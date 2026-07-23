const WebSocket = require('ws')
const express = require('express')
const cors = require('cors')
const tokenManager = require('./tokenManager')

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '5mb' }))
app.use(require('express').static(__dirname + '/public'))

const GW_BASE = 'https://kr-gw.spooncast.net'
const API_BASE = 'https://api.spooncast.net'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let spoonWs = null
let settings = null
let joinMsgs = []
let likeMsgs = []
let commands = []
let isConnected = false
let sseClients = []

// 자동입장 상태
let autoJoinTag = ''
let autoJoinWatcher = null
let autoJoinedFor = ''
let autoJoinChecking = false

// ══════════════════════════════════════════════════════
// 세션 쿠키 기반 accessToken 자동 갱신 (PC 없이 유지)
tokenManager.setOnTokenUpdate((token) => {
  if (!settings) settings = {}
  settings.accessToken = token
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
  } catch(e) {
    return null
  }
}

async function fetchRoomToken(liveId, accessToken) {
  try {
    const res = await fetch(`${API_BASE}/lives/${liveId}/entrance/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
        'Referer': 'https://www.spooncast.net/',
      },
      body: JSON.stringify({})
    })
    const data = await res.json()
    console.log('[입장 API]', res.status, JSON.stringify(data).substring(0, 200))
    const token = data.token || data.live_token || data.room_token || data.access_token
    return token || null
  } catch(e) {
    console.log('[입장 API 오류]', e.message)
    return null
  }
}

async function fetchStreamName(liveId, accessToken) {
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
    const streamName = live.stream_name || live.streamName || String(liveId)
    console.log('[stream_name]', streamName)
    return streamName
  } catch(e) {
    console.log('[stream_name 오류]', e.message)
    return String(liveId)
  }
}

async function sendChat(message) {
  if (!settings) return
  try {
    const res = await fetch(`${GW_BASE}/lives/${settings.streamName}/chat/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.accessToken}`,
        'x-live-authorization': `Bearer ${settings.roomToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
        'Referer': 'https://www.spooncast.net/',
      },
      body: JSON.stringify({ message, messageType: 'GENERAL_MESSAGE' })
    })
    const data = await res.json()
    console.log('채팅 전송:', message, '응답:', res.status)
    return data
  } catch(e) {
    console.log('채팅 전송 오류:', e.message)
  }
}

async function connectSpoon(s) {
  if (spoonWs) { spoonWs.terminate(); spoonWs = null }

  const streamName = await fetchStreamName(s.channelId, s.accessToken)
  s.streamName = streamName
  settings = s

  const ws = new WebSocket(`wss://kr-wala.spooncast.net/ws?token=${s.accessToken}`)
  spoonWs = ws

  ws.on('open', () => {
    console.log('스푼 연결됨! streamName:', streamName)
    isConnected = true
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        command: 'ACTIVATE_CHANNEL',
        payload: { channelId: streamName, liveToken: s.roomToken }
      }))
    }
    broadcast({ type: 'status', isConnected: true })
  })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data)
      if (msg.command !== 'MESSAGE') return
      const body = JSON.parse(msg.payload?.body || '{}')
      const { eventName, eventPayload = {} } = body
      console.log('[WS 이벤트]', eventName)

      if (eventName === 'ChatMessage') {
        const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
        const text = eventPayload.message || ''
        console.log(`[채팅] ${author}: ${text}`)
        broadcast({ type: 'chat', nick: author, text })
        const matched = commands.find(c => text.trim() === c.trigger.trim())
        if (matched) setTimeout(() => sendChat(matched.response), 500)

      } else if (eventName === 'RoomJoin') {
        const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
        console.log(`[입장] ${author}`)
        broadcast({ type: 'join', nick: author })
        const msgs = joinMsgs.filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author)
          setTimeout(() => sendChat(text), 500)
        }

      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
        console.log(`[좋아요] ${author}`)
        broadcast({ type: 'like', nick: author })
        const msgs = likeMsgs.filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author)
          setTimeout(() => sendChat(text), 500)
        }
      }
    } catch(e) {
      console.log('[WS 파싱 오류]', e.message)
    }
  })

  ws.on('close', (code, reason) => {
    console.log('스푼 연결 종료 code:', code)
    isConnected = false
    spoonWs = null
    broadcast({ type: 'status', isConnected: false })
  })

  ws.on('error', (e) => {
    console.log('스푼 오류:', e.message)
    isConnected = false
  })
}

