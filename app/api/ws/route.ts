import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const accessToken = searchParams.get('accessToken')
  const roomToken = searchParams.get('roomToken')
  const channelId = searchParams.get('channelId')

  if (!accessToken || !roomToken || !channelId) {
    return NextResponse.json({ error: '파라미터 없음' }, { status: 400 })
  }

  // WebSocket URL 반환 (프론트에서 직접 연결)
  return NextResponse.json({
    wsUrl: `wss://kr-wala.spooncast.net/ws?token=${accessToken}`,
    channelId,
    roomToken,
  })
}
EOF.


cat > app/page.tsx << 'EOF'
'use client'
import { useState, useEffect, useRef } from 'react'

export default function Home() {
  const [accessToken, setAccessToken] = useState('')
  const [roomToken, setRoomToken] = useState('')
  const [channelId, setChannelId] = useState('')
  const [message, setMessage] = useState('')
  const [logs, setLogs] = useState<{type:string,author:string,text:string}[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket|null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  const addLog = (type: string, author: string, text: string) => {
    setLogs(prev => [...prev, { type, author, text }])
  }

  const connect = () => {
    if (!accessToken || !roomToken || !channelId) {
      addLog('error', '시스템', '토큰과 채널ID를 모두 입력하세요!')
      return
    }
    if (wsRef.current) wsRef.current.close()

    const ws = new WebSocket(`wss://kr-wala.spooncast.net/ws?token=${accessToken}`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        command: 'ACTIVATE_CHANNEL',
        payload: { channelId, liveToken: roomToken }
      }))
      addLog('system', '시스템', 'WebSocket 연결됨, 입장 중...')
      setTimeout(() => { setConnected(true); addLog('system', '시스템', '✅ 연결 완료!') }, 1500)
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.command !== 'MESSAGE') return
        const body = JSON.parse(msg.payload?.body || '{}')
        const { eventName, eventPayload = {} } = body
        if (eventName === 'ChatMessage') {
          const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
          addLog('chat', author, eventPayload.message || '')
        } else if (eventName === 'RoomJoin') {
          const author = eventPayload.generator?.nickname || '?'
          addLog('join', author, '입장했습니다 👋')
        }
      } catch {}
    }

    ws.onerror = () => addLog('error', '오류', '연결 오류 발생')
    ws.onclose = (e) => { setConnected(false); addLog('system', '시스템', `연결 종료 (${e.code})`) }
  }

  const disconnect = () => { wsRef.current?.close(); setConnected(false) }

  const sendChat = async () => {
    if (!message.trim()) return
    const res = await fetch('/api/spoon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, message, accessToken, roomToken })
    })
    if (res.ok) { addLog('bot', '🤖봇', message); setMessage('') }
    else addLog('error', '오류', '채팅 전송 실패')
  }

  const colorMap: Record<string,string> = {
    chat: '#fff', join: '#4ade80', error: '#f87171', system: '#94a3b8', bot: '#60a5fa'
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#0f172a', color:'#fff', fontFamily:'sans-serif', padding:'1rem', gap:'0.75rem' }}>
      <h1 style={{ margin:0, fontSize:'1.25rem' }}>🎙️ 스푼 웹봇</h1>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem' }}>
        <input placeholder="Access Token" value={accessToken} onChange={e=>setAccessToken(e.target.value)}
          style={{ padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff', fontSize:'0.75rem' }} />
        <input placeholder="Room Token" value={roomToken} onChange={e=>setRoomToken(e.target.value)}
          style={{ padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff', fontSize:'0.75rem' }} />
        <input placeholder="Channel ID (stream_name)" value={channelId} onChange={e=>setChannelId(e.target.value)}
          style={{ padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff', fontSize:'0.75rem', gridColumn:'span 2' }} />
      </div>

      <div style={{ display:'flex', gap:'0.5rem' }}>
        <button onClick={connect} disabled={connected}
          style={{ flex:1, padding:'0.5rem', borderRadius:'6px', border:'none', background: connected ? '#334155' : '#22c55e', color:'#fff', cursor: connected ? 'not-allowed' : 'pointer' }}>
          {connected ? '✅ 연결됨' : '🔌 연결'}
        </button>
        <button onClick={disconnect} disabled={!connected}
          style={{ flex:1, padding:'0.5rem', borderRadius:'6px', border:'none', background: !connected ? '#334155' : '#ef4444', color:'#fff', cursor: !connected ? 'not-allowed' : 'pointer' }}>
          ⛔ 연결 끊기
        </button>
      </div>

      <div style={{ flex:1, overflowY:'auto', background:'#1e293b', borderRadius:'8px', padding:'0.75rem', display:'flex', flexDirection:'column', gap:'0.25rem' }}>
        {logs.map((log, i) => (
          <div key={i} style={{ fontSize:'0.85rem', color: colorMap[log.type] || '#fff' }}>
            <span style={{ opacity:0.6 }}>[{log.author}]</span> {log.text}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>

      <div style={{ display:'flex', gap:'0.5rem' }}>
        <input placeholder="채팅 입력..." value={message} onChange={e=>setMessage(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&sendChat()}
          style={{ flex:1, padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff' }} />
        <button onClick={sendChat}
          style={{ padding:'0.5rem 1rem', borderRadius:'6px', border:'none', background:'#3b82f6', color:'#fff', cursor:'pointer' }}>
          전송
        </button>
      </div>
    </div>
  )
}
