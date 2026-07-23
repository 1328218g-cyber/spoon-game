const WebSocket = require('ws')
const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json())
app.use(require('express').static(__dirname + '/public'))

const GW_BASE = 'https://kr-gw.spooncast.net'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

let spoonWs = null
let settings = null
let joinMsgs = []
let likeMsgs = []
let commands = []
let isConnected = false

// 스푼에 채팅 전송
async function sendChat(message) {
  if (!settings) return
  try {
    const res = await fetch(`${GW_BASE}/lives/${settings.channelId}/chat/message`, {
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

// 스푼 WebSocket 연결
function connectSpoon(s) {
  if (spoonWs) { spoonWs.terminate(); spoonWs = null }
  settings = s
  
  spoonWs = new WebSocket(`wss://kr-wala.spooncast.net/ws?token=${s.accessToken}`)
  
  spoonWs.on('open', () => {
    console.log('스푼 연결됨!')
    isConnected = true
    spoonWs.send(JSON.stringify({
      command: 'ACTIVATE_CHANNEL',
      payload: { channelId: s.channelId.trim(), liveToken: s.roomToken }
    }))
  })

  spoonWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data)
      if (msg.command !== 'MESSAGE') return
      const body = JSON.parse(msg.payload?.body || '{}')
      const { eventName, eventPayload = {} } = body

      if (eventName === 'ChatMessage') {
        const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
        const text = eventPayload.message || ''
        console.log(`[채팅] ${author}: ${text}`)
        const matched = commands.find(c => text.trim() === c.trigger.trim())
        if (matched) {
          setTimeout(() => sendChat(matched.response), 500)
        }
      } else if (eventName === 'RoomJoin') {
        const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
        console.log(`[입장] ${author}`)
        const msgs = joinMsgs.filter(m => m.enabled && (!m.target || m.target === author))
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author)
          setTimeout(() => sendChat(text), 500)
        }
      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
        console.log(`[좋아요] ${author}`)
        const msgs = likeMsgs.filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author)
          setTimeout(() => sendChat(text), 500)
        }
      }
    } catch(e) {}
  })

  spoonWs.on('close', () => {
    console.log('스푼 연결 종료')
    isConnected = false
    spoonWs = null
  })

  spoonWs.on('error', (e) => {
    console.log('스푼 오류:', e.message)
    isConnected = false
  })
}

// API 엔드포인트
app.post('/connect', (req, res) => {
  const { accessToken, roomToken, channelId } = req.body
  if (!accessToken || !roomToken || !channelId) {
    return res.json({ error: '파라미터 없음' })
  }
  connectSpoon({ accessToken, roomToken, channelId })
  res.json({ success: true, message: '연결 시작!' })
})

app.post('/disconnect', (req, res) => {
  if (spoonWs) { spoonWs.terminate(); spoonWs = null }
  isConnected = false
  settings = null
  res.json({ success: true })
})

app.get('/status', (req, res) => {
  res.json({ isConnected, channelId: settings?.channelId })
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
  res.json({ status: 'ok', isConnected })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`))