// 자동입장 감시
async function checkAutoJoin() {
  // 매 체크마다 tokenManager가 갱신해둔 최신 accessToken을 반영
  const latestToken = tokenManager.getAccessToken()
  if (latestToken) {
    if (!settings) settings = {}
    settings.accessToken = latestToken
  }

  if (!autoJoinTag || !settings?.accessToken) return
  if (autoJoinChecking) return
  autoJoinChecking = true
  try {
    const status = await fetchUserStatusByTag(autoJoinTag)
    if (!status) return

    if (!status.is_live || !status.current_live_id) {
      if (autoJoinedFor) {
        console.log(`[자동입장] @${autoJoinTag} 방송 종료`)
        broadcast({ type: 'autojoin', status: 'offline', tag: autoJoinTag })
        autoJoinedFor = ''
        if (isConnected) {
          if (spoonWs) { spoonWs.terminate(); spoonWs = null }
          isConnected = false
          broadcast({ type: 'status', isConnected: false })
        }
      }
      return
    }

    const liveId = String(status.current_live_id)
    broadcast({ type: 'autojoin', status: 'live', tag: autoJoinTag, liveId })

    if (liveId === autoJoinedFor) return

    console.log(`[자동입장] @${autoJoinTag} 방송 감지! live_id: ${liveId}`)
    broadcast({ type: 'autojoin', status: 'joining', tag: autoJoinTag, liveId })

    const roomToken = await fetchRoomToken(liveId, settings.accessToken)
    if (!roomToken) {
      console.log('[자동입장] Room Token 발급 실패')
      broadcast({ type: 'autojoin', status: 'error', tag: autoJoinTag, msg: 'Room Token 발급 실패' })
      return
    }

    console.log('[자동입장] Room Token 발급 성공! 연결 시작')
    autoJoinedFor = liveId
    await connectSpoon({
      accessToken: settings.accessToken,
      roomToken,
      channelId: liveId,
    })
    broadcast({ type: 'autojoin', status: 'joined', tag: autoJoinTag, liveId })
  } catch(e) {
    console.log('[자동입장 오류]', e.message)
  } finally {
    autoJoinChecking = false
  }
}

function startAutoJoinWatcher() {
  if (autoJoinWatcher) clearInterval(autoJoinWatcher)
  autoJoinWatcher = setInterval(checkAutoJoin, 5000)
  checkAutoJoin()
}

function stopAutoJoinWatcher() {
  if (autoJoinWatcher) { clearInterval(autoJoinWatcher); autoJoinWatcher = null }
  autoJoinedFor = ''
}

// API 엔드포인트
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sseClients.push(res)
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res) })
})

app.post('/connect', async (req, res) => {
  const { accessToken, roomToken, channelId } = req.body
  if (!accessToken || !roomToken || !channelId) return res.json({ error: '파라미터 없음' })
  await connectSpoon({ accessToken, roomToken, channelId })
  res.json({ success: true })
})

app.post('/disconnect', (req, res) => {
  if (spoonWs) { spoonWs.terminate(); spoonWs = null }
  isConnected = false
  settings = null
  stopAutoJoinWatcher()
  res.json({ success: true })
})

app.get('/status', (req, res) => {
  res.json({
    isConnected,
    channelId: settings?.channelId,
    autoJoinTag,
    hasSession: tokenManager.hasCookies(),
    hasToken: !!tokenManager.getAccessToken(),
  })
})

// ══════════════════════════════════════════════════════
// 세션 쿠키 업로드 (PC에서 get_session_cookies.js로 추출한 파일 내용)
app.post('/session/upload', (req, res) => {
  const { cookies } = req.body
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    return res.json({ success: false, error: '쿠키 데이터가 비어있습니다' })
  }
  tokenManager.setCookies(cookies)
  tokenManager.startAutoRefresh(10) // 10분마다 자동 갱신
  console.log(`[세션] 쿠키 업로드됨 (${cookies.length}개) → accessToken 발급 시도`)
  res.json({ success: true, msg: '쿠키 업로드 완료. accessToken 발급을 시도합니다.' })
})

app.get('/session/status', (req, res) => {
  res.json({ hasSession: tokenManager.hasCookies(), hasToken: !!tokenManager.getAccessToken() })
})

app.post('/autojoin', (req, res) => {
  const { tag } = req.body
  if (!tag) {
    stopAutoJoinWatcher()
    autoJoinTag = ''
    broadcast({ type: 'autojoin', status: 'off' })
    return res.json({ success: true, msg: '자동입장 해제' })
  }
  autoJoinTag = String(tag).replace('@', '').trim()

  // accessToken은 더 이상 프론트에서 받지 않고, tokenManager가 관리하는 최신 토큰을 사용
  const latestToken = tokenManager.getAccessToken()
  if (latestToken) {
    if (!settings) settings = {}
    settings.accessToken = latestToken
  }
  if (!settings?.accessToken) {
    broadcast({ type: 'autojoin', status: 'error', tag: autoJoinTag, msg: '세션 쿠키를 먼저 업로드해주세요' })
    return res.json({ success: false, error: '세션 쿠키가 없습니다. /session/upload 먼저 진행해주세요.' })
  }

  startAutoJoinWatcher()
  console.log(`[자동입장] @${autoJoinTag} 감시 시작`)
  broadcast({ type: 'autojoin', status: 'watching', tag: autoJoinTag })
  res.json({ success: true, msg: `@${autoJoinTag} 감시 시작` })
})

app.post('/chat', async (req, res) => {
  const { message } = req.body
  if (!message) return res.json({ error: '메시지 없음' })
  const result = await sendChat(message)
  res.json({ success: true, result })
})

app.post('/settings', (req, res) => {
  const { joinMessages, likeMessages, cmds } = req.body
  if (joinMessages) joinMsgs = joinMessages
  if (likeMessages) likeMsgs = likeMessages
  if (cmds) commands = cmds
  res.json({ success: true })
})

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html')
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`))
