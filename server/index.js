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

// 디제이별 방(연결) 상태. djId -> { ws, isConnected, streamName, roomToken, autoJoinedFor, checking }
const rooms = {}
function getRoom(djId) {
  if (!rooms[djId]) {
    rooms[djId] = { ws: null, isConnected: false, streamName: '', roomToken: '', autoJoinedFor: '', checking: false, liveDjUserId: null }
  }
  return rooms[djId]
}

let sseClients = []

// ══════════════════════════════════════════════════════
// 세션 쿠키 기반 accessToken 자동 갱신 (스푼 계정은 단비님 것 하나만 공용으로 사용)
tokenManager.setOnTokenUpdate(() => {
  broadcast({ type: 'session', status: 'connected' })
})
tokenManager.setOnSessionExpired(() => {
  broadcast({ type: 'session', status: 'expired' })
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
  const accessToken = tokenManager.getAccessToken()
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
    const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken())
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

async function connectSpoonForDj(djId, liveId, roomToken) {
  const room = getRoom(djId)
  if (room.ws) { room.ws.terminate(); room.ws = null }

  const accessToken = tokenManager.getAccessToken()
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
        }

      } else if (eventName === 'RoomJoin') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'join', djId, nick: author })

        if (!isLurker) {
          const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken())
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

      } else if (eventName === 'RoomLeave' || eventName === 'RoomExit' || eventName === 'LiveLeave') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        broadcast({ type: 'leave', djId, nick: author })
        if (!isLurker) {
          const msgs = (settings.leaveMessages || []).filter(m => m.enabled)
          if (msgs.length > 0) {
            // {tag}는 조회 API 호출이 필요해서 퇴장 멘트에서는 지원하지 않음 (빈 값 처리)
            const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, '')
            setTimeout(() => sendChatToRoom(djId, text), 500)
          }
        }

      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const gen = eventPayload.generator || {}
        const author = eventPayload.nickname || gen.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'like', djId, nick: author })
        const msgs = isLurker ? [] : (settings.likeMessages || []).filter(m => m.enabled)
        if (msgs.length > 0) {
          const tag = await fetchUserTag(liveId, authorId, tokenManager.getAccessToken())
          const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, tag ? `@${tag}` : '')
          setTimeout(() => sendChatToRoom(djId, text), 500)
        }

      } else if (eventName === 'LiveDonation') {
        const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
        const amount = Number(eventPayload.amount) || 0
        broadcast({ type: 'donation', djId, nick: author, amount })
        if (!isLurker) handleFlagAutoDonation(djId, settings, amount)
      }
    } catch (e) {
      console.log(`[${djId}] WS 파싱 오류`, e.message)
    }
  })

  ws.on('close', (code) => {
    console.log(`[${djId}] 스푼 연결 종료 code:`, code)
    room.isConnected = false
    room.ws = null
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

app.post('/settings', auth.requireAuth, (req, res) => {
  const { joinMessages, likeMessages, leaveMessages, entryData, entryCooldown, funding, shield, flags, commands, greetings, songRequest } = req.body || {}
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
  store.saveSettings(req.djId, patch)
  res.json({ success: true })
})

// 관리자(sum) 전용 — 등록해둔 여러 고유닉 중 방송 중인 곳을 찾아 자동으로 입장한다. (다른 디제이는 해당 없음)
async function checkAdminAutoJoin() {
  if (!tokenManager.getAccessToken()) return

  for (const djId of store.listDjIds()) {
    if (!canAutoJoin(djId)) continue

    const settings = store.getSettings(djId)
    if (!settings || !settings.autoJoinWatch) continue
    const tagList = (settings.autoJoinTags && settings.autoJoinTags.length) ? settings.autoJoinTags : (settings.autoJoinTag ? [settings.autoJoinTag] : [])
    if (!tagList.length) continue

    const room = getRoom(djId)
    if (room.checking) continue
    if (room.isConnected && room.autoJoinedFor) continue // 이미 어딘가 들어가 있으면 유지
    room.checking = true

    try {
      for (const tag of tagList) {
        const status = await fetchUserStatusByTag(tag)
        if (status && status.is_live && status.current_live_id) {
          const liveId = String(status.current_live_id)
          broadcast({ type: 'autojoin', djId, status: 'joining', tag, liveId })
          const roomToken = await tokenManager.fetchRoomToken(liveId)
          room.autoJoinedFor = liveId
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
  if (!tokenManager.getAccessToken()) {
    return res.json({ success: false, error: '스푼 세션이 아직 준비되지 않았어요. 관리자에게 문의해주세요.' })
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
    const roomToken = await tokenManager.fetchRoomToken(liveId)
    room.autoJoinedFor = liveId
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
  broadcast({ type: 'status', djId, isConnected: false })
  res.json({ success: true, msg: '현재 방에서 나갔어요' })
})

app.get('/status', auth.requireAuth, (req, res) => {
  const room = getRoom(req.djId)
  const settings = store.getSettings(req.djId)
  res.json({
    isConnected: room.isConnected,
    autoJoinTag: settings?.autoJoinTag || '',
    hasSession: tokenManager.hasCookies(),
    hasToken: !!tokenManager.getAccessToken(),
  })
})

app.post('/chat', auth.requireAuth, async (req, res) => {
  const { message } = req.body || {}
  if (!message) return res.json({ error: '메시지 없음' })
  await sendChatToRoom(req.djId, message)
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════
// 스푼 세션 쿠키 업로드 — 단비님(관리자) 전용.
// Railway 환경변수 ADMIN_KEY를 설정하면 x-admin-key 헤더가 필요해진다.
app.post('/session/upload', auth.requireAdmin, (req, res) => {
  const { cookies, localStorage, sessionStorage } = req.body
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    return res.json({ success: false, error: '쿠키 데이터가 비어있습니다' })
  }
  tokenManager.setCookies({ cookies, localStorage, sessionStorage })
  tokenManager.startAutoRefresh(30)
  console.log(`[세션] 쿠키 업로드됨 (${cookies.length}개) → accessToken 발급 시도`)
  res.json({ success: true, msg: '쿠키 업로드 완료. accessToken 발급을 시도합니다.' })
})

app.get('/session/status', (req, res) => {
  res.json({ hasSession: tokenManager.hasCookies(), hasToken: !!tokenManager.getAccessToken() })
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
  // 디스크에 저장된 세션(Volume)이 있으면 불러와서 자동 갱신을 바로 재개한다.
  if (tokenManager.initFromDisk()) {
    console.log('[세션] 저장된 세션 발견 → accessToken 자동 갱신 재개')
    tokenManager.startAutoRefresh(30)
  }
})