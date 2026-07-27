const WebSocket = require('ws')
const express = require('express')
const cors = require('cors')
const tokenManager = require('./tokenManager')
const store = require('./store')
const auth = require('./auth')

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '5mb' }))
app.use(require('express').static(__dirname + '/public'))

const GW_BASE = 'https://kr-gw.spooncast.net'
const API_BASE = 'https://api.spooncast.net'
const KR_API_BASE = 'https://kr-api.spooncast.net'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ⚠️ 지금은 djId별 멀티 계정 대신, 모든 DJ가 관리자(sum) 계정의 토큰을 공유해서 사용한다.
// (tokenManager 자체는 계속 djId 기반 멀티 계정을 지원하므로, 나중에 다시 DJ별로 나누고 싶으면
//  아래 상수 대신 실제 djId를 넘기도록 되돌리기만 하면 된다.)
const SHARED_TOKEN_DJID = 'sum'

// 디제이별 방(연결) 상태. djId -> { ws, isConnected, streamName, roomToken, autoJoinedFor, checking }
const rooms = {}
function getRoom(djId) {
  if (!rooms[djId]) {
    rooms[djId] = { ws: null, isConnected: false, streamName: '', roomToken: '', autoJoinedFor: '', watchingTag: '', checking: false, liveDjUserId: null }
  }
  return rooms[djId]
}

let sseClients = []

// ══════════════════════════════════════════════════════
// 세션 쿠키 기반 accessToken 자동 갱신 (스푼 계정은 단비님 것 하나만 공용으로 사용)
tokenManager.setOnTokenUpdate((djId) => {
  broadcast({ type: 'session', djId, status: 'connected' })
})
tokenManager.setOnSessionExpired((djId) => {
  broadcast({ type: 'session', djId, status: 'expired' })
})

function broadcast(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n'
  sseClients = sseClients.filter(c => !c.destroyed)
  sseClients.forEach(c => c.write(msg))
}

async function fetchUserStatusByTag(tag) {
  const cleanTag = String(tag || '').replace('@', '').trim()
  if (!cleanTag) return null
  try {
    const res = await fetch(`https://kr-gw.spooncast.net/search/user?keyword=${encodeURIComponent(cleanTag)}&page_size=20`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': CHROME_UA,
        'X-Client-App': 'sopia-web',
        'X-Client-Version': '1.0.0',
      }
    })
    const json = await res.json()
    const results = json.results || []
    const match = results.find(u => u.tag === cleanTag)
    if (!match || !match.id) return null
    return {
      id: match.id,
      tag: match.tag,
      nickname: match.nickname || '',
      is_live: !!match.is_live,
      current_live_id: match.current_live_id || null,
    }
  } catch (e) {
    return null
  }
}

async function fetchUserTag(liveId, userId, accessToken) {
  if (!liveId || !userId || !accessToken) return null
  try {
    const res = await fetch(`${KR_API_BASE}/lives/${liveId}/member/${userId}/profile/`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
      }
    })
    const json = await res.json()
    const profile = (json.results && json.results[0]) || json
    let tag = profile.tag || profile.tag_name || profile.username || profile.id_name || null
    if (tag) tag = String(tag).replace('@', '').trim()
    return tag
  } catch (e) {
    console.log('[tag 조회 오류]', e.message)
    return null
  }
}

// 방송 실시간 시청자 명단 조회 (퇴장 감지용 폴링에 사용) — 스푼은 퇴장 소켓 이벤트를 보내지 않음
async function fetchLiveMembers(liveId, accessToken) {
  if (!liveId || !accessToken) return []
  try {
    const res = await fetch(`${KR_API_BASE}/lives/${liveId}/members/`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
      }
    })
    const json = await res.json()
    const members = json.results || []
    return members.map(m => {
      let tag = m.tag || m.tag_name || m.username || m.id_name || null
      let nickname = m.nickname || m.name || m.display_name || null
      if (tag) tag = String(tag).replace('@', '').trim()
      if (!tag && !nickname) return null
      return { tag, nickname: nickname || tag }
    }).filter(Boolean)
  } catch (e) {
    console.log('[fetchLiveMembers 오류]', e.message)
    return []
  }
}

async function fetchLiveInfo(liveId, accessToken) {
  try {
    const res = await fetch(`${API_BASE}/lives/${liveId}/`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
        'Referer': 'https://www.spooncast.net/',
      }
    })
    const data = await res.json()
    const live = data.results?.[0] || data
    return {
      streamName: live.stream_name || live.streamName || String(liveId),
      djUserId: live.dj_user_id || live.author?.id || live.user?.id || null,
    }
  } catch (e) {
    console.log('[stream_name 오류]', e.message)
    return { streamName: String(liveId), djUserId: null }
  }
}

