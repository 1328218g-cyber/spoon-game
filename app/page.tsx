'use client'
import { useState, useEffect, useRef } from 'react'

export default function Home() {
  const [accessToken, setAccessToken] = useState('')
  const [roomToken, setRoomToken] = useState('')
  const [channelId, setChannelId] = useState('')
  const [message, setMessage] = useState('')
  const [logs, setLogs] = useState<{type:string,author:string,text:string}[]>([])
  const [connected, setConnected] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [joinMsg, setJoinMsg] = useState('환영합니다 {닉네임}님! 😊')
  const [likeMsg, setLikeMsg] = useState('{닉네임}님 좋아요 감사해요! 💕')
  const [joinEnabled, setJoinEnabled] = useState(true)
  const [likeEnabled, setLikeEnabled] = useState(true)
  const wsRef = useRef<WebSocket|null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const a = params.get('a') || localStorage.getItem('spoon_access') || ''
    const r = params.get('r') || localStorage.getItem('spoon_room') || ''
    const c = params.get('c') || localStorage.getItem('spoon_channel') || ''
    if (a) setAccessToken(a)
    if (r) setRoomToken(r)
    if (c) setChannelId(c)
    const jm = localStorage.getItem('join_msg')
    const lm = localStorage.getItem('like_msg')
    if (jm) setJoinMsg(jm)
    if (lm) setLikeMsg(lm)
  }, [])

  useEffect(() => { if (accessToken) localStorage.setItem('spoon_access', accessToken) }, [accessToken])
  useEffect(() => { if (roomToken) localStorage.setItem('spoon_room', roomToken) }, [roomToken])
  useEffect(() => { if (channelId) localStorage.setItem('spoon_channel', channelId) }, [channelId])
  useEffect(() => { localStorage.setItem('join_msg', joinMsg) }, [joinMsg])
  useEffect(() => { localStorage.setItem('like_msg', likeMsg) }, [likeMsg])
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  const addLog = (type: string, author: string, text: string) => {
    setLogs(prev => [...prev, { type, author, text }])
  }

  const sendChatMsg = async (text: string) => {
    await fetch('/api/spoon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: channelId.trim(), message: text, accessToken, roomToken })
    })
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
      ws.send(JSON.stringify({ command: 'ACTIVATE_CHANNEL', payload: { channelId: channelId.trim(), liveToken: roomToken } }))
      addLog('system', '시스템', 'WebSocket 연결됨!')
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
          const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
          addLog('join', author, '입장했습니다 👋')
          if (joinEnabled && joinMsg) {
            const text = joinMsg.replace('{닉네임}', author)
            setTimeout(() => sendChatMsg(text), 500)
            addLog('bot', '🤖봇', text)
          }
        } else if (eventName === 'LiveLike' || eventName === 'LivePresent') {
          const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
          addLog('system', '❤️좋아요', `${author}님`)
          if (likeEnabled && likeMsg) {
            const text = likeMsg.replace('{닉네임}', author)
            setTimeout(() => sendChatMsg(text), 500)
            addLog('bot', '🤖봇', text)
          }
        }
      } catch {}
    }
    ws.onerror = () => addLog('error', '오류', '연결 오류')
    ws.onclose = () => { setConnected(false); addLog('system', '시스템', '연결 종료') }
  }

  const disconnect = () => { wsRef.current?.close(); setConnected(false) }

  const generateUrl = () => {
    if (!accessToken || !roomToken || !channelId) {
      addLog('error', '시스템', '토큰을 먼저 입력하세요!')
      return
    }
    const url = `https://spoon-game-tan.vercel.app?a=${encodeURIComponent(accessToken)}&r=${encodeURIComponent(roomToken)}&c=${encodeURIComponent(channelId.trim())}`
    setShareUrl(url)
  }

  const sendChat = async () => {
    if (!message.trim()) return
    await sendChatMsg(message)
    addLog('bot', '봇', message)
    setMessage('')
  }

  const colorMap: Record<string,string> = { chat: '#fff', join: '#4ade80', error: '#f87171', system: '#94a3b8', bot: '#60a5fa' }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#0f172a', color:'#fff', fontFamily:'sans-serif', padding:'1rem', gap:'0.75rem' }}>
      <h1 style={{ margin:0, fontSize:'1.25rem' }}>🎙️ 스푼 웹봇</h1>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem' }}>
        <input placeholder="Access Token" value={accessToken} onChange={e=>setAccessToken(e.target.value)} style={{ padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff', fontSize:'0.75rem' }} />
        <input placeholder="Room Token" value={roomToken} onChange={e=>setRoomToken(e.target.value)} style={{ padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff', fontSize:'0.75rem' }} />
        <input placeholder="Channel ID (예: rz3QHUQT)" value={channelId} onChange={e=>setChannelId(e.target.value)} style={{ padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff', fontSize:'0.75rem', gridColumn:'span 2' }} />
      </div>

      <div style={{ background:'#1e293b', borderRadius:'8px', padding:'0.75rem', display:'flex', flexDirection:'column', gap:'0.5rem' }}>
        <div style={{ fontSize:'0.85rem', color:'#94a3b8', fontWeight:'bold' }}>자동 멘트 설정</div>
        <div style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <input type="checkbox" checked={joinEnabled} onChange={e=>setJoinEnabled(e.target.checked)} />
          <span style={{ fontSize:'0.8rem', minWidth:'50px' }}>입장</span>
          <input value={joinMsg} onChange={e=>setJoinMsg(e.target.value)} style={{ flex:1, padding:'0.35rem', borderRadius:'4px', border:'1px solid #334155', background:'#0f172a', color:'#fff', fontSize:'0.75rem' }} />
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <input type="checkbox" checked={likeEnabled} onChange={e=>setLikeEnabled(e.target.checked)} />
          <span style={{ fontSize:'0.8rem', minWidth:'50px' }}>좋아요</span>
          <input value={likeMsg} onChange={e=>setLikeMsg(e.target.value)} style={{ flex:1, padding:'0.35rem', borderRadius:'4px', border:'1px solid #334155', background:'#0f172a', color:'#fff', fontSize:'0.75rem' }} />
        </div>
        <div style={{ fontSize:'0.7rem', color:'#475569' }}>※ {'{닉네임}'} 을 입력하면 자동으로 닉네임으로 바뀌어요</div>
      </div>

      <div style={{ display:'flex', gap:'0.5rem' }}>
        <button onClick={connect} disabled={connected} style={{ flex:1, padding:'0.5rem', borderRadius:'6px', border:'none', background:connected?'#334155':'#22c55e', color:'#fff', cursor:connected?'not-allowed':'pointer' }}>{connected?'✅ 연결됨':'🔌 연결'}</button>
        <button onClick={disconnect} disabled={!connected} style={{ flex:1, padding:'0.5rem', borderRadius:'6px', border:'none', background:!connected?'#334155':'#ef4444', color:'#fff', cursor:!connected?'not-allowed':'pointer' }}>⛔ 끊기</button>
        <button onClick={generateUrl} style={{ padding:'0.5rem 1rem', borderRadius:'6px', border:'none', background:'#7c3aed', color:'#fff', cursor:'pointer' }}>🔗 링크</button>
      </div>

      {shareUrl && (
        <div style={{ background:'#1e293b', borderRadius:'6px', padding:'0.5rem', display:'flex', flexDirection:'column', gap:'0.5rem' }}>
          <textarea readOnly value={shareUrl} style={{ width:'100%', background:'#0f172a', color:'#94a3b8', border:'none', fontSize:'0.65rem', resize:'none', height:'50px', borderRadius:'4px', padding:'0.25rem' }} />
          <button onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => addLog('system', '시스템', '복사됐어요!'))} style={{ padding:'0.25rem', borderRadius:'4px', border:'none', background:'#3b82f6', color:'#fff', cursor:'pointer', fontSize:'0.75rem' }}>📋 복사</button>
        </div>
      )}

      <div style={{ flex:1, overflowY:'auto', background:'#1e293b', borderRadius:'8px', padding:'0.75rem', display:'flex', flexDirection:'column', gap:'0.25rem' }}>
        {logs.map((log, i) => (
          <div key={i} style={{ fontSize:'0.85rem', color:colorMap[log.type]||'#fff' }}>
            <span style={{ opacity:0.6 }}>[{log.author}]</span> {log.text}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>

      <div style={{ display:'flex', gap:'0.5rem' }}>
        <input placeholder="채팅 입력..." value={message} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sendChat()} style={{ flex:1, padding:'0.5rem', borderRadius:'6px', border:'1px solid #334155', background:'#1e293b', color:'#fff' }} />
        <button onClick={sendChat} style={{ padding:'0.5rem 1rem', borderRadius:'6px', border:'none', background:'#3b82f6', color:'#fff', cursor:'pointer' }}>전송</button>
      </div>
    </div>
  )
}
