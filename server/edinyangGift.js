// edinyangGift.js — 🔗 [에디냥(공식 API) 연동] 선물 정보 그대로 넘겨주기
// 공식 API 선물 이벤트엔 스티커·콤보·프로필 사진이 없어서, 에디냥 서버가 "선물카드 갤러리"를 켠 DJ 방송에 대해
// 여기에 몇 초마다 물어봐요 (GET /internal/edinyang/gifts). 물어보는 동안에는 이 서버가 그 방에 같이 들어가서
// 선물 이벤트를 그대로 모아두고, 에디냥 서버가 가져가요. 1분 30초 넘게 안 물어보면 방에서 나와요.
//  · 들어가는 계정: 환경변수 EDINYANG_GIFT_ACCOUNT (기본 sum1004) — 이 서버에 가입하고 세션 연결해둔 계정
//  · 한 계정이 동시에 들어갈 수 있는 방 수: EDINYANG_GIFT_CAPACITY (기본 18)
//  · 이 서버 봇(짜잔에디봇)이 이미 그 방에 들어가 있으면 따로 안 들어가고 그 방 선물을 그대로 써요
'use strict'

module.exports = function createEdinyangGift({ app, tokenManager, WebSocket, getRooms, findLiveIdForEdinyang, fetchLiveInfo, getCachedUserTag, findStickerImage, findStickerAnim, getWsProxyForDj, CHROME_UA, SHARED_TOKEN_DJID }) {
  const ACCOUNT = process.env.EDINYANG_GIFT_ACCOUNT || 'sum1004'
  const CAP = Number(process.env.EDINYANG_GIFT_CAPACITY || 18)
  const IDLE_MS = 90 * 1000 // 이만큼 안 물어보면 방에서 나와요
  const LIVE_CHECK_MS = 60 * 1000 // 방송이 바뀌었는지(껐다 켰는지) 확인 간격
  const watchers = new Map() // dj -> watcher
  const stats = { gifts: 0, joins: 0, errors: 0, lastError: '' }

  const token = () => tokenManager.getAccessToken(ACCOUNT) || tokenManager.getAccessToken(SHARED_TOKEN_DJID) || ''
  const ownCount = () => [...watchers.values()].filter(w => w.ws).length
  const sharedRoom = (liveId) => {
    const rooms = getRooms()
    for (const k of Object.keys(rooms)) { const r = rooms[k]; if (r && r.isConnected && r.ws && String(r.liveId) === String(liveId)) return r }
    return null
  }

  function closeWs(w) {
    if (w.pingTimer) { clearInterval(w.pingTimer); w.pingTimer = null }
    if (w.ws) { const ws = w.ws; w.ws = null; try { ws.terminate() } catch (e) {} }
    w.connected = false
  }

  // 선물 이벤트 → 넘겨줄 모양
  async function addGift(w, p) {
    const gen = p.generator || {}
    const nick = gen.nickname || p.nickname || '?'
    const userId = gen.id != null ? Number(gen.id) : (p.userId != null ? Number(p.userId) : (p.user_id != null ? Number(p.user_id) : null))
    const amount = Number(p.amount || p.spoonCount || p.spoon_count || p.quantity || p.value || 0)
    const combo = Math.max(1, Number(p.comboCount || p.combo_count || p.combo || 1))
    const sticker = p.sticker || p.stickerName || p.sticker_name || p.name || ''
    const profileUrl = gen.profileUrl || p.profileUrl || p.profile_url || ''
    const seq = ++w.seq
    const g = { seq, at: Date.now(), nick, amount, combo, total: amount * combo, sticker, stickerImage: '', lottieUrl: '', profileUrl, tag: '', djPhoto: w.djPhoto || '', ready: false }
    w.gifts.push(g)
    if (w.gifts.length > 200) w.gifts.splice(0, w.gifts.length - 200)
    stats.gifts++
    // 고유닉·스티커 이미지는 조금 늦게 채워져도 돼요 (에디냥 서버는 몇 초 뒤에 가져가요)
    try { if (sticker) { g.stickerImage = await findStickerImage(sticker); g.lottieUrl = (await findStickerAnim(sticker)).lottieUrl || '' } } catch (e) {}
    try { g.tag = (await getCachedUserTag(w, w.liveId, userId, token())) || '' } catch (e) {}
    g.ready = true
  }

  async function connect(w) {
    const liveId = w.liveId
    w.busy = true
    try {
      if (!tokenManager.hasCookies(ACCOUNT) || !tokenManager.getAccessToken(ACCOUNT)) throw new Error(`${ACCOUNT} 계정 세션이 없어요 (이 서버에 ${ACCOUNT} 로 가입하고 세션 연결해주세요)`)
      if (ownCount() >= CAP) throw new Error(`${ACCOUNT} 계정이 들어갈 수 있는 방(${CAP}개)이 꽉 찼어요`)
      const roomToken = await tokenManager.fetchRoomToken(ACCOUNT, liveId)
      if (w.liveId !== liveId || !watchers.has(w.dj)) return
      const info = await fetchLiveInfo(liveId, tokenManager.getAccessToken(ACCOUNT))
      if (info.djProfileUrl) w.djPhoto = info.djProfileUrl
      const proxy = getWsProxyForDj(ACCOUNT)
      const ws = new WebSocket(`wss://kr-wala.spooncast.net/ws?token=${tokenManager.getAccessToken(ACCOUNT)}`, {
        agent: proxy ? proxy.wsAgent : undefined,
        headers: { 'Origin': 'https://www.spooncast.net', 'User-Agent': CHROME_UA, 'Cache-Control': 'no-cache' },
      })
      w.ws = ws
      ws.on('open', () => {
        w.connected = true
        w.tries = 0
        w.error = ''
        stats.joins++
        console.log(`[에디냥 선물 연동] ${w.dj} 방(${liveId}) 들어감 — ${ACCOUNT}`)
        ws.send(JSON.stringify({ command: 'ACTIVATE_CHANNEL', payload: { channelId: info.streamName, liveToken: roomToken || '' } }))
      })
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data)
          if (msg.command !== 'MESSAGE') return
          const body = JSON.parse((msg.payload && msg.payload.body) || '{}')
          const ev = body.eventName
          if (ev === 'LiveDonation' || ev === 'live_present' || ev === 'DonationMessage') addGift(w, body.eventPayload || {}).catch(() => {})
        } catch (e) {}
      })
      ws.on('unexpected-response', (req, res) => { w.error = `스푼이 접속을 거절했어요 (status ${res.statusCode})`; stats.errors++; stats.lastError = w.error; try { ws.terminate() } catch (e) {} })
      ws.on('error', () => {})
      ws.on('close', () => {
        if (w.ws !== ws) return
        closeWs(w)
        w.tries = (w.tries || 0) + 1
        w.retryAt = Date.now() + Math.min(5000 * Math.pow(2, w.tries - 1), 60000)
      })
      w.pingTimer = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.ping() } catch (e) {} }, 30000)
    } catch (e) {
      w.error = e.message
      stats.errors++; stats.lastError = e.message
      w.tries = (w.tries || 0) + 1
      w.retryAt = Date.now() + Math.min(15000 * Math.pow(2, w.tries - 1), 5 * 60000)
    } finally { w.busy = false }
  }

  // 방송 확인 → (짜잔에디봇이 이미 있으면 그걸 쓰고) 아니면 직접 들어가기
  async function ensure(w) {
    if (w.busy) return
    const now = Date.now()
    if (!w.liveId || now - w.liveAt > LIVE_CHECK_MS) {
      w.busy = true
      let found = null
      try { found = await findLiveIdForEdinyang(w.dj, w.nick) } catch (e) {}
      w.busy = false
      w.liveAt = Date.now()
      const liveId = found && found.liveId ? String(found.liveId) : ''
      if (found && found.djPhoto) w.djPhoto = found.djPhoto
      if (liveId !== w.liveId) { closeWs(w); w.liveId = liveId; w.tries = 0; w.retryAt = 0; if (w.tagCache) w.tagCache.clear() }
    }
    if (!w.liveId) return
    w.shared = !!sharedRoom(w.liveId)
    if (w.shared) { if (w.ws) closeWs(w); return } // 짜잔에디봇이 그 방에 있어요 → 그 선물을 받아요 (onRoomGift)
    if (!w.ws && now >= (w.retryAt || 0)) connect(w).catch(() => {})
  }

  // 짜잔에디봇이 들어가 있는 방의 선물 (index.js 선물 처리에서 불러요)
  function onRoomGift(liveId, payload) {
    for (const w of watchers.values()) if (w.shared && String(w.liveId) === String(liveId)) addGift(w, payload).catch(() => {})
  }

  // 고유닉 찾는 중인 선물이 있으면 그 앞까지만 줘요 (순서대로 가져가게 · 20초 넘게 걸리면 그냥 줘요)
  function readyGifts(w, since) {
    const out = []
    for (const g of w.gifts) {
      if (g.seq <= since) continue
      if (!g.ready && Date.now() - g.at < 20000) break
      const { ready, ...rest } = g
      out.push(rest)
    }
    return out
  }

  app.get('/internal/edinyang/gifts', (req, res) => {
    const key = process.env.EDINYANG_LINK_KEY || ''
    if (!key || req.get('x-link-key') !== key) return res.status(403).json({ success: false, error: 'forbidden' })
    const dj = String(req.query.dj || '').replace('@', '').trim().slice(0, 40)
    const nick = String(req.query.nick || '').trim().slice(0, 60)
    if (!dj && !nick) return res.status(400).json({ success: false, error: 'dj 가 필요해요' })
    const since = Number(req.query.since) || 0
    let w = watchers.get(dj || nick)
    if (!w) {
      w = { dj: dj || nick, nick, liveId: '', liveAt: 0, ws: null, connected: false, shared: false, busy: false, gifts: [], seq: Date.now(), tagCache: new Map(), tagToNickname: new Map(), djPhoto: '', error: '', tries: 0, retryAt: 0 }
      watchers.set(w.dj, w)
    }
    if (nick) w.nick = nick
    w.lastPoll = Date.now()
    ensure(w).catch(() => {})
    res.json({
      success: true, account: ACCOUNT, live: !!w.liveId, liveId: w.liveId,
      connected: !!(w.liveId && (w.connected || w.shared)), via: w.shared ? 'room' : 'own', error: w.error || '',
      djPhoto: w.djPhoto || '', seq: w.seq,
      // since 가 0 이면 처음 묻는 거라 예전 선물은 안 줘요 (지금 번호만 알려줘요)
      gifts: since ? readyGifts(w, since) : [],
    })
  })

  // 안 물어보는 방은 나오기
  setInterval(() => {
    const now = Date.now()
    for (const [k, w] of watchers) if (now - (w.lastPoll || 0) > IDLE_MS) { closeWs(w); watchers.delete(k); console.log(`[에디냥 선물 연동] ${k} 방에서 나옴 (에디냥 서버가 안 물어봐요)`) }
  }, 30000).unref()

  return { onRoomGift, stats: () => ({ ...stats, account: ACCOUNT, watching: watchers.size, own: ownCount() }) }
}