async function sendChatToRoom(djId, message) {
  const room = getRoom(djId)
  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  if (!room.streamName || !accessToken) return
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': CHROME_UA,
      'Origin': 'https://www.spooncast.net',
      'Referer': 'https://www.spooncast.net/',
    }
    if (room.roomToken) headers['x-live-authorization'] = `Bearer ${room.roomToken}`
    const res = await fetch(`${GW_BASE}/lives/${room.streamName}/chat/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, messageType: 'GENERAL_MESSAGE' })
    })
    console.log(`[채팅:${djId}]`, message, '응답:', res.status)
  } catch (e) {
    console.log(`[채팅:${djId} 오류]`, e.message)
  }
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 실드 명령어 처리: "!실드", "!실드 +5", "!실드 -3" (명령어 자체는 DJ가 커스텀 가능)
function handleShieldCommand(djId, room, settings, author, authorId, text) {
  const shield = settings.shield
  if (!shield || !shield.cmd) return

  const cmd = shield.cmd.trim()
  const re = new RegExp(`^${escapeRegExp(cmd)}(?:\\s*([+-]\\s*\\d+))?\\s*$`)
  const m = String(text || '').trim().match(re)
  if (!m) return

  const delta = m[1] ? parseInt(m[1].replace(/\s/g, ''), 10) : null

  // 조회 (인자 없음) — 누구나 가능
  if (delta === null) {
    const reply = (shield.msgView || '현재 실드: {실드}개').replace(/{실드}/g, shield.count)
    setTimeout(() => sendChatToRoom(djId, reply), 400)
    return
  }

  // 적립/차감 — DJ 본인 또는 등록된 권한자만 가능
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const perms = (shield.perms || []).map(t => String(t).replace('@', '').toLowerCase())
  const isPermUser = perms.includes(String(author || '').toLowerCase())
  if (!isDj && !isPermUser) {
    setTimeout(() => sendChatToRoom(djId, '❌ 실드 조절 권한이 없어요'), 400)
    return
  }

  shield.count = (shield.count || 0) + delta
  store.saveSettings(djId, { shield })
  broadcast({ type: 'shield', djId, count: shield.count })

  const amount = Math.abs(delta)
  const tpl = delta > 0 ? (shield.msgAdd || '실드 {amount}개 적립! 현재: {실드}개') : (shield.msgSub || '실드 {amount}개 차감! 현재: {실드}개')
  const reply = tpl
    .replace(/{amount}/g, amount)
    .replace(/{실드}/g, shield.count)
    .replace(/{icon}/g, delta > 0 ? '✅' : '▼')
    .replace(/{action}/g, delta > 0 ? '적립' : '차감')
  setTimeout(() => sendChatToRoom(djId, reply), 400)
}

function renderFlagTemplate(tpl, flag, index) {
  const goal = Number(flag.goal) || 0
  const current = Number(flag.current) || 0
  const percent = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
  return String(tpl || '')
    .replace(/{index}/g, index)
    .replace(/{title}/g, flag.title)
    .replace(/{current}/g, current)
    .replace(/{goal}/g, goal)
    .replace(/{percent}/g, percent)
}

// 깃발 명령어 처리: "!깃발", "!깃발 1", "!깃발 1 50" (음수면 차감)
function handleFlagCommand(djId, room, settings, author, authorId, text) {
  const flags = settings.flags
  if (!flags || !flags.cmd || !flags.items || !flags.items.length) return

  const cmd = flags.cmd.trim()
  const re = new RegExp(`^${escapeRegExp(cmd)}(?:\\s+(\\d+))?(?:\\s+(-?\\d+))?\\s*$`)
  const m = String(text || '').trim().match(re)
  if (!m) return

  const idx1 = m[1] ? parseInt(m[1], 10) : null   // 1-based
  const delta = m[2] ? parseInt(m[2], 10) : null

  // 인자 없음 → 전체 출력
  if (idx1 === null) {
    const lines = flags.items.map((f, i) => renderFlagTemplate(f.template, f, i + 1))
    setTimeout(() => sendChatToRoom(djId, lines.join('\n')), 400)
    return
  }

  const flag = flags.items[idx1 - 1]
  if (!flag) return

  // 조회만 (숫자 하나만) → 누구나 가능
  if (delta === null) {
    setTimeout(() => sendChatToRoom(djId, renderFlagTemplate(flag.template, flag, idx1)), 400)
    return
  }

  // 적립/차감 → DJ 본인만 가능 (매니저 목록 조회는 아직 미지원)
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (!isDj) {
    setTimeout(() => sendChatToRoom(djId, '❌ 깃발 조절 권한이 없어요'), 400)
    return
  }

  flag.current = (flag.current || 0) + delta
  store.saveSettings(djId, { flags })
  broadcast({ type: 'flags', djId, items: flags.items })
  setTimeout(() => sendChatToRoom(djId, renderFlagTemplate(flag.template, flag, idx1)), 400)
}

// 선물(도네이션) 수신 시 "자동 적립" 깃발에 수량만큼 자동 반영
function handleFlagAutoDonation(djId, settings, amount) {
  const flags = settings.flags
  if (!flags || !flags.items || !flags.items.length || !amount) return
  let changed = false
  flags.items.forEach(f => {
    if (f.mode === 'auto') { f.current = (f.current || 0) + amount; changed = true }
  })
  if (changed) {
    store.saveSettings(djId, { flags })
    broadcast({ type: 'flags', djId, items: flags.items })
  }
}

function calcDday(endDate) {
  if (!endDate) return ''
  const end = new Date(endDate + 'T23:59:59')
  const diffDays = Math.ceil((end - new Date()) / 86400000)
  if (diffDays < 0) return '종료'
  if (diffDays === 0) return 'D-Day'
  return `D-${diffDays}`
}

function renderFundingItem(tpl, item, index, funding) {
  const goal = Number(item.goal) || 0
  const current = Number(item.current) || 0
  const percent = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0
  return String(tpl || '')
    .replace(/{index}/g, index)
    .replace(/{title}/g, item.title)
    .replace(/{current}/g, current.toLocaleString())
    .replace(/{goal}/g, goal.toLocaleString())
    .replace(/{percent}/g, funding.showPercent === false ? '' : `${percent}%`)
    .replace(/{dday}/g, funding.showDday === false ? '' : calcDday(item.endDate))
}

// 펀딩 명령어 처리: "!펀딩", "!펀딩 1", "!펀딩 1 200" (음수면 차감)
function handleFundingCommand(djId, room, settings, author, authorId, text) {
  const funding = settings.funding
  if (!funding || !funding.cmd || !funding.items || !funding.items.length) return

  const cmd = funding.cmd.trim()
  const re = new RegExp(`^${escapeRegExp(cmd)}(?:\\s+(\\d+))?(?:\\s+(-?\\d+))?\\s*$`)
  const m = String(text || '').trim().match(re)
  if (!m) return

  const idx1 = m[1] ? parseInt(m[1], 10) : null
  const delta = m[2] ? parseInt(m[2], 10) : null

  if (idx1 === null) {
    const month = new Date().getMonth() + 1
    const header = String(funding.titleTemplate || '').replace(/{month}/g, month)
    const lines = funding.items.map((it, i) => renderFundingItem(funding.itemTemplate, it, i + 1, funding))
    setTimeout(() => sendChatToRoom(djId, [header, ...lines].join('\n')), 400)
    return
  }

  const item = funding.items[idx1 - 1]
  if (!item) return

  if (delta === null) {
    setTimeout(() => sendChatToRoom(djId, renderFundingItem(funding.itemTemplate, item, idx1, funding)), 400)
    return
  }

  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (!isDj) {
    setTimeout(() => sendChatToRoom(djId, '❌ 펀딩 조절 권한이 없어요'), 400)
    return
  }

  item.current = (item.current || 0) + delta
  store.saveSettings(djId, { funding })
  broadcast({ type: 'funding', djId, items: funding.items })
  setTimeout(() => sendChatToRoom(djId, renderFundingItem(funding.itemTemplate, item, idx1, funding)), 400)
}

// 단축키 명령어 쿨타임 추적용 (메모리에만 유지, 재시작하면 초기화됨 — 큰 문제 없음)
const commandCooldowns = new Map() // `${djId}:${trigger}` -> timestamp(ms)

// 단축키 명령어 처리: 등록해둔 트리거와 채팅이 정확히 일치하면 응답 전송
async function handleShortcutCommand(djId, room, settings, author, authorId, liveId, text) {
  const commands = settings.commands
  if (!commands || !commands.length) return

  const msg = String(text || '').trim()
  const cmd = commands.find(c => c.trigger === msg)
  if (!cmd) return

  // 권한 체크
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (cmd.scope === 'dj' && !isDj) return
  if (cmd.scope === 'manager' && !isDj) return // 매니저 목록 연동 전까지는 DJ만 허용

  // 쿨타임 체크
  const cooldownMs = (Number(cmd.cooldown) || 0) * 1000
  if (cooldownMs > 0) {
    const key = `${djId}:${cmd.trigger}`
    const last = commandCooldowns.get(key) || 0
    if (Date.now() - last < cooldownMs) return
    commandCooldowns.set(key, Date.now())
  }

  cmd.useCount = (cmd.useCount || 0) + 1
  store.saveSettings(djId, { commands })

  let response = cmd.response || ''
  response = response.replace(/{nickname}/g, author).replace(/{count}/g, cmd.useCount)
  if (response.includes('{tag}')) {
    const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
    response = response.replace(/{tag}/g, tag ? `@${tag}` : '')
  }
  // 호스트/랭킹 변수는 아직 미지원 — 빈 값으로 처리
  response = response.replace(/{host_nickname}|{host_tag}|{rank}|{choice_rank}|{like_rank}|{time_rank}/g, '')

  setTimeout(() => sendChatToRoom(djId, response), 400)
}

// 메시지 길이 제한에 맞춰 여러 줄을 나눠서 순차 전송
function sendChatSplit(djId, fullText, maxChars, intervalMs) {
  const limit = Math.max(30, Math.min(500, Number(maxChars) || 100))
  const interval = Math.max(200, Number(intervalMs) || 600)
  const lines = String(fullText || '').split('\n')
  const chunks = []
  let current = ''
  for (const line of lines) {
    const next = current ? current + '\n' + line : line
    if (next.length > limit && current) {
      chunks.push(current)
      current = line
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  chunks.forEach((chunk, i) => setTimeout(() => sendChatToRoom(djId, chunk), 400 + i * interval))
}

// 신청곡 관리 명령어 처리
function handleSongRequestCommand(djId, room, settings, author, authorId, text) {
  const sr = settings.songRequest
  if (!sr) return
  const msg = String(text || '').trim()
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  const save = () => store.saveSettings(djId, { songRequest: sr })
  const reqPrefix = sr.cmdRequest + ' '

  // !신청곡 [가수] [제목]
  if (msg.startsWith(reqPrefix)) {
    if (!sr.accepting) {
      setTimeout(() => sendChatToRoom(djId, '🚫 지금은 신청곡을 받지 않아요'), 400)
      return
    }
    const rest = msg.slice(reqPrefix.length).trim()
    if (!rest) return
    const parts = rest.split(/\s+/)
    const artist = parts.shift() || ''
    const title = parts.join(' ') || artist
    const item = { id: 'sr' + Date.now() + Math.floor(Math.random() * 1000), artist, title, requester: author }
    if (sr.priorityMode) sr.items.unshift(item); else sr.items.push(item)
    save()
    broadcast({ type: 'songrequest', djId, items: sr.items })
    const doneMsg = (sr.doneTemplate || '').replace(/{artist}/g, artist).replace(/{title}/g, title).replace(/{count}/g, sr.items.length)
    setTimeout(() => sendChatToRoom(djId, doneMsg), 400)
    return
  }

  // !신청곡 (목록 출력)
  if (msg === sr.cmdRequest) {
    if (!sr.items.length) {
      setTimeout(() => sendChatToRoom(djId, '📭 신청곡이 없어요'), 400)
      return
    }
    const lines = sr.items.map((it, i) => (sr.listItemTemplate || '{index}. {artist} - {title}')
      .replace(/{index}/g, i + 1).replace(/{artist}/g, it.artist).replace(/{title}/g, it.title))
    sendChatSplit(djId, [sr.listTitle, ...lines].join('\n'), sr.maxCharsPerMsg, sr.msgIntervalMs)
    return
  }

  // !현재곡
  if (msg === '!현재곡') {
    if (!sr.items.length) return
    const it = sr.items[0]
    setTimeout(() => sendChatToRoom(djId, `🎧 현재 곡: ${it.artist} - ${it.title}`), 400)
    return
  }

  // 아래는 전부 DJ 전용 관리 명령어
  if (!isDj) return

  if (msg.startsWith(sr.cmdRemove + ' ')) {
    const idx = parseInt(msg.slice(sr.cmdRemove.length).trim(), 10)
    if (idx >= 1 && idx <= sr.items.length) {
      const removed = sr.items.splice(idx - 1, 1)[0]
      save()
      broadcast({ type: 'songrequest', djId, items: sr.items })
      setTimeout(() => sendChatToRoom(djId, `🗑️ ${removed.artist} - ${removed.title} 제거됨`), 400)
    }
    return
  }
  if (msg === sr.cmdReset) {
    sr.items = []
    save()
    broadcast({ type: 'songrequest', djId, items: sr.items })
    setTimeout(() => sendChatToRoom(djId, '🔄 신청곡 목록이 초기화됐어요'), 400)
    return
  }
  if (msg === sr.cmdClose) { sr.accepting = false; save(); setTimeout(() => sendChatToRoom(djId, '🚫 신청곡 접수를 마감했어요'), 400); return }
  if (msg === sr.cmdOpen) { sr.accepting = true; save(); setTimeout(() => sendChatToRoom(djId, '✅ 신청곡 접수를 시작했어요'), 400); return }
  if (msg === sr.cmdPriorityOn) { sr.priorityMode = true; save(); return }
  if (msg === sr.cmdPriorityOff) { sr.priorityMode = false; save(); return }
  if (msg === sr.cmdNameOn) { sr.showRequester = true; save(); return }
  if (msg === sr.cmdNameOff) { sr.showRequester = false; save(); return }
}

function percentPick(items) {
  const total = items.reduce((s, it) => s + (Number(it.percent) || 1), 0)
  let r = Math.random() * total
  for (const it of items) {
    r -= (Number(it.percent) || 1)
    if (r <= 0) return it
  }
  return items[items.length - 1]
}

const SECTION_FIELD = { '킵목록': 'keepList', '이벤트목록': 'eventList', '기타목록': 'miscList' }
const SECTION_LABEL = { '킵목록': '킵', '이벤트목록': '이벤트', '기타목록': '내카드' }

function getHistoryRec(settings, tag) {
  if (!settings.rouletteHistory) settings.rouletteHistory = {}
  if (!settings.rouletteHistory[tag]) settings.rouletteHistory[tag] = { coupons: {}, wins: [], keepList: {}, miscList: {}, eventList: {} }
  const rec = settings.rouletteHistory[tag]
  if (!rec.keepList) rec.keepList = {}
  if (!rec.miscList) rec.miscList = {}
  if (!rec.eventList) rec.eventList = {}
  return rec
}

// !킵, !이벤트, !내카드 [페이지] / !킵확인N, !이벤트확인N, !내카드확인N [고유닉] 응답 문구 생성
function formatKeepMessage(displayName, section, entries, page) {
  const label = SECTION_LABEL[section]
  if (!entries.length) return `📋 ${displayName}님의 ${label} 기록이 없습니다.`
  const pageSize = 10
  const totalPages = Math.ceil(entries.length / pageSize)
  const cur = Math.max(1, Math.min(page, totalPages))
  const startIdx = (cur - 1) * pageSize
  const pageEntries = entries.slice(startIdx, startIdx + pageSize)
  let msg = `📋 ${displayName}님의 ${label} 기록 (${cur}/${totalPages}페이지, 총 ${entries.length}개)\n`
  pageEntries.forEach(([name, count], i) => {
    msg += `${startIdx + i + 1}. ${name}${count > 1 ? ` (${count}개)` : ''}\n`
  })
  if (totalPages > 1) {
    const cmdBase = section === '이벤트목록' ? '!이벤트' : (section === '기타목록' ? '!내카드' : '!킵')
    const next = cur < totalPages ? cur + 1 : 1
    msg += `\n💡 ${cmdBase} ${next} 로 다른 페이지 확인 가능`
  }
  return msg.trim()
}

// 지급 방식 계산: 일반(exact)=정확히 X스푼일 때 1회, 콤보/배분(combo/distribute)=X스푼당 1회(내림)
// mode: exact(일반)=단발(콤보X)로 정확히 X스푼일 때만 1회
//       combo(콤보)=X스푼짜리 아이템을 comboCount번 연속 선물 시 comboCount회
//       distribute(배분)=총합(amount*comboCount) 안에서 X스푼당 1회 (내림, 단가 무관)
function calcAutoGrantCount(mode, triggerAmount, amount, comboCount) {
  const X = Number(triggerAmount) || 0
  const combo = Math.max(1, Number(comboCount) || 1)
  if (X <= 0) return 0
  if (mode === 'exact') return (amount === X && combo === 1) ? 1 : 0
  if (mode === 'combo') return amount === X ? combo : 0
  // distribute
  const total = amount * combo
  return total >= X ? Math.floor(total / X) : 0
}

// 지정 스티커 매칭: 선물로 들어온 스티커 이름이 등록해둔 이름과 같거나 일부만 포함돼도 매칭.
// (콤보로 같은 스티커를 여러 번 연속 선물하면 그 횟수만큼 실행)
function checkStickerTrigger(triggerSticker, sticker, comboCount) {
  const target = String(triggerSticker || '').trim().toLowerCase()
  const current = String(sticker || '').trim().toLowerCase()
  if (!target || !current) return 0
  if (current === target || current.includes(target)) {
    return Math.max(1, Number(comboCount) || 1)
  }
  return 0
}

// 룰렛 명령어 처리: "!룰렛1", "!룰렛1 3" (수량)
// !킵, !이벤트, !내카드 [페이지] (본인 조회) / !킵확인N, !이벤트확인N, !내카드확인N [고유닉] (타인 조회)
// !킵추가 [고유닉] [내용] (DJ 전용) / !킵사용, !이벤트사용, !내카드사용 [번호] [수량]
async function handleKeepCommands(djId, room, settings, author, authorId, liveId, text) {
  const msg = String(text || '').trim()
  const parts = msg.split(/\s+/)
  const first = parts[0]
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  const sectionByCmd = { '!킵': '킵목록', '!이벤트': '이벤트목록', '!내카드': '기타목록' }
  if (sectionByCmd[first]) {
    const section = sectionByCmd[first]
    const page = parseInt(parts[1]) || 1
    const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
    const keepKey = tag || author
    const rec = getHistoryRec(settings, keepKey)
    const entries = Object.entries(rec[SECTION_FIELD[section]] || {})
    sendChatSplit(djId, formatKeepMessage(author, section, entries, page), 150, 600)
    return
  }

  const checkMatch = first.match(/^(!킵확인|!이벤트확인|!내카드확인)(\d*)$/)
  if (checkMatch) {
    const section = { '!킵확인': '킵목록', '!이벤트확인': '이벤트목록', '!내카드확인': '기타목록' }[checkMatch[1]]
    const page = parseInt(checkMatch[2]) || 1
    const targetTag = (parts[1] || '').replace('@', '').trim()
    if (!targetTag) {
      setTimeout(() => sendChatToRoom(djId, `📋 사용법: ${checkMatch[1]} [고유닉]\n예) ${checkMatch[1]} sum`), 400)
      return
    }
    const rec = getHistoryRec(settings, targetTag)
    const entries = Object.entries(rec[SECTION_FIELD[section]] || {})
    sendChatSplit(djId, formatKeepMessage(targetTag, section, entries, page), 150, 600)
    return
  }

  if (first === '!킵추가') {
    if (!isDj) { setTimeout(() => sendChatToRoom(djId, '⛔ !킵추가 명령어는 DJ만 사용할 수 있습니다.'), 400); return }
    if (parts.length < 3) { setTimeout(() => sendChatToRoom(djId, '📋 사용법: !킵추가 [고유닉] [내용]\n예) !킵추가 sum 리방하기'), 400); return }
    const targetTag = parts[1].replace('@', '').trim()
    const content = parts.slice(2).join(' ').trim()
    if (!targetTag || !content) return
    const rec = getHistoryRec(settings, targetTag)
    rec.keepList[content] = (rec.keepList[content] || 0) + 1
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag: targetTag })
    const newCount = rec.keepList[content]
    setTimeout(() => sendChatToRoom(djId, `✅ [${targetTag}] 님의 킵목록에 [${content}]${newCount > 1 ? ` (총 ${newCount}개)` : ''} 추가 완료!`), 400)
    return
  }

  const useMatch = first.match(/^(!킵사용|!이벤트사용|!내카드사용)$/)
  if (useMatch) {
    const section = { '!킵사용': '킵목록', '!이벤트사용': '이벤트목록', '!내카드사용': '기타목록' }[useMatch[1]]
    const idx = parseInt(parts[1])
    const count = parseInt(parts[2]) || 1
    if (!idx || idx <= 0) { setTimeout(() => sendChatToRoom(djId, `📋 사용법: ${useMatch[1]} [번호] [수량]\n(예: ${useMatch[1]} 1 1)`), 400); return }
    const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
    const keepKey = tag || author
    const rec = getHistoryRec(settings, keepKey)
    const field = SECTION_FIELD[section]
    const data = rec[field]
    const items = Object.keys(data)
    const item = items[idx - 1]
    if (!item) { setTimeout(() => sendChatToRoom(djId, `📋 ${author}님, 해당 번호(${idx})의 항목이 없습니다.`), 400); return }
    if (data[item] < count) { setTimeout(() => sendChatToRoom(djId, `📋 ${author}님, ${item}의 수량이 부족합니다. (현재: ${data[item]}개)`), 400); return }
    data[item] -= count
    const remaining = data[item]
    if (data[item] <= 0) delete data[item]
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag: keepKey })
    setTimeout(() => sendChatToRoom(djId, `✅ ${author}님의 [${item}] ${count}개 사용 완료! (남은 수량: ${remaining > 0 ? remaining : 0}개)`), 400)
    return
  }
}

// !룰렛지급N [고유닉] [수량] — DJ 전용 룰렛권 지급
async function handleRouletteGiveCommand(djId, room, settings, author, authorId, text) {
  const msg = String(text || '').trim()
  const parts = msg.split(/\s+/)
  const m = parts[0].match(/^!룰렛지급(\d+)$/)
  if (!m) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (!isDj) { setTimeout(() => sendChatToRoom(djId, '🎡 !룰렛지급 명령어는 DJ만 사용할 수 있습니다.'), 400); return }

  const idx = parseInt(m[1], 10)
  const rt = settings.roulette && settings.roulette.list[idx - 1]
  if (!rt) { setTimeout(() => sendChatToRoom(djId, `🎡 룰렛${idx}은 등록되어 있지 않습니다.`), 400); return }

  const targetTag = (parts[1] || '').replace('@', '').trim()
  const count = parseInt(parts[2], 10) || 1
  if (!targetTag) { setTimeout(() => sendChatToRoom(djId, `🎡 사용법: !룰렛지급${idx} [고유닉] [수량]`), 400); return }

  const rec = getHistoryRec(settings, targetTag)
  rec.coupons[idx] = Number(rec.coupons[idx] || 0) + count
  store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
  broadcast({ type: 'roulette', djId, tag: targetTag })
  setTimeout(() => sendChatToRoom(djId, `🎡 [${targetTag}]님에게 룰렛${idx}(${rt.name}) 권 ${count}개 지급 완료! (현재: ${rec.coupons[idx]}개)`), 400)
}

// !룰렛메뉴N[-P] — 룰렛 항목 목록 확인 (페이지)
function handleRouletteMenuCommand(djId, settings, text) {
  const m = String(text || '').trim().match(/^!룰렛메뉴(\d+)(?:-(\d+))?$/)
  if (!m) return
  const idx = parseInt(m[1], 10)
  const page = parseInt(m[2], 10) || 1
  const rt = settings.roulette && settings.roulette.list[idx - 1]
  if (!rt) { setTimeout(() => sendChatToRoom(djId, `🎡 룰렛${idx}은 등록되어 있지 않습니다.`), 400); return }
  if (!rt.items || !rt.items.length) { setTimeout(() => sendChatToRoom(djId, `🎡 ${rt.name} 룰렛에 등록된 항목이 없습니다.`), 400); return }

  const pageSize = 10
  const totalPages = Math.ceil(rt.items.length / pageSize)
  const cur = Math.max(1, Math.min(page, totalPages))
  const startIdx = (cur - 1) * pageSize
  const pageItems = rt.items.slice(startIdx, startIdx + pageSize)
  let out = `🎡 [${rt.name}] 항목 (${cur}/${totalPages}페이지)\n`
  pageItems.forEach((it, i) => { out += `${startIdx + i + 1}. ${it.name}\n` })
  if (totalPages > 1) {
    const next = cur < totalPages ? cur + 1 : 1
    out += `\n💡 !룰렛메뉴${idx}-${next} 로 다른 페이지 확인 가능`
  }
  sendChatSplit(djId, out.trim(), 150, 600)
}

async function handleRouletteCommand(djId, room, settings, author, authorId, liveId, text) {
  const rl = settings.roulette
  if (!rl || !rl.list || !rl.list.length) return
  const msg = String(text || '').trim()
  const m = msg.match(/^!룰렛(\d+)(?:\s+(\d+))?\s*$/)
  if (!m) return

  const idx = parseInt(m[1], 10)
  const count = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1
  const rt = rl.list[idx - 1]
  if (!rt || !rt.items || !rt.items.length) return

  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))

  // 시청자는 룰렛권 차감/기록에 태그가 꼭 필요하므로, 태그 조회 실패 시 실행하지 않는다.
  // DJ는 태그 조회가 실패해도(네트워크 이슈 등) 명령어가 무시되지 않도록 닉네임을 키로 대체해서라도 항상 실행한다.
  if (!tag && !isDj) return
  const histKey = tag || author
  const hist = getHistoryRec(settings, histKey)
  let resultDelay = 400

  if (!isDj) {
    const have = Number(hist.coupons[idx] || 0)
    if (have < count) {
      const lowMsg = (rl.couponLowTemplate || '').replace(/{닉네임}/g, author).replace(/{번호}/g, idx).replace(/{룰렛명}/g, rt.name)
        .replace(/{요청}/g, count).replace(/{보유}/g, have)
      setTimeout(() => sendChatToRoom(djId, lowMsg), 400)
      return
    }
    hist.coupons[idx] = have - count
    const useMsg = (rl.couponUseTemplate || '🎡 {닉네임}님이 룰렛{번호} 권 {수량}개를 사용했습니다! (잔여: {잔여}개)')
      .replace(/{닉네임}/g, author).replace(/{번호}/g, idx).replace(/{수량}/g, count).replace(/{잔여}/g, hist.coupons[idx])
    setTimeout(() => sendChatToRoom(djId, useMsg), 400)
    resultDelay = 900
  }

  const wonCounts = {}
  for (let i = 0; i < count; i++) {
    const won = percentPick(rt.items)
    wonCounts[won.name] = (wonCounts[won.name] || 0) + 1
    if (!won.skipHistory) {
      hist.wins.push({ idx, rouletteName: rt.name, itemName: won.name, ts: Date.now() })
      hist.keepList[won.name] = (hist.keepList[won.name] || 0) + 1
    }
  }
  store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
  broadcast({ type: 'roulette', djId, tag: histKey })

  const header = (rl.resultHeaderTemplate || '').replace(/{룰렛명}/g, rt.name).replace(/{닉네임}/g, author)
  const resultLine = Object.entries(wonCounts).map(([name, c]) => '👉 ' + (c > 1 ? `${name}(${c})` : name)).join('\n')
  setTimeout(() => sendChatToRoom(djId, `${header}\n${resultLine}`), resultDelay)
}

// 선물(도네이션) 수신 시 조건에 맞는 룰렛의 룰렛권 자동 지급
// sticker: 선물로 들어온 스티커 이름 (지정 스티커 트리거용, 없으면 빈 문자열)
async function handleRouletteAutoGrant(djId, settings, author, authorId, liveId, amount, comboCount, sticker = '') {
  const rl = settings.roulette
  if (!rl || !rl.list || !rl.list.length) return
  const applicable = rl.list
    .map((rt, i) => {
      const count = rt.triggerMode === 'sticker'
        ? checkStickerTrigger(rt.triggerSticker, sticker, comboCount)
        : calcAutoGrantCount(rt.triggerMode, rt.triggerAmount, amount, comboCount)
      return { rt, idx: i + 1, count }
    })
    .filter(x => x.count > 0)
  if (!applicable.length) return

  const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
  const hist = tag ? getHistoryRec(settings, tag) : null
  let changed = false

  for (const { rt, idx, count } of applicable) {
    const wonCounts = {}
    for (let i = 0; i < count; i++) {
      const won = percentPick(rt.items)
      wonCounts[won.name] = (wonCounts[won.name] || 0) + 1
      if (hist && !won.skipHistory) {
        hist.wins.push({ idx, rouletteName: rt.name, itemName: won.name, ts: Date.now() })
        hist.keepList[won.name] = (hist.keepList[won.name] || 0) + 1
        changed = true
      }
    }
    const header = (rl.resultHeaderTemplate || '').replace(/{룰렛명}/g, rt.name).replace(/{닉네임}/g, author)
    const resultLine = Object.entries(wonCounts).map(([name, c]) => '👉 ' + (c > 1 ? `${name}(${c})` : name)).join('\n')
    setTimeout(() => sendChatToRoom(djId, `${header}\n${resultLine}`), 400)
  }

  if (changed) {
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag })
  }
}

// ══════════════════════════════════════════════════════
// 🚪 퇴장 감지 폴링 — 스푼은 소켓으로 퇴장 이벤트를 보내지 않으므로,
// 시청자 명단 API를 주기적으로 조회해서 직전 스냅샷과 비교하는 방식으로 판정한다.
const LEAVE_POLL_MS = 5000          // 몇 초마다 명단을 조회할지
const LEAVE_ABSENCE_THRESHOLD = 1   // 연속 몇 회 명단에 안 보이면 퇴장 확정할지 (1=즉시)

function registerJoinSnapshot(room, nickname, tag, prevKey) {
  if (!room._lastLiveMembers) return
  const key = (tag || nickname || '').toString().toLowerCase()
  if (!key) return
  // 태그가 나중에 확인되면서 키가 바뀌는 경우, 이전 닉네임 기준 키는 지워서 중복 등록(유령 엔트리) 방지
  if (prevKey && prevKey !== key) {
    room._lastLiveMembers.delete(prevKey)
    if (room._memberAbsenceCount) room._memberAbsenceCount.delete(prevKey)
  }
  room._lastLiveMembers.set(key, { nickname, tag: tag || null })
  if (room._memberAbsenceCount) room._memberAbsenceCount.delete(key)
}

function sendLeaveMessage(djId, settings, nickname) {
  broadcast({ type: 'leave', djId, nick: nickname })
  if (settings.botEnabled === false) return
  const msgs = (settings.leaveMessages || []).filter(m => m.enabled)
  if (msgs.length > 0) {
    // {tag}는 조회 API 호출이 필요해서 퇴장 멘트에서는 지원하지 않음 (빈 값 처리)
    const text = msgs[0].text.replace(/{nickname}/g, nickname).replace(/{tag}/g, '')
    setTimeout(() => sendChatToRoom(djId, text), 500)
  }
}

function startLeavePolling(djId, liveId) {
  const room = getRoom(djId)
  stopLeavePolling(djId)
  room._lastLiveMembers = new Map()
  room._memberAbsenceCount = new Map()
  room._leavePollInFlight = false

  room._leavePollTimer = setInterval(async () => {
    if (room._leavePollInFlight) return
    room._leavePollInFlight = true
    try {
      const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
      const users = await fetchLiveMembers(liveId, accessToken)
      if (!users.length) return // 빈 응답은 API 오류일 가능성이 커서 스냅샷 유지하고 이번 회차는 패스

      const currentMembers = new Map()
      for (const u of users) {
        const key = (u.tag || u.nickname || '').toString().toLowerCase()
        if (!key) continue
        currentMembers.set(key, u)
      }

      const leftCandidates = []
      for (const [key, info] of room._lastLiveMembers.entries()) {
        if (currentMembers.has(key)) {
          room._memberAbsenceCount.delete(key)
        } else {
          const absent = (room._memberAbsenceCount.get(key) || 0) + 1
          room._memberAbsenceCount.set(key, absent)
          if (absent >= LEAVE_ABSENCE_THRESHOLD) leftCandidates.push({ key, info })
        }
      }

      for (const { key, info } of leftCandidates) {
        room._lastLiveMembers.delete(key)
        room._memberAbsenceCount.delete(key)
        const settings = store.getSettings(djId) || {}
        sendLeaveMessage(djId, settings, info.nickname)
      }

      for (const [key, info] of currentMembers.entries()) {
        room._lastLiveMembers.set(key, info)
      }
    } catch (e) {
      console.log(`[${djId}] 퇴장감지 폴링 오류`, e.message)
    } finally {
      room._leavePollInFlight = false
    }
  }, LEAVE_POLL_MS)
}

function stopLeavePolling(djId) {
  const room = getRoom(djId)
  if (room._leavePollTimer) {
    clearInterval(room._leavePollTimer)
    room._leavePollTimer = null
  }
}

async function connectSpoonForDj(djId, liveId, roomToken) {
  const room = getRoom(djId)
  if (room.ws) { room.ws.terminate(); room.ws = null }

  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const { streamName, djUserId } = await fetchLiveInfo(liveId, accessToken)
  room.streamName = streamName
  room.roomToken = roomToken
  room.liveDjUserId = djUserId

  const ws = new WebSocket(`wss://kr-wala.spooncast.net/ws?token=${accessToken}`, {
    headers: {
      'Origin': 'https://www.spooncast.net',
      'User-Agent': CHROME_UA,
      'Cache-Control': 'no-cache',
    }
  })
  room.ws = ws

  ws.on('unexpected-response', (req, res) => {
    console.log(`[${djId}] WS 예상밖 응답: status=${res.statusCode} headers=${JSON.stringify(res.headers)}`)
  })

  ws.on('open', () => {
    console.log(`[${djId}] 스푼 연결됨! streamName:`, streamName)
    room.isConnected = true
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        command: 'ACTIVATE_CHANNEL',
        payload: { channelId: streamName, liveToken: roomToken || '' }
      }))
    }
    broadcast({ type: 'status', djId, isConnected: true })
    // 🚪 퇴장 감지 폴링 시작 (스푼은 퇴장 소켓 이벤트를 안 보내서 명단 폴링으로 대체)
    startLeavePolling(djId, liveId)
    // 🔁 반복 문구 타이머도 이번 입장 시점부터 새로 시작
    repeatLastSent[djId] = {}
  })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data)
      if (msg.command !== 'MESSAGE') return
      const body = JSON.parse(msg.payload?.body || '{}')
      const { eventName, eventPayload = {} } = body
      console.log(`[${djId}][diag] 이벤트 수신: ${eventName}`, JSON.stringify(eventPayload).slice(0, 200))

      const settings = store.getSettings(djId) || {}
      const isLurker = settings.botEnabled === false

      if (eventName === 'ChatMessage') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        const text = eventPayload.message || ''
        broadcast({ type: 'chat', djId, nick: author, text })
        if (!isLurker) {
          handleShieldCommand(djId, room, settings, author, authorId, text)
          handleFlagCommand(djId, room, settings, author, authorId, text)
          handleFundingCommand(djId, room, settings, author, authorId, text)
          handleShortcutCommand(djId, room, settings, author, authorId, liveId, text)
          handleSongRequestCommand(djId, room, settings, author, authorId, text)
          handleRouletteCommand(djId, room, settings, author, authorId, liveId, text)
          handleKeepCommands(djId, room, settings, author, authorId, liveId, text)
          handleRouletteGiveCommand(djId, room, settings, author, authorId, text)
          handleRouletteMenuCommand(djId, settings, text)
        }

      } else if (eventName === 'RoomJoin') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'join', djId, nick: author })

        // 퇴장 감지 스냅샷에도 즉시 등록 (폴링 주기 사이에 짧게 머문 유저도 잡히도록)
        const joinSnapshotKey = author.toString().toLowerCase()
        registerJoinSnapshot(room, author, null)

        if (!isLurker) {
          const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          if (tag) registerJoinSnapshot(room, author, tag, joinSnapshotKey) // 태그 알아내면 스냅샷 키를 태그 기준으로 갱신 (이전 닉네임 키 정리)
          const greeting = tag ? (settings.greetings || []).find(g => String(g.tag).toLowerCase() === tag.toLowerCase()) : null

          if (greeting) {
            const text = greeting.message.replace(/{유저}/g, author).replace(/{nickname}/g, author).replace(/{tag}/g, `@${tag}`)
            setTimeout(() => sendChatToRoom(djId, text), 500)
          } else {
            const msgs = (settings.joinMessages || []).filter(m => m.enabled)
            if (msgs.length > 0) {
              const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, tag ? `@${tag}` : '')
              setTimeout(() => sendChatToRoom(djId, text), 500)
            }
          }
        }

      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const gen = eventPayload.generator || {}
        const author = eventPayload.nickname || gen.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'like', djId, nick: author })
        const msgs = isLurker ? [] : (settings.likeMessages || []).filter(m => m.enabled)
        if (msgs.length > 0) {
          const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, tag ? `@${tag}` : '')
          setTimeout(() => sendChatToRoom(djId, text), 500)
        }

      } else if (eventName === 'LiveDonation' || eventName === 'live_present' || eventName === 'DonationMessage') {
        const gen = eventPayload.generator || {}
        const author = eventPayload.nickname || gen.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        const amount = Number(eventPayload.amount || eventPayload.spoonCount || eventPayload.spoon_count || eventPayload.quantity || eventPayload.value || 0)
        const comboCount = Number(eventPayload.comboCount || eventPayload.combo_count || eventPayload.combo || 1)
        const sticker = eventPayload.sticker || eventPayload.stickerName || eventPayload.sticker_name || eventPayload.name || ''
        broadcast({ type: 'donation', djId, nick: author, amount, comboCount, sticker })
        if (!isLurker) {
          handleFlagAutoDonation(djId, settings, amount * Math.max(1, comboCount))
          handleRouletteAutoGrant(djId, settings, author, authorId, liveId, amount, comboCount, sticker)
        }
      }
    } catch (e) {
      console.log(`[${djId}] WS 파싱 오류`, e.message)
    }
  })

  ws.on('close', (code) => {
    console.log(`[${djId}] 스푼 연결 종료 code:`, code)
    room.isConnected = false
    room.ws = null
    stopLeavePolling(djId)
    broadcast({ type: 'status', djId, isConnected: false })
  })

  ws.on('error', (e) => {
    console.log(`[${djId}] 스푼 오류:`, e.message)
    room.isConnected = false
  })
}

