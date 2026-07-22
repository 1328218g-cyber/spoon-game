'use client'
import { useState, useEffect, useRef } from 'react'

type Log = { type: string; author: string; text: string }
type AutoMsg = { id: number; enabled: boolean; target: string; text: string }
type Command = { id: number; trigger: string; response: string }

export default function Home() {
  const [accessToken, setAccessToken] = useState('')
  const [roomToken, setRoomToken] = useState('')
  const [channelId, setChannelId] = useState('')
  const [connected, setConnected] = useState(false)
  const [activeMenu, setActiveMenu] = useState('dashboard')
  const [activeTab, setActiveTab] = useState('join')
  const [logs, setLogs] = useState<Log[]>([])
  const [message, setMessage] = useState('')
  const [shareUrl, setShareUrl] = useState('')

  const [joinMsgs, setJoinMsgs] = useState<AutoMsg[]>([{ id: 1, enabled: true, target: '', text: '{nickname}님 환영합니다! 👋' }])
  const [likeMsgs, setLikeMsgs] = useState<AutoMsg[]>([{ id: 1, enabled: true, target: '', text: '{nickname}님 좋아요 감사해요! ❤️' }])
  const [joinEnabled, setJoinEnabled] = useState(true)
  const [likeEnabled, setLikeEnabled] = useState(true)
  const [commands, setCommands] = useState<Command[]>([{ id: 1, trigger: '!방가', response: '반가워요! 어서오세요~' }])

  const wsRef = useRef<WebSocket | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const joinMsgsRef = useRef(joinMsgs)
  const likeMsgsRef = useRef(likeMsgs)
  const joinEnabledRef = useRef(joinEnabled)
  const likeEnabledRef = useRef(likeEnabled)
  const commandsRef = useRef(commands)

  useEffect(() => { joinMsgsRef.current = joinMsgs }, [joinMsgs])
  useEffect(() => { likeMsgsRef.current = likeMsgs }, [likeMsgs])
  useEffect(() => { joinEnabledRef.current = joinEnabled }, [joinEnabled])
  useEffect(() => { likeEnabledRef.current = likeEnabled }, [likeEnabled])
  useEffect(() => { commandsRef.current = commands }, [commands])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const a = params.get('a') || localStorage.getItem('spoon_access') || ''
    const r = params.get('r') || localStorage.getItem('spoon_room') || ''
    const c = params.get('c') || localStorage.getItem('spoon_channel') || ''
    if (a) setAccessToken(a)
    if (r) setRoomToken(r)
    if (c) setChannelId(c)
  }, [])

  useEffect(() => { if (accessToken) localStorage.setItem('spoon_access', accessToken) }, [accessToken])
  useEffect(() => { if (roomToken) localStorage.setItem('spoon_room', roomToken) }, [roomToken])
  useEffect(() => { if (channelId) localStorage.setItem('spoon_channel', channelId) }, [channelId])
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  const addLog = (type: string, author: string, text: string) =>
    setLogs(prev => [...prev.slice(-200), { type, author, text }])

  const sendChatMsg = async (text: string) => {
    await fetch('/api/spoon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: channelId.trim(), message: text, accessToken, roomToken })
    })
  }

  const connect = () => {
    if (!accessToken || !roomToken || !channelId) { addLog('error', '시스템', '토큰과 채널ID를 입력하세요!'); return }
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
          const txt = (eventPayload.message || '').trim().toLowerCase()
          for (const cmd of commandsRef.current) {
            if (txt === cmd.trigger.toLowerCase()) {
              setTimeout(() => sendChatMsg(cmd.response), 500)
              addLog('bot', '🤖봇', cmd.response)
              break
            }
          }
        } else if (eventName === 'RoomJoin') {
          const author = eventPayload.generator?.nickname || eventPayload.nickname || '?'
          addLog('join', author, '입장했습니다 👋')
          if (joinEnabledRef.current) {
            const msgs = joinMsgsRef.current.filter(m => m.enabled && (!m.target || m.target === author))
            if (msgs.length > 0) {
              const text = msgs[0].text.replace(/{nickname}/g, author)
              setTimeout(() => sendChatMsg(text), 500)
              addLog('bot', '🤖봇', text)
            }
          }
        } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
          const author = eventPayload.nickname || eventPayload.generator?.nickname || '?'
          addLog('like', '❤️', `${author}님 좋아요`)
          if (likeEnabledRef.current) {
            const msgs = likeMsgsRef.current.filter(m => m.enabled)
            if (msgs.length > 0) {
              const text = msgs[0].text.replace(/{nickname}/g, author)
              setTimeout(() => sendChatMsg(text), 500)
              addLog('bot', '🤖봇', text)
            }
          }
        }
      } catch {}
    }
    ws.onerror = () => addLog('error', '오류', '연결 오류')
    ws.onclose = () => { setConnected(false); addLog('system', '시스템', '연결 종료') }
  }

  const disconnect = () => { wsRef.current?.close(); setConnected(false) }

  const sendChat = async () => {
    if (!message.trim()) return
    await sendChatMsg(message)
    addLog('bot', '봇', message)
    setMessage('')
  }

  const generateUrl = () => {
    const url = `https://spoon-game-tan.vercel.app?a=${encodeURIComponent(accessToken)}&r=${encodeURIComponent(roomToken)}&c=${encodeURIComponent(channelId.trim())}`
    setShareUrl(url)
    navigator.clipboard?.writeText(url)
  }

  const colorMap: Record<string, string> = { chat: '#1f2937', join: '#065f46', like: '#7f1d1d', error: '#7f1d1d', system: '#374151', bot: '#1e3a5f' }
  const textColorMap: Record<string, string> = { chat: '#111827', join: '#065f46', like: '#dc2626', error: '#dc2626', system: '#6b7280', bot: '#2563eb' }

  const menuItems = [
    { id: 'dashboard', icon: '🏠', label: '대시보드', toggle: null },
    { id: 'join', icon: '📋', label: '입장 설정', toggle: joinEnabled, onToggle: setJoinEnabled },
    { id: 'commands', icon: '⌨️', label: '단축키 명령어', toggle: null },
    { id: 'settings', icon: '⚙️', label: '연결 설정', toggle: null },
  ]

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', background: '#f3f4f6' }}>
      {/* 사이드바 */}
      <div style={{ width: '200px', background: '#fff', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', padding: '0.5rem 0' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.2rem' }}>🎙️</span>
          <span style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>스푼 웹봇</span>
        </div>
        <div style={{ padding: '0.5rem 0' }}>
          {menuItems.map(item => (
            <div key={item.id} onClick={() => setActiveMenu(item.id)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 1rem', cursor: 'pointer', background: activeMenu === item.id ? '#7c3aed' : 'transparent', color: activeMenu === item.id ? '#fff' : '#374151', borderRadius: '0.25rem', margin: '0.1rem 0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>{item.icon}</span>
                <span style={{ fontSize: '0.85rem', fontWeight: '500' }}>{item.label}</span>
              </div>
              {item.toggle !== null && (
                <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: '9999px', background: item.toggle ? '#22c55e' : '#9ca3af', color: '#fff', fontWeight: 'bold' }}>
                  {item.toggle ? 'ON' : 'OFF'}
                </span>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: connected ? '#22c55e' : '#ef4444' }} />
            <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{connected ? '연결됨' : '미연결'}</span>
          </div>
          <button onClick={connected ? disconnect : connect}
            style={{ width: '100%', padding: '0.4rem', borderRadius: '6px', border: 'none', background: connected ? '#ef4444' : '#22c55e', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>
            {connected ? '⛔ 연결 끊기' : '🔌 연결'}
          </button>
        </div>
      </div>

      {/* 메인 컨텐츠 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* 대시보드 */}
        {activeMenu === 'dashboard' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1rem', gap: '0.75rem', overflow: 'hidden' }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#111827' }}>🏠 대시보드</h2>
            <div style={{ flex: 1, overflowY: 'auto', background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {logs.length === 0 && <div style={{ color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center', marginTop: '2rem' }}>연결 후 채팅이 여기에 표시됩니다</div>}
              {logs.map((log, i) => (
                <div key={i} style={{ fontSize: '0.85rem', padding: '0.2rem 0.4rem', borderRadius: '4px', background: colorMap[log.type] + '20' || '#f9fafb' }}>
                  <span style={{ fontWeight: 'bold', color: textColorMap[log.type] || '#374151' }}>[{log.author}]</span>{' '}
                  <span style={{ color: '#374151' }}>{log.text}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input placeholder="채팅 입력..." value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendChat()}
                style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '0.9rem' }} />
              <button onClick={sendChat} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer' }}>전송</button>
            </div>
          </div>
        )}

        {/* 입장 설정 */}
        {activeMenu === 'join' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>📋 입장 및 자동 메시지 설정</h2>
              <button onClick={() => {
                const newMsg = { id: Date.now(), enabled: true, target: '', text: '{nickname}님 환영합니다!' }
                if (activeTab === 'join') setJoinMsgs(prev => [...prev, newMsg])
                else setLikeMsgs(prev => [...prev, newMsg])
              }} style={{ padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>+ 추가</button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              {[['join', '👋 입장'], ['like', '❤️ 좋아요']].map(([id, label]) => (
                <button key={id} onClick={() => setActiveTab(id)}
                  style={{ padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', background: activeTab === id ? '#7c3aed' : '#e5e7eb', color: activeTab === id ? '#fff' : '#374151', cursor: 'pointer', fontSize: '0.85rem' }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.85rem', color: '#374151' }}>자동 멘트</span>
              <div onClick={() => activeTab === 'join' ? setJoinEnabled(!joinEnabled) : setLikeEnabled(!likeEnabled)}
                style={{ width: '44px', height: '24px', borderRadius: '12px', background: (activeTab === 'join' ? joinEnabled : likeEnabled) ? '#7c3aed' : '#d1d5db', cursor: 'pointer', position: 'relative', transition: 'background 0.2s' }}>
                <div style={{ position: 'absolute', top: '2px', left: (activeTab === 'join' ? joinEnabled : likeEnabled) ? '22px' : '2px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
              </div>
            </div>
            {(activeTab === 'join' ? joinMsgs : likeMsgs).map((msg, idx) => (
              <div key={msg.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <input placeholder="특정 닉네임 (비우면 전체)" value={msg.target}
                    onChange={e => {
                      const update = (msgs: AutoMsg[]) => msgs.map((m, i) => i === idx ? { ...m, target: e.target.value } : m)
                      activeTab === 'join' ? setJoinMsgs(update) : setLikeMsgs(update)
                    }}
                    style={{ flex: 1, padding: '0.35rem', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '0.8rem' }} />
                  <button onClick={() => {
                    activeTab === 'join' ? setJoinMsgs(prev => prev.filter((_, i) => i !== idx)) : setLikeMsgs(prev => prev.filter((_, i) => i !== idx))
                  }} style={{ padding: '0.35rem 0.75rem', borderRadius: '4px', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>삭제</button>
                </div>
                <input placeholder="{nickname}님 환영합니다!" value={msg.text}
                  onChange={e => {
                    const update = (msgs: AutoMsg[]) => msgs.map((m, i) => i === idx ? { ...m, text: e.target.value } : m)
                    activeTab === 'join' ? setJoinMsgs(update) : setLikeMsgs(update)
                  }}
                  style={{ width: '100%', padding: '0.35rem', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '0.85rem', boxSizing: 'border-box' }} />
                <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginTop: '0.25rem' }}>변수: {'{nickname}'}</div>
              </div>
            ))}
          </div>
        )}

        {/* 명령어 */}
        {activeMenu === 'commands' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>⌨️ 단축키 명령어</h2>
              <button onClick={() => setCommands(prev => [...prev, { id: Date.now(), trigger: '!명령어', response: '응답 내용' }])}
                style={{ padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>+ 추가</button>
            </div>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>채팅창에서 명령어를 입력하면 자동으로 응답합니다.</p>
            {commands.map((cmd, idx) => (
              <div key={cmd.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem', marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ padding: '0.35rem 0.75rem', borderRadius: '6px', background: '#7c3aed', color: '#fff', fontSize: '0.85rem', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{cmd.trigger}</span>
                <input placeholder="트리거 (예: !방가)" value={cmd.trigger}
                  onChange={e => setCommands(prev => prev.map((c, i) => i === idx ? { ...c, trigger: e.target.value } : c))}
                  style={{ width: '120px', padding: '0.35rem', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '0.8rem' }} />
                <input placeholder="응답 내용" value={cmd.response}
                  onChange={e => setCommands(prev => prev.map((c, i) => i === idx ? { ...c, response: e.target.value } : c))}
                  style={{ flex: 1, padding: '0.35rem', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '0.8rem' }} />
                <button onClick={() => setCommands(prev => prev.filter((_, i) => i !== idx))}
                  style={{ padding: '0.35rem 0.75rem', borderRadius: '4px', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>삭제</button>
              </div>
            ))}
          </div>
        )}

        {/* 연결 설정 */}
        {activeMenu === 'settings' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem', marginBottom: '1rem' }}>⚙️ 연결 설정</h2>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label style={{ fontSize: '0.85rem', color: '#374151', display: 'block', marginBottom: '0.25rem' }}>Access Token</label>
                <input value={accessToken} onChange={e => setAccessToken(e.target.value)} placeholder="스푼 Access Token"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '0.8rem', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.85rem', color: '#374151', display: 'block', marginBottom: '0.25rem' }}>Room Token</label>
                <input value={roomToken} onChange={e => setRoomToken(e.target.value)} placeholder="스푼 Room Token"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '0.8rem', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.85rem', color: '#374151', display: 'block', marginBottom: '0.25rem' }}>Channel ID</label>
                <input value={channelId} onChange={e => setChannelId(e.target.value)} placeholder="예: rz3QHUQT"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '0.8rem', boxSizing: 'border-box' }} />
              </div>
              <button onClick={generateUrl} style={{ padding: '0.5rem', borderRadius: '6px', border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>🔗 공유 링크 생성</button>
              {shareUrl && (
                <div style={{ background: '#f9fafb', borderRadius: '6px', padding: '0.5rem' }}>
                  <div style={{ fontSize: '0.7rem', color: '#6b7280', wordBreak: 'break-all' }}>{shareUrl}</div>
                  <div style={{ fontSize: '0.75rem', color: '#7c3aed', marginTop: '0.25rem' }}>✅ 클립보드에 복사됐어요!</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
