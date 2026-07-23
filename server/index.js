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
  if (!room.streamName || !room.roomToken || !accessToken) return
  try {
    const res = await fetch(`${GW_BASE}/lives/${room.streamName}/chat/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'x-live-authorization': `Bearer ${room.roomToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
        'Referer': 'https://www.spooncast.net/',
      },
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

async function connectSpoonForDj(djId, liveId, roomToken) {
  const room = getRoom(djId)
  if (room.ws) { room.ws.terminate(); room.ws = null }

  const accessToken = tokenManager.getAccessToken()
  const { streamName, djUserId } = await fetchLiveInfo(liveId, accessToken)
  room.streamName = streamName
  room.roomToken = roomToken
  room.liveDjUserId = djUserId

  const ws = new WebSocket(`wss://kr-wala.spooncast.net/ws?token=${accessToken}`)
  room.ws = ws

  ws.on('open', () => {
    console.log(`[${djId}] 스푼 연결됨! streamName:`, streamName)
    room.isConnected = true
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        command: 'ACTIVATE_CHANNEL',
        payload: { channelId: streamName, liveToken: roomToken }
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

      const settings = store.getSettings(djId) || {}

      if (eventName === 'ChatMessage') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        const text = eventPayload.message || ''
        broadcast({ type: 'chat', djId, nick: author, text })
        handleShieldCommand(djId, room, settings, author, authorId, text)
        handleFlagCommand(djId, room, settings, author, authorId, text)

      } else if (eventName === 'RoomJoin') {
        const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
        broadcast({ type: 'join', djId, nick: author })
        const msgs = (settings.joinMessages || []).filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author)
          setTimeout(() => sendChatToRoom(djId, text), 500)
        }

      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
        broadcast({ type: 'like', djId, nick: author })
        const msgs = (settings.likeMessages || []).filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author)
          setTimeout(() => sendChatToRoom(djId, text), 500)
        }

      } else if (eventName === 'LiveDonation') {
        const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
        const amount = Number(eventPayload.amount) || 0
        broadcast({ type: 'donation', djId, nick: author, amount })
        handleFlagAutoDonation(djId, settings, amount)
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
// 자동입장 감시 — 모든 디제이를 한 번씩 훑으면서, autoJoinTag가 설정된
// 디제이의 방송 여부를 확인하고 켜져있으면 자동 입장시킨다.
async function checkAutoJoinAll() {
  const accessToken = tokenManager.getAccessToken()
  if (!accessToken) return

  for (const djId of store.listDjIds()) {
    const settings = store.getSettings(djId)
    if (!settings || !settings.autoJoinTag) continue

    const room = getRoom(djId)
    if (room.checking) continue
    room.checking = true

    try {
      const status = await fetchUserStatusByTag(settings.autoJoinTag)
      if (!status) continue

      if (!status.is_live || !status.current_live_id) {
        if (room.autoJoinedFor) {
          broadcast({ type: 'autojoin', djId, status: 'offline', tag: settings.autoJoinTag })
          room.autoJoinedFor = ''
          if (room.ws) { room.ws.terminate(); room.ws = null; room.isConnected = false }
          broadcast({ type: 'status', djId, isConnected: false })
        }
        continue
      }

      const liveId = String(status.current_live_id)
      broadcast({ type: 'autojoin', djId, status: 'live', tag: settings.autoJoinTag, liveId })
      if (liveId === room.autoJoinedFor) continue

      broadcast({ type: 'autojoin', djId, status: 'joining', tag: settings.autoJoinTag, liveId })
      const roomToken = await tokenManager.fetchRoomToken(liveId)
      if (!roomToken) {
        broadcast({ type: 'autojoin', djId, status: 'error', tag: settings.autoJoinTag, msg: 'Room Token 발급 실패' })
        continue
      }

      room.autoJoinedFor = liveId
      await connectSpoonForDj(djId, liveId, roomToken)
      broadcast({ type: 'autojoin', djId, status: 'joined', tag: settings.autoJoinTag, liveId })
    } catch (e) {
      console.log(`[자동입장:${djId} 오류]`, e.message)
    } finally {
      room.checking = false
    }
  }
}

setInterval(checkAutoJoinAll, 5000)

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

app.post('/auth/login', (req, res) => {
  const { djId, password } = req.body || {}
  const result = store.login(djId, password)
  if (!result.ok) return res.json({ success: false, error: result.error })
  const token = auth.issueToken(djId)
  res.json({ success: true, token, djId })
})

app.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ success: true, djId: req.djId })
})

// ══════════════════════════════════════════════════════
// 디제이별 설정 (로그인 필요)
app.get('/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId)
  res.json({ success: true, settings })
})

app.post('/settings', auth.requireAuth, (req, res) => {
  const { joinMessages, likeMessages, entryData, entryCooldown, funding, shield, flags } = req.body || {}
  const patch = {}
  if (joinMessages) patch.joinMessages = joinMessages
  if (likeMessages) patch.likeMessages = likeMessages
  if (entryData) patch.entryData = entryData
  if (typeof entryCooldown === 'number') patch.entryCooldown = entryCooldown
  if (funding) patch.funding = funding
  if (shield) patch.shield = shield
  if (flags) patch.flags = flags
  store.saveSettings(req.djId, patch)
  res.json({ success: true })
})

app.post('/autojoin', auth.requireAuth, (req, res) => {
  const { tag } = req.body || {}
  const djId = req.djId
  const room = getRoom(djId)

  if (!tag) {
    store.saveSettings(djId, { autoJoinTag: '' })
    room.autoJoinedFor = ''
    if (room.ws) { room.ws.terminate(); room.ws = null; room.isConnected = false }
    broadcast({ type: 'autojoin', djId, status: 'off' })
    return res.json({ success: true, msg: '자동입장 해제' })
  }

  if (!tokenManager.getAccessToken()) {
    return res.json({ success: false, error: '스푼 세션이 아직 준비되지 않았어요. 관리자에게 문의해주세요.' })
  }

  store.saveSettings(djId, { autoJoinTag: String(tag).replace('@', '').trim() })
  broadcast({ type: 'autojoin', djId, status: 'watching', tag })
  res.json({ success: true, msg: `@${tag} 감시 시작` })
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