// ══════════════════════════════════════════════════════
// (실시간 방송 감시 폴링은 제거됨 — 이제 고유닉으로 즉시 1회 입장하는 방식만 사용)

// 5분마다 "주기 출력" 켜진 깃발의 현재 상태를 채팅으로 자동 출력
setInterval(() => {
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (!room.isConnected) continue
    const settings = store.getSettings(djId)
    const items = settings?.flags?.items || []
    items.forEach((f, i) => {
      if (f.useCycle) sendChatToRoom(djId, renderFlagTemplate(f.template, f, i + 1))
    })
  }
}, 5 * 60 * 1000)

// ══════════════════════════════════════════════════════
// 🔁 반복 문구 — 입장 설정 > 반복문구 탭에서 등록한 메시지를, 각자 설정한 간격(분/초)마다
// 방송에 봇이 들어가 있는 동안 자동으로 채팅에 전송한다. 메시지마다 간격이 다를 수 있어서
// 짧은 주기(10초)로 깨어나 각 메시지의 마지막 전송 시각과 비교하는 방식으로 처리한다.
const repeatLastSent = {} // djId -> { [messageId]: timestampMs }
const REPEAT_TICK_MS = 10 * 1000

setInterval(() => {
  const now = Date.now()
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (!room.isConnected) continue
    const settings = store.getSettings(djId) || {}
    if (settings.botEnabled === false) continue
    const list = settings.entryData?.repeat || []
    if (!list.length) continue

    if (!repeatLastSent[djId]) repeatLastSent[djId] = {}
    const lastMap = repeatLastSent[djId]

    list.forEach(m => {
      if (!m || m.enabled === false) return
      const text = String(m.text || '').trim()
      if (!text) return
      const intervalMs = ((Number(m.intervalMin) || 0) * 60 + (Number(m.intervalSec) || 0)) * 1000
      if (intervalMs <= 0) return

      const last = lastMap[m.id]
      if (last == null) {
        // 처음 감지된 메시지는 바로 쏘지 않고, 그 시점부터 간격을 재기 시작한다.
        lastMap[m.id] = now
        return
      }
      if (now - last >= intervalMs) {
        const out = text.replace(/{tag}/g, settings.autoJoinTag ? `@${settings.autoJoinTag}` : '')
        sendChatToRoom(djId, out)
        lastMap[m.id] = now
      }
    })
  }
}, REPEAT_TICK_MS)

// ══════════════════════════════════════════════════════
// 🎀 스티커 목록 프록시 — 브라우저에서 static.spooncast.net을 직접 fetch하면
// CDN이 CORS 헤더를 안 내려줘서 막히는 경우가 있어, 서버가 대신 가져와 내려준다.
// 결과는 메모리에 잠깐 캐싱해서 매번 스푼 CDN에 다시 요청하지 않도록 한다.
let stickerCache = { data: null, fetchedAt: 0 }
const STICKER_CACHE_TTL_MS = 30 * 60 * 1000 // 30분

app.get('/stickers', async (req, res) => {
  try {
    const now = Date.now()
    if (stickerCache.data && (now - stickerCache.fetchedAt) < STICKER_CACHE_TTL_MS) {
      return res.json({ success: true, cached: true, stickers: stickerCache.data })
    }

    const upstream = await fetch('https://static.spooncast.net/kr/stickers/index.json', {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/json' }
    })
    if (!upstream.ok) throw new Error('upstream status ' + upstream.status)
    const raw = await upstream.json()

    const nowDate = new Date(now)
    const list = []
    ;(raw.categories || []).forEach(cat => {
      // 주의: 카테고리 레벨의 is_used는 스푼 API에서 실제 노출 여부와 무관하게 거의 항상 false로 내려오므로
      // 이 값으로 카테고리 전체를 거르면 안 된다. 개별 스티커의 is_used만 기준으로 삼는다.
      ;(cat.stickers || []).forEach(s => {
        if (s.is_used === false) return
        if (!s.name) return
        // 현재 판매 기간(start_date ~ end_date) 안에 있는 스티커만 노출 — 종료된 이벤트 스티커 제외
        if (s.start_date) {
          const start = new Date(s.start_date)
          if (!isNaN(start) && start > nowDate) return
        }
        if (s.end_date) {
          const end = new Date(s.end_date)
          if (!isNaN(end) && end < nowDate) return
        }
        list.push({
          name: s.name,
          title: s.title || s.name,
          image: s.image_thumbnail_web || s.image_thumbnail || s.image_url_web || '',
          price: s.price || 0,
          category: cat.title || cat.name || ''
        })
      })
    })
    // 같은 name이 여러 카테고리에 중복 등록된 경우 대비, name 기준 중복 제거
    const dedup = new Map()
    list.forEach(s => dedup.set(s.name, s))
    const stickers = Array.from(dedup.values())

    stickerCache = { data: stickers, fetchedAt: now }
    res.json({ success: true, cached: false, stickers })
  } catch (e) {
    console.log('[스티커 목록 조회 오류]', e.message)
    // 실패해도 이전에 캐시된 값이 있으면 그거라도 내려준다.
    if (stickerCache.data) {
      return res.json({ success: true, cached: true, stale: true, stickers: stickerCache.data })
    }
    res.status(502).json({ success: false, error: '스티커 목록을 가져오지 못했어요: ' + e.message })
  }
})

// ══════════════════════════════════════════════════════
// 계정 (디제이별 가입/로그인)
app.post('/auth/signup', (req, res) => {
  const { djId, password } = req.body || {}
  const result = store.signup(djId, password)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true, msg: '가입 완료! 로그인해주세요.' })
})

function canAutoJoin(djId) {
  return djId === 'sum' || store.getAutoJoinEnabled(djId)
}

app.post('/auth/login', (req, res) => {
  const { djId, password } = req.body || {}
  const result = store.login(djId, password)
  if (!result.ok) return res.json({ success: false, error: result.error })
  const token = auth.issueToken(djId)
  res.json({ success: true, token, djId, autoJoinEnabled: canAutoJoin(djId) })
})

app.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ success: true, djId: req.djId, autoJoinEnabled: canAutoJoin(req.djId) })
})

// 관리자(sum) 전용 — 가입한 디제이 목록 + 상태 조회
app.get('/admin/users', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const users = store.listDjSummaries().map(u => {
    const room = getRoom(u.djId)
    return { ...u, isConnected: room.isConnected }
  })
  res.json({ success: true, users })
})

app.post('/admin/users/:djId/block', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const targetId = req.params.djId
  if (targetId === 'sum') return res.json({ success: false, error: '관리자 계정은 차단할 수 없어요' })
  const { blocked } = req.body || {}
  const ok = store.setBlocked(targetId, !!blocked)
  if (!ok) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  res.json({ success: true })
})

app.post('/admin/users/:djId/delete', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const targetId = req.params.djId
  if (targetId === 'sum') return res.json({ success: false, error: '관리자 계정은 삭제할 수 없어요' })
  const room = getRoom(targetId)
  if (room.ws) { room.ws.terminate() }
  delete rooms[targetId]
  const ok = store.deleteDj(targetId)
  if (!ok) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  res.json({ success: true })
})

// 관리자(sum) 전용 — 특정 디제이의 자동입장(방입장) 기능 허용/차단
app.post('/admin/users/:djId/autojoin', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const targetId = req.params.djId
  if (targetId === 'sum') return res.json({ success: false, error: '관리자 계정은 항상 사용 가능해요' })
  const { enabled } = req.body || {}
  const ok = store.setAutoJoinEnabled(targetId, !!enabled)
  if (!ok) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════
// 디제이별 설정 (로그인 필요)
app.get('/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId)
  res.json({ success: true, settings })
})

app.get('/roulette/users', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const tags = Object.keys(settings.rouletteHistory || {})
  res.json({ success: true, tags })
})

app.get('/roulette/history/:tag', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const tag = req.params.tag
  const rec = (settings.rouletteHistory && settings.rouletteHistory[tag]) || { coupons: {}, wins: [], keepList: {}, miscList: {}, eventList: {} }
  res.json({ success: true, tag, record: rec, roulette: settings.roulette })
})

// 시청자를 기록 목록에 수동으로 추가(빈 기록 생성)
app.post('/roulette/history/:tag/track', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  getHistoryRec(settings, req.params.tag)
  store.saveSettings(req.djId, { rouletteHistory: settings.rouletteHistory })
  res.json({ success: true })
})

app.post('/roulette/history/:tag/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (settings.rouletteHistory) delete settings.rouletteHistory[req.params.tag]
  store.saveSettings(req.djId, { rouletteHistory: settings.rouletteHistory || {} })
  res.json({ success: true })
})

app.post('/roulette/history/:tag/coupon', auth.requireAuth, (req, res) => {
  const { idx, delta } = req.body || {}
  if (!idx || !delta) return res.json({ success: false, error: '잘못된 요청' })
  const settings = store.getSettings(req.djId) || {}
  const rec = getHistoryRec(settings, req.params.tag)
  rec.coupons[idx] = Math.max(0, Number(rec.coupons[idx] || 0) + Number(delta))
  store.saveSettings(req.djId, { rouletteHistory: settings.rouletteHistory })
  res.json({ success: true, coupons: rec.coupons })
})

// 킵목록/기타목록/이벤트목록 관리 (add / remove / clear)
app.post('/roulette/history/:tag/list', auth.requireAuth, (req, res) => {
  const { listType, action, text } = req.body || {}
  const key = listType === 'keep' ? 'keepList' : listType === 'event' ? 'eventList' : 'miscList'
  const settings = store.getSettings(req.djId) || {}
  const rec = getHistoryRec(settings, req.params.tag)
  if (action === 'add' && text) rec[key][text] = (rec[key][text] || 0) + 1
  else if (action === 'remove' && text) delete rec[key][text]
  else if (action === 'clear') rec[key] = {}
  store.saveSettings(req.djId, { rouletteHistory: settings.rouletteHistory })
  res.json({ success: true, list: rec[key] })
})

app.post('/roulette/history/reset', auth.requireAuth, (req, res) => {
  store.saveSettings(req.djId, { rouletteHistory: {} })
  res.json({ success: true })
})

app.post('/settings', auth.requireAuth, (req, res) => {
  const { joinMessages, likeMessages, leaveMessages, entryData, entryCooldown, funding, shield, flags, commands, greetings, songRequest, roulette, rouletteHistory } = req.body || {}
  const patch = {}
  if (joinMessages) patch.joinMessages = joinMessages
  if (likeMessages) patch.likeMessages = likeMessages
  if (leaveMessages) patch.leaveMessages = leaveMessages
  if (entryData) patch.entryData = entryData
  if (typeof entryCooldown === 'number') patch.entryCooldown = entryCooldown
  if (funding) patch.funding = funding
  if (shield) patch.shield = shield
  if (flags) patch.flags = flags
  if (commands) patch.commands = commands
  if (greetings) patch.greetings = greetings
  if (songRequest) patch.songRequest = songRequest
  if (roulette) patch.roulette = roulette
  if (rouletteHistory) patch.rouletteHistory = rouletteHistory
  store.saveSettings(req.djId, patch)
  res.json({ success: true })
})

// 관리자(sum) 전용 — 등록해둔 여러 고유닉 중 방송 중인 곳을 찾아 자동으로 입장한다. (다른 디제이는 해당 없음)
async function checkAdminAutoJoin() {
  for (const djId of store.listDjIds()) {
    if (!canAutoJoin(djId)) continue
    if (!tokenManager.getAccessToken(SHARED_TOKEN_DJID)) continue // 관리자 계정에 아직 발급된 토큰이 없으면 건너뜀

    const settings = store.getSettings(djId)
    if (!settings || !settings.autoJoinWatch) continue
    const tagList = (settings.autoJoinTags && settings.autoJoinTags.length) ? settings.autoJoinTags : (settings.autoJoinTag ? [settings.autoJoinTag] : [])
    if (!tagList.length) continue

    const room = getRoom(djId)
    if (room.checking) continue
    room.checking = true

    try {
      // 이미 어딘가 들어가 있으면, 그 방송이 여전히 켜져있는지 확인만 하고 유지 (끝났으면 연결 해제)
      if (room.isConnected && room.watchingTag) {
        const cur = await fetchUserStatusByTag(room.watchingTag)
        if (!cur || !cur.is_live || !cur.current_live_id) {
          console.log(`[${djId}] @${room.watchingTag} 방송 종료 감지 → 연결 해제`)
          if (room.ws) { room.ws.terminate(); room.ws = null }
          room.isConnected = false
          room.autoJoinedFor = ''
          room.watchingTag = ''
          stopLeavePolling(djId)
          broadcast({ type: 'status', djId, isConnected: false })
          broadcast({ type: 'autojoin', djId, status: 'offline', tag: room.watchingTag })
        }
        continue
      }

      for (const tag of tagList) {
        const status = await fetchUserStatusByTag(tag)
        if (status && status.is_live && status.current_live_id) {
          const liveId = String(status.current_live_id)
          broadcast({ type: 'autojoin', djId, status: 'joining', tag, liveId })
          const roomToken = await tokenManager.fetchRoomToken(SHARED_TOKEN_DJID, liveId)
          room.autoJoinedFor = liveId
          room.watchingTag = tag
          await connectSpoonForDj(djId, liveId, roomToken || '')
          broadcast({ type: 'autojoin', djId, status: 'joined', tag, liveId })
          break
        }
      }
    } catch (e) {
      console.log(`[자동입장:${djId} 오류]`, e.message)
    } finally {
      room.checking = false
    }
  }
}

setInterval(checkAdminAutoJoin, 15000)

// 관리자 전용 — 봇 응답 전체 on/off (꺼두면 어떤 명령어에도 반응하지 않는 순수 시청 모드)
app.post('/bot/toggle', auth.requireAuth, (req, res) => {
  const { enabled } = req.body || {}
  store.saveSettings(req.djId, { botEnabled: !!enabled })
  res.json({ success: true, msg: enabled ? '봇 기능 켜짐' : '봇 기능 꺼짐 (순수 시청 모드)' })
})

// 관리자 또는 자동입장 허용된 디제이 — 등록 고유닉 목록 자동감시 on/off
app.post('/autojoin/watch', auth.requireAuth, (req, res) => {
  if (!canAutoJoin(req.djId)) return res.status(403).json({ success: false, error: '관리자가 자동입장 권한을 켜줘야 사용할 수 있어요' })
  const djId = req.djId
  const { enabled, tags } = req.body || {}
  const cleanTags = Array.isArray(tags) ? tags.map(t => String(t).replace('@', '').trim()).filter(Boolean) : []

  if (enabled && !cleanTags.length) return res.json({ success: false, error: 'DJ 고유닉을 한 줄에 하나씩 입력해주세요' })

  store.saveSettings(djId, { autoJoinTags: cleanTags, autoJoinWatch: !!enabled })
  if (!enabled) {
    const room = getRoom(djId)
    room.autoJoinedFor = ''
  }
  broadcast({ type: 'autojoin', djId, status: enabled ? 'watching' : 'off', tags: cleanTags })
  res.json({ success: true, msg: enabled ? `${cleanTags.length}개 고유닉 감시 시작` : '감시 중지됨' })
})

app.post('/autojoin', auth.requireAuth, async (req, res) => {
  const { tag } = req.body || {}
  const djId = req.djId
  const room = getRoom(djId)
  const cleanTag = String(tag || '').replace('@', '').trim()

  if (!cleanTag) {
    return res.json({ success: false, error: 'DJ 고유닉을 입력해주세요' })
  }
  if (!tokenManager.getAccessToken(SHARED_TOKEN_DJID)) {
    return res.json({ success: false, error: '스푼 계정이 아직 연결되지 않았어요. 먼저 세션 연결을 진행해주세요.' })
  }

  store.saveSettings(djId, { autoJoinTag: cleanTag })
  broadcast({ type: 'autojoin', djId, status: 'joining', tag: cleanTag })

  try {
    const status = await fetchUserStatusByTag(cleanTag)
    if (!status || !status.is_live || !status.current_live_id) {
      broadcast({ type: 'autojoin', djId, status: 'offline', tag: cleanTag })
      return res.json({ success: false, error: '현재 방송 중이 아니에요' })
    }

    const liveId = String(status.current_live_id)
    const roomToken = await tokenManager.fetchRoomToken(SHARED_TOKEN_DJID, liveId)
    room.autoJoinedFor = liveId
    room.watchingTag = cleanTag
    await connectSpoonForDj(djId, liveId, roomToken || '')
    broadcast({ type: 'autojoin', djId, status: 'joined', tag: cleanTag, liveId })
    res.json({ success: true, msg: `@${cleanTag} 방 입장 완료` })
  } catch (e) {
    broadcast({ type: 'autojoin', djId, status: 'error', tag: cleanTag, msg: e.message })
    res.json({ success: false, error: '입장 중 오류: ' + e.message })
  }
})

// 감시(자동입장)는 계속 켜둔 채로, 지금 들어가 있는 방에서만 즉시 나가기.
// (방송이 계속 켜져 있어도 재입장하지 않도록 autoJoinedFor를 비우지 않고 그대로 유지)
app.post('/room/leave', auth.requireAuth, (req, res) => {
  const djId = req.djId
  const room = getRoom(djId)
  if (room.ws) { room.ws.terminate(); room.ws = null }
  room.isConnected = false
  room.autoJoinedFor = ''
  room.watchingTag = ''
  stopLeavePolling(djId)
  broadcast({ type: 'status', djId, isConnected: false })
  res.json({ success: true, msg: '현재 방에서 나갔어요' })
})

app.get('/status', auth.requireAuth, (req, res) => {
  const room = getRoom(req.djId)
  const settings = store.getSettings(req.djId)
  res.json({
    isConnected: room.isConnected,
    autoJoinTag: settings?.autoJoinTag || '',
    hasSession: tokenManager.hasCookies(SHARED_TOKEN_DJID),
    hasToken: !!tokenManager.getAccessToken(SHARED_TOKEN_DJID),
  })
})

app.post('/chat', auth.requireAuth, async (req, res) => {
  const { message } = req.body || {}
  if (!message) return res.json({ error: '메시지 없음' })
  await sendChatToRoom(req.djId, message)
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════
// 스푼 세션 쿠키 업로드 — 로그인한 DJ 본인 계정에만 연결된다. (djId별 멀티 계정 구조)
// ⚠️ 지금은 모든 DJ가 이 계정의 토큰을 공유해서 쓰므로, 세션 업로드도 관리자(sum)만 가능하게 제한한다.
app.post('/session/upload', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 세션을 연결할 수 있어요' })
  const { cookies, localStorage, sessionStorage } = req.body
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    return res.json({ success: false, error: '쿠키 데이터가 비어있습니다' })
  }
  tokenManager.setCookies(SHARED_TOKEN_DJID, { cookies, localStorage, sessionStorage })
  // setCookies가 업로드된 쿠키에서 accessToken을 이미 즉시 반영하므로, 여기서 또 Puppeteer를
  // 띄워 재확인할 필요는 없다. PC 자동동기화가 멈췄을 때를 대비한 백업 타이머만 최초 1회 걸어둔다.
  tokenManager.ensureAutoRefresh(SHARED_TOKEN_DJID, 180)
  console.log(`[세션:${SHARED_TOKEN_DJID}] 쿠키 업로드됨 (${cookies.length}개) → accessToken 발급 시도`)
  res.json({ success: true, msg: '쿠키 업로드 완료. accessToken 발급을 시도합니다.' })
})

app.get('/session/status', (req, res) => {
  res.json({ hasSession: tokenManager.hasCookies(SHARED_TOKEN_DJID), hasToken: !!tokenManager.getAccessToken(SHARED_TOKEN_DJID) })
})

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sseClients.push(res)
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res) })
})

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html')
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`서버 실행 중: ${PORT}`)
  // 디스크에 저장된 세션(Volume)이 있으면 불러와서, 계정마다 자동 갱신을 바로 재개한다.
  const loadedDjIds = tokenManager.initFromDisk()
  if (loadedDjIds.length) {
    console.log(`[세션] 저장된 세션 발견 (${loadedDjIds.length}개 계정) → accessToken 자동 갱신 재개`)
    tokenManager.startAutoRefreshForAll(loadedDjIds, 30)
  }
})