const WebSocket = require('ws')
const express = require('express')
const cors = require('cors')
const tokenManager = require('./tokenManager')
const store = require('./store')
const auth = require('./auth')
const { buildMigrationPatch } = require('./localMigrate')

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '20mb' })) // 로컬 에디봇 설정 마이그레이션 업로드(/account/migrate-local)를 위해 여유있게 설정
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
    rooms[djId] = { ws: null, isConnected: false, streamName: '', roomToken: '', autoJoinedFor: '', watchingTag: '', checking: false, liveDjUserId: null, tagCache: new Map(), tagToNickname: new Map() }
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
    // ⚠️ 스푼 API가 가끔(권한 문제 등으로) 요청한 유저가 아니라 "봇 계정 자신의" 프로필을
    // 잘못 돌려주는 경우가 있다. 응답의 id가 우리가 물어본 userId와 다르면 무조건 무시한다.
    // (이걸 안 걸러내면 서로 다른 시청자의 기록이 전부 봇 계정 태그 하나로 뒤섞여버림)
    const returnedId = profile.id != null ? Number(profile.id) : (profile.user_id != null ? Number(profile.user_id) : null)
    if (returnedId != null && returnedId !== Number(userId)) {
      console.log(`[tag 조회 불일치] 요청 userId=${userId} 응답 id=${returnedId} → 무시하고 null 처리`)
      return null
    }
    let tag = profile.tag || profile.tag_name || profile.username || profile.id_name || null
    if (tag) tag = String(tag).replace('@', '').trim()
    return tag
  } catch (e) {
    console.log('[tag 조회 오류]', e.message)
    return null
  }
}

// 한 번 성공적으로 확인된 유저의 태그는 room별로 캐시해서 계속 재사용한다.
// (스푼 프로필 조회 API가 가끔 결과가 오락가락하는 문제가 있어서, 매번 새로 조회하면
//  선물 시점과 명령어 입력 시점에 서로 다른 값이 나와 기록이 어긋나는 문제가 생김.
//  한 번 확실하게(요청 userId와 응답 id가 일치) 확인된 값만 캐시하고, 이후엔 API를 다시 부르지 않는다.)
async function getCachedUserTag(room, liveId, userId, accessToken) {
  if (userId == null) return null
  if (room && room.tagCache && room.tagCache.has(userId)) {
    return room.tagCache.get(userId)
  }
  const tag = await fetchUserTag(liveId, userId, accessToken)
  if (tag && room && room.tagCache) {
    room.tagCache.set(userId, tag)
  }
  return tag
}

// 채팅/입장/좋아요/선물 이벤트가 들어올 때마다 태그↔닉네임 매핑을 방 단위로 기록해둔다.
// DJ가 !룰렛지급 등에서 태그로 대상을 지정해도, 실제 저장은 닉네임 기준이라서
// "이 태그는 이 닉네임"이라는 걸 알아야 정확히 찾아서 표시할 수 있다.
function rememberTagNickname(room, tag, nickname) {
  if (!room || !room.tagToNickname || !tag || !nickname) return
  room.tagToNickname.set(String(tag).trim().toLowerCase(), nickname)
}

// DJ가 입력한 값(태그일 수도, 닉네임일 수도 있음)을 실제 닉네임으로 변환한다.
// 매핑에 없으면 입력값을 그대로 닉네임으로 간주한다 (DJ가 닉네임을 직접 입력한 경우).
function resolveNicknameFromInput(room, input) {
  const clean = String(input || '').trim().replace(/^@/, '')
  if (!clean) return clean
  const mapped = room && room.tagToNickname ? room.tagToNickname.get(clean.toLowerCase()) : null
  return mapped || clean
}

// 방송 실시간 시청자 명단 조회 (퇴장 감지용 폴링에 사용) — 스푼은 퇴장 소켓 이벤트를 보내지 않음
async function fetchLiveMembers(liveId, accessToken, maxPages = 1) {
  if (!liveId || !accessToken) return []
  try {
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': CHROME_UA,
      'Origin': 'https://www.spooncast.net',
    }
    let url = `${KR_API_BASE}/lives/${liveId}/members/`
    const all = []
    let pages = 0
    while (url && pages < maxPages) { // 5초마다 도는 일반 폴링은 1페이지만, 필요한 곳에서만 더 깊이 조회
      const res = await fetch(url, { headers })
      const json = await res.json()
      const members = json.results || []
      all.push(...members)
      url = json.next || null
      pages++
    }
    return all.map(m => {
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

// 사이드바 메뉴별 ON/OFF 값을 확인한다. moduleEnabled 필드에 그 키가 아예 없는 경우(예전 계정 등)엔
// 원래 있던 기존 모듈들은 하위호환을 위해 기본 켜진 것으로 간주하지만, 새로 추가되는 모듈은
// NEW_MODULE_DEFAULT_OFF_KEYS에 등록해두면 값이 없을 때 기본 꺼진 것으로 간주한다 — 그래야 이미
// 가입해있던 유저들에게도 새 모듈이 자동으로 켜진 채 나타나지 않고, 모듈 마켓에서 직접 켜야만 보인다.
// 이용 만료일(expiresAt)이 지난 계정은 입장설정/룰렛기록을 제외한 모든 메뉴가 강제로 꺼진다.
// ⚠️ 관리자(sum) 계정은 화면에서 이용 만료일을 직접 입력/수정할 수는 있지만(테스트/기록용),
//    스스로를 잠가버리는 사고를 막기 위해 만료 강제잠금 자체는 항상 적용하지 않는다.
const EXPIRY_EXEMPT_KEYS = ['entrysettings', 'roulettelog']
const NEW_MODULE_DEFAULT_OFF_KEYS = ['lottoauto'] // 새로 추가하는 모듈은 여기에 키를 등록한다
function isAccountExpired(settings, djId) {
  if (djId === 'sum') return false
  return !!(settings && settings.expiresAt && Date.now() > new Date(settings.expiresAt).getTime())
}
function isModuleOn(settings, key, djId) {
  if (isAccountExpired(settings, djId) && !EXPIRY_EXEMPT_KEYS.includes(key)) return false
  const v = settings && settings.moduleEnabled ? settings.moduleEnabled[key] : undefined
  if (v === undefined) return !NEW_MODULE_DEFAULT_OFF_KEYS.includes(key)
  return v !== false
}

// 실드 명령어 처리: "!실드", "!실드 +5", "!실드 -3" (명령어 자체는 DJ가 커스텀 가능)
async function handleShieldCommand(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'shield', djId)) return
  const shield = settings.shield
  if (!shield || !shield.cmd) return

  const cmd = shield.cmd.trim()
  const re = new RegExp(`^${escapeRegExp(cmd)}(?:\\s*([+-]\\s*\\d+))?\\s*$`)
  const m = String(text || '').trim().match(re)
  if (!m) return

  const delta = m[1] ? parseInt(m[1].replace(/\s/g, ''), 10) : null

  // 조회 (인자 없음) — 누구나 가능
  if (delta === null) {
    const reply = (shield.msgView || '현재 실드: {실드}개').replace(/{실드}/g, (shield.count || 0).toLocaleString())
    setTimeout(() => sendChatToRoom(djId, reply), 400)
    return
  }

  // 적립/차감 — DJ 본인 또는 등록된 권한자(고유닉/태그)만 가능 (단, strictPerms가 켜져있으면 DJ 자동 허용 자체를 끔)
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const perms = (shield.perms || []).map(t => String(t).replace('@', '').toLowerCase())
  const authorNorm = String(author || '').toLowerCase()

  // 1) 그동안 관측된 태그↔닉네임 매핑으로 먼저 확인
  let isPermUser = perms.some(p => p === authorNorm || String(resolveNicknameFromInput(room, p) || '').toLowerCase() === authorNorm)

  // 2) 못 찾았으면, 그 자리에서 시청자 명단(더 안정적인 API)을 다시 조회해서 이 사람의 실제 태그를 확인한다.
  if (!isPermUser && perms.length && liveId) {
    try {
      const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
      const freshMembers = await fetchLiveMembers(liveId, accessToken, 5)
      const me = freshMembers.find(u => u.nickname && u.nickname.toLowerCase() === authorNorm)
      if (me && me.tag) {
        rememberTagNickname(room, me.tag, author)
        isPermUser = perms.includes(me.tag.toLowerCase())
      }
    } catch (e) {
      console.log('[실드 권한 재조회 오류]', e.message)
    }
  }

  const allowed = shield.strictPerms ? isPermUser : (isDj || isPermUser)
  if (!allowed) {
    setTimeout(() => sendChatToRoom(djId, '❌ 실드 조절 권한이 없어요'), 400)
    return
  }

  shield.count = Math.max(0, (shield.count || 0) + delta)
  store.saveSettings(djId, { shield })
  broadcast({ type: 'shield', djId, count: shield.count })

  const amount = Math.abs(delta)
  const tpl = delta > 0 ? (shield.msgAdd || '실드 {amount}개 적립! 현재: {실드}개') : (shield.msgSub || '실드 {amount}개 차감! 현재: {실드}개')
  const reply = tpl
    .replace(/{amount}/g, amount.toLocaleString())
    .replace(/{실드}/g, (shield.count || 0).toLocaleString())
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
  if (!isModuleOn(settings, 'flag', djId)) return
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
  if (!isModuleOn(settings, 'flag', djId)) return
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
  if (!isModuleOn(settings, 'funding', djId)) return
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
  if (!isModuleOn(settings, 'shortcuts', djId)) return
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
    const tag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
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
function getSongRequestSettings(djId, settings) {
  if (!settings.songRequest) {
    settings.songRequest = {
      accepting: true, priorityMode: false, showRequester: true,
      cmdRequest: '!신청곡', cmdRemove: '!제거', cmdReset: '리셋', cmdClose: '!마감', cmdOpen: '!접수',
      cmdPriorityOn: '!우선온', cmdPriorityOff: '!우선오프', cmdNameOn: '!이름온', cmdNameOff: '!이름오프',
      doneTemplate: '✅ [{artist} - {title}] 신청 완료! (대기: {count}번)',
      listTitle: '🎵 현재 신청곡 목록 🎵', listItemTemplate: '{index}. {artist} - {title}',
      maxCharsPerMsg: 100, msgIntervalMs: 600, items: []
    }
    // 최초 1회는 실제로 저장해서, 이후 /settings 조회(웹 화면)에서도 같은 값이 보이도록 한다.
    store.saveSettings(djId, { songRequest: settings.songRequest })
  }
  return settings.songRequest
}

function handleSongRequestCommand(djId, room, settings, author, authorId, text) {
  if (!isModuleOn(settings, 'request', djId)) return
  const sr = getSongRequestSettings(djId, settings)
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

// ══════════════════════════════════════════════════════
// ⭐ 애청지수 (로컬 에디봇의 활동 포인트/레벨/복권 시스템과 동일한 사양)
// 키는 룰렛 기록과 마찬가지로 "닉네임" 고정 (스푼 태그 조회 API가 신뢰할 수 없어서 사용하지 않음)

function getActivitySettings(djId, settings) {
  if (!settings.activity) {
    settings.activity = {
      enabled: true,
      cmdMyInfo: '!내정보', cmdCreate: '!내정보 생성', cmdDelete: '!내정보 삭제',
      cmdRank: '!랭킹', cmdLotto: '!복권', cmdAttend: '!출석',
      cmdLottoGive: '!복권지급', cmdShop: '!상점', cmdAt: '@',
      grantNicknames: [], // DJ 외에 복권지급/상점 명령어를 쓸 수 있는 닉네임 목록
      lvBase: 100,
      scoreHeart: 1, scorePaidHeart: null, scoreChat: 2, scoreAttend: 10, scoreLottoPoint: 5,
      lottoExchange: 22, lotto1st: 3000, lotto2nd: 500, lotto3rd: 100, lottoFail: 1,
      lvUpLottoEnabled: true, lvUpLottoInterval: 10, lvUpLottoAmount: 1,
      autoAttendEnabled: true, autoAttendIntervalMin: 30,
      msgCreate: '✅ {nickname}님의 애청지수 정보가 생성되었습니다!',
      msgDeleteOk: '🗑️ {nickname}님의 애청지수 정보가 삭제되었습니다.',
      msgNoInfo: "⚠️ {nickname}님은 정보가 없습니다. '!내정보 생성' 으로 등록하세요.",
      msgMyInfo: "[ '{nickname}'님 활동정보 ]\n순위 : {rank}위\n레벨 : {level} ({exp}/{nextExp})\n하트 : {heart}\n채팅 : {chat}\n출석 : {attend}\n복권포인트 : {lp}/{lpMax}\n복권 : {lotto}",
      msgRankHeader: '🏆 애청지수 TOP 5 🏆',
      msgRankLine: '{rank}위: {nickname} (Lv.{level})',
      msgLvUpLotto: '🎉 {nickname}님 Lv.{level} 달성! 복권 {amount}장 지급! (보유: {lotto}장)',
      msgLottoHeader: '🎰 {nickname}님의 복권 {count}개 지정 결과',
      msgLottoWin: '🎊당첨번호:{winNums}',
      msgLottoMy: '✨나의번호:{myNums}',
      msgLottoTotal: '🎁 총 획득 경험치: +{totalExp} EXP',
      msgLottoAutoHeader: '🎰 {nickname}님의 복권 {count}개 자동 결과',
      msgLottoFull: '🎟️ {nickname}님 복권 {gained}장 지급! (보유: {lotto}장 | 포인트: {lp}/{lpMax})',
      users: {}
    }
    store.saveSettings(djId, { activity: settings.activity })
  }
  if (!settings.activity.users) settings.activity.users = {}
  return settings.activity
}

function actGetLevel(exp, lvBase) {
  const base = Number(lvBase) || 100
  const e = Math.max(0, Number(exp) || 0)
  const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + 8 * e / base)) / 2))
  const curStart = base * level * (level - 1) / 2
  const nextExp = base * level
  return { level, curExp: Math.max(0, e - curStart), nextExp }
}

function actRank(users, key) {
  const entries = Object.entries(users).sort((a, b) => (b[1].exp || 0) - (a[1].exp || 0))
  const idx = entries.findIndex(([k]) => k === key)
  return idx >= 0 ? idx + 1 : 0
}

function actFormat(tpl, data) {
  const v = (val) => (val === undefined || val === null || val === '') ? '0' : String(val)
  return String(tpl || '')
    .replace(/{nickname}/g, data.nickname || '')
    .replace(/{tag}/g, data.tag || '')
    .replace(/{rank}/g, v(data.rank))
    .replace(/{level}/g, v(data.level))
    .replace(/{exp}/g, v(data.exp))
    .replace(/{nextExp}/g, v(data.nextExp))
    .replace(/{heart}/g, v(data.heart))
    .replace(/{chat}/g, v(data.chat))
    .replace(/{attend}/g, v(data.attend))
    .replace(/{lp}/g, v(data.lp))
    .replace(/{lpMax}/g, v(data.lpMax))
    .replace(/{lotto}/g, v(data.lotto))
    .replace(/{count}/g, v(data.count))
    .replace(/{totalExp}/g, v(data.totalExp))
    .replace(/{gained}/g, v(data.gained))
    .replace(/{amount}/g, v(data.amount))
    .replace(/{winNums}/g, data.winNums || '')
    .replace(/{myNums}/g, data.myNums || '')
}

// exp 증가 + 레벨업 복권 보상 체크를 한 번에 처리
function actGrantExp(djId, act, key, delta) {
  const d = act.users[key]
  if (!d) return
  const prevExp = d.exp || 0
  d.exp = prevExp + (Number(delta) || 0)
  if (act.lvUpLottoEnabled === false) return
  const interval = Math.max(1, Number(act.lvUpLottoInterval) || 10)
  const amount = Math.max(1, Number(act.lvUpLottoAmount) || 1)
  const prevLevel = actGetLevel(prevExp, act.lvBase).level
  const newLevel = actGetLevel(d.exp, act.lvBase).level
  if (newLevel <= prevLevel) return
  const crossings = Math.floor(newLevel / interval) - Math.floor(prevLevel / interval)
  if (crossings <= 0) return
  const totalGift = crossings * amount
  d.lotto = (d.lotto || 0) + totalGift
  const msg = actFormat(act.msgLvUpLotto, { nickname: d.nickname || key, level: newLevel, amount: totalGift, lotto: d.lotto })
  setTimeout(() => sendChatToRoom(djId, msg), 400)
}

// 로컬봇과 동일한 방식: 태그(고유닉)가 있으면 태그를 키로, 없으면 닉네임을 키로 사용한다.
// 우선순위: 1) 입력값이 그대로 키(태그)로 존재 → 2) 닉네임이 그대로 키로 존재
//         → 3) 등록된 유저 중 tag 필드가 일치 → 4) 등록된 유저 중 nickname 필드가 일치(대소문자 무시)
function actResolveKey(act, author, tag) {
  const a = author, t = tag
  if (t && act.users[t]) return t
  if (a && act.users[a]) return a
  if (t) {
    const byTag = Object.keys(act.users).find(k => act.users[k].tag && String(act.users[k].tag).toLowerCase() === String(t).toLowerCase())
    if (byTag) return byTag
  }
  if (a) {
    const byNick = Object.keys(act.users).find(k => String(act.users[k].nickname || '').toLowerCase() === String(a).toLowerCase())
    if (byNick) return byNick
  }
  return null
}

// DJ가 명령어에 입력한 값(닉네임 또는 태그) 하나로 유저를 찾는다. 입력값을 태그/닉네임 양쪽으로 다 시도한다.
function findActUserKey(act, input) {
  if (!input) return null
  const norm = String(input).trim().replace(/^@/, '')
  return actResolveKey(act, norm, norm)
}

// 유저를 못 찾았을 때, 등록된 닉네임/태그 중 입력값을 포함하는 후보가 있으면 같이 안내해준다.
function actNoUserMsg(act, input) {
  const norm = String(input || '').trim().toLowerCase()
  const candidates = Object.values(act.users)
    .map(d => d.tag ? `${d.nickname}(@${d.tag})` : d.nickname)
    .filter((n, i) => {
      const d = Object.values(act.users)[i]
      return (d.nickname && d.nickname.toLowerCase().includes(norm)) || (d.tag && d.tag.toLowerCase().includes(norm))
    })
    .slice(0, 3)
  let msg = `⚠️ '${input}' 유저의 정보가 없습니다. (등록된 태그 또는 닉네임을 입력해주세요)`
  if (candidates.length) msg += `\n혹시 이 사람인가요? ${candidates.join(', ')}`
  return msg
}

function actEnsureUser(act, key, nickname, tag) {
  if (!act.users[key]) {
    act.users[key] = { nickname: nickname || key, tag: tag || null, heart: 0, chat: 0, attend: 0, lp: 0, lotto: 0, exp: 0, lastAttendTime: 0 }
  } else {
    if (nickname) act.users[key].nickname = nickname
    if (tag) act.users[key].tag = tag
  }
  return act.users[key]
}

// 채팅 수신 시 훅 (등록된 유저만 채팅 EXP 적립, 미등록 유저는 조용히 무시)
// tag가 있으면 그 태그를 키로 우선 사용한다 (로컬봇과 동일한 방식).
function handleActChatHook(djId, settings, author, tag) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const key = actResolveKey(act, author, tag)
  if (!key) return
  const d = act.users[key]
  d.nickname = author
  if (tag) d.tag = tag
  d.chat = (d.chat || 0) + 1
  actGrantExp(djId, act, key, Number(act.scoreChat) || 2)
  store.saveSettings(djId, { activity: act })
}

// 무료 좋아요 수신 시 훅
function handleActHeartHook(djId, settings, author, tag) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const key = actResolveKey(act, author, tag)
  if (!key) return
  const d = act.users[key]
  d.nickname = author
  if (tag) d.tag = tag
  d.heart = (d.heart || 0) + 1
  actGrantExp(djId, act, key, Number(act.scoreHeart) || 1)
  store.saveSettings(djId, { activity: act })
}

// 출석 처리 (수동 !출석 / 자동 출석 타이머) - 30분 쿨다운, 미등록 유저는 조용히 무시
function handleActAttendHook(djId, settings, author, tag) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const key = actResolveKey(act, author, tag)
  if (!key) return
  const d = act.users[key]
  if (tag) d.tag = tag
  const now = Date.now()
  const interval = 30 * 60 * 1000
  if (now - (d.lastAttendTime || 0) < interval) return
  d.lastAttendTime = now
  d.attend = (d.attend || 0) + 1
  actGrantExp(djId, act, key, Number(act.scoreAttend) || 10)
  store.saveSettings(djId, { activity: act })
}

// 선물(스푼) 수신 시 복권포인트 적립 훅 (스푼 1개당 1포인트, exchange 도달 시 복권 1장)
function handleActLottoPointHook(djId, settings, author, amount, tag) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const key = actResolveKey(act, author, tag)
  if (!key) return
  const d = act.users[key]
  if (tag) d.tag = tag
  const exchange = Number(act.lottoExchange) || 22
  const expPerPoint = Number(act.scoreLottoPoint) || 5
  d.lp = (d.lp || 0) + amount
  if (amount > 0 && expPerPoint > 0) actGrantExp(djId, act, key, amount * expPerPoint)
  let gained = 0
  while (d.lp >= exchange) { d.lp -= exchange; d.lotto = (d.lotto || 0) + 1; gained++ }
  if (gained > 0) {
    const msg = actFormat(act.msgLottoFull, { nickname: d.nickname || author, gained, lotto: d.lotto, lp: d.lp, lpMax: exchange })
    setTimeout(() => sendChatToRoom(djId, msg), 400)
  }
  store.saveSettings(djId, { activity: act })
}

// 채팅 명령어 처리: !내정보, !내정보 생성/삭제, !랭킹, !출석, !복권, !복권지급, !상점, @[닉네임]
function handleActivityCommand(djId, room, settings, author, authorId, text, tag) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const msg = String(text || '').trim()
  const parts = msg.split(/\s+/)
  const first = parts[0]
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  // 로컬봇과 동일하게: 이미 등록된 기록이 있으면(태그든 닉네임이든) 그 키를 그대로 쓰고,
  // 처음 등록하는 경우엔 태그를 우선 키로 쓴다 (태그 조회 실패 시에만 닉네임으로 대체).
  const lookupKey = actResolveKey(act, author, tag)
  const key = lookupKey || tag || author
  const save = () => store.saveSettings(djId, { activity: act })

  const cmdMyInfo = act.cmdMyInfo || '!내정보'
  const cmdCreate = act.cmdCreate || '!내정보 생성'
  const cmdDelete = act.cmdDelete || '!내정보 삭제'
  const cmdRank = act.cmdRank || '!랭킹'
  const cmdAttend = act.cmdAttend || '!출석'
  const cmdLotto = act.cmdLotto || '!복권'
  const cmdLottoGive = act.cmdLottoGive || '!복권지급'
  const cmdShop = act.cmdShop || '!상점'
  const cmdAt = act.cmdAt || '@'

  if (msg === cmdCreate) {
    if (act.users[key]) { setTimeout(() => sendChatToRoom(djId, `⚠️ ${author}님은 이미 애청지수 정보가 있습니다.`), 400); return }
    actEnsureUser(act, key, author, tag)
    save()
    setTimeout(() => sendChatToRoom(djId, actFormat(act.msgCreate, { nickname: author })), 400)
    return
  }
  if (msg === cmdDelete) {
    if (!act.users[key]) { setTimeout(() => sendChatToRoom(djId, `⚠️ ${author}님의 정보가 없습니다.`), 400); return }
    delete act.users[key]
    save()
    setTimeout(() => sendChatToRoom(djId, actFormat(act.msgDeleteOk, { nickname: author })), 400)
    return
  }
  if (msg === cmdMyInfo) {
    const d = act.users[key]
    if (!d) { setTimeout(() => sendChatToRoom(djId, actFormat(act.msgNoInfo, { nickname: author })), 400); return }
    const { level, curExp, nextExp } = actGetLevel(d.exp || 0, act.lvBase)
    const rank = actRank(act.users, key)
    const lpMax = Number(act.lottoExchange) || 22
    const out = actFormat(act.msgMyInfo, { nickname: d.nickname || author, tag: d.tag || '', rank, level, exp: curExp, nextExp, heart: d.heart || 0, chat: d.chat || 0, attend: d.attend || 0, lp: d.lp || 0, lpMax, lotto: d.lotto || 0 })
    sendChatSplit(djId, out, 150, 600)
    return
  }
  if (msg === cmdRank) {
    const sorted = Object.entries(act.users).sort((a, b) => (b[1].exp || 0) - (a[1].exp || 0)).slice(0, 5)
    if (!sorted.length) { setTimeout(() => sendChatToRoom(djId, '📊 아직 애청지수 데이터가 없습니다.'), 400); return }
    let out = (act.msgRankHeader || '🏆 애청지수 TOP 5 🏆') + '\n'
    sorted.forEach(([k, d], i) => {
      const { level } = actGetLevel(d.exp || 0, act.lvBase)
      out += actFormat(act.msgRankLine, { rank: i + 1, nickname: d.nickname || k, level, exp: d.exp || 0 }) + '\n'
    })
    sendChatSplit(djId, out.trim(), 150, 600)
    return
  }
  if (msg === cmdAttend) {
    handleActAttendHook(djId, settings, author, tag)
    return
  }
  if (first === cmdLotto) {
    const d = act.users[key]
    if (!d) { setTimeout(() => sendChatToRoom(djId, actFormat(act.msgNoInfo, { nickname: author })), 400); return }
    const args = parts.slice(1)
    const exp1st = Number(act.lotto1st) || 3000
    const exp2nd = Number(act.lotto2nd) || 500
    const exp3rd = Number(act.lotto3rd) || 100
    const expFail = Number(act.lottoFail) || 1
    const nums = args.map(a => parseInt(a, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 9)

    if (nums.length === 3) {
      if ((d.lotto || 0) < 1) { setTimeout(() => sendChatToRoom(djId, `⚠️ ${author}님의 복권이 없습니다.`), 400); return }
      d.lotto -= 1
      const winNums = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, 3).sort((a, b) => a - b)
      const myNums = nums.slice().sort((a, b) => a - b)
      const matches = myNums.filter(n => winNums.includes(n)).length
      let gainExp = expFail
      if (matches === 3) gainExp = exp1st
      else if (matches === 2) gainExp = exp2nd
      else if (matches === 1) gainExp = exp3rd
      actGrantExp(djId, act, key, gainExp)
      save()
      const top = actFormat(act.msgLottoHeader, { nickname: d.nickname || author, count: 1 }) + '\n' +
        actFormat(act.msgLottoWin, { winNums: winNums.join(',') }) + '\n' +
        actFormat(act.msgLottoMy, { myNums: myNums.join(',') })
      const bottom = '━━━━━━━━━━━━━━\n' +
        `🥇 1등(3개): ${matches === 3 ? 1 : 0}회 (+${exp1st} EXP)\n` +
        `🥈 2등(2개): ${matches === 2 ? 1 : 0}회 (+${exp2nd} EXP)\n` +
        `🥉 3등(1개): ${matches === 1 ? 1 : 0}회 (+${exp3rd} EXP)\n` +
        `💀 꽝(0개): ${matches === 0 ? 1 : 0}회 (+${expFail} EXP)\n` +
        '━━━━━━━━━━━━━━\n' + actFormat(act.msgLottoTotal, { totalExp: gainExp })
      setTimeout(() => sendChatToRoom(djId, top), 400)
      setTimeout(() => sendChatToRoom(djId, bottom), 900)
      return
    }

    const count = args.length > 0 && !isNaN(parseInt(args[0], 10)) ? parseInt(args[0], 10) : (d.lotto || 0)
    if (count <= 0 || (d.lotto || 0) <= 0) { setTimeout(() => sendChatToRoom(djId, `⚠️ ${author}님의 복권이 없습니다.`), 400); return }
    const useCount = Math.min(count, d.lotto || 0)
    d.lotto -= useCount
    let cnt1 = 0, cnt2 = 0, cnt3 = 0, cntFail = 0
    for (let i = 0; i < useCount; i++) {
      const win = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, 3)
      const my = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5).slice(0, 3)
      const m = my.filter(n => win.includes(n)).length
      if (m === 3) cnt1++; else if (m === 2) cnt2++; else if (m === 1) cnt3++; else cntFail++
    }
    const totalExp = cnt1 * exp1st + cnt2 * exp2nd + cnt3 * exp3rd + cntFail * expFail
    actGrantExp(djId, act, key, totalExp)
    save()
    const top = actFormat(act.msgLottoAutoHeader, { nickname: d.nickname || author, count: useCount })
    const bottom = '━━━━━━━━━━━━━━\n' +
      `🥇 1등(3개): ${cnt1}회 (+${exp1st} EXP)\n` +
      `🥈 2등(2개): ${cnt2}회 (+${exp2nd} EXP)\n` +
      `🥉 3등(1개): ${cnt3}회 (+${exp3rd} EXP)\n` +
      `💀 꽝(0개): ${cntFail}회 (+${expFail} EXP)\n` +
      '━━━━━━━━━━━━━━\n' + actFormat(act.msgLottoTotal, { totalExp })
    setTimeout(() => sendChatToRoom(djId, top), 400)
    setTimeout(() => sendChatToRoom(djId, bottom), 900)
    return
  }

  // 아래는 DJ 또는 grantNicknames에 등록된 닉네임만 사용 가능
  const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
  const canGrant = isDj || grantList.includes(String(author || '').trim().toLowerCase())

  if (canGrant && first === cmdLottoGive && parts[1] === '전체') {
    const amount = parseInt(parts[2], 10)
    if (isNaN(amount) || amount === 0) { setTimeout(() => sendChatToRoom(djId, `⚠️ 사용법: ${cmdLottoGive} 전체 [수량] (음수 입력 시 차감)`), 400); return }
    // "전체"는 역대 등록된 모든 유저가 아니라, 지금 방송에 실제로 접속 중인 유저에게만 지급한다.
    // 퇴장감지 폴링(5초 주기)이 유지하는 room._lastLiveMembers 스냅샷을 기준으로 판단한다.
    const liveNames = new Set()
    if (room._lastLiveMembers) {
      for (const info of room._lastLiveMembers.values()) {
        if (info.nickname) liveNames.add(String(info.nickname).trim().toLowerCase())
        if (info.tag) liveNames.add(String(info.tag).trim().toLowerCase())
      }
    }
    let count = 0
    Object.entries(act.users).forEach(([key, d]) => {
      const isLive = liveNames.has(String(key).trim().toLowerCase())
        || (d.nickname && liveNames.has(String(d.nickname).trim().toLowerCase()))
        || (d.tag && liveNames.has(String(d.tag).trim().toLowerCase()))
      if (!isLive) return
      d.lotto = Math.max(0, (d.lotto || 0) + amount)
      count++
    })
    if (count > 0) {
      save()
      const action = amount > 0 ? '지급' : '차감'
      setTimeout(() => sendChatToRoom(djId, `🎁 현재 접속 중인 ${count}명의 복권이 ${Math.abs(amount)}장 ${action}되었습니다.`), 400)
    } else {
      setTimeout(() => sendChatToRoom(djId, `⚠️ 현재 접속 중인 등록된 애청지수 유저가 없습니다.`), 400)
    }
    return
  }
  if (canGrant && first === cmdLottoGive && parts[1] !== '전체') {
    const targetNick = parts[1]
    const amount = parseInt(parts[2], 10)
    if (!targetNick || isNaN(amount) || amount === 0) { setTimeout(() => sendChatToRoom(djId, `⚠️ 사용법: ${cmdLottoGive} [닉네임] [수량] (음수 입력 시 차감)`), 400); return }
    // 기록이 없는 유저에게 지급하면 !룰렛지급과 동일하게 자동으로 등록하고 지급한다.
    const existingKey = findActUserKey(act, targetNick)
    const key = existingKey || targetNick
    const d = actEnsureUser(act, key, existingKey ? act.users[existingKey].nickname : targetNick, existingKey ? null : targetNick)
    d.lotto = Math.max(0, (d.lotto || 0) + amount)
    save()
    const action = amount > 0 ? '지급' : '차감'
    setTimeout(() => sendChatToRoom(djId, `🎁 ${d.nickname || key}님의 복권이 ${Math.abs(amount)}장 ${action}되었습니다. (현재: ${d.lotto}장)`), 400)
    return
  }
  if (canGrant && first === cmdShop) {
    const targetNick = parts[1]
    const expAmount = parseInt(parts[2], 10)
    if (!targetNick || isNaN(expAmount)) { setTimeout(() => sendChatToRoom(djId, `⚠️ 사용법: ${cmdShop} [닉네임] [경험치]`), 400); return }
    // 기록이 없는 유저에게 지급하면 자동으로 등록하고 지급한다.
    const existingKey = findActUserKey(act, targetNick)
    const key = existingKey || targetNick
    const d = actEnsureUser(act, key, existingKey ? act.users[existingKey].nickname : targetNick, existingKey ? null : targetNick)
    actGrantExp(djId, act, key, expAmount)
    save()
    const action = expAmount >= 0 ? '지급' : '차감'
    setTimeout(() => sendChatToRoom(djId, `🛍️ ${d.nickname || key}님의 경험치가 ${Math.abs(expAmount)}만큼 ${action}되었습니다. (현재: ${d.exp} EXP)`), 400)
    return
  }
  if (isDj && first.startsWith(cmdAt) && first.length > cmdAt.length) {
    const targetNick = first.slice(cmdAt.length)
    const key = findActUserKey(act, targetNick)
    const d = key ? act.users[key] : null
    if (!d) { setTimeout(() => sendChatToRoom(djId, actNoUserMsg(act, targetNick)), 400); return }
    const { level, curExp, nextExp } = actGetLevel(d.exp || 0, act.lvBase)
    const rank = actRank(act.users, key)
    const lpMax = Number(act.lottoExchange) || 22
    const out = actFormat(act.msgMyInfo, { nickname: d.nickname || key, tag: d.tag || '', rank, level, exp: curExp, nextExp, heart: d.heart || 0, chat: d.chat || 0, attend: d.attend || 0, lp: d.lp || 0, lpMax, lotto: d.lotto || 0 })
    sendChatSplit(djId, out, 150, 600)
    return
  }
}

// ══════════════════════════════════════════════════════
// 🎟️ 복권 자동 지급 — 정해진 주기마다 "지금 방송에 실제로 접속 중인" 등록 애청지수 유저에게
// 복권을 자동으로 지급한다. 로컬 에디봇의 "복권 자동 지급" 외부 모듈과 동일한 사양으로 맞췄다.
// (활성화 토글, 지급 주기/수량, 안내 멘트, 즉시지급/일시정지/재개, 상태조회 명령어)

function getLottoAutoSettings(djId, settings) {
  if (!settings.lottoAuto) {
    settings.lottoAuto = {
      enabled: false,
      intervalMin: 30,
      amount: 1,
      announceMsg: '🎟️ 정기 자동 복권 지급! 모두에게 {amount}장씩 드립니다.',
      cmdStatus: '!자동복권',
      cmdNow: '!자동복권즉시',
      cmdPause: '!자동복권정지',
      cmdResume: '!자동복권시작',
      cmdRefresh: '!자동복권갱신',
      paused: false,
      lastRunAt: 0,
      runCount: 0,
    }
    store.saveSettings(djId, { lottoAuto: settings.lottoAuto })
  }
  return settings.lottoAuto
}

function lottoAutoNextRunHint(cfg) {
  if (cfg.enabled === false) return '비활성'
  if (cfg.paused) return '일시정지'
  const min = Math.max(1, Math.min(1440, parseInt(cfg.intervalMin, 10) || 30))
  if (!cfg.lastRunAt) return `${min}분 이내`
  const remain = (cfg.lastRunAt + min * 60000) - Date.now()
  if (remain <= 0) return '곧'
  return `약 ${Math.ceil(remain / 60000)}분 후`
}

// 1회 실행 — 지금 라이브 접속 중인 시청자 중, 애청지수에 등록되어 있는 유저에게만 복권을 지급한다.
// (수동 "!복권지급 전체"와 동일한 "현재 접속자만" 원칙을 따른다. 미등록 유저는 자동으로 새로 만들지 않는다.)
async function runLottoAutoOnce(djId, room, liveId, reason) {
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'lottoauto', djId)) return { ok: false, why: 'module_off' }
  const cfg = getLottoAutoSettings(djId, settings)
  if (cfg.enabled === false) return { ok: false, why: 'disabled' }
  if (cfg.paused) return { ok: false, why: 'paused' }
  if (!room.isConnected || !liveId) return { ok: false, why: 'not_connected' }

  const amount = Math.max(1, Math.min(1000, parseInt(cfg.amount, 10) || 1))

  let members = []
  try {
    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    members = await fetchLiveMembers(liveId, accessToken, 5)
  } catch (e) { console.log(`[자동복권:${djId}] 시청자 명단 조회 오류`, e.message) }

  if (!members.length) {
    console.log(`[자동복권:${djId}/${reason}] 라이브 접속 중인 시청자가 없어 건너뜀`)
    return { ok: false, why: 'no_live_users' }
  }

  const announce = String(cfg.announceMsg || '').trim()
  if (announce) {
    const msg = announce.replace(/\{amount\}/g, String(amount)).replace(/\{interval\}/g, String(cfg.intervalMin || ''))
    sendChatToRoom(djId, msg)
  }

  const act = getActivitySettings(djId, settings)
  const liveNames = new Set()
  members.forEach(u => {
    if (u.nickname) liveNames.add(String(u.nickname).trim().toLowerCase())
    if (u.tag) liveNames.add(String(u.tag).trim().toLowerCase())
  })

  let count = 0
  Object.entries(act.users).forEach(([key, d]) => {
    const isLive = liveNames.has(String(key).trim().toLowerCase())
      || (d.nickname && liveNames.has(String(d.nickname).trim().toLowerCase()))
      || (d.tag && liveNames.has(String(d.tag).trim().toLowerCase()))
    if (!isLive) return
    d.lotto = Math.max(0, (d.lotto || 0) + amount)
    count++
  })

  cfg.lastRunAt = Date.now()
  cfg.runCount = (cfg.runCount || 0) + 1
  store.saveSettings(djId, { activity: act, lottoAuto: cfg })

  const delay = announce ? 900 : 400
  if (count > 0) {
    setTimeout(() => sendChatToRoom(djId, `🎟️ 자동 복권 지급: 현재 접속 중인 ${count}명에게 ${amount}장씩 지급했어요! (누적 ${cfg.runCount}회)`), delay)
  } else {
    setTimeout(() => sendChatToRoom(djId, `🎟️ 자동 복권 지급을 시도했지만, 애청지수에 등록되어 있으면서 지금 접속 중인 유저가 없었어요.`), delay)
  }
  console.log(`[자동복권:${djId}/${reason}] ${count}명에게 ${amount}장 지급 (누적 ${cfg.runCount}회)`)
  return { ok: true, amount, count }
}

// 방(room) 단위 타이머 관리 — 설정을 바꾸거나 방에 새로 입장할 때마다 다시 만든다.
function stopLottoAutoTimer(djId) {
  const room = getRoom(djId)
  if (room.lottoAutoTimer) { clearInterval(room.lottoAutoTimer); room.lottoAutoTimer = null }
}

function startLottoAutoTimer(djId, liveId) {
  stopLottoAutoTimer(djId)
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'lottoauto', djId)) return
  const cfg = getLottoAutoSettings(djId, settings)
  if (cfg.enabled === false) return
  const min = Math.max(1, Math.min(1440, parseInt(cfg.intervalMin, 10) || 30))
  const ms = min * 60 * 1000
  room.lottoAutoTimer = setInterval(() => {
    runLottoAutoOnce(djId, room, liveId, '정기').catch(e => console.log(`[자동복권:${djId}] 타이머 실행 오류`, e.message))
  }, ms)
  console.log(`[자동복권:${djId}] 타이머 시작 — 주기 ${min}분`)
}

// 채팅 명령어: !자동복권(상태조회, 누구나) / !자동복권즉시·!자동복권정지·!자동복권시작·!자동복권갱신 (DJ+지정 권한자)
async function handleLottoAutoCommand(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'lottoauto', djId)) return
  const cfg = getLottoAutoSettings(djId, settings)
  const msg = String(text || '').trim()
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const act = getActivitySettings(djId, settings)
  const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
  const canManage = isDj || grantList.includes(String(author || '').trim().toLowerCase())

  if (msg === (cfg.cmdStatus || '!자동복권')) {
    const state = cfg.enabled === false ? '🔴 비활성' : cfg.paused ? '⏸️ 일시정지' : '🟢 가동중'
    const min = Math.max(1, parseInt(cfg.intervalMin, 10) || 30)
    const amt = Math.max(1, parseInt(cfg.amount, 10) || 1)
    setTimeout(() => sendChatToRoom(djId, `🎟️ 자동 복권 지급 상태\n상태: ${state}\n주기: ${min}분 / 수량: ${amt}장\n누적 실행: ${cfg.runCount || 0}회 / 다음 실행: ${lottoAutoNextRunHint(cfg)}`), 400)
    return
  }

  if (msg === (cfg.cmdNow || '!자동복권즉시')) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ DJ/지정 권한자만 사용할 수 있습니다.'), 400); return }
    const r = await runLottoAutoOnce(djId, room, liveId, '수동')
    if (!r.ok && r.why === 'no_live_users') setTimeout(() => sendChatToRoom(djId, '⚠️ 라이브 접속 중인 시청자가 없어 지급할 수 없습니다.'), 400)
    return
  }

  if (msg === (cfg.cmdPause || '!자동복권정지')) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ DJ/지정 권한자만 사용할 수 있습니다.'), 400); return }
    cfg.paused = true
    store.saveSettings(djId, { lottoAuto: cfg })
    setTimeout(() => sendChatToRoom(djId, `⏸️ 자동 복권 지급을 일시정지했어요. (다시 켜려면 ${cfg.cmdResume || '!자동복권시작'})`), 400)
    return
  }

  if (msg === (cfg.cmdResume || '!자동복권시작')) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ DJ/지정 권한자만 사용할 수 있습니다.'), 400); return }
    cfg.paused = false
    store.saveSettings(djId, { lottoAuto: cfg })
    if (cfg.enabled === false) { setTimeout(() => sendChatToRoom(djId, '⚠️ 자동 복권 지급 설정이 꺼져있어요. 웹 화면에서 먼저 활성화해주세요.'), 400); return }
    startLottoAutoTimer(djId, liveId)
    setTimeout(() => sendChatToRoom(djId, '▶️ 자동 복권 지급을 재개했어요.'), 400)
    return
  }

  if (msg === (cfg.cmdRefresh || '!자동복권갱신')) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ DJ/지정 권한자만 사용할 수 있습니다.'), 400); return }
    startLottoAutoTimer(djId, liveId)
    const min = Math.max(1, parseInt(cfg.intervalMin, 10) || 30)
    setTimeout(() => sendChatToRoom(djId, `🔄 타이머가 재시작됐어요 (주기 ${min}분).`), 400)
    return
  }
}

// ══════════════════════════════════════════════════════
// 🧩 퀴즈 시스템 — 문제 은행에서 무작위로 골라 정해진 간격마다 채팅에 출제하고,
// 정확히 일치하는 답을 먼저 맞힌 사람에게 애청지수 EXP를 지급한다.

function getQuizSettings(djId, settings) {
  if (!settings.quiz) {
    settings.quiz = {
      enabled: false,
      autoStartOnRestart: false,
      intervalMin: 0, intervalSec: 10,
      msgCorrect: '🎉 정답! {nickname}님이 맞추셨습니다!\n+{score} EXP 획득',
      msgTimeout: '⏰ 시간 초과! 정답은 [{answer}]였습니다.',
      msgQuestion: '🧩 퀴즈! {question} (제한시간: {time}초)',
      questions: []
    }
    store.saveSettings(djId, { quiz: settings.quiz })
  }
  if (!settings.quiz.questions) settings.quiz.questions = []
  return settings.quiz
}

function quizFormat(tpl, data) {
  return String(tpl || '')
    .replace(/{nickname}/g, data.nickname || '')
    .replace(/{answer}/g, data.answer || '')
    .replace(/{score}/g, data.score != null ? String(data.score) : '')
    .replace(/{question}/g, data.question || '')
    .replace(/{time}/g, data.time != null ? String(data.time) : '')
}

function ensureQuizState(room) {
  if (!room.quiz) room.quiz = { running: false, current: null, timeoutTimer: null, nextTimer: null }
  return room.quiz
}

function clearQuizTimers(room) {
  ensureQuizState(room)
  if (room.quiz.timeoutTimer) clearTimeout(room.quiz.timeoutTimer)
  if (room.quiz.nextTimer) clearTimeout(room.quiz.nextTimer)
  room.quiz.timeoutTimer = null
  room.quiz.nextTimer = null
}

function scheduleNextQuiz(djId) {
  const room = getRoom(djId)
  ensureQuizState(room)
  if (room.quiz.nextTimer) clearTimeout(room.quiz.nextTimer)
  if (!room.quiz.running) return
  const settings = store.getSettings(djId) || {}
  const quiz = getQuizSettings(djId, settings)
  const intervalMs = (Number(quiz.intervalMin) || 0) * 60000 + (Number(quiz.intervalSec) || 0) * 1000
  if (intervalMs <= 0) return // 0분0초 = 비활성
  room.quiz.nextTimer = setTimeout(() => askQuizQuestion(djId), intervalMs)
}

function askQuizQuestion(djId) {
  const room = getRoom(djId)
  ensureQuizState(room)
  if (!room.isConnected || !room.quiz.running) return
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'quiz', djId)) { scheduleNextQuiz(djId); return }
  const quiz = getQuizSettings(djId, settings)
  if (!quiz.questions.length) { scheduleNextQuiz(djId); return }
  const q = quiz.questions[Math.floor(Math.random() * quiz.questions.length)]
  const timeLimit = Math.max(1, Number(q.timeLimit) || 20)
  room.quiz.current = { id: q.id, question: q.question, answer: q.answer, score: Number(q.score) || 0, timeLimit }
  const msg = quizFormat(quiz.msgQuestion, { question: q.question, time: timeLimit })
  sendChatToRoom(djId, msg)
  broadcast({ type: 'quiz', djId, status: 'asked', question: q.question })
  room.quiz.timeoutTimer = setTimeout(() => handleQuizTimeout(djId), timeLimit * 1000)
}

function handleQuizTimeout(djId) {
  const room = getRoom(djId)
  ensureQuizState(room)
  const cur = room.quiz.current
  if (!cur) return
  const settings = store.getSettings(djId) || {}
  const quiz = getQuizSettings(djId, settings)
  const msg = quizFormat(quiz.msgTimeout, { answer: cur.answer })
  sendChatToRoom(djId, msg)
  room.quiz.current = null
  broadcast({ type: 'quiz', djId, status: 'timeout' })
  scheduleNextQuiz(djId)
}

// 채팅 메시지가 들어올 때마다(진행 중인 문제가 있을 때만) 정답 여부를 확인한다.
function handleQuizAnswer(djId, settings, author, text) {
  if (!isModuleOn(settings, 'quiz', djId)) return
  const room = getRoom(djId)
  ensureQuizState(room)
  const cur = room.quiz.current
  if (!cur) return
  const msg = String(text || '').trim()
  if (!msg || msg !== String(cur.answer).trim()) return

  if (room.quiz.timeoutTimer) { clearTimeout(room.quiz.timeoutTimer); room.quiz.timeoutTimer = null }
  room.quiz.current = null

  const quiz = getQuizSettings(djId, settings)
  // 애청지수와 연동: 등록 안 된 유저도 다른 지급 기능과 동일하게 자동 등록하고 지급한다.
  const act = getActivitySettings(djId, settings)
  const existingKey = actResolveKey(act, author, null)
  const key = existingKey || author
  actEnsureUser(act, key, author)
  if (cur.score) actGrantExp(djId, act, key, cur.score)
  store.saveSettings(djId, { activity: act })

  const out = quizFormat(quiz.msgCorrect, { nickname: author, answer: cur.answer, score: cur.score })
  sendChatToRoom(djId, out)
  broadcast({ type: 'quiz', djId, status: 'correct', nickname: author })
  scheduleNextQuiz(djId)
}

function startQuiz(djId) {
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  const quiz = getQuizSettings(djId, settings)
  quiz.enabled = true
  store.saveSettings(djId, { quiz })
  ensureQuizState(room)
  room.quiz.running = true
  scheduleNextQuiz(djId)
  broadcast({ type: 'quiz', djId, status: 'started' })
}

function stopQuiz(djId) {
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  const quiz = getQuizSettings(djId, settings)
  quiz.enabled = false
  store.saveSettings(djId, { quiz })
  ensureQuizState(room)
  clearQuizTimers(room)
  room.quiz.running = false
  room.quiz.current = null
  broadcast({ type: 'quiz', djId, status: 'stopped' })
}

function percentPick(items) {
  if (!items || !items.length) return null
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
// 지정 스티커도 스푼 트리거처럼 지급 방식(일반/콤보/배분)을 선택할 수 있다.
// payout: exact(일반)=단발(콤보X)로 딱 1개 선물했을 때만 1회
//         combo(콤보, 기본값)=선물한 콤보 수만큼 그대로 실행 (기존 동작과 동일)
//         distribute(배분)=기준 개수(count)당 1회씩 (내림 계산)
function checkStickerTrigger(triggerSticker, sticker, comboCount, payout, thresholdCount) {
  const target = String(triggerSticker || '').trim().toLowerCase()
  const current = String(sticker || '').trim().toLowerCase()
  if (!target || !current) return 0
  const matched = current === target || current.includes(target)
  if (!matched) return 0

  const combo = Math.max(1, Number(comboCount) || 1)
  if (payout === 'exact') return combo === 1 ? 1 : 0
  if (payout === 'distribute') {
    const X = Math.max(1, Number(thresholdCount) || 1)
    return Math.floor(combo / X)
  }
  // combo (기본값, 미지정 시 기존 동작 그대로 유지)
  return combo
}

// 룰렛 명령어 처리: "!룰렛1", "!룰렛1 3" (수량)
// !킵, !이벤트, !내카드 [페이지] (본인 조회) / !킵확인N, !이벤트확인N, !내카드확인N [고유닉] (타인 조회)
// !킵추가 [고유닉] [내용] (DJ 전용) / !킵사용, !이벤트사용, !내카드사용 [번호] [수량]
async function handleKeepCommands(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'roulette', djId)) return
  const msg = String(text || '').trim()
  const parts = msg.split(/\s+/)
  const first = parts[0]
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  const sectionByCmd = { '!킵': '킵목록', '!이벤트': '이벤트목록', '!내카드': '기타목록' }
  if (sectionByCmd[first]) {
    const section = sectionByCmd[first]
    const page = parseInt(parts[1]) || 1
    // ⚠️ 스푼의 고유닉(tag) 조회 API가 같은 유저에도 매번 다른(때론 완전히 틀린) 값을 주는 경우가 있어서
    // 더 이상 신뢰하지 않는다. 이벤트에 직접 들어있는 닉네임으로 고정해서 저장/조회 키를 일치시킨다.
    const keepKey = author
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
    const keepKey = author
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
async function handleRouletteGiveCommand(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'roulette', djId)) return
  const msg = String(text || '').trim()
  const parts = msg.split(/\s+/)
  const m = parts[0].match(/^!룰렛지급(\d+)$/)
  if (!m) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (!isDj) { setTimeout(() => sendChatToRoom(djId, '🎡 !룰렛지급 명령어는 DJ만 사용할 수 있습니다.'), 400); return }

  const idx = parseInt(m[1], 10)
  const rt = settings.roulette && settings.roulette.list[idx - 1]
  if (!rt) { setTimeout(() => sendChatToRoom(djId, `🎡 룰렛${idx}은 등록되어 있지 않습니다.`), 400); return }

  const targetInput = (parts[1] || '').replace('@', '').trim()
  const count = parseInt(parts[2], 10) || 1
  if (!targetInput) { setTimeout(() => sendChatToRoom(djId, `🎡 사용법: !룰렛지급${idx} [고유닉] [수량]`), 400); return }
  // 룰렛 기록은 닉네임 기준으로 저장되므로, DJ가 태그를 입력했다면 실제 닉네임으로 변환한다.
  let targetTag = resolveNicknameFromInput(room, targetInput)
  if (targetTag === targetInput) {
    // 그동안 관측된 매핑에 없으면, 그 자리에서 시청자 명단을 더 깊이(여러 페이지) 다시 조회해서 한 번 더 찾아본다.
    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    const freshMembers = await fetchLiveMembers(liveId, accessToken, 5)
    const norm = targetInput.toLowerCase()
    const found = freshMembers.find(u => u.tag && u.tag.toLowerCase() === norm)
    if (found) {
      rememberTagNickname(room, found.tag, found.nickname || found.tag)
      targetTag = found.nickname || found.tag
    }
  }

  const rec = getHistoryRec(settings, targetTag)
  rec.coupons[idx] = Number(rec.coupons[idx] || 0) + count
  store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
  broadcast({ type: 'roulette', djId, tag: targetTag })
  setTimeout(() => sendChatToRoom(djId, `🎡 ${targetTag}님에게 룰렛권${idx} ${count}장 지급했습니다! (보유: ${rec.coupons[idx]}장)`), 400)
}

// !룰렛메뉴N[-P] — 룰렛 항목 목록 확인 (페이지)
function handleRouletteMenuCommand(djId, settings, text) {
  if (!isModuleOn(settings, 'roulette', djId)) return
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
  if (!isModuleOn(settings, 'roulette', djId)) return
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
  // ⚠️ 스푼 태그(고유닉) 조회 API가 신뢰할 수 없어서(같은 유저에도 결과가 오락가락함) 더 이상 쓰지 않는다.
  // 이벤트에 바로 들어있는 닉네임을 고정 키로 써서, 선물 시점과 명령어 조회 시점의 키가 항상 일치하도록 한다.
  const histKey = author
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
    if (!won) continue
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
async function handleRouletteAutoGrant(djId, room, settings, author, authorId, liveId, amount, comboCount, sticker = '') {
  if (!isModuleOn(settings, 'roulette', djId)) return
  const rl = settings.roulette
  if (!rl || !rl.list || !rl.list.length) { console.log(`[룰렛디버그:${djId}] 등록된 룰렛 없음`); return }
  const applicable = rl.list
    .map((rt, i) => {
      const count = rt.triggerMode === 'sticker'
        ? checkStickerTrigger(rt.triggerSticker, sticker, comboCount, rt.triggerStickerPayout, rt.triggerStickerCount)
        : calcAutoGrantCount(rt.triggerMode, rt.triggerAmount, amount, comboCount)
      return { rt, idx: i + 1, count }
    })
    .filter(x => x.count > 0 && x.rt.items && x.rt.items.length > 0)
  console.log(`[룰렛디버그:${djId}] author=${author} amount=${amount} combo=${comboCount} sticker=${sticker} 적용될 룰렛수=${applicable.length}`)
  if (!applicable.length) return

  // ⚠️ 스푼 태그(고유닉) 조회 API가 신뢰할 수 없어서(같은 유저에도 결과가 오락가락함) 더 이상 쓰지 않는다.
  // 이벤트에 바로 들어있는 닉네임을 고정 키로 써서, 선물 시점과 명령어 조회 시점의 키가 항상 일치하도록 한다.
  const histKey = author
  console.log(`[룰렛디버그:${djId}] histKey(닉네임 고정)=${histKey}`)
  const hist = getHistoryRec(settings, histKey)
  let changed = false

  for (const { rt, idx, count } of applicable) {
    const wonCounts = {}
    for (let i = 0; i < count; i++) {
      const won = percentPick(rt.items)
      if (!won) continue
      wonCounts[won.name] = (wonCounts[won.name] || 0) + 1
      if (!won.skipHistory) {
        hist.wins.push({ idx, rouletteName: rt.name, itemName: won.name, ts: Date.now() })
        hist.keepList[won.name] = (hist.keepList[won.name] || 0) + 1
        changed = true
      }
    }
    const header = (rl.resultHeaderTemplate || '').replace(/{룰렛명}/g, rt.name).replace(/{닉네임}/g, author)
    const resultLine = Object.entries(wonCounts).map(([name, c]) => '👉 ' + (c > 1 ? `${name}(${c})` : name)).join('\n')
    setTimeout(() => sendChatToRoom(djId, `${header}\n${resultLine}`), 400)
  }
  console.log(`[룰렛디버그:${djId}] changed=${changed} keepList=`, JSON.stringify(hist.keepList))

  if (changed) {
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag: histKey })
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
  if (!isModuleOn(settings, 'entrysettings', djId)) return
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
  room._lastAutoAttendCheck = Date.now() // 방금 입장했으니 자동 출석은 한 주기 지난 뒤부터 시작

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

      // 🆔 태그↔닉네임 매핑은 시청자 명단을 받아올 때마다(5초 주기) 항상 갱신한다.
      // (자동 출석과 달리, 이 매핑은 !룰렛지급 등에서 태그로 대상을 찾을 때 쓰이므로 자주 갱신될수록 좋다)
      for (const u of currentMembers.values()) {
        if (u.tag && (u.nickname || u.tag)) rememberTagNickname(room, u.tag, u.nickname || u.tag)
      }

      // ⭐ 애청지수 자동 출석 — 등록된 유저에게만, 설정된 간격(기본 30분)마다 한 번씩 체크
      const settings = store.getSettings(djId) || {}
      const act = settings.activity
      if (act && act.enabled !== false && act.autoAttendEnabled !== false) {
        const intervalMs = Math.max(1, Number(act.autoAttendIntervalMin) || 30) * 60 * 1000
        if (Date.now() - room._lastAutoAttendCheck >= intervalMs) {
          room._lastAutoAttendCheck = Date.now()
          for (const u of currentMembers.values()) {
            const nickname = u.nickname || u.tag
            if (nickname) handleActAttendHook(djId, settings, nickname, u.tag || null)
          }
        }
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

// 특정 디제이의 방 연결(WebSocket)과 관련된 인메모리 상태를 전부 초기화한다.
// 저장된 설정 데이터는 전혀 건드리지 않는다. 관리자가 유저 관리 화면에서 누르는
// "재부팅" 버튼과, 각 디제이 본인이 "자동입장" 화면에서 누르는 "내 봇 재부팅" 버튼이
// 이 함수 하나를 공통으로 사용한다.
function rebootDjConnection(djId) {
  const room = getRoom(djId)
  if (room.ws) { room.ws.terminate() }
  stopLeavePolling(djId)
  stopLottoAutoTimer(djId)
  clearQuizTimers(room)
  delete rooms[djId]           // 다음 getRoom() 호출 시 완전히 새 상태로 재생성됨
  delete repeatLastSent[djId]  // 반복 문구 타이머 기준 시각도 초기화

  for (const key of [...commandCooldowns.keys()]) {
    if (key.startsWith(djId + ':')) commandCooldowns.delete(key)
  }

  broadcast({ type: 'status', djId, isConnected: false })
  console.log(`[재부팅] ${djId} 계정의 봇 연결 상태를 초기화했어요`)
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
    // 🎟️ 복권 자동 지급 타이머도 이번 입장 시점부터 새로 시작 (설정이 켜져있을 때만 실제로 동작)
    startLottoAutoTimer(djId, liveId)
    // 🧩 "서버 재시작 시 퀴즈 자동 시작"이 켜져 있으면, 방에 들어갈 때마다 퀴즈를 자동으로 시작한다.
    try {
      const s = store.getSettings(djId) || {}
      const quiz = getQuizSettings(djId, s)
      if (quiz.autoStartOnRestart && quiz.questions.length) startQuiz(djId)
    } catch (e) {}
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
        broadcast({ type: 'chat', djId, nick: author, text, profileUrl: gen.profileUrl || '' })
        if (!isLurker) {
          // 🆔 태그↔닉네임 매핑은 이 사람의 다른 명령어(!실드 등)를 처리하기 전에 먼저 갱신해둔다.
          // (순서가 뒤에 있으면, 방금 막 채팅을 시작한 사람은 권한 체크 시점에 태그 매핑이 없어서
          //  '고유닉'으로 등록해둔 권한자 목록과 못 맞는 문제가 생김)
          const actTag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          rememberTagNickname(room, actTag, author)

          await handleShieldCommand(djId, room, settings, author, authorId, liveId, text)
          handleFlagCommand(djId, room, settings, author, authorId, text)
          handleFundingCommand(djId, room, settings, author, authorId, text)
          handleShortcutCommand(djId, room, settings, author, authorId, liveId, text)
          handleSongRequestCommand(djId, room, settings, author, authorId, text)
          handleRouletteCommand(djId, room, settings, author, authorId, liveId, text)
          handleKeepCommands(djId, room, settings, author, authorId, liveId, text)
          handleRouletteGiveCommand(djId, room, settings, author, authorId, liveId, text)
          handleRouletteMenuCommand(djId, settings, text)
          handleActivityCommand(djId, room, settings, author, authorId, text, actTag)
          handleActChatHook(djId, settings, author, actTag)
          handleQuizAnswer(djId, settings, author, text)
          handleLottoAutoCommand(djId, room, settings, author, authorId, liveId, text)
        }

      } else if (eventName === 'RoomJoin') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'join', djId, nick: author })

        // 퇴장 감지 스냅샷에도 즉시 등록 (폴링 주기 사이에 짧게 머든 유저도 잡히도록)
        const joinSnapshotKey = author.toString().toLowerCase()
        registerJoinSnapshot(room, author, null)

        if (!isLurker) {
          const tag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          rememberTagNickname(room, tag, author)
          if (tag) registerJoinSnapshot(room, author, tag, joinSnapshotKey) // 태그 알아내면 스냅샷 키를 태그 기준으로 갱신 (이전 닉네임 키 정리)
          const greeting = (tag && isModuleOn(settings, 'greet', djId)) ? (settings.greetings || []).find(g => String(g.tag).toLowerCase() === tag.toLowerCase()) : null

          handleActAttendHook(djId, settings, author, tag)

          if (greeting) {
            const text = greeting.message.replace(/{유저}/g, author).replace(/{nickname}/g, author).replace(/{tag}/g, `@${tag}`)
            setTimeout(() => sendChatToRoom(djId, text), 500)
          } else if (isModuleOn(settings, 'entrysettings', djId)) {
            const msgs = (settings.joinMessages || []).filter(m => m.enabled)
            if (msgs.length > 0) {
              const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, tag ? `@${tag}` : '')
              setTimeout(() => sendChatToRoom(djId, text), 500)
            }
          }
        }

      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'like', djId, nick: author })
        const likeTag = isLurker ? null : await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
        rememberTagNickname(room, likeTag, author)
        if (!isLurker) handleActHeartHook(djId, settings, author, likeTag)
        const msgs = (isLurker || !isModuleOn(settings, 'entrysettings', djId)) ? [] : (settings.likeMessages || []).filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, likeTag ? `@${likeTag}` : '')
          setTimeout(() => sendChatToRoom(djId, text), 500)
        }

      } else if (eventName === 'LiveDonation' || eventName === 'live_present' || eventName === 'DonationMessage') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        const amount = Number(eventPayload.amount || eventPayload.spoonCount || eventPayload.spoon_count || eventPayload.quantity || eventPayload.value || 0)
        const comboCount = Number(eventPayload.comboCount || eventPayload.combo_count || eventPayload.combo || 1)
        const sticker = eventPayload.sticker || eventPayload.stickerName || eventPayload.sticker_name || eventPayload.name || ''
        const stickerImage = sticker ? await findStickerImage(sticker) : ''
        broadcast({ type: 'donation', djId, nick: author, amount, comboCount, sticker, stickerImage, profileUrl: gen.profileUrl || '' })
        if (!isLurker) {
          handleFlagAutoDonation(djId, settings, amount * Math.max(1, comboCount))
          handleRouletteAutoGrant(djId, room, settings, author, authorId, liveId, amount, comboCount, sticker)
          const donationTag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          rememberTagNickname(room, donationTag, author)
          handleActLottoPointHook(djId, settings, author, amount * Math.max(1, comboCount), donationTag)
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
    stopLottoAutoTimer(djId)
    clearQuizTimers(room)
    if (room.quiz) { room.quiz.running = false; room.quiz.current = null }
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
    if (!isModuleOn(settings, 'entrysettings', djId)) continue
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
// (룰렛 "지정 스티커" 선택 화면뿐 아니라, 채팅창에 선물 스티커 이미지를 보여줄 때도 이 캐시를 함께 쓴다.)
let stickerCache = { data: null, fetchedAt: 0 }
const STICKER_CACHE_TTL_MS = 30 * 60 * 1000 // 30분

async function getStickerList() {
  const now = Date.now()
  if (stickerCache.data && (now - stickerCache.fetchedAt) < STICKER_CACHE_TTL_MS) {
    return stickerCache.data
  }
  try {
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
    return stickers
  } catch (e) {
    console.log('[스티커 목록 조회 오류]', e.message)
    // 실패해도 이전에 캐시된 값이 있으면 그거라도 내려준다.
    return stickerCache.data || []
  }
}

// 선물 이벤트로 들어온 스티커 이름으로 실제 이미지 URL을 찾는다. (이름이 정확히 안 맞아도 부분일치까지 시도)
async function findStickerImage(stickerName) {
  const name = String(stickerName || '').trim()
  if (!name) return ''
  try {
    const list = await getStickerList()
    const target = name.toLowerCase()
    const found = list.find(s => String(s.name).toLowerCase() === target || String(s.title).toLowerCase() === target)
      || list.find(s => String(s.name).toLowerCase().includes(target) || target.includes(String(s.name).toLowerCase()))
    return found ? found.image : ''
  } catch (e) {
    return ''
  }
}

app.get('/stickers', async (req, res) => {
  try {
    const wasCached = !!(stickerCache.data && (Date.now() - stickerCache.fetchedAt) < STICKER_CACHE_TTL_MS)
    const stickers = await getStickerList()
    if (!stickers.length && !stickerCache.data) {
      return res.status(502).json({ success: false, error: '스티커 목록을 가져오지 못했어요' })
    }
    res.json({ success: true, cached: wasCached, stickers })
  } catch (e) {
    console.log('[스티커 목록 조회 오류]', e.message)
    if (stickerCache.data) {
      return res.json({ success: true, cached: true, stale: true, stickers: stickerCache.data })
    }
    res.status(502).json({ success: false, error: '스티커 목록을 가져오지 못했어요: ' + e.message })
  }
})

// ══════════════════════════════════════════════════════
// 계정 (디제이별 가입/로그인)
app.post('/auth/signup', (req, res) => {
  const { djId, password, referrerId } = req.body || {}
  const result = store.signup(djId, password, referrerId)
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

// 본인 계정 전용 — 비밀번호 변경 (현재 비밀번호 확인 필요)
app.post('/account/change-password', auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (!currentPassword || !newPassword) return res.json({ success: false, error: '현재 비밀번호와 새 비밀번호를 입력해주세요' })
  if (!store.verifyPassword(req.djId, currentPassword)) return res.json({ success: false, error: '현재 비밀번호가 틀렸어요' })
  const result = store.changePassword(req.djId, newPassword)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true, msg: '비밀번호가 변경됐어요' })
})

// 본인 계정 전용 — 아이디 변경 (현재 비밀번호 확인 필요, 관리자 계정 sum은 변경 불가)
// 아이디가 바뀌면 로그인 키 자체가 바뀌는 것이므로, 방 연결 등 인메모리 상태를 정리하고
// 새 아이디 기준으로 로그인 토큰을 새로 발급해서 내려준다.
app.post('/account/change-id', auth.requireAuth, (req, res) => {
  const oldId = req.djId
  const { currentPassword } = req.body || {}
  const newId = String((req.body || {}).newDjId || '').trim()
  if (!currentPassword || !newId) return res.json({ success: false, error: '새 아이디와 현재 비밀번호를 입력해주세요' })
  if (!store.verifyPassword(oldId, currentPassword)) return res.json({ success: false, error: '현재 비밀번호가 틀렸어요' })
  const result = store.renameDjId(oldId, newId)
  if (!result.ok) return res.json({ success: false, error: result.error })

  // 인메모리 방 연결 상태(WebSocket, 폴링/타이머 등)는 새 아이디로 자동 이전되지 않으므로
  // 안전하게 정리한다. 자동입장이 켜져 있었다면 새 아이디 기준으로 다시 접속을 시도하게 된다.
  const room = getRoom(oldId)
  if (room.ws) { room.ws.terminate() }
  stopLeavePolling(oldId)
  stopLottoAutoTimer(oldId)
  clearQuizTimers(room)
  delete rooms[oldId]
  delete repeatLastSent[oldId]

  const token = auth.issueToken(newId)
  res.json({ success: true, djId: newId, token, msg: '아이디가 변경됐어요' })
})

// 본인 계정 전용 — 로컬 에디봇(Electron) 설정 파일을 업로드해서 본인 계정 설정으로 마이그레이션한다.
// 로그인한 djId 자신에게만 적용되고, 다른 계정 데이터는 절대 건드리지 않는다.
// 실제 변환 로직은 localMigrate.js에 있고, 관리자용 CLI 스크립트(migrate-local-data.js)와 공유한다.
app.post('/account/migrate-local', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'migrate', req.djId)) return res.json({ success: false, error: '로컬 데이터 가져오기 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const raw = (req.body || {}).data
  if (!raw || typeof raw !== 'object') return res.json({ success: false, error: '올바른 데이터 파일이 아니에요' })
  try {
    const { patch, report } = buildMigrationPatch(raw)
    store.saveSettings(req.djId, patch)
    res.json({ success: true, report })
  } catch (e) {
    res.json({ success: false, error: '마이그레이션 중 오류: ' + e.message })
  }
})

// 관리자(sum) 전용 — 신규 회원가입 시 자동으로 부여되는 기본 이용기간(일수)을 조회/설정한다.
// 이미 가입한 유저에게는 영향 없고, 이 설정을 바꾼 이후 새로 가입하는 유저부터 적용된다.
// 0으로 설정하면 신규가입자도 처음부터 무제한으로 시작한다.
app.get('/admin/default-trial-days', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  res.json({ success: true, days: store.getDefaultTrialDays() })
})

app.post('/admin/default-trial-days', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const result = store.setDefaultTrialDays((req.body || {}).days)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true })
})

// 관리자(sum) 전용 — 가입한 디제이 목록 + 상태 조회
app.get('/admin/users', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const users = store.listDjSummaries().map(u => {
    const room = getRoom(u.djId)
    return { ...u, isConnected: room.isConnected }
  })
  res.json({ success: true, users })
})

// 관리자(sum) 전용 — 특정 디제이의 비밀번호를 본인 확인 없이 직접 변경한다.
// (본인이 비밀번호를 잊어버렸을 때 등, 관리자가 대신 초기화해줄 수 있게)
app.post('/admin/users/:djId/change-password', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const targetId = req.params.djId
  if (!store.exists(targetId)) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  const { newPassword } = req.body || {}
  const result = store.changePassword(targetId, newPassword)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true, msg: `${targetId} 계정의 비밀번호를 변경했어요` })
})

app.post('/admin/users/:djId/block', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const targetId = req.params.djId
  if (targetId === 'sum') return res.json({ success: false, error: '관리자 계정은 차단할 수 없어요' })
  const { blocked } = req.body || {}
  const ok = store.setBlocked(targetId, !!blocked)
  if (!ok) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  res.json({ success: true })
})

app.post('/admin/users/:djId/delete', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const targetId = req.params.djId
  if (targetId === 'sum') return res.json({ success: false, error: '관리자 계정은 삭제할 수 없어요' })
  const room = getRoom(targetId)
  if (room.ws) { room.ws.terminate() }
  delete rooms[targetId]
  const ok = store.deleteDj(targetId)
  if (!ok) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  res.json({ success: true })
})

// 관리자(sum) 전용 — 특정 디제이의 설정 데이터만 초기화(리셋)한다.
// 아이디/비밀번호/가입일/차단여부/자동입장허용여부 같은 "계정 정보"는 그대로 두고,
// 실드/깃발/펀딩/신청곡/룰렛/애청지수/명령어/지정인사/입장설정 등 "봇 설정값"만
// 최초 가입 시 상태로 되돌린다. 방송에 접속되어 있었다면 연결도 함께 정리한다.
app.post('/admin/users/:djId/reset', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const targetId = req.params.djId
  const ok = store.resetSettings(targetId)
  if (!ok) return res.json({ success: false, error: '유저를 찾을 수 없어요' })

  const room = getRoom(targetId)
  if (room.ws) { room.ws.terminate(); room.ws = null }
  room.isConnected = false
  room.autoJoinedFor = ''
  room.watchingTag = ''
  stopLeavePolling(targetId)
  stopLottoAutoTimer(targetId)
  clearQuizTimers(room)
  if (room.quiz) { room.quiz.running = false; room.quiz.current = null }
  broadcast({ type: 'status', djId: targetId, isConnected: false })

  res.json({ success: true, msg: `${targetId} 계정의 설정이 초기화됐어요` })
})

// 관리자(sum) 전용 — 특정 디제이의 "서버"(봇 연결 상태)만 재부팅한다.
// 저장된 설정 데이터는 전혀 건드리지 않고, 그 디제이의 방 연결(WebSocket)과 관련된
// 인메모리 상태(연결 여부, 퇴장감지 폴링, 반복문구 타이머, 퀴즈 타이머, 명령어 쿨타임)를
// 전부 초기화해서 그 계정만 새로 시작한 것과 같은 상태로 만든다.
// autoJoinWatch가 켜져 있었다면, 15초 주기로 도는 자동입장 감시 로직이 알아서 재접속을 시도한다.
app.post('/admin/users/:djId/reboot', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const targetId = req.params.djId
  if (!store.exists(targetId)) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  rebootDjConnection(targetId)
  res.json({ success: true, msg: `${targetId} 계정의 봇 연결을 재부팅했어요` })
})

// 본인 계정 전용 — 로그인한 디제이가 스스로 "자동입장" 화면에서 자기 봇 연결만 재부팅한다.
// 관리자 여부와 무관하게 누구나 자기 자신에 대해서만 사용할 수 있고, 다른 계정에는 전혀 영향이 없다.
app.post('/bot/reboot', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'botreboot', req.djId)) return res.json({ success: false, error: '봇 재부팅 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  rebootDjConnection(req.djId)
  res.json({ success: true, msg: '봇 연결을 재부팅했어요' })
})

// 관리자(sum) 전용 — 특정 디제이의 이용 만료일을 설정하거나(expiresAt: ISO 문자열) 해제한다(expiresAt: null).
// 만료일이 지나면 그 계정은 입장설정/룰렛기록을 제외한 모든 메뉴가 자동으로 잠긴다.
// ⚠️ 관리자(sum) 자신의 날짜도 여기서 직접 입력/수정할 수 있다 (기록·테스트용). 다만 isAccountExpired()가
//    djId==='sum'인 경우 항상 예외 처리하므로, 날짜를 지나도 관리자 계정 자체가 잠기는 일은 없다.
app.post('/admin/users/:djId/expiry', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const targetId = req.params.djId
  if (!store.exists(targetId)) return res.json({ success: false, error: '유저를 찾을 수 없어요' })

  const raw = (req.body || {}).expiresAt
  if (!raw) {
    store.saveSettings(targetId, { expiresAt: null, expiryStartAt: null })
    return res.json({ success: true, msg: `${targetId} 계정의 이용 만료일을 해제했어요` })
  }
  const parsed = new Date(raw)
  if (isNaN(parsed.getTime())) return res.json({ success: false, error: '날짜 형식이 올바르지 않아요' })
  store.saveSettings(targetId, { expiresAt: parsed.toISOString(), expiryStartAt: new Date().toISOString() })
  res.json({ success: true, msg: `${targetId} 계정의 이용 만료일을 설정했어요` })
})

// 관리자(sum) 전용 — 특정 디제이의 자동입장(방입장) 기능 허용/차단
app.post('/admin/users/:djId/autojoin', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'userlist', req.djId)) return res.json({ success: false, error: '유저 관리 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
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

// ⭐ 애청지수 유저 목록 (랭킹순)
// 🎁 실시간 지급용 — 현재 방송에 접속 중인 시청자 목록 (여러 페이지까지 조회)
app.get('/live/members', auth.requireAuth, async (req, res) => {
  const djId = req.djId
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'autogrant', djId)) return res.json({ success: false, error: '실시간 지급 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const room = getRoom(djId)
  if (!room.isConnected || !room.autoJoinedFor) {
    return res.json({ success: false, error: '현재 방송에 접속되어 있지 않아요' })
  }
  try {
    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    const members = await fetchLiveMembers(room.autoJoinedFor, accessToken, 5)
    members.forEach(u => { if (u.tag) rememberTagNickname(room, u.tag, u.nickname || u.tag) })
    res.json({ success: true, members })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// 🎁 실시간 지급용 — 복권 지급/차감 (기록 없는 유저는 자동 등록, 채팅 명령어와 동일한 정책)
app.post('/activity/grant-lotto', auth.requireAuth, (req, res) => {
  const target = String((req.body || {}).target || '').trim()
  const amount = Number((req.body || {}).amount)
  if (!target || !amount) return res.json({ success: false, error: '대상과 수량을 입력해주세요' })
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'autogrant', req.djId)) return res.json({ success: false, error: '실시간 지급 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const act = getActivitySettings(req.djId, settings)
  const existingKey = findActUserKey(act, target)
  const key = existingKey || target
  const d = actEnsureUser(act, key, existingKey ? act.users[existingKey].nickname : target, existingKey ? null : target)
  d.lotto = Math.max(0, (d.lotto || 0) + amount)
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true, key, nickname: d.nickname || key, lotto: d.lotto })
})

app.get('/activity/users', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  const list = Object.entries(act.users).map(([key, d]) => {
    const { level, curExp, nextExp } = actGetLevel(d.exp || 0, act.lvBase)
    return { key, nickname: d.nickname || key, tag: d.tag || '', exp: d.exp || 0, level, curExp, nextExp, heart: d.heart || 0, chat: d.chat || 0, attend: d.attend || 0, lp: d.lp || 0, lotto: d.lotto || 0 }
  }).sort((a, b) => b.exp - a.exp)
  res.json({ success: true, users: list, lottoExchange: Number(act.lottoExchange) || 22 })
})

// ⭐ 특정 유저 exp/복권 수동 조정 (웹 화면에서 !상점/!복권지급 대신 쓸 수 있게)
app.post('/activity/users/:key/adjust', auth.requireAuth, (req, res) => {
  const { expDelta, lottoDelta } = req.body || {}
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  const d = act.users[req.params.key]
  if (!d) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  if (expDelta) actGrantExp(req.djId, act, req.params.key, Number(expDelta) || 0)
  if (lottoDelta) d.lotto = Math.max(0, (d.lotto || 0) + Number(lottoDelta))
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true })
})

// ⭐ 특정 유저 애청지수 정보 삭제 (DJ가 대신 초기화해줄 때)
app.post('/activity/users/:key/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  delete act.users[req.params.key]
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true })
})

// ⭐ 새 유저 수동 추가 (웹 화면 "+ 추가")
app.post('/activity/users', auth.requireAuth, (req, res) => {
  const nickname = String((req.body || {}).nickname || '').trim()
  if (!nickname) return res.json({ success: false, error: '닉네임을 입력해주세요' })
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  if (act.users[nickname]) return res.json({ success: false, error: '이미 등록된 닉네임이에요' })
  actEnsureUser(act, nickname, nickname)
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true })
})

// ⭐ 전체 유저 삭제
app.post('/activity/users/delete-all', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  act.users = {}
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true })
})

// ⭐ 유저 점수 수동 편집 (웹 화면 상세 카드의 "수동 점수 편집" 저장 버튼)
// heart/chat/attend/lp/lotto는 절대값으로 덮어쓰고, expAdd는 기존 EXP에 더하고,
// setLevel이 있으면(>0) 그 레벨의 시작 EXP로 먼저 맞춘 뒤 expAdd를 추가로 더한다.
app.post('/activity/users/:key/edit', auth.requireAuth, (req, res) => {
  const { heart, chat, attend, lp, lotto, expAdd, setLevel, tag } = req.body || {}
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  const d = act.users[req.params.key]
  if (!d) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  if (heart != null) d.heart = Math.max(0, Number(heart) || 0)
  if (chat != null) d.chat = Math.max(0, Number(chat) || 0)
  if (attend != null) d.attend = Math.max(0, Number(attend) || 0)
  if (lp != null) d.lp = Math.max(0, Number(lp) || 0)
  if (lotto != null) d.lotto = Math.max(0, Number(lotto) || 0)
  if (tag != null) d.tag = String(tag).trim().replace(/^@/, '') || null
  if (setLevel != null && Number(setLevel) > 0) {
    const base = Number(act.lvBase) || 100
    const lvl = Math.max(1, Math.floor(Number(setLevel)))
    d.exp = base * lvl * (lvl - 1) / 2
  }
  if (expAdd) actGrantExp(req.djId, act, req.params.key, Number(expAdd) || 0)
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true })
})

// ⭐ 유저 닉네임(키) 변경 — 저장된 키가 실제 닉네임과 어긋났을 때 DJ가 직접 고칠 수 있게
app.post('/activity/users/:key/rename', auth.requireAuth, (req, res) => {
  const newKey = String((req.body || {}).newKey || '').trim()
  if (!newKey) return res.json({ success: false, error: '새 고유닉을 입력해주세요' })
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  const d = act.users[req.params.key]
  if (!d) return res.json({ success: false, error: '유저를 찾을 수 없어요' })
  if (newKey !== req.params.key && act.users[newKey]) return res.json({ success: false, error: '이미 그 고유닉으로 등록된 유저가 있어요' })
  delete act.users[req.params.key]
  d.tag = newKey
  act.users[newKey] = d
  store.saveSettings(req.djId, { activity: act })
  res.json({ success: true, key: newKey })
})

// 🧩 퀴즈 문제 목록 + 설정 조회
app.get('/quiz/questions', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const quiz = getQuizSettings(req.djId, settings)
  const room = getRoom(req.djId)
  res.json({
    success: true,
    questions: quiz.questions,
    settings: {
      intervalMin: quiz.intervalMin, intervalSec: quiz.intervalSec,
      autoStartOnRestart: quiz.autoStartOnRestart, enabled: quiz.enabled,
      msgCorrect: quiz.msgCorrect, msgTimeout: quiz.msgTimeout, msgQuestion: quiz.msgQuestion
    },
    running: !!(room.quiz && room.quiz.running),
    current: room.quiz && room.quiz.current ? { question: room.quiz.current.question } : null
  })
})

app.post('/quiz/questions', auth.requireAuth, (req, res) => {
  const { question, answer, score, timeLimit } = req.body || {}
  if (!question || !answer) return res.json({ success: false, error: '문제와 정답을 입력해주세요' })
  const settings = store.getSettings(req.djId) || {}
  const quiz = getQuizSettings(req.djId, settings)
  if (quiz.questions.length >= 100) return res.json({ success: false, error: '문제는 최대 100개까지 등록할 수 있어요' })
  const id = 'q' + Date.now() + Math.floor(Math.random() * 1000)
  quiz.questions.push({ id, question, answer, score: Number(score) || 10, timeLimit: Number(timeLimit) || 20 })
  store.saveSettings(req.djId, { quiz })
  res.json({ success: true, id })
})

app.post('/quiz/questions/:id', auth.requireAuth, (req, res) => {
  const { question, answer, score, timeLimit } = req.body || {}
  const settings = store.getSettings(req.djId) || {}
  const quiz = getQuizSettings(req.djId, settings)
  const q = quiz.questions.find(x => x.id === req.params.id)
  if (!q) return res.json({ success: false, error: '문제를 찾을 수 없어요' })
  if (question != null) q.question = question
  if (answer != null) q.answer = answer
  if (score != null) q.score = Number(score) || 0
  if (timeLimit != null) q.timeLimit = Number(timeLimit) || 20
  store.saveSettings(req.djId, { quiz })
  res.json({ success: true })
})

app.post('/quiz/questions/:id/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const quiz = getQuizSettings(req.djId, settings)
  quiz.questions = quiz.questions.filter(x => x.id !== req.params.id)
  store.saveSettings(req.djId, { quiz })
  res.json({ success: true })
})

app.post('/quiz/settings', auth.requireAuth, (req, res) => {
  const { intervalMin, intervalSec, autoStartOnRestart } = req.body || {}
  const settings = store.getSettings(req.djId) || {}
  const quiz = getQuizSettings(req.djId, settings)
  if (intervalMin != null) quiz.intervalMin = Number(intervalMin) || 0
  if (intervalSec != null) quiz.intervalSec = Number(intervalSec) || 0
  if (autoStartOnRestart != null) quiz.autoStartOnRestart = !!autoStartOnRestart
  store.saveSettings(req.djId, { quiz })
  res.json({ success: true })
})

app.post('/quiz/messages', auth.requireAuth, (req, res) => {
  const { msgCorrect, msgTimeout, msgQuestion } = req.body || {}
  const settings = store.getSettings(req.djId) || {}
  const quiz = getQuizSettings(req.djId, settings)
  if (msgCorrect != null) quiz.msgCorrect = msgCorrect
  if (msgTimeout != null) quiz.msgTimeout = msgTimeout
  if (msgQuestion != null) quiz.msgQuestion = msgQuestion
  store.saveSettings(req.djId, { quiz })
  res.json({ success: true })
})

app.post('/quiz/start', auth.requireAuth, (req, res) => {
  const room = getRoom(req.djId)
  if (!room.isConnected) return res.json({ success: false, error: '봇이 방송에 접속되어 있지 않아요' })
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'quiz', req.djId)) return res.json({ success: false, error: '퀴즈 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const quiz = getQuizSettings(req.djId, settings)
  if (!quiz.questions.length) return res.json({ success: false, error: '등록된 문제가 없어요. 먼저 문제를 추가해주세요' })
  startQuiz(req.djId)
  res.json({ success: true })
})

app.post('/quiz/stop', auth.requireAuth, (req, res) => {
  stopQuiz(req.djId)
  res.json({ success: true })
})

// 🎟️ 복권 자동 지급 — 설정 조회/저장 + 즉시지급/일시정지/재개
app.get('/lottoauto/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getLottoAutoSettings(req.djId, settings)
  const room = getRoom(req.djId)
  res.json({ success: true, settings: cfg, running: !!room.lottoAutoTimer, isConnected: room.isConnected, nextRunHint: lottoAutoNextRunHint(cfg) })
})

app.post('/lottoauto/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'lottoauto', req.djId)) return res.json({ success: false, error: '복권 자동지급 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getLottoAutoSettings(req.djId, settings)
  const { enabled, intervalMin, amount, announceMsg, cmdStatus, cmdNow, cmdPause, cmdResume, cmdRefresh } = req.body || {}
  if (enabled != null) cfg.enabled = !!enabled
  if (intervalMin != null) cfg.intervalMin = Math.max(1, Math.min(1440, Number(intervalMin) || 30))
  if (amount != null) cfg.amount = Math.max(1, Math.min(1000, Number(amount) || 1))
  if (announceMsg != null) cfg.announceMsg = announceMsg
  if (cmdStatus != null) cfg.cmdStatus = String(cmdStatus).trim() || '!자동복권'
  if (cmdNow != null) cfg.cmdNow = String(cmdNow).trim() || '!자동복권즉시'
  if (cmdPause != null) cfg.cmdPause = String(cmdPause).trim() || '!자동복권정지'
  if (cmdResume != null) cfg.cmdResume = String(cmdResume).trim() || '!자동복권시작'
  if (cmdRefresh != null) cfg.cmdRefresh = String(cmdRefresh).trim() || '!자동복권갱신'
  store.saveSettings(req.djId, { lottoAuto: cfg })
  const room = getRoom(req.djId)
  if (room.isConnected && room.autoJoinedFor) startLottoAutoTimer(req.djId, room.autoJoinedFor)
  else stopLottoAutoTimer(req.djId)
  res.json({ success: true })
})

app.post('/lottoauto/run-now', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'lottoauto', req.djId)) return res.json({ success: false, error: '복권 자동지급 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const room = getRoom(req.djId)
  if (!room.isConnected || !room.autoJoinedFor) return res.json({ success: false, error: '봇이 방송에 접속되어 있지 않아요' })
  const r = await runLottoAutoOnce(req.djId, room, room.autoJoinedFor, '수동(웹)')
  if (!r.ok) return res.json({ success: false, error: r.why === 'no_live_users' ? '라이브 접속 중인 시청자가 없어요' : '지급에 실패했어요' })
  res.json({ success: true, count: r.count, amount: r.amount })
})

app.post('/lottoauto/pause', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getLottoAutoSettings(req.djId, settings)
  cfg.paused = true
  store.saveSettings(req.djId, { lottoAuto: cfg })
  res.json({ success: true })
})

app.post('/lottoauto/resume', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getLottoAutoSettings(req.djId, settings)
  cfg.paused = false
  store.saveSettings(req.djId, { lottoAuto: cfg })
  const room = getRoom(req.djId)
  if (room.isConnected && room.autoJoinedFor) startLottoAutoTimer(req.djId, room.autoJoinedFor)
  res.json({ success: true })
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
  const { joinMessages, likeMessages, leaveMessages, entryData, entryCooldown, funding, shield, flags, commands, greetings, songRequest, roulette, rouletteHistory, activity, moduleEnabled, moduleVisible } = req.body || {}
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
  if (activity) patch.activity = activity
  if (moduleEnabled) patch.moduleEnabled = moduleEnabled
  if (moduleVisible) patch.moduleVisible = moduleVisible
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
    if (!isModuleOn(settings, 'autojoin', djId)) continue
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
          stopLottoAutoTimer(djId)
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
  const settingsForCheck = store.getSettings(djId) || {}
  if (enabled && !isModuleOn(settingsForCheck, 'autojoin', djId)) return res.json({ success: false, error: '자동입장 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
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

  const settingsForCheck = store.getSettings(djId) || {}
  if (!isModuleOn(settingsForCheck, 'autojoin', djId)) {
    return res.json({ success: false, error: '자동입장 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  }
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
  stopLottoAutoTimer(djId)
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
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'chat', req.djId)) return res.json({ success: false, error: '채팅 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  await sendChatToRoom(req.djId, message)
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════
// 스푼 세션 쿠키 업로드 — 로그인한 DJ 본인 계정에만 연결된다. (djId별 멀티 계정 구조)
// ⚠️ 지금은 모든 DJ가 이 계정의 토큰을 공유해서 쓰므로, 세션 업로드도 관리자(sum)만 가능하게 제한한다.
app.post('/session/upload', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 세션을 연결할 수 있어요' })
  const adminSettings = store.getSettings(req.djId) || {}
  if (!isModuleOn(adminSettings, 'session', req.djId)) return res.json({ success: false, error: '세션 연결 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
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