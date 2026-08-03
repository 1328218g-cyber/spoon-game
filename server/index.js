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

// 🔑 구글 보이스(TTS) API 키 — Railway 환경변수(Variables)에 GOOGLE_TTS_API_KEY로 등록해서 사용한다.
// 절대 프론트엔드(index.html) 코드에 직접 넣지 않는다 — 브라우저 소스보기로 그대로 노출되기 때문.
// 이 키는 서버가 구글 API를 대신 호출할 때만 쓰이고, 클라이언트에는 절대 전달되지 않는다.
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || ''

// 디제이별 방(연결) 상태. djId -> { ws, isConnected, streamName, roomToken, autoJoinedFor, checking }
const rooms = {}
function getRoom(djId) {
  if (!rooms[djId]) {
    rooms[djId] = { ws: null, isConnected: false, streamName: '', roomToken: '', autoJoinedFor: '', watchingTag: '', checking: false, liveDjUserId: null, tagCache: new Map(), tagToNickname: new Map(), profileUrlCache: new Map() }
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
      photoUrl: match.profile_url || match.profileUrl || match.image_url || match.imageUrl || match.thumbnail_url || '',
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

// 채팅/좋아요/선물 이벤트에서 실제로 확인된 프로필 사진 URL을, 태그와 닉네임 양쪽 키로 캐싱해둔다.
// (실시간 접속자 API는 프로필 사진을 안 줄 수 있어서, 이미 채팅에서 검증된 이 캐시를 우선 사용한다)
function rememberProfileUrl(room, tag, nickname, imgUrl) {
  if (!room || !imgUrl) return
  if (!room.profileUrlCache) room.profileUrlCache = new Map()
  if (tag) room.profileUrlCache.set(String(tag).trim().toLowerCase(), imgUrl)
  if (nickname) room.profileUrlCache.set(String(nickname).trim().toLowerCase(), imgUrl)
}

function getCachedProfileUrl(room, tag, nickname) {
  if (!room || !room.profileUrlCache) return ''
  const byTag = tag ? room.profileUrlCache.get(String(tag).trim().toLowerCase()) : null
  if (byTag) return byTag
  const byNick = nickname ? room.profileUrlCache.get(String(nickname).trim().toLowerCase()) : null
  return byNick || ''
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
      const imgUrl = m.profile_url || m.profileUrl || m.image_url || m.imageUrl || m.thumbnail_url
        || (m.profile && (m.profile.url || m.profile.image_url)) || m.photo || ''
      return { tag, nickname: nickname || tag, imgUrl }
    }).filter(Boolean)
  } catch (e) {
    console.log('[fetchLiveMembers 오류]', e.message)
    return []
  }
}

// 지금 방송에 실제로 접속 중인 사람인지 태그 또는 닉네임으로 확인한다. (룰렛지급/복권지급/상점 등
// DJ가 직접 대상을 지정하는 명령어에서, 고유닉을 잘못 입력해도 조용히 지급되던 문제를 막기 위해 사용)
async function findLiveMemberByNickOrTag(liveId, input) {
  const norm = String(input || '').trim().toLowerCase()
  if (!norm) return null
  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const members = await fetchLiveMembers(liveId, accessToken, 5)
  return members.find(u => (u.tag && u.tag.toLowerCase() === norm) || (u.nickname && u.nickname.toLowerCase() === norm)) || null
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
const NEW_MODULE_DEFAULT_OFF_KEYS = ['lottoauto', 'reactiontimer', 'dday', 'raffle', 'dice', 'soundfx', 'tts', 'dashboard', 'wheelroulette', 'couponcheck', 'usernotes', 'discordnotify', 'fishing', 'stock', 'auction', 'randombox', 'swordgame', 'mynotes'] // 새로 추가하는 모듈은 여기에 키를 등록한다 (fishtournament는 아래 "요청 모듈" 접근 목록으로 관리되므로 이 목록에서 제외)
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

// ══════════════════════════════════════════════════════
// 🔐 요청 모듈 — 특정 유저만 접근 가능한 제한 메뉴.
// 일반 모듈 마켓(누구나 켜고 끌 수 있음)과 달리, 관리자(sum)가 항목별로 "허용 유저 목록"을
// 직접 관리한다. 목록에 없는 유저는 사이드바에서 아예 안 보이고, API도 막힌다.
// 항목은 관리자(sum) 계정의 settings.requestModules 배열에 저장된다:
//   { id, title, icon, targetPanel, allowedDjIds: [djId, ...] }
// targetPanel은 이미 존재하는 화면(panel)의 키를 그대로 재사용한다 (예: 'fishtournament').
// ══════════════════════════════════════════════════════
function isRequestModuleAllowed(targetPanel, djId) {
  if (djId === 'sum') return true // 관리자는 모든 요청 모듈에 항상 접근 가능
  const list = store.getRequestModules()
  return list.some(m => m.targetPanel === targetPanel && (m.allowedDjIds || []).includes(djId))
}
// 라우트에 붙이는 미들웨어 — auth.requireAuth 뒤에 이어서 사용한다.
function requireRequestModuleAccess(targetPanel) {
  return (req, res, next) => {
    if (!isRequestModuleAllowed(targetPanel, req.djId)) {
      return res.status(403).json({ success: false, error: '이 메뉴에 접근 권한이 없어요' })
    }
    next()
  }
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

  shield.count = (shield.count || 0) + delta
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
// actTag: 이 채팅 이벤트에서 이미 한 번 조회해둔 고유닉(있으면 재사용, API 중복 호출/실패 방지)
async function handleShortcutCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
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
    let tag = actTag
    if (!tag) tag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
    if (!tag) console.log(`[${djId}][단축키] '${cmd.trigger}' {tag} 조회 실패 → 닉네임(${author})으로 대체 출력`)
    // 태그 조회에 실패해도 빈 값으로 나가지 않도록 닉네임으로 대체
    response = response.replace(/{tag}/g, tag ? `@${tag}` : `@${author}`)
  }
  // 호스트(대시보드에 등록해둔 방송하는 DJ 본인) 정보 및 이달의 DJ 랭킹 변수
  if (/{host_nickname}|{host_tag}|{rank}|{choice_rank}|{like_rank}|{time_rank}/.test(response)) {
    const rv = buildDashboardRankVars(settings)
    response = response
      .replace(/{host_nickname}/g, rv.nickname)
      .replace(/{host_tag}/g, rv.tag ? `@${rv.tag}` : '')
      .replace(/{rank}/g, rv.rank)
      .replace(/{choice_rank}/g, rv.choice_rank)
      .replace(/{like_rank}/g, rv.like_rank)
      .replace(/{time_rank}/g, rv.time_rank)
  }

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
      cmdRecommend: '!추천곡',
      doneTemplate: '✅ [{artist} - {title}] 신청 완료! (대기: {count}번)',
      listTitle: '🎵 현재 신청곡 목록 🎵', listItemTemplate: '{index}. {artist} - {title}',
      maxCharsPerMsg: 100, msgIntervalMs: 600, items: []
    }
    // 최초 1회는 실제로 저장해서, 이후 /settings 조회(웹 화면)에서도 같은 값이 보이도록 한다.
    store.saveSettings(djId, { songRequest: settings.songRequest })
  }
  if (!settings.songRequest.cmdRecommend) settings.songRequest.cmdRecommend = '!추천곡'
  return settings.songRequest
}

// 🎵 멜론 차트에서 곡을 긁어와 캐싱해둔다 (TOP100/HOT100/DAILY100 랜덤 추천용).
// 멜론은 페이지 HTML 구조라 정규식으로 제목/가수를 뽑는다 — 멜론이 마크업을 바꾸면 깨질 수 있다.
let melonChartCache = { list: [], fetchedAt: 0 }
const MELON_CHART_URLS = [
  'https://www.melon.com/chart/index.htm',
  'https://www.melon.com/chart/hot100/index.htm',
  'https://www.melon.com/chart/day/index.htm?classCd=AB0000',
]
async function fetchMelonChartSongs() {
  if (melonChartCache.list.length && Date.now() - melonChartCache.fetchedAt < 30 * 60 * 1000) {
    return melonChartCache.list
  }
  const all = []
  for (const url of MELON_CHART_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': CHROME_UA,
          'Referer': 'https://www.melon.com/',
          'Accept': 'text/html',
        }
      })
      const html = await res.text()
      // <tr> 안의 곡명(rank01)/아티스트(rank02)를 순서대로 페어링해서 뽑는다.
      const titleMatches = [...html.matchAll(/class="ellipsis rank01"[\s\S]*?title="([^"]+)\s*"/g)].map(m => m[1].trim())
      const artistMatches = [...html.matchAll(/class="ellipsis rank02"[\s\S]*?title="([^"]+)"/g)].map(m => m[1].trim())
      const count = Math.min(titleMatches.length, artistMatches.length)
      for (let i = 0; i < count; i++) {
        if (titleMatches[i] && artistMatches[i]) all.push({ title: titleMatches[i], artist: artistMatches[i] })
      }
    } catch (e) {
      console.log('[멜론차트 조회 실패]', url, e.message)
    }
  }
  if (all.length) {
    melonChartCache = { list: all, fetchedAt: Date.now() }
  }
  return melonChartCache.list
}

function handleSongRequestCommand(djId, room, settings, author, authorId, text) {
  if (!isModuleOn(settings, 'request', djId)) return
  const sr = getSongRequestSettings(djId, settings)
  const msg = String(text || '').trim()
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  const save = () => store.saveSettings(djId, { songRequest: sr })
  const reqPrefix = sr.cmdRequest + ' '

  // !추천곡 — 멜론 차트(TOP100/HOT100/DAILY100)에서 랜덤 한 곡 추천
  if (sr.cmdRecommend && msg === sr.cmdRecommend) {
    fetchMelonChartSongs().then(list => {
      if (!list.length) { sendChatSplit(djId, '😥 지금 추천곡을 불러오지 못했어요. 잠시 후 다시 시도해주세요.', 150, 300); return }
      const pick = list[Math.floor(Math.random() * list.length)]
      sendChatSplit(djId, `🎧 오늘의 추천곡!\n${pick.artist} - ${pick.title}`, 150, 300)
    })
    return
  }

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
    act.users[key] = { nickname: nickname || key, tag: tag || null, heart: 0, chat: 0, attend: 0, lp: 0, lotto: 0, exp: 0, lastAttendTime: 0, imgUrl: '' }
  } else {
    if (nickname) act.users[key].nickname = nickname
    if (tag) act.users[key].tag = tag
  }
  return act.users[key]
}

// 채팅 수신 시 훅 (등록된 유저만 채팅 EXP 적립, 미등록 유저는 조용히 무시)
// tag가 있으면 그 태그를 키로 우선 사용한다 (로컬봇과 동일한 방식).
function handleActChatHook(djId, settings, author, tag, profileUrl) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const key = actResolveKey(act, author, tag)
  if (!key) return
  const d = act.users[key]
  d.nickname = author
  if (tag) d.tag = tag
  if (profileUrl) d.imgUrl = profileUrl
  d.chat = (d.chat || 0) + 1
  actGrantExp(djId, act, key, Number(act.scoreChat) || 2)
  store.saveSettings(djId, { activity: act })
}

// 무료 좋아요 수신 시 훅
function handleActHeartHook(djId, settings, author, tag, profileUrl) {
  if (!isModuleOn(settings, 'loyalty', djId)) return
  const act = getActivitySettings(djId, settings)
  if (act.enabled === false) return
  const key = actResolveKey(act, author, tag)
  if (!key) return
  const d = act.users[key]
  d.nickname = author
  if (tag) d.tag = tag
  if (profileUrl) d.imgUrl = profileUrl
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
async function handleActivityCommand(djId, room, settings, author, authorId, text, tag, liveId) {
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
    const existingKey = findActUserKey(act, targetNick)
    // 기록이 없는 유저는 !룰렛지급과 동일하게 자동으로 등록하고 지급하되, 고유닉을 잘못 입력해도
    // 조용히 새 유저가 생기는 걸 막기 위해 지금 방송에 실제로 있는 사람인지 먼저 확인한다.
    if (!existingKey) {
      const found = await findLiveMemberByNickOrTag(liveId, targetNick)
      if (!found) {
        setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetNick}' 님을 지금 방송에서 찾을 수 없어요. 닉네임/고유닉을 다시 확인해주세요.`), 400)
        return
      }
    }
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
    const existingKey = findActUserKey(act, targetNick)
    // 기록이 없는 유저는 자동으로 등록하고 지급하되, 지금 방송에 실제로 있는 사람인지 먼저 확인한다.
    if (!existingKey) {
      const found = await findLiveMemberByNickOrTag(liveId, targetNick)
      if (!found) {
        setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetNick}' 님을 지금 방송에서 찾을 수 없어요. 닉네임/고유닉을 다시 확인해주세요.`), 400)
        return
      }
    }
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
// ⏰ 리액션 타이머 — "[명령어] [분] [내용]"으로 등록하면 그 시간 후에 채팅으로 알려준다.
// 등록된 타이머 목록은 명령어만 입력하면 확인할 수 있다. (누구나 등록 가능, 방 재접속 시 초기화됨)

function getReminderSettings(djId, settings) {
  if (!settings.reminderTimer) {
    settings.reminderTimer = {
      cmd: '!리액션',
      registerMsg: '⏰ {min}분 후 알림: {content}',
      alertMsg: '🔔 {content} 시간이 됐습니다!',
    }
    store.saveSettings(djId, { reminderTimer: settings.reminderTimer })
  }
  return settings.reminderTimer
}

function clearReminderTimers(room) {
  if (!room.reminderTimers) return
  room.reminderTimers.forEach(t => { if (t.handle) clearTimeout(t.handle) })
  room.reminderTimers = []
}

function handleReminderCommand(djId, room, settings, author, text) {
  if (!isModuleOn(settings, 'reactiontimer', djId)) return
  const cfg = getReminderSettings(djId, settings)
  const msg = String(text || '').trim()
  const cmd = cfg.cmd || '!리액션'
  if (!room.reminderTimers) room.reminderTimers = []

  if (msg === cmd) {
    if (!room.reminderTimers.length) { setTimeout(() => sendChatToRoom(djId, '⏰ 등록된 리액션 타이머가 없어요.'), 400); return }
    const lines = room.reminderTimers.map((t, i) => {
      const remainMin = Math.max(0, Math.ceil((t.dueAt - Date.now()) / 60000))
      return `${i + 1}. ${t.content} (약 ${remainMin}분 후, 등록: ${t.author})`
    })
    sendChatSplit(djId, ['⏰ 등록된 리액션 타이머'].concat(lines).join('\n'), 150, 600)
    return
  }
  if (msg.startsWith(cmd + ' ')) {
    const rest = msg.slice(cmd.length).trim()
    const m = rest.match(/^(\d+)\s+(.+)$/)
    if (!m) { setTimeout(() => sendChatToRoom(djId, `⏰ 사용법: ${cmd} [분] [내용]`), 400); return }
    const min = Math.max(1, Math.min(1440, parseInt(m[1], 10)))
    const content = m[2].trim()
    if (!content) return
    if (room.reminderTimers.length >= 20) { setTimeout(() => sendChatToRoom(djId, '⏰ 등록 가능한 타이머는 최대 20개예요.'), 400); return }
    const id = 'rt' + Date.now() + Math.floor(Math.random() * 1000)
    const dueAt = Date.now() + min * 60000
    const handle = setTimeout(() => {
      const idx = room.reminderTimers.findIndex(t => t.id === id)
      if (idx >= 0) room.reminderTimers.splice(idx, 1)
      const alertText = (cfg.alertMsg || '🔔 {content} 시간이 됐습니다!').replace(/\{content\}/g, content)
      sendChatToRoom(djId, alertText)
    }, min * 60000)
    room.reminderTimers.push({ id, content, author, dueAt, handle })
    const regText = (cfg.registerMsg || '⏰ {min}분 후 알림: {content}').replace(/\{min\}/g, min).replace(/\{content\}/g, content)
    setTimeout(() => sendChatToRoom(djId, regText), 400)
    return
  }
}

// ══════════════════════════════════════════════════════
// 📅 디데이 — "[명령어] [MM-DD] [내용]"으로 등록(DJ 전용)하면, 명령어만 입력했을 때
// 등록된 디데이 목록과 남은/지난 일수를 보여준다. 매년 반복되는 날짜로 계산한다.

// 📝 나만의 메모장 — DJ 본인이 필요할 때마다 자유롭게 새 메모를 만들어서 내용을 적어두는 개인 메모장.
// (시청자별로 남기는 "usernotes"와는 완전히 별개 — 이건 그냥 DJ 혼자 쓰는 자유 메모)
function getMyNotesSettings(djId, settings) {
  if (!settings.myNotes) {
    settings.myNotes = { items: [] }
    store.saveSettings(djId, { myNotes: settings.myNotes })
  }
  if (!settings.myNotes.items) settings.myNotes.items = []
  return settings.myNotes
}

function getDdaySettings(djId, settings) {
  if (!settings.dday) {
    settings.dday = { cmd: '!디데이', registerMsg: '📅 디데이 등록: {content} ({date})', items: [] }
    store.saveSettings(djId, { dday: settings.dday })
  }
  if (!settings.dday.items) settings.dday.items = []
  return settings.dday
}

function calcNextDdayDiff(mmdd) {
  const m = String(mmdd || '').match(/^(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10)
  const now = new Date()
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let target = new Date(now.getFullYear(), month - 1, day)
  if (target < today0) target = new Date(now.getFullYear() + 1, month - 1, day)
  return Math.round((target - today0) / 86400000)
}

function handleDdayCommand(djId, room, settings, author, authorId, text) {
  if (!isModuleOn(settings, 'dday', djId)) return
  const cfg = getDdaySettings(djId, settings)
  const msg = String(text || '').trim()
  const cmd = cfg.cmd || '!디데이'
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  if (msg === cmd) {
    if (!cfg.items.length) { setTimeout(() => sendChatToRoom(djId, '📅 등록된 디데이가 없어요.'), 400); return }
    const lines = cfg.items.map((it, i) => {
      const d = calcNextDdayDiff(it.date)
      const label = d === 0 ? 'D-Day' : (d > 0 ? `D-${d}` : `D+${Math.abs(d)}`)
      return `${i + 1}. ${it.content} (${it.date}) — ${label}`
    })
    sendChatSplit(djId, ['📅 등록된 디데이 목록'].concat(lines).join('\n'), 150, 600)
    return
  }
  if (msg.startsWith(cmd + ' ')) {
    if (!isDj) { setTimeout(() => sendChatToRoom(djId, '❌ 디데이 등록은 DJ만 할 수 있습니다.'), 400); return }
    const rest = msg.slice(cmd.length).trim()
    const m = rest.match(/^(\d{1,2}-\d{1,2})\s+(.+)$/)
    if (!m || calcNextDdayDiff(m[1]) === null) { setTimeout(() => sendChatToRoom(djId, `📅 사용법: ${cmd} [MM-DD] [내용] (예: ${cmd} 12-25 크리스마스)`), 400); return }
    const date = m[1]
    const content = m[2].trim()
    if (cfg.items.length >= 30) { setTimeout(() => sendChatToRoom(djId, '📅 등록 가능한 디데이는 최대 30개예요.'), 400); return }
    cfg.items.push({ id: 'dd' + Date.now() + Math.floor(Math.random() * 1000), date, content })
    store.saveSettings(djId, { dday: cfg })
    const regText = (cfg.registerMsg || '📅 디데이 등록: {content} ({date})').replace(/\{content\}/g, content).replace(/\{date\}/g, date)
    setTimeout(() => sendChatToRoom(djId, regText), 400)
    return
  }
}

// ══════════════════════════════════════════════════════
// 🎁 추첨 — 실시간 시청자 중 한 명을 무작위로 뽑는다. (DJ/애청지수 지급권한자 전용)

function getRaffleSettings(djId, settings) {
  if (!settings.raffle) {
    settings.raffle = { cmd: '!추첨', winMsg: '🎉 축하합니다! 오늘의 당첨자는 [{nickname}]님입니다! 🎊' }
    store.saveSettings(djId, { raffle: settings.raffle })
  }
  return settings.raffle
}

async function handleRaffleCommand(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'raffle', djId)) return
  const cfg = getRaffleSettings(djId, settings)
  const msg = String(text || '').trim()
  if (msg !== (cfg.cmd || '!추첨')) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const act = getActivitySettings(djId, settings)
  const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
  const canManage = isDj || grantList.includes(String(author || '').trim().toLowerCase())
  if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ DJ/매니저만 사용할 수 있습니다.'), 400); return }

  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const members = await fetchLiveMembers(liveId, accessToken, 5)
  if (!members.length) { setTimeout(() => sendChatToRoom(djId, '🎁 지금 방송에 접속 중인 시청자가 없어요.'), 400); return }
  const winner = members[Math.floor(Math.random() * members.length)]
  const nickname = winner.nickname || winner.tag
  const out = (cfg.winMsg || '🎉 축하합니다! 오늘의 당첨자는 [{nickname}]님입니다! 🎊').replace(/\{nickname\}/g, nickname)
  setTimeout(() => sendChatToRoom(djId, out), 400)
}

// ══════════════════════════════════════════════════════
// 🎲 주사위 — 명령어를 입력하면 1~6 중 하나를 동일한 확률로 랜덤 출력한다. (누구나 사용 가능)

function getDiceSettings(djId, settings) {
  if (!settings.dice) {
    settings.dice = { cmd: '!주사위', msg: '🎲 {user}님의 주사위: {result}!' }
    store.saveSettings(djId, { dice: settings.dice })
  }
  return settings.dice
}

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']

function handleDiceCommand(djId, settings, author, text) {
  if (!isModuleOn(settings, 'dice', djId)) return
  const cfg = getDiceSettings(djId, settings)
  const msg = String(text || '').trim()
  if (msg !== (cfg.cmd || '!주사위')) return
  const n = Math.floor(Math.random() * 6) + 1
  const result = `${DICE_FACES[n - 1]}${n}`
  const out = (cfg.msg || '🎲 {user}님의 주사위: {result}!').replace(/\{user\}/g, author).replace(/\{result\}/g, result)
  setTimeout(() => sendChatToRoom(djId, out), 400)
}

// ══════════════════════════════════════════════════════
// 🔊 효과음 — 선물(도네이션)을 받으면 등록해둔 조건에 맞춰 DJ의 PC(브라우저)에서 효과음을 재생한다.
// 실제 소리는 서버가 아니라 에디봇 사이트를 열어둔 브라우저에서 재생되므로, 방송 중 PC에 사이트를
// 켜두고 있어야 들린다. 파일 자체는 djs.json에 base64로 저장하고, SSE로는 재생할 항목의 id만 보낸다
// (오디오 원본을 매번 전송하면 무거우므로, 프론트엔드가 페이지 로드 시 한 번만 받아서 로컬 캐시해둔다).

const SOUNDFX_MAX_ITEMS = 10
const SOUNDFX_MAX_BYTES = 1.5 * 1024 * 1024 // base64 문자열 기준 약 1.5MB (원본 오디오 1MB 안팎)

function getSoundEffectSettings(djId, settings) {
  if (!settings.soundEffects) {
    settings.soundEffects = { enabled: true, items: [] }
    store.saveSettings(djId, { soundEffects: settings.soundEffects })
  }
  if (!settings.soundEffects.items) settings.soundEffects.items = []
  return settings.soundEffects
}

// 리스트 순서 = 우선순위. 위에서부터 조건을 검사해서 처음 맞는 항목 하나만 재생한다.
function handleSoundEffectTrigger(djId, settings, amount, comboCount, sticker) {
  if (!isModuleOn(settings, 'soundfx', djId)) return
  const cfg = getSoundEffectSettings(djId, settings)
  if (cfg.enabled === false || !cfg.items.length) return
  const stickerNorm = String(sticker || '').trim().toLowerCase()
  const totalAmount = (Number(amount) || 0) * Math.max(1, Number(comboCount) || 1)

  const matches = cfg.items.filter(it => {
    if (it.enabled === false) return false
    if (it.triggerType === 'sticker') {
      const t = String(it.triggerValue || '').trim().toLowerCase()
      return !!t && !!stickerNorm && (stickerNorm === t || stickerNorm.includes(t) || t.includes(stickerNorm))
    }
    if (it.triggerType === 'amount') {
      const threshold = Number(it.triggerValue) || 0
      if (threshold <= 0) return false
      // 정확히 일치: 받은 스푼 수가 딱 그 개수일 때만 / 이상: 그 개수 이상이면 항상
      return it.matchType === 'exact' ? totalAmount === threshold : totalAmount >= threshold
    }
    return it.triggerType === 'any'
  })
  if (!matches.length) return

  // 우선순위: 스푼 개수 조건 중 "가장 높은 개수"에 매칭된 항목이 최우선, 그다음 스티커 조건, 마지막으로 "무조건 재생"
  const amountMatches = matches.filter(it => it.triggerType === 'amount')
  let winner
  if (amountMatches.length) {
    winner = amountMatches.reduce((a, b) => (Number(b.triggerValue) || 0) > (Number(a.triggerValue) || 0) ? b : a)
  } else {
    winner = matches.find(it => it.triggerType === 'sticker') || matches.find(it => it.triggerType === 'any')
  }
  if (!winner) return
  broadcast({ type: 'soundfx', djId, id: winner.id })
}

// ══════════════════════════════════════════════════════
// 🎙️ TTS — 지정한 스푼 금액 이상 선물을 받으면, 그 유저에게 "채팅 1회 읽기 권한"을 부여한다.
// 권한이 있는 동안 그 유저가 채팅을 치면(명령어 제외) 그 메시지를 DJ의 PC(브라우저)에서 음성으로
// 읽어주고, 그 즉시 권한은 소진된다(1회 읽기). 로컬 에디봇의 TTS 기능과 동일한 사양이며,
// 무료인 "브라우저 내장 TTS"만 지원한다 (구글/타입캐스트 같은 유료 API 연동은 지원하지 않음).

function getTtsSettings(djId, settings) {
  if (!settings.tts) {
    settings.tts = {
      enabled: false,
      engine: 'browser', // 'browser' | 'google' | 'typecast'
      voice: '',         // 브라우저 엔진: 음성 이름 / 구글 엔진: GOOGLE_VOICES의 name
      typecastVoiceId: '',
      typecastVoiceName: '',
      typecastModel: 'ssfm-v30',
      typecastEmotion: 'normal',
      rate: 1.0,
      triggerAmount: 10,
      durationMin: 30,
      maxLen: 50,
      volume: 1.0,
      playChime: false,
      // { '태그또는닉네임(소문자)': { voice:'브라우저/구글 음성', typecastVoiceId:'', typecastVoiceName:'' } }
      voicePresets: {},
    }
    store.saveSettings(djId, { tts: settings.tts })
  }
  if (!settings.tts.voicePresets) settings.tts.voicePresets = {}
  return settings.tts
}

// 지금 이 닉네임에게 "채팅 1회 읽기" 권한이 살아있는지 확인
function isTtsEligible(room, nickname) {
  if (!room.ttsAccess) return false
  const key = String(nickname || '').trim().toLowerCase()
  const exp = room.ttsAccess.get(key)
  return !!(exp && exp > Date.now())
}

// 선물로 권한을 얻으면 호출 — 유지시간(분) 동안 "다음 채팅 1회"를 읽어줄 권한을 준다.
function grantTtsAccess(djId, room, settings, nickname) {
  const cfg = getTtsSettings(djId, settings)
  if (!room.ttsAccess) room.ttsAccess = new Map()
  const expiresAt = Date.now() + Math.max(1, Number(cfg.durationMin) || 30) * 60000
  room.ttsAccess.set(String(nickname || '').trim().toLowerCase(), expiresAt)
  broadcast({ type: 'ttsgrant', djId, nickname, expiresAt })
}

// 채팅 1회를 읽고 나면 권한을 즉시 회수(소진)한다.
function consumeTtsAccess(djId, room, nickname) {
  if (!room.ttsAccess) return
  room.ttsAccess.delete(String(nickname || '').trim().toLowerCase())
  broadcast({ type: 'ttsrevoke', djId, nickname })
}

function clearTtsAccess(room) {
  if (room.ttsAccess) room.ttsAccess.clear()
}

// ══════════════════════════════════════════════════════
// 📊 대시보드 — 날짜별 스푼 기록(누가 얼마나 줬는지), 하트 기록, 좋아요 종류별 통계를 쌓아두고
// 월간/주간 랭킹·MVP를 계산할 수 있게 해준다. 로컬 에디봇의 "대시보드" 탭과 동일한 데이터 구조.

// 서버가 UTC로 돌아가도 항상 "한국 시간" 기준 YYYY-MM-DD를 돌려준다.
// (자정 근처에 UTC 기준으로 날짜를 잡으면 실제로는 아직 어제인데 오늘로 찍히는 문제를 방지)
function todayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`
}

// 채팅 화면 하단 "오늘의 MVP" — 선물/좋아요/채팅 각 1명씩. 대시보드/애청지수 켜짐 여부와
// 상관없이 항상 집계되는, 채팅 화면 전용의 가벼운 실시간 트래커다. 방 단위 메모리에만
// 있고(자정 지나면 자동으로 새로 시작), 서버 재시작 시에는 초기화된다.
function getTodayMvpBucket(room) {
  const today = todayKST()
  if (!room.todayMvp || room.todayMvp.date !== today) {
    room.todayMvp = { date: today, gift: {}, like: {}, chat: {} }
  }
  return room.todayMvp
}

function recordTodayMvp(room, category, key, nickname, amount) {
  if (!key) return
  const bucket = getTodayMvpBucket(room)
  const map = bucket[category]
  if (!map[key]) map[key] = { nickname, value: 0 }
  map[key].nickname = nickname
  map[key].value += amount
}

function getDashboardData(djId, settings) {
  if (!settings.dashboard) {
    settings.dashboard = {
      spoonLog: {}, // { 'YYYY-MM-DD': { total, byUser: { tag: { nickname, amount, count } } } }
      heartLog: {}, // { tag: { nickname, count } }
      likeStats: { free: 0, ad: 0, plan: 0, paid: 0, total: 0, sessionStart: 0 },
      djTag: '', // 이달의 DJ 랭킹(초이스/좋아요/방송시간) 조회에 쓸, 등록해둔 본인 고유닉
      rankData: null, // { nickname, tag, ranks:{next_choice,free_like,live_time}, updatedAt }
    }
    store.saveSettings(djId, { dashboard: settings.dashboard })
  }
  if (!settings.dashboard.spoonLog) settings.dashboard.spoonLog = {}
  if (!settings.dashboard.heartLog) settings.dashboard.heartLog = {}
  if (!settings.dashboard.likeStats) settings.dashboard.likeStats = { free: 0, ad: 0, plan: 0, paid: 0, total: 0, sessionStart: 0 }
  if (settings.dashboard.djTag == null) settings.dashboard.djTag = ''
  if (settings.dashboard.rankData === undefined) settings.dashboard.rankData = null
  return settings.dashboard
}

// 📊 스푼 자체 DJ 월간 랭킹 (초이스/좋아요/방송시간) — 특정 방송의 데이터가 아니라
// 스푼 플랫폼 전체 기준이라 djId별로 나누지 않고 서버 전체에서 하나만 캐싱해서 공유한다.
// (로컬 에디봇의 rank:scan / rank:search 를 그대로 이식)
let dashRankCache = { next_choice: [], free_like: [], live_time: [], lastScanned: 0 }
const DASH_RANK_PATH_MAP = {
  next_choice: '/ranks/v2/dj/live/?sub-type=monthly',
  free_like: '/ranks/v2/dj/live-free-like/?sub-type=monthly',
  live_time: '/ranks/v2/dj/live-time/?sub-type=monthly',
}

async function fetchMonthlyRank(type, accessToken, maxCount = 600) {
  let address = DASH_RANK_PATH_MAP[type]
  if (!address || !accessToken) return []
  let list = []
  try {
    while (list.length < maxCount && address) {
      const url = address.startsWith('http') ? address : `https://kr-api.spooncast.net${address}`
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': CHROME_UA, 'Origin': 'https://www.spooncast.net' },
      })
      const json = await res.json().catch(() => null)
      if (!json || !json.results) break
      list = list.concat(json.results)
      address = json.next || null
    }
  } catch (e) { /* 지금까지 모은 것만이라도 반환 */ }
  return list
}

async function scanDashRank() {
  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  if (!accessToken) return { success: false, error: '토큰이 없습니다. 세션 연결을 먼저 확인해주세요.' }
  try {
    for (const type of ['next_choice', 'free_like', 'live_time']) {
      dashRankCache[type] = await fetchMonthlyRank(type, accessToken)
    }
    dashRankCache.lastScanned = Date.now()
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

function searchDashRank(tag) {
  if (dashRankCache.lastScanned === 0) return { success: false, error: '먼저 랭킹 데이터를 스캔해주세요.' }
  const results = { nickname: '', tag, ranks: {} }
  let found = false
  for (const type of ['next_choice', 'free_like', 'live_time']) {
    const idx = dashRankCache[type].findIndex(x => x.author && x.author.tag === tag)
    if (idx !== -1) {
      found = true
      results.nickname = dashRankCache[type][idx].author.nickname
      results.ranks[type] = idx + 1
    }
  }
  if (!found) return { success: false, error: '랭킹 데이터에서 해당 유저를 찾을 수 없습니다.' }
  return { success: true, data: results }
}

// "✨초이스: 222위 | ❤️좋아요: 50위 | ⏱시간: 12위" 형태의 한 줄 요약 문구를 만든다.
function formatRankSummary(ranks) {
  if (!ranks) return ''
  const fmt = v => (v ? v + '위' : '순위없음')
  return `✨초이스: ${fmt(ranks.next_choice)} | ❤️좋아요: ${fmt(ranks.free_like)} | ⏱시간: ${fmt(ranks.live_time)}`
}

// 반복문구/단축키 명령어에서 쓰는 {nickname}{tag}{rank}{choice_rank}{like_rank}{time_rank}
// (대시보드에 등록해둔 "본인" 고유닉 기준 — 채팅 친 시청자가 아니라 방송하는 DJ 본인 정보)
function buildDashboardRankVars(settings) {
  const dash = settings && settings.dashboard
  const warn = '[대시보드에 고유닉 미등록]'
  if (!dash || !dash.djTag) {
    return { nickname: '', tag: '', rank: warn, choice_rank: warn, like_rank: warn, time_rank: warn }
  }
  const rd = dash.rankData
  if (!rd) return { nickname: '', tag: dash.djTag, rank: warn, choice_rank: warn, like_rank: warn, time_rank: warn }
  const r = rd.ranks || {}
  return {
    nickname: rd.nickname || '',
    tag: rd.tag || dash.djTag || '',
    rank: formatRankSummary(r),
    choice_rank: r.next_choice ? `${r.next_choice}위` : '',
    like_rank: r.free_like ? `${r.free_like}위` : '',
    time_rank: r.live_time ? `${r.live_time}위` : '',
  }
}

// 등록된 djTag 기준으로 랭킹을 다시 조회해서 settings.dashboard.rankData에 저장한다.
// needScan이 true면(캐시가 없거나 너무 오래됐으면) 전체 랭킹판을 먼저 새로 긁어온다.
async function refreshDashboardRankFor(djId, settings) {
  const dash = getDashboardData(djId, settings)
  if (!dash.djTag) return { success: false, error: '등록된 고유닉이 없어요' }
  if (dashRankCache.lastScanned === 0 || Date.now() - dashRankCache.lastScanned > 30 * 60 * 1000) {
    const scanResult = await scanDashRank()
    if (!scanResult.success) return scanResult
  }
  const r = searchDashRank(dash.djTag)
  if (!r.success) {
    dash.rankData = { nickname: '', tag: dash.djTag, ranks: {}, updatedAt: Date.now(), notFound: true }
    store.saveSettings(djId, { dashboard: dash })
    return r
  }
  dash.rankData = { nickname: r.data.nickname, tag: dash.djTag, ranks: r.data.ranks, updatedAt: Date.now(), notFound: false }
  store.saveSettings(djId, { dashboard: dash })
  return { success: true, data: dash.rankData }
}

// 봇이 방송에 접속해있는 동안, 고유닉을 등록해둔 계정은 10분마다 자동으로 랭킹을 갱신한다.
// 랭킹판 전체 스캔은 무거워서(전체 DJ 대상) 한 번만 하고, 등록된 모든 계정이 그 결과를 같이 사용한다.
const DASH_RANK_AUTO_REFRESH_MS = 10 * 60 * 1000
setInterval(async () => {
  const targets = []
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (!room.isConnected) continue
    const settings = store.getSettings(djId) || {}
    if (!isModuleOn(settings, 'dashboard', djId)) continue
    const dash = getDashboardData(djId, settings)
    if (dash.djTag) targets.push(djId)
  }
  if (!targets.length) return
  const scanResult = await scanDashRank()
  if (!scanResult.success) { console.log('[대시보드랭킹] 자동 갱신 스캔 실패:', scanResult.error); return }
  for (const djId of targets) {
    const settings = store.getSettings(djId) || {}
    const dash = getDashboardData(djId, settings)
    const r = searchDashRank(dash.djTag)
    if (r.success) dash.rankData = { nickname: r.data.nickname, tag: dash.djTag, ranks: r.data.ranks, updatedAt: Date.now(), notFound: false }
    else dash.rankData = { nickname: '', tag: dash.djTag, ranks: {}, updatedAt: Date.now(), notFound: true }
    store.saveSettings(djId, { dashboard: dash })
  }
  console.log(`[대시보드랭킹] 자동 갱신 완료 (${targets.length}개 계정)`)
}, DASH_RANK_AUTO_REFRESH_MS)

// 선물을 받으면 오늘 날짜의 스푼 로그에 유저별로 누적 기록한다.
function recordDashboardSpoon(djId, settings, nickname, tag, amount, comboCount) {
  if (!isModuleOn(settings, 'dashboard', djId)) return
  const dash = getDashboardData(djId, settings)
  const today = todayKST()
  const key = String(tag || nickname || '').trim() || nickname
  if (!dash.spoonLog[today]) dash.spoonLog[today] = { total: 0, byUser: {} }
  const entry = dash.spoonLog[today]
  if (!entry.byUser[key]) entry.byUser[key] = { nickname, amount: 0, count: 0 }
  entry.byUser[key].nickname = nickname
  entry.byUser[key].amount += amount
  entry.byUser[key].count += Math.max(1, Number(comboCount) || 1)
  entry.total = (entry.total || 0) + amount
  store.saveSettings(djId, { dashboard: dash })
}

// 좋아요를 받으면 하트 랭킹 + 무료/광고/플랜/유료 하트 통계에 반영한다.
// type: 'free'(일반 좋아요 탭) | 'ad'(광고/룰렛 하트) | 'plan'(플랜 하트) | 'paid'(그 외 유료 하트)
function recordDashboardHeart(djId, settings, nickname, tag, type = 'free', amount = 1) {
  if (!isModuleOn(settings, 'dashboard', djId)) return
  const dash = getDashboardData(djId, settings)
  const key = String(tag || nickname || '').trim() || nickname
  if (!dash.heartLog[key]) dash.heartLog[key] = { nickname, count: 0 }
  dash.heartLog[key].nickname = nickname
  dash.heartLog[key].count += amount
  if (!dash.likeStats.sessionStart) dash.likeStats.sessionStart = Date.now()
  const safeType = ['free', 'ad', 'plan', 'paid'].includes(type) ? type : 'free'
  dash.likeStats[safeType] = (dash.likeStats[safeType] || 0) + amount
  dash.likeStats.total = (dash.likeStats.total || 0) + amount
  store.saveSettings(djId, { dashboard: dash })
}

// ══════════════════════════════════════════════════════
// 🎡 돌림판 룰렛 — DJ가 웹 화면에서 직접 돌리는 SVG 회전판. 1~5페이지, 페이지마다
// 독립된 항목/확률/효과음/TTS/결과문구를 가진다. "!돌림판 [1~5]" 로 페이지를 열어달라는
// 신호를 보낼 수 있고(자동으로 화면이 열리진 않음, 웹 특성상), 실제 회전은 DJ가 화면에서
// 직접 "GO" 버튼을 눌러야 한다. 회전 결과는 채팅으로 자동 브로드캐스트된다.

const WHEEL_PAGE_COUNT = 5

function defaultWheelPage() {
  return {
    items: [
      { label: '리방권', weight: 10, color: '#f59e0b' },
      { label: '방송 소환권', weight: 30, color: '#64748b' },
      { label: '복권 10장', weight: 15, color: '#a855f7' },
      { label: '5분동안 냥냥체', weight: 15, color: '#fb923c' },
      { label: '10분간 배경이미지 변경', weight: 5, color: '#7c2d12' },
      { label: '10분간 방제 변경', weight: 10, color: '#ec4899' },
      { label: '마실 500', weight: 10, color: '#06b6d4' },
      { label: '실드 500', weight: 5, color: '#ef4444' },
    ],
    soundEnabled: true,
    ttsEnabled: true,
    spinSeconds: 5,
    resultTemplate: '🎡 돌림판 결과: {result}',
  }
}

function getWheelSettings(djId, settings) {
  if (!settings.wheelRoulette) {
    settings.wheelRoulette = { activePage: 0, pages: Array.from({ length: WHEEL_PAGE_COUNT }, defaultWheelPage) }
    store.saveSettings(djId, { wheelRoulette: settings.wheelRoulette })
  }
  if (!Array.isArray(settings.wheelRoulette.pages) || settings.wheelRoulette.pages.length !== WHEEL_PAGE_COUNT) {
    const d = Array.from({ length: WHEEL_PAGE_COUNT }, defaultWheelPage)
    const src = Array.isArray(settings.wheelRoulette.pages) ? settings.wheelRoulette.pages : []
    settings.wheelRoulette.pages = d.map((dp, i) => Object.assign({}, dp, src[i] || {}))
  }
  return settings.wheelRoulette
}

// "!돌림판" 또는 "!돌림판 3" — DJ/매니저가 채팅으로 요청하면, 지금 웹 화면을 열어둔
// 브라우저에 "이 페이지 좀 보여줘" 신호를 SSE로 보낸다. (웹에서는 채팅만으로 화면을
// 강제로 띄울 수는 없어서, 이미 돌림판 화면을 켜둔 경우에만 자동으로 페이지가 전환된다)
async function handleWheelCommand(djId, room, settings, author, authorId, text) {
  if (!isModuleOn(settings, 'wheelroulette', djId)) return
  const msg = String(text || '').trim()
  const m = msg.match(/^!돌림판(?:\s+(\d))?$/)
  if (!m) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const act = getActivitySettings(djId, settings)
  const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
  const canManage = isDj || grantList.includes(String(author || '').trim().toLowerCase())
  if (!canManage) { setTimeout(() => sendChatToRoom(djId, '🎡 돌림판은 DJ 또는 매니저만 사용할 수 있어요.'), 400); return }
  let page = null
  if (m[1]) { const n = parseInt(m[1], 10); if (n >= 1 && n <= WHEEL_PAGE_COUNT) page = n - 1 }
  broadcast({ type: 'wheelopen', djId, page })
  const pageMsg = page !== null ? ` (${page + 1}페이지)` : ''
  setTimeout(() => sendChatToRoom(djId, `🎡 돌림판을 준비해주세요${pageMsg}!`), 400)
}

// DJ가 웹 화면에서 실제로 돌려서 결과가 나오면, 그 결과를 채팅에 브로드캐스트한다.
// (실제 처리는 아래 POST /wheel/spin-result 라우트에서)

// ══════════════════════════════════════════════════════
// 🎟️ 쿠폰 확인 — "!쿠폰"으로 복권/룰렛권 보유 현황을 한 번에 확인한다.
// 로컬 버전처럼 별도 장부를 새로 만들지 않고, 이미 있는 애청지수(복권)와
// 룰렛 기록(룰렛권) 데이터를 그대로 읽어서 보여준다 — 데이터가 두 곳에서 따로 노는 걸 방지.

function getCouponCheckSettings(djId, settings) {
  if (!settings.couponCheck) {
    settings.couponCheck = {
      title: '🎟️ 쿠폰 보유 현황',
      footer: '보유 쿠폰 조회 완료!',
      showZeroRoulette: true,
      cmdCoupon: '!쿠폰',
      cmdGive: '!룰렛권지급',
      cmdSync: '!쿠폰동기화',
    }
    store.saveSettings(djId, { couponCheck: settings.couponCheck })
  }
  return settings.couponCheck
}

async function handleCouponCommand(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'couponcheck', djId)) return
  const cfg = getCouponCheckSettings(djId, settings)
  const msg = String(text || '').trim()
  const parts = msg.split(/\s+/)
  const first = parts[0]
  const cmdCoupon = cfg.cmdCoupon || '!쿠폰'
  const cmdGive = cfg.cmdGive || '!룰렛권지급'
  const cmdSync = cfg.cmdSync || '!쿠폰동기화'

  if (first === cmdCoupon) {
    const act = getActivitySettings(djId, settings)
    const key = findActUserKey(act, author)
    const lotto = key ? (act.users[key].lotto || 0) : 0
    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    const authorTag = await getCachedUserTag(room, liveId, authorId, accessToken)
    if (authorTag) rememberTagNickname(room, authorTag, author)
    const rec = getHistoryRecByIdentity(settings, authorTag, author)
    const rouletteList = ((settings.roulette || {}).list || [])
    const lines = []
    rouletteList.forEach((r, i) => {
      const idx = i + 1
      const count = Number(rec.coupons[idx] || 0)
      if (cfg.showZeroRoulette !== false || count > 0) {
        lines.push(`🎡 ${r.name || ('룰렛' + idx)}: ${count}장`)
      }
    })
    const body = [
      cfg.title || '🎟️ 쿠폰 보유 현황',
      `👤 ${author}님`,
      `🎫 복권: ${lotto}장`,
      lines.length ? lines.join('\n') : '🎡 룰렛권: 0장',
      '━━━━━━━━━━━━',
      cfg.footer || '보유 쿠폰 조회 완료!',
    ].join('\n')
    sendChatSplit(djId, body, 150, 600)
    return
  }

  if (first === cmdGive || first === cmdSync) {
    const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
    const act = getActivitySettings(djId, settings)
    const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
    const canManage = isDj || grantList.includes(String(author || '').trim().toLowerCase())
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '⚠️ 매니저 이상만 사용 가능합니다.'), 400); return }

    const rouletteNo = parseInt(parts[1], 10)
    const targetInput = parts[2]
    const countVal = parseInt(parts[3], 10)
    if (!rouletteNo || !targetInput || isNaN(countVal)) {
      setTimeout(() => sendChatToRoom(djId, `사용법: ${first === cmdGive ? cmdGive : cmdSync} 1 @고유닉 3`), 400)
      return
    }

    // ⚠️ 오타로 조용히 없는 유저가 만들어지지 않도록, 지금 방에 실제로 있는 사람인지 먼저 확인 (기존 !룰렛지급과 동일한 규칙)
    const found = await findLiveMemberByNickOrTag(liveId, targetInput)
    if (!found) {
      setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetInput}' 님을 지금 방송에서 찾을 수 없어요.`), 400)
      return
    }
    const targetName = found.nickname || found.tag
    const rec = getHistoryRecByIdentity(settings, found.tag, targetName)
    if (first === cmdGive) {
      rec.coupons[rouletteNo] = Number(rec.coupons[rouletteNo] || 0) + countVal
    } else {
      rec.coupons[rouletteNo] = Math.max(0, countVal)
    }
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag: found.tag || targetName })
    const label = first === cmdGive ? '지급' : '동기화'
    setTimeout(() => sendChatToRoom(djId, `✅ ${targetName}님 룰렛${rouletteNo} ${label} 완료 / 보유 ${rec.coupons[rouletteNo]}장`), 400)
    return
  }
}

// ══════════════════════════════════════════════════════
// 📝 메모장 — 애청지수(복권/레벨) 시스템과 완전히 독립적인, 실시간 접속자 대상 개인 메모.
// 등록 없이 "지금 방에 있는 사람"이면 누구든 메모를 남길 수 있고, 한 번 메모를 남기면
// 그 사람은 방을 나가도 "메모 있는 유저 목록"에 계속 남는다.

function getUserNotesData(djId, settings) {
  if (!settings.userNotes) {
    settings.userNotes = {} // { key(tag 또는 닉네임): { nickname, tag, imgUrl, memo, updatedAt } }
    store.saveSettings(djId, { userNotes: settings.userNotes })
  }
  return settings.userNotes
}

// ══════════════════════════════════════════════════════
// 🔔 디스코드 방송 알림 — 봇이 방송에 새로 연결될 때마다(자동입장/다중감시/즉시입장 등 어떤
// 경로로 들어오든 전부) 디스코드 웹후크로 "방송 시작" 알림을 자동으로 보낸다.

function getDiscordNotifySettings(djId, settings) {
  if (!settings.discordNotify) {
    settings.discordNotify = {
      webhookUrl: '',
      manualStreamName: '',
      enabled: true,
      title: '🔴 방송 시작!',
      description: '🎙️ **{스트림}**님이 방송을 시작했어요!\n👇 아래 링크 누르면 바로 입장!',
      streamUrlTemplate: 'https://www.spooncast.net/kr/live/@{스트림}',
      cooldownMinutes: 30,
      lastSentAt: 0,
      lastStreamName: '',
    }
    store.saveSettings(djId, { discordNotify: settings.discordNotify })
  }
  return settings.discordNotify
}

async function sendDiscordNotify(cfg, streamName) {
  const url = (cfg.webhookUrl || '').trim()
  if (!url) return { ok: false, error: '웹후크 URL이 비어있습니다.' }
  const validPrefixes = ['https://discord.com/api/webhooks/', 'https://discordapp.com/api/webhooks/', 'https://canary.discord.com/api/webhooks/', 'https://ptb.discord.com/api/webhooks/']
  if (!validPrefixes.some(p => url.startsWith(p))) {
    return { ok: false, error: '올바른 디스코드 웹후크 URL이 아니에요. (https://discord.com/api/webhooks/... 형식)' }
  }

  const cleanName = String(streamName || '').replace(/^@+/, '').trim()
  let streamUrl = ''
  const urlTpl = (cfg.streamUrlTemplate || '').trim()
  if (urlTpl && cleanName) streamUrl = urlTpl.replace(/\{스트림\}/g, cleanName)

  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const timeStr = `${hh}:${mm}`
  const subst = s => String(s == null ? '' : s)
    .replace(/\{스트림\}/g, cleanName || '방송')
    .replace(/\{시간\}/g, timeStr)
    .replace(/\{링크\}/g, streamUrl || '')

  const title = subst(cfg.title || '🔴 방송 시작!')
  const description = subst(cfg.description || '')
  const embed = { title, color: 0x7c3aed, timestamp: now.toISOString() }
  if (description) embed.description = description
  if (streamUrl && /^https?:\/\//i.test(streamUrl)) {
    embed.url = streamUrl
    embed.fields = [{ name: '🎙️ 방송 입장하기', value: streamUrl, inline: false }]
  }
  const payload = { content: '', embeds: [embed], allowed_mentions: { parse: [] } }

  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!res.ok) {
      let body = ''
      try { body = await res.text() } catch (e) {}
      return { ok: false, error: `HTTP ${res.status} ${res.statusText} - ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 봇이 방송에 새로 연결될 때마다(connectSpoonForDj의 ws 'open' 콜백에서) 호출된다.
// 쿨다운(재접속 시 중복 알림 방지) 검사 후, 조건에 맞으면 실제로 웹후크를 쏜다.
async function notifyDiscordOnConnect(djId, streamName) {
  try {
    const settings = store.getSettings(djId) || {}
    if (!isModuleOn(settings, 'discordnotify', djId)) return
    const cfg = getDiscordNotifySettings(djId, settings)
    if (cfg.enabled === false) return
    const finalName = (cfg.manualStreamName || '').trim().replace(/^@+/, '') || String(streamName || '').replace(/^@+/, '').trim()

    const cooldownMs = Math.max(0, Number(cfg.cooldownMinutes) || 0) * 60000
    if (cooldownMs > 0 && finalName) {
      const elapsed = Date.now() - (Number(cfg.lastSentAt) || 0)
      if (cfg.lastStreamName === finalName && elapsed < cooldownMs) {
        console.log(`[디스코드알림:${djId}] 쿨다운 중 - 스킵`)
        return
      }
    }
    const r = await sendDiscordNotify(cfg, finalName)
    if (r.ok) {
      cfg.lastSentAt = Date.now()
      if (finalName) cfg.lastStreamName = finalName
      store.saveSettings(djId, { discordNotify: cfg })
      console.log(`[디스코드알림:${djId}] ✅ 발송 완료 (${finalName || '미확정'})`)
    } else {
      console.log(`[디스코드알림:${djId}] ❌ 발송 실패:`, r.error)
    }
  } catch (e) {
    console.log(`[디스코드알림:${djId}] 오류:`, e.message)
  }
}

// 채팅 명령어: !알림테스트 / !알림초기화 / !알림상태 (DJ/매니저 전용)
async function handleDiscordNotifyCommand(djId, room, settings, author, authorId, text) {
  if (!isModuleOn(settings, 'discordnotify', djId)) return
  const msg = String(text || '').trim()
  if (!['!알림테스트', '!알림초기화', '!알림상태'].includes(msg)) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const act = getActivitySettings(djId, settings)
  const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
  const canManage = isDj || grantList.includes(String(author || '').trim().toLowerCase())
  if (!canManage) { setTimeout(() => sendChatToRoom(djId, '⚠️ DJ/매니저만 사용 가능합니다.'), 400); return }

  const cfg = getDiscordNotifySettings(djId, settings)

  if (msg === '!알림테스트') {
    const finalName = (cfg.manualStreamName || '').trim().replace(/^@+/, '') || String(room.watchingTag || '').replace(/^@+/, '').trim()
    setTimeout(() => sendChatToRoom(djId, `📡 디스코드 테스트 알림 발송 중... (방송명: ${finalName || '(없음)'})`), 300)
    const r = await sendDiscordNotify(cfg, finalName)
    setTimeout(() => sendChatToRoom(djId, r.ok ? '✅ 디스코드 알림 전송 성공!' : ('❌ 전송 실패: ' + r.error)), 800)
    return
  }
  if (msg === '!알림초기화') {
    cfg.lastSentAt = 0
    cfg.lastStreamName = ''
    store.saveSettings(djId, { discordNotify: cfg })
    setTimeout(() => sendChatToRoom(djId, '🔄 디스코드 알림 쿨다운이 초기화되었습니다.'), 300)
    return
  }
  if (msg === '!알림상태') {
    const manual = (cfg.manualStreamName || '').trim() || '(없음)'
    const watching = room.watchingTag || '(없음)'
    const lastSentStr = cfg.lastSentAt ? new Date(cfg.lastSentAt).toLocaleString('ko-KR') : '(없음)'
    const resolved = (cfg.manualStreamName || '').trim().replace(/^@+/, '') || String(room.watchingTag || '').replace(/^@+/, '').trim() || '(없음)'
    const body = [
      '📊 디스코드 알림 상태',
      `▸ 설정 수동 방송명: ${manual}`,
      `▸ 현재 감시/입장 태그: ${watching}`,
      `▸ 최종 결정값: ${resolved}`,
      `▸ 마지막 알림 방송: ${cfg.lastStreamName || '(없음)'}`,
      `▸ 마지막 알림 시각: ${lastSentStr}`,
      `▸ 봇 접속 중: ${room.isConnected ? '예' : '아니오'}`,
    ].join('\n')
    sendChatSplit(djId, body, 150, 600)
    return
  }
}

// ══════════════════════════════════════════════════════
// 🎣 낚시 게임 — 로컬 낚시봇 외부 모듈을 그대로 이식. 물고기 잡기/상점/아이템/컬렉션/
// 신용대출/도박(슬롯·주사위·홀짝)/송금/도둑질까지 전부 채팅 명령어로 동작하는 미니 경제 게임.

const FISHING_DEFAULT_FISH_LIST = '붕어,800,1200,30,5,common\n잉어,1500,2500,25,8,common\n메기,4000,6000,15,12,uncommon\n농어,8000,12000,10,20,uncommon\n참치,25000,35000,5,40,rare\n상어,70000,90000,2,80,epic\n고래,180000,220000,0.5,200,legendary'
const FISHING_DEFAULT_SHOP = '미끼,500\n특수미끼,2000\n낚싯대,10000\n고급낚싯대,50000'
const FISHING_DEFAULT_ITEMSHOP = '물고기확률업,5000,fish_chance,30,30,0,money\n수익증가,8000,fishing_income,50,30,0,money\n주사위확률,3000,dice_chance,30,0,5,money\n주사위두배,10000,dice_double,0,0,3,money\n홀짝확률,2000,oddeven_chance,40,0,5,money'
const FISHING_DEFAULT_COLLECTIONS = '강물고기:붕어,잉어,메기,농어\n바다물고기:참치,상어,고래'

function getFishingSettings(djId, settings) {
  if (!settings.fishing) {
    settings.fishing = {
      config: {
        enabled: true,
        fishingCooldown: 120,
        dailyMoney: 10000,
        slotMinBet: 1000,
        diceWinExp: 10,
        diceLoseExp: -2,
        fishList: FISHING_DEFAULT_FISH_LIST,
        eventFishList: '',
        shopProducts: FISHING_DEFAULT_SHOP,
        itemShop: FISHING_DEFAULT_ITEMSHOP,
        collections: FISHING_DEFAULT_COLLECTIONS,
        creditTier1Points: 0, creditTier1Loan: 500000,
        creditTier2Points: 100, creditTier2Loan: 1000000,
        creditTier3Points: 500, creditTier3Loan: 3000000,
        theftBaseRate: 5, theftLevelBonus: 0.5, theftMaxRate: 70,
        djTags: '',
      },
      users: {}, // { tag: {...} }
    }
    store.saveSettings(djId, { fishing: settings.fishing })
  }
  if (!settings.fishing.config) settings.fishing.config = {}
  if (!settings.fishing.users) settings.fishing.users = {}
  return settings.fishing
}

function _fishSplitLines(text) {
  if (!text || typeof text !== 'string') return []
  return text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
}
function _fishParseFishList(text) {
  return _fishSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 3 || !p[0]) return null
    if (p.length >= 6 && !isNaN(p[1]) && !isNaN(p[2]) && !isNaN(p[3])) {
      const minVal = parseInt(p[1]) || 0
      const maxVal = parseInt(p[2]) || minVal
      return { name: p[0], minValue: Math.min(minVal, maxVal), maxValue: Math.max(minVal, maxVal), chance: parseFloat(p[3]) || 0, exp: parseInt(p[4]) || 1, rarity: p[5] || 'common' }
    }
    const val = parseInt(p[1]) || 0
    return { name: p[0], minValue: val, maxValue: val, chance: parseFloat(p[2]) || 0, exp: parseInt(p[3]) || 1, rarity: p[4] || 'common' }
  }).filter(Boolean)
}
function _fishParseShop(text) {
  return _fishSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 2 || !p[0]) return null
    return { name: p[0], price: parseInt(p[1]) || 0 }
  }).filter(Boolean)
}
function _fishParseItemShop(text) {
  return _fishSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 3 || !p[0]) return null
    return { name: p[0], price: parseInt(p[1]) || 0, effect_type: p[2] || '', effect_value: parseFloat(p[3]) || 0, duration_minutes: parseInt(p[4]) || 0, uses: parseInt(p[5]) || 0, price_type: (p[6] === 'points') ? 'points' : 'money' }
  }).filter(Boolean)
}
function _fishParseCollections(text) {
  return _fishSplitLines(text).map(line => {
    const idx = line.indexOf(':')
    if (idx < 0) return null
    const name = line.substring(0, idx).trim()
    const fish = line.substring(idx + 1).split(',').map(s => s.trim()).filter(Boolean)
    if (!name || fish.length === 0) return null
    return { name, required_fish: fish }
  }).filter(Boolean)
}
function _fishCreditTiers(cfg) {
  return [
    { rating: 1, required_points: cfg.creditTier1Points || 0, loan_limit: cfg.creditTier1Loan || 500000 },
    { rating: 2, required_points: cfg.creditTier2Points || 100, loan_limit: cfg.creditTier2Loan || 1000000 },
    { rating: 3, required_points: cfg.creditTier3Points || 500, loan_limit: cfg.creditTier3Loan || 3000000 },
  ]
}
function _fishNewUser(tag, nickname) {
  return { tag, nickname: nickname || tag, balance: 0, level: 1, exp: 0, caught_fish: {}, event_fish_catches: {}, total_fish_count: 0, heart_points: 0, credit_rating: 1, loan_amount: 0, loan_date: null, active_items: [], inventory: {}, last_fishing_time: null, last_daily_money_date: null }
}
function getFishingUser(fishing, tag, nickname) {
  if (!tag) return null
  if (!fishing.users[tag]) fishing.users[tag] = _fishNewUser(tag, nickname)
  else if (nickname && fishing.users[tag].nickname !== nickname) fishing.users[tag].nickname = nickname
  return fishing.users[tag]
}
function saveFishingUser(djId, fishing) {
  store.saveSettings(djId, { fishing })
}
function _fishActiveItems(user) {
  if (!Array.isArray(user.active_items)) return []
  const now = Date.now()
  return user.active_items.filter(item => {
    if (item.expires_at && new Date(item.expires_at).getTime() <= now) return false
    if (item.uses_remaining !== undefined && item.uses_remaining > 0) return true
    if (item.expires_at) return true
    return false
  })
}
function _fishRecalcCredit(user, tiers) {
  const sorted = [...tiers].sort((a, b) => b.required_points - a.required_points)
  for (const t of sorted) {
    if ((user.heart_points || 0) >= t.required_points) { user.credit_rating = t.rating; return }
  }
  user.credit_rating = 1
}
function _fishCheckLevelUp(user) {
  let leveled = false
  while (true) {
    const need = user.level * 100
    if (user.exp >= need) { user.exp -= need; user.level++; leveled = true }
    else break
  }
  return leveled
}
function _fishIsDj(djId, room, settings, authorId, author) {
  if (authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId) return true
  const cfg = getFishingSettings(djId, settings).config
  const list = String(cfg.djTags || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
  if (list.includes(String(author || '').trim().toLowerCase())) return true
  const act = getActivitySettings(djId, settings)
  return (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase())
}

const _fishRecentCalls = new Map()
function _fishIsDuplicateCall(key, windowMs = 3000) {
  const now = Date.now()
  const last = _fishRecentCalls.get(key)
  if (last && now - last < windowMs) return true
  _fishRecentCalls.set(key, now)
  if (_fishRecentCalls.size > 500) {
    for (const [k, v] of _fishRecentCalls) { if (now - v > 30000) _fishRecentCalls.delete(k) }
  }
  return false
}

function fishReply(djId, msg) {
  sendChatSplit(djId, msg, 150, 500)
}

// ── 명령어 핸들러 (전부 djId/room/settings/author/authorId/tag/parts 형태로 통일) ──

async function fishCmdFishing(djId, room, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  const cfg = fishing.config
  if (!cfg.enabled) return
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 낚시를 할 수 있습니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  const cooldown = (cfg.fishingCooldown || 120) * 1000
  if (user.last_fishing_time) {
    const elapsed = Date.now() - new Date(user.last_fishing_time).getTime()
    if (elapsed < cooldown) { fishReply(djId, `⏰ 쿨타임 ${Math.ceil((cooldown - elapsed) / 1000)}초 남음`); return }
  }
  const fishList = _fishParseFishList(cfg.fishList)
  const eventFish = _fishParseFishList(cfg.eventFishList)
  const allFish = [...fishList.map(f => ({ ...f, isEvent: false })), ...eventFish.map(f => ({ ...f, isEvent: true }))]
  if (allFish.length === 0) { fishReply(djId, '❌ 물고기가 등록되지 않았습니다. 설정에서 추가해주세요.'); return }
  const items = _fishActiveItems(user)
  const fishChanceItem = items.find(i => i.effect_type === 'fish_chance')
  const incomeItem = items.find(i => i.effect_type === 'fishing_income')
  let weighted = allFish
  if (fishChanceItem && fishChanceItem.effect_value > 0) {
    weighted = allFish.map(f => ({ ...f, chance: (f.maxValue || 0) > 10000 ? f.chance * (1 + fishChanceItem.effect_value / 100) : f.chance }))
  }
  const total = weighted.reduce((s, f) => s + f.chance, 0)
  let roll = Math.random() * total
  let caught = weighted[0]
  for (const f of weighted) { roll -= f.chance; if (roll <= 0) { caught = f; break } }
  const minVal = caught.minValue, maxVal = caught.maxValue
  const baseValue = minVal === maxVal ? minVal : Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal
  let value = baseValue
  if (incomeItem && incomeItem.effect_value > 0) value = Math.floor(value * (1 + incomeItem.effect_value / 100))
  user.balance += value
  user.exp += caught.exp
  user.total_fish_count++
  user.last_fishing_time = new Date().toISOString()
  if (caught.isEvent) { user.event_fish_catches[caught.name] = (user.event_fish_catches[caught.name] || 0) + 1 }
  else { user.caught_fish[caught.name] = (user.caught_fish[caught.name] || 0) + 1 }
  const leveled = _fishCheckLevelUp(user)
  saveFishingUser(djId, fishing)
  const hasRange = minVal !== maxVal
  let msg = `🎣 와! ${author}님 ${caught.name}를 낚았습니다!\n`
  if (incomeItem && incomeItem.effect_value > 0) {
    msg += hasRange ? `💰 기본가 ₩${baseValue.toLocaleString()}원 (₩${minVal.toLocaleString()}~₩${maxVal.toLocaleString()})\n` : `💰 원래 가치 ₩${baseValue.toLocaleString()}원\n`
    msg += `💰 수익 +${incomeItem.effect_value}% 적용!\n💰 보너스 적용 ₩${value.toLocaleString()}원\n`
  } else {
    msg += hasRange ? `💰 ₩${value.toLocaleString()}원 (₩${minVal.toLocaleString()}~₩${maxVal.toLocaleString()})\n` : `💰 ₩${value.toLocaleString()}원\n`
  }
  msg += `현재 잔액: ₩${user.balance.toLocaleString()}원`
  if (leveled) msg += `\n🎉 레벨업! Lv.${user.level}`
  fishReply(djId, msg)
}

async function fishCmdDailyMoney(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!fishing.config.enabled) return
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  const today = new Date().toISOString().split('T')[0]
  if (user.last_daily_money_date === today) { fishReply(djId, '💸 오늘 이미 받음'); return }
  const amount = fishing.config.dailyMoney || 10000
  user.balance += amount
  user.last_daily_money_date = today
  saveFishingUser(djId, fishing)
  fishReply(djId, `💵 +₩${amount.toLocaleString()}원\n💰 잔액: ₩${user.balance.toLocaleString()}원`)
}

async function fishCmdBalance(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  saveFishingUser(djId, fishing)
  fishReply(djId, `💰 ${author}님의 현재 잔액\n ₩${user.balance.toLocaleString()}원\n🅿️${user.heart_points || 0}포인트`)
}

async function fishCmdStatus(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  saveFishingUser(djId, fishing)
  let msg = `👤 ${author}님의 상태\n💰 보유금액: ₩${user.balance.toLocaleString()}원\n🎣 낚시 횟수: ${user.total_fish_count}회\n\n⭐ 경험치: ${user.exp} EXP (레벨 ${user.level})\n🎯 포인트: 🅿️${user.heart_points || 0}포인트`
  const items = _fishActiveItems(user)
  if (items.length > 0) {
    msg += `\n\n🎁 활성 아이템:`
    const groups = {}
    items.forEach(it => { if (!groups[it.item_name]) groups[it.item_name] = []; groups[it.item_name].push(it) })
    Object.entries(groups).forEach(([name, arr]) => {
      const first = arr[0]
      msg += `\n• ${name}` + (arr.length > 1 ? ` x${arr.length}` : '')
      if (first.expires_at) { const remain = Math.ceil((new Date(first.expires_at).getTime() - Date.now()) / 60000); if (remain > 0) msg += ` (${remain}분 남음)` }
      if (first.uses_remaining !== undefined && first.uses_remaining > 0) { const t = arr.reduce((s, x) => s + (x.uses_remaining || 0), 0); msg += ` (${t}회 남음)` }
    })
  }
  fishReply(djId, msg)
}

async function fishCmdWallet(djId, settings) {
  const fishing = getFishingSettings(djId, settings)
  const all = Object.values(fishing.users)
  if (all.length === 0) { fishReply(djId, '💼 등록된 유저가 없습니다.'); return }
  const sorted = all.sort((a, b) => (b.balance || 0) - (a.balance || 0)).slice(0, 10)
  let msg = '💼 잔액 랭킹 TOP 10\n'
  sorted.forEach((u, i) => { const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`; msg += `${medal} ${u.nickname}: ₩${(u.balance || 0).toLocaleString()}원\n` })
  fishReply(djId, msg.trim())
}

async function fishCmdLevel(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  saveFishingUser(djId, fishing)
  const cfg = fishing.config
  const baseRate = (cfg.theftBaseRate || 5) / 100, lvlBonus = (cfg.theftLevelBonus || 0.5) / 100, maxRate = (cfg.theftMaxRate || 70) / 100
  const rate = Math.min(maxRate, baseRate + (user.level - 1) * lvlBonus)
  fishReply(djId, `🎯 ${author}님의 레벨 정보\n⭐ 레벨: Lv.${user.level}\n📊 경험치: ${user.exp} EXP\n🎲 도둑 성공률: ${Math.round(rate * 100)}%`)
}

async function fishCmdSlot(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  const cfg = fishing.config
  if (!cfg.enabled) return
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const amount = parseInt(parts[1]) || 0
  const minBet = cfg.slotMinBet || 1000
  if (!amount || amount < minBet) { fishReply(djId, `🎰 최소 베팅: ₩${minBet.toLocaleString()}원`); return }
  const user = getFishingUser(fishing, tag, author)
  if (user.balance < amount) { fishReply(djId, '💸 잔액 부족'); return }
  const symbols = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣']
  const r = [symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)]]
  let win = 0, label = ''
  if (r[0] === r[1] && r[1] === r[2]) {
    if (r[0] === '7️⃣') { win = amount * 10; label = '🎊x10' }
    else if (r[0] === '💎') { win = amount * 5; label = '💎x5' }
    else { win = amount * 3; label = '🎉x3' }
  } else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) { win = amount * 2; label = '✨x2' }
  user.balance = user.balance - amount + win
  saveFishingUser(djId, fishing)
  let msg = `🎰 ${r.join(' ')}\n`
  msg += win > 0 ? `${label} +₩${(win - amount).toLocaleString()}원` : `꽝 -₩${amount.toLocaleString()}원`
  msg += `\n💰 잔액: ₩${user.balance.toLocaleString()}원`
  fishReply(djId, msg)
}

async function fishCmdDice(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  const cfg = fishing.config
  if (!cfg.enabled) return
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const amount = parseInt(parts[1]) || 0
  if (amount <= 0) { fishReply(djId, '🎲 사용법: !주사위 [금액]'); return }
  const user = getFishingUser(fishing, tag, author)
  if (user.balance < amount) { fishReply(djId, '💸 잔액 부족'); return }
  let updated = [...(user.active_items || [])]
  const items = _fishActiveItems(user)
  const chanceItem = items.find(i => i.effect_type === 'dice_chance')
  const doubleItem = items.find(i => i.effect_type === 'dice_double')
  const myDice = Math.floor(Math.random() * 6) + 1
  let botDice = Math.floor(Math.random() * 6) + 1
  if (myDice > botDice && Math.random() < 0.1 && botDice < 6) botDice = Math.min(6, botDice + 1)
  let chanceUsed = false
  if (chanceItem && chanceItem.effect_value > 0 && chanceItem.uses_remaining > 0) {
    if (Math.random() < (chanceItem.effect_value / 100) && botDice > 1) {
      botDice = Math.max(1, botDice - 1); chanceUsed = true
      const idx = updated.findIndex(i => i.effect_type === 'dice_chance' && i.uses_remaining > 0)
      if (idx >= 0) { if (updated[idx].uses_remaining > 1) updated[idx] = { ...updated[idx], uses_remaining: updated[idx].uses_remaining - 1 }; else updated.splice(idx, 1) }
    }
  }
  let msg = `🎲 ${author}(${myDice}) vs 봇(${botDice})\n`
  if (myDice > botDice) {
    let winAmt = amount, doubleUsed = false
    if (doubleItem && doubleItem.uses_remaining > 0) {
      winAmt = amount * 2; doubleUsed = true
      const idx = updated.findIndex(i => i.effect_type === 'dice_double' && i.uses_remaining > 0)
      if (idx >= 0) { if (updated[idx].uses_remaining > 1) updated[idx] = { ...updated[idx], uses_remaining: updated[idx].uses_remaining - 1 }; else updated.splice(idx, 1) }
    }
    user.balance += winAmt
    user.exp += cfg.diceWinExp || 10
    user.active_items = updated
    if (chanceUsed) msg += `🎯 확률 아이템 사용!\n`
    if (doubleUsed) msg += `💎 두배 보상! (${amount.toLocaleString()}→${winAmt.toLocaleString()})\n`
    msg += `🎉 승리! +₩${winAmt.toLocaleString()}원\n💰 잔액: ₩${user.balance.toLocaleString()}원`
  } else if (myDice < botDice) {
    user.balance -= amount
    user.exp = Math.max(0, user.exp + (cfg.diceLoseExp || -2))
    user.active_items = updated
    msg += `😢 패배 -₩${amount.toLocaleString()}원\n💰 잔액: ₩${user.balance.toLocaleString()}원`
  } else {
    user.active_items = updated
    msg += `🤝 무승부\n💰 잔액: ₩${user.balance.toLocaleString()}원`
  }
  _fishCheckLevelUp(user)
  saveFishingUser(djId, fishing)
  fishReply(djId, msg)
}

async function fishCmdOddEven(djId, settings, author, tag, parts, isOdd) {
  const fishing = getFishingSettings(djId, settings)
  const cfg = fishing.config
  if (!cfg.enabled) return
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const amount = parseInt(parts[1]) || 0
  if (amount <= 0) { fishReply(djId, `🎯 사용법: ${isOdd ? '!홀' : '!짝'} [금액]`); return }
  const user = getFishingUser(fishing, tag, author)
  if (user.balance < amount) { fishReply(djId, '💸 잔액 부족'); return }
  const items = _fishActiveItems(user)
  const oeItem = items.find(i => i.effect_type === 'oddeven_chance')
  const num = Math.floor(Math.random() * 10) + 1
  const resultIsOdd = num % 2 === 1
  let win = (isOdd && resultIsOdd) || (!isOdd && !resultIsOdd)
  if (win && Math.random() < 0.1) win = false
  let itemUsed = false
  if (!win && oeItem && oeItem.uses_remaining > 0 && Math.random() < (oeItem.effect_value / 100)) {
    win = true; itemUsed = true
    const updated = [...user.active_items]
    const idx = updated.findIndex(i => i.effect_type === 'oddeven_chance' && i.uses_remaining > 0)
    if (idx >= 0) { if (updated[idx].uses_remaining > 1) updated[idx] = { ...updated[idx], uses_remaining: updated[idx].uses_remaining - 1 }; else updated.splice(idx, 1) }
    user.active_items = updated
  }
  let msg = `🎯 홀짝 게임\n결과: ${num} (${resultIsOdd ? '홀' : '짝'})\n선택: ${isOdd ? '홀' : '짝'}\n`
  if (win) {
    user.balance += amount
    if (itemUsed) msg += `🎯 확률 아이템 사용! 패배→승리 전환!\n`
    msg += `🎉 승리! +₩${amount.toLocaleString()}원\n💰 잔액: ₩${user.balance.toLocaleString()}원`
  } else {
    user.balance -= amount
    msg += `😢 패배 -₩${amount.toLocaleString()}원\n💰 잔액: ₩${user.balance.toLocaleString()}원`
  }
  saveFishingUser(djId, fishing)
  fishReply(djId, msg)
}

async function fishCmdShop(djId, settings) {
  const fishing = getFishingSettings(djId, settings)
  const products = _fishParseShop(fishing.config.shopProducts)
  if (products.length === 0) { fishReply(djId, '🏪 상품 없음'); return }
  let msg = '🏪 상점\n'
  products.forEach((p, i) => { msg += `${i + 1}. ${p.name} ₩${p.price.toLocaleString()}원\n` })
  msg += '!구매 [번호]'
  fishReply(djId, msg)
}

async function fishCmdItemShop(djId, settings) {
  const fishing = getFishingSettings(djId, settings)
  const items = _fishParseItemShop(fishing.config.itemShop)
  if (items.length === 0) { fishReply(djId, '🏪 아이템이 없습니다'); return }
  let msg = '🏪 아이템 상점\n'
  items.forEach((it, i) => { const price = it.price_type === 'points' ? `🅿️${it.price.toLocaleString()}포인트` : `💰${it.price.toLocaleString()}원`; msg += `${i + 1}. ${it.name} ${price}\n` })
  msg += '!아이템구매 [번호]'
  fishReply(djId, msg)
}

async function fishCmdPurchase(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const idx = parseInt(parts[1])
  if (!idx || idx < 1) { fishReply(djId, '!구매 [번호]'); return }
  const products = _fishParseShop(fishing.config.shopProducts)
  const product = products[idx - 1]
  if (!product) { fishReply(djId, '❌ 없는 상품'); return }
  const user = getFishingUser(fishing, tag, author)
  if (user.balance < product.price) { fishReply(djId, '💸 잔액 부족'); return }
  user.balance -= product.price
  if (!user.inventory) user.inventory = {}
  user.inventory[product.name] = (user.inventory[product.name] || 0) + 1
  saveFishingUser(djId, fishing)
  fishReply(djId, `✅ ${product.name} 구매 완료!\n💰 잔액: ₩${user.balance.toLocaleString()}원`)
}

async function fishCmdItemPurchase(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const idx = parseInt(parts[1])
  if (!idx || idx < 1) { fishReply(djId, '!아이템구매 [번호]'); return }
  const items = _fishParseItemShop(fishing.config.itemShop)
  const item = items[idx - 1]
  if (!item) { fishReply(djId, '❌ 없는 아이템'); return }
  const user = getFishingUser(fishing, tag, author)
  if (item.price_type === 'points') { if ((user.heart_points || 0) < item.price) { fishReply(djId, `💸 포인트 부족 (필요: 🅿️${item.price.toLocaleString()})`); return } }
  else { if (user.balance < item.price) { fishReply(djId, `💸 잔액 부족 (필요: ₩${item.price.toLocaleString()})`); return } }
  if (!user.active_items) user.active_items = []
  const now = new Date()
  const expiresAt = item.duration_minutes > 0 ? new Date(Date.now() + item.duration_minutes * 60000).toISOString() : null
  user.active_items.push({ item_name: item.name, effect_type: item.effect_type, effect_value: item.effect_value, expires_at: expiresAt, uses_remaining: item.uses || 0, started_at: now.toISOString() })
  if (item.price_type === 'points') user.heart_points = (user.heart_points || 0) - item.price
  else user.balance -= item.price
  saveFishingUser(djId, fishing)
  let msg = `✅ ${item.name} 구매 완료!\n`
  msg += item.price_type === 'points' ? `⭐ 포인트: 🅿️${user.heart_points.toLocaleString()}포인트` : `💰 잔액: ₩${user.balance.toLocaleString()}원`
  if (item.duration_minutes > 0) msg += `\n⏰ 지속시간: ${item.duration_minutes}분`
  if (item.uses > 0) msg += `\n🎫 사용 횟수: ${item.uses}회`
  fishReply(djId, msg)
}

async function fishCmdTransfer(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const targetTag = (parts[1] || '').replace(/^@/, '')
  const amount = parseInt(parts[2]) || 0
  if (!targetTag || !amount) { fishReply(djId, '사용법: !송금 [고유닉] [금액]'); return }
  if (amount <= 0) { fishReply(djId, '❌ 0보다 큰 금액'); return }
  if (targetTag.toLowerCase() === tag.toLowerCase()) { fishReply(djId, '❌ 자기 자신에겐 송금할 수 없습니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  if (user.balance < amount) { fishReply(djId, '💸 잔액 부족'); return }
  const target = fishing.users[targetTag]
  if (!target) { fishReply(djId, `❌ ${targetTag} 유저 없음 (낚시를 한 번이라도 한 사람만 송금 가능)`); return }
  user.balance -= amount
  target.balance = (target.balance || 0) + amount
  saveFishingUser(djId, fishing)
  fishReply(djId, `💸 ${target.nickname}님께 ₩${amount.toLocaleString()}원 송금\n💰 잔액: ₩${user.balance.toLocaleString()}원`)
}

async function fishCmdTheft(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  const cfg = fishing.config
  if (!cfg.enabled) return
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const dedupKey = '도둑:' + tag + ':' + (parts.slice(1).join(' ') || '')
  if (_fishIsDuplicateCall(dedupKey, 3000)) return
  const targetTag = (parts[1] || '').replace(/^@/, '')
  const amount = parseInt(parts[2]) || 0
  if (!targetTag || !amount) { fishReply(djId, '사용법: !도둑 [고유닉] [금액]'); return }
  if (amount <= 0) { fishReply(djId, '❌ 0보다 큰 금액'); return }
  if (targetTag.toLowerCase() === tag.toLowerCase()) { fishReply(djId, '❌ 자기 자신은 도둑질할 수 없습니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  const target = fishing.users[targetTag]
  if (!target) { fishReply(djId, `❌ ${targetTag} 유저 없음`); return }
  const baseRate = (cfg.theftBaseRate || 5) / 100, lvlBonus = (cfg.theftLevelBonus || 0.5) / 100, maxRate = (cfg.theftMaxRate || 70) / 100
  const rate = Math.min(maxRate, baseRate + (user.level - 1) * lvlBonus)
  const success = Math.random() < rate
  if (success) {
    if ((target.balance || 0) < amount) { fishReply(djId, `❌ ${target.nickname}님의 잔액이 부족합니다`); return }
    user.balance += amount
    target.balance -= amount
    saveFishingUser(djId, fishing)
    fishReply(djId, `🎉 도둑 성공! (성공률 ${Math.round(rate * 100)}%) ${target.nickname}님에게서 ₩${amount.toLocaleString()}원 훔침!\n💰 잔액: ₩${user.balance.toLocaleString()}원`)
  } else {
    const penalty = amount * 2
    if (user.balance < penalty) { fishReply(djId, `❌ 도둑 실패 시 벌금(₩${penalty.toLocaleString()})을 낼 잔액이 부족`); return }
    user.balance -= penalty
    target.balance = (target.balance || 0) + penalty
    saveFishingUser(djId, fishing)
    fishReply(djId, `😢 도둑 실패! (성공률 ${Math.round(rate * 100)}%) ${target.nickname}님에게 벌금 ₩${penalty.toLocaleString()}원 지불\n💰 잔액: ₩${user.balance.toLocaleString()}원`)
  }
}

async function fishCmdFishBook(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  saveFishingUser(djId, fishing)
  const all = { ...(user.caught_fish || {}), ...(user.event_fish_catches || {}) }
  const names = Object.keys(all)
  if (names.length === 0) { fishReply(djId, '🐟 잡은 물고기 없음'); return }
  const rarityIcons = { common: '⚪', uncommon: '🟢', rare: '🔵', epic: '🟣', legendary: '🟡' }
  const lookup = {}
  _fishParseFishList(fishing.config.fishList).forEach(f => { lookup[f.name] = { rarity: f.rarity, isEvent: false } })
  _fishParseFishList(fishing.config.eventFishList).forEach(f => { lookup[f.name] = { rarity: f.rarity, isEvent: true } })
  let msg = `📚 ${author}의 도감 (${user.total_fish_count}마리)\n\n`
  names.slice(0, 12).forEach(name => { const info = lookup[name] || { rarity: 'common', isEvent: false }; msg += `${rarityIcons[info.rarity] || '⚪'} ${info.isEvent ? '🎁' : '🐟'} ${name} ${all[name]}마리\n` })
  if (names.length > 12) msg += `\n외 ${names.length - 12}종`
  fishReply(djId, msg.trim())
}

async function fishCmdFishBookShare(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  saveFishingUser(djId, fishing)
  const all = { ...(user.caught_fish || {}), ...(user.event_fish_catches || {}) }
  const names = Object.keys(all)
  if (names.length === 0) { fishReply(djId, '🐟 잡은 물고기 없음'); return }
  const lookup = {}
  _fishParseFishList(fishing.config.fishList).forEach(f => { lookup[f.name] = f.rarity })
  _fishParseFishList(fishing.config.eventFishList).forEach(f => { lookup[f.name] = f.rarity })
  const counts = { legendary: 0, epic: 0, rare: 0, uncommon: 0, common: 0 }
  names.forEach(n => { counts[lookup[n] || 'common']++ })
  let msg = `🎣 ${author}님의 도감 공유\n\n총 ${user.total_fish_count}마리 낚음\n물고기 종류: ${names.length}종\n\n🏆 희귀도별 보유\n`
  if (counts.legendary > 0) msg += `🟡전설: ${counts.legendary}종\n`
  if (counts.epic > 0) msg += `🟣영웅: ${counts.epic}종\n`
  if (counts.rare > 0) msg += `🔵희귀: ${counts.rare}종\n`
  if (counts.uncommon > 0) msg += `🟢고급: ${counts.uncommon}종\n`
  if (counts.common > 0) msg += `⚪일반: ${counts.common}종`
  fishReply(djId, msg.trim())
}

async function fishCmdLoan(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const amount = parseInt(parts[1]) || 0
  if (amount <= 0) { fishReply(djId, '사용법: !대출 [금액]'); return }
  const user = getFishingUser(fishing, tag, author)
  if (user.loan_amount > 0) { fishReply(djId, `이미 대출이 있습니다 (₩${user.loan_amount.toLocaleString()}). 먼저 상환하세요.`); return }
  const tiers = _fishCreditTiers(fishing.config)
  const tier = tiers.find(t => t.rating === user.credit_rating) || tiers[0]
  if (amount > tier.loan_limit) { fishReply(djId, `신용등급 ${'⭐'.repeat(user.credit_rating)} 대출 한도: ₩${tier.loan_limit.toLocaleString()}`); return }
  const due = new Date(); due.setDate(due.getDate() + 3)
  user.balance += amount
  user.loan_amount = amount
  user.loan_date = new Date().toISOString()
  saveFishingUser(djId, fishing)
  const dueStr = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
  fishReply(djId, `✅ ₩${amount.toLocaleString()}원 대출 승인\n만기일: ${dueStr}\n잔액: ₩${user.balance.toLocaleString()}원`)
}

async function fishCmdRepay(djId, settings, author, tag, parts) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const amount = parseInt(parts[1]) || 0
  if (amount <= 0) { fishReply(djId, '사용법: !상환 [금액]'); return }
  const user = getFishingUser(fishing, tag, author)
  if (!user.loan_amount) { fishReply(djId, '상환할 대출이 없습니다.'); return }
  const repay = Math.min(amount, user.loan_amount)
  if (user.balance < repay) { fishReply(djId, `잔액 부족 (보유: ₩${user.balance.toLocaleString()})`); return }
  user.balance -= repay
  user.loan_amount -= repay
  if (user.loan_amount === 0) user.loan_date = null
  saveFishingUser(djId, fishing)
  fishReply(djId, `✅ ₩${repay.toLocaleString()}원 상환\n남은 대출: ₩${user.loan_amount.toLocaleString()}원\n잔액: ₩${user.balance.toLocaleString()}원`)
}

async function fishCmdCreditInfo(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  const tiers = _fishCreditTiers(fishing.config)
  _fishRecalcCredit(user, tiers)
  saveFishingUser(djId, fishing)
  const tier = tiers.find(t => t.rating === user.credit_rating)
  const next = tiers.find(t => t.rating === user.credit_rating + 1)
  let msg = `💳 ${author}님의 신용 정보\n신용등급: ${'⭐'.repeat(user.credit_rating)}\n대출 한도: ₩${(tier && tier.loan_limit || 0).toLocaleString()}원\n`
  msg += user.loan_amount > 0 ? `현재 대출: ₩${user.loan_amount.toLocaleString()}원\n` : `현재 대출 없음\n`
  msg += `신용 점수: 🅿️${user.heart_points || 0}포인트`
  if (next) { const need = next.required_points - (user.heart_points || 0); if (need > 0) msg += `\n다음 등급까지: 🅿️${need}포인트` }
  fishReply(djId, msg)
}

async function fishCmdCollections(djId, settings, author, tag) {
  const fishing = getFishingSettings(djId, settings)
  if (!tag) { fishReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFishingUser(fishing, tag, author)
  saveFishingUser(djId, fishing)
  const collections = _fishParseCollections(fishing.config.collections)
  if (collections.length === 0) { fishReply(djId, '📚 등록된 컬렉션이 없습니다'); return }
  const all = { ...(user.caught_fish || {}), ...(user.event_fish_catches || {}) }
  let msg = `📚 ${author}님의 컬렉션\n\n`
  collections.forEach(c => {
    const have = c.required_fish.filter(n => all[n] > 0)
    const done = have.length === c.required_fish.length
    msg += done ? `✅ ${c.name} (완성!)\n` : `📋 ${c.name} (${have.length}/${c.required_fish.length})\n`
    if (!done) {
      const preview = c.required_fish.slice(0, 3).map(n => all[n] > 0 ? `✔${n}` : n).join(', ')
      msg += `   필요: ${preview}`
      if (c.required_fish.length > 3) msg += ` 외 ${c.required_fish.length - 3}종`
      msg += '\n'
    }
  })
  fishReply(djId, msg.trim())
}

async function fishCmdGiveMoney(djId, room, settings, author, authorId, parts) {
  const fishing = getFishingSettings(djId, settings)
  if (!fishing.config.enabled) return
  if (!_fishIsDj(djId, room, settings, authorId, author)) { fishReply(djId, '❌ 디제이 전용 명령어입니다.'); return }
  const dedupKey = '돈주기:' + (author || 'dj') + ':' + (parts.slice(1).join(' ') || '')
  if (_fishIsDuplicateCall(dedupKey, 3000)) return
  const targetTag = (parts[1] || '').replace(/^@/, '')
  const amount = parseInt(parts[2]) || 0
  if (!targetTag || !amount) { fishReply(djId, '사용법: !돈주기 [고유닉] [금액]'); return }
  if (amount <= 0) { fishReply(djId, '❌ 0보다 큰 금액'); return }
  let target = fishing.users[targetTag]
  if (!target) { target = _fishNewUser(targetTag); fishing.users[targetTag] = target }
  target.balance = (target.balance || 0) + amount
  saveFishingUser(djId, fishing)
  fishReply(djId, `🎁 [DJ] ${target.nickname}님께 ₩${amount.toLocaleString()}원 입금 완료\n💰 ${target.nickname} 잔액: ₩${target.balance.toLocaleString()}원`)
}

function fishCmdHelp(djId) {
  let msg = '🎣 낚시 게임 명령어\n!낚시 / !돈줘 / !잔액 / !상태 / !지갑 / !레벨\n!도감 / !도감공유 / !컬렉션\n!상점 / !구매 [번호] / !아이템상점 / !아이템구매 [번호]\n!슬롯 [금액] / !주사위 [금액] / !홀 [금액] / !짝 [금액]\n!송금 [고유닉] [금액] / !도둑 [고유닉] [금액]\n!대출 [금액] / !상환 [금액] / !신용정보'
  fishReply(djId, msg)
}

// ── 채팅 이벤트 마스터 디스패처 ──
async function handleFishingCommand(djId, room, settings, author, authorId, liveId, text) {
  if (!isModuleOn(settings, 'fishing', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const parts = msg.split(/\s+/)
  const cmd = parts[0]

  const FISH_CMDS = ['!낚시', '!돈줘', '!잔액', '!상태', '!지갑', '!레벨', '!도감', '!도감공유', '!상점', '!구매', '!아이템상점', '!아이템구매', '!슬롯', '!주사위', '!홀', '!짝', '!송금', '!도둑', '!돈주기', '!대출', '!상환', '!신용정보', '!컬렉션', '!낚시도움말', '!낚시명령어']
  if (!FISH_CMDS.includes(cmd)) return

  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const tag = await getCachedUserTag(room, liveId, authorId, accessToken)
  if (tag) rememberTagNickname(room, tag, author)

  switch (cmd) {
    case '!낚시': return fishCmdFishing(djId, room, settings, author, tag)
    case '!돈줘': return fishCmdDailyMoney(djId, settings, author, tag)
    case '!잔액': return fishCmdBalance(djId, settings, author, tag)
    case '!상태': return fishCmdStatus(djId, settings, author, tag)
    case '!지갑': return fishCmdWallet(djId, settings)
    case '!레벨': return fishCmdLevel(djId, settings, author, tag)
    case '!도감': return fishCmdFishBook(djId, settings, author, tag)
    case '!도감공유': return fishCmdFishBookShare(djId, settings, author, tag)
    case '!상점': return fishCmdShop(djId, settings)
    case '!구매': return fishCmdPurchase(djId, settings, author, tag, parts)
    case '!아이템상점': return fishCmdItemShop(djId, settings)
    case '!아이템구매': return fishCmdItemPurchase(djId, settings, author, tag, parts)
    case '!슬롯': return fishCmdSlot(djId, settings, author, tag, parts)
    case '!주사위': return fishCmdDice(djId, settings, author, tag, parts)
    case '!홀': return fishCmdOddEven(djId, settings, author, tag, parts, true)
    case '!짝': return fishCmdOddEven(djId, settings, author, tag, parts, false)
    case '!송금': return fishCmdTransfer(djId, settings, author, tag, parts)
    case '!도둑': return fishCmdTheft(djId, settings, author, tag, parts)
    case '!돈주기': return fishCmdGiveMoney(djId, room, settings, author, authorId, parts)
    case '!대출': return fishCmdLoan(djId, settings, author, tag, parts)
    case '!상환': return fishCmdRepay(djId, settings, author, tag, parts)
    case '!신용정보': return fishCmdCreditInfo(djId, settings, author, tag)
    case '!컬렉션': return fishCmdCollections(djId, settings, author, tag)
    case '!낚시도움말': case '!낚시명령어': return fishCmdHelp(djId)
  }
}


// ══════════════════════════════════════════════════════
// 🎣 팝블리네 낚시대회 — 낚시 게임과는 완전히 별개인 신규 모듈.
// DJ가 미끼목록과 미끼별 룰렛(1~10)을 채워두면, 관리자가 시청자에게 미끼(룰렛권)를
// 지급하고 시청자는 미끼 사용 명령어로 룰렛을 돌려 어항(킵, 1~10)에 결과를 기록한다.
// (예전엔 사용비번을 입력해야 동작했지만, 그 게이트는 관리자 설정 화면과 함께 완전히 제거됐고
//  이제 사이드바 모듈 ON/OFF만으로 동작한다. 기본값도 다른 신규모듈과 달리 기본 ON으로 켜둠.)
// ══════════════════════════════════════════════════════

const FT_KEEP_SLOTS = 10
const FT_ROULETTE_SLOTS = 10

function getFishTournamentSettings(djId, settings) {
  if (!settings.fishtournament) {
    settings.fishtournament = {
      config: {
        enabled: true,
        shopTitle: '🎣 미끼상점 🎣',
        startCommand: '낚시시작',
        shopCommand: '미끼상점',
        voucherCommand: '미끼보유',
        myCatchCommand: '내물고기',
        giveCommand: '미끼지급',
        listCommand: '유저목록',
        resetCommand: '유저초기화',
        logCommand: '룰렛기록',
        helpCommand: '낚시도움말',
        baits: [
          { name: '갯지렁이', cmd: '갯지렁이', priceLabel: '무료하트10', rouletteIdx: 1 },
          { name: '새우', cmd: '새우', priceLabel: '10스푼', rouletteIdx: 2 },
          { name: '마시기1', cmd: '마시기1', priceLabel: '50스푼', rouletteIdx: 3 },
          { name: '마시기2', cmd: '마시기2', priceLabel: '100스푼', rouletteIdx: 4 },
        ],
        rankCommand: '낚시왕',
        rankTitle: '팝블리네 낚시랭킹',
        rankTopN: 5,
        giveAdminOnly: true,
        staffFreeSpin: false,
      },
      users: {}, // { tag: { tag, nickname, vouchers:{}, tanks:{}, registeredAt } }
      logs: {},  // { [rouletteIdx]: [{tag,nickname,content,score,keepIdx,at}, ...] }
    }
    for (let i = 1; i <= FT_ROULETTE_SLOTS; i++) settings.fishtournament.config['roulette' + i] = []
    for (let i = 1; i <= FT_KEEP_SLOTS; i++) settings.fishtournament.config['keep' + i + 'Name'] = '어항' + i
    store.saveSettings(djId, { fishtournament: settings.fishtournament })
  }
  if (!settings.fishtournament.config) settings.fishtournament.config = {}
  if (!settings.fishtournament.users) settings.fishtournament.users = {}
  if (!settings.fishtournament.logs) settings.fishtournament.logs = {}
  return settings.fishtournament
}

function saveFishTournament(djId, ft) {
  store.saveSettings(djId, { fishtournament: ft })
}

function _ftSplitLines(text) {
  if (!text || typeof text !== 'string') return []
  return text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
}
function _ftParseBaitList(text) {
  return _ftSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 4 || !p[0] || !p[1]) return null
    const idx = parseInt(p[3], 10)
    if (!idx || idx < 1 || idx > FT_ROULETTE_SLOTS) return null
    return { name: p[0], cmd: p[1], priceLabel: p[2] || '', rouletteIdx: idx }
  }).filter(Boolean)
}
function _ftParseRouletteTable(text) {
  return _ftSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 3 || !p[0]) return null
    const score = parseInt(p[1], 10) || 0
    const chance = parseFloat(p[2]) || 0
    if (chance <= 0) return null
    let keepIdx = parseInt(p[3], 10)
    if (!keepIdx || keepIdx < 1 || keepIdx > FT_KEEP_SLOTS) keepIdx = 1
    return { content: p[0], score, chance, keepIdx }
  }).filter(Boolean)
}
// baits는 새 버전부터 배열(cfg.baits)로 저장된다. 과거 텍스트(cfg.baitList) 데이터가 남아있으면 그걸로 폴백한다.
function _ftGetBaitList(cfg) {
  if (Array.isArray(cfg.baits)) {
    return cfg.baits.map(b => {
      const idx = Math.min(FT_ROULETTE_SLOTS, Math.max(1, parseInt(b.rouletteIdx, 10) || 1))
      return { name: String(b.name || '').trim(), cmd: String(b.cmd || '').trim(), priceLabel: String(b.priceLabel || ''), rouletteIdx: idx }
    }).filter(b => b.name && b.cmd)
  }
  return _ftParseBaitList(cfg.baitList)
}
function _ftFindBaitByCmd(baits, cmdRaw) {
  const c = String(cmdRaw || '').toLowerCase()
  return baits.find(b => b.cmd.toLowerCase() === c) || null
}
function _ftFindBaitByName(baits, nameRaw) {
  const n = String(nameRaw || '').trim()
  return baits.find(b => b.name === n) || baits.find(b => b.name.toLowerCase() === n.toLowerCase()) || null
}
// 룰렛 항목도 새 버전부터 배열로 저장된다. 과거 텍스트 데이터가 남아있으면 그걸로 폴백한다.
function _ftGetRouletteTable(cfg, idx) {
  const val = cfg['roulette' + idx]
  if (Array.isArray(val)) {
    return val.map(r => {
      const keepIdx = Math.min(FT_KEEP_SLOTS, Math.max(1, parseInt(r.keepIdx, 10) || 1))
      return { content: String(r.content || '').trim(), score: parseInt(r.score, 10) || 0, chance: parseFloat(r.chance) || 0, keepIdx }
    }).filter(r => r.content && r.chance > 0)
  }
  return _ftParseRouletteTable(val)
}
function _ftSpinRoulette(table) {
  if (!table.length) return null
  const total = table.reduce((s, f) => s + f.chance, 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const f of table) { roll -= f.chance; if (roll <= 0) return f }
  return table[table.length - 1]
}

function getFtUser(ft, tag, nickname) {
  if (!tag) return null
  if (!ft.users[tag]) ft.users[tag] = { tag, nickname: nickname || tag, vouchers: {}, tanks: {}, registeredAt: new Date().toISOString() }
  else if (nickname && ft.users[tag].nickname !== nickname) ft.users[tag].nickname = nickname
  return ft.users[tag]
}
function _ftEnsureTank(user, idx) {
  const k = String(idx)
  if (!user.tanks[k]) user.tanks[k] = { items: {}, total: 0 }
  return user.tanks[k]
}
function _ftAppendLog(djId, ft, idx, entry) {
  const key = String(idx)
  if (!Array.isArray(ft.logs[key])) ft.logs[key] = []
  ft.logs[key].push(entry)
  if (ft.logs[key].length > 50) ft.logs[key] = ft.logs[key].slice(ft.logs[key].length - 50)
}

function ftReply(djId, msg) { sendChatSplit(djId, msg, 150, 500) }

function _ftIsAdmin(cfg, isDj, isManager) {
  if (cfg.giveAdminOnly === false) return true
  return !!(isDj || isManager)
}
function _ftIsStaff(cfg, isDj) {
  if (cfg.staffFreeSpin !== true) return false
  return !!isDj
}

// 닉네임/고유닉으로 대상을 찾는다: 저장된 낚시대회 유저 중 매칭, 없으면 입력값을 고유닉으로 간주
function _ftResolveTarget(ft, identifier) {
  if (!identifier) return null
  const stripped = identifier.replace(/^@/, '')
  const all = Object.values(ft.users)
  const found = all.find(u => u.tag === stripped || u.nickname === identifier)
  if (found) return { tag: found.tag, nickname: found.nickname }
  return { tag: stripped, nickname: identifier }
}

async function ftCmdStart(djId, ft, author, tag) {
  if (!tag) { ftReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const shopCmd = ft.config.shopCommand || '미끼상점'
  const existing = ft.users[tag]
  const user = getFtUser(ft, tag, author)
  saveFishTournament(djId, ft)
  if (existing) ftReply(djId, `🎣 ${author}님은 이미 낚시대회에 등록되어 있어요! (!${shopCmd} 로 미끼 목록 확인)`)
  else ftReply(djId, `🎣 ${author}님, 낚시대회 등록 완료! DJ에게 미끼를 지급받으면 낚시를 시작할 수 있어요. (!${shopCmd} 로 미끼 목록 확인)`)
}

async function ftCmdShop(djId, ft) {
  const baits = _ftGetBaitList(ft.config)
  if (!baits.length) { ftReply(djId, '❌ 등록된 미끼가 없습니다. ⚙️ 설정에서 미끼목록을 채워주세요.'); return }
  const title = ft.config.shopTitle || '🎣 미끼상점 🎣'
  let msg = title + '\n'
  baits.forEach(b => { msg += `${b.name} : ${b.priceLabel}\n` })
  ftReply(djId, msg.trim())
}

async function ftCmdMyVouchers(djId, ft, author, tag) {
  if (!tag) { ftReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const baits = _ftGetBaitList(ft.config)
  const user = getFtUser(ft, tag, author)
  const owned = baits.filter(b => (user.vouchers[b.cmd.toLowerCase()] || 0) > 0)
  if (!owned.length) { ftReply(djId, `🎒 ${author}님이 보유한 미끼가 없습니다.`); return }
  let msg = `🎒 ${author}님의 보유 미끼\n`
  owned.forEach(b => { msg += `${b.name}(!${b.cmd}) : ${user.vouchers[b.cmd.toLowerCase()]}개\n` })
  ftReply(djId, msg.trim())
}

async function ftCmdGiveBait(djId, ft, author, isDj, isManager, parts) {
  if (!_ftIsAdmin(ft.config, isDj, isManager)) { ftReply(djId, '❌ 이 명령어는 DJ/매니저만 사용할 수 있습니다.'); return }
  const giveCmd = ft.config.giveCommand || '미끼지급'
  const shopCmd = ft.config.shopCommand || '미끼상점'
  const targetRaw = parts[1], baitNameRaw = parts[2]
  const count = parseInt(parts[3], 10) || 1
  if (!targetRaw || !baitNameRaw) { ftReply(djId, `사용법: !${giveCmd} [닉네임 또는 @고유닉] [미끼이름] [개수(생략시 1)]`); return }
  const baits = _ftGetBaitList(ft.config)
  const bait = _ftFindBaitByName(baits, baitNameRaw)
  if (!bait) { ftReply(djId, `❌ "${baitNameRaw}" 라는 미끼를 찾을 수 없습니다. !${shopCmd} 으로 확인해주세요.`); return }
  const target = _ftResolveTarget(ft, targetRaw)
  if (!target || !target.tag) { ftReply(djId, '❌ 대상을 찾을 수 없습니다.'); return }
  const user = getFtUser(ft, target.tag, target.nickname)
  const key = bait.cmd.toLowerCase()
  user.vouchers[key] = (user.vouchers[key] || 0) + count
  saveFishTournament(djId, ft)
  ftReply(djId, `✅ ${user.nickname}님에게 [${bait.name}] 미끼 ${count}개 지급 완료 (보유: ${user.vouchers[key]}개)`)
}

async function ftCmdResetUser(djId, ft, isDj, isManager, parts) {
  if (!_ftIsAdmin(ft.config, isDj, isManager)) { ftReply(djId, '❌ 이 명령어는 DJ/매니저만 사용할 수 있습니다.'); return }
  const resetCmd = ft.config.resetCommand || '유저초기화'
  const targetRaw = parts[1]
  if (!targetRaw) { ftReply(djId, `사용법: !${resetCmd} [닉네임 또는 @고유닉] · 전체 초기화는 !${resetCmd} 전체`); return }
  if (targetRaw === '전체' || targetRaw.toLowerCase() === 'all') {
    const users = Object.values(ft.users)
    if (!users.length) { ftReply(djId, '❌ 등록된 유저가 없습니다.'); return }
    users.forEach(u => { u.vouchers = {}; u.tanks = {} })
    saveFishTournament(djId, ft)
    ftReply(djId, `✅ 등록된 유저 ${users.length}명 전체의 미끼 보유량/어항 기록을 초기화했습니다.`)
    return
  }
  const target = _ftResolveTarget(ft, targetRaw)
  const user = target && ft.users[target.tag]
  if (!user) { ftReply(djId, `❌ "${targetRaw}" 님은 등록된 유저가 아닙니다.`); return }
  user.vouchers = {}; user.tanks = {}
  saveFishTournament(djId, ft)
  ftReply(djId, `✅ ${user.nickname || target.tag}님의 미끼 보유량과 어항 기록을 초기화했습니다. (등록은 유지됨)`)
}

async function ftCmdUserList(djId, ft, isDj, isManager) {
  if (!_ftIsAdmin(ft.config, isDj, isManager)) { ftReply(djId, '❌ 이 명령어는 DJ/매니저만 사용할 수 있습니다.'); return }
  const users = Object.values(ft.users)
  if (!users.length) { const startCmd = ft.config.startCommand || '낚시시작'; ftReply(djId, `👥 아직 등록된 유저가 없습니다. 시청자에게 !${startCmd} 을 안내해주세요.`); return }
  const sorted = users.slice().sort((a, b) => new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0))
  const LIMIT = 30
  const shown = sorted.slice(0, LIMIT)
  let msg = `👥 등록된 낚시 유저 (총 ${users.length}명, 최근 등록순${users.length > LIMIT ? `, 상위 ${LIMIT}명 표시` : ''})\n`
  shown.forEach((u, i) => {
    const totalVouchers = Object.values(u.vouchers || {}).reduce((s, n) => s + (n || 0), 0)
    const tag = totalVouchers > 0 ? `보유 미끼 ${totalVouchers}개` : '미지급'
    msg += `${i + 1}. ${u.nickname || u.tag} (@${u.tag}) - ${tag}\n`
  })
  ftReply(djId, msg.trim())
}

async function ftCmdRouletteLog(djId, ft, isDj, isManager, parts) {
  if (!_ftIsAdmin(ft.config, isDj, isManager)) { ftReply(djId, '❌ 이 명령어는 DJ/매니저만 사용할 수 있습니다.'); return }
  const logCmd = ft.config.logCommand || '룰렛기록'
  const idx = parseInt(parts[1], 10)
  if (!idx || idx < 1 || idx > FT_ROULETTE_SLOTS) { ftReply(djId, `사용법: !${logCmd} [1~${FT_ROULETTE_SLOTS}]`); return }
  const log = ft.logs[String(idx)]
  if (!Array.isArray(log) || !log.length) { ftReply(djId, `📜 ${idx}번 룰렛 기록이 없습니다.`); return }
  const recent = log.slice(-10).reverse()
  let msg = `📜 ${idx}번 룰렛 최근 기록 (최대 10개)\n`
  recent.forEach(e => { msg += `${e.nickname} → ${e.content} (${e.score}점)\n` })
  ftReply(djId, msg.trim())
}

function ftCmdHelp(djId, ft) {
  const baits = _ftGetBaitList(ft.config)
  const rankCmd = ft.config.rankCommand || '낚시왕'
  const startCmd = ft.config.startCommand || '낚시시작'
  const shopCmd = ft.config.shopCommand || '미끼상점'
  const voucherCmd = ft.config.voucherCommand || '미끼보유'
  const myCatchCmd = ft.config.myCatchCommand || '내물고기'
  const giveCmd = ft.config.giveCommand || '미끼지급'
  const resetCmd = ft.config.resetCommand || '유저초기화'
  const listCmd = ft.config.listCommand || '유저목록'
  const logCmd = ft.config.logCommand || '룰렛기록'
  let msg = '🎣 팝블리네 낚시대회 명령어\n'
  msg += `!${startCmd} - 낚시대회 참가 등록\n`
  msg += `!${shopCmd} - 미끼 목록/가격 보기\n`
  msg += `!${voucherCmd} - 내가 보유한 미끼 보기\n`
  msg += `!${myCatchCmd} - 내가 잡은 물고기 전체 보기 (모든 어항 합산)\n`
  if (baits.length) msg += '미끼 사용(낚시): ' + baits.map(b => `!${b.cmd} [횟수]`).join(', ') + '\n'
  for (let i = 1; i <= FT_KEEP_SLOTS; i++) { const name = ft.config['keep' + i + 'Name']; if (name) msg += `!${name} - 내 어항(${i}번) 보기\n` }
  msg += `!${rankCmd} - 낚시 랭킹 보기 (전체 어항 합산, "!${rankCmd} [번호]"로 특정 어항만 보기)\n`
  msg += `(관리자) !${giveCmd} [대상] [미끼이름] [개수], !${resetCmd} [대상|전체], !${listCmd}, !${logCmd} [룰렛번호]`
  ftReply(djId, msg)
}

async function _ftHandleBaitSpin(djId, ft, author, tag, isDj, bait, parts) {
  if (!tag) { ftReply(djId, '❌ 고유닉이 있어야 낚시를 할 수 있습니다.'); return }
  const user = getFtUser(ft, tag, author)
  const key = bait.cmd.toLowerCase()
  const have = user.vouchers[key] || 0
  const staff = _ftIsStaff(ft.config, isDj)
  let requested = parseInt(parts[1], 10)
  if (!requested || requested < 1) requested = 1
  requested = Math.min(requested, 100)
  let spins
  if (staff) spins = requested
  else {
    if (have <= 0) { const shopCmd = ft.config.shopCommand || '미끼상점'; ftReply(djId, `❌ [${bait.name}] 미끼가 없습니다. !${shopCmd} 을 확인해주세요.`); return }
    spins = Math.min(requested, have)
  }
  const table = _ftGetRouletteTable(ft.config, bait.rouletteIdx)
  if (!table.length) { ftReply(djId, `❌ [${bait.name}] 룰렛(${bait.rouletteIdx}번)이 아직 준비되지 않았습니다.`); return }
  const results = {}
  let consumed = 0
  for (let i = 0; i < spins; i++) {
    const caught = _ftSpinRoulette(table)
    if (!caught) break
    if (!results[caught.content]) results[caught.content] = { score: caught.score, qty: 0, keepIdx: caught.keepIdx || 1 }
    results[caught.content].qty += 1
    const keepIdx = caught.keepIdx || 1
    const tank = _ftEnsureTank(user, keepIdx)
    if (!tank.items[caught.content]) tank.items[caught.content] = { score: caught.score, qty: 0 }
    tank.items[caught.content].score = caught.score
    tank.items[caught.content].qty += 1
    tank.total += caught.score
    _ftAppendLog(djId, ft, bait.rouletteIdx, { tag, nickname: author, content: caught.content, score: caught.score, keepIdx, at: new Date().toISOString() })
    consumed++
  }
  if (consumed === 0) { ftReply(djId, '❌ 룰렛 확률 설정을 확인해주세요.'); return }
  const usedFreebie = staff && have <= 0
  if (!staff) user.vouchers[key] = have - consumed
  else if (have > 0) user.vouchers[key] = Math.max(0, have - consumed)
  saveFishTournament(djId, ft)
  const remain = user.vouchers[key] || 0
  const totalScore = Object.values(results).reduce((s, r) => s + r.score * r.qty, 0)
  if (consumed === 1) {
    const only = Object.keys(results)[0]
    const r = results[only]
    const keepLabel = ft.config['keep' + r.keepIdx + 'Name'] || ('어항' + r.keepIdx)
    const tank = user.tanks[String(r.keepIdx)]
    let msg = `🎣 ${author}님이 [${bait.name}]로 낚시를 해서 "${only}"을(를) 낚았습니다! (+${r.score}점)\n📦 ${keepLabel} 누적 총점수: ${tank.total}점`
    msg += usedFreebie ? ' (관리자 체험, 미끼 소모 없음)' : ` (남은 [${bait.name}] 미끼: ${remain}개)`
    ftReply(djId, msg)
    return
  }
  const lines = Object.keys(results).map(c => `${c} x${results[c].qty}(${results[c].score}점)`).join(', ')
  let msg = `🎣 ${author}님이 [${bait.name}]로 ${consumed}회 낚시! → ${lines}\n💎 총 획득: +${totalScore}점`
  msg += usedFreebie ? ' (관리자 체험, 미끼 소모 없음)' : ` (남은 [${bait.name}] 미끼: ${remain}개)`
  ftReply(djId, msg)
}

async function _ftHandleKeepView(djId, ft, author, tag, slotIdx, label) {
  if (!tag) { ftReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFtUser(ft, tag, author)
  const tank = user.tanks[String(slotIdx)]
  if (!tank || !Object.keys(tank.items || {}).length) { ftReply(djId, `🎣 ${author}님의 ${label} 🎣\n💎 총점수 : 0점\n아직 잡은 물고기가 없습니다.`); return }
  const rows = Object.keys(tank.items).map(content => ({ content, score: tank.items[content].score, qty: tank.items[content].qty })).sort((a, b) => (b.score * b.qty) - (a.score * a.qty))
  let msg = `🎣 ${author}님의 ${label} 🎣\n💎 총점수 : ${tank.total}점\n`
  rows.forEach((r, i) => { msg += `${i + 1}. ${r.content} ${r.score}점 ${r.qty}개\n` })
  ftReply(djId, msg.trim())
}

async function ftCmdMyCatch(djId, ft, author, tag) {
  if (!tag) { ftReply(djId, '❌ 고유닉이 있어야 합니다.'); return }
  const user = getFtUser(ft, tag, author)
  const items = {}; let total = 0
  Object.values(user.tanks || {}).forEach(tank => {
    total += tank.total || 0
    Object.keys(tank.items || {}).forEach(content => {
      if (!items[content]) items[content] = { score: tank.items[content].score, qty: 0 }
      items[content].score = tank.items[content].score
      items[content].qty += tank.items[content].qty
    })
  })
  if (!Object.keys(items).length) { ftReply(djId, `🎣 ${author}님의 낚시 기록 🎣\n💎 총점수 : 0점\n아직 잡은 물고기가 없습니다.`); return }
  const rows = Object.keys(items).map(content => ({ content, score: items[content].score, qty: items[content].qty })).sort((a, b) => (b.score * b.qty) - (a.score * a.qty))
  let msg = `🎣 ${author}님의 낚시 기록 (전체 어항 합산) 🎣\n💎 총점수 : ${total}점\n`
  rows.forEach((r, i) => { msg += `${i + 1}. ${r.content} ${r.score}점 ${r.qty}개\n` })
  ftReply(djId, msg.trim())
}

async function _ftHandleRank(djId, ft, parts) {
  const overrideSlot = parseInt(parts[1], 10)
  const singleSlot = (overrideSlot >= 1 && overrideSlot <= FT_KEEP_SLOTS) ? overrideSlot : null
  const users = Object.values(ft.users)
  const ranked = users.map(u => {
    let total
    if (singleSlot) total = (u.tanks && u.tanks[String(singleSlot)]) ? u.tanks[String(singleSlot)].total : 0
    else total = Object.values(u.tanks || {}).reduce((s, t) => s + (t.total || 0), 0)
    return { nickname: u.nickname || u.tag, total }
  }).filter(u => u.total > 0).sort((a, b) => b.total - a.total)
  const topN = parseInt(ft.config.rankTopN, 10) || 5
  const top = ranked.slice(0, topN)
  let title = ft.config.rankTitle || '팝블리네 낚시랭킹'
  if (singleSlot) { const label = ft.config['keep' + singleSlot + 'Name'] || ('어항' + singleSlot); title += ` (${label})` }
  const medals = ['🥇', '🥈', '🥉']
  if (!top.length) { ftReply(djId, `🎣 ${title} 🎣\n아직 기록이 없습니다.`); return }
  let msg = `🎣 ${title} 🎣\n`
  top.forEach((u, i) => { const rank = i + 1; const icon = medals[i] || '🎣'; msg += `${icon}${rank}위 : ${u.nickname} ${u.total}점\n` })
  ftReply(djId, msg.trim())
}

// ── 채팅 이벤트 마스터 디스패처 ──
async function handleFishTournamentCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  if (!isRequestModuleAllowed('fishtournament', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const parts = msg.split(/\s+/)
  const cmd = parts[0]
  const cmdLower = cmd.toLowerCase()

  const ft = getFishTournamentSettings(djId, settings)
  if (!ft.config.enabled) return

  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const chatAct = getActivitySettings(djId, settings)
  const isManager = !isDj && (chatAct.grantNicknames || []).map(n => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase())

  const tag = actTag || await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
  if (tag) rememberTagNickname(room, tag, author)

  const namedCmds = [
    { cfgKey: 'startCommand', def: '낚시시작', fn: () => ftCmdStart(djId, ft, author, tag) },
    { cfgKey: 'shopCommand', def: '미끼상점', fn: () => ftCmdShop(djId, ft) },
    { cfgKey: 'voucherCommand', def: '미끼보유', fn: () => ftCmdMyVouchers(djId, ft, author, tag) },
    { cfgKey: 'myCatchCommand', def: '내물고기', fn: () => ftCmdMyCatch(djId, ft, author, tag) },
    { cfgKey: 'giveCommand', def: '미끼지급', fn: () => ftCmdGiveBait(djId, ft, author, isDj, isManager, parts) },
    { cfgKey: 'resetCommand', def: '유저초기화', fn: () => ftCmdResetUser(djId, ft, isDj, isManager, parts) },
    { cfgKey: 'listCommand', def: '유저목록', fn: () => ftCmdUserList(djId, ft, isDj, isManager) },
    { cfgKey: 'logCommand', def: '룰렛기록', fn: () => ftCmdRouletteLog(djId, ft, isDj, isManager, parts) },
    { cfgKey: 'helpCommand', def: '낚시도움말', fn: () => ftCmdHelp(djId, ft) },
  ]
  for (const c of namedCmds) {
    const name = ft.config[c.cfgKey] || c.def
    if (('!' + name).toLowerCase() === cmdLower) return c.fn()
  }

  const baits = _ftGetBaitList(ft.config)
  const bait = baits.find(b => ('!' + b.cmd).toLowerCase() === cmdLower)
  if (bait) return _ftHandleBaitSpin(djId, ft, author, tag, isDj, bait, parts)

  for (let i = 1; i <= FT_KEEP_SLOTS; i++) {
    const name = ft.config['keep' + i + 'Name']
    if (name && ('!' + name).toLowerCase() === cmdLower) return _ftHandleKeepView(djId, ft, author, tag, i, name)
  }

  const rankCmd = ft.config.rankCommand || '낚시왕'
  if (('!' + rankCmd).toLowerCase() === cmdLower) return _ftHandleRank(djId, ft, parts)
}


// ══════════════════════════════════════════════════════
// 🍞 증권거래소 — 방송용 종합 경제 게임
// 좋아요·채팅·스푼·출석으로 '머니'를 모아 주식에 투자하고, 슬롯·룰렛·복권 등 미니게임과

// 은행(예금/대출), 아이템, 랭킹이 하나의 경제로 연결된다. 시세/뉴스/배당/시장이벤트는 전부
// 타이머로 자동 진행되고, 종목은 운영자가 명령어로 직접 설립/폐지한다.
// 모든 명령어는 ! 로 시작하고, 유저 데이터는 "닉네임" 키로 저장한다 (룰렛/애청지수와 동일 관례).

function stkDefaultConfig() {
  return {
    enabled: true,
    cmdStart: '!시작', cmdAttend: '!출석', cmdRule: '!룰설명',
    cmdMyInfo: '!내정보', cmdMyMoney: '!내돈', cmdStockList: '!주식', cmdMyStock: '!내주식',
    cmdRanking: '!식빵랭킹', cmdJackpot: '!잭팟',
    cmdDeposit: '!예금', cmdWithdraw: '!출금', cmdLoan: '!대출', cmdRepay: '!상환',
    cmdSlot: '!슬롯', cmdRoulette: '!룰렛', cmdOddEven: '!홀짝', cmdDice: '!주사위', cmdLotto: '!복권',
    cmdShop: '!상점', cmdBuy: '!구매', cmdUse: '!사용',
    cmdStockCreate: '!주식설립', cmdStockDelete: '!주식폐지', cmdGiveMoney: '!머니지급',
    startMoney: 100000,
    likeMoney: 50, chatMoney: 5, spoonMoney: 100, attendMoney: 1000,
    priceIntervalMin: 10, priceMinPct: -5, priceMaxPct: 5, priceFloor: 500,
    newsIntervalMin: 30,
    dividendIntervalMin: 30,
    eventIntervalMin: 60, eventChancePct: 10,
    depositInterestPct: 5, depositInterestCap: 10000000,
    loanLimit: 1000000, loanInterestPct: 10, autoLoanAmount: 500000,
    jackpotSeed: 1000000,
    goodNews: [
      ['신제품 출시 대박!', 12], ['대규모 수주 계약 체결!', 15], ['어닝 서프라이즈!', 10],
      ['해외 시장 진출 성공!', 8], ['신기술 특허 등록!', 10], ['대기업 투자 유치!', 18],
      ['정부 지원 사업 선정!', 8], ['초대형 인수합병 발표!', 15], ['신사업 진출 선언!', 6],
      ['연구 결과 대성공!', 20],
    ],
    badNews: [
      ['제품 결함 전량 리콜…', -12], ['공장 화재 발생…', -15], ['어닝 쇼크…', -10],
      ['대형 계약 파기…', -12], ['경영진 구설수…', -8], ['세무조사 착수…', -8],
      ['핵심 인력 대거 퇴사…', -10], ['기술 유출 사고…', -15], ['대형 소송 패소…', -18],
      ['신사업 대실패…', -20],
    ],
    items: [
      { name: '시장분석권', price: 30000, desc: '지정 종목의 다음 시세 변동을 예측' },
      { name: '배당쿠폰', price: 20000, desc: '다음 배당 2배' },
      { name: '보험', price: 30000, desc: '폭락 손실 50% 보상' },
      { name: '행운권', price: 20000, desc: '다음 슬롯 확률 2배' },
    ],
  }
}

function getStockSettings(djId, settings) {
  if (!settings.stock) {
    settings.stock = { config: stkDefaultConfig(), stocks: [], jackpot: 1000000, pendingChange: {}, users: {}, chatAccrual: {}, lastDailyRunAt: 0 }
    store.saveSettings(djId, { stock: settings.stock })
  }
  const s = settings.stock
  if (!s.config) s.config = stkDefaultConfig()
  if (!Array.isArray(s.stocks)) s.stocks = []
  if (typeof s.jackpot !== 'number') s.jackpot = Number(s.config.jackpotSeed) || 1000000
  if (!s.pendingChange) s.pendingChange = {}
  if (!s.users) s.users = {}
  if (!s.chatAccrual) s.chatAccrual = {}
  return s
}
function saveStock(djId, stock) { store.saveSettings(djId, { stock }) }

// 유저 데이터는 "고유닉(tag)"을 기준 키로 저장한다 (닉네임은 바뀔 수 있어서 신뢰 불가).
function stkNewUser(tag, nickname) {
  return {
    tag, nickname: nickname || tag, cash: 0, holdings: {}, deposit: 0, loan: 0, items: {},
    started: false, attended: false, creditBad: false,
    nextDividendX2: false, nextInsurance: false, nextLuckyTicket: false,
    stats: { totalDividend: 0, gambleWin: 0, gambleLose: 0, tradeCount: 0, bankruptCount: 0 },
  }
}
// tag가 없으면(고유닉 조회 실패) null을 반환한다 — 증권거래소 관련 동작은 전부 고유닉 기준으로만 처리한다.
function stkGetUser(stock, tag, nickname) {
  if (!tag) return null
  const key = String(tag).trim().toLowerCase()
  if (!stock.users[key]) stock.users[key] = stkNewUser(key, nickname)
  const u = stock.users[key]
  if (!u.stats) u.stats = { totalDividend: 0, gambleWin: 0, gambleLose: 0, tradeCount: 0, bankruptCount: 0 }
  if (!u.holdings) u.holdings = {}
  if (!u.items) u.items = {}
  if (nickname) u.nickname = nickname
  return u
}
// 고유닉 조회가 실패했을 때(좋아요처럼 빈번한 이벤트는 특히 자주 실패함), 새 계정을 만들지는 않되
// 이미 !시작한 기존 유저를 닉네임으로 찾아서 적립을 계속 이어갈 수 있게 하는 안전장치.
function stkFindStartedUserByNickname(stock, nickname) {
  const norm = String(nickname || '').trim().toLowerCase()
  if (!norm) return null
  for (const key in stock.users) {
    const u = stock.users[key]
    if (u.started && String(u.nickname || '').trim().toLowerCase() === norm) return u
  }
  return null
}
function stkFmt(n) { return Math.round(Number(n) || 0).toLocaleString() + '원' }
function stkParseMoney(str) {
  if (!str) return 0
  let s = String(str).trim().replace(/원$/, '').replace(/,/g, '')
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  let total = 0, m
  m = s.match(/(\d+)억/); if (m) { total += parseInt(m[1], 10) * 100000000; s = s.replace(m[0], '') }
  m = s.match(/(\d+)만/); if (m) { total += parseInt(m[1], 10) * 10000; s = s.replace(m[0], '') }
  m = s.match(/(\d+)천/); if (m) { total += parseInt(m[1], 10) * 1000; s = s.replace(m[0], '') }
  s = s.trim()
  if (/^\d+$/.test(s)) total += parseInt(s, 10)
  return total
}
function stkReply(djId, msg) { sendChatSplit(djId, msg, 150, 500) }
function stkTotalAssets(stock, user) {
  let stockValue = 0
  for (const name in user.holdings) {
    const h = user.holdings[name]
    const st = stock.stocks.find(s => s.name === name)
    if (st && h) stockValue += h.qty * st.price
  }
  return (user.cash || 0) + stockValue + (user.deposit || 0) - (user.loan || 0)
}
function stkTitle(total) {
  if (total >= 20000000) return '재벌'
  if (total >= 5000000) return '큰손'
  if (total >= 1000000) return '우량주 투자자'
  if (total >= 300000) return '개미 투자자'
  return '초보 개미'
}
function _stkIsDj(djId, room, settings, authorId, author) {
  if (authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId) return true
  const act = getActivitySettings(djId, settings)
  return (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase())
}

// 파산했는데 이미 대출 한도까지 다 쓴 상태 → 신용불량 (도박 이용 불가, 이후 소득 50% 자동 상환)
function stkAddIncome(djId, stock, u, amount) {
  if (!u || amount <= 0) return
  if (u.creditBad && (u.loan || 0) > 0) {
    const toLoan = Math.round(amount * 0.5)
    const pay = Math.min(toLoan, u.loan)
    u.loan -= pay
    u.cash = (u.cash || 0) + (amount - pay)
    if (u.loan <= 0) {
      u.loan = 0
      u.creditBad = false
      setTimeout(() => sendChatToRoom(djId, `✅ ${u.nickname}님, 대출을 전액 상환해서 신용불량 상태가 해제됐어요!`), 500)
    }
  } else {
    u.cash = (u.cash || 0) + amount
  }
}

function stkCheckBankrupt(djId, stock, u) {
  let stockValue = 0
  for (const name in u.holdings) {
    const h = u.holdings[name]; const st = stock.stocks.find(s => s.name === name)
    if (st && h) stockValue += h.qty * st.price
  }
  if ((u.cash || 0) > 0 || stockValue > 0 || (u.deposit || 0) > 0) return
  const limit = Number(stock.config.loanLimit) || 1000000
  if ((u.loan || 0) >= limit) {
    if (!u.creditBad) {
      u.creditBad = true
      u.stats.bankruptCount = (u.stats.bankruptCount || 0) + 1
      setTimeout(() => sendChatToRoom(djId, `🚫 ${u.nickname}님 파산! 대출 한도를 모두 사용해서 신용불량 상태가 됐어요. (도박 이용 불가, 이후 소득의 50%가 자동 상환에 사용돼요)`), 400)
    }
    return
  }
  const amt = Number(stock.config.autoLoanAmount) || 500000
  const room = Math.max(0, limit - (u.loan || 0))
  const give = Math.min(amt, room)
  if (give <= 0) return
  u.loan = (u.loan || 0) + give
  u.cash = (u.cash || 0) + give
  u.stats.bankruptCount = (u.stats.bankruptCount || 0) + 1
  setTimeout(() => sendChatToRoom(djId, `🆘 ${u.nickname}님 파산! 자동 대출 ${stkFmt(give)} 실행\n💳 대출 잔액 ${stkFmt(u.loan)} (방송일마다 이자 ${stock.config.loanInterestPct}%)`), 400)
}

// 보험 아이템 정산 — 지정 종목의 가격이 내려갔을 때, nextInsurance 플래그가 있는 보유자에게 손실의 50%를 환급
function stkApplyInsurance(djId, stock, lossMap) {
  for (const key in stock.users) {
    const u = stock.users[key]
    if (!u.nextInsurance) continue
    let totalLoss = 0
    for (const name in lossMap) {
      const h = u.holdings[name]
      const perShareLoss = lossMap[name]
      if (h && h.qty > 0 && perShareLoss > 0) totalLoss += h.qty * perShareLoss
    }
    if (totalLoss > 0) {
      const refund = Math.round(totalLoss * 0.5)
      u.cash = (u.cash || 0) + refund
      u.nextInsurance = false
      setTimeout(() => sendChatToRoom(djId, `🛡️ 보험 적용! ${u.nickname}님 손실의 50% (${stkFmt(refund)}) 보상 완료`), 600)
    }
  }
}

// ── 타이머: 시세/뉴스/배당/시장이벤트 ──
function stkPriceTick(djId) {
  const settings = store.getSettings(djId); if (!settings) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  if (cfg.enabled !== false && stock.stocks.length) {
    stock.stocks.forEach(st => {
      let pct = stock.pendingChange[st.name]
      if (typeof pct === 'number') delete stock.pendingChange[st.name]
      else pct = (Number(cfg.priceMinPct) || -5) + Math.random() * ((Number(cfg.priceMaxPct) || 5) - (Number(cfg.priceMinPct) || -5))
      const floor = Number(cfg.priceFloor) || 500
      const newPrice = Math.max(floor, Math.round((st.price * (1 + pct / 100)) / 10) * 10)
      st.lastPct = st.price > 0 ? ((newPrice - st.price) / st.price) * 100 : 0
      st.price = newPrice
    })
  }
  for (const key in stock.chatAccrual) {
    const amt = stock.chatAccrual[key]
    if (amt > 0) {
      const u = stock.users[key]
      if (u) stkAddIncome(djId, stock, u, amt)
    }
  }
  stock.chatAccrual = {}
  saveStock(djId, stock)
}

function stkNewsTick(djId) {
  const settings = store.getSettings(djId); if (!settings) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  if (cfg.enabled === false || !stock.stocks.length) return
  const st = stock.stocks[Math.floor(Math.random() * stock.stocks.length)]
  const good = Math.random() < 0.5
  const pool = good ? cfg.goodNews : cfg.badNews
  if (!pool || !pool.length) return
  const [phrase, pct] = pool[Math.floor(Math.random() * pool.length)]
  const floor = Number(cfg.priceFloor) || 500
  const oldPrice = st.price
  const newPrice = Math.max(floor, Math.round((oldPrice * (1 + pct / 100)) / 10) * 10)
  st.lastPct = oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0
  st.price = newPrice
  if (newPrice < oldPrice) stkApplyInsurance(djId, stock, { [st.name]: oldPrice - newPrice })
  saveStock(djId, stock)
  const sign = pct >= 0 ? '+' : ''
  setTimeout(() => sendChatToRoom(djId, `📰 [속보] ${st.name} ${phrase} ${sign}${pct}%\n📈 현재가 ${Math.round(st.price).toLocaleString()}원`), 400)
}

function stkDividendTick(djId) {
  const settings = store.getSettings(djId); if (!settings) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  if (cfg.enabled === false || !stock.stocks.length) return
  for (const key in stock.users) {
    const u = stock.users[key]
    let total = 0
    const names = []
    for (const name in (u.holdings || {})) {
      const h = u.holdings[name]
      const st = stock.stocks.find(s => s.name === name)
      if (!st || !h || !h.qty) continue
      const rate = (Number(st.dividendRate) || 0) / 100
      total += h.qty * st.price * rate
      names.push(name)
    }
    if (total <= 0) continue
    if (u.nextDividendX2) { total *= 2; u.nextDividendX2 = false }
    total = Math.round(total)
    stkAddIncome(djId, stock, u, total)
    u.stats.totalDividend = (u.stats.totalDividend || 0) + total
    const extra = names.length > 1 ? ` 외 ${names.length - 1}종목` : ''
    setTimeout(() => sendChatToRoom(djId, `💵 배당 지급! ${u.nickname}님 +${total.toLocaleString()}원 (${names[0]}${extra})`), 400)
  }
  saveStock(djId, stock)
}

function stkEventTick(djId) {
  const settings = store.getSettings(djId); if (!settings) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  if (cfg.enabled === false || !stock.stocks.length) return
  if (Math.random() * 100 >= (Number(cfg.eventChancePct) || 10)) return
  const floor = Number(cfg.priceFloor) || 500
  const types = ['bull', 'bear', 'theme', 'rate']
  const type = types[Math.floor(Math.random() * types.length)]
  let msg = ''
  if (type === 'bull') {
    stock.stocks.forEach(st => { st.price = Math.max(floor, Math.round(st.price * 1.10 / 10) * 10) })
    msg = '📈 강세장! 전 종목 +10%'
  } else if (type === 'bear') {
    const lossMap = {}
    stock.stocks.forEach(st => {
      const old = st.price
      st.price = Math.max(floor, Math.round(st.price * 0.90 / 10) * 10)
      if (st.price < old) lossMap[st.name] = old - st.price
    })
    stkApplyInsurance(djId, stock, lossMap)
    msg = '📉 약세장! 전 종목 -10%'
  } else if (type === 'theme') {
    const st = stock.stocks[Math.floor(Math.random() * stock.stocks.length)]
    st.price = Math.max(floor, Math.round(st.price * 1.20 / 10) * 10)
    msg = `🔥 테마주 열풍! ${st.name} +20%`
  } else {
    const lossMap = {}
    stock.stocks.forEach(st => {
      const old = st.price
      if ((Number(st.dividendRate) || 0) >= 2) st.price = Math.max(floor, Math.round(st.price * 1.08 / 10) * 10)
      else st.price = Math.max(floor, Math.round(st.price * 0.92 / 10) * 10)
      if (st.price < old) lossMap[st.name] = old - st.price
    })
    stkApplyInsurance(djId, stock, lossMap)
    msg = '🏦 금리 인상! 고배당주(배당2%↑) +8% / 저배당주 -8%'
  }
  saveStock(djId, stock)
  setTimeout(() => sendChatToRoom(djId, `🌍 [시장 이벤트] ${msg}`), 400)
}

function stkDailyRoutine(djId) {
  const settings = store.getSettings(djId); if (!settings) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  const cap = Number(cfg.depositInterestCap) || 10000000
  const depRate = (Number(cfg.depositInterestPct) || 5) / 100
  const loanRate = (Number(cfg.loanInterestPct) || 10) / 100
  for (const key in stock.users) {
    const u = stock.users[key]
    if (u.deposit > 0) u.deposit += Math.round(Math.min(u.deposit, cap) * depRate)
    if (u.loan > 0) u.loan += Math.round(u.loan * loanRate)
    u.attended = false
  }
  stock.lastDailyRunAt = Date.now()
  saveStock(djId, stock)
  console.log(`[증권거래소:${djId}] 방송일 루틴 실행 (예금이자/대출이자/출석초기화)`)
}

function stkBumpNext(djId, field, ms) {
  const settings = store.getSettings(djId); if (!settings) return
  const stock = getStockSettings(djId, settings)
  stock[field] = Date.now() + ms
  saveStock(djId, stock)
}
function stopStockTimers(djId) {
  const room = getRoom(djId);
  ['stockPriceTimer', 'stockNewsTimer', 'stockDividendTimer', 'stockEventTimer'].forEach(k => {
    if (room[k]) { clearInterval(room[k]); room[k] = null }
  })
}
function startStockTimers(djId, liveId) {
  stopStockTimers(djId)
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'stock', djId)) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  if (cfg.enabled === false) return

  const priceMs = Math.max(1, Number(cfg.priceIntervalMin) || 10) * 60000
  const newsMs = Math.max(1, Number(cfg.newsIntervalMin) || 30) * 60000
  const divMs = Math.max(1, Number(cfg.dividendIntervalMin) || 30) * 60000
  const eventMs = Math.max(1, Number(cfg.eventIntervalMin) || 60) * 60000

  const now = Date.now()
  stock.nextPriceAt = now + priceMs
  stock.nextNewsAt = now + newsMs
  stock.nextDividendAt = now + divMs
  stock.nextEventAt = now + eventMs
  saveStock(djId, stock)

  room.stockPriceTimer = setInterval(() => { stkPriceTick(djId); stkBumpNext(djId, 'nextPriceAt', priceMs) }, priceMs)
  room.stockNewsTimer = setInterval(() => { stkNewsTick(djId); stkBumpNext(djId, 'nextNewsAt', newsMs) }, newsMs)
  room.stockDividendTimer = setInterval(() => { stkDividendTick(djId); stkBumpNext(djId, 'nextDividendAt', divMs) }, divMs)
  room.stockEventTimer = setInterval(() => { stkEventTick(djId); stkBumpNext(djId, 'nextEventAt', eventMs) }, eventMs)

  if (now - (stock.lastDailyRunAt || 0) > 4 * 60 * 60 * 1000) stkDailyRoutine(djId)
  console.log(`[증권거래소:${djId}] 타이머 시작`)
}

// ── 채팅 적립 훅 (좋아요/채팅/스푼) — 전부 고유닉(tag) 기준으로만 적립한다 ──
function handleStockChatHook(djId, settings, tag, nickname) {
  if (!isModuleOn(settings, 'stock', djId)) return
  const stock = getStockSettings(djId, settings)
  if (stock.config.enabled === false) return
  const key = tag ? String(tag).trim().toLowerCase() : null
  const u = (key && stock.users[key]) || stkFindStartedUserByNickname(stock, nickname)
  if (!u || !u.started) return
  if (nickname) u.nickname = nickname
  const uKey = key || Object.keys(stock.users).find(k => stock.users[k] === u)
  stock.chatAccrual[uKey] = (stock.chatAccrual[uKey] || 0) + (Number(stock.config.chatMoney) || 5)
  saveStock(djId, stock)
}
function handleStockHeartHook(djId, settings, tag, nickname) {
  if (!isModuleOn(settings, 'stock', djId)) return
  const stock = getStockSettings(djId, settings)
  if (stock.config.enabled === false) return
  const u = (tag && stkGetUser(stock, tag, nickname)) || stkFindStartedUserByNickname(stock, nickname)
  if (!u || !u.started) return
  stkAddIncome(djId, stock, u, Number(stock.config.likeMoney) || 50)
  saveStock(djId, stock)
}
function handleStockDonationHook(djId, settings, tag, nickname, spoonCount) {
  if (!isModuleOn(settings, 'stock', djId)) return
  const stock = getStockSettings(djId, settings)
  if (stock.config.enabled === false) return
  const u = (tag && stkGetUser(stock, tag, nickname)) || stkFindStartedUserByNickname(stock, nickname)
  if (!u || !u.started) return
  stkAddIncome(djId, stock, u, Math.max(0, spoonCount) * (Number(stock.config.spoonMoney) || 100))
  saveStock(djId, stock)
}

// ── 명령어 핸들러 (전부 tag를 받아서 stkGetUser로 유저를 찾는다. nickname은 표시용) ──
function stkCmdStart(djId, stock, tag, nickname) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (u.started) { stkReply(djId, `⚠️ ${nickname}님은 이미 시작했어요. ${stock.config.cmdMyInfo}로 확인하세요.`); return }
  u.started = true
  u.cash = (u.cash || 0) + (Number(stock.config.startMoney) || 100000)
  saveStock(djId, stock)
  stkReply(djId, `🍞 ${nickname}님, 식빵 증권거래소에 오신 걸 환영해요! 시작금 ${stkFmt(stock.config.startMoney || 100000)} 지급 완료!`)
}
function stkCmdAttend(djId, stock, tag, nickname) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  if (u.attended) { stkReply(djId, '⚠️ 오늘 방송에서는 이미 출석했어요.'); return }
  u.attended = true
  const amt = Number(stock.config.attendMoney) || 1000
  stkAddIncome(djId, stock, u, amt)
  saveStock(djId, stock)
  stkReply(djId, `📅 출석 완료! +${stkFmt(amt)} (보유 현금: ${stkFmt(u.cash)})`)
}
const STK_RULE_TOPICS = ['주식', '배당', '뉴스', '슬롯', '잭팟', '룰렛', '홀짝', '주사위', '복권', '은행', '아이템', '랭킹']
function stkCmdRule(djId, cfg, parts) {
  const topic = parts.slice(1).join(' ').trim()
  if (!topic) {
    stkReply(djId, `📖 식빵 증권거래소 룰설명 항목\n${STK_RULE_TOPICS.join(' · ')}\n→ ${cfg.cmdRule} [항목] 으로 확인하세요`)
    return
  }
  const texts = {
    '주식': `📈 주식 룰\n· ${cfg.priceIntervalMin}분마다 전 종목 시세가 ${cfg.priceMinPct}% ~ +${cfg.priceMaxPct}% 랜덤 변동\n· ${cfg.cmdStockList} 으로 시세 확인 → !종목명 3주 매수 · !종목명 전량 매도 로 거래\n· ${cfg.newsIntervalMin}분마다 뉴스로 급등락, ${cfg.eventIntervalMin}분마다 시장 이벤트 발생 가능`,
    '배당': `💵 배당 룰\n· ${cfg.dividendIntervalMin}분마다 보유 주식 평가액 × 종목 배당률 자동 지급\n· 종목별 배당률은 ${cfg.cmdStockList} 에서 확인`,
    '뉴스': `📰 뉴스 룰\n· ${cfg.newsIntervalMin}분마다 랜덤 종목에 호재 또는 악재가 발생\n· 즉시 시세에 반영돼요`,
    '슬롯': `🎰 슬롯 룰 (${cfg.cmdSlot} 1만·5만·10만·50만)\n· 3개 일치 100배 / 50배 / 20배 · 2개 일치 2배\n· 777 이 나오면 잭팟 전액!`,
    '잭팟': `💎 잭팟 룰\n· 모든 슬롯 배팅액의 1%가 자동 적립\n· 슬롯에서 777 이 뜨면 누적금 전액 획득\n· ${cfg.cmdJackpot} 으로 현재 누적금 확인`,
    '룰렛': `🎡 룰렛 룰 (${cfg.cmdRoulette} 빨강 5만원)\n· 빨강 2배 · 검정 2배 · 초록 14배`,
    '홀짝': `⚫ 홀짝 룰 (${cfg.cmdOddEven} 홀 5만원)\n· 홀/짝 반반, 맞히면 2배`,
    '주사위': `🎲 주사위 룰 (${cfg.cmdDice} 3 5만원)\n· 1~6 중 숫자 선택, 맞히면 6배 / 틀리면 0`,
    '복권': `🎟️ 복권 룰 (${cfg.cmdLotto} 5장)\n· 1장 100,000원, 1회 최대 10장, 결과 즉시 발표\n· 1등 1,000만 / 2등 300만 / 3등 100만`,
    '은행': `🏦 은행 룰\n· ${cfg.cmdDeposit} [금액] → 방송일마다 이자 ${cfg.depositInterestPct}% 자동 지급\n· ${cfg.cmdLoan} [금액] → 한도 ${stkFmt(cfg.loanLimit)}, 방송일마다 이자 ${cfg.loanInterestPct}% 가산\n· 전 재산이 0원이 되면 자동 대출 ${stkFmt(cfg.autoLoanAmount)} 실행`,
    '아이템': `🛍️ 아이템 룰 (${cfg.cmdShop} → ${cfg.cmdBuy} → ${cfg.cmdUse})\n· 시장분석권 : 지정 종목의 다음 시세 변동 예측\n· 배당쿠폰 : 다음 배당 2배 / 보험 : 폭락 손실 50% 보상 / 행운권 : 다음 슬롯 확률 2배`,
    '랭킹': `🏆 랭킹 룰\n· 총자산 = 현금 + 주식 평가액 + 예금 - 대출\n· ${cfg.cmdRanking} 으로 TOP5 확인`,
  }
  const t = texts[topic]
  stkReply(djId, t || `⚠️ '${topic}' 항목을 찾을 수 없어요. ${cfg.cmdRule} 으로 목록을 확인해주세요.`)
}
function stkCmdMyInfo(djId, stock, tag, nickname) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  let stockValue = 0
  for (const name in u.holdings) { const h = u.holdings[name]; const st = stock.stocks.find(s => s.name === name); if (st) stockValue += h.qty * st.price }
  const total = stkTotalAssets(stock, u)
  stkReply(djId, `🍞 ${u.nickname}님의 자산 정보\n🏅 칭호 : ${stkTitle(total)}\n💰 현금 : ${stkFmt(u.cash)}\n📊 주식 : ${stkFmt(stockValue)}\n🏦 예금 : ${stkFmt(u.deposit)}\n💳 대출 : -${stkFmt(u.loan)}\n━━━━━━━━━━━━━━\n💎 총자산 : ${stkFmt(total)}`)
}
function stkCmdMyMoney(djId, stock, tag, nickname) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  stkReply(djId, `💰 ${u.nickname}님의 보유 현금: ${stkFmt(u.cash)}`)
}
function stkCmdStockList(djId, stock) {
  if (!stock.stocks.length) { stkReply(djId, '📊 아직 개설된 종목이 없어요.'); return }
  const lines = stock.stocks.map(st => {
    const pct = st.lastPct || 0
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '-'
    return `${st.name}  ${Math.round(st.price).toLocaleString()}  ${arrow}${Math.abs(pct).toFixed(1)}% (배당 ${st.dividendRate}%)`
  })
  const nextPrice = Math.max(0, Math.round(((stock.nextPriceAt || Date.now()) - Date.now()) / 60000))
  const nextDiv = Math.max(0, Math.round(((stock.nextDividendAt || Date.now()) - Date.now()) / 60000))
  stkReply(djId, `🍞 식빵 증권거래소 🍞\n━━━━━━━━━━━━━━\n${lines.join('\n')}\n━━━━━━━━━━━━━━\n⏰ 다음 시세변경 : ${nextPrice}분\n💵 다음 배당까지 : ${nextDiv}분\n💎 현재 잭팟 : ${stkFmt(stock.jackpot)}`)
}
function stkCmdMyStock(djId, stock, tag, nickname) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  const names = Object.keys(u.holdings || {}).filter(n => u.holdings[n].qty > 0)
  if (!names.length) { stkReply(djId, `📊 ${u.nickname}님은 보유 중인 주식이 없어요.`); return }
  let totalVal = 0, totalCost = 0
  const lines = names.map((name, i) => {
    const h = u.holdings[name]; const st = stock.stocks.find(s => s.name === name)
    const price = st ? st.price : h.avgPrice
    const val = h.qty * price
    const cost = h.qty * h.avgPrice
    totalVal += val; totalCost += cost
    const pct = cost > 0 ? ((val - cost) / cost * 100) : 0
    return `${i + 1}. ${name} ${h.qty}주 | 평단 ${Math.round(h.avgPrice).toLocaleString()} | ${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(1)}%`
  })
  const diff = totalVal - totalCost
  stkReply(djId, `📊 ${u.nickname}님의 포트폴리오\n${lines.join('\n')}\n━━━━━━━━━━━━━━\n💰 평가액 ${stkFmt(totalVal)} (${diff >= 0 ? '+' : ''}${stkFmt(diff)})`)
}
function stkCmdRanking(djId, stock, cfg) {
  const entries = Object.values(stock.users).filter(u => u.started).map(u => ({ nickname: u.nickname, total: stkTotalAssets(stock, u) })).sort((a, b) => b.total - a.total).slice(0, 5)
  if (!entries.length) { stkReply(djId, '🏆 아직 등록된 유저가 없어요.'); return }
  const lines = entries.map((e, i) => `${i + 1}위 : ${e.nickname} ${stkFmt(e.total)}`)
  stkReply(djId, `🏆 ${String(cfg.cmdRanking || '!식빵랭킹').replace('!', '')} 🏆\n${lines.join('\n')}`)
}
function stkCmdJackpot(djId, stock) { stkReply(djId, `💎 현재 잭팟 누적금: ${stkFmt(stock.jackpot)}`) }

function stkCmdDeposit(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const amt = stkParseMoney(parts.slice(1).join(' '))
  if (!amt || amt <= 0) { stkReply(djId, '사용법: !예금 [금액] (예: !예금 5만원)'); return }
  if ((u.cash || 0) < amt) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= amt; u.deposit = (u.deposit || 0) + amt
  saveStock(djId, stock)
  stkReply(djId, `🏦 예금 완료! ${stkFmt(amt)} (예금 잔액: ${stkFmt(u.deposit)})`)
}
function stkCmdWithdraw(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const amt = stkParseMoney(parts.slice(1).join(' '))
  if (!amt || amt <= 0) { stkReply(djId, '사용법: !출금 [금액]'); return }
  if ((u.deposit || 0) < amt) { stkReply(djId, '❌ 예금 잔액이 부족해요.'); return }
  u.deposit -= amt; u.cash = (u.cash || 0) + amt
  saveStock(djId, stock)
  stkReply(djId, `🏦 출금 완료! ${stkFmt(amt)} (보유 현금: ${stkFmt(u.cash)})`)
}
function stkCmdLoan(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const amt = stkParseMoney(parts.slice(1).join(' '))
  if (!amt || amt <= 0) { stkReply(djId, '사용법: !대출 [금액]'); return }
  const limit = Number(stock.config.loanLimit) || 1000000
  if ((u.loan || 0) + amt > limit) { stkReply(djId, `❌ 대출 한도(${stkFmt(limit)})를 초과해요. (현재 대출: ${stkFmt(u.loan)})`); return }
  u.loan = (u.loan || 0) + amt; u.cash = (u.cash || 0) + amt
  saveStock(djId, stock)
  stkReply(djId, `💳 대출 실행! ${stkFmt(amt)} 지급 (대출 잔액: ${stkFmt(u.loan)})`)
}
function stkCmdRepay(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const amt = stkParseMoney(parts.slice(1).join(' '))
  if (!amt || amt <= 0) { stkReply(djId, '사용법: !상환 [금액]'); return }
  if ((u.cash || 0) < amt) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  const pay = Math.min(amt, u.loan || 0)
  u.cash -= pay; u.loan -= pay
  if (u.loan <= 0) { u.loan = 0; u.creditBad = false }
  saveStock(djId, stock)
  stkReply(djId, `💳 상환 완료! ${stkFmt(pay)} (남은 대출: ${stkFmt(u.loan)})`)
}

const STK_SLOT_ALLOWED = [10000, 50000, 100000, 500000]
function stkCmdSlot(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  if (u.creditBad) { stkReply(djId, '🚫 신용불량 상태에서는 도박을 이용할 수 없어요.'); return }
  const amt = stkParseMoney(parts.slice(1).join(' '))
  if (!STK_SLOT_ALLOWED.includes(amt)) { stkReply(djId, '사용법: !슬롯 [1만/5만/10만/50만] (예: !슬롯 5만원)'); return }
  if ((u.cash || 0) < amt) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= amt
  stock.jackpot = (stock.jackpot || 0) + Math.round(amt * 0.01)

  let odds = [
    { key: '777', p: 0.0005, mult: 'jackpot', symbols: ['7️⃣', '7️⃣', '7️⃣'] },
    { key: 'hi', p: 0.002, mult: 100, symbols: ['🪙', '🪙', '🪙'] },
    { key: 'mid', p: 0.005, mult: 50, symbols: ['⭐', '⭐', '⭐'] },
    { key: 'lo', p: 0.013, mult: 20, symbols: ['🍀', '🍀', '🍀'] },
    { key: 'pair', p: 0.08, mult: 2, symbols: null },
  ]
  if (u.nextLuckyTicket) { odds = odds.map(o => ({ ...o, p: o.p * 2 })); u.nextLuckyTicket = false }

  const roll = Math.random()
  let acc = 0, result = null
  for (const o of odds) { acc += o.p; if (roll < acc) { result = o; break } }

  let winAmount = 0, symbols
  const pool = ['🍒', '🔔', '🍋', '🍇']
  if (!result) {
    const a = pool[Math.floor(Math.random() * pool.length)]
    let b = a; while (b === a) b = pool[Math.floor(Math.random() * pool.length)]
    let c = a; while (c === a || c === b) c = pool[Math.floor(Math.random() * pool.length)]
    symbols = [a, b, c]
  } else if (result.key === '777') {
    winAmount = stock.jackpot
    stock.jackpot = Number(stock.config.jackpotSeed) || 1000000
    symbols = result.symbols
  } else if (result.key === 'pair') {
    winAmount = amt * 2
    const a = pool[Math.floor(Math.random() * pool.length)]
    let b = a; while (b === a) b = pool[Math.floor(Math.random() * pool.length)]
    symbols = [a, a, b]
  } else {
    winAmount = amt * result.mult
    symbols = result.symbols
  }
  if (winAmount > 0) { u.cash += winAmount; u.stats.gambleWin = (u.stats.gambleWin || 0) + 1 }
  else { u.stats.gambleLose = (u.stats.gambleLose || 0) + 1 }
  stkCheckBankrupt(djId, stock, u)
  saveStock(djId, stock)
  const net = winAmount - amt
  stkReply(djId, `🎰 ${u.nickname}님의 슬롯\n${symbols.join(' | ')}\n${winAmount > 0 ? `✨ 당첨! +${stkFmt(winAmount)}` : '😢 꽝!'} (${net >= 0 ? '+' : ''}${stkFmt(net)})\n💎 현재 잭팟 : ${stkFmt(stock.jackpot)}`)
}
function stkCmdRoulette(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  if (u.creditBad) { stkReply(djId, '🚫 신용불량 상태에서는 도박을 이용할 수 없어요.'); return }
  const color = parts[1]
  const amt = stkParseMoney(parts.slice(2).join(' '))
  const colorMap = { '빨강': { p: 0.47, mult: 2 }, '검정': { p: 0.47, mult: 2 }, '초록': { p: 0.06, mult: 14 } }
  if (!colorMap[color] || !amt || amt <= 0) { stkReply(djId, '사용법: !룰렛 [빨강·검정·초록] [금액]'); return }
  if ((u.cash || 0) < amt) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= amt
  const roll = Math.random()
  let acc = 0, resultColor = '초록'
  for (const c of ['빨강', '검정', '초록']) { acc += colorMap[c].p; if (roll < acc) { resultColor = c; break } }
  const win = resultColor === color
  const payout = win ? amt * colorMap[color].mult : 0
  if (win) { u.cash += payout; u.stats.gambleWin = (u.stats.gambleWin || 0) + 1 } else { u.stats.gambleLose = (u.stats.gambleLose || 0) + 1 }
  stkCheckBankrupt(djId, stock, u)
  saveStock(djId, stock)
  stkReply(djId, `🎡 ${u.nickname}님의 룰렛 (선택: ${color})\n결과: ${resultColor}\n${win ? `🎉 적중! +${stkFmt(payout - amt)}` : `😢 실패! -${stkFmt(amt)}`}`)
}
function stkCmdOddEven(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  if (u.creditBad) { stkReply(djId, '🚫 신용불량 상태에서는 도박을 이용할 수 없어요.'); return }
  const pick = parts[1]
  const amt = stkParseMoney(parts.slice(2).join(' '))
  if (!['홀', '짝'].includes(pick) || !amt || amt <= 0) { stkReply(djId, '사용법: !홀짝 [홀·짝] [금액]'); return }
  if ((u.cash || 0) < amt) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= amt
  const result = Math.random() < 0.5 ? '홀' : '짝'
  const win = result === pick
  const payout = win ? amt * 2 : 0
  if (win) { u.cash += payout; u.stats.gambleWin = (u.stats.gambleWin || 0) + 1 } else { u.stats.gambleLose = (u.stats.gambleLose || 0) + 1 }
  stkCheckBankrupt(djId, stock, u)
  saveStock(djId, stock)
  stkReply(djId, `⚫ ${u.nickname}님의 홀짝 (선택: ${pick})\n결과: ${result}\n${win ? `🎉 적중! +${stkFmt(payout - amt)}` : `😢 실패! -${stkFmt(amt)}`}`)
}
function stkCmdDice(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  if (u.creditBad) { stkReply(djId, '🚫 신용불량 상태에서는 도박을 이용할 수 없어요.'); return }
  const pick = parseInt(parts[1], 10)
  const amt = stkParseMoney(parts.slice(2).join(' '))
  if (!(pick >= 1 && pick <= 6) || !amt || amt <= 0) { stkReply(djId, '사용법: !주사위 [1~6] [금액]'); return }
  if ((u.cash || 0) < amt) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= amt
  const result = 1 + Math.floor(Math.random() * 6)
  const win = result === pick
  const payout = win ? amt * 6 : 0
  if (win) { u.cash += payout; u.stats.gambleWin = (u.stats.gambleWin || 0) + 1 } else { u.stats.gambleLose = (u.stats.gambleLose || 0) + 1 }
  stkCheckBankrupt(djId, stock, u)
  saveStock(djId, stock)
  stkReply(djId, `🎲 ${u.nickname}님의 주사위 (선택: ${pick})\n데굴데굴... 결과는 [ ${result} ]!\n${win ? `🎉 적중! +${stkFmt(payout - amt)}` : `😢 아쉽습니다! -${stkFmt(amt)}`}`)
}
function stkCmdLotto(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  if (u.creditBad) { stkReply(djId, '🚫 신용불량 상태에서는 도박을 이용할 수 없어요.'); return }
  let n = parseInt(parts[1], 10); if (!n || n < 1) n = 1
  n = Math.min(n, 10)
  const price = 100000
  const cost = price * n
  if ((u.cash || 0) < cost) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= cost
  let totalWin = 0
  const lines = []
  for (let i = 1; i <= n; i++) {
    const r = Math.random() * 100
    let label = '꽝', amt = 0
    if (r < 0.1) { label = '🥇 1등 당첨! +10,000,000원'; amt = 10000000 }
    else if (r < 0.6) { label = '🥈 2등 당첨! +3,000,000원'; amt = 3000000 }
    else if (r < 3.6) { label = '🥉 3등 당첨! +1,000,000원'; amt = 1000000 }
    totalWin += amt
    lines.push(`${i}. ${label}`)
  }
  u.cash += totalWin
  if (totalWin > 0) u.stats.gambleWin = (u.stats.gambleWin || 0) + 1; else u.stats.gambleLose = (u.stats.gambleLose || 0) + 1
  stkCheckBankrupt(djId, stock, u)
  saveStock(djId, stock)
  stkReply(djId, `🎟️ ${u.nickname}님의 복권 ${n}장\n${lines.join('\n')}\n━━━━━━━━━━━━━━\n💰 총 당첨 ${stkFmt(totalWin)} / 구매 ${stkFmt(cost)}`)
}

function stkCmdShop(djId, cfg) {
  const lines = (cfg.items || []).map((it, i) => `${i + 1}. ${it.name} — ${stkFmt(it.price)} (${it.desc || ''})`)
  stkReply(djId, `🛍️ 아이템 상점\n${lines.join('\n')}\n→ !구매 [아이템명] 으로 구매하세요`)
}
function stkCmdBuyItem(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const name = parts.slice(1).join(' ').trim()
  const item = (stock.config.items || []).find(it => it.name === name)
  if (!item) { stkReply(djId, '❌ 없는 아이템이에요. !상점 으로 목록을 확인해주세요.'); return }
  if ((u.cash || 0) < item.price) { stkReply(djId, '❌ 보유 현금이 부족해요.'); return }
  u.cash -= item.price
  u.items[item.name] = (u.items[item.name] || 0) + 1
  saveStock(djId, stock)
  stkReply(djId, `🛍️ ${item.name} 구매 완료! (보유: ${u.items[item.name]}개)`)
}
function stkCmdUseItem(djId, stock, tag, nickname, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const name = parts[1]
  if (!name || !u.items[name] || u.items[name] <= 0) { stkReply(djId, '❌ 보유하지 않은 아이템이에요.'); return }
  if (name === '시장분석권') {
    const target = parts.slice(2).join(' ').trim()
    const st = stock.stocks.find(s => s.name === target)
    if (!st) { stkReply(djId, '사용법: !사용 시장분석권 [종목명]'); return }
    const cfg = stock.config
    let pct = stock.pendingChange[st.name]
    if (typeof pct !== 'number') {
      pct = (Number(cfg.priceMinPct) || -5) + Math.random() * ((Number(cfg.priceMaxPct) || 5) - (Number(cfg.priceMinPct) || -5))
      stock.pendingChange[st.name] = pct
    }
    u.items[name]--
    saveStock(djId, stock)
    stkReply(djId, `🔍 ${u.nickname}님의 시장분석 결과 — ${st.name}은(는) 다음 시세 변동에서 ${pct >= 0 ? '상승' : '하락'}할 것으로 보여요! (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`)
    return
  }
  if (name === '배당쿠폰') { u.items[name]--; u.nextDividendX2 = true; saveStock(djId, stock); stkReply(djId, '🎫 배당쿠폰 사용! 다음 배당이 2배가 돼요.'); return }
  if (name === '보험') { u.items[name]--; u.nextInsurance = true; saveStock(djId, stock); stkReply(djId, '🛡️ 보험 사용! 다음 손실의 50%를 보상받아요.'); return }
  if (name === '행운권') { u.items[name]--; u.nextLuckyTicket = true; saveStock(djId, stock); stkReply(djId, '🍀 행운권 사용! 다음 슬롯 확률이 2배가 돼요.'); return }
  stkReply(djId, '❌ 사용할 수 없는 아이템이에요.')
}

function stkCmdTrade(djId, stock, tag, nickname, st, parts) {
  const u = stkGetUser(stock, tag, nickname)
  if (!u) { stkReply(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.'); return }
  if (!u.started) { stkReply(djId, `⚠️ 먼저 ${stock.config.cmdStart}로 시작해주세요.`); return }
  const rest = parts.slice(1).join('').replace(/\s+/g, '')
  let qty = 0, action = null
  if (/^전량매수$/.test(rest)) { action = 'buy'; qty = Math.floor((u.cash || 0) / st.price) }
  else if (/^전량매도$/.test(rest)) { action = 'sell'; qty = (u.holdings[st.name] && u.holdings[st.name].qty) || 0 }
  else if (/^절반매도$/.test(rest)) { action = 'sell'; qty = Math.floor(((u.holdings[st.name] && u.holdings[st.name].qty) || 0) / 2) }
  else {
    const m = rest.match(/^(\d+)주?(매수|매도)$/)
    if (m) { qty = parseInt(m[1], 10); action = m[2] === '매수' ? 'buy' : 'sell' }
  }
  if (!action || qty <= 0) return
  if (action === 'buy') {
    const cost = qty * st.price
    if ((u.cash || 0) < cost) { stkReply(djId, `❌ 현금이 부족해요. (필요: ${stkFmt(cost)}, 보유: ${stkFmt(u.cash)})`); return }
    u.cash -= cost
    const h = u.holdings[st.name] || { qty: 0, avgPrice: 0 }
    const newQty = h.qty + qty
    h.avgPrice = Math.round((h.avgPrice * h.qty + st.price * qty) / newQty)
    h.qty = newQty
    u.holdings[st.name] = h
    u.stats.tradeCount = (u.stats.tradeCount || 0) + 1
    saveStock(djId, stock)
    stkReply(djId, `📈 매수 완료! ${st.name} ${qty}주 @ ${Math.round(st.price).toLocaleString()}원 (총 ${stkFmt(cost)})\n💰 남은 현금: ${stkFmt(u.cash)}`)
  } else {
    const h = u.holdings[st.name]
    if (!h || h.qty < qty) { stkReply(djId, `❌ 보유 수량이 부족해요. (보유: ${h ? h.qty : 0}주)`); return }
    const proceeds = qty * st.price
    h.qty -= qty
    if (h.qty <= 0) delete u.holdings[st.name]
    u.cash += proceeds
    u.stats.tradeCount = (u.stats.tradeCount || 0) + 1
    saveStock(djId, stock)
    stkCheckBankrupt(djId, stock, u)
    saveStock(djId, stock)
    stkReply(djId, `📉 매도 완료! ${st.name} ${qty}주 @ ${Math.round(st.price).toLocaleString()}원 (총 ${stkFmt(proceeds)})\n💰 보유 현금: ${stkFmt(u.cash)}`)
  }
}

function stkCmdStockCreate(djId, stock, parts) {
  if (stock.stocks.length >= 10) { stkReply(djId, '❌ 종목은 최대 10개까지 운영할 수 있어요.'); return }
  const name = parts[1]
  const priceRaw = parts[2]
  if (!name || !priceRaw) { stkReply(djId, '사용법: !주식설립 [종목명] [시작가] [배당률(선택)]'); return }
  if (stock.stocks.find(s => s.name === name)) { stkReply(djId, '❌ 이미 있는 종목명이에요.'); return }
  const price = stkParseMoney(priceRaw)
  let divRate = parts[3] != null ? parseFloat(parts[3]) : NaN
  if (isNaN(divRate)) divRate = Math.round((0.5 + Math.random() * 2.5) * 2) / 2
  stock.stocks.push({ name, price, dividendRate: divRate, lastPct: 0 })
  saveStock(djId, stock)
  stkReply(djId, `✅ 종목 설립 완료! ${name} (시작가 ${Math.round(price).toLocaleString()}원, 배당률 ${divRate}%)`)
}
function stkCmdStockDelete(djId, stock, parts) {
  const name = parts[1]
  const idx = stock.stocks.findIndex(s => s.name === name)
  if (idx < 0) { stkReply(djId, '❌ 없는 종목이에요.'); return }
  const st = stock.stocks[idx]
  for (const key in stock.users) {
    const u = stock.users[key]
    const h = u.holdings[name]
    if (h && h.qty > 0) { u.cash += h.qty * st.price; delete u.holdings[name] }
  }
  stock.stocks.splice(idx, 1)
  saveStock(djId, stock)
  stkReply(djId, `🗑️ ${name} 종목이 폐지됐어요. 보유자 전원에게 현재가로 정산 완료.`)
}
// !머니지급 [고유닉] [금액] — 닉네임이 아니라 반드시 "고유닉"을 직접 입력해야 한다.
function stkCmdGiveMoney(djId, room, stock, parts) {
  let targetTag = parts[1]
  const amt = stkParseMoney(parts.slice(2).join(' '))
  if (!targetTag || !amt) { stkReply(djId, '사용법: !머니지급 [고유닉] [금액] (닉네임이 아니라 고유닉을 입력해주세요)'); return }
  targetTag = targetTag.replace(/^@/, '').trim().toLowerCase()
  const knownNickname = (room && room.tagToNickname && room.tagToNickname.get(targetTag)) || targetTag
  const u = stkGetUser(stock, targetTag, knownNickname)
  u.cash = (u.cash || 0) + amt
  saveStock(djId, stock)
  stkReply(djId, `🎁 [운영자] ${u.nickname}님(@${targetTag})께 ${stkFmt(amt)} 지급 완료 (보유 현금: ${stkFmt(u.cash)})`)
}

// ── 채팅 이벤트 마스터 디스패처 ── actTag: 이 메시지에서 이미 조회해둔 발화자의 고유닉 (재사용, 중복 API 호출 방지)
async function handleStockCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  if (!isModuleOn(settings, 'stock', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const stock = getStockSettings(djId, settings)
  const cfg = stock.config
  if (cfg.enabled === false) return
  const parts = msg.split(/\s+/)
  const cmd = parts[0]
  const isDj = _stkIsDj(djId, room, settings, authorId, author)

  if (cmd === cfg.cmdStockCreate) { if (isDj) stkCmdStockCreate(djId, stock, parts); return }
  if (cmd === cfg.cmdStockDelete) { if (isDj) stkCmdStockDelete(djId, stock, parts); return }
  if (cmd === cfg.cmdGiveMoney) { if (isDj) stkCmdGiveMoney(djId, room, stock, parts); return }

  if (cmd === cfg.cmdStart) return stkCmdStart(djId, stock, actTag, author)
  if (cmd === cfg.cmdAttend) return stkCmdAttend(djId, stock, actTag, author)
  if (cmd === cfg.cmdRule) return stkCmdRule(djId, cfg, parts)
  if (cmd === cfg.cmdMyInfo) return stkCmdMyInfo(djId, stock, actTag, author)
  if (cmd === cfg.cmdMyMoney) return stkCmdMyMoney(djId, stock, actTag, author)
  if (cmd === cfg.cmdStockList) return stkCmdStockList(djId, stock)
  if (cmd === cfg.cmdMyStock) return stkCmdMyStock(djId, stock, actTag, author)
  if (cmd === cfg.cmdRanking) return stkCmdRanking(djId, stock, cfg)
  if (cmd === cfg.cmdJackpot) return stkCmdJackpot(djId, stock)
  if (cmd === cfg.cmdDeposit) return stkCmdDeposit(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdWithdraw) return stkCmdWithdraw(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdLoan) return stkCmdLoan(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdRepay) return stkCmdRepay(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdSlot) return stkCmdSlot(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdRoulette) return stkCmdRoulette(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdOddEven) return stkCmdOddEven(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdDice) return stkCmdDice(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdLotto) return stkCmdLotto(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdShop) return stkCmdShop(djId, cfg)
  if (cmd === cfg.cmdBuy) return stkCmdBuyItem(djId, stock, actTag, author, parts)
  if (cmd === cfg.cmdUse) return stkCmdUseItem(djId, stock, actTag, author, parts)

  const stockName = cmd.slice(1)
  const st = stock.stocks.find(s => s.name === stockName)
  if (st) return stkCmdTrade(djId, stock, actTag, author, st, parts)
}


// ══════════════════════════════════════════════════════
// 🔨 경매 시스템 — 누적 입찰 방식의 경매. 후원(스티커)으로 입찰하고 총액으로 경쟁한다.
// 후원 → 정해진 유효시간(기본 60초) 안에 "!경매 [번호]"를 쳐야 그 후원액이 해당 경매에 입찰로 반영된다.
// 같은 사람이 같은 경매에 여러 번 입찰하면 총액이 누적된다 (경매마다 별도 누적).
// 공개 방식(visibility) 4종에 따라 닉네임/누적금액/순위 공개 여부가 달라진다.

// 🔨 경매 시스템 — "!경매 참여"로 먼저 참가 등록한 사람만, 그 이후 보내는 선물(후원)이
// 자동으로 이 경매에 반영된다(더 이상 후원 후 번호를 따로 입력할 필요 없음).
// 여러 명이 보낸 스푼 총액 대비 내 누적 비율 = 당첨 확률이고, 경매 종료 시 그 확률로 추첨해서
// 한 명을 당첨자로 뽑는 방식(래플)이다. 한 방송에서는 경매를 한 번에 하나만 진행할 수 있다 —
// 진행중인 경매가 끝나야(종료/취소) 다음 경매를 새로 등록할 수 있다.

function auctionDefaultConfig() {
  return {
    enabled: true,
    announceOnBid: true,
    cmd: '!경매',
    cmdMyBid: '!내입찰',
    cmdEnd: '!경매종료',
    cmdCancel: '!경매취소',
  }
}
const AUCTION_VIS = {
  full_blind: { nickname: false, amount: false, rank: false },
  price_blind: { nickname: true, amount: false, rank: true },
  info_blind: { nickname: false, amount: true, rank: false },
  public: { nickname: true, amount: true, rank: true },
}
function auctionVisOf(auc) { return AUCTION_VIS[auc.visibility] || AUCTION_VIS.public }

function getAuctionSettings(djId, settings) {
  if (!settings.auction) {
    settings.auction = { config: auctionDefaultConfig(), list: [], nextId: 1 }
    store.saveSettings(djId, { auction: settings.auction })
  }
  const a = settings.auction
  if (!a.config) a.config = auctionDefaultConfig()
  if (!Array.isArray(a.list)) a.list = []
  if (!a.nextId) a.nextId = (a.list.reduce((m, x) => Math.max(m, x.id || 0), 0) || 0) + 1
  return a
}
function saveAuction(djId, a) { store.saveSettings(djId, { auction: a }) }
function auctionActive(a) { return a.list.find(x => x.status === 'active') || null }
function auctionRanking(auc) {
  return Object.entries(auc.bids || {}).map(([tag, b]) => ({ tag, ...b })).sort((x, y) => y.total - x.total)
}
function auctionFmt(n) { return Math.round(Number(n) || 0).toLocaleString() }
function auctionTotalSpoons(auc) { return Object.values(auc.bids || {}).reduce((s, b) => s + (b.total || 0), 0) }
// 참여자별 누적 금액 비율(=당첨 확률)에 따라 가중치 랜덤으로 한 명을 뽑는다 (래플).
function auctionPickWeightedWinner(auc) {
  const entries = Object.entries(auc.bids || {}).filter(([, b]) => b.total > 0)
  if (!entries.length) return null
  const total = entries.reduce((s, [, b]) => s + b.total, 0)
  let r = Math.random() * total
  for (const [tag, b] of entries) {
    r -= b.total
    if (r <= 0) return { tag, nickname: b.nickname, total: b.total }
  }
  const [tag, b] = entries[entries.length - 1]
  return { tag, nickname: b.nickname, total: b.total }
}

// "!경매 참여"로 등록한 사람만 대상 — 선물(후원) 수신 시 진행중인 경매가 있으면 자동으로 누적 반영한다.
function handleAuctionDonationHook(djId, settings, author, tag, spoonTotal) {
  if (!isModuleOn(settings, 'auction', djId)) return
  if (spoonTotal <= 0) return
  const a = getAuctionSettings(djId, settings)
  if (a.config.enabled === false) return
  const auc = auctionActive(a)
  if (!auc) return // 진행중인 경매가 없으면 무시
  const key = String(tag || author || '').trim().toLowerCase()
  if (!key) return
  if (!auc.joined || !auc.joined[key]) return // "!경매 참여"로 먼저 참가 등록한 사람만 자동 반영됨

  if (!auc.bids) auc.bids = {}
  const bid = auc.bids[key] || { nickname: author, total: 0 }
  bid.total += spoonTotal
  bid.nickname = author
  bid.lastBidAt = Date.now()
  auc.bids[key] = bid
  saveAuction(djId, a)

  const vis = auctionVisOf(auc)
  const totalAll = auctionTotalSpoons(auc)
  const pct = totalAll > 0 ? Math.round((bid.total / totalAll) * 1000) / 10 : 0

  if (a.config.announceOnBid) {
    let msg = `💰 [${auc.itemName}] `
    msg += vis.nickname ? `${author}님 ` : `참여자님 `
    msg += `${auctionFmt(spoonTotal)}스푼!`
    if (vis.amount) msg += ` 현재 확률 ${pct}%`
    if (vis.amount) msg += ` (누적 ${auctionFmt(bid.total)}스푼)`
    sendChatSplit(djId, msg, 150, 300)
  }
}

function auctionJoin(djId, a, tag, author) {
  const auc = auctionActive(a)
  if (!auc) { sendChatSplit(djId, '❌ 지금 진행중인 경매가 없어요.', 150, 300); return }
  const key = String(tag || author || '').trim().toLowerCase()
  if (!key) { sendChatSplit(djId, '⚠️ 닉네임을 확인하지 못했어요. 잠시 후 다시 시도해주세요.', 150, 300); return }
  if (!auc.joined) auc.joined = {}
  if (auc.joined[key]) {
    sendChatSplit(djId, `✅ ${author}님은 이미 [${auc.itemName}] 경매에 참여중이에요. 선물을 보내면 자동으로 확률에 반영돼요!`, 150, 300)
    return
  }
  auc.joined[key] = { nickname: author, joinedAt: Date.now() }
  saveAuction(djId, a)
  sendChatSplit(djId, `🙋 ${author}님 [${auc.itemName}] 경매 참여 완료!\n이제 선물을 보내면 자동으로 누적되고 확률에 반영돼요`, 150, 300)
}

function auctionListMsg(djId, a) {
  const auc = auctionActive(a)
  if (!auc) { sendChatSplit(djId, '🔨 진행중인 경매가 없어요.', 150, 300); return }
  const joinedCount = Object.keys(auc.joined || {}).length
  const totalAll = auctionTotalSpoons(auc)
  sendChatSplit(djId, `🔨 [${auc.itemName}] 경매 진행중\n🙋 참여 ${joinedCount}명 · 💰 누적 ${auctionFmt(totalAll)}스푼\n→ ${a.config.cmd} 참여 로 참여하고, 선물을 보내면 자동으로 확률에 반영돼요`, 150, 300)
}

function auctionMyBids(djId, a, tag, author) {
  const key = String(tag || author || '').trim().toLowerCase()
  if (!key) { sendChatSplit(djId, '⚠️ 닉네임을 확인하지 못했어요. 잠시 후 다시 시도해주세요.', 150, 300); return }
  const mine = a.list.filter(x => (x.joined && x.joined[key]) || (x.bids && x.bids[key]))
  if (!mine.length) { sendChatSplit(djId, `📋 ${author}님은 참여중인 경매가 없어요.`, 150, 300); return }
  const lines = mine.map(x => {
    const vis = auctionVisOf(x)
    const total = auctionTotalSpoons(x)
    const my = (x.bids && x.bids[key]) || { total: 0 }
    const pct = total > 0 ? Math.round((my.total / total) * 1000) / 10 : 0
    const showDetail = x.status !== 'active' // 종료/취소된 경매는 블라인드 상관없이 본인껀 다 보여줌
    let line = `[${x.itemName}]`
    if (vis.amount || showDetail) line += ` - 누적 ${auctionFmt(my.total)}스푼 (확률 ${pct}%)`
    if (x.status === 'ended') line += (x.winner && x.winner.tag === key) ? ' 🏆당첨!' : ' (종료)'
    if (x.status === 'cancelled') line += ' (취소됨)'
    return line
  })
  sendChatSplit(djId, `📋 ${author}님의 경매 참여 현황\n${lines.join('\n')}`, 150, 300)
}

function auctionEnd(djId, a, id, status) {
  const auc = a.list.find(x => x.id === id)
  if (!auc || auc.status !== 'active') return
  auc.status = status
  if (status === 'ended') {
    const winner = auctionPickWeightedWinner(auc)
    if (winner) {
      const totalAll = auctionTotalSpoons(auc)
      const pct = totalAll > 0 ? Math.round((winner.total / totalAll) * 1000) / 10 : 0
      auc.winner = winner
      sendChatSplit(djId, `🎉 [${auc.itemName}] 경매 종료! 추첨 당첨자: ${winner.nickname}님 🎊\n(당첨 확률 ${pct}% · 누적 ${auctionFmt(winner.total)}스푼)`, 150, 300)
    } else {
      sendChatSplit(djId, `🔨 [${auc.itemName}] 경매가 참여자 없이 종료됐어요.`, 150, 300)
    }
  } else {
    sendChatSplit(djId, `🚫 [${auc.itemName}] 경매가 취소됐어요.`, 150, 300)
  }
  saveAuction(djId, a)
}

async function handleAuctionCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  if (!isModuleOn(settings, 'auction', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const a = getAuctionSettings(djId, settings)
  const cfg = a.config
  if (cfg.enabled === false) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  if (cfg.cmdEnd && msg === cfg.cmdEnd) {
    if (isDj) { const auc = auctionActive(a); if (auc) auctionEnd(djId, a, auc.id, 'ended') }
    return
  }
  if (cfg.cmdCancel && msg === cfg.cmdCancel) {
    if (isDj) { const auc = auctionActive(a); if (auc) auctionEnd(djId, a, auc.id, 'cancelled') }
    return
  }
  if (cfg.cmdMyBid && msg === cfg.cmdMyBid) { auctionMyBids(djId, a, actTag, author); return }
  if (cfg.cmd && msg === `${cfg.cmd} 참여`) { auctionJoin(djId, a, actTag, author); return }
  if (cfg.cmd && msg === cfg.cmd) { auctionListMsg(djId, a); return }
}

// 방송에 봇이 접속해있는 동안, 종료 시간이 지난 진행중 경매를 자동으로 종료 처리한다.
setInterval(() => {
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (!room.isConnected) continue
    const settings = store.getSettings(djId) || {}
    if (!isModuleOn(settings, 'auction', djId)) continue
    const a = getAuctionSettings(djId, settings)
    const auc = auctionActive(a)
    if (auc && auc.endAt && Date.now() >= auc.endAt) {
      auctionEnd(djId, a, auc.id, 'ended')
    }
  }
}, 20000)


// ══════════════════════════════════════════════════════
// ⚔️ 검키우기 — 기존 "Sopia" 봇용으로 만들어져 있던 게임을 이 서버(Express) 구조로 이식.
// 게임 로직(강화/던전/배틀/랭킹 등 계산 공식)은 원본 그대로이고, 메시지 송수신 부분만
// 이 서버의 채팅 파이프라인에 맞게 다시 연결했다.
// 유저 데이터(검 레벨/골드 등)는 기존처럼 Base44(외부 DB)에 저장돼있던 걸 그대로 쓴다 —
// !저장/!로드 명령어로 수동 동기화(원본과 동일한 방식). 설정(강화확률/상점 등)은
// 관리자(sum) 계정 아래 공용으로 저장해서, 이 모듈을 켠 모든 방송이 같은 설정을 공유한다
// (플레이어 데이터가 Base44에 태그 기준으로 전역 저장되는 것과 같은 맥락).
//
// ⚠️ 이식 범위: 강화·던전·배틀·랭킹·검정보(프로필)·판매·창고·유물·룬·탐험·룬제작/판매/강화·
// 출석·저장/로드·검온오프·도움말 (1차) + 상점/구매·펫·몬스터박스·방보스·자동배틀·거래소·
// 관리자 지급(!쿠폰/!보상) (2차, handleSwordHelp 함수 위쪽 "2차 이식" 섹션 참고) 까지 이식 완료.

const APP_URL = 'https://copy-09a708e1.base44.app'
let API_TOKEN = process.env.SWORD_API_TOKEN || '102810aa'

let localUsers = new Map()
let localSettings = null
let enhanceCooldowns = new Map()
let battleCooldowns = new Map()
let dungeonCooldowns = new Map()
let loadCooldowns = new Map()
let bannedUsersCache = new Set()
let lastBannedCheck = 0

// 2차 이식(상점/펫/몬스터박스/자동배틀/거래소/방보스/관리자 지급) 전용 상태 — 전부 인메모리, 프로세스 재시작 시 초기화됨
let autoBattleUsers = new Map()      // tag -> true (자동배틀 진행 중 표시)
let autoBattleIntervals = new Map()  // tag -> setInterval id
let autoBattleTimeouts = new Map()   // tag -> setTimeout id (종료 예약)
let autoBattleStats = new Map()      // tag -> { battles, wins, losses, goldEarned }
let marketListings = []              // 거래소(자동쿠폰 전용): [{ id, sellerTag, sellerNick, qty, price, createdAt }]
let currentBoss = null               // 방보스: { name, hp, maxHp, contributions:{tag:damage}, spawnedAt } | null
let bossCooldowns = new Map()        // tag -> 마지막 !참여 시각 (연타 방지)

async function checkBannedUser(tag) {
  // 5분마다 캐시 갱신
  if (Date.now() - lastBannedCheck > 300000) {
    try {
      const response = await apiRequest('getBannedUsers', 'GET', {});
      if (response.success && response.banned_tags) {
        bannedUsersCache = new Set(response.banned_tags);
        lastBannedCheck = Date.now();
      }
    } catch (error) {
      console.log('[차단 체크 실패]', error);
    }
  }
  
  return bannedUsersCache.has(tag);
}

async function apiRequest(endpoint, method = 'GET', params = {}, body = null) {
  const url = new URL(APP_URL + '/functions/' + endpoint);
  if (method === 'GET') {
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
  }
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + API_TOKEN,
    },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  return await response.json();
}

async function loadUserFromDB(tag) {
  try {
    const response = await apiRequest('loadGlobalSwordUser', 'POST', {}, { tag });
    return response.success && response.user ? response.user : null;
  } catch (error) {
    return null;
  }
}

async function saveUserToDB(user) {
  try {
    const payload = {
      tag: user.tag,
      userData: {
        nickname: user.nickname,
        gold: user.gold,
        spoon_points: user.spoon_points,
        sword_level: user.sword_level,
        max_sword_level: user.max_sword_level,
        attack_power: user.attack_power,
        weapon_bonus: user.weapon_bonus,
        weapon_bonus2: user.weapon_bonus2,
        weapon_bonus3: user.weapon_bonus3,
        battle_wins: user.battle_wins,
        battle_losses: user.battle_losses,
        inventory: user.inventory,
        special_weapon: user.special_weapon,
        last_daily_money_date: user.last_daily_money_date,
        current_dungeon_floor: user.current_dungeon_floor,
        relics: user.relics,
        dungeon_tickets: user.dungeon_tickets,
        auto_battle_tickets: user.auto_battle_tickets,
        runes: user.runes,
        rune_fragments: user.rune_fragments,
        last_explore_date: user.last_explore_date,
        explore_count: user.explore_count,
        user_plan_level: user.user_plan_level,
        pets: user.pets,
        equipped_pet_id: user.equipped_pet_id,
        pet_fragments: user.pet_fragments
      }
    };
    await apiRequest('saveGlobalSwordUser', 'POST', {}, payload);
    return true;
  } catch (error) {
    return false;
  }
}

function initializeSettings() {
  if (localSettings) return localSettings;

  // DB에서 불러온 설정이 있으면 사용
  const savedSettings = {
  "enabled": true,
  "initial_gold": 2000000,
  "daily_money": 1500000,
  "like_reward": 500000,
  "spoon_to_gold_rate": 1,
  "enhance_cooldown": 4,
  "battle_cooldown": 6,
  "dungeon_cooldown": 5,
  "enhance_success_rates": [
    {
      "level": 0,
      "cost": 10,
      "success_rate": 100,
      "fail_rate": 0,
      "down_rate": 0,
      "destroy_rate": 0
    },
    {
      "level": 1,
      "cost": 20,
      "success_rate": 95,
      "fail_rate": 5,
      "down_rate": 0,
      "destroy_rate": 0
    },
    {
      "level": 2,
      "cost": 50,
      "success_rate": 90,
      "fail_rate": 10,
      "down_rate": 0,
      "destroy_rate": 0
    },
    {
      "level": 3,
      "cost": 100,
      "success_rate": 85,
      "fail_rate": 15,
      "down_rate": 0,
      "destroy_rate": 0
    },
    {
      "level": 4,
      "cost": 200,
      "success_rate": 80,
      "fail_rate": 20,
      "down_rate": 0,
      "destroy_rate": 0
    },
    {
      "level": 5,
      "cost": 500,
      "success_rate": 75,
      "fail_rate": 20,
      "down_rate": 5,
      "destroy_rate": 0
    },
    {
      "level": 6,
      "cost": 1000,
      "success_rate": 70,
      "fail_rate": 20,
      "down_rate": 10,
      "destroy_rate": 0
    },
    {
      "level": 7,
      "cost": 2000,
      "success_rate": 65,
      "fail_rate": 20,
      "down_rate": 15,
      "destroy_rate": 0
    },
    {
      "level": 8,
      "cost": 5000,
      "success_rate": 60,
      "fail_rate": 20,
      "down_rate": 15,
      "destroy_rate": 5
    },
    {
      "level": 9,
      "cost": 10000,
      "success_rate": 55,
      "fail_rate": 20,
      "down_rate": 15,
      "destroy_rate": 10
    },
    {
      "level": 10,
      "cost": 20000,
      "success_rate": 50,
      "fail_rate": 20,
      "down_rate": 15,
      "destroy_rate": 15
    },
    {
      "level": 11,
      "cost": 40000,
      "success_rate": 48,
      "fail_rate": 20,
      "down_rate": 17,
      "destroy_rate": 15
    },
    {
      "level": 12,
      "cost": 80000,
      "success_rate": 46,
      "fail_rate": 20,
      "down_rate": 19,
      "destroy_rate": 15
    },
    {
      "level": 13,
      "cost": 160000,
      "success_rate": 44,
      "fail_rate": 20,
      "down_rate": 20,
      "destroy_rate": 16
    },
    {
      "level": 14,
      "cost": 320000,
      "success_rate": 42,
      "fail_rate": 20,
      "down_rate": 20,
      "destroy_rate": 18
    },
    {
      "level": 15,
      "cost": 640000,
      "success_rate": 40,
      "fail_rate": 20,
      "down_rate": 20,
      "destroy_rate": 20
    },
    {
      "level": 16,
      "cost": 1280000,
      "success_rate": 38,
      "fail_rate": 20,
      "down_rate": 21,
      "destroy_rate": 21
    },
    {
      "level": 17,
      "cost": 2560000,
      "success_rate": 36,
      "fail_rate": 20,
      "down_rate": 22,
      "destroy_rate": 22
    },
    {
      "level": 18,
      "cost": 5000000,
      "success_rate": 34,
      "fail_rate": 20,
      "down_rate": 23,
      "destroy_rate": 23
    },
    {
      "level": 19,
      "cost": 10000000,
      "success_rate": 32,
      "fail_rate": 20,
      "down_rate": 24,
      "destroy_rate": 24
    },
    {
      "level": 20,
      "cost": 20000000,
      "success_rate": 30,
      "fail_rate": 20,
      "down_rate": 25,
      "destroy_rate": 25
    },
    {
      "level": 21,
      "cost": 40000000,
      "success_rate": 28,
      "fail_rate": 20,
      "down_rate": 26,
      "destroy_rate": 26
    },
    {
      "level": 22,
      "cost": 80000000,
      "success_rate": 26,
      "fail_rate": 20,
      "down_rate": 27,
      "destroy_rate": 27
    },
    {
      "level": 23,
      "cost": 160000000,
      "success_rate": 24,
      "fail_rate": 20,
      "down_rate": 28,
      "destroy_rate": 28
    },
    {
      "level": 24,
      "cost": 320000000,
      "success_rate": 22,
      "fail_rate": 20,
      "down_rate": 29,
      "destroy_rate": 29
    },
    {
      "level": 25,
      "cost": 640000000,
      "success_rate": 20,
      "fail_rate": 20,
      "down_rate": 30,
      "destroy_rate": 30
    },
    {
      "level": 26,
      "cost": 1280000000,
      "success_rate": 18,
      "fail_rate": 20,
      "down_rate": 31,
      "destroy_rate": 31
    },
    {
      "level": 27,
      "cost": 2560000000,
      "success_rate": 16,
      "fail_rate": 20,
      "down_rate": 32,
      "destroy_rate": 32
    },
    {
      "level": 28,
      "cost": 5000000000,
      "success_rate": 14,
      "fail_rate": 20,
      "down_rate": 33,
      "destroy_rate": 33
    },
    {
      "level": 29,
      "cost": 10000000000,
      "success_rate": 12,
      "fail_rate": 20,
      "down_rate": 34,
      "destroy_rate": 34
    },
    {
      "level": 30,
      "cost": 20000000000,
      "success_rate": 10,
      "fail_rate": 20,
      "down_rate": 35,
      "destroy_rate": 35
    },
    {
      "level": 31,
      "cost": 40000000000,
      "success_rate": 9,
      "fail_rate": 20,
      "down_rate": 35,
      "destroy_rate": 36
    },
    {
      "level": 32,
      "cost": 80000000000,
      "success_rate": 8,
      "fail_rate": 20,
      "down_rate": 36,
      "destroy_rate": 36
    },
    {
      "level": 33,
      "cost": 160000000000,
      "success_rate": 7,
      "fail_rate": 20,
      "down_rate": 36,
      "destroy_rate": 37
    },
    {
      "level": 34,
      "cost": 320000000000,
      "success_rate": 6,
      "fail_rate": 20,
      "down_rate": 37,
      "destroy_rate": 37
    },
    {
      "level": 35,
      "cost": 640000000000,
      "success_rate": 5,
      "fail_rate": 20,
      "down_rate": 37,
      "destroy_rate": 38
    },
    {
      "level": 36,
      "cost": 1280000000000,
      "success_rate": 5,
      "fail_rate": 19,
      "down_rate": 38,
      "destroy_rate": 38
    },
    {
      "level": 37,
      "cost": 2560000000000,
      "success_rate": 4,
      "fail_rate": 19,
      "down_rate": 38,
      "destroy_rate": 39
    },
    {
      "level": 38,
      "cost": 5000000000000,
      "success_rate": 4,
      "fail_rate": 19,
      "down_rate": 38,
      "destroy_rate": 39
    },
    {
      "level": 39,
      "cost": 10000000000000,
      "success_rate": 3,
      "fail_rate": 19,
      "down_rate": 39,
      "destroy_rate": 39
    },
    {
      "level": 40,
      "cost": 20000000000000,
      "success_rate": 3,
      "fail_rate": 19,
      "down_rate": 39,
      "destroy_rate": 39
    },
    {
      "level": 41,
      "cost": 40000000000000,
      "success_rate": 3,
      "fail_rate": 18,
      "down_rate": 39,
      "destroy_rate": 40
    },
    {
      "level": 42,
      "cost": 80000000000000,
      "success_rate": 2,
      "fail_rate": 18,
      "down_rate": 40,
      "destroy_rate": 40
    },
    {
      "level": 43,
      "cost": 160000000000000,
      "success_rate": 2,
      "fail_rate": 18,
      "down_rate": 40,
      "destroy_rate": 40
    },
    {
      "level": 44,
      "cost": 320000000000000,
      "success_rate": 2,
      "fail_rate": 18,
      "down_rate": 40,
      "destroy_rate": 40
    },
    {
      "level": 45,
      "cost": 640000000000000,
      "success_rate": 2,
      "fail_rate": 17,
      "down_rate": 40,
      "destroy_rate": 41
    },
    {
      "level": 46,
      "cost": 1280000000000000,
      "success_rate": 1,
      "fail_rate": 17,
      "down_rate": 41,
      "destroy_rate": 41
    },
    {
      "level": 47,
      "cost": 2560000000000000,
      "success_rate": 1,
      "fail_rate": 17,
      "down_rate": 41,
      "destroy_rate": 41
    },
    {
      "level": 48,
      "cost": 5000000000000000,
      "success_rate": 1,
      "fail_rate": 17,
      "down_rate": 41,
      "destroy_rate": 41
    },
    {
      "level": 49,
      "cost": 10000000000000000,
      "success_rate": 1,
      "fail_rate": 16,
      "down_rate": 41,
      "destroy_rate": 42
    }
  ],
  "weapon_names": [
    {
      "level": 0,
      "name": "낡은 검"
    },
    {
      "level": 1,
      "name": "무쇠 검"
    },
    {
      "level": 2,
      "name": "강철 검"
    },
    {
      "level": 3,
      "name": "은 검"
    },
    {
      "level": 4,
      "name": "미스릴 검"
    },
    {
      "level": 5,
      "name": "마법 검"
    },
    {
      "level": 6,
      "name": "전설 검"
    },
    {
      "level": 7,
      "name": "신화 검"
    },
    {
      "level": 8,
      "name": "초월 검"
    },
    {
      "level": 9,
      "name": "불멸 검"
    },
    {
      "level": 10,
      "name": "신검"
    },
    {
      "level": 11,
      "name": "천상의 검"
    },
    {
      "level": 12,
      "name": "성스러운 검"
    },
    {
      "level": 13,
      "name": "영원의 검"
    },
    {
      "level": 14,
      "name": "용의 검"
    },
    {
      "level": 15,
      "name": "봉황의 검"
    },
    {
      "level": 16,
      "name": "태양의 검"
    },
    {
      "level": 17,
      "name": "달의 검"
    },
    {
      "level": 18,
      "name": "별의 검"
    },
    {
      "level": 19,
      "name": "은하의 검"
    },
    {
      "level": 20,
      "name": "우주의 검"
    },
    {
      "level": 21,
      "name": "시공의 검"
    },
    {
      "level": 22,
      "name": "차원의 검"
    },
    {
      "level": 23,
      "name": "운명의 검"
    },
    {
      "level": 24,
      "name": "창조의 검"
    },
    {
      "level": 25,
      "name": "파괴의 검"
    },
    {
      "level": 26,
      "name": "절대의 검"
    },
    {
      "level": 27,
      "name": "무한의 검"
    },
    {
      "level": 28,
      "name": "궁극의 검"
    },
    {
      "level": 29,
      "name": "진리의 검"
    },
    {
      "level": 30,
      "name": "천지의 검"
    },
    {
      "level": 31,
      "name": "혼돈의 검"
    },
    {
      "level": 32,
      "name": "질서의 검"
    },
    {
      "level": 33,
      "name": "빛의 검"
    },
    {
      "level": 34,
      "name": "어둠의 검"
    },
    {
      "level": 35,
      "name": "생명의 검"
    },
    {
      "level": 36,
      "name": "죽음의 검"
    },
    {
      "level": 37,
      "name": "신성의 검"
    },
    {
      "level": 38,
      "name": "마신의 검"
    },
    {
      "level": 39,
      "name": "천벌의 검"
    },
    {
      "level": 40,
      "name": "구원의 검"
    },
    {
      "level": 41,
      "name": "심판의 검"
    },
    {
      "level": 42,
      "name": "계시의 검"
    },
    {
      "level": 43,
      "name": "예언의 검"
    },
    {
      "level": 44,
      "name": "신탁의 검"
    },
    {
      "level": 45,
      "name": "천명의 검"
    },
    {
      "level": 46,
      "name": "영겁의 검"
    },
    {
      "level": 47,
      "name": "불멸왕의 검"
    },
    {
      "level": 48,
      "name": "세계수의 검"
    },
    {
      "level": 49,
      "name": "창세신의 검"
    }
  ],
  "level_first_achievers": {},
  "sell_price_multiplier": 10,
  "shop_items": [
    {
      "name": "⚔️강화제(성공률 10%상승)",
      "price": 10000,
      "effect_type": "enhance_boost",
      "effect_value": 10
    },
    {
      "name": "⚔️강화제(성공률 40%상승)",
      "price": 100000,
      "effect_type": "enhance_boost",
      "effect_value": 40
    },
    {
      "name": "🛡️파괴방지(1회성)",
      "price": 10000,
      "effect_type": "destroy_prevent",
      "effect_value": 1
    },
    {
      "name": "🔄옵션 재설정",
      "price": 20000,
      "effect_type": "reroll_option",
      "effect_value": 0
    },
    {
      "name": "✨옵션 부여 부적",
      "price": 200000,
      "effect_type": "add_option",
      "effect_value": 0
    },
    {
      "name": "🔐옵션 잠금 부적(1회성)",
      "price": 20000,
      "effect_type": "option_lock",
      "effect_value": 1
    },
    {
      "name": "🛡️하락방지(1회성)",
      "price": 20000,
      "effect_type": "down_prevent",
      "effect_value": 1
    },
    {
      "name": "🎁미스터리 선물 상자",
      "price": 200000,
      "effect_type": "mystery_box",
      "effect_value": 0
    },
    {
      "name": "⛩던전 이용권",
      "price": 10000,
      "effect_type": "dungeon_ticket",
      "effect_value": 1
    },
    {
      "name": "🏁던전 리셋권",
      "price": 500000,
      "effect_type": "dungeon_reset",
      "effect_value": 0
    }
  ],
  "battle_reward_base": 7000,
  "dungeon_floors": [
    {
      "floor": 1,
      "monster_level": 1,
      "monster_attack": 17,
      "gold_reward": 10000,
      "item_rewards": []
    },
    {
      "floor": 2,
      "monster_level": 1,
      "monster_attack": 17,
      "gold_reward": 20000,
      "item_rewards": []
    },
    {
      "floor": 3,
      "monster_level": 1,
      "monster_attack": 17,
      "gold_reward": 30000,
      "item_rewards": []
    },
    {
      "floor": 4,
      "monster_level": 2,
      "monster_attack": 35,
      "gold_reward": 40000,
      "item_rewards": []
    },
    {
      "floor": 5,
      "monster_level": 2,
      "monster_attack": 38,
      "gold_reward": 50000,
      "item_rewards": []
    },
    {
      "floor": 6,
      "monster_level": 2,
      "monster_attack": 38,
      "gold_reward": 60000,
      "item_rewards": []
    },
    {
      "floor": 7,
      "monster_level": 3,
      "monster_attack": 56,
      "gold_reward": 70000,
      "item_rewards": []
    },
    {
      "floor": 8,
      "monster_level": 3,
      "monster_attack": 56,
      "gold_reward": 80000,
      "item_rewards": []
    },
    {
      "floor": 9,
      "monster_level": 3,
      "monster_attack": 56,
      "gold_reward": 90000,
      "item_rewards": []
    },
    {
      "floor": 10,
      "monster_level": 3,
      "monster_attack": 59,
      "gold_reward": 100000,
      "item_rewards": [
        {
          "item_name": "화염의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 60,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 11,
      "monster_level": 4,
      "monster_attack": 74,
      "gold_reward": 110000,
      "item_rewards": []
    },
    {
      "floor": 12,
      "monster_level": 4,
      "monster_attack": 74,
      "gold_reward": 120000,
      "item_rewards": []
    },
    {
      "floor": 13,
      "monster_level": 4,
      "monster_attack": 77,
      "gold_reward": 130000,
      "item_rewards": []
    },
    {
      "floor": 14,
      "monster_level": 5,
      "monster_attack": 92,
      "gold_reward": 140000,
      "item_rewards": []
    },
    {
      "floor": 15,
      "monster_level": 5,
      "monster_attack": 95,
      "gold_reward": 150000,
      "item_rewards": []
    },
    {
      "floor": 16,
      "monster_level": 5,
      "monster_attack": 95,
      "gold_reward": 160000,
      "item_rewards": []
    },
    {
      "floor": 17,
      "monster_level": 6,
      "monster_attack": 113,
      "gold_reward": 170000,
      "item_rewards": []
    },
    {
      "floor": 18,
      "monster_level": 6,
      "monster_attack": 113,
      "gold_reward": 180000,
      "item_rewards": []
    },
    {
      "floor": 19,
      "monster_level": 6,
      "monster_attack": 113,
      "gold_reward": 190000,
      "item_rewards": []
    },
    {
      "floor": 20,
      "monster_level": 6,
      "monster_attack": 116,
      "gold_reward": 200000,
      "item_rewards": [
        {
          "item_name": "얼음의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 30,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 30,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 21,
      "monster_level": 7,
      "monster_attack": 134,
      "gold_reward": 210000,
      "item_rewards": []
    },
    {
      "floor": 22,
      "monster_level": 7,
      "monster_attack": 134,
      "gold_reward": 220000,
      "item_rewards": []
    },
    {
      "floor": 23,
      "monster_level": 7,
      "monster_attack": 134,
      "gold_reward": 230000,
      "item_rewards": []
    },
    {
      "floor": 24,
      "monster_level": 8,
      "monster_attack": 152,
      "gold_reward": 240000,
      "item_rewards": []
    },
    {
      "floor": 25,
      "monster_level": 8,
      "monster_attack": 155,
      "gold_reward": 250000,
      "item_rewards": []
    },
    {
      "floor": 26,
      "monster_level": 8,
      "monster_attack": 155,
      "gold_reward": 260000,
      "item_rewards": []
    },
    {
      "floor": 27,
      "monster_level": 9,
      "monster_attack": 173,
      "gold_reward": 270000,
      "item_rewards": []
    },
    {
      "floor": 28,
      "monster_level": 9,
      "monster_attack": 173,
      "gold_reward": 280000,
      "item_rewards": []
    },
    {
      "floor": 29,
      "monster_level": 9,
      "monster_attack": 173,
      "gold_reward": 290000,
      "item_rewards": []
    },
    {
      "floor": 30,
      "monster_level": 9,
      "monster_attack": 176,
      "gold_reward": 300000,
      "item_rewards": [
        {
          "item_name": "번개의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 20,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 20,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 20,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 31,
      "monster_level": 10,
      "monster_attack": 194,
      "gold_reward": 310000,
      "item_rewards": []
    },
    {
      "floor": 32,
      "monster_level": 10,
      "monster_attack": 194,
      "gold_reward": 320000,
      "item_rewards": []
    },
    {
      "floor": 33,
      "monster_level": 10,
      "monster_attack": 197,
      "gold_reward": 330000,
      "item_rewards": []
    },
    {
      "floor": 34,
      "monster_level": 11,
      "monster_attack": 215,
      "gold_reward": 340000,
      "item_rewards": []
    },
    {
      "floor": 35,
      "monster_level": 11,
      "monster_attack": 218,
      "gold_reward": 350000,
      "item_rewards": []
    },
    {
      "floor": 36,
      "monster_level": 11,
      "monster_attack": 218,
      "gold_reward": 360000,
      "item_rewards": []
    },
    {
      "floor": 37,
      "monster_level": 12,
      "monster_attack": 236,
      "gold_reward": 370000,
      "item_rewards": []
    },
    {
      "floor": 38,
      "monster_level": 12,
      "monster_attack": 236,
      "gold_reward": 380000,
      "item_rewards": []
    },
    {
      "floor": 39,
      "monster_level": 12,
      "monster_attack": 236,
      "gold_reward": 390000,
      "item_rewards": []
    },
    {
      "floor": 40,
      "monster_level": 12,
      "monster_attack": 239,
      "gold_reward": 400000,
      "item_rewards": [
        {
          "item_name": "대지의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 15,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 15,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 15,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 15,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 41,
      "monster_level": 13,
      "monster_attack": 257,
      "gold_reward": 410000,
      "item_rewards": []
    },
    {
      "floor": 42,
      "monster_level": 13,
      "monster_attack": 257,
      "gold_reward": 420000,
      "item_rewards": []
    },
    {
      "floor": 43,
      "monster_level": 13,
      "monster_attack": 260,
      "gold_reward": 430000,
      "item_rewards": []
    },
    {
      "floor": 44,
      "monster_level": 14,
      "monster_attack": 278,
      "gold_reward": 440000,
      "item_rewards": []
    },
    {
      "floor": 45,
      "monster_level": 14,
      "monster_attack": 281,
      "gold_reward": 450000,
      "item_rewards": []
    },
    {
      "floor": 46,
      "monster_level": 14,
      "monster_attack": 281,
      "gold_reward": 460000,
      "item_rewards": []
    },
    {
      "floor": 47,
      "monster_level": 15,
      "monster_attack": 299,
      "gold_reward": 470000,
      "item_rewards": []
    },
    {
      "floor": 48,
      "monster_level": 15,
      "monster_attack": 299,
      "gold_reward": 480000,
      "item_rewards": []
    },
    {
      "floor": 49,
      "monster_level": 15,
      "monster_attack": 299,
      "gold_reward": 490000,
      "item_rewards": []
    },
    {
      "floor": 50,
      "monster_level": 15,
      "monster_attack": 302,
      "gold_reward": 500000,
      "item_rewards": [
        {
          "item_name": "바람의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 12,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 12,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 12,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 12,
          "gold_amount": 0
        },
        {
          "item_name": "바람의 유물 재료",
          "drop_chance": 12,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 51,
      "monster_level": 16,
      "monster_attack": 320,
      "gold_reward": 510000,
      "item_rewards": []
    },
    {
      "floor": 52,
      "monster_level": 16,
      "monster_attack": 320,
      "gold_reward": 520000,
      "item_rewards": []
    },
    {
      "floor": 53,
      "monster_level": 16,
      "monster_attack": 323,
      "gold_reward": 530000,
      "item_rewards": []
    },
    {
      "floor": 54,
      "monster_level": 17,
      "monster_attack": 341,
      "gold_reward": 540000,
      "item_rewards": []
    },
    {
      "floor": 55,
      "monster_level": 17,
      "monster_attack": 344,
      "gold_reward": 550000,
      "item_rewards": []
    },
    {
      "floor": 56,
      "monster_level": 17,
      "monster_attack": 344,
      "gold_reward": 560000,
      "item_rewards": []
    },
    {
      "floor": 57,
      "monster_level": 18,
      "monster_attack": 362,
      "gold_reward": 570000,
      "item_rewards": []
    },
    {
      "floor": 58,
      "monster_level": 18,
      "monster_attack": 362,
      "gold_reward": 580000,
      "item_rewards": []
    },
    {
      "floor": 59,
      "monster_level": 18,
      "monster_attack": 362,
      "gold_reward": 590000,
      "item_rewards": []
    },
    {
      "floor": 60,
      "monster_level": 18,
      "monster_attack": 365,
      "gold_reward": 600000,
      "item_rewards": [
        {
          "item_name": "빛의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 10,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 10,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 10,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 10,
          "gold_amount": 0
        },
        {
          "item_name": "바람의 유물 재료",
          "drop_chance": 10,
          "gold_amount": 0
        },
        {
          "item_name": "빛의 유물 재료",
          "drop_chance": 10,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 61,
      "monster_level": 19,
      "monster_attack": 383,
      "gold_reward": 610000,
      "item_rewards": []
    },
    {
      "floor": 62,
      "monster_level": 19,
      "monster_attack": 383,
      "gold_reward": 620000,
      "item_rewards": []
    },
    {
      "floor": 63,
      "monster_level": 19,
      "monster_attack": 386,
      "gold_reward": 630000,
      "item_rewards": []
    },
    {
      "floor": 64,
      "monster_level": 20,
      "monster_attack": 404,
      "gold_reward": 640000,
      "item_rewards": []
    },
    {
      "floor": 65,
      "monster_level": 20,
      "monster_attack": 407,
      "gold_reward": 650000,
      "item_rewards": []
    },
    {
      "floor": 66,
      "monster_level": 20,
      "monster_attack": 407,
      "gold_reward": 660000,
      "item_rewards": []
    },
    {
      "floor": 67,
      "monster_level": 21,
      "monster_attack": 425,
      "gold_reward": 670000,
      "item_rewards": []
    },
    {
      "floor": 68,
      "monster_level": 21,
      "monster_attack": 425,
      "gold_reward": 680000,
      "item_rewards": []
    },
    {
      "floor": 69,
      "monster_level": 21,
      "monster_attack": 425,
      "gold_reward": 690000,
      "item_rewards": []
    },
    {
      "floor": 70,
      "monster_level": 21,
      "monster_attack": 428,
      "gold_reward": 700000,
      "item_rewards": [
        {
          "item_name": "어둠의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        },
        {
          "item_name": "바람의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        },
        {
          "item_name": "빛의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        },
        {
          "item_name": "어둠의 유물 재료",
          "drop_chance": 8.571428571428571,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 71,
      "monster_level": 22,
      "monster_attack": 446,
      "gold_reward": 710000,
      "item_rewards": []
    },
    {
      "floor": 72,
      "monster_level": 22,
      "monster_attack": 446,
      "gold_reward": 720000,
      "item_rewards": []
    },
    {
      "floor": 73,
      "monster_level": 22,
      "monster_attack": 449,
      "gold_reward": 730000,
      "item_rewards": []
    },
    {
      "floor": 74,
      "monster_level": 23,
      "monster_attack": 467,
      "gold_reward": 740000,
      "item_rewards": []
    },
    {
      "floor": 75,
      "monster_level": 23,
      "monster_attack": 470,
      "gold_reward": 750000,
      "item_rewards": []
    },
    {
      "floor": 76,
      "monster_level": 23,
      "monster_attack": 470,
      "gold_reward": 760000,
      "item_rewards": []
    },
    {
      "floor": 77,
      "monster_level": 24,
      "monster_attack": 488,
      "gold_reward": 770000,
      "item_rewards": []
    },
    {
      "floor": 78,
      "monster_level": 24,
      "monster_attack": 488,
      "gold_reward": 780000,
      "item_rewards": []
    },
    {
      "floor": 79,
      "monster_level": 24,
      "monster_attack": 488,
      "gold_reward": 790000,
      "item_rewards": []
    },
    {
      "floor": 80,
      "monster_level": 24,
      "monster_attack": 491,
      "gold_reward": 800000,
      "item_rewards": [
        {
          "item_name": "시공의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "바람의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "빛의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "어둠의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        },
        {
          "item_name": "시공의 유물 재료",
          "drop_chance": 7.5,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 81,
      "monster_level": 25,
      "monster_attack": 509,
      "gold_reward": 810000,
      "item_rewards": []
    },
    {
      "floor": 82,
      "monster_level": 25,
      "monster_attack": 509,
      "gold_reward": 820000,
      "item_rewards": []
    },
    {
      "floor": 83,
      "monster_level": 25,
      "monster_attack": 512,
      "gold_reward": 830000,
      "item_rewards": []
    },
    {
      "floor": 84,
      "monster_level": 26,
      "monster_attack": 530,
      "gold_reward": 840000,
      "item_rewards": []
    },
    {
      "floor": 85,
      "monster_level": 26,
      "monster_attack": 533,
      "gold_reward": 850000,
      "item_rewards": []
    },
    {
      "floor": 86,
      "monster_level": 26,
      "monster_attack": 533,
      "gold_reward": 860000,
      "item_rewards": []
    },
    {
      "floor": 87,
      "monster_level": 27,
      "monster_attack": 551,
      "gold_reward": 870000,
      "item_rewards": []
    },
    {
      "floor": 88,
      "monster_level": 27,
      "monster_attack": 551,
      "gold_reward": 880000,
      "item_rewards": []
    },
    {
      "floor": 89,
      "monster_level": 27,
      "monster_attack": 551,
      "gold_reward": 890000,
      "item_rewards": []
    },
    {
      "floor": 90,
      "monster_level": 27,
      "monster_attack": 554,
      "gold_reward": 900000,
      "item_rewards": [
        {
          "item_name": "창조의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "바람의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "빛의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "어둠의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "시공의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        },
        {
          "item_name": "창조의 유물 재료",
          "drop_chance": 6.666666666666667,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 91,
      "monster_level": 28,
      "monster_attack": 572,
      "gold_reward": 910000,
      "item_rewards": []
    },
    {
      "floor": 92,
      "monster_level": 28,
      "monster_attack": 572,
      "gold_reward": 920000,
      "item_rewards": []
    },
    {
      "floor": 93,
      "monster_level": 28,
      "monster_attack": 575,
      "gold_reward": 930000,
      "item_rewards": []
    },
    {
      "floor": 94,
      "monster_level": 29,
      "monster_attack": 593,
      "gold_reward": 940000,
      "item_rewards": []
    },
    {
      "floor": 95,
      "monster_level": 29,
      "monster_attack": 596,
      "gold_reward": 950000,
      "item_rewards": []
    },
    {
      "floor": 96,
      "monster_level": 29,
      "monster_attack": 596,
      "gold_reward": 960000,
      "item_rewards": []
    },
    {
      "floor": 97,
      "monster_level": 30,
      "monster_attack": 614,
      "gold_reward": 970000,
      "item_rewards": []
    },
    {
      "floor": 98,
      "monster_level": 30,
      "monster_attack": 614,
      "gold_reward": 980000,
      "item_rewards": []
    },
    {
      "floor": 99,
      "monster_level": 30,
      "monster_attack": 614,
      "gold_reward": 990000,
      "item_rewards": []
    },
    {
      "floor": 100,
      "monster_level": 30,
      "monster_attack": 617,
      "gold_reward": 1000000,
      "item_rewards": [
        {
          "item_name": "파괴의 유물",
          "drop_chance": 40,
          "gold_amount": 0
        },
        {
          "item_name": "화염의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "얼음의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "번개의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "대지의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "바람의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "빛의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "어둠의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "시공의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "창조의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        },
        {
          "item_name": "파괴의 유물 재료",
          "drop_chance": 6,
          "gold_amount": 0
        }
      ]
    },
    {
      "floor": 101,
      "monster_level": 31,
      "monster_attack": 635,
      "gold_reward": 1010000,
      "item_rewards": []
    },
    {
      "floor": 102,
      "monster_level": 31,
      "monster_attack": 635,
      "gold_reward": 1020000,
      "item_rewards": []
    },
    {
      "floor": 103,
      "monster_level": 31,
      "monster_attack": 638,
      "gold_reward": 1030000,
      "item_rewards": []
    },
    {
      "floor": 104,
      "monster_level": 32,
      "monster_attack": 656,
      "gold_reward": 1040000,
      "item_rewards": []
    },
    {
      "floor": 105,
      "monster_level": 32,
      "monster_attack": 659,
      "gold_reward": 1050000,
      "item_rewards": []
    },
    {
      "floor": 106,
      "monster_level": 32,
      "monster_attack": 659,
      "gold_reward": 1060000,
      "item_rewards": []
    },
    {
      "floor": 107,
      "monster_level": 33,
      "monster_attack": 677,
      "gold_reward": 1070000,
      "item_rewards": []
    },
    {
      "floor": 108,
      "monster_level": 33,
      "monster_attack": 677,
      "gold_reward": 1080000,
      "item_rewards": []
    },
    {
      "floor": 109,
      "monster_level": 33,
      "monster_attack": 677,
      "gold_reward": 1090000,
      "item_rewards": []
    },
    {
      "floor": 110,
      "monster_level": 33,
      "monster_attack": 680,
      "gold_reward": 1100000,
      "item_rewards": []
    },
    {
      "floor": 111,
      "monster_level": 34,
      "monster_attack": 698,
      "gold_reward": 1110000,
      "item_rewards": []
    },
    {
      "floor": 112,
      "monster_level": 34,
      "monster_attack": 698,
      "gold_reward": 1120000,
      "item_rewards": []
    },
    {
      "floor": 113,
      "monster_level": 34,
      "monster_attack": 701,
      "gold_reward": 1130000,
      "item_rewards": []
    },
    {
      "floor": 114,
      "monster_level": 35,
      "monster_attack": 719,
      "gold_reward": 1140000,
      "item_rewards": []
    },
    {
      "floor": 115,
      "monster_level": 35,
      "monster_attack": 722,
      "gold_reward": 1150000,
      "item_rewards": []
    },
    {
      "floor": 116,
      "monster_level": 35,
      "monster_attack": 722,
      "gold_reward": 1160000,
      "item_rewards": []
    },
    {
      "floor": 117,
      "monster_level": 36,
      "monster_attack": 740,
      "gold_reward": 1170000,
      "item_rewards": []
    },
    {
      "floor": 118,
      "monster_level": 36,
      "monster_attack": 740,
      "gold_reward": 1180000,
      "item_rewards": []
    },
    {
      "floor": 119,
      "monster_level": 36,
      "monster_attack": 740,
      "gold_reward": 1190000,
      "item_rewards": []
    },
    {
      "floor": 120,
      "monster_level": 36,
      "monster_attack": 743,
      "gold_reward": 1200000,
      "item_rewards": []
    },
    {
      "floor": 121,
      "monster_level": 37,
      "monster_attack": 761,
      "gold_reward": 1210000,
      "item_rewards": []
    },
    {
      "floor": 122,
      "monster_level": 37,
      "monster_attack": 761,
      "gold_reward": 1220000,
      "item_rewards": []
    },
    {
      "floor": 123,
      "monster_level": 37,
      "monster_attack": 764,
      "gold_reward": 1230000,
      "item_rewards": []
    },
    {
      "floor": 124,
      "monster_level": 38,
      "monster_attack": 782,
      "gold_reward": 1240000,
      "item_rewards": []
    },
    {
      "floor": 125,
      "monster_level": 38,
      "monster_attack": 785,
      "gold_reward": 1250000,
      "item_rewards": []
    },
    {
      "floor": 126,
      "monster_level": 38,
      "monster_attack": 785,
      "gold_reward": 1260000,
      "item_rewards": []
    },
    {
      "floor": 127,
      "monster_level": 39,
      "monster_attack": 803,
      "gold_reward": 1270000,
      "item_rewards": []
    },
    {
      "floor": 128,
      "monster_level": 39,
      "monster_attack": 803,
      "gold_reward": 1280000,
      "item_rewards": []
    },
    {
      "floor": 129,
      "monster_level": 39,
      "monster_attack": 803,
      "gold_reward": 1290000,
      "item_rewards": []
    },
    {
      "floor": 130,
      "monster_level": 39,
      "monster_attack": 806,
      "gold_reward": 1300000,
      "item_rewards": []
    },
    {
      "floor": 131,
      "monster_level": 40,
      "monster_attack": 824,
      "gold_reward": 1310000,
      "item_rewards": []
    },
    {
      "floor": 132,
      "monster_level": 40,
      "monster_attack": 824,
      "gold_reward": 1320000,
      "item_rewards": []
    },
    {
      "floor": 133,
      "monster_level": 40,
      "monster_attack": 827,
      "gold_reward": 1330000,
      "item_rewards": []
    },
    {
      "floor": 134,
      "monster_level": 41,
      "monster_attack": 845,
      "gold_reward": 1340000,
      "item_rewards": []
    },
    {
      "floor": 135,
      "monster_level": 41,
      "monster_attack": 848,
      "gold_reward": 1350000,
      "item_rewards": []
    },
    {
      "floor": 136,
      "monster_level": 41,
      "monster_attack": 848,
      "gold_reward": 1360000,
      "item_rewards": []
    },
    {
      "floor": 137,
      "monster_level": 42,
      "monster_attack": 866,
      "gold_reward": 1370000,
      "item_rewards": []
    },
    {
      "floor": 138,
      "monster_level": 42,
      "monster_attack": 866,
      "gold_reward": 1380000,
      "item_rewards": []
    },
    {
      "floor": 139,
      "monster_level": 42,
      "monster_attack": 866,
      "gold_reward": 1390000,
      "item_rewards": []
    },
    {
      "floor": 140,
      "monster_level": 42,
      "monster_attack": 869,
      "gold_reward": 1400000,
      "item_rewards": []
    },
    {
      "floor": 141,
      "monster_level": 43,
      "monster_attack": 887,
      "gold_reward": 1410000,
      "item_rewards": []
    },
    {
      "floor": 142,
      "monster_level": 43,
      "monster_attack": 887,
      "gold_reward": 1420000,
      "item_rewards": []
    },
    {
      "floor": 143,
      "monster_level": 43,
      "monster_attack": 890,
      "gold_reward": 1430000,
      "item_rewards": []
    },
    {
      "floor": 144,
      "monster_level": 44,
      "monster_attack": 908,
      "gold_reward": 1440000,
      "item_rewards": []
    },
    {
      "floor": 145,
      "monster_level": 44,
      "monster_attack": 911,
      "gold_reward": 1450000,
      "item_rewards": []
    },
    {
      "floor": 146,
      "monster_level": 44,
      "monster_attack": 911,
      "gold_reward": 1460000,
      "item_rewards": []
    },
    {
      "floor": 147,
      "monster_level": 45,
      "monster_attack": 929,
      "gold_reward": 1470000,
      "item_rewards": []
    },
    {
      "floor": 148,
      "monster_level": 45,
      "monster_attack": 929,
      "gold_reward": 1480000,
      "item_rewards": []
    },
    {
      "floor": 149,
      "monster_level": 45,
      "monster_attack": 929,
      "gold_reward": 1490000,
      "item_rewards": []
    },
    {
      "floor": 150,
      "monster_level": 45,
      "monster_attack": 932,
      "gold_reward": 1500000,
      "item_rewards": []
    },
    {
      "floor": 151,
      "monster_level": 46,
      "monster_attack": 950,
      "gold_reward": 1510000,
      "item_rewards": []
    },
    {
      "floor": 152,
      "monster_level": 46,
      "monster_attack": 950,
      "gold_reward": 1520000,
      "item_rewards": []
    },
    {
      "floor": 153,
      "monster_level": 46,
      "monster_attack": 953,
      "gold_reward": 1530000,
      "item_rewards": []
    },
    {
      "floor": 154,
      "monster_level": 47,
      "monster_attack": 971,
      "gold_reward": 1540000,
      "item_rewards": []
    },
    {
      "floor": 155,
      "monster_level": 47,
      "monster_attack": 974,
      "gold_reward": 1550000,
      "item_rewards": []
    },
    {
      "floor": 156,
      "monster_level": 47,
      "monster_attack": 974,
      "gold_reward": 1560000,
      "item_rewards": []
    },
    {
      "floor": 157,
      "monster_level": 48,
      "monster_attack": 992,
      "gold_reward": 1570000,
      "item_rewards": []
    },
    {
      "floor": 158,
      "monster_level": 48,
      "monster_attack": 992,
      "gold_reward": 1580000,
      "item_rewards": []
    },
    {
      "floor": 159,
      "monster_level": 48,
      "monster_attack": 992,
      "gold_reward": 1590000,
      "item_rewards": []
    },
    {
      "floor": 160,
      "monster_level": 48,
      "monster_attack": 995,
      "gold_reward": 1600000,
      "item_rewards": []
    },
    {
      "floor": 161,
      "monster_level": 49,
      "monster_attack": 1013,
      "gold_reward": 1610000,
      "item_rewards": []
    },
    {
      "floor": 162,
      "monster_level": 49,
      "monster_attack": 1013,
      "gold_reward": 1620000,
      "item_rewards": []
    },
    {
      "floor": 163,
      "monster_level": 49,
      "monster_attack": 1016,
      "gold_reward": 1630000,
      "item_rewards": []
    },
    {
      "floor": 164,
      "monster_level": 50,
      "monster_attack": 1034,
      "gold_reward": 1640000,
      "item_rewards": []
    },
    {
      "floor": 165,
      "monster_level": 50,
      "monster_attack": 1037,
      "gold_reward": 1650000,
      "item_rewards": []
    },
    {
      "floor": 166,
      "monster_level": 50,
      "monster_attack": 1037,
      "gold_reward": 1660000,
      "item_rewards": []
    },
    {
      "floor": 167,
      "monster_level": 51,
      "monster_attack": 1055,
      "gold_reward": 1670000,
      "item_rewards": []
    },
    {
      "floor": 168,
      "monster_level": 51,
      "monster_attack": 1055,
      "gold_reward": 1680000,
      "item_rewards": []
    },
    {
      "floor": 169,
      "monster_level": 51,
      "monster_attack": 1055,
      "gold_reward": 1690000,
      "item_rewards": []
    },
    {
      "floor": 170,
      "monster_level": 51,
      "monster_attack": 1058,
      "gold_reward": 1700000,
      "item_rewards": []
    },
    {
      "floor": 171,
      "monster_level": 52,
      "monster_attack": 1076,
      "gold_reward": 1710000,
      "item_rewards": []
    },
    {
      "floor": 172,
      "monster_level": 52,
      "monster_attack": 1076,
      "gold_reward": 1720000,
      "item_rewards": []
    },
    {
      "floor": 173,
      "monster_level": 52,
      "monster_attack": 1079,
      "gold_reward": 1730000,
      "item_rewards": []
    },
    {
      "floor": 174,
      "monster_level": 53,
      "monster_attack": 1097,
      "gold_reward": 1740000,
      "item_rewards": []
    },
    {
      "floor": 175,
      "monster_level": 53,
      "monster_attack": 1100,
      "gold_reward": 1750000,
      "item_rewards": []
    },
    {
      "floor": 176,
      "monster_level": 53,
      "monster_attack": 1100,
      "gold_reward": 1760000,
      "item_rewards": []
    },
    {
      "floor": 177,
      "monster_level": 54,
      "monster_attack": 1118,
      "gold_reward": 1770000,
      "item_rewards": []
    },
    {
      "floor": 178,
      "monster_level": 54,
      "monster_attack": 1118,
      "gold_reward": 1780000,
      "item_rewards": []
    },
    {
      "floor": 179,
      "monster_level": 54,
      "monster_attack": 1118,
      "gold_reward": 1790000,
      "item_rewards": []
    },
    {
      "floor": 180,
      "monster_level": 54,
      "monster_attack": 1121,
      "gold_reward": 1800000,
      "item_rewards": []
    },
    {
      "floor": 181,
      "monster_level": 55,
      "monster_attack": 1139,
      "gold_reward": 1810000,
      "item_rewards": []
    },
    {
      "floor": 182,
      "monster_level": 55,
      "monster_attack": 1139,
      "gold_reward": 1820000,
      "item_rewards": []
    },
    {
      "floor": 183,
      "monster_level": 55,
      "monster_attack": 1142,
      "gold_reward": 1830000,
      "item_rewards": []
    },
    {
      "floor": 184,
      "monster_level": 56,
      "monster_attack": 1160,
      "gold_reward": 1840000,
      "item_rewards": []
    },
    {
      "floor": 185,
      "monster_level": 56,
      "monster_attack": 1163,
      "gold_reward": 1850000,
      "item_rewards": []
    },
    {
      "floor": 186,
      "monster_level": 56,
      "monster_attack": 1163,
      "gold_reward": 1860000,
      "item_rewards": []
    },
    {
      "floor": 187,
      "monster_level": 57,
      "monster_attack": 1181,
      "gold_reward": 1870000,
      "item_rewards": []
    },
    {
      "floor": 188,
      "monster_level": 57,
      "monster_attack": 1181,
      "gold_reward": 1880000,
      "item_rewards": []
    },
    {
      "floor": 189,
      "monster_level": 57,
      "monster_attack": 1181,
      "gold_reward": 1890000,
      "item_rewards": []
    },
    {
      "floor": 190,
      "monster_level": 57,
      "monster_attack": 1184,
      "gold_reward": 1900000,
      "item_rewards": []
    },
    {
      "floor": 191,
      "monster_level": 58,
      "monster_attack": 1202,
      "gold_reward": 1910000,
      "item_rewards": []
    },
    {
      "floor": 192,
      "monster_level": 58,
      "monster_attack": 1202,
      "gold_reward": 1920000,
      "item_rewards": []
    },
    {
      "floor": 193,
      "monster_level": 58,
      "monster_attack": 1205,
      "gold_reward": 1930000,
      "item_rewards": []
    },
    {
      "floor": 194,
      "monster_level": 59,
      "monster_attack": 1223,
      "gold_reward": 1940000,
      "item_rewards": []
    },
    {
      "floor": 195,
      "monster_level": 59,
      "monster_attack": 1226,
      "gold_reward": 1950000,
      "item_rewards": []
    },
    {
      "floor": 196,
      "monster_level": 59,
      "monster_attack": 1226,
      "gold_reward": 1960000,
      "item_rewards": []
    },
    {
      "floor": 197,
      "monster_level": 60,
      "monster_attack": 1244,
      "gold_reward": 1970000,
      "item_rewards": []
    },
    {
      "floor": 198,
      "monster_level": 60,
      "monster_attack": 1244,
      "gold_reward": 1980000,
      "item_rewards": []
    },
    {
      "floor": 199,
      "monster_level": 60,
      "monster_attack": 1244,
      "gold_reward": 1990000,
      "item_rewards": []
    },
    {
      "floor": 200,
      "monster_level": 60,
      "monster_attack": 1247,
      "gold_reward": 2000000,
      "item_rewards": []
    }
  ],
  "relic_types": [
    {
      "name": "항아리",
      "attack_per_level": 0.1,
      "exp_per_level": 30
    },
    {
      "name": "망토",
      "attack_per_level": 0.2,
      "exp_per_level": 30
    },
    {
      "name": "목걸이",
      "attack_per_level": 0.15,
      "exp_per_level": 30
    },
    {
      "name": "반지",
      "attack_per_level": 0.12,
      "exp_per_level": 30
    },
    {
      "name": "부적",
      "attack_per_level": 0.18,
      "exp_per_level": 30
    },
    {
      "name": "구슬",
      "attack_per_level": 0.25,
      "exp_per_level": 30
    },
    {
      "name": "왕관",
      "attack_per_level": 0.3,
      "exp_per_level": 30
    },
    {
      "name": "방패",
      "attack_per_level": 0.08,
      "exp_per_level": 30
    },
    {
      "name": "장갑",
      "attack_per_level": 0.13,
      "exp_per_level": 30
    },
    {
      "name": "신발",
      "attack_per_level": 0.11,
      "exp_per_level": 30
    }
  ],
  "mystery_box_items": [
    {
      "name": "⚔️강화제(성공률 10%상승)",
      "chance": 15,
      "amount": 0
    },
    {
      "name": "⚔️강화제(성공률 40%상승)",
      "chance": 15,
      "amount": 0
    },
    {
      "name": "🛡️파괴방지(1회성)",
      "chance": 15,
      "amount": 0
    },
    {
      "name": "🔄옵션 재설정",
      "chance": 10,
      "amount": 0
    },
    {
      "name": "✨옵션 부여 부적",
      "chance": 10,
      "amount": 0
    },
    {
      "name": "🔐옵션 잠금 부적(1회성)",
      "chance": 19,
      "amount": 0
    },
    {
      "name": "단비가 버린검",
      "chance": 0.5,
      "amount": 0
    },
    {
      "name": "골드",
      "chance": 15.5,
      "amount": 0
    }
  ],
  "gift_command_authorized_tags": [],
  "id": "695cd1baeb15f142bc4a37a1",
  "created_date": "2026-01-06T09:11:22.224000",
  "updated_date": "2026-01-14T05:11:19.696000",
  "created_by_id": "695cb0ce8ab739b809a708e2",
  "created_by": "102810aa@gmail.com",
  "is_sample": false
};
  if (savedSettings) {
    localSettings = {
      enabled: savedSettings.enabled ?? true,
      initial_gold: savedSettings.initial_gold ?? 100000,
      daily_money: savedSettings.daily_money ?? 10000,
      like_reward: savedSettings.like_reward ?? 5000,
      spoon_to_gold_rate: savedSettings.spoon_to_gold_rate ?? 1,
      enhance_cooldown: savedSettings.enhance_cooldown ?? 3,
      battle_cooldown: savedSettings.battle_cooldown ?? 20,
      dungeon_cooldown: savedSettings.dungeon_cooldown ?? 2,
      enhance_success_rates: savedSettings.enhance_success_rates || [],
      weapon_names: savedSettings.weapon_names || [],
      sell_price_multiplier: savedSettings.sell_price_multiplier ?? 10,
      shop_items: savedSettings.shop_items || [],
      battle_reward_base: savedSettings.battle_reward_base ?? 7000,
      dungeon_floors: savedSettings.dungeon_floors || [],
      relic_types: savedSettings.relic_types || [],
      level_first_achievers: savedSettings.level_first_achievers || {},
      mystery_box_items: savedSettings.mystery_box_items || [],
      monster_box_items: savedSettings.monster_box_items || []
    };

    // 유물 타입이 비어있으면 기본값 먼저 설정
    if (localSettings.relic_types.length === 0) {
      localSettings.relic_types = defaultRelicTypes();
    }

    // 설정이 비어있는 경우 기본값으로 채움
    if (localSettings.enhance_success_rates.length === 0) {
      localSettings.enhance_success_rates = defaultEnhanceRates();
    }
    if (localSettings.weapon_names.length === 0) {
      localSettings.weapon_names = defaultWeaponNames();
    }
    if (localSettings.shop_items.length === 0) {
      localSettings.shop_items = defaultShopItems();
    } else {
      // shop_items가 있어도 필수 아이템이 없으면 자동 추가
      const hasDownPrevent = localSettings.shop_items.some(item => item.effect_type === 'down_prevent');
      if (!hasDownPrevent) {
        localSettings.shop_items.push({name: "하락방지(1회성)", price: 200, effect_type: "down_prevent", effect_value: 1});
      }
      const hasAutoBattle = localSettings.shop_items.some(item => item.effect_type === 'auto_battle_ticket');
      if (!hasAutoBattle) {
        localSettings.shop_items.push({name: "자동쿠폰", price: 300, price_type: "gold", effect_type: "auto_battle_ticket", effect_value: 10});
      }
      
      // 몬스터 상자가 없으면 자동 추가
      const hasMonsterBox = localSettings.shop_items.some(item => item.effect_type === 'monster_box');
      if (!hasMonsterBox) {
        localSettings.shop_items.push({name: "몬스터 상자", price: 50, price_type: "spoon_points", effect_type: "monster_box", effect_value: 0});
      }
      
      // 펫 상자가 없으면 자동 추가
      const hasPetBox = localSettings.shop_items.some(item => item.effect_type === 'pet_box');
      if (!hasPetBox) {
        localSettings.shop_items.push({name: "펫 상자", price: 100, price_type: "spoon_points", effect_type: "pet_box", effect_value: 0});
      }
    }
    if (localSettings.dungeon_floors.length === 0) {
      localSettings.dungeon_floors = defaultDungeonFloors(localSettings.relic_types);
    }
    if (localSettings.mystery_box_items.length === 0) {
      localSettings.mystery_box_items = defaultMysteryBoxItems();
    }
    if (localSettings.monster_box_items.length === 0) {
      localSettings.monster_box_items = defaultMonsterBoxItems();
    }

    return localSettings;
  }

  // DB 설정이 없으면 기본값 사용
  const defaultRates = defaultEnhanceRates();
  const defaultWeaponNames = defaultWeaponNames();
  const defaultShopItems = defaultShopItems();
  const defaultRelicTypes = defaultRelicTypes();
  const defaultDungeonFloors = defaultDungeonFloors(defaultRelicTypes);

  localSettings = {
    "enabled": true,
    "initial_gold": 100000,
    "daily_money": 10000,
    "like_reward": 5000,
    "spoon_to_gold_rate": 1,
    "enhance_cooldown": 3,
    "battle_cooldown": 20,
    "dungeon_cooldown": 2,
    "enhance_success_rates": defaultRates,
    "weapon_names": defaultWeaponNames,
    "sell_price_multiplier": 10,
    "shop_items": defaultShopItems,
    "battle_reward_base": 10,
    "dungeon_floors": defaultDungeonFloors,
    "relic_types": defaultRelicTypes,
    "level_first_achievers": {},
    "mystery_box_items": defaultMysteryBoxItems(),
    "monster_box_items": defaultMonsterBoxItems()
  };
  
  return localSettings;
}

function defaultEnhanceRates() {
  const defaultRates = [
    {level: 0, cost: 10, success_rate: 100, fail_rate: 0, down_rate: 0, destroy_rate: 0},
    {level: 1, cost: 20, success_rate: 95, fail_rate: 5, down_rate: 0, destroy_rate: 0},
    {level: 2, cost: 50, success_rate: 90, fail_rate: 10, down_rate: 0, destroy_rate: 0},
    {level: 3, cost: 100, success_rate: 85, fail_rate: 15, down_rate: 0, destroy_rate: 0},
    {level: 4, cost: 200, success_rate: 80, fail_rate: 20, down_rate: 0, destroy_rate: 0},
    {level: 5, cost: 500, success_rate: 75, fail_rate: 20, down_rate: 5, destroy_rate: 0},
    {level: 6, cost: 1000, success_rate: 70, fail_rate: 20, down_rate: 10, destroy_rate: 0},
    {level: 7, cost: 2000, success_rate: 65, fail_rate: 20, down_rate: 15, destroy_rate: 0},
    {level: 8, cost: 5000, success_rate: 60, fail_rate: 20, down_rate: 15, destroy_rate: 5},
    {level: 9, cost: 10000, success_rate: 55, fail_rate: 20, down_rate: 15, destroy_rate: 10},
    {level: 10, cost: 20000, success_rate: 50, fail_rate: 20, down_rate: 15, destroy_rate: 15},
    {level: 11, cost: 40000, success_rate: 48, fail_rate: 20, down_rate: 17, destroy_rate: 15},
    {level: 12, cost: 80000, success_rate: 46, fail_rate: 20, down_rate: 19, destroy_rate: 15},
    {level: 13, cost: 160000, success_rate: 44, fail_rate: 20, down_rate: 20, destroy_rate: 16},
    {level: 14, cost: 320000, success_rate: 42, fail_rate: 20, down_rate: 20, destroy_rate: 18},
    {level: 15, cost: 640000, success_rate: 40, fail_rate: 20, down_rate: 20, destroy_rate: 20},
    {level: 16, cost: 1280000, success_rate: 38, fail_rate: 20, down_rate: 21, destroy_rate: 21},
    {level: 17, cost: 2560000, success_rate: 36, fail_rate: 20, down_rate: 22, destroy_rate: 22},
    {level: 18, cost: 5000000, success_rate: 34, fail_rate: 20, down_rate: 23, destroy_rate: 23},
    {level: 19, cost: 10000000, success_rate: 32, fail_rate: 20, down_rate: 24, destroy_rate: 24},
    {level: 20, cost: 20000000, success_rate: 30, fail_rate: 20, down_rate: 25, destroy_rate: 25},
    {level: 21, cost: 40000000, success_rate: 28, fail_rate: 20, down_rate: 26, destroy_rate: 26},
    {level: 22, cost: 80000000, success_rate: 26, fail_rate: 20, down_rate: 27, destroy_rate: 27},
    {level: 23, cost: 160000000, success_rate: 24, fail_rate: 20, down_rate: 28, destroy_rate: 28},
    {level: 24, cost: 320000000, success_rate: 22, fail_rate: 20, down_rate: 29, destroy_rate: 29},
    {level: 25, cost: 640000000, success_rate: 20, fail_rate: 20, down_rate: 30, destroy_rate: 30},
    {level: 26, cost: 1280000000, success_rate: 18, fail_rate: 20, down_rate: 31, destroy_rate: 31},
    {level: 27, cost: 2560000000, success_rate: 16, fail_rate: 20, down_rate: 32, destroy_rate: 32},
    {level: 28, cost: 5000000000, success_rate: 14, fail_rate: 20, down_rate: 33, destroy_rate: 33},
    {level: 29, cost: 10000000000, success_rate: 12, fail_rate: 20, down_rate: 34, destroy_rate: 34}
  ];

  // 30~60 레벨 추가 (특수 무기용)
  for (let i = 30; i <= 60; i++) {
    defaultRates.push({
      "level": i,
      "cost": 10000000000 * Math.pow(2, i - 29),
      "success_rate": Math.max(5, 12 - (i - 29)),
      "fail_rate": 20,
      "down_rate": Math.min(40, 34 + (i - 29)),
      "destroy_rate": Math.min(40, 34 + (i - 29))
    });
  }

  return defaultRates;
}

function defaultWeaponNames() {
  const defaultWeaponNames = [
    {"level": 0, "name": "낡은 검"},
    {"level": 1, "name": "무쇠 검"},
    {"level": 2, "name": "강철 검"},
    {"level": 3, "name": "은 검"},
    {"level": 4, "name": "미스릴 검"},
    {"level": 5, "name": "마법 검"},
    {"level": 6, "name": "전설 검"},
    {"level": 7, "name": "신화 검"},
    {"level": 8, "name": "초월 검"},
    {"level": 9, "name": "불멸 검"},
    {"level": 10, "name": "신검"},
    {"level": 11, "name": "천상의 검"},
    {"level": 12, "name": "성스러운 검"},
    {"level": 13, "name": "영원의 검"},
    {"level": 14, "name": "용의 검"},
    {"level": 15, "name": "봉황의 검"},
    {"level": 16, "name": "태양의 검"},
    {"level": 17, "name": "달의 검"},
    {"level": 18, "name": "별의 검"},
    {"level": 19, "name": "은하의 검"},
    {"level": 20, "name": "우주의 검"},
    {"level": 21, "name": "시공의 검"},
    {"level": 22, "name": "차원의 검"},
    {"level": 23, "name": "운명의 검"},
    {"level": 24, "name": "창조의 검"},
    {"level": 25, "name": "파괴의 검"},
    {"level": 26, "name": "절대의 검"},
    {"level": 27, "name": "무한의 검"},
    {"level": 28, "name": "궁극의 검"},
    {"level": 29, "name": "진리의 검"}
  ];
  
  return defaultWeaponNames;
}

function defaultRelicTypes() {
  const defaultRelicTypes = [
    {name: "항아리", attack_per_level: 0.1, exp_per_level: 30},
    {name: "망토", attack_per_level: 0.2, exp_per_level: 30},
    {name: "목걸이", attack_per_level: 0.15, exp_per_level: 30},
    {name: "반지", attack_per_level: 0.12, exp_per_level: 30},
    {name: "부적", attack_per_level: 0.18, exp_per_level: 30},
    {name: "구슬", attack_per_level: 0.25, exp_per_level: 30},
    {name: "왕관", attack_per_level: 0.3, exp_per_level: 30},
    {name: "방패", attack_per_level: 0.08, exp_per_level: 30},
    {name: "장갑", attack_per_level: 0.13, exp_per_level: 30},
    {name: "신발", attack_per_level: 0.11, exp_per_level: 30},
    {name: "화염", attack_per_level: 0.35, exp_per_level: 30},
    {name: "번개", attack_per_level: 0.4, exp_per_level: 30},
    {name: "빛", attack_per_level: 0.45, exp_per_level: 30},
    {name: "바람", attack_per_level: 0.5, exp_per_level: 30},
    {name: "얼음", attack_per_level: 0.55, exp_per_level: 30},
    {name: "대지", attack_per_level: 0.6, exp_per_level: 30},
    {name: "도플갱어", attack_per_level: 0.5, exp_per_level: 30}
  ];

  return defaultRelicTypes;
}

function defaultShopItems() {
  return [
    {name: "강화제(성공률 10%상승)", price: 100, price_type: "gold", effect_type: "enhance_boost", effect_value: 10},
    {name: "파괴방지(1회성)", price: 200, price_type: "gold", effect_type: "destroy_prevent", effect_value: 1},
    {name: "하락방지(1회성)", price: 200, price_type: "gold", effect_type: "down_prevent", effect_value: 1},
    {name: "골드 30분동안 추가획득20%", price: 150, price_type: "gold", effect_type: "gold_boost", effect_value: 20},
    {name: "옵션 재설정", price: 500, price_type: "gold", effect_type: "reroll_option", effect_value: 0},
    {name: "옵션 부여 부적", price: 300, price_type: "gold", effect_type: "add_option", effect_value: 0},
    {name: "옵션 잠금 부적(1회성)", price: 700, price_type: "gold", effect_type: "option_lock", effect_value: 1},
    {name: "미스터리 선물 상자", price: 100, price_type: "gold", effect_type: "mystery_box", effect_value: 0},
    {name: "던전 이용권", price: 50, price_type: "gold", effect_type: "dungeon_ticket", effect_value: 1},
    {name: "던전 리셋권", price: 1000, price_type: "gold", effect_type: "dungeon_reset", effect_value: 0},
    {name: "자동쿠폰", price: 300, price_type: "gold", effect_type: "auto_battle_ticket", effect_value: 10},
    {name: "몬스터 상자", price: 50, price_type: "spoon_points", effect_type: "monster_box", effect_value: 0},
    {name: "펫 상자", price: 100, price_type: "spoon_points", effect_type: "pet_box", effect_value: 0}
  ];
}

function defaultMysteryBoxItems() {
  return [
    {"name": "골드", "chance": 50, "amount": 2000},
    {"name": "강화제(성공률 10%상승)", "chance": 25, "amount": 1},
    {"name": "파괴방지(1회성)", "chance": 15, "amount": 1},
    {"name": "옵션 재설정", "chance": 8, "amount": 1},
    {"name": "단비가 버린검 +1", "chance": 2, "amount": 1}
  ];
}

function defaultMonsterBoxItems() {
  return [
    {name: "골드", chance: 20, amount: 5000},
    {name: "던전 이용권", chance: 10, amount: 1},
    {name: "강화제(성공률 10%상승)", chance: 5, amount: 1},
    {name: "자동쿠폰", chance: 3, amount: 1},
    {name: "공격펫(+5~10)", chance: 8, amount: 0},
    {name: "공격펫(+11~20)", chance: 7, amount: 0},
    {name: "공격펫(+21~30)", chance: 6, amount: 0},
    {name: "공격펫(+31~40)", chance: 5, amount: 0},
    {name: "공격펫(+41~50)", chance: 4, amount: 0},
    {name: "공격펫(+51~60)", chance: 3, amount: 0},
    {name: "공격펫(+61~70)", chance: 2.5, amount: 0},
    {name: "공격펫(+71~80)", chance: 2, amount: 0},
    {name: "공격펫(+81~100)", chance: 1.5, amount: 0},
    {name: "공격펫(+101~150)", chance: 1, amount: 0},
    {name: "골드펫(+200~500%)", chance: 8, amount: 0},
    {name: "골드펫(+501~1000%)", chance: 6, amount: 0},
    {name: "골드펫(+1001~1500%)", chance: 4, amount: 0},
    {name: "골드펫(+1501~2000%)", chance: 3, amount: 0},
    {name: "골드펫(+2001~3000%)", chance: 2, amount: 0},
    {name: "골드펫(+3001~4000%)", chance: 1.5, amount: 0},
    {name: "골드펫(+4001~5000%)", chance: 1.2, amount: 0},
    {name: "골드펫(+5001~7000%)", chance: 0.8, amount: 0},
    {name: "골드펫(+7001~10000%)", chance: 0.5, amount: 0},
    {name: "골드펫(+10001~20000%)", chance: 0.3, amount: 0}
  ];
}

function defaultDungeonFloors(relicTypes) {
  const floors = [];
  const allRelicTypes = relicTypes && relicTypes.length > 0 ? relicTypes : defaultRelicTypes();
  
  // 기본 유물 10개 (항아리~신발, 인덱스 0~9)
  const basicRelics = allRelicTypes.slice(0, 10);
  // 고급 유물 6개 (화염~대지, 인덱스 10~15)
  const advancedRelics = allRelicTypes.slice(10, 16);
  
  for (let i = 1; i <= 200; i++) {
    const monsterLevel = Math.ceil(i * 0.3);
    const baseAttack = monsterLevel * 7 + Math.floor(i / 5);
    const monsterAttack = Math.floor(baseAttack * 2.548);
    const goldReward = i * 1000;
    
    const item_rewards = [];
    
    // 10층 단위 유물 드랍
    if (i % 10 === 0) {
      if (i <= 100) {
        // 100층 이하: 기본 유물만 (항아리~신발)
        const relicIndex = (i / 10) - 1; // 10층=0, 20층=1, ..., 100층=9
        
        if (relicIndex >= 0 && relicIndex < basicRelics.length) {
          const relic = basicRelics[relicIndex];
          
          // 해당 등급 유물 10% 확률로 드랍
          item_rewards.push({
            item_name: relic.name,
            drop_chance: 10,
            gold_amount: 0
          });

          // 나머지 90%는 이전까지의 모든 기본 유물 재료를 균등 분배
          const materialCount = relicIndex + 1;
          const materialChance = 90 / materialCount;

          for (let j = 0; j <= relicIndex; j++) {
            item_rewards.push({
              item_name: basicRelics[j].name + ' 재료',
              drop_chance: materialChance,
              gold_amount: 0
            });
          }
        }
      } else if (i >= 110) {
        // 110층 이상: 고급 유물만 (화염~대지)
        const relicIndex = ((i - 110) / 10); // 110층=0, 120층=1, ..., 160층=5
        
        if (relicIndex >= 0 && relicIndex < advancedRelics.length) {
          const relic = advancedRelics[relicIndex];
          
          // 해당 등급 유물 10% 확률로 드랍
          item_rewards.push({
            item_name: relic.name,
            drop_chance: 10,
            gold_amount: 0
          });

          // 나머지 90%는 이전까지의 모든 고급 유물 재료를 균등 분배
          const materialCount = relicIndex + 1;
          const materialChance = 90 / materialCount;

          for (let j = 0; j <= relicIndex; j++) {
            item_rewards.push({
              item_name: advancedRelics[j].name + ' 재료',
              drop_chance: materialChance,
              gold_amount: 0
            });
          }
        }
      }
    }

    floors.push({
      floor: i,
      monster_level: monsterLevel,
      monster_attack: monsterAttack,
      gold_reward: goldReward,
      item_rewards: item_rewards
    });
  }
  
  return floors;
}

function calculateRelicAttack(user) {
  const relics = user.relics || {};
  const relicTypes = localSettings.relic_types || [];
  let totalRelicAttack = 0;

  for (const relicName in relics) {
    const relicData = relics[relicName];
    const relicType = relicTypes.find(r => r.name === relicName);

    if (relicType && relicData.level) {
      totalRelicAttack += relicData.level * relicType.attack_per_level;
    }
  }

  return totalRelicAttack;
}

function calculateRuneAttack(user) {
  const runes = user.runes || {};
  let totalRuneAttack = 0;

  for (const runeName in runes) {
    const runeData = runes[runeName];
    if (runeData && runeData.attack) {
      totalRuneAttack += runeData.attack;
    }
  }

  return totalRuneAttack;
}

function calculatePetAttackBonus(user) {
  if (!user.equipped_pet_id || !user.pets) return 0;
  
  const equippedPet = user.pets.find(p => p.id === user.equipped_pet_id);
  if (equippedPet && equippedPet.type === 'attack') {
    return equippedPet.attack_bonus || 0;
  }
  
  return 0;
}

function calculatePetGoldBonus(user) {
  if (!user.equipped_pet_id || !user.pets) return 0;
  
  const equippedPet = user.pets.find(p => p.id === user.equipped_pet_id);
  if (equippedPet && equippedPet.type === 'gold') {
    return (equippedPet.gold_bonus_percent || 0) / 100;
  }
  
  return 0;
}

function getOrCreateUser(tag, nickname) {
  let user = localUsers.get(tag);

  if (!user) {
    user = {
      "tag": tag,
      "nickname": nickname,
      "gold": localSettings?.initial_gold || 100000,
      "spoon_points": 0,
      "sword_level": 0,
      "max_sword_level": 0,
      "attack_power": 0,
      "weapon_bonus": 0,
      "weapon_bonus2": 0,
      "weapon_bonus3": 0,
      "battle_wins": 0,
      "battle_losses": 0,
      "inventory": {},
      "special_weapon": null,
      "last_daily_money_date": null,
      "current_dungeon_floor": 1,
      "relics": {},
      "dungeon_tickets": 0,
      "auto_battle_tickets": 0,
      "heart_clicks_after_plus_28": 0,
      "runes": {},
      "rune_fragments": 0,
      "last_explore_date": null,
      "explore_count": 0,
      "user_plan_level": 0,
      "pets": [],
      "equipped_pet_id": null,
      "pet_fragments": 0
      };
      localUsers.set(tag, user);
  } else {
    if (user.nickname !== nickname) {
      user.nickname = nickname;
    }
    
    if (!user.current_dungeon_floor) {
      user.current_dungeon_floor = 1;
    }
    
    if (!user.relics) {
      user.relics = {};
    }
    
    if (user.dungeon_tickets === undefined) {
      user.dungeon_tickets = 0;
    }
    
    if (user.auto_battle_tickets === undefined) {
      user.auto_battle_tickets = 0;
    }

    if (user.heart_clicks_after_plus_28 === undefined) {
      user.heart_clicks_after_plus_28 = 0;
    }
    
    // 룬이 2개 이상이면 1개로 통합 (기본 공격력으로 초기화)
    if (user.runes && Object.keys(user.runes).length > 1) {
      const runeKeys = Object.keys(user.runes);
      const firstRuneName = runeKeys[0];
      
      // 룬 1개로 통합, 레벨 1, 기본 공격력(12)로 초기화
      user.runes = {
        [firstRuneName]: {
          level: 1,
          attack: 12
        }
      };
    }
  }

  return user;
}

function handleEnhance(tag, nickname) {
  if (!localSettings || localSettings.enabled === false) {
    return '❌ 검키우기 시스템이 비활성화되어 있습니다';
  }

  const user = getOrCreateUser(tag, nickname);

  const enhanceCooldown = (localSettings.enhance_cooldown || 3) * 1000;
  const lastEnhanceTime = enhanceCooldowns.get(tag) || 0;
  const elapsed = Date.now() - lastEnhanceTime;

  if (elapsed < enhanceCooldown) {
    const remainingSeconds = Math.ceil((enhanceCooldown - elapsed) / 1000);
    return `⏰ 강화 쿨타임 ${remainingSeconds}초 남음`;
  }

  const currentLevel = user.sword_level;
  const inventory = user.inventory || {};
  let updatedInventory = { ...inventory };
  const specialWeapon = user.special_weapon || null;

  const rates = localSettings.enhance_success_rates || [];

  const maxAllowedLevel = specialWeapon ? (specialWeapon.max_level || 60) : 50;

  if (currentLevel >= maxAllowedLevel) {
    return `❌ 최대 강화 레벨 +${maxAllowedLevel}에 도달했습니다`;
  }

  const rateConfig = rates.find(r => r.level === currentLevel);

  if (!rateConfig) {
    return `❌ +${currentLevel} 강화는 지원하지 않습니다`;
  }

  const enhanceCost = rateConfig.cost || 10;

  if (user.gold < enhanceCost) {
    return `💸 골드 부족 (필요: ${enhanceCost.toLocaleString()}골드)`;
  }

  const shopItems = localSettings.shop_items || [];
  
  // 강화석: 창고에 있는 모든 enhance_boost 아이템 중 가장 높은 effect_value 선택
  const enhanceBoostItems = shopItems.filter(item => item.effect_type === 'enhance_boost');
  let bestEnhanceBoostItem = null;
  let bestEnhanceValue = 0;
  
  for (const item of enhanceBoostItems) {
    const itemCount = updatedInventory[item.name] || 0;
    if (itemCount > 0 && item.effect_value > bestEnhanceValue) {
      bestEnhanceBoostItem = item;
      bestEnhanceValue = item.effect_value;
    }
  }
  
  // 파괴방지, 하락방지, 옵션잠금, 떡국은 이름으로 직접 찾기
  let destroyPreventItemName = '';
  let downPreventItemName = '';
  let optionLockItemName = '';
  let tteokgukItemName = '';
  
  for (const itemName in updatedInventory) {
    if (updatedInventory[itemName] > 0) {
      if (itemName.includes('파괴') && itemName.includes('방지')) {
        destroyPreventItemName = itemName;
      }
      if (itemName.includes('하락') && itemName.includes('방지')) {
        downPreventItemName = itemName;
      }
      if (itemName.includes('옵션') && itemName.includes('잠금')) {
        optionLockItemName = itemName;
      }
      if (itemName.includes('떡국')) {
        tteokgukItemName = itemName;
      }
    }
  }

  let hasEnhanceBoost = bestEnhanceBoostItem !== null;
  let hasDestroyPrevent = destroyPreventItemName !== '';
  let hasDownPrevent = downPreventItemName !== '';
  let hasOptionLock = optionLockItemName !== '';
  let hasTteokguk = tteokgukItemName !== '';
  let enhanceBoostItemName = bestEnhanceBoostItem ? bestEnhanceBoostItem.name : '';
  let enhanceBoostValue = bestEnhanceValue;

  let successRate = rateConfig.success_rate;
  if (hasEnhanceBoost) {
    successRate += enhanceBoostValue;
  }

  const random = Math.random() * 100;
  let result = '';
  let newLevel = currentLevel;

  const weaponNames = localSettings.weapon_names || [];
  const firstAchievers = localSettings.level_first_achievers || {};
  const getWeaponName = (level) => {
    if (specialWeapon && specialWeapon.name) {
      return specialWeapon.name;
    }
    // +20 이상이고 최초 달성자가 있으면 "[닉네임]의 검" (닉네임 앞 5자만)
    if (level >= 20 && firstAchievers[level]) {
      return firstAchievers[level].substring(0, 5) + '의 검';
    }
    const weapon = weaponNames.find(w => w.level === level);
    return weapon ? weapon.name : '검';
  };

  if (random < successRate) {
    // 강화 성공 - 아이템 차감
    if (hasEnhanceBoost && enhanceBoostItemName) {
      updatedInventory[enhanceBoostItemName]--;
      if (updatedInventory[enhanceBoostItemName] === 0) {
        delete updatedInventory[enhanceBoostItemName];
      }
    }

    // 떡국 아이템 체크 - 10% 확률로 +2 강화 (일회용)
    let levelBonus = 1;
    let tteokgukUsed = false;
    let tteokgukSuccess = false;
    if (hasTteokguk && tteokgukItemName) {
      tteokgukUsed = true;
      // 떡국 사용 (소모)
      updatedInventory[tteokgukItemName]--;
      if (updatedInventory[tteokgukItemName] === 0) {
        delete updatedInventory[tteokgukItemName];
      }
      
      // 10% 확률로 +2 강화
      if (Math.random() < 0.1) {
        levelBonus = 2;
        tteokgukSuccess = true;
      }
    }

    newLevel = currentLevel + levelBonus;
    
    if (newLevel >= 20 && !specialWeapon) {
      const firstAchievers = localSettings.level_first_achievers || {};
      if (!firstAchievers[newLevel]) {
        firstAchievers[newLevel] = nickname;
        localSettings.level_first_achievers = firstAchievers;
      }
    }
    
    const weaponName = getWeaponName(newLevel);
    const attackBonus = specialWeapon ? Math.floor(Math.random() * 24) + 7 : Math.floor(Math.random() * 11) + 5;

    let weaponBonus = user.weapon_bonus || 0;
    let weaponBonus2 = user.weapon_bonus2 || 0;
    let weaponBonus3 = user.weapon_bonus3 || 0;

    // 옵션 잠금 부적 체크
    if (hasOptionLock && optionLockItemName) {
      // 옵션 잠금 부적 사용 - 기존 옵션 값 유지
      updatedInventory[optionLockItemName]--;
      if (updatedInventory[optionLockItemName] === 0) {
        delete updatedInventory[optionLockItemName];
      }
      // weaponBonus 값들은 기존 값 그대로 유지
    } else {
      // 옵션 잠금 부적 없으면 기존 옵션 개수 유지하되 수치만 랜덤 재설정
      weaponBonus = specialWeapon ? Math.floor(Math.random() * 26) + 10 : Math.floor(Math.random() * 31) + 5;

      // weapon_bonus2가 기존에 있었으면 재설정, 없었으면 0 유지
      if (weaponBonus2 > 0) {
        weaponBonus2 = specialWeapon ? Math.floor(Math.random() * 31) + 15 : Math.floor(Math.random() * 39) + 7;
      }

      // weapon_bonus3가 기존에 있었으면 재설정, 없었으면 0 유지
      if (weaponBonus3 > 0) {
        weaponBonus3 = specialWeapon ? Math.floor(Math.random() * 55) + 16 : Math.floor(Math.random() * 56) + 10;
      }
    }

    user.attack_power = (user.attack_power || 0) + attackBonus;
    user.weapon_bonus = weaponBonus;
    user.weapon_bonus2 = weaponBonus2;
    user.weapon_bonus3 = weaponBonus3;

    const relicAttack = calculateRelicAttack(user);
    const petAttack = calculatePetAttackBonus(user);
    const totalAttack = user.attack_power + user.weapon_bonus + (user.weapon_bonus2 || 0) + (user.weapon_bonus3 || 0) + relicAttack + petAttack;

    if (specialWeapon) {
      result = `〖✨강화 성공✨ +${currentLevel} → +${newLevel}〗\n🆙공격력+${attackBonus}\n🎁추가옵션: [공:${weaponBonus}]\n🎁추가옵션: [공:${weaponBonus2}]\n🔰총 공격력:${totalAttack.toFixed(1)}\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}G\n⚔️획득 검: [+${newLevel} ${weaponName}]`;
    } else {
      result = `〖✨강화 성공✨ +${currentLevel} → +${newLevel}〗\n🆙공격력+${attackBonus}\n🎁추가옵션: [공:${weaponBonus}]\n🔰총 공격력:${totalAttack.toFixed(1)}\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}G\n⚔️획득 검: [+${newLevel} ${weaponName}]`;
    }

    if (tteokgukUsed) {
      if (tteokgukSuccess) {
        result += '\n🍜 떡국 발동! +2 강화 성공! (10%)';
      } else {
        result += '\n🍜 떡국 사용 (발동 실패)';
      }
    }
    if (hasEnhanceBoost) {
      result += `\n✅ 강화제 사용됨 (성공률 +${enhanceBoostValue}%)`;
    }
    if (hasOptionLock) {
      result += '\n🔒 옵션 잠금 부적 사용됨 (추가 옵션 유지)';
    }
  } else if (random < successRate + rateConfig.fail_rate) {
    // 강화 실패 - 아이템 차감
    if (hasEnhanceBoost && enhanceBoostItemName) {
      updatedInventory[enhanceBoostItemName]--;
      if (updatedInventory[enhanceBoostItemName] === 0) {
        delete updatedInventory[enhanceBoostItemName];
      }
    }

    const weaponName = getWeaponName(currentLevel);
    result = `〖💥강화 실패💥〗\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${currentLevel} ${weaponName}]`;

    if (hasEnhanceBoost) {
      result += `\n✅ 강화제 사용됨 (성공률 +${enhanceBoostValue}%)`;
    }
  } else if (random < successRate + rateConfig.fail_rate + rateConfig.down_rate) {
    // 강화 하락 단계
    if (hasDownPrevent && downPreventItemName) {
      // 하락 방지 아이템 사용
      updatedInventory[downPreventItemName]--;
      if (updatedInventory[downPreventItemName] === 0) {
        delete updatedInventory[downPreventItemName];
      }

      if (hasEnhanceBoost && enhanceBoostItemName) {
        updatedInventory[enhanceBoostItemName]--;
        if (updatedInventory[enhanceBoostItemName] === 0) {
          delete updatedInventory[enhanceBoostItemName];
        }
      }

      const weaponName = getWeaponName(currentLevel);
      const relicAttack = calculateRelicAttack(user);
      const petAttack = calculatePetAttackBonus(user);
      const totalAttack = user.attack_power + (user.weapon_bonus || 0) + (user.weapon_bonus2 || 0) + relicAttack + petAttack;

      if (specialWeapon) {
        result = `〖🛡️하락 방지!〗\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${currentLevel} ${weaponName}]\n🎁추가옵션: [공:${user.weapon_bonus || 0}]\n🎁추가옵션: [공:${user.weapon_bonus2 || 0}]\n⚡총 공격력: ${totalAttack.toFixed(1)}\n✅ 하락방지 아이템 사용됨!`;
      } else {
        result = `〖🛡️하락 방지!〗\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${currentLevel} ${weaponName}]\n🎁추가옵션: [공:${user.weapon_bonus || 0}]\n⚡총 공격력: ${totalAttack.toFixed(1)}\n✅ 하락방지 아이템 사용됨!`;
      }

      if (hasEnhanceBoost) {
        result += `\n✅ 강화제 사용됨 (성공률 +${enhanceBoostValue}%)`;
      }
    } else {
      // 하락방지 아이템이 없으면 실제 하락
      if (hasEnhanceBoost && enhanceBoostItemName) {
        updatedInventory[enhanceBoostItemName]--;
        if (updatedInventory[enhanceBoostItemName] === 0) {
          delete updatedInventory[enhanceBoostItemName];
        }
      }

      newLevel = Math.max(0, currentLevel - 1);
      const weaponName = getWeaponName(newLevel);
      const attackLoss = specialWeapon ? Math.floor(Math.random() * 24) + 7 : Math.floor(Math.random() * 11) + 5;
      user.attack_power = Math.max(0, (user.attack_power || 0) - attackLoss);
      
      // 검이 +0으로 떨어질 때만 옵션 초기화, 그 외에는 옵션 유지
      if (newLevel === 0) {
        user.weapon_bonus = 0;
        user.weapon_bonus2 = 0;
        user.weapon_bonus3 = 0;
      }
      
      const relicAttack = calculateRelicAttack(user);
      const petAttack = calculatePetAttackBonus(user);
      const totalAttack = user.attack_power + user.weapon_bonus + (user.weapon_bonus2 || 0) + (user.weapon_bonus3 || 0) + relicAttack + petAttack;

      if (specialWeapon) {
        result = `〖💥강화 하락💥〗\n🔻공격력-${attackLoss}\n🎁추가옵션: [공:${user.weapon_bonus}]\n🎁추가옵션: [공:${user.weapon_bonus2 || 0}]\n🔰총 공격력:${totalAttack.toFixed(1)}\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${newLevel} ${weaponName}]`;
      } else {
        result = `〖💥강화 하락💥〗\n🔻공격력-${attackLoss}\n🎁추가옵션: [공:${user.weapon_bonus}]\n🔰총 공격력:${totalAttack.toFixed(1)}\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${newLevel} ${weaponName}]`;
      }

      if (hasEnhanceBoost) {
        result += `\n✅ 강화제 사용됨 (성공률 +${enhanceBoostValue}%)`;
      }
    }
  } else {
    // 파괴 단계
    if (hasDestroyPrevent && destroyPreventItemName) {
      // 파괴방지 차감
      updatedInventory[destroyPreventItemName]--;
      if (updatedInventory[destroyPreventItemName] === 0) {
        delete updatedInventory[destroyPreventItemName];
      }

      if (hasEnhanceBoost && enhanceBoostItemName) {
        updatedInventory[enhanceBoostItemName]--;
        if (updatedInventory[enhanceBoostItemName] === 0) {
          delete updatedInventory[enhanceBoostItemName];
        }
      }

      const weaponName = getWeaponName(currentLevel);
      const relicAttack = calculateRelicAttack(user);
      const petAttack = calculatePetAttackBonus(user);
      const totalAttack = user.attack_power + (user.weapon_bonus || 0) + (user.weapon_bonus2 || 0) + relicAttack + petAttack;

      if (specialWeapon) {
        result = `〖🛡️파괴 방지!〗\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${currentLevel} ${weaponName}]\n🎁추가옵션: [공:${user.weapon_bonus || 0}]\n🎁추가옵션: [공:${user.weapon_bonus2 || 0}]\n⚡총 공격력: ${totalAttack.toFixed(1)}\n✅ 파괴방지 아이템 사용됨!`;
      } else {
        result = `〖🛡️파괴 방지!〗\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️보유 검: [+${currentLevel} ${weaponName}]\n🎁추가옵션: [공:${user.weapon_bonus || 0}]\n⚡총 공격력: ${totalAttack.toFixed(1)}\n✅ 파괴방지 아이템 사용됨!`;
      }

      if (hasEnhanceBoost) {
        result += `\n✅ 강화제 사용됨 (성공률 +${enhanceBoostValue}%)`;
      }
    } else {
      // 파괴됨 - 강화제만 차감
      if (hasEnhanceBoost && enhanceBoostItemName) {
        updatedInventory[enhanceBoostItemName]--;
        if (updatedInventory[enhanceBoostItemName] === 0) {
          delete updatedInventory[enhanceBoostItemName];
        }
      }

      newLevel = 0;
      user.attack_power = 0;
      user.weapon_bonus = 0;
      user.weapon_bonus2 = 0;
      user.weapon_bonus3 = 0;
      user.special_weapon = null;
      result = `〖💥강화 파괴💥〗\n💸사용 골드: -${enhanceCost}골드\n💰남은 골드: ${(user.gold - enhanceCost).toLocaleString()}골드\n⚔️획득 검: [+0 낡은 검]\n⚡공격력: 0 (초기화)`;

      if (specialWeapon) {
        result += '\n💔 특수 무기가 파괴되어 일반 무기로 돌아갔습니다';
      }

      if (hasEnhanceBoost) {
        result += `\n✅ 강화제 사용됨 (성공률 +${enhanceBoostValue}%)`;
      }
    }
  }

  user.gold -= enhanceCost;
  user.sword_level = newLevel;
  user.max_sword_level = Math.max(user.max_sword_level, newLevel);
  user.inventory = updatedInventory;

  enhanceCooldowns.set(tag, Date.now());
  
  // 로컬 저장
  saveLocalData();
  
  return result;
}

function handleSwordInfo(tag, nickname, targetTag) {
  const getWeaponName = (level, specialWeapon) => {
    if (specialWeapon && specialWeapon.name) {
      // 빛나는 단비검일 경우 특별한 표시
      if (specialWeapon.name === '빛나는 단비검') {
        return '✨빛나는 단비검✨';
      }
      return specialWeapon.name;
    }
    const weaponNames = localSettings?.weapon_names || [];
    const weapon = weaponNames.find(w => w.level === level);
    return weapon ? weapon.name : '검';
  };

  const calculateTotalAttack = (userData) => {
    const relicAttack = calculateRelicAttack(userData);
    const runeAttack = calculateRuneAttack(userData);
    const petAttack = calculatePetAttackBonus(userData);
    let totalAttack = (userData.attack_power || 0) + (userData.weapon_bonus || 0) + (userData.weapon_bonus2 || 0) + (userData.weapon_bonus3 || 0) + relicAttack + runeAttack + petAttack;
    // 빛나는 단비검 추가 공격력 +30은 이미 attack_power에 포함되어 있음
    return totalAttack;
  };

  if (targetTag && targetTag.length > 0) {
    const targetUser = localUsers.get(targetTag);
    
    if (!targetUser) {
      return `❌ ${targetTag} 유저를 찾을 수 없습니다`;
    }
    
    const weaponBonus = targetUser.weapon_bonus || 0;
    const weaponBonus2 = targetUser.weapon_bonus2 || 0;
    const weaponBonus3 = targetUser.weapon_bonus3 || 0;
    const relicAttack = calculateRelicAttack(targetUser);
    const runeAttack = calculateRuneAttack(targetUser);
    const totalAttack = calculateTotalAttack(targetUser);
    const weaponName = getWeaponName(targetUser.sword_level, targetUser.special_weapon);

    let msg = `⚔️ [${targetUser.nickname}님 검정보]\n`;
    msg += `● 전적: ${targetUser.battle_wins || 0}승 ${targetUser.battle_losses || 0}패\n`;
    msg += `● 보유 골드: ${(targetUser.gold || 0).toLocaleString()}골드\n`;
    msg += `● 최고 기록: [+${targetUser.max_sword_level || 0}]\n`;
    msg += `● 보유 검: [+${targetUser.sword_level || 0} ${weaponName}]\n`;

    if (weaponBonus > 0) {
      msg += `● 추가옵션1: [공:${weaponBonus}]\n`;
    }
    if (weaponBonus2 > 0) {
      msg += `● 추가옵션2: [공:${weaponBonus2}]\n`;
    }
    if (weaponBonus3 > 0) {
      msg += `● 추가옵션3: [공:${weaponBonus3}]\n`;
    }
    if (relicAttack > 0) {
      msg += `● 보유 유물: ${relicAttack.toFixed(1)}\n`;
    }
    if (runeAttack > 0) {
      const runeCount = Object.keys(user.runes || {}).length;
      msg += `● 보유 룬: ${runeAttack.toFixed(1)} (${runeCount}개)\n`;
    }

    msg += `● 공격력: [+${totalAttack.toFixed(1)}]`;

    return msg;
    }

  const user = localUsers.get(tag);
  
  if (!user) {
    return '❌ 검키우기 데이터가 없습니다. !출석 또는 💖 클릭으로 시작하세요';
  }

  const weaponBonus = user.weapon_bonus || 0;
  const weaponBonus2 = user.weapon_bonus2 || 0;
  const weaponBonus3 = user.weapon_bonus3 || 0;
  const relicAttack = calculateRelicAttack(user);
  const runeAttack = calculateRuneAttack(user);
  const totalAttack = calculateTotalAttack(user);
  const weaponName = getWeaponName(user.sword_level, user.special_weapon);

  let msg = `⚔️ [${nickname}님 검정보]\n`;
  msg += `● 전적: ${user.battle_wins || 0}승 ${user.battle_losses || 0}패\n`;
  msg += `● 보유 골드: ${(user.gold || 0).toLocaleString()}골드\n`;
  msg += `● 최고 기록: [+${user.max_sword_level || 0}]\n`;
  msg += `● 보유 검: [+${user.sword_level || 0} ${weaponName}]\n`;

  // 모든 옵션 표시 (0이 아닌 경우만)
  if (weaponBonus > 0) {
    msg += `● 추가옵션1: [공:${weaponBonus}]\n`;
  }
  if (weaponBonus2 > 0) {
    msg += `● 추가옵션2: [공:${weaponBonus2}]\n`;
  }
  if (weaponBonus3 > 0) {
    msg += `● 추가옵션3: [공:${weaponBonus3}]\n`;
  }
  if (relicAttack > 0) {
    msg += `● 보유 유물: ${relicAttack.toFixed(1)}\n`;
  }
  if (runeAttack > 0) {
    const runeCount = Object.keys(targetUser.runes || {}).length;
    msg += `● 보유 룬: ${runeAttack.toFixed(1)} (${runeCount}개)\n`;
  }

  msg += `● 공격력: [+${totalAttack.toFixed(1)}]`;

  return msg;
}

function handleDungeon(tag, nickname) {
  if (!localSettings || localSettings.enabled === false) {
    return '❌ 검키우기 시스템이 비활성화되어 있습니다';
  }

  const user = getOrCreateUser(tag, nickname);

  // 던전 이용권 체크
  if (!user.dungeon_tickets || user.dungeon_tickets <= 0) {
    return '❌ 던전 이용권이 부족합니다\n💡 !검상점에서 던전 이용권을 구매하세요';
  }

  const dungeonCooldown = (localSettings.dungeon_cooldown || 2) * 1000;
  const lastDungeonTime = dungeonCooldowns.get(tag) || 0;
  const elapsed = Date.now() - lastDungeonTime;

  if (elapsed < dungeonCooldown) {
    const remainingSeconds = Math.ceil((dungeonCooldown - elapsed) / 1000);
    return `⏰ 던전 쿨타임 ${remainingSeconds}초 남음`;
  }

  // 현재 층수 확인 (로컬 파일에서 로드된 값 사용)
  const currentFloor = user.current_dungeon_floor || 1;
  
  const dungeonFloors = localSettings?.dungeon_floors || [];
  
  const floorData = dungeonFloors.find(f => f.floor === currentFloor);
  
  if (!floorData) {
    return `❌ ${currentFloor}층 설정이 없습니다. 설정 페이지에서 던전을 설정하고 !설정새로고침 실행하세요.`;
  }

  const monsterLevel = floorData.monster_level;
  const monsterAttack = floorData.monster_attack;
  const relicAttack = calculateRelicAttack(user);
  const petAttack = calculatePetAttackBonus(user);
  const userPower = (user.attack_power || 0) + (user.weapon_bonus || 0) + (user.weapon_bonus2 || 0) + (user.weapon_bonus3 || 0) + relicAttack + petAttack;

  // 던전 이용권 소모
  user.dungeon_tickets--;

  if (userPower > monsterAttack) {
    // 승리
    let goldReward = currentFloor * 1000; // 층수 * 1000 골드
    
    // 펫 골드 보너스 적용
    const petGoldBonus = calculatePetGoldBonus(user);
    goldReward = Math.floor(goldReward * (1 + petGoldBonus));
    
    user.gold += goldReward;

    let rewardMsg = `🏆 던전 ${currentFloor}층 클리어! (이용권 -1)\n💀 몬스터: Lv.${monsterLevel} (공격력 ${monsterAttack})\n💰 골드 획득: ${goldReward.toLocaleString()}골드\n`;

    // 80층 클리어 시 단비가 버린검 -> 빛나는 단비검 변환 (중복 보상 방지)
    if (currentFloor === 80 && user.special_weapon && user.special_weapon.name === '단비가 버린검') {
      user.special_weapon.name = '빛나는 단비검';
      user.attack_power += 30;
      rewardMsg += `\n✨ 단비가 버린검이 빛나는 단비검으로 진화했습니다! (공격력 +30)\n`;
    } else if (currentFloor === 80 && user.special_weapon && user.special_weapon.name === '빛나는 단비검') {
      rewardMsg += `\n⚠️ 이미 빛나는 단비검을 보유 중이라 추가 보상이 없습니다\n`;
    }

    // 아이템 드랍 체크
    const itemRewards = floorData.item_rewards || [];
    const droppedMaterials = [];

    if (itemRewards.length > 0) {
      const totalChance = itemRewards.reduce((sum, item) => sum + (item.drop_chance || 0), 0);
      const random = Math.random() * totalChance;
      
      let currentSum = 0;
      let selectedItem = null;
      
      for (const itemConfig of itemRewards) {
        currentSum += itemConfig.drop_chance || 0;
        if (random <= currentSum) {
          selectedItem = itemConfig;
          break;
        }
      }
      
      if (selectedItem) {
        const itemName = selectedItem.item_name;
        const relicTypes = localSettings.relic_types || [];
        const isRelic = relicTypes.some(r => r.name === itemName);
        
        if (isRelic) {
          // 유물 드랍
          if (!user.relics) user.relics = {};
          
          if (user.relics[itemName]) {
            // 이미 보유 중인 유물 -> 재료로 변환
            const materialName = itemName + ' 재료';
            if (!user.inventory) user.inventory = {};
            user.inventory[materialName] = (user.inventory[materialName] || 0) + 1;
            droppedMaterials.push(`${materialName} (보유 유물 -> 재료)`);
            
            // 재료 3개 모이면 자동 레벨업
            if (user.inventory[materialName] >= 3) {
              user.inventory[materialName] -= 3;
              if (user.inventory[materialName] === 0) {
                delete user.inventory[materialName];
              }
              
              user.relics[itemName].level = (user.relics[itemName].level || 1) + 1;
              user.relics[itemName].exp = 0;
              rewardMsg += `✨ ${itemName} 레벨업! Lv.${user.relics[itemName].level}\n`;
            }
          } else {
            // 신규 유물 획득
            user.relics[itemName] = { level: 1, exp: 0 };
            droppedMaterials.push(`${itemName} (유물 획득!)`);
          }
        } else if (itemName.endsWith(' 재료')) {
          // 유물 재료 획득
          const materialName = itemName;
          const relicName = materialName.replace(' 재료', '');
          
          // 재료를 창고에 적립
          if (!user.inventory) user.inventory = {};
          user.inventory[materialName] = (user.inventory[materialName] || 0) + 1;
          droppedMaterials.push(materialName);
          
          // 재료 3개 모이면 자동으로 유물 레벨업
          if (user.inventory[materialName] >= 3) {
            user.inventory[materialName] -= 3;
            if (user.inventory[materialName] === 0) {
              delete user.inventory[materialName];
            }
            
            if (!user.relics) user.relics = {};
            if (!user.relics[relicName]) {
              // 유물이 없으면 새로 생성 (Lv.1)
              user.relics[relicName] = { level: 1, exp: 0 };
              rewardMsg += `✨ ${relicName} 획득! Lv.1\n`;
            } else {
              // 유물이 있으면 레벨업
              user.relics[relicName].level = (user.relics[relicName].level || 1) + 1;
              user.relics[relicName].exp = 0;
              rewardMsg += `✨ ${relicName} 레벨업! Lv.${user.relics[relicName].level}\n`;
            }
          }
        }
      }
    }

    if (droppedMaterials.length > 0) {
      rewardMsg += `🎁 재료 획득: ${droppedMaterials.join(', ')}\n`;
    }
    
    // 4% 확률로 자동쿠폰 드랍
    if (Math.random() < 0.04) {
      if (!user.inventory) user.inventory = {};
      const ticketName = '자동쿠폰';
      user.inventory[ticketName] = (user.inventory[ticketName] || 0) + 1;
      rewardMsg += `🎟️ 자동쿠폰 획득! (4%)\n`;
    }

    // 다음 층으로 이동
    if (currentFloor < 200) {
      user.current_dungeon_floor = currentFloor + 1;
      rewardMsg += `⬆️ 다음 층: ${user.current_dungeon_floor}층\n`;
    } else {
      user.current_dungeon_floor = 1; // 200층 클리어 시 1층으로 초기화
      rewardMsg += `🎉 던전 200층 완료! 축하합니다! 던전이 1층으로 초기화됩니다!\n`;
    }
    
    rewardMsg += `🎫 남은 이용권: ${user.dungeon_tickets}`;

    dungeonCooldowns.set(tag, Date.now());
    
    // 로컬 저장
    saveLocalData();
    
    return rewardMsg;
  } else {
    // 패배 - 현재 층수 유지하고 저장 (이용권은 이미 소모됨)
    dungeonCooldowns.set(tag, Date.now());
    
    // 로컬 저장 (던전 진행 상황 유지)
    saveLocalData();
    
    return `💀 던전 ${currentFloor}층 실패! (이용권 -1)\n💀 몬스터: Lv.${monsterLevel} (공격력 ${monsterAttack})\n⚔️ 내 공격력: ${userPower.toFixed(1)}\n🎫 남은 이용권: ${user.dungeon_tickets}\n더 강해져서 다시 도전하세요!`;
  }
}

function handleBattle(tag, nickname, targetTag) {
  if (!localSettings || localSettings.enabled === false) {
    return '❌ 검키우기 시스템이 비활성화되어 있습니다';
  }

  const user = getOrCreateUser(tag, nickname);

  const battleCooldown = (localSettings.battle_cooldown || 20) * 1000;
  const lastBattleTime = battleCooldowns.get(tag) || 0;
  const elapsed = Date.now() - lastBattleTime;

  if (elapsed < battleCooldown) {
    const remainingSeconds = Math.ceil((battleCooldown - elapsed) / 1000);
    return `⏰ 배틀 쿨타임 ${remainingSeconds}초 남음`;
  }

  let opponent;

  if (!targetTag) {
    const myLevel = user.sword_level || 0;
    const allUsers = Array.from(localUsers.values());
    
    const availableOpponents = allUsers.filter(u => 
      u.tag !== tag && 
      Math.abs((u.sword_level || 0) - myLevel) <= 5
    );
    
    if (availableOpponents.length > 0) {
      opponent = availableOpponents[Math.floor(Math.random() * availableOpponents.length)];
    } else {
      const npcLevel = myLevel + Math.floor(Math.random() * 11) - 5;
      const npcAttack = Math.max(0, npcLevel * 7 + Math.floor(Math.random() * 21) - 10);
      
      opponent = {
        "tag": 'npc_bot',
        "nickname": 'NPC',
        "sword_level": Math.max(0, npcLevel),
        "attack_power": npcAttack,
        "weapon_bonus": Math.floor(Math.random() * 10),
        "weapon_bonus2": 0,
        "weapon_bonus3": 0
      };
    }
  } else {
    opponent = localUsers.get(targetTag);
    if (!opponent) {
      return `❌ ${targetTag} 유저를 찾을 수 없습니다`;
    }
  }

  const relicAttack = calculateRelicAttack(user);
  const petAttack = calculatePetAttackBonus(user);
  const userPower = (user.attack_power || 0) + (user.weapon_bonus || 0) + (user.weapon_bonus2 || 0) + (user.weapon_bonus3 || 0) + relicAttack + petAttack;
  const opponentRelicAttack = calculateRelicAttack(opponent);
  const opponentPetAttack = calculatePetAttackBonus(opponent);
  const opponentPower = (opponent.attack_power || 0) + (opponent.weapon_bonus || 0) + (opponent.weapon_bonus2 || 0) + (opponent.weapon_bonus3 || 0) + opponentRelicAttack + opponentPetAttack;

  if (userPower > opponentPower) {
  let reward = Math.max(1, opponent.sword_level * localSettings.battle_reward_base);

  // 플랜 가입자는 보상 +1000 고정값
  const isPlanSubscriber = planSubscribers.get(tag) || false;
  if (isPlanSubscriber) {
    reward = reward + 1000;
  }

  // 펫 골드 보너스 적용
  const petGoldBonus = calculatePetGoldBonus(user);
  reward = Math.floor(reward * (1 + petGoldBonus));

  user.battle_wins++;
  user.gold += reward;

  // 상대방이 NPC가 아니면 상대방의 패배 카운트 증가
  if (opponent.tag !== 'npc_bot') {
    opponent.battle_losses++;
  }

  battleCooldowns.set(tag, Date.now());

  // 로컬 저장
  saveLocalData();

  let msg = `[🏆결과] ${nickname}(${userPower}) vs ${opponent.nickname}(${opponentPower}) 승리!\n`;
  msg += `💰전리품 ${reward.toLocaleString()}골드를 획득하였습니다`;
  if (isPlanSubscriber) {
    msg += `\n🌟플랜 가입자 보너스 +1,000골드!`;
  }
  return msg;
  } else if (userPower < opponentPower) {
    user.battle_losses++;

    // 상대방이 NPC가 아니면 상대방의 승리 카운트 증가
    if (opponent.tag !== 'npc_bot') {
      opponent.battle_wins++;
    }

    battleCooldowns.set(tag, Date.now());

    // 로컬 저장
    saveLocalData();

    return `[💀결과] ${nickname}(${userPower}) vs ${opponent.nickname}(${opponentPower}) 패배!\n아쉽게 패배했습니다`;
  } else {
    return `[🤝결과] ${nickname}(${userPower}) vs ${opponent.nickname}(${opponentPower}) 무승부!`;
  }
}

async function handleRanking(tag, nickname) {
  // 로컬 방 랭킹
  const allUsers = Array.from(localUsers.values());
  const localRanking = [...allUsers].sort((a, b) => b.sword_level - a.sword_level);

  const weaponNames = localSettings?.weapon_names || [];
  const getWeaponName = (level, userData) => {
    if (userData?.special_weapon?.name) return userData.special_weapon.name;
    const weapon = weaponNames.find(w => w.level === level);
    return weapon ? weapon.name : '검';
  };

  let msg = '';

  // DB 월드 랭킹 조회
  try {
    const response = await apiRequest('getGlobalSwordRanking', 'GET', {});
    if (response.users && response.users.length > 0) {
      const globalRanking = response.users.sort((a, b) => b.sword_level - a.sword_level).slice(0, 5);
      
      msg += `🏆 검키우기 월드 랭킹 🏆\n`;
      for (let i = 0; i < globalRanking.length; i++) {
        const user = globalRanking[i];
        const weaponName = getWeaponName(user.sword_level, user);
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '등';
        msg += medal + ' ' + user.nickname + '(' + user.tag + ') [+' + user.sword_level + '] ' + weaponName;
        if (i < globalRanking.length - 1) {
          msg += '\n';
        }
      }
      msg += '\n\n';
    }
  } catch (error) {
    console.log('[월드 랭킹 조회 실패]', error);
  }

  // 우리방 랭킹
  if (localRanking.length > 0) {
    msg += `🏆 우리방 검랭킹 🏆\n`;
    for (let i = 0; i < Math.min(5, localRanking.length); i++) {
      const user = localRanking[i];
      const weaponName = getWeaponName(user.sword_level, user);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '등';
      msg += medal + ' ' + user.nickname + '(' + user.tag + ') [+' + user.sword_level + '] ' + weaponName;
      if (i < Math.min(4, localRanking.length - 1)) {
        msg += '\n';
      }
    }
  } else {
    msg += '❌ 우리방 랭킹 데이터가 없습니다';
  }

  return msg;
}

function handleSell(tag, nickname) {
  const user = getOrCreateUser(tag, nickname);

  const rates = localSettings.enhance_success_rates || [];
  let totalEnhanceCost = 0;
  for (let i = 0; i < user.sword_level; i++) {
    const rateConfig = rates.find(r => r.level === i);
    totalEnhanceCost += rateConfig ? (rateConfig.cost || 10) : 10;
  }

  // 강화 비용의 60% 환불
  const refund = Math.floor(totalEnhanceCost * 0.6);

  user.gold += refund;
  user.sword_level = 0;
  user.attack_power = 0;
  user.weapon_bonus = 0;
  user.weapon_bonus2 = 0;
  user.weapon_bonus3 = 0;
  user.special_weapon = null;
  
  // 로컬 저장
  saveLocalData();

  let msg = `${nickname}님〖검 판매〗\n`;
  msg += `💶획득 골드: +${refund.toLocaleString()}골드 (강화비용 60%)\n`;
  msg += `💰현재 보유 골드: ${user.gold.toLocaleString()}골드\n`;
  msg += `⚔️새로운 검 획득: [+0] 낡은 검`;

  return msg;
}

function handleInventory(tag, nickname) {
  const user = getOrCreateUser(tag, nickname);

  const inventory = user.inventory || {};
  const items = Object.entries(inventory).filter(([_, count]) => count > 0);

  if (items.length === 0) {
    return '🎒 창고가 비어있습니다';
  }

  let msg = '🎒 창고\n';
  items.forEach(([itemName, count], index) => {
    msg += `${index + 1}. ${itemName} x${count}\n`;
  });

  return msg;
}

function handleDailyMoney(tag, nickname) {
  if (!localSettings || localSettings.enabled === false) {
    return '❌ 검키우기 시스템이 비활성화되어 있습니다';
  }

  const user = getOrCreateUser(tag, nickname);
  const today = new Date().toISOString().split('T')[0];

  if (user.last_daily_money_date === today) {
    return '💸 오늘 이미 출석 보상을 받았습니다';
  }

  let dailyMoney = localSettings.daily_money || 10000;
  
  // 펫 골드 보너스 적용
  const petGoldBonus = calculatePetGoldBonus(user);
  dailyMoney = Math.floor(dailyMoney * (1 + petGoldBonus));
  
  user.gold += dailyMoney;
  user.last_daily_money_date = today;
  
  // 로컬 저장
  saveLocalData();

  return `✅ 출석 완료! +${dailyMoney.toLocaleString()}골드\n💰 현재 골드: ${user.gold.toLocaleString()}골드`;
}

function handleRelics(tag, nickname) {
  const user = getOrCreateUser(tag, nickname);

  const relics = user.relics || {};
  const relicTypes = localSettings.relic_types || [];

  if (Object.keys(relics).length === 0) {
    return '🏺 보유 중인 유물이 없습니다\n던전을 클리어하여 유물을 획득하세요!';
  }

  let msg = '🏺 보유 유물\n\n';

  let index = 1;
  for (const relicName in relics) {
    const relicData = relics[relicName];
    const relicType = relicTypes.find(r => r.name === relicName);

    const level = relicData.level || 1;
    const exp = relicData.exp || 0;

    // relicType이 없으면 기본값 사용
    const attackPerLevel = relicType ? relicType.attack_per_level : 0.1;
    const expPerLevel = relicType ? relicType.exp_per_level : 30;
    const attackBonus = level * attackPerLevel;

    // 도플갱어는 재료 시스템 사용
    if (relicName === '도플갱어') {
      const inventory = user.inventory || {};
      const materialName = '도플갱어 재료';
      const currentMaterials = inventory[materialName] || 0;
      const materialsNeeded = (level + 1) * 3; // 다음 레벨업에 필요한 재료

      msg += `${index}. ${relicName} Lv.${level} 공격+${attackBonus.toFixed(1)} (${currentMaterials}/${materialsNeeded})\n`;
    } else {
      // 일반 유물은 경험치 시스템
      const expNeeded = level * expPerLevel;
      msg += `${index}. ${relicName} Lv.${level} 공격+${attackBonus.toFixed(1)} (${exp}/${expNeeded})\n`;
    }
    index++;
  }

  return msg;
}

function handleRunes(tag, nickname) {
  const user = getOrCreateUser(tag, nickname);

  const runes = user.runes || {};
  const runeFragments = user.rune_fragments || 0;

  let msg = '💎 보유 룬\n\n';
  msg += `📦 룬 조각: ${runeFragments}개\n\n`;

  if (Object.keys(runes).length === 0) {
    msg += '보유 중인 룬이 없습니다\n!탐험으로 룬 조각을 모아 룬을 제작하세요!';
  } else {
    let index = 1;
    for (const runeName in runes) {
      const runeData = runes[runeName];
      const level = runeData.level || 1;
      const attack = runeData.attack || 0;

      msg += `${index}. ${runeName} Lv.${level} 공격+${attack.toFixed(1)}\n`;
      index++;
    }
  }

  return msg;
}

function handleExplore(tag, nickname) {
  if (!localSettings || localSettings.enabled === false) {
    return '❌ 검키우기 시스템이 비활성화되어 있습니다';
  }

  const user = getOrCreateUser(tag, nickname);

  // 하루 제한 체크 (플랜 사용자 15번, 일반 사용자 10번)
  const maxExploreCount = (user.user_plan_level > 0) ? 15 : 10;
  const today = new Date().toISOString().split('T')[0];
  if (!user.last_explore_date || user.last_explore_date !== today) {
    user.last_explore_date = today;
    user.explore_count = 0;
  }

  if (user.explore_count >= maxExploreCount) {
    return `❌ 오늘의 탐험 횟수를 모두 사용했습니다 (${user.explore_count}/${maxExploreCount})\n⏰ 자정(00:00)에 초기화됩니다`;
  }

  const exploreCooldown = 30 * 1000; // 30초 쿨타임
  const lastExploreTime = enhanceCooldowns.get(tag + '_explore') || 0;
  const elapsed = Date.now() - lastExploreTime;

  if (elapsed < exploreCooldown) {
    const remainingSeconds = Math.ceil((exploreCooldown - elapsed) / 1000);
    return `⏰ 탐험 쿨타임 ${remainingSeconds}초 남음`;
  }

  // 룬 조각 1~5개 랜덤 획득
  const fragmentsGained = Math.floor(Math.random() * 5) + 1;
  user.rune_fragments = (user.rune_fragments || 0) + fragmentsGained;
  user.explore_count = (user.explore_count || 0) + 1;

  enhanceCooldowns.set(tag + '_explore', Date.now());
  saveLocalData();

  return `🗺️ 탐험 완료! (${user.explore_count}/${maxExploreCount})\n💎 룬 조각 +${fragmentsGained}개 획득\n📦 보유 조각: ${user.rune_fragments}개\n💡 조각 100개로 룬 제작 가능 (!룬제작)`;
}

function handleCraftRune(tag, nickname) {
  const user = getOrCreateUser(tag, nickname);

  // 이미 룬을 보유 중이면 제작 불가
  if (user.runes && Object.keys(user.runes).length > 0) {
    return `❌ 이미 룬을 보유하고 있습니다\n💡 !룬강화로 레벨업하세요`;
  }

  if ((user.rune_fragments || 0) < 100) {
    return `❌ 룬 조각 부족 (보유: ${user.rune_fragments || 0}개, 필요: 100개)`;
  }

  // 룬 조각 100개 소모
  user.rune_fragments -= 100;

  // 10% 확률로 성공
  const random = Math.random() * 100;

  if (random < 10) {
    // 성공 - 룬 생성
    // 70% 확률로 2~20, 30% 확률로 21~40
    let runeAttack;
    if (Math.random() < 0.7) {
      runeAttack = Math.floor(Math.random() * 19) + 2; // 2~20
    } else {
      runeAttack = Math.floor(Math.random() * 20) + 21; // 21~40
    }
    const runeId = Date.now();
    const runeName = `룬#${runeId}`;

    if (!user.runes) user.runes = {};
    user.runes[runeName] = {
      level: 1,
      attack: runeAttack
    };

    saveLocalData();

    return `✨ 룬 제작 성공! (10%)\n💎 ${runeName} 획득 (Lv.1, 공격+${runeAttack})\n📦 남은 조각: ${user.rune_fragments}개\n💡 !룬강화로 레벨업 가능`;
  } else {
    // 실패
    saveLocalData();

    return `💥 룬 제작 실패... (10%)\n📦 남은 조각: ${user.rune_fragments}개`;
  }
}

function handleSellRune(tag, nickname, runeName) {
  if (!runeName) {
    return '사용법: !룬판매 [룬이름]\n예: !룬판매 룬#1234567890';
  }

  const user = getOrCreateUser(tag, nickname);
  const runes = user.runes || {};

  if (!runes[runeName]) {
    return `❌ ${runeName}을(를) 보유하고 있지 않습니다`;
  }

  const runeData = runes[runeName];
  const sellPrice = runeData.attack * 1000; // 공격력 * 1000골드

  user.gold = (user.gold || 0) + sellPrice;
  delete runes[runeName];
  user.runes = runes;

  saveLocalData();

  return `✅ ${runeName} 판매 완료!\n💰 획득 골드: +${sellPrice.toLocaleString()}골드\n💰 보유 골드: ${user.gold.toLocaleString()}골드`;
}

function handleUpgradeRune(tag, nickname, runeName) {
  const user = getOrCreateUser(tag, nickname);
  const runes = user.runes || {};

  // 룬이 없으면 에러
  if (Object.keys(runes).length === 0) {
    return '❌ 보유 중인 룬이 없습니다\n💡 !룬제작으로 먼저 룬을 만드세요';
  }

  // 룬 이름이 없으면 보유 중인 룬 자동 선택
  if (!runeName) {
    runeName = Object.keys(runes)[0];
  }

  if (!runes[runeName]) {
    return `❌ ${runeName}을(를) 보유하고 있지 않습니다`;
  }

  const runeData = runes[runeName];
  const currentLevel = runeData.level || 1;
  
  // 레벨별 필요 조각 수: 20, 40, 80, 160, 320...
  const requiredFragments = 20 * Math.pow(2, currentLevel - 1);

  if ((user.rune_fragments || 0) < requiredFragments) {
    return `❌ 룬 조각 부족 (보유: ${user.rune_fragments || 0}개, 필요: ${requiredFragments}개)\n💡 !탐험으로 조각을 모으세요`;
  }

  // 룬 조각 소모
  user.rune_fragments -= requiredFragments;

  // 레벨업 및 공격력 증가
  const attackBonus = Math.floor(Math.random() * 6) + 5; // 5~10
  runeData.level++;
  runeData.attack += attackBonus;

  user.runes = runes;
  saveLocalData();

  return `✨ ${runeName} 강화 성공!\n🆙 Lv.${currentLevel} → Lv.${runeData.level}\n⚡ 공격력 +${attackBonus} (총 ${runeData.attack})\n💎 룬 조각 ${requiredFragments}개 소모\n📦 남은 조각: ${user.rune_fragments}개`;
}

// ══════════════════════════════════════════════════════
// ⚔️ 검키우기 2차 이식 — 상점/구매, 몬스터박스, 펫, 자동배틀, 거래소, 방보스, 관리자 지급.
// 1차 이식 때 이미 만들어둔 shop_items/mystery_box_items/monster_box_items 설정과
// pets/equipped_pet_id/pet_fragments/spoon_points 유저 필드, calculatePetAttackBonus/
// calculatePetGoldBonus(이미 배틀·던전 보상 계산에 반영돼있음)를 그대로 활용한다.
// ══════════════════════════════════════════════════════

// ── 🏪 상점 / 구매 ──
function handleShop() {
  const items = (localSettings && localSettings.shop_items) || []
  if (!items.length) return '🏪 상점이 비어있어요'
  let msg = '🏪 검상점\n'
  items.forEach((it, i) => {
    const cur = it.price_type === 'spoon_points' ? 'P' : 'G'
    msg += `${i + 1}. ${it.name} - ${(it.price || 0).toLocaleString()}${cur}\n`
  })
  msg += '\n!검구매[번호] [수량(선택)]'
  return msg
}

// 몬스터 상자 개봉: monster_box_items의 "공격펫(+min~max)" / "골드펫(+min~max%)" 이름에서
// 범위를 파싱해 랜덤 값으로 실제 펫을 만들어준다. "골드" 항목은 즉시 골드 지급, 나머지는 인벤토리 적립.
function _swParsePetRange(name) {
  const m = String(name || '').match(/\(\+?(\d+)~(\d+)%?\)/)
  if (!m) return null
  return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) }
}
function _swRollTable(table) {
  const total = table.reduce((s, r) => s + (Number(r.chance) || 0), 0)
  if (total <= 0) return table[table.length - 1]
  let roll = Math.random() * total
  for (const row of table) {
    roll -= (Number(row.chance) || 0)
    if (roll <= 0) return row
  }
  return table[table.length - 1]
}
function openMonsterBoxes(user, qty) {
  const table = (localSettings && localSettings.monster_box_items) || []
  if (!table.length) return '❌ 몬스터 상자 아이템이 설정되지 않았어요'
  if (!user.pets) user.pets = []
  if (!user.inventory) user.inventory = {}
  const counts = {}
  for (let i = 0; i < qty; i++) {
    const picked = _swRollTable(table)
    counts[picked.name] = (counts[picked.name] || 0) + 1
    if (picked.name === '골드') {
      user.gold += picked.amount || 0
    } else if (picked.name.startsWith('공격펫') || picked.name.startsWith('골드펫')) {
      const isAttack = picked.name.startsWith('공격펫')
      const range = _swParsePetRange(picked.name)
      const val = range ? (range.min + Math.floor(Math.random() * (range.max - range.min + 1))) : (isAttack ? 5 : 100)
      user.pets.push({
        id: 'pet_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: isAttack ? `공격펫(+${val})` : `골드펫(+${val}%)`,
        type: isAttack ? 'attack' : 'gold',
        attack_bonus: isAttack ? val : 0,
        gold_bonus_percent: isAttack ? 0 : val
      })
    } else {
      user.inventory[picked.name] = (user.inventory[picked.name] || 0) + (picked.amount || 1)
    }
  }
  return Object.entries(counts).map(([n, c]) => `📦 ${n} x${c}`).join('\n')
}

function handlePurchase(tag, nickname, idxRaw, qtyRaw) {
  const idx = parseInt(idxRaw, 10)
  if (!idx || idx < 1) return '사용법: !검구매[번호] [수량]\n예: !검구매1 또는 !검구매1 3'
  const numQty = Math.max(1, parseInt(qtyRaw, 10) || 1)
  const items = (localSettings && localSettings.shop_items) || []
  const it = items[idx - 1]
  if (!it) return '❌ 없는 아이템 번호예요'

  const user = getOrCreateUser(tag, nickname)
  const total = (it.price || 0) * numQty
  const pt = it.price_type || 'gold'
  if (pt === 'spoon_points') {
    if ((user.spoon_points || 0) < total) return `💸 스푼 포인트 부족 (필요: ${total}P, 보유: ${user.spoon_points || 0}P)`
  } else {
    if (user.gold < total) return `💸 골드 부족 (필요: ${total.toLocaleString()}골드)`
  }
  const pay = () => { if (pt === 'spoon_points') user.spoon_points -= total; else user.gold -= total }

  if (it.effect_type === 'dungeon_ticket') {
    pay(); user.dungeon_tickets = (user.dungeon_tickets || 0) + numQty * (it.effect_value || 1)
    saveLocalData()
    return `✅ 던전 이용권 x${numQty} 구매!\n🎫 보유: ${user.dungeon_tickets}개`
  }
  if (it.effect_type === 'dungeon_reset') {
    pay(); user.current_dungeon_floor = 1
    saveLocalData()
    return '✅ 던전 리셋! 1층으로 초기화됐어요'
  }
  if (it.effect_type === 'auto_battle_ticket') {
    pay()
    if (!user.inventory) user.inventory = {}
    user.inventory['자동쿠폰'] = (user.inventory['자동쿠폰'] || 0) + numQty
    saveLocalData()
    return `✅ 자동쿠폰 x${numQty} 구매!\n🎟️ 보유: ${user.inventory['자동쿠폰']}개 (1개 = ${it.effect_value || 10}분)`
  }
  if (it.effect_type === 'mystery_box') {
    const mbi = (localSettings && localSettings.mystery_box_items) || []
    if (!mbi.length) return '❌ 미스터리 상자가 설정되지 않았어요'
    pay()
    if (!user.inventory) user.inventory = {}
    const counts = {}
    for (let i = 0; i < numQty; i++) {
      const picked = _swRollTable(mbi)
      counts[picked.name] = (counts[picked.name] || 0) + 1
      if (picked.name === '골드') user.gold += picked.amount || 2000
      else user.inventory[picked.name] = (user.inventory[picked.name] || 0) + 1
    }
    saveLocalData()
    return `🎁 미스터리 상자 x${numQty} 오픈!\n\n` + Object.entries(counts).map(([n, c]) => `📦 ${n} x${c}`).join('\n') + `\n\n💰 잔액: ${user.gold.toLocaleString()}골드`
  }
  if (it.effect_type === 'monster_box') {
    pay()
    const openMsg = openMonsterBoxes(user, numQty)
    saveLocalData()
    return `🎁 몬스터 상자 x${numQty} 오픈!\n\n${openMsg}\n\n💰 잔액: ${user.gold.toLocaleString()}골드 / 💎 스푼: ${user.spoon_points || 0}P`
  }
  if (it.effect_type === 'pet_box') {
    pay()
    if (!user.pets) user.pets = []
    const names = []
    for (let i = 0; i < numQty; i++) {
      const isAttack = Math.random() < 0.5
      const val = isAttack ? (5 + Math.floor(Math.random() * 146)) : (200 + Math.floor(Math.random() * 19801))
      const pet = {
        id: 'pet_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: isAttack ? `공격펫(+${val})` : `골드펫(+${val}%)`,
        type: isAttack ? 'attack' : 'gold',
        attack_bonus: isAttack ? val : 0,
        gold_bonus_percent: isAttack ? 0 : val
      }
      user.pets.push(pet)
      names.push(pet.name)
    }
    saveLocalData()
    return `🐾 펫 상자 x${numQty} 오픈!\n\n${names.map(n => '🐾 ' + n).join('\n')}\n\n총 보유 펫: ${user.pets.length}마리\n!펫 으로 확인하고 !펫착용[번호]로 장착하세요`
  }
  // 강화제/파괴방지/하락방지/옵션류 등 나머지는 이름 그대로 인벤토리에 적립
  // (handleEnhance가 이미 아이템 이름으로 알아서 인식하도록 짜여있음)
  pay()
  if (!user.inventory) user.inventory = {}
  user.inventory[it.name] = (user.inventory[it.name] || 0) + numQty
  saveLocalData()
  return `✅ ${it.name} x${numQty} 구매 완료!\n${pt === 'spoon_points' ? '💎 잔여 스푼: ' + (user.spoon_points || 0) + 'P' : '💰 잔여 골드: ' + user.gold.toLocaleString() + '골드'}`
}

// ── 🐾 펫 ──
function handleMyPets(tag, nickname) {
  const user = getOrCreateUser(tag, nickname)
  const pets = user.pets || []
  if (!pets.length) return '🐾 보유한 펫이 없어요\n💡 !검상점에서 펫 상자를 구매해보세요 (스푼 포인트 필요)'
  let msg = `🐾 보유 펫 (${pets.length}마리) · 💎 펫 재료: ${user.pet_fragments || 0}개\n\n`
  pets.forEach((p, i) => {
    const eq = p.id === user.equipped_pet_id ? ' [착용중]' : ''
    msg += p.type === 'attack' ? `${i + 1}. ${p.name} 공격력+${p.attack_bonus}${eq}\n` : `${i + 1}. ${p.name} 골드+${p.gold_bonus_percent}%${eq}\n`
  })
  msg += '\n!펫착용[번호] · !펫해제 · !펫분해[번호] · !펫강화[번호]'
  return msg
}
function handleEquipPet(tag, nickname, idxRaw) {
  const idx = parseInt(idxRaw, 10)
  if (!idx || idx < 1) return '사용법: !펫착용[번호]'
  const user = getOrCreateUser(tag, nickname)
  const pet = (user.pets || [])[idx - 1]
  if (!pet) return '❌ 없는 펫 번호예요'
  user.equipped_pet_id = pet.id
  saveLocalData()
  const bonus = pet.type === 'attack' ? `공격력+${pet.attack_bonus}` : `골드+${pet.gold_bonus_percent}%`
  return `✅ ${pet.name} 착용 완료! (${bonus})`
}
function handleUnequipPet(tag, nickname) {
  const user = getOrCreateUser(tag, nickname)
  if (!user.equipped_pet_id) return '❌ 착용 중인 펫이 없어요'
  user.equipped_pet_id = null
  saveLocalData()
  return '✅ 펫 해제 완료!'
}
function handleDisassemblePet(tag, nickname, idxRaw) {
  const idx = parseInt(idxRaw, 10)
  if (!idx || idx < 1) return '사용법: !펫분해[번호]'
  const user = getOrCreateUser(tag, nickname)
  const pets = user.pets || []
  const pet = pets[idx - 1]
  if (!pet) return '❌ 없는 펫 번호예요'
  if (pet.id === user.equipped_pet_id) return '❌ 착용 중인 펫은 분해할 수 없어요. 먼저 !펫해제 해주세요'
  pets.splice(idx - 1, 1)
  user.pets = pets
  const gained = 5
  user.pet_fragments = (user.pet_fragments || 0) + gained
  saveLocalData()
  return `✅ ${pet.name} 분해 완료!\n💎 펫 재료 +${gained}개 (보유: ${user.pet_fragments}개)`
}
const SWORD_PET_ENHANCE_COST = 10
function handleEnhancePet(tag, nickname, idxRaw) {
  const idx = parseInt(idxRaw, 10)
  if (!idx || idx < 1) return '사용법: !펫강화[번호]'
  const user = getOrCreateUser(tag, nickname)
  const pet = (user.pets || [])[idx - 1]
  if (!pet) return '❌ 없는 펫 번호예요'
  if ((user.pet_fragments || 0) < SWORD_PET_ENHANCE_COST) return `💎 펫 재료 부족 (필요: ${SWORD_PET_ENHANCE_COST}개, 보유: ${user.pet_fragments || 0}개)\n💡 다른 펫을 !펫분해 해서 재료를 모아보세요`
  user.pet_fragments -= SWORD_PET_ENHANCE_COST
  if (pet.type === 'attack') {
    pet.attack_bonus += Math.max(1, Math.round(pet.attack_bonus * 0.1))
    pet.name = `공격펫(+${pet.attack_bonus})`
  } else {
    pet.gold_bonus_percent += Math.max(10, Math.round(pet.gold_bonus_percent * 0.1))
    pet.name = `골드펫(+${pet.gold_bonus_percent}%)`
  }
  saveLocalData()
  const bonus = pet.type === 'attack' ? `공격력+${pet.attack_bonus}` : `골드+${pet.gold_bonus_percent}%`
  return `✅ 펫 강화 완료! ${pet.name}\n💎 남은 재료: ${user.pet_fragments}개 · 효과: ${bonus}`
}

// ── 🤖 자동배틀 — 자동쿠폰 1개 = 10분, 10초마다 자동으로 !배틀 실행 ──
function handleAutoOn(djId, tag, nickname, qtyRaw) {
  if (autoBattleUsers.has(tag)) return '⚠️ 이미 자동배틀이 진행 중이에요'
  const user = getOrCreateUser(tag, nickname)
  const inv = user.inventory || {}
  const ticketCount = inv['자동쿠폰'] || 0
  if (ticketCount <= 0) return '❌ 자동쿠폰이 없어요\n💡 던전에서 획득하거나 !검상점에서 구매해보세요'

  let used = ticketCount
  const sq = parseInt(qtyRaw, 10)
  if (sq > 0 && sq <= ticketCount) used = sq
  const perTicketMin = 10
  const totalMs = used * perTicketMin * 60 * 1000

  inv['자동쿠폰'] -= used
  if (inv['자동쿠폰'] <= 0) delete inv['자동쿠폰']
  user.inventory = inv

  autoBattleUsers.set(tag, true)
  autoBattleStats.set(tag, { battles: 0, wins: 0, losses: 0, goldEarned: 0 })

  const intervalId = setInterval(() => {
    if (!autoBattleUsers.has(tag)) { clearInterval(intervalId); return }
    const stats = autoBattleStats.get(tag)
    if (!stats) return
    const before = (localUsers.get(tag) || {}).gold || 0
    let battleResult = null
    try { battleResult = handleBattle(tag, nickname, '') } catch (e) { battleResult = null }
    if (battleResult && !battleResult.includes('쿨타임')) {
      stats.battles++
      const after = (localUsers.get(tag) || {}).gold || 0
      const diff = after - before
      if (battleResult.includes('승리')) { stats.wins++; stats.goldEarned += Math.max(0, diff) }
      else if (battleResult.includes('패배')) stats.losses++
    }
  }, 10000)
  autoBattleIntervals.set(tag, intervalId)

  const timeoutId = setTimeout(() => {
    const iid = autoBattleIntervals.get(tag)
    if (iid) clearInterval(iid)
    autoBattleIntervals.delete(tag)
    const stats = autoBattleStats.get(tag) || {}
    autoBattleUsers.delete(tag)
    autoBattleStats.delete(tag)
    autoBattleTimeouts.delete(tag)
    saveLocalData()
    sendChatSplit(djId, `⏰ [${nickname}] 자동배틀 시간 종료!\n📊 총 ${stats.battles || 0}회 대결 (${stats.wins || 0}승 ${stats.losses || 0}패)\n💰 획득 골드: ${(stats.goldEarned || 0).toLocaleString()}골드`, 150, 300)
  }, totalMs)
  autoBattleTimeouts.set(tag, timeoutId)

  saveLocalData()
  return `✅ 자동배틀 시작!\n🎟️ 쿠폰 ${used}개 사용 (${used * perTicketMin}분간 진행, 10초마다 자동 대결)\n!자동오프 로 중간에 멈출 수 있어요`
}
function handleAutoOff(tag) {
  if (!autoBattleUsers.has(tag)) return '❌ 진행 중인 자동배틀이 없어요'
  const iid = autoBattleIntervals.get(tag); if (iid) clearInterval(iid)
  const tid = autoBattleTimeouts.get(tag); if (tid) clearTimeout(tid)
  const stats = autoBattleStats.get(tag) || {}
  autoBattleUsers.delete(tag); autoBattleIntervals.delete(tag); autoBattleTimeouts.delete(tag); autoBattleStats.delete(tag)
  return `🛑 자동배틀 중지!\n📊 총 ${stats.battles || 0}회 대결 (${stats.wins || 0}승 ${stats.losses || 0}패)\n💰 획득 골드: ${(stats.goldEarned || 0).toLocaleString()}골드`
}
function handleAutoStatus(tag) {
  if (!autoBattleUsers.has(tag)) return '❌ 진행 중인 자동배틀이 없어요\n💡 !자동온 으로 시작할 수 있어요'
  const stats = autoBattleStats.get(tag) || {}
  return `🤖 자동배틀 진행 중\n📊 ${stats.battles || 0}회 대결 (${stats.wins || 0}승 ${stats.losses || 0}패)\n💰 획득 골드: ${(stats.goldEarned || 0).toLocaleString()}골드`
}

// ── 💱 거래소 — 자동쿠폰만 거래 가능, 개인당 최대 3개 등록 ──
function handleMarketList() {
  if (!marketListings.length) return '💱 거래소가 비어있어요\n!거래등록[수량] [가격] 으로 자동쿠폰을 등록해보세요 (개인당 최대 3개)'
  let msg = '💱 검키우기 거래소 (자동쿠폰 전용)\n\n'
  marketListings.forEach((l, i) => {
    msg += `${i + 1}. 자동쿠폰 x${l.qty} — ${l.price.toLocaleString()}골드 (판매자: ${l.sellerNick})\n`
  })
  msg += '\n!거래구매[번호]'
  return msg
}
function handleMarketRegister(tag, nickname, qtyRaw, priceRaw) {
  const qty = parseInt(qtyRaw, 10)
  const price = parseInt(priceRaw, 10)
  if (!qty || qty < 1 || !price || price <= 0) return '사용법: !거래등록[수량] [가격]\n예: !거래등록 2 1000'
  const existingQty = marketListings.filter(l => l.sellerTag === tag).reduce((s, l) => s + l.qty, 0)
  if (existingQty + qty > 3) return `❌ 개인당 자동쿠폰 최대 3개까지 등록할 수 있어요 (현재 등록: ${existingQty}개)`
  const user = getOrCreateUser(tag, nickname)
  const inv = user.inventory || {}
  const have = inv['자동쿠폰'] || 0
  if (have < qty) return `❌ 자동쿠폰이 부족해요 (보유: ${have}개)`
  inv['자동쿠폰'] = have - qty
  if (inv['자동쿠폰'] <= 0) delete inv['자동쿠폰']
  user.inventory = inv
  marketListings.push({ id: 'mkt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), sellerTag: tag, sellerNick: nickname, qty, price, createdAt: Date.now() })
  saveLocalData()
  return `✅ 자동쿠폰 x${qty}를 ${price.toLocaleString()}골드에 거래소에 등록했어요`
}
function handleMarketBuy(tag, nickname, idxRaw) {
  const idx = parseInt(idxRaw, 10)
  if (!idx || idx < 1) return '사용법: !거래구매[번호]'
  const listing = marketListings[idx - 1]
  if (!listing) return '❌ 없는 거래 번호예요'
  if (listing.sellerTag === tag) return '❌ 본인이 등록한 거래는 구매할 수 없어요'
  const buyer = getOrCreateUser(tag, nickname)
  if (buyer.gold < listing.price) return `💸 골드 부족 (필요: ${listing.price.toLocaleString()}골드)`
  buyer.gold -= listing.price
  if (!buyer.inventory) buyer.inventory = {}
  buyer.inventory['자동쿠폰'] = (buyer.inventory['자동쿠폰'] || 0) + listing.qty
  const seller = localUsers.get(listing.sellerTag)
  if (seller) seller.gold += listing.price
  marketListings.splice(idx - 1, 1)
  saveLocalData()
  return `✅ 자동쿠폰 x${listing.qty} 구매 완료! (-${listing.price.toLocaleString()}골드)`
}

// ── 👹 방보스 (도플갱어) — sum 전용 소환, 전체 공용 레이드 ──
const SWORD_BOSS_JOIN_COOLDOWN_MS = 3000
function handleBossSpawn(tag) {
  if (String(tag).toLowerCase() !== 'sum') return '❌ 관리자만 사용할 수 있는 명령어예요'
  if (currentBoss && currentBoss.hp > 0) return `⚠️ 이미 [${currentBoss.name}]이(가) 등장해있어요 (남은 HP: ${currentBoss.hp.toLocaleString()})`
  const cfg = (localSettings && localSettings.boss_config) || {}
  const maxHp = cfg.hp || 5000000
  currentBoss = { name: cfg.name || '도플갱어', hp: maxHp, maxHp, contributions: {}, spawnedAt: Date.now() }
  saveLocalData()
  return `👹 [${currentBoss.name}]이(가) 나타났습니다!\n❤️ HP: ${maxHp.toLocaleString()}\n!참여 로 공격하세요!`
}
function handleBossJoin(djId, tag, nickname) {
  if (!currentBoss || currentBoss.hp <= 0) return '❌ 지금 나타난 보스가 없어요'
  const last = bossCooldowns.get(tag) || 0
  if (Date.now() - last < SWORD_BOSS_JOIN_COOLDOWN_MS) return null // 너무 잦은 연타는 조용히 무시
  bossCooldowns.set(tag, Date.now())

  const user = getOrCreateUser(tag, nickname)
  const petAttack = calculatePetAttackBonus(user)
  const dmg = Math.max(1, Math.floor((user.attack_power || 1) + petAttack))
  currentBoss.hp = Math.max(0, currentBoss.hp - dmg)
  currentBoss.contributions[tag] = (currentBoss.contributions[tag] || 0) + dmg

  if (currentBoss.hp <= 0) {
    const cfg = (localSettings && localSettings.boss_config) || {}
    const rewardPool = cfg.gold_reward || 50000000
    const bossName = currentBoss.name
    const contribs = Object.entries(currentBoss.contributions).sort((a, b) => b[1] - a[1])
    const totalDmg = contribs.reduce((s, [, d]) => s + d, 0) || 1
    let msg = `🎉 [${bossName}] 처치! 기여도만큼 골드를 나눠 드렸어요.\n\n`
    contribs.forEach(([t, d], i) => {
      const share = Math.round(rewardPool * (d / totalDmg))
      const u = localUsers.get(t)
      if (u) u.gold += share
      if (i < 5) msg += `${i + 1}위 ${u ? u.nickname : t} — 피해 ${d.toLocaleString()} → +${share.toLocaleString()}골드\n`
    })
    currentBoss = null
    saveLocalData()
    return msg.trim()
  }

  saveLocalData()
  return `⚔️ [${currentBoss.name}]에게 ${dmg.toLocaleString()} 피해!\n❤️ 남은 HP: ${currentBoss.hp.toLocaleString()} / ${currentBoss.maxHp.toLocaleString()}`
}
function handleBossStatus() {
  // ⚠️ "!상태"는 낚시(fishing) 모듈도 자체적으로 쓰는 명령어라, 보스가 없을 때는
  // 조용히 무시해서(응답 없음) 두 모듈을 같이 켜둔 방송에서 메시지가 중복되지 않게 한다.
  if (!currentBoss || currentBoss.hp <= 0) return null
  const pct = Math.round((currentBoss.hp / currentBoss.maxHp) * 100)
  const participants = Object.keys(currentBoss.contributions).length
  return `👹 [${currentBoss.name}]\n❤️ HP: ${currentBoss.hp.toLocaleString()} / ${currentBoss.maxHp.toLocaleString()} (${pct}%)\n👥 참여자: ${participants}명`
}

// ── 🛠️ 관리자 지급 명령어 (sum 전용) ──
function handleGrantReward(tag, targetTagRaw, amountRaw) {
  if (String(tag).toLowerCase() !== 'sum') return '❌ 관리자만 사용할 수 있는 명령어예요'
  const amount = parseInt(amountRaw, 10)
  if (!targetTagRaw || !amount) return '사용법: !보상 [고유닉] [골드]'
  const cleanTag = String(targetTagRaw).replace('@', '').toLowerCase()
  const user = localUsers.get(cleanTag)
  if (!user) return `❌ [${cleanTag}] 유저 데이터를 찾을 수 없어요 (한 번이라도 게임을 해야 지급 가능해요)`
  user.gold += amount
  saveLocalData()
  return `✅ [${user.nickname}]님에게 ${amount.toLocaleString()}골드 지급 완료! (현재: ${user.gold.toLocaleString()}골드)`
}
function handleGrantCoupon(tag, targetTagRaw, qtyRaw) {
  // ⚠️ "!쿠폰"은 쿠폰확인 모듈 기본 명령어와 겹칠 수 있어서, 관리자가 아니면 조용히 무시한다(응답 없음).
  if (String(tag).toLowerCase() !== 'sum') return null
  const qty = Math.max(1, parseInt(qtyRaw, 10) || 1)
  if (!targetTagRaw) return '사용법: !쿠폰 [고유닉] [수량]'
  const cleanTag = String(targetTagRaw).replace('@', '').toLowerCase()
  const user = localUsers.get(cleanTag)
  if (!user) return `❌ [${cleanTag}] 유저 데이터를 찾을 수 없어요`
  if (!user.inventory) user.inventory = {}
  user.inventory['자동쿠폰'] = (user.inventory['자동쿠폰'] || 0) + qty
  saveLocalData()
  return `✅ [${user.nickname}]님에게 자동쿠폰 x${qty} 지급 완료! (보유: ${user.inventory['자동쿠폰']}개)`
}
// sum 전용 테스트 — 몬스터 상자 1개 즉시 오픈
function handleMonsterBoxTest(tag, nickname) {
  if (String(tag).toLowerCase() !== 'sum') return '❌ sum 전용 테스트 명령어예요'
  const user = getOrCreateUser(tag, nickname)
  const msg = openMonsterBoxes(user, 1)
  saveLocalData()
  return `🎁 몬스터 상자 테스트!\n\n${msg}\n\n💰 ${user.gold.toLocaleString()}골드`
}

// ── 🛠️ 추가 관리자 명령어 (sum 전용 / sum·sum1004 전용 / hs7234·sum1004 전용) ──

// !ALL — 지금 메모리에 있는 모든 유저 데이터를 한 번에 Base44에 저장한다 (서버 재시작 전 백업용)
async function handleSaveAllUsers(tag) {
  if (String(tag).toLowerCase() !== 'sum') return null
  const users = Array.from(localUsers.values())
  let saved = 0
  for (const u of users) {
    try { if (await saveUserToDB(u)) saved++ } catch (e) { /* 개별 실패는 무시하고 계속 진행 */ }
  }
  return `✅ 전체 유저 데이터 저장 완료! (${saved}/${users.length}명)`
}

// !유물리셋 — 고급 유물(화염/번개/빛/바람/얼음/대지/도플갱어)을 로컬 캐시에 있는 모든 유저에게서 제거
const SWORD_ADVANCED_RELIC_NAMES = ['화염', '번개', '빛', '바람', '얼음', '대지', '도플갱어']
function handleRemoveAdvancedRelics(tag) {
  if (String(tag).toLowerCase() !== 'sum') return null
  let affected = 0
  for (const u of localUsers.values()) {
    if (!u.relics) continue
    let touched = false
    for (const name of SWORD_ADVANCED_RELIC_NAMES) {
      if (u.relics[name]) { delete u.relics[name]; touched = true }
    }
    if (touched) affected++
  }
  saveLocalData()
  return `✅ 고급 유물 제거 완료! (영향받은 유저: ${affected}명)`
}

// !차단 [고유닉] [일수] [사유] — 로컬 차단 목록(Base44 원격 차단 목록과 별개, 이 서버 안에서만 적용됨)
function isLocallyBanned(tag) {
  const bans = (localSettings && localSettings.local_bans) || {}
  const entry = bans[tag]
  if (!entry) return false
  if (entry.until && Date.now() > entry.until) { delete bans[tag]; return false }
  return true
}
function handleLocalBan(tag, targetTagRaw, daysRaw, reasonParts) {
  if (!['sum', 'sum1004'].includes(String(tag).toLowerCase())) return null
  const days = Math.min(30, Math.max(1, parseInt(daysRaw, 10) || 1))
  if (!targetTagRaw) return '사용법: !차단 [고유닉] [일수(1~30)] [사유]'
  const cleanTag = String(targetTagRaw).replace('@', '').toLowerCase()
  if (!localSettings.local_bans) localSettings.local_bans = {}
  const until = Date.now() + days * 24 * 60 * 60 * 1000
  const reason = (reasonParts || []).join(' ') || '사유 미기재'
  localSettings.local_bans[cleanTag] = { until, reason, bannedBy: tag, bannedAt: Date.now() }
  persistSwordSettings()
  return `🚫 [${cleanTag}] ${days}일 차단 완료 (사유: ${reason})`
}

// !골드 [고유닉] [금액] — 골드 직접 조정 (음수 가능, hs7234·sum1004 전용)
function handleAdjustGold(tag, targetTagRaw, amountRaw) {
  if (!['hs7234', 'sum1004'].includes(String(tag).toLowerCase())) return null
  const amount = parseInt(amountRaw, 10)
  if (!targetTagRaw || !Number.isFinite(amount)) return '사용법: !골드 [고유닉] [금액] (음수 가능)'
  const cleanTag = String(targetTagRaw).replace('@', '').toLowerCase()
  const user = localUsers.get(cleanTag)
  if (!user) return `❌ [${cleanTag}] 유저 데이터를 찾을 수 없어요`
  user.gold = Math.max(0, user.gold + amount)
  saveLocalData()
  return `✅ [${user.nickname}] 골드 ${amount >= 0 ? '+' : ''}${amount.toLocaleString()} 조정 완료! (현재: ${user.gold.toLocaleString()}골드)`
}

function handleSwordHelp() {
  let msg = '⚔️ 검키우기 명령어\n\n';
  msg += '• ⚔️ !강화 - 검 강화 (성공/실패/하락/파괴)\n';
  msg += '• 📊 !프로필 [고유닉] - 검 정보 조회\n';
  msg += '• 📊 !아이템 - 상점아이템 상세 조회\n';
  msg += '• 📋 !패치 - 오늘 패치 내용 확인\n';
  msg += '• ⚔️ !배틀 - 자동 매칭 배틀\n';
  msg += '• ⚔️ !배틀 [고유닉] - 특정 유저와 배틀\n';
  msg += '• 🗡️ !던전 - 몬스터 던전 입장 (1~100층)\n';
  msg += '• 🏺 !유물 - 보유 유물 확인\n';
  msg += '• 💎 !룬 - 보유 룬 확인\n';
  msg += '• 🗺️ !탐험 - 룬 조각 획득 (30초 쿨타임)\n';
  msg += '• ✨ !룬제작 - 조각 100개로 룬 제작 (10%)\n';
  msg += '• 💰 !룬판매 [룬이름] - 룬 판매하기\n';
  msg += '• ⬆️ !룬강화 [룬이름] - 룬 레벨업\n';
  msg += '• 🏆 !검랭킹 - 강화/배틀 랭킹\n';
  msg += '• 🔍 !방검색 - 검키우기 사용 중인 디제이 목록\n';
  msg += '• 💰 !판매 - 검 판매하고 골드 획득\n';
  msg += '• 🎒 !창고 - 보유 아이템 확인\n';
  msg += '• 🔄 !옵션 - 옵션 재설정 물약 사용\n';
  msg += '• ✨ !부여 - 옵션 부여 부적 사용\n';
  msg += '• 🏪 !검상점 - 아이템 상점 보기\n';
  msg += '• 🛒 !검구매[번호] - 아이템 구매\n';
  msg += '• 📅 !출석 - 매일 골드 받기\n';
  msg += '• 💖 무료하트 클릭 - 골드 5000원 적립\n';
  msg += '• 🐾 !펫 - 보유 펫 목록 확인\n';
  msg += '• 🐾 !펫착용 [번호] - 펫 장착\n';
  msg += '• 🐾 !펫해제 - 펫 해제\n';
  msg += '• 🔨 !펫분해 [번호] - 펫 분해 (재료 획득)\n';
  msg += '• ⬆️ !펫강화 [번호] - 펫 능력치 강화 (재료 5개)\n';
  msg += '• 🤖 !자동온 [수량] - 자동 배틀 시작 (지정 수량만)\n';
  msg += '• 🛑 !자동오프 - 자동 배틀 중지\n';
  msg += '• 📊 !자동 - 자동 배틀 진행 상황 확인\n';
  msg += '• 🏪 !거래소 - 자동쿠폰 거래소 (전체 유저)\n';
  msg += '• 📝 !거래등록 [수량] [가격] - 거래 등록 (개인당 3개)\n';
  msg += '• 💰 !거래구매 [번호] - 거래소에서 구매\n';
  msg += '• 👹 !참여 - 도플갱어 보스 레이드 참가\n';
  msg += '• 👹 !상태 - 보스 상태 및 대미지 랭킹 확인\n\n';
  msg += '🎮 sum 전용 테스트:\n';
  msg += '• 🎁 !몬스터 - 몬스터 상자 1개 오픈 (테스트)\n\n';
  msg += '🎮 디제이 전용:\n';
  msg += '• 🟢 !검온 - 검키우기 시스템 활성화\n';
  msg += '• 🔴 !검오프 - 검키우기 시스템 비활성화\n';
  msg += '• 🔧 !복구 [고유닉] [+레벨] [일/단] [옵션1] [옵션2] [옵션3] - 검 복구\n';
  msg += '• 💾 !저장 - 현재 데이터를 DB에 저장\n';
  msg += '• 📥 !로드 - DB에서 데이터 불러오기 (20분 쿨타임)\n';
  msg += '• 🔄 !ALL - 모든 유저 데이터 DB 저장\n';
  msg += '• 🔄 !설정새로고침 - 상점/던전 설정 업데이트\n';
  msg += '• 📋 !질문 [내용] - 복구 요청 등록\n\n';
  msg += '👥 sum, sum1004 전용:\n';
  msg += '• 🚫 !차단 [고유닉] [일수] [사유] - 유저 차단 (1~30일)\n\n';
  msg += '👥 sum 전용:\n';
  msg += '• 🎁 !주기 [고유닉] [강화] [공격] - 장비 지급\n';
  msg += '• ⚔️ !단비검 [고유닉] [+강화] [공격] - 단비가 버린검 지급\n';
  msg += '• 🎁 !보상 [고유닉] [+강화] [옵션개수] [공격] - 옵션개수 지정 장비 지급\n';
  msg += '• ✨ !옵션 [고유닉] [개수] - 검 옵션 개수 조정\n';
  msg += '• 🎟️ !쿠폰 [고유닉] [수량] - 자동쿠폰 지급\n';
  msg += '• 👹 !보스 - 도플갱어 보스 강제 소환\n';
  msg += '• 🗑️ !유물리셋 - 로컬 모든 유저 고급 유물 제거\n';
  msg += '• 📥 !로드 [고유닉] - 특정 유저 데이터 로드\n\n';
  msg += '👥 hs7234, sum1004 전용:\n';
  msg += '• 💰 !골드 [고유닉] [금액] - 유저 골드 조정 (음수 가능)';
  return msg;
}

async function handleSaveData(tag, nickname) {
  const user = localUsers.get(tag);
  
  if (!user) {
    return '❌ 저장할 데이터가 없습니다. 먼저 !출석으로 시작하세요';
  }

  if (!API_TOKEN || API_TOKEN === 'YOUR_TOKEN_HERE') {
    return '❌ DB 저장 불가 (토큰 미설정)';
  }

  const success = await saveUserToDB(user);
  
  if (success) {
    return `✅ ${nickname}님의 데이터가 DB에 저장되었습니다!\n다른 방에서 !로드 명령어로 불러올 수 있습니다.`;
  } else {
    return '❌ DB 저장 실패';
  }
}

async function handleLoadData(tag, nickname, targetTag) {
  if (!API_TOKEN || API_TOKEN === 'YOUR_TOKEN_HERE') {
    return '❌ DB 로드 불가 (토큰 미설정)';
  }

  // sum이 아닌 유저는 20분 쿨타임 적용
  if (tag.toLowerCase() !== 'sum') {
    const loadCooldown = 1200 * 1000; // 20분
    const lastLoadTime = loadCooldowns.get(tag) || 0;
    const elapsed = Date.now() - lastLoadTime;

    if (elapsed < loadCooldown) {
      const remainingMinutes = Math.ceil((loadCooldown - elapsed) / 60000);
      return `⏰ 로드 쿨타임 ${remainingMinutes}분 남음`;
    }
  }

  // sum이 targetTag를 지정한 경우 해당 유저 로드
  const loadTag = (tag.toLowerCase() === 'sum' && targetTag) ? targetTag : tag;
  const dbUser = await loadUserFromDB(loadTag);

  if (!dbUser) {
    return `❌ DB에 저장된 데이터가 없습니다. 먼저 다른 방에서 !저장을 하세요`;
  }

  // DB 데이터를 로컬 메모리에 덮어쓰기 (고급 유물 제거 없이)
  localUsers.set(loadTag, {
    tag: dbUser.tag,
    nickname: dbUser.nickname,
    gold: dbUser.gold || 0,
    sword_level: dbUser.sword_level || 0,
    max_sword_level: dbUser.max_sword_level || 0,
    attack_power: dbUser.attack_power || 0,
    weapon_bonus: dbUser.weapon_bonus || 0,
    weapon_bonus2: dbUser.weapon_bonus2 || 0,
    weapon_bonus3: dbUser.weapon_bonus3 || 0,
    battle_wins: dbUser.battle_wins || 0,
    battle_losses: dbUser.battle_losses || 0,
    inventory: dbUser.inventory || {},
    special_weapon: dbUser.special_weapon || null,
    last_daily_money_date: dbUser.last_daily_money_date || null,
    current_dungeon_floor: dbUser.current_dungeon_floor || 1,
    relics: dbUser.relics || {},
    dungeon_tickets: dbUser.dungeon_tickets || 0,
    runes: dbUser.runes || {},
    rune_fragments: dbUser.rune_fragments || 0,
    last_explore_date: dbUser.last_explore_date || null,
    explore_count: dbUser.explore_count || 0,
    user_plan_level: dbUser.user_plan_level || 0,
    spoon_points: dbUser.spoon_points || 0,
    pets: dbUser.pets || [],
    equipped_pet_id: dbUser.equipped_pet_id || null,
    pet_fragments: dbUser.pet_fragments || 0
    });

  // sum이 아닌 경우만 쿨타임 기록
  if (tag.toLowerCase() !== 'sum') {
    loadCooldowns.set(tag, Date.now());
  }

  const weaponNames = localSettings?.weapon_names || [];
  const getWeaponName = (level, specialWeapon) => {
    if (specialWeapon && specialWeapon.name) {
      return specialWeapon.name;
    }
    const weapon = weaponNames.find(w => w.level === level);
    return weapon ? weapon.name : '검';
  };

  const weaponName = getWeaponName(dbUser.sword_level, dbUser.special_weapon);
  const loadedUser = localUsers.get(loadTag);
  const relicAttack = calculateRelicAttack(loadedUser);
  const totalAttack = (dbUser.attack_power || 0) + (dbUser.weapon_bonus || 0) + (dbUser.weapon_bonus2 || 0) + (dbUser.weapon_bonus3 || 0) + relicAttack;

  const displayName = (tag.toLowerCase() === 'sum' && targetTag) ? dbUser.nickname : nickname;
  return `✅ ${displayName}님의 데이터가 DB에서 로드되었습니다!\n⚔️ 보유 검: [+${dbUser.sword_level}] ${weaponName}\n⚡ 총 공격력: ${totalAttack.toFixed(1)}\n💰 보유 골드: ${(dbUser.gold || 0).toLocaleString()}골드\n🗡️ 던전 진행: ${dbUser.current_dungeon_floor || 1}층`;
}
// ── 설정 로드/저장: 관리자(sum) 계정 아래 공용으로 보관 ──
// 원본은 매 액션마다 로컬 암호화 파일에 저장했는데, Railway는 재배포마다 디스크가 초기화되니
// 그 대신 우리 서버의 영구 저장소(store, Volume 있으면 거기에 남음)에 저장한다.
let swordSaveDebounceTimer = null
function saveLocalData() {
  if (swordSaveDebounceTimer) clearTimeout(swordSaveDebounceTimer)
  swordSaveDebounceTimer = setTimeout(() => {
    try {
      store.saveSettings(SHARED_TOKEN_DJID, {
        swordGameUsers: Object.fromEntries(localUsers),
        swordGameMarket: marketListings,
        swordGameBoss: currentBoss
      })
    } catch (e) { console.log('[검키우기] 유저 캐시 저장 실패', e.message) }
  }, 2000)
}
let swordUsersLoaded = false
function loadSwordUsersIfNeeded() {
  if (swordUsersLoaded) return
  swordUsersLoaded = true
  try {
    const adminSettings = store.getSettings(SHARED_TOKEN_DJID) || {}
    if (adminSettings.swordGameUsers) {
      localUsers = new Map(Object.entries(adminSettings.swordGameUsers))
      console.log('[검키우기] 캐시에서 유저 데이터 복원:', localUsers.size, '명')
    }
    if (Array.isArray(adminSettings.swordGameMarket)) marketListings = adminSettings.swordGameMarket
    if (adminSettings.swordGameBoss && adminSettings.swordGameBoss.hp > 0) currentBoss = adminSettings.swordGameBoss
  } catch (e) { console.log('[검키우기] 유저 캐시 로드 실패', e.message) }
}
function ensureSwordSettingsLoaded() {
  loadSwordUsersIfNeeded()
  if (localSettings) return
  const adminSettings = store.getSettings(SHARED_TOKEN_DJID) || {}
  if (adminSettings.swordGame) {
    localSettings = adminSettings.swordGame
  } else {
    initializeSettings() // 이 함수가 내부적으로 localSettings에 기본값을 채워준다 (원본 그대로)
    persistSwordSettings()
  }
}
function persistSwordSettings() {
  store.saveSettings(SHARED_TOKEN_DJID, { swordGame: localSettings })
}

// ── 채팅 명령어 디스패처 (1차 이식 범위) ──
// 좋아요(하트) 훅 — 원본의 exports.live_like 로직을 그대로 이식.
// 골드 보상 + "+27일 때 하트 20번 클릭 시 자동 강화 이벤트" 특수 효과 포함.
function handleSwordHeartHook(djId, settings, tag, nickname) {
  if (!isModuleOn(settings, 'swordgame', djId)) return
  if (!tag) return
  ensureSwordSettingsLoaded()
  if (!localSettings || localSettings.enabled === false) return
  const user = getOrCreateUser(tag, nickname)
  user.gold += localSettings?.like_reward || 5000

  if (user.sword_level === 27) {
    user.heart_clicks_after_plus_28 = (user.heart_clicks_after_plus_28 || 0) + 1
    if (user.heart_clicks_after_plus_28 >= 20) {
      const enhanceResult = handleEnhance(tag, nickname)
      user.heart_clicks_after_plus_28 = 0
      setTimeout(() => sendChatToRoom(djId, `🎉 +28 특별 이벤트 발동! 하트 20번 클릭 달성!\n${enhanceResult}`), 500)
    }
  }
  saveLocalData()
}

async function handleSwordCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  if (!isModuleOn(settings, 'swordgame', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const textLower = msg.toLowerCase()
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId

  // 검온/검오프 — DJ 전용
  if (msg === '!검온' || msg === '!검오프') {
    if (!isDj) { sendChatSplit(djId, '❌ 이 명령어는 디제이만 사용할 수 있습니다', 150, 300); return }
    ensureSwordSettingsLoaded()
    const enable = msg === '!검온'
    localSettings.enabled = enable
    persistSwordSettings()
    sendChatSplit(djId, enable ? '✅ 검키우기 활성화' : '❌ 검키우기 비활성화', 150, 300)
    return
  }

  const PHASE1_CMDS = ['!강화', '!던전', '!유물', '!룬', '!탐험', '!룬제작', '!룬판매', '!룬강화',
    '!검랭킹', '!프로필', '!배틀', '!판매', '!창고', '!출석', '!도움말', '!저장', '!로드', '!검버전',
    '!검상점', '!검구매', '!펫', '!자동온', '!자동오프', '!자동', '!거래소', '!거래등록', '!거래구매',
    '!참여', '!상태', '!보스', '!몬스터', '!쿠폰', '!보상', '!ALL', '!차단', '!골드']
  const isSwordCommand = PHASE1_CMDS.some(c => textLower === c || textLower.startsWith(c))
  if (!isSwordCommand) return

  ensureSwordSettingsLoaded()
  if (localSettings && localSettings.enabled === false) {
    sendChatSplit(djId, '❌ 시스템 비활성화', 150, 300)
    return
  }

  const tag = actTag ? String(actTag).trim().toLowerCase() : null
  if (!tag) { sendChatSplit(djId, '⚠️ 고유닉을 확인하지 못했어요. 잠시 후 다시 시도해주세요.', 150, 300); return }

  // 차단 유저 체크 (원본 로직 그대로, Base44 API 사용 + 이 서버 안에서만 적용되는 로컬 차단)
  try {
    const isBanned = await checkBannedUser(tag)
    if (isBanned) { sendChatSplit(djId, '❌ 차단된 등록자입니다', 150, 300); return }
  } catch (e) { /* 차단 체크 실패해도 게임은 계속 진행 */ }
  if (isLocallyBanned(tag)) { sendChatSplit(djId, '❌ 차단된 등록자입니다', 150, 300); return }

  let result = null
  try {
    const parts = msg.split(/\s+/)
    if (textLower === '!강화') {
      result = handleEnhance(tag, author)
    } else if (textLower === '!던전') {
      result = handleDungeon(tag, author)
    } else if (textLower === '!유물') {
      result = handleRelics(tag, author)
    } else if (textLower === '!룬') {
      result = handleRunes(tag, author)
    } else if (textLower === '!탐험') {
      result = handleExplore(tag, author)
    } else if (textLower === '!룬제작') {
      result = handleCraftRune(tag, author)
    } else if (textLower.startsWith('!룬판매')) {
      const runeName = parts.slice(1).join(' ')
      result = handleSellRune(tag, author, runeName)
    } else if (textLower.startsWith('!룬강화')) {
      const runeName = parts.slice(1).join(' ') || ''
      result = handleUpgradeRune(tag, author, runeName)
    } else if (textLower === '!검랭킹') {
      result = await handleRanking(tag, author)
    } else if (textLower.startsWith('!프로필')) {
      const targetTag = (parts[1] || '').trim()
      result = handleSwordInfo(tag, author, targetTag)
    } else if (textLower.startsWith('!배틀')) {
      const targetTag = parts[1] || ''
      result = handleBattle(tag, author, targetTag)
    } else if (textLower === '!판매') {
      result = handleSell(tag, author)
    } else if (textLower === '!창고') {
      result = handleInventory(tag, author)
    } else if (textLower === '!출석') {
      result = handleDailyMoney(tag, author)
    } else if (textLower === '!도움말') {
      result = handleSwordHelp()
    } else if (textLower === '!저장') {
      result = await handleSaveData(tag, author)
    } else if (textLower.startsWith('!로드')) {
      const targetTag = (parts[1] || '').trim()
      result = await handleLoadData(tag, author, targetTag)
    } else if (msg === '!검버전') {
      const userCount = localUsers.size
      result = '검키우기 봇: 이식판(1차) ⚔️\n접속 유저: ' + userCount + '명\n강화 쿨타임: ' + (localSettings?.enhance_cooldown || 3) + '초\n배틀 쿨타임: ' + (localSettings?.battle_cooldown || 20) + '초'
    } else if (textLower.startsWith('!검상점')) {
      result = handleShop()
    } else if (textLower.startsWith('!검구매')) {
      const attached = textLower.match(/^!검구매(\d+)/)
      const idx = attached ? attached[1] : parts[1]
      const qty = attached ? parts[1] : parts[2]
      result = handlePurchase(tag, author, idx, qty)
    } else if (textLower.startsWith('!펫착용')) {
      const attached = textLower.match(/^!펫착용(\d+)/)
      result = handleEquipPet(tag, author, attached ? attached[1] : parts[1])
    } else if (textLower === '!펫해제') {
      result = handleUnequipPet(tag, author)
    } else if (textLower.startsWith('!펫분해')) {
      const attached = textLower.match(/^!펫분해(\d+)/)
      result = handleDisassemblePet(tag, author, attached ? attached[1] : parts[1])
    } else if (textLower.startsWith('!펫강화')) {
      const attached = textLower.match(/^!펫강화(\d+)/)
      result = handleEnhancePet(tag, author, attached ? attached[1] : parts[1])
    } else if (textLower === '!펫') {
      result = handleMyPets(tag, author)
    } else if (textLower.startsWith('!자동온')) {
      const attached = textLower.match(/^!자동온(\d+)/)
      result = handleAutoOn(djId, tag, author, attached ? attached[1] : parts[1])
    } else if (textLower === '!자동오프') {
      result = handleAutoOff(tag)
    } else if (textLower === '!자동') {
      result = handleAutoStatus(tag)
    } else if (textLower === '!거래소') {
      result = handleMarketList()
    } else if (textLower.startsWith('!거래등록')) {
      result = handleMarketRegister(tag, author, parts[1], parts[2])
    } else if (textLower.startsWith('!거래구매')) {
      const attached = textLower.match(/^!거래구매(\d+)/)
      result = handleMarketBuy(tag, author, attached ? attached[1] : parts[1])
    } else if (textLower === '!참여') {
      result = handleBossJoin(djId, tag, author)
    } else if (textLower === '!상태') {
      result = handleBossStatus()
    } else if (textLower === '!보스') {
      result = handleBossSpawn(tag)
    } else if (textLower === '!몬스터') {
      result = handleMonsterBoxTest(tag, author)
    } else if (textLower.startsWith('!쿠폰')) {
      result = handleGrantCoupon(tag, parts[1], parts[2])
    } else if (textLower.startsWith('!보상')) {
      result = handleGrantReward(tag, parts[1], parts[2])
    } else if (msg === '!ALL') {
      result = await handleSaveAllUsers(tag)
    } else if (textLower.startsWith('!유물리셋')) {
      result = handleRemoveAdvancedRelics(tag)
    } else if (textLower.startsWith('!차단')) {
      result = handleLocalBan(tag, parts[1], parts[2], parts.slice(3))
    } else if (textLower.startsWith('!골드')) {
      result = handleAdjustGold(tag, parts[1], parts[2])
    }
  } catch (e) {
    console.log(`[검키우기:${djId}] 처리 중 오류`, e.message)
    result = '❌ 처리 중 오류가 발생했어요'
  }

  if (result) {
    sendChatSplit(djId, result, 150, 300)
  }
}


// ══════════════════════════════════════════════════════
// 🤝 팔로우 자동승인 — 시청자가 "!팔로우신청"을 치면 고유 인증번호를 발급하고,
// 그 번호를 관리자(sum) 계정의 스푼 팬보드에 글로 남기면, 서버가 주기적으로 그 팬보드를
// 확인해서 일치하는 번호를 찾으면 그 글쓴이를 자동으로 맞팔로우한다.
// ※ 팬보드 조회/팔로우 실행 둘 다 "관리자(sum) 계정" 기준으로 항상 동작한다
//    (어느 DJ의 채팅에서 신청했든 관계없이, 팔로우는 항상 관리자 계정이 하는 것이기 때문)

function getAutoFollowSettings() {
  const settings = store.getSettings(SHARED_TOKEN_DJID) || {}
  if (!settings.autoFollow) {
    settings.autoFollow = {
      channelId: '',       // 관리자 계정의 채널 ID (URL의 /kr/channel/{여기}/... 부분)
      codeLength: 8,
      expireMinutes: 60,
      pollIntervalSec: 60,
      pending: {},          // { code: { nickname, tag, djId, issuedAt, expiresAt } }
      history: [],          // 최근 처리 완료 기록 (최대 100개)
      lastPolledAt: 0,
    }
    store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: settings.autoFollow })
  }
  if (!settings.autoFollow.pending) settings.autoFollow.pending = {}
  if (!settings.autoFollow.history) settings.autoFollow.history = []
  return settings.autoFollow
}

function generateFollowCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 헷갈리기 쉬운 0/O/1/I 제외
  let code = ''
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

// "!팔로우신청" — 어느 DJ의 채팅에서든 사용 가능(그 DJ가 이 모듈을 켜뒀다면). 인증번호를 발급해서 안내한다.
async function handleAutoFollowCommand(djId, settings, author, actTag, text) {
  if (!isModuleOn(settings, 'autofollow', djId)) return
  const cfg = getAutoFollowSettings()
  const cmd = cfg.cmd || '!팔로우신청'
  if (String(text || '').trim() !== cmd) return

  if (!cfg.channelId) {
    setTimeout(() => sendChatToRoom(djId, '⚠️ 팔로우 자동승인이 아직 설정되지 않았어요. (관리자에게 문의)'), 400)
    return
  }

  // 이미 대기 중인 번호가 있으면 새로 안 만들고 그걸 다시 안내한다 (번호 남발 방지)
  const existing = Object.entries(cfg.pending).find(([, v]) => v.djId === djId && String(v.nickname || '').trim().toLowerCase() === String(author || '').trim().toLowerCase())
  let code
  if (existing) {
    code = existing[0]
  } else {
    code = generateFollowCode(Number(cfg.codeLength) || 8)
    cfg.pending[code] = {
      nickname: author,
      tag: actTag || '',
      djId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + Math.max(1, Number(cfg.expireMinutes) || 60) * 60000,
    }
    store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
  }
  setTimeout(() => sendChatToRoom(djId, `🤝 ${author}님, 인증번호 [${code}]를 관리자(sum) 스푼 팬보드에 글로 남겨주세요! 확인되면 자동으로 맞팔로우돼요. (${Number(cfg.expireMinutes) || 60}분 이내)`), 400)
}

// 관리자 팬보드를 조회해서 대기 중인 인증번호와 일치하는 글을 찾으면 팔로우를 실행한다.
async function pollAutoFollowBoard() {
  try {
    const cfg = getAutoFollowSettings()
    if (!cfg.channelId) return
    const pendingCodes = Object.keys(cfg.pending)
    if (!pendingCodes.length) return // 대기 중인 신청이 없으면 굳이 조회 안 함

    // 만료된 신청은 조용히 정리
    const now = Date.now()
    let changed = false
    pendingCodes.forEach(code => {
      if (cfg.pending[code].expiresAt < now) { delete cfg.pending[code]; changed = true }
    })
    const stillPending = Object.keys(cfg.pending)
    if (!stillPending.length) {
      if (changed) store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
      return
    }

    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    if (!accessToken) return

    const res = await fetch(`https://kr-gw.spooncast.net/feed/${cfg.channelId}/FAN?contentType=POST&excludeContentType=TALK&isNext=false`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': CHROME_UA, 'Origin': 'https://www.spooncast.net' },
    })
    const json = await res.json()
    const posts = json.results || []

    for (const post of posts) {
      const cd = post.contentData || {}
      const contents = String(cd.contents || '').trim().toUpperCase()
      const authorId = cd.authorId != null ? Number(cd.authorId) : null
      if (!contents || authorId == null) continue

      // 글 내용 안에 대기 중인 인증번호가 포함돼있으면 매칭 (정확히 일치가 아니어도 인사말과 같이 남길 수 있으니 포함 여부로 체크)
      const matchedCode = stillPending.find(code => contents.includes(code))
      if (!matchedCode) continue
      const req = cfg.pending[matchedCode]
      if (!req) continue

      // ✅ 팔로우 실행
      try {
        const followRes = await fetch(`https://kr-api.spooncast.net/users/${authorId}/follow/`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': CHROME_UA, 'Origin': 'https://www.spooncast.net' },
        })
        if (followRes.ok) {
          console.log(`[팔로우자동] ✅ ${req.nickname}(authorId:${authorId}) 팔로우 완료 (코드:${matchedCode})`)
          // 매칭된 신청은 대기 목록에서 조용히 제거(=자동 숨김) 하고 처리기록으로 옮긴다
          delete cfg.pending[matchedCode]
          cfg.history.unshift({ nickname: req.nickname, tag: req.tag, djId: req.djId, code: matchedCode, followedAt: Date.now() })
          if (cfg.history.length > 100) cfg.history.length = 100
          store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
          const room = getRoom(req.djId)
          if (room && room.isConnected) {
            setTimeout(() => sendChatToRoom(req.djId, `🤝 ${req.nickname}님 팔로우 인증 완료! 맞팔로우했어요 💙`), 300)
          }
        } else {
          console.log(`[팔로우자동] ❌ 팔로우 API 실패 (authorId:${authorId}) status:${followRes.status}`)
        }
      } catch (e) {
        console.log('[팔로우자동] 팔로우 요청 오류:', e.message)
      }
      // 스푼 서버에 짧은 시간에 연속 요청 안 보내도록 살짝 텀을 둔다
      await new Promise(r => setTimeout(r, 2500))
    }
  } catch (e) {
    console.log('[팔로우자동] 폴링 오류:', e.message)
  }
}

// 서버 시작 시 한 번만 등록되는 폴링 타이머 (매 60초, 설정값 반영은 다음 틱부터)
let autoFollowPollTimer = null
function ensureAutoFollowPolling() {
  if (autoFollowPollTimer) return
  autoFollowPollTimer = setInterval(() => {
    pollAutoFollowBoard().catch(() => {})
  }, 60000)
}
ensureAutoFollowPolling()

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
// 룰렛 항목 이름에 "실드 +10" / "실드 -20" 또는 "복권 10장" 같은 패턴이 들어있으면,
// 당첨 시 자동으로 실드(방송 전체 공용)/복권(당첨자 개인)을 적립·차감해준다.
// 킵/이벤트/기타 목록 기록은 항목별 설정(skipHistory 등) 그대로 별개로 계속 남는다.
function applySpecialRouletteItem(djId, settings, authorTag, author, itemName) {
  const name = String(itemName || '').trim()

  const shieldM = name.match(/실드\s*([+-]?\d+)/)
  if (shieldM) {
    const delta = parseInt(shieldM[1], 10)
    if (delta && settings.shield) {
      settings.shield.count = (settings.shield.count || 0) + delta
      store.saveSettings(djId, { shield: settings.shield })
      broadcast({ type: 'shield', djId, count: settings.shield.count })
      setTimeout(() => sendChatToRoom(djId, `🛡️ [룰렛 당첨] 실드 ${delta > 0 ? '+' : ''}${delta}개 ${delta > 0 ? '적립' : '차감'}! (현재: ${settings.shield.count}개)`), 700)
    }
    return
  }

  const lottoM = name.match(/복권\s*(\d+)\s*장?/)
  if (lottoM) {
    const amount = parseInt(lottoM[1], 10)
    if (amount > 0) {
      const act = getActivitySettings(djId, settings)
      const key = actResolveKey(act, author, authorTag) || authorTag || author
      const d = actEnsureUser(act, key, author, authorTag)
      d.lotto = (d.lotto || 0) + amount
      store.saveSettings(djId, { activity: act })
      setTimeout(() => sendChatToRoom(djId, `🎟️ [룰렛 당첨] ${author}님 복권 ${amount}장 적립! (현재 보유: ${d.lotto}장)`), 700)
    }
  }
}

const SECTION_LABEL = { '킵목록': '킵', '이벤트목록': '이벤트', '기타목록': '내카드' }

// 룰렛 항목마다 지정한 저장 목록(킵/기타/이벤트)에 맞춰 당첨 기록을 누적한다.
// saveTo가 없으면(예전 데이터) 기존과 동일하게 킵목록에 저장한다.
function addRouletteWinToList(hist, saveTo, name) {
  const listKey = saveTo === 'event' ? 'eventList' : saveTo === 'misc' ? 'miscList' : 'keepList'
  hist[listKey][name] = (hist[listKey][name] || 0) + 1
}

function getHistoryRec(settings, tag) {
  if (!settings.rouletteHistory) settings.rouletteHistory = {}
  if (!settings.rouletteHistory[tag]) settings.rouletteHistory[tag] = { coupons: {}, wins: [], keepList: {}, miscList: {}, eventList: {} }
  const rec = settings.rouletteHistory[tag]
  if (!rec.keepList) rec.keepList = {}
  if (!rec.miscList) rec.miscList = {}
  if (!rec.eventList) rec.eventList = {}
  return rec
}

// 룰렛 기록은 이제 고유닉(tag) 기준으로 저장한다 — 닉네임은 자주 바뀌지만 고유닉은 안 바뀌기 때문.
// (예전엔 태그 조회 API가 불안정해서 닉네임 고정으로 저장했었는데, getCachedUserTag가
//  응답 id 검증 + 캐싱까지 해줘서 이제 훨씬 신뢰할 수 있어 다시 태그 기준으로 되돌린다)
// tag를 정말 못 구하는 경우(예: lurker 모드)에만 어쩔 수 없이 닉네임을 임시 키로 쓴다.
// 처음으로 tag가 확인된 사람은, 예전에 닉네임 키로 저장돼있던 기록을 자동으로 tag 키로 옮겨준다(1회성 마이그레이션).
// 이후로도 닉네임이 바뀌면 기록 안의 nickname 필드가 자동으로 최신 값으로 갱신된다.
function getHistoryRecByIdentity(settings, tag, nickname) {
  if (!settings.rouletteHistory) settings.rouletteHistory = {}
  const cleanTag = tag ? String(tag).trim() : ''
  const key = cleanTag || nickname
  if (!key) return getHistoryRec(settings, 'unknown')

  if (cleanTag && !settings.rouletteHistory[cleanTag] && nickname && settings.rouletteHistory[nickname]) {
    settings.rouletteHistory[cleanTag] = settings.rouletteHistory[nickname]
    delete settings.rouletteHistory[nickname]
    console.log(`[룰렛기록 마이그레이션] 닉네임 "${nickname}" 기록 → 고유닉 "${cleanTag}" 로 이전`)
  }

  const rec = getHistoryRec(settings, key)
  if (nickname && rec.nickname !== nickname) rec.nickname = nickname // 닉네임 변경 자동 반영
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

// ══════════════════════════════════════════════════════
// 🎁 랜덤박스 — 디제이가 지정한 스티커 또는 지정 스푼을 받으면, 등록해둔 내용물 중 하나를
// 랜덤으로 뽑아서 결과를 채팅에 알려준다. 룰렛과 트리거 매칭 방식(스티커/금액)은 동일하게 재사용한다.

function getRandomBoxSettings(djId, settings) {
  if (!settings.randomBox) {
    settings.randomBox = { list: [] }
    store.saveSettings(djId, { randomBox: settings.randomBox })
  }
  if (!Array.isArray(settings.randomBox.list)) settings.randomBox.list = []
  return settings.randomBox
}

async function handleRandomBoxTrigger(djId, room, settings, author, authorId, liveId, amount, comboCount, sticker = '') {
  if (!isModuleOn(settings, 'randombox', djId)) return
  const rb = getRandomBoxSettings(djId, settings)
  if (!rb.list.length) return
  const applicable = rb.list
    .map((box, i) => {
      const count = box.triggerMode === 'sticker'
        ? checkStickerTrigger(box.triggerSticker, sticker, comboCount, box.triggerStickerPayout, box.triggerStickerCount)
        : calcAutoGrantCount(box.triggerMode, box.triggerAmount, amount, comboCount)
      return { box, idx: i, count }
    })
    .filter(x => x.count > 0 && x.box.items && x.box.items.length > 0)
  if (!applicable.length) return

  for (const { box, count } of applicable) {
    const results = []
    for (let i = 0; i < count; i++) {
      const won = percentPick(box.items)
      if (won) results.push(won.name)
    }
    if (!results.length) continue
    const template = box.resultTemplate || '🎁 [{박스명}] {닉네임}님의 결과 👉 {결과}'
    const resultText = results.length > 1
      ? Object.entries(results.reduce((m, n) => { m[n] = (m[n] || 0) + 1; return m }, {})).map(([n, c]) => c > 1 ? `${n}(${c})` : n).join(', ')
      : results[0]
    const text = template.replace(/{박스명}/g, box.name).replace(/{닉네임}/g, author).replace(/{결과}/g, resultText)
    setTimeout(() => sendChatToRoom(djId, text), 400)
  }
}


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
    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    const authorTag = await getCachedUserTag(room, liveId, authorId, accessToken)
    if (authorTag) rememberTagNickname(room, authorTag, author)
    const rec = getHistoryRecByIdentity(settings, authorTag, author)
    const entries = Object.entries(rec[SECTION_FIELD[section]] || {})
    sendChatSplit(djId, formatKeepMessage(author, section, entries, page), 150, 600)
    return
  }

  const checkMatch = first.match(/^(!킵확인|!이벤트확인|!내카드확인)(\d*)$/)
  if (checkMatch) {
    const section = { '!킵확인': '킵목록', '!이벤트확인': '이벤트목록', '!내카드확인': '기타목록' }[checkMatch[1]]
    const page = parseInt(checkMatch[2]) || 1
    const targetInput = (parts[1] || '').replace('@', '').trim()
    if (!targetInput) {
      setTimeout(() => sendChatToRoom(djId, `📋 사용법: ${checkMatch[1]} [고유닉]\n예) ${checkMatch[1]} sum`), 400)
      return
    }
    // 지금 방에 있으면 정확한 태그+닉네임으로 확정, 없으면 입력값을 그대로 태그로 간주해서 조회
    const found = await findLiveMemberByNickOrTag(liveId, targetInput)
    const targetTag = found ? found.tag : targetInput
    const displayName = found ? (found.nickname || found.tag) : targetInput
    const rec = getHistoryRecByIdentity(settings, targetTag, found ? displayName : null)
    const entries = Object.entries(rec[SECTION_FIELD[section]] || {})
    sendChatSplit(djId, formatKeepMessage(displayName, section, entries, page), 150, 600)
    return
  }

  if (first === '!킵추가') {
    if (!isDj) { setTimeout(() => sendChatToRoom(djId, '⛔ !킵추가 명령어는 DJ만 사용할 수 있습니다.'), 400); return }
    if (parts.length < 3) { setTimeout(() => sendChatToRoom(djId, '📋 사용법: !킵추가 [고유닉] [내용]\n예) !킵추가 sum 리방하기'), 400); return }
    const targetInput = parts[1].replace('@', '').trim()
    const content = parts.slice(2).join(' ').trim()
    if (!targetInput || !content) return
    const found = await findLiveMemberByNickOrTag(liveId, targetInput)
    const targetTag = found ? found.tag : targetInput
    const displayName = found ? (found.nickname || found.tag) : targetInput
    const rec = getHistoryRecByIdentity(settings, targetTag, found ? displayName : null)
    rec.keepList[content] = (rec.keepList[content] || 0) + 1
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag: targetTag })
    const newCount = rec.keepList[content]
    setTimeout(() => sendChatToRoom(djId, `✅ [${displayName}] 님의 킵목록에 [${content}]${newCount > 1 ? ` (총 ${newCount}개)` : ''} 추가 완료!`), 400)
    return
  }

  const useMatch = first.match(/^(!킵사용|!이벤트사용|!내카드사용)$/)
  if (useMatch) {
    const section = { '!킵사용': '킵목록', '!이벤트사용': '이벤트목록', '!내카드사용': '기타목록' }[useMatch[1]]
    const idx = parseInt(parts[1])
    const count = parseInt(parts[2]) || 1
    if (!idx || idx <= 0) { setTimeout(() => sendChatToRoom(djId, `📋 사용법: ${useMatch[1]} [번호] [수량]\n(예: ${useMatch[1]} 1 1)`), 400); return }
    const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
    const authorTag = await getCachedUserTag(room, liveId, authorId, accessToken)
    if (authorTag) rememberTagNickname(room, authorTag, author)
    const rec = getHistoryRecByIdentity(settings, authorTag, author)
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
    broadcast({ type: 'roulette', djId, tag: authorTag || author })
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

  // ⚠️ 고유닉을 잘못 입력해도 조용히 지급되던 버그 수정: 지금 방송에 실제로 있는 사람인지 먼저 확인한다.
  const found = await findLiveMemberByNickOrTag(liveId, targetInput)
  if (!found) {
    setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetInput}' 님을 지금 방송에서 찾을 수 없어요. 고유닉을 다시 확인해주세요.`), 400)
    return
  }
  const targetTag = found.tag || null
  const targetName = found.nickname || found.tag
  if (found.tag) rememberTagNickname(room, found.tag, targetName)

  const rec = getHistoryRecByIdentity(settings, targetTag, targetName)
  rec.coupons[idx] = Number(rec.coupons[idx] || 0) + count
  store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
  broadcast({ type: 'roulette', djId, tag: targetTag || targetName })
  setTimeout(() => sendChatToRoom(djId, `🎡 ${targetName}님에게 룰렛권${idx} ${count}장 지급했습니다! (보유: ${rec.coupons[idx]}장)`), 400)
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
  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const authorTag = await getCachedUserTag(room, liveId, authorId, accessToken)
  if (authorTag) rememberTagNickname(room, authorTag, author)
  const histKey = authorTag || author
  const hist = getHistoryRecByIdentity(settings, authorTag, author)
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
      addRouletteWinToList(hist, won.saveTo, won.name)
    }
    applySpecialRouletteItem(djId, settings, authorTag, author, won.name)
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

  // ⚠️ 스푼 태그(고유닉) 조회 API가 가끔 결과가 오락가락했었는데, getCachedUserTag가 응답 id
  // 검증 + 캐싱까지 해줘서 이제 신뢰할 수 있다. 닉네임이 바뀌어도 항상 같은 사람으로 인식되도록 태그를 우선 사용한다.
  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const authorTag = await getCachedUserTag(room, liveId, authorId, accessToken)
  if (authorTag) rememberTagNickname(room, authorTag, author)
  const histKey = authorTag || author
  console.log(`[룰렛디버그:${djId}] histKey(태그 우선)=${histKey}`)
  const hist = getHistoryRecByIdentity(settings, authorTag, author)
  let changed = false

  for (const { rt, idx, count } of applicable) {
    const wonCounts = {}
    for (let i = 0; i < count; i++) {
      const won = percentPick(rt.items)
      if (!won) continue
      wonCounts[won.name] = (wonCounts[won.name] || 0) + 1
      if (!won.skipHistory) {
        hist.wins.push({ idx, rouletteName: rt.name, itemName: won.name, ts: Date.now() })
        addRouletteWinToList(hist, won.saveTo, won.name)
        changed = true
      }
      applySpecialRouletteItem(djId, settings, authorTag, author, won.name)
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

// 입장설정(entryData)의 입장/좋아요/퇴장 메시지 중, 대상 지정된 게 있으면 그걸 우선하고
// 없으면 첫 번째 활성 메시지를 돌려준다. 이 메시지에 음원(soundData)이 붙어있으면 재생 신호를 보낸다.
function pickEntryMessage(entryData, type, author, tag) {
  const list = (entryData && entryData[type]) || []
  const enabled = list.filter(m => m.enabled !== false)
  if (!enabled.length) return null
  const norm = s => String(s || '').trim().replace(/^@/, '').toLowerCase()
  const a = norm(author), t = norm(tag)
  const targeted = enabled.find(m => {
    const target = norm(m.target)
    return !!target && (target === a || (!!t && target === t))
  })
  return targeted || enabled[0]
}

function sendLeaveMessage(djId, settings, nickname, tag) {
  broadcast({ type: 'leave', djId, nick: nickname })
  if (settings.botEnabled === false) return
  if (!isModuleOn(settings, 'entrysettings', djId)) return
  const msgs = (settings.leaveMessages || []).filter(m => m.enabled)
  if (msgs.length > 0) {
    // 퇴장 감지 스냅샷에 이미 확인된 태그가 있으면 그걸 쓰고, 없으면 닉네임으로 대체 (빈 값으로 나가지 않도록)
    const text = msgs[0].text.replace(/{nickname}/g, nickname).replace(/{tag}/g, tag ? `@${tag}` : `@${nickname}`)
    setTimeout(() => sendChatToRoom(djId, text), 500)
  }
  const em = pickEntryMessage(settings.entryData, 'leave', nickname, tag || null)
  if (em && em.soundData) broadcast({ type: 'entrysound', djId, category: 'leave', id: em.id })
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
        sendLeaveMessage(djId, settings, info.nickname, info.tag)
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
  stopStockTimers(djId)
  clearReminderTimers(room)
  clearTtsAccess(room)
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
    notifyDiscordOnConnect(djId, room.watchingTag)
    // 🚪 퇴장 감지 폴링 시작 (스푼은 퇴장 소켓 이벤트를 안 보내서 명단 폴링으로 대체)
    startLeavePolling(djId, liveId)
    // 🔁 반복 문구 타이머도 이번 입장 시점부터 새로 시작
    repeatLastSent[djId] = {}
    // 🎟️ 복권 자동 지급 타이머도 이번 입장 시점부터 새로 시작 (설정이 켜져있을 때만 실제로 동작)
    startLottoAutoTimer(djId, liveId)
    // 🍞 증권거래소 타이머(시세/뉴스/배당/이벤트)도 이번 입장 시점부터 새로 시작
    startStockTimers(djId, liveId)
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

        // 🎙️ TTS: 이 유저가 "채팅 1회 읽기" 권한을 갖고 있으면(명령어 제외) 이번 채팅을 읽어주고 권한을 소진한다.
        let ttsEligible = false
        if (isModuleOn(settings, 'tts', djId)) {
          const ttsCfg = getTtsSettings(djId, settings)
          if (ttsCfg.enabled && !text.trim().startsWith('!') && isTtsEligible(room, author)) {
            ttsEligible = true
            consumeTtsAccess(djId, room, author)
          }
        }

        // 🏷️ 채팅 뱃지 — DJ/매니저는 저희가 이미 갖고 있는 정보로 확실히 판단 가능.
        // VIP/구독 뱃지는 스푼 API가 실제로 어떤 필드명을 쓰는지 확실치 않아 몇 가지 후보 필드를 추정해서 시도한다.
        // (안 나오면 정확한 필드명을 몰라서일 수 있음 — 확인되면 고칠 수 있어요)
        const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
        const chatAct = getActivitySettings(djId, settings)
        const isManager = !isDj && (chatAct.grantNicknames || []).map(n => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase())
        const isVip = !!(gen.is_vip || gen.vip || gen.isVip || (gen.fan_level && Number(gen.fan_level) > 0))
        const isSubscribe = !!(gen.is_subscribe || gen.subscribe || gen.isSubscribe || gen.plan)

        broadcast({ type: 'chat', djId, nick: author, text, profileUrl: gen.profileUrl || '', ttsEligible, isDj, isManager, isVip, isSubscribe })
        if (!isLurker) {
          // 🆔 태그↔닉네임 매핑은 이 사람의 다른 명령어(!실드 등)를 처리하기 전에 먼저 갱신해둔다.
          // (순서가 뒤에 있으면, 방금 막 채팅을 시작한 사람은 권한 체크 시점에 태그 매핑이 없어서
          //  '고유닉'으로 등록해둔 권한자 목록과 못 맞는 문제가 생김)
          const actTag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          rememberTagNickname(room, actTag, author)

          await handleShieldCommand(djId, room, settings, author, authorId, liveId, text)
          handleFlagCommand(djId, room, settings, author, authorId, text)
          handleFundingCommand(djId, room, settings, author, authorId, text)
          handleShortcutCommand(djId, room, settings, author, authorId, liveId, text, actTag)
          handleSongRequestCommand(djId, room, settings, author, authorId, text)
          handleRouletteCommand(djId, room, settings, author, authorId, liveId, text)
          handleKeepCommands(djId, room, settings, author, authorId, liveId, text)
          handleRouletteGiveCommand(djId, room, settings, author, authorId, liveId, text)
          handleRouletteMenuCommand(djId, settings, text)
          handleActivityCommand(djId, room, settings, author, authorId, text, actTag, liveId)
          handleActChatHook(djId, settings, author, actTag, gen.profileUrl)
          recordTodayMvp(room, 'chat', actTag || author, author, 1)
          rememberProfileUrl(room, actTag, author, gen.profileUrl)
          handleQuizAnswer(djId, settings, author, text)
          handleLottoAutoCommand(djId, room, settings, author, authorId, liveId, text)
          handleReminderCommand(djId, room, settings, author, text)
          handleDdayCommand(djId, room, settings, author, authorId, text)
          handleRaffleCommand(djId, room, settings, author, authorId, liveId, text)
          handleDiceCommand(djId, settings, author, text)
          handleWheelCommand(djId, room, settings, author, authorId, text)
          handleCouponCommand(djId, room, settings, author, authorId, liveId, text)
          handleDiscordNotifyCommand(djId, room, settings, author, authorId, text)
          handleAutoFollowCommand(djId, settings, author, actTag, text)
          handleFishingCommand(djId, room, settings, author, authorId, liveId, text)
          handleFishTournamentCommand(djId, room, settings, author, authorId, liveId, text, actTag)
          handleStockCommand(djId, room, settings, author, authorId, liveId, text, actTag)
          handleAuctionCommand(djId, room, settings, author, authorId, liveId, text, actTag)
          handleSwordCommand(djId, room, settings, author, authorId, liveId, text, actTag)
          handleStockChatHook(djId, settings, actTag, author)
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
          let tag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          if (!tag) {
            // 입장 직후엔 스푼 서버에 아직 유저 정보가 안 붙어있어서 태그 조회가 한 번에 실패할 때가 있다.
            // "지정 인사"가 조용히 안 나가는 걸 막기 위해, 잠깐 기다렸다가 한 번 더 시도한다.
            await new Promise(r => setTimeout(r, 1200))
            tag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          }
          rememberTagNickname(room, tag, author)
          if (tag) registerJoinSnapshot(room, author, tag, joinSnapshotKey) // 태그 알아내면 스냅샷 키를 태그 기준으로 갱신 (이전 닉네임 키 정리)
          const greeting = (tag && isModuleOn(settings, 'greet', djId)) ? (settings.greetings || []).find(g => String(g.tag).toLowerCase() === tag.toLowerCase()) : null

          handleActAttendHook(djId, settings, author, tag)

          if (greeting) {
            const text = greeting.message.replace(/{유저}/g, author).replace(/{nickname}/g, author).replace(/{tag}/g, `@${tag}`)
            setTimeout(() => sendChatToRoom(djId, text), 500)
            if (greeting.soundData) broadcast({ type: 'greetsound', djId, id: greeting.id })
          } else if (isModuleOn(settings, 'entrysettings', djId)) {
            const msgs = (settings.joinMessages || []).filter(m => m.enabled)
            if (msgs.length > 0) {
              const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, tag ? `@${tag}` : `@${author}`)
              setTimeout(() => sendChatToRoom(djId, text), 500)
            }
          }
          if (isModuleOn(settings, 'entrysettings', djId)) {
            const em = pickEntryMessage(settings.entryData, 'entry', author, tag)
            if (em && em.soundData) broadcast({ type: 'entrysound', djId, category: 'entry', id: em.id })
          }
        }

      } else if (eventName === 'LiveFreeLike' || eventName === 'live_like') {
        const gen = eventPayload.generator || {}
        const author = gen.nickname || eventPayload.nickname || '?'
        const authorId = gen.id != null ? Number(gen.id) : null
        broadcast({ type: 'like', djId, nick: author })
        const likeTag = isLurker ? null : await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
        rememberTagNickname(room, likeTag, author)
        rememberProfileUrl(room, likeTag, author, gen.profileUrl)
        if (!isLurker) handleActHeartHook(djId, settings, author, likeTag, gen.profileUrl)
        if (!isLurker) handleStockHeartHook(djId, settings, likeTag, author)
        if (!isLurker) handleSwordHeartHook(djId, settings, likeTag, author)
        if (!isLurker) recordTodayMvp(room, 'like', likeTag || author, author, 1)
        const msgs = (isLurker || !isModuleOn(settings, 'entrysettings', djId)) ? [] : (settings.likeMessages || []).filter(m => m.enabled)
        if (msgs.length > 0) {
          const text = msgs[0].text.replace(/{nickname}/g, author).replace(/{tag}/g, likeTag ? `@${likeTag}` : `@${author}`)
          setTimeout(() => sendChatToRoom(djId, text), 500)
        }
        if (!isLurker && isModuleOn(settings, 'entrysettings', djId)) {
          const em = pickEntryMessage(settings.entryData, 'like', author, likeTag)
          if (em && em.soundData) broadcast({ type: 'entrysound', djId, category: 'like', id: em.id })
        }
        recordDashboardHeart(djId, settings, author, likeTag, 'free', 1)

      } else if (eventName === 'LiveItemUse' || eventName === 'live_item_use') {
        // 유료 아이템(좋아요 효과) — itemId로 광고하트(37)/플랜하트(510,511)/그 외 유료하트를 구분한다.
        const effectType = String(eventPayload.effectType || eventPayload.effect_type || '').toUpperCase()
        if (effectType === 'LIKE' || effectType === 'HEART') {
          const author = eventPayload.nickname || eventPayload.author?.nickname || eventPayload.user?.nickname || '시청자'
          const authorId = eventPayload.userId || eventPayload.user_id || eventPayload.author?.id || eventPayload.user?.id || null
          const baseAmount = Math.max(0, Number(eventPayload.amount) || 0)
          const extraAmount = Math.max(0, Number(eventPayload.extraAmount) || 0)
          const total = baseAmount + extraAmount
          const itemId = Number(eventPayload.itemId || eventPayload.item_id || 0)
          const AD_ITEM_IDS = [37]
          const PLAN_ITEM_IDS = [510, 511]
          let likeType = 'paid'
          if (AD_ITEM_IDS.includes(itemId)) likeType = 'ad'
          else if (PLAN_ITEM_IDS.includes(itemId)) likeType = 'plan'
          if (total > 0) {
            const likeTag = isLurker ? null : await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
            rememberTagNickname(room, likeTag, author)
            if (!isLurker) recordDashboardHeart(djId, settings, author, likeTag, likeType, total)
          }
        }

      } else if (eventName === 'LivePaidLike' || eventName === 'live_paid_like') {
        // 유료 하트(직접 구매) — 항상 '유료하트'로 집계
        const author = eventPayload.nickname || eventPayload.author?.nickname || '시청자'
        const authorId = eventPayload.userId || eventPayload.user_id || null
        const baseAmount = Math.max(0, Number(eventPayload.amount) || 0)
        const extraAmount = Math.max(0, Number(eventPayload.extraAmount) || 0)
        const total = baseAmount + extraAmount
        if (total > 0) {
          const likeTag = isLurker ? null : await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          rememberTagNickname(room, likeTag, author)
          if (!isLurker) recordDashboardHeart(djId, settings, author, likeTag, 'paid', total)
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
        handleSoundEffectTrigger(djId, settings, amount, comboCount, sticker)
        if (!isLurker) {
          handleFlagAutoDonation(djId, settings, amount * Math.max(1, comboCount))
          handleRouletteAutoGrant(djId, room, settings, author, authorId, liveId, amount, comboCount, sticker)
          handleRandomBoxTrigger(djId, room, settings, author, authorId, liveId, amount, comboCount, sticker)
          const donationTag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(SHARED_TOKEN_DJID))
          rememberTagNickname(room, donationTag, author)
          rememberProfileUrl(room, donationTag, author, gen.profileUrl)
          handleActLottoPointHook(djId, settings, author, amount * Math.max(1, comboCount), donationTag)
          handleStockDonationHook(djId, settings, donationTag, author, amount * Math.max(1, comboCount))
          handleAuctionDonationHook(djId, settings, author, donationTag, amount * Math.max(1, comboCount))
          recordTodayMvp(room, 'gift', donationTag || author, author, amount * Math.max(1, comboCount))

          if (isModuleOn(settings, 'entrysettings', djId)) {
            const gm = pickEntryMessage(settings.entryData, 'gift', author, donationTag)
            if (gm && gm.text && gm.text.trim()) {
              const totalCount = amount * Math.max(1, comboCount)
              const text = gm.text.replace(/{nickname}/g, author).replace(/{tag}/g, donationTag ? `@${donationTag}` : `@${author}`).replace(/{count}/g, totalCount).replace(/{amount}/g, totalCount)
              setTimeout(() => sendChatToRoom(djId, text), Math.max(0, Number(gm.delay) || 0) * 1000)
            }
            if (gm && gm.soundData) broadcast({ type: 'entrysound', djId, category: 'gift', id: gm.id })
          }

          if (isModuleOn(settings, 'tts', djId)) {
            const ttsCfg = getTtsSettings(djId, settings)
            if (ttsCfg.enabled) {
              const totalAmount = amount * Math.max(1, comboCount)
              if (totalAmount >= (Number(ttsCfg.triggerAmount) || 10)) {
                grantTtsAccess(djId, room, settings, author)
              }
            }
          }

          recordDashboardSpoon(djId, settings, author, donationTag, amount * Math.max(1, comboCount), comboCount)
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
    stopStockTimers(djId)
    clearReminderTimers(room)
    clearTtsAccess(room)
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
        const rv = buildDashboardRankVars(settings)
        const out = text
          .replace(/{tag}/g, settings.autoJoinTag ? `@${settings.autoJoinTag}` : '')
          .replace(/{nickname}/g, rv.nickname)
          .replace(/{rank}/g, rv.rank)
          .replace(/{choice_rank}/g, rv.choice_rank)
          .replace(/{like_rank}/g, rv.like_rank)
          .replace(/{time_rank}/g, rv.time_rank)
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
  const { djId, password, djTag, email } = req.body || {}
  const result = store.signup(djId, password, djTag, email)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true, msg: '가입 완료! 로그인해주세요.' })
})

// 🔑 비밀번호 찾기 — 가입 시 등록한 이메일이 일치하는지 확인 후, 맞으면 새 비밀번호로 바로 변경한다.
app.post('/auth/forgot-password', (req, res) => {
  const { djId, email, newPassword } = req.body || {}
  const cleanDjId = String(djId || '').trim()
  if (!cleanDjId) return res.json({ success: false, error: '아이디를 입력해주세요' })
  const check = store.verifyRecoveryEmail(cleanDjId, email)
  if (!check.ok) return res.json({ success: false, error: check.error })
  if (!newPassword) return res.json({ success: true, verified: true }) // 이메일만 먼저 확인하는 단계
  const result = store.changePassword(cleanDjId, newPassword)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true, verified: true, changed: true })
})

function canAutoJoin(djId) {
  // 다중감시(자동입장)는 이제 관리자가 개별로 권한을 켜주지 않아도 누구나 기본으로 사용 가능하다.
  return true
}

app.post('/auth/login', async (req, res) => {
  const { djId, password } = req.body || {}
  const result = await store.login(djId, password)
  if (!result.ok) return res.json({ success: false, error: result.error })
  const token = auth.issueToken(djId)
  res.json({ success: true, token, djId, autoJoinEnabled: canAutoJoin(djId) })
})

app.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ success: true, djId: req.djId, autoJoinEnabled: canAutoJoin(req.djId) })
})

// 본인 계정 전용 — 비밀번호 변경 (현재 비밀번호 확인 필요)
app.post('/account/change-password', auth.requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (!currentPassword || !newPassword) return res.json({ success: false, error: '현재 비밀번호와 새 비밀번호를 입력해주세요' })
  if (!(await store.verifyPassword(req.djId, currentPassword))) return res.json({ success: false, error: '현재 비밀번호가 틀렸어요' })
  const result = store.changePassword(req.djId, newPassword)
  if (!result.ok) return res.json({ success: false, error: result.error })
  res.json({ success: true, msg: '비밀번호가 변경됐어요' })
})

// 본인 계정 전용 — 아이디 변경 (현재 비밀번호 확인 필요, 관리자 계정 sum은 변경 불가)
// 아이디가 바뀌면 로그인 키 자체가 바뀌는 것이므로, 방 연결 등 인메모리 상태를 정리하고
// 새 아이디 기준으로 로그인 토큰을 새로 발급해서 내려준다.
app.post('/account/change-id', auth.requireAuth, async (req, res) => {
  const oldId = req.djId
  const { currentPassword } = req.body || {}
  const newId = String((req.body || {}).newDjId || '').trim()
  if (!currentPassword || !newId) return res.json({ success: false, error: '새 아이디와 현재 비밀번호를 입력해주세요' })
  if (!(await store.verifyPassword(oldId, currentPassword))) return res.json({ success: false, error: '현재 비밀번호가 틀렸어요' })
  const result = store.renameDjId(oldId, newId)
  if (!result.ok) return res.json({ success: false, error: result.error })

  // 인메모리 방 연결 상태(WebSocket, 폴링/타이머 등)는 새 아이디로 자동 이전되지 않으므로
  // 안전하게 정리한다. 자동입장이 켜져 있었다면 새 아이디 기준으로 다시 접속을 시도하게 된다.
  const room = getRoom(oldId)
  if (room.ws) { room.ws.terminate() }
  stopLeavePolling(oldId)
  stopLottoAutoTimer(oldId)
  clearReminderTimers(room)
  clearTtsAccess(room)
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

// 본인 계정 전용 — 지금 저장된 모든 봇 설정을 JSON으로 그대로 내보낸다. (백업 / 다른 계정으로 옮길 때 사용)
app.get('/account/settings-export', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, djId: req.djId, exportedAt: new Date().toISOString(), settings })
})

// 본인 계정 전용 — settings-export로 받은 JSON을 다시 업로드해서 설정을 통째로 복원한다.
// 로그인한 djId 자신에게만 적용되고, 다른 계정 데이터는 절대 건드리지 않는다.
// ⚠️ 이용 만료일(expiresAt/expiryStartAt)과 신규가입 기본 이용기간(defaultTrialDays)은
// 관리자만 관리하는 값이라, 업로드한 파일에 들어있어도 무시하고 반영하지 않는다.
// (그렇지 않으면 유저가 만료일을 조작한 파일을 만들어 이용기간을 우회할 수 있음)
app.post('/account/settings-import', auth.requireAuth, (req, res) => {
  const incoming = (req.body || {}).settings
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.json({ success: false, error: '올바른 설정 파일이 아니에요' })
  }
  const patch = { ...incoming }
  delete patch.expiresAt
  delete patch.expiryStartAt
  delete patch.defaultTrialDays
  store.saveSettings(req.djId, patch)
  res.json({ success: true })
})

// 관리자(sum) 전용 — "요청 모듈"(특정 유저만 접근 가능한 제한 메뉴) 목록을 조회/저장한다.
app.get('/admin/request-modules', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  res.json({ success: true, list: store.getRequestModules() })
})

app.post('/admin/request-modules', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const raw = (req.body || {}).list
  if (!Array.isArray(raw)) return res.json({ success: false, error: '목록 형식이 올바르지 않아요' })
  const seen = new Set()
  const clean = []
  for (const m of raw) {
    const id = String((m && m.id) || '').trim()
    const title = String((m && m.title) || '').trim()
    const targetPanel = String((m && m.targetPanel) || '').trim()
    if (!id || !title || !targetPanel) continue
    if (seen.has(id)) continue // 아이디 중복 방지
    seen.add(id)
    clean.push({
      id,
      title,
      icon: String((m && m.icon) || '🔒').trim() || '🔒',
      targetPanel,
      allowedDjIds: Array.isArray(m && m.allowedDjIds) ? [...new Set(m.allowedDjIds.map(x => String(x).trim()).filter(Boolean))] : [],
    })
  }
  const result = store.saveRequestModules(clean)
  if (!result.ok) return res.json(result)
  res.json({ success: true, list: clean })
})

// 본인 계정 전용 — 내가 접근 가능한 요청 모듈만 골라서 반환한다 (사이드바 렌더링용).
// 관리자(sum)는 항상 전체 목록을 받는다.
app.get('/request-modules', auth.requireAuth, (req, res) => {
  const all = store.getRequestModules()
  const mine = req.djId === 'sum' ? all : all.filter(m => (m.allowedDjIds || []).includes(req.djId))
  res.json({ success: true, list: mine.map(m => ({ id: m.id, title: m.title, icon: m.icon, targetPanel: m.targetPanel })) })
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

// 관리자(sum) 전용 — 비밀번호 없이 특정 디제이 계정으로 전환해서 설정을 바로 확인/수정할 수 있게 토큰을 발급한다.
// 관리자(sum) 전용 — 현재 봇이 접속해있는 모든 디제이의 방송 채팅에 한 번에 공지 메시지를 보낸다.
app.post('/admin/broadcast-chat', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const rawMsg = String((req.body || {}).message || '').trim()
  if (!rawMsg) return res.json({ success: false, error: '메시지를 입력해주세요' })
  const sentTo = []
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (room.isConnected) {
      sendChatToRoom(djId, rawMsg)
      sentTo.push(djId)
    }
  }
  res.json({ success: true, count: sentTo.length, djIds: sentTo })
})

app.post('/admin/impersonate', auth.requireAuth, (req, res) => {
  if (req.djId !== 'sum') return res.status(403).json({ success: false, error: '권한이 없어요' })
  const targetDjId = String((req.body || {}).djId || '').trim()
  if (!targetDjId) return res.json({ success: false, error: '아이디를 입력해주세요' })
  if (!store.exists(targetDjId)) return res.json({ success: false, error: '존재하지 않는 계정이에요' })
  const token = auth.issueToken(targetDjId)
  res.json({ success: true, token, djId: targetDjId })
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
  clearReminderTimers(room)
  clearTtsAccess(room)
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

app.get('/roulette/users', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const hist = settings.rouletteHistory || {}
  const tags = Object.keys(hist)
  const room = getRoom(req.djId)
  const users = await Promise.all(tags.map(async tag => {
    const nickname = (hist[tag] && hist[tag].nickname) || tag
    let imgUrl = getCachedProfileUrl(room, null, tag)
    if (!imgUrl) {
      // 캐시에 없으면(최근에 채팅/좋아요 등으로 확인된 적 없으면) 스푼 검색 API로 실제 프로필 사진을 직접 조회한다.
      try {
        const info = await fetchUserStatusByTag(tag)
        if (info && info.photoUrl) {
          imgUrl = info.photoUrl
          rememberProfileUrl(room, tag, nickname, imgUrl)
        }
      } catch (e) { /* 조회 실패 시 그냥 이니셜 아바타로 대체 */ }
    }
    return { tag, nickname, imgUrl }
  }))
  res.json({ success: true, tags, users })
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
    members.forEach(u => {
      if (u.tag) rememberTagNickname(room, u.tag, u.nickname || u.tag)
      if (u.imgUrl) rememberProfileUrl(room, u.tag, u.nickname, u.imgUrl)
    })
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

app.get('/activity/users', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const act = getActivitySettings(req.djId, settings)
  const room = getRoom(req.djId)
  let changed = false
  await Promise.all(Object.entries(act.users).map(async ([key, d]) => {
    if (d.imgUrl) { rememberProfileUrl(room, d.tag, d.nickname, d.imgUrl); return }
    let imgUrl = getCachedProfileUrl(room, d.tag, d.nickname)
    if (!imgUrl && d.tag) {
      try {
        const info = await fetchUserStatusByTag(d.tag)
        if (info && info.photoUrl) imgUrl = info.photoUrl
      } catch (e) { /* 조회 실패 시 이니셜 아바타로 대체 */ }
    }
    if (imgUrl) { d.imgUrl = imgUrl; changed = true; rememberProfileUrl(room, d.tag, d.nickname, imgUrl) }
  }))
  if (changed) store.saveSettings(req.djId, { activity: act })
  const list = Object.entries(act.users).map(([key, d]) => {
    const { level, curExp, nextExp } = actGetLevel(d.exp || 0, act.lvBase)
    return { key, nickname: d.nickname || key, tag: d.tag || '', exp: d.exp || 0, level, curExp, nextExp, heart: d.heart || 0, chat: d.chat || 0, attend: d.attend || 0, lp: d.lp || 0, lotto: d.lotto || 0, imgUrl: d.imgUrl || '' }
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

// ⏰ 리액션 타이머
app.get('/reaction/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getReminderSettings(req.djId, settings)
  const room = getRoom(req.djId)
  const active = (room.reminderTimers || []).map(t => ({ id: t.id, content: t.content, author: t.author, dueAt: t.dueAt }))
  res.json({ success: true, settings: cfg, active })
})
app.post('/reaction/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'reactiontimer', req.djId)) return res.json({ success: false, error: '리액션 타이머 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getReminderSettings(req.djId, settings)
  const { cmd, registerMsg, alertMsg } = req.body || {}
  if (cmd != null) cfg.cmd = String(cmd).trim() || '!리액션'
  if (registerMsg != null) cfg.registerMsg = registerMsg
  if (alertMsg != null) cfg.alertMsg = alertMsg
  store.saveSettings(req.djId, { reminderTimer: cfg })
  res.json({ success: true })
})

// 📝 나만의 메모장
app.get('/mynotes/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getMyNotesSettings(req.djId, settings)
  res.json({ success: true, items: cfg.items })
})
app.post('/mynotes/add', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'mynotes', req.djId)) return res.json({ success: false, error: '나만의 메모장 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getMyNotesSettings(req.djId, settings)
  const title = String((req.body || {}).title || '').trim() || '제목 없음'
  const content = String((req.body || {}).content || '')
  const note = { id: 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), title, content, updatedAt: Date.now() }
  cfg.items.unshift(note) // 최근에 만든 메모가 위로 오게
  store.saveSettings(req.djId, { myNotes: cfg })
  res.json({ success: true, note })
})
app.post('/mynotes/update', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getMyNotesSettings(req.djId, settings)
  const { id, title, content } = req.body || {}
  const note = cfg.items.find(n => n.id === id)
  if (!note) return res.json({ success: false, error: '메모를 찾을 수 없어요' })
  if (title != null) note.title = String(title).trim() || '제목 없음'
  if (content != null) note.content = String(content)
  note.updatedAt = Date.now()
  store.saveSettings(req.djId, { myNotes: cfg })
  res.json({ success: true, note })
})
app.post('/mynotes/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getMyNotesSettings(req.djId, settings)
  const { id } = req.body || {}
  cfg.items = cfg.items.filter(n => n.id !== id)
  store.saveSettings(req.djId, { myNotes: cfg })
  res.json({ success: true })
})

// 📅 디데이
app.get('/dday/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getDdaySettings(req.djId, settings)
  const items = cfg.items.map(it => ({ ...it, diff: calcNextDdayDiff(it.date) }))
  res.json({ success: true, settings: cfg, items })
})
app.post('/dday/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'dday', req.djId)) return res.json({ success: false, error: '디데이 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getDdaySettings(req.djId, settings)
  const { cmd, registerMsg } = req.body || {}
  if (cmd != null) cfg.cmd = String(cmd).trim() || '!디데이'
  if (registerMsg != null) cfg.registerMsg = registerMsg
  store.saveSettings(req.djId, { dday: cfg })
  res.json({ success: true })
})
app.post('/dday/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getDdaySettings(req.djId, settings)
  const { id } = req.body || {}
  cfg.items = cfg.items.filter(it => it.id !== id)
  store.saveSettings(req.djId, { dday: cfg })
  res.json({ success: true })
})

// 🎁 추첨
app.get('/raffle/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getRaffleSettings(req.djId, settings) })
})
app.post('/raffle/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'raffle', req.djId)) return res.json({ success: false, error: '추첨 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getRaffleSettings(req.djId, settings)
  const { cmd, winMsg } = req.body || {}
  if (cmd != null) cfg.cmd = String(cmd).trim() || '!추첨'
  if (winMsg != null) cfg.winMsg = winMsg
  store.saveSettings(req.djId, { raffle: cfg })
  res.json({ success: true })
})
app.post('/raffle/run-now', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'raffle', req.djId)) return res.json({ success: false, error: '추첨 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const room = getRoom(req.djId)
  if (!room.isConnected || !room.autoJoinedFor) return res.json({ success: false, error: '봇이 방송에 접속되어 있지 않아요' })
  const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
  const members = await fetchLiveMembers(room.autoJoinedFor, accessToken, 5)
  if (!members.length) return res.json({ success: false, error: '지금 방송에 접속 중인 시청자가 없어요' })
  const cfg = getRaffleSettings(req.djId, settings)
  const winner = members[Math.floor(Math.random() * members.length)]
  const nickname = winner.nickname || winner.tag
  const out = (cfg.winMsg || '🎉 축하합니다! 오늘의 당첨자는 [{nickname}]님입니다! 🎊').replace(/\{nickname\}/g, nickname)
  setTimeout(() => sendChatToRoom(req.djId, out), 400)
  res.json({ success: true, nickname })
})

// 🎲 주사위
app.get('/dice/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getDiceSettings(req.djId, settings) })
})
app.post('/dice/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'dice', req.djId)) return res.json({ success: false, error: '주사위 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getDiceSettings(req.djId, settings)
  const { cmd, msg } = req.body || {}
  if (cmd != null) cfg.cmd = String(cmd).trim() || '!주사위'
  if (msg != null) cfg.msg = msg
  store.saveSettings(req.djId, { dice: cfg })
  res.json({ success: true })
})

// 🔊 효과음
app.get('/soundfx/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getSoundEffectSettings(req.djId, settings) })
})
app.post('/soundfx/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'soundfx', req.djId)) return res.json({ success: false, error: '효과음 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getSoundEffectSettings(req.djId, settings)
  const { enabled } = req.body || {}
  if (enabled != null) cfg.enabled = !!enabled
  store.saveSettings(req.djId, { soundEffects: cfg })
  res.json({ success: true })
})
app.post('/soundfx/items', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'soundfx', req.djId)) return res.json({ success: false, error: '효과음 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getSoundEffectSettings(req.djId, settings)
  if (cfg.items.length >= SOUNDFX_MAX_ITEMS) return res.json({ success: false, error: `효과음은 최대 ${SOUNDFX_MAX_ITEMS}개까지 등록할 수 있어요.` })
  const { name, triggerType, triggerValue, matchType, enabled, volume, audioData } = req.body || {}
  if (!name || !String(name).trim()) return res.json({ success: false, error: '효과음 이름을 입력해주세요' })
  if (!['sticker', 'amount', 'any'].includes(triggerType)) return res.json({ success: false, error: '조건 종류가 올바르지 않아요' })
  if (triggerType !== 'any' && !String(triggerValue || '').trim()) return res.json({ success: false, error: '조건 값을 입력해주세요' })
  if (!audioData || typeof audioData !== 'string' || !audioData.startsWith('data:audio')) return res.json({ success: false, error: '올바른 오디오 파일이 아니에요' })
  if (audioData.length > SOUNDFX_MAX_BYTES) return res.json({ success: false, error: '오디오 파일이 너무 커요. 1MB 이하 파일로 올려주세요.' })
  const item = {
    id: 'sfx' + Date.now() + Math.floor(Math.random() * 1000),
    name: String(name).trim(),
    triggerType,
    triggerValue: triggerType === 'any' ? '' : String(triggerValue).trim(),
    matchType: triggerType === 'amount' ? (matchType === 'exact' ? 'exact' : 'atLeast') : undefined,
    enabled: enabled !== false,
    volume: Math.max(0, Math.min(1, Number(volume) || 1)),
    audioData,
  }
  cfg.items.push(item)
  store.saveSettings(req.djId, { soundEffects: cfg })
  res.json({ success: true, id: item.id })
})
app.post('/soundfx/items/:id/toggle', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getSoundEffectSettings(req.djId, settings)
  const item = cfg.items.find(it => it.id === req.params.id)
  if (!item) return res.json({ success: false, error: '항목을 찾을 수 없어요' })
  const { enabled } = req.body || {}
  item.enabled = !!enabled
  store.saveSettings(req.djId, { soundEffects: cfg })
  res.json({ success: true })
})
app.post('/soundfx/items/:id/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getSoundEffectSettings(req.djId, settings)
  cfg.items = cfg.items.filter(it => it.id !== req.params.id)
  store.saveSettings(req.djId, { soundEffects: cfg })
  res.json({ success: true })
})

// 🎙️ TTS
app.get('/tts/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getTtsSettings(req.djId, settings) })
})
app.post('/tts/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'tts', req.djId)) return res.json({ success: false, error: 'TTS 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getTtsSettings(req.djId, settings)
  const { enabled, engine, voice, typecastVoiceId, typecastVoiceName, typecastModel, typecastEmotion, rate, triggerAmount, durationMin, maxLen, volume, playChime } = req.body || {}
  if (enabled != null) cfg.enabled = !!enabled
  if (engine != null && ['browser', 'google', 'typecast'].includes(engine)) cfg.engine = engine
  if (voice != null) cfg.voice = String(voice)
  if (typecastVoiceId != null) cfg.typecastVoiceId = String(typecastVoiceId)
  if (typecastVoiceName != null) cfg.typecastVoiceName = String(typecastVoiceName)
  if (typecastModel != null) cfg.typecastModel = String(typecastModel)
  if (typecastEmotion != null) cfg.typecastEmotion = String(typecastEmotion)
  if (rate != null) cfg.rate = Math.max(0.5, Math.min(2, Number(rate) || 1))
  if (triggerAmount != null) cfg.triggerAmount = Math.max(1, Number(triggerAmount) || 10)
  if (durationMin != null) cfg.durationMin = Math.max(1, Number(durationMin) || 30)
  if (maxLen != null) cfg.maxLen = Math.max(1, Math.min(200, Number(maxLen) || 50))
  if (volume != null) cfg.volume = Math.max(0, Math.min(1, Number(volume)))
  if (playChime != null) cfg.playChime = !!playChime
  store.saveSettings(req.djId, { tts: cfg })
  res.json({ success: true })
})
app.get('/tts/active', auth.requireAuth, (req, res) => {
  const room = getRoom(req.djId)
  const now = Date.now()
  const active = []
  if (room.ttsAccess) {
    room.ttsAccess.forEach((expiresAt, key) => { if (expiresAt > now) active.push({ nickname: key, expiresAt }) })
  }
  res.json({ success: true, active })
})
app.post('/tts/reset', auth.requireAuth, (req, res) => {
  const room = getRoom(req.djId)
  clearTtsAccess(room)
  res.json({ success: true })
})
app.post('/tts/presets', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'tts', req.djId)) return res.json({ success: false, error: 'TTS 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getTtsSettings(req.djId, settings)
  const { tag, voice, typecastVoiceId, typecastVoiceName } = req.body || {}
  const key = String(tag || '').trim().replace(/^@/, '').toLowerCase()
  if (!key) return res.json({ success: false, error: '고유닉(또는 닉네임)을 입력해주세요' })
  const hasVoice = voice && String(voice).trim()
  const hasTypecast = typecastVoiceId && String(typecastVoiceId).trim()
  if (!hasVoice && !hasTypecast) return res.json({ success: false, error: '목소리를 선택해주세요' })
  if (!cfg.voicePresets[key] && Object.keys(cfg.voicePresets).length >= 50) return res.json({ success: false, error: '전용 목소리는 최대 50개까지 등록할 수 있어요.' })
  cfg.voicePresets[key] = {
    voice: hasVoice ? String(voice) : '',
    typecastVoiceId: hasTypecast ? String(typecastVoiceId) : '',
    typecastVoiceName: hasTypecast ? String(typecastVoiceName || typecastVoiceId) : '',
  }
  store.saveSettings(req.djId, { tts: cfg })
  res.json({ success: true })
})
app.post('/tts/presets/:tag/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getTtsSettings(req.djId, settings)
  delete cfg.voicePresets[String(req.params.tag || '').toLowerCase()]
  store.saveSettings(req.djId, { tts: cfg })
  res.json({ success: true })
})

// 🎙️ 구글 보이스 — 서버가 관리자의 구글 API 키로 대신 요청해서, 오디오만 클라이언트에 내려준다.
// (클라이언트는 API 키를 절대 알 수 없음)
app.post('/tts/google-speak', auth.requireAuth, async (req, res) => {
  if (!GOOGLE_TTS_API_KEY) return res.json({ success: false, error: '관리자가 아직 구글 보이스를 설정하지 않았어요. 타입캐스트를 이용해주세요.' })
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'tts', req.djId)) return res.json({ success: false, error: 'TTS 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const text = String((req.body || {}).text || '').slice(0, 200)
  if (!text) return res.json({ success: false, error: '읽을 텍스트가 없어요' })
  const voiceName = String((req.body || {}).voice || 'ko-KR-Neural2-A')
  const lang = voiceName.startsWith('en-') ? 'en-US' : voiceName.startsWith('ja-') ? 'ja-JP' : voiceName.startsWith('cmn-') ? 'cmn-CN' : 'ko-KR'
  const gender = ['A', 'B'].includes(voiceName.slice(-1)) ? 'FEMALE' : 'MALE'
  try {
    const upstream = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(GOOGLE_TTS_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: lang, name: voiceName, ssmlGender: gender },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    })
    const data = await upstream.json()
    if (!data.audioContent) return res.json({ success: false, error: (data.error && data.error.message) || '음성 생성 실패' })
    res.json({ success: true, audioContent: data.audioContent })
  } catch (e) {
    console.log('[구글 보이스 오류]', e.message)
    res.json({ success: false, error: '구글 보이스 요청 중 오류: ' + e.message })
  }
})

// 🎙️ 타입캐스트 음성 생성 프록시 — 브라우저에서 직접 호출 시 CORS/권한 문제로 403이 나는 경우가 있어
// 서버가 대신 호출해준다. API 키는 요청마다 클라이언트가 보내는 값을 그대로 전달만 하고 저장하지 않는다.
app.post('/tts/typecast-speak', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'tts', req.djId)) return res.json({ success: false, error: 'TTS 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const { apiKey, voiceId, text, model, emotion, rate } = req.body || {}
  if (!apiKey) return res.json({ success: false, error: 'Typecast API 키가 없어요' })
  if (!voiceId) return res.json({ success: false, error: '타입캐스트 목소리를 먼저 선택해주세요' })
  const cleanText = String(text || '').slice(0, 200)
  if (!cleanText) return res.json({ success: false, error: '읽을 텍스트가 없어요' })
  try {
    const upstream = await fetch('https://api.typecast.ai/v1/text-to-speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({
        voice_id: voiceId,
        text: cleanText,
        model: model || 'ssfm-v30',
        language: 'kor',
        prompt: { emotion_type: 'preset', emotion_preset: emotion || 'normal', emotion_intensity: 1.0 },
        output: { volume: 100, audio_pitch: 0, audio_tempo: Math.max(0.5, Math.min(2, Number(rate) || 1)), audio_format: 'wav' },
      }),
    })
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      console.log('[타입캐스트 오류]', upstream.status, errText.slice(0, 300))
      return res.json({ success: false, error: `HTTP ${upstream.status}${errText ? ' — ' + errText.slice(0, 150) : ''}` })
    }
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.set('Content-Type', 'audio/wav')
    res.send(buf)
  } catch (e) {
    console.log('[타입캐스트 오류]', e.message)
    res.json({ success: false, error: '타입캐스트 요청 중 오류: ' + e.message })
  }
})

// 📊 대시보드
app.get('/dashboard/data', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const dash = getDashboardData(req.djId, settings)
  const fundingItems = ((settings.funding || {}).items || []).filter(f => f.title)
  res.json({ success: true, dashboard: dash, funding: fundingItems })
})
app.post('/dashboard/spoon', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'dashboard', req.djId)) return res.json({ success: false, error: '대시보드 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const dash = getDashboardData(req.djId, settings)
  const { date, tag, nickname, amount } = req.body || {}
  const amt = Number(amount) || 0
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ success: false, error: '날짜 형식이 올바르지 않아요' })
  const key = String(tag || nickname || '').trim().replace(/^@/, '')
  const nick = String(nickname || key || '').trim()
  if (!key || !nick || amt <= 0) return res.json({ success: false, error: '고유닉/닉네임/스푼 개수를 모두 입력해주세요' })
  if (!dash.spoonLog[date]) dash.spoonLog[date] = { total: 0, byUser: {} }
  const entry = dash.spoonLog[date]
  if (!entry.byUser[key]) entry.byUser[key] = { nickname: nick, amount: 0, count: 0 }
  entry.byUser[key].nickname = nick
  entry.byUser[key].amount += amt
  entry.byUser[key].count += 1
  entry.total = (entry.total || 0) + amt
  store.saveSettings(req.djId, { dashboard: dash })
  res.json({ success: true })
})
app.post('/dashboard/spoon/edit', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const dash = getDashboardData(req.djId, settings)
  const { date, tag, nickname, amount } = req.body || {}
  const entry = dash.spoonLog[date]
  if (!entry || !entry.byUser[tag]) return res.json({ success: false, error: '해당 기록을 찾을 수 없어요' })
  const amt = Math.max(0, Number(amount) || 0)
  const diff = amt - (entry.byUser[tag].amount || 0)
  entry.byUser[tag].nickname = String(nickname || entry.byUser[tag].nickname).trim()
  entry.byUser[tag].amount = amt
  entry.total = (entry.total || 0) + diff
  store.saveSettings(req.djId, { dashboard: dash })
  res.json({ success: true })
})
app.post('/dashboard/spoon/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const dash = getDashboardData(req.djId, settings)
  const { date, tag } = req.body || {}
  const entry = dash.spoonLog[date]
  if (!entry || !entry.byUser[tag]) return res.json({ success: false, error: '해당 기록을 찾을 수 없어요' })
  entry.total = Math.max(0, (entry.total || 0) - (entry.byUser[tag].amount || 0))
  delete entry.byUser[tag]
  if (entry.total <= 0 && Object.keys(entry.byUser).length === 0) delete dash.spoonLog[date]
  store.saveSettings(req.djId, { dashboard: dash })
  res.json({ success: true })
})
app.post('/dashboard/likestats/reset', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const dash = getDashboardData(req.djId, settings)
  dash.likeStats = { free: 0, ad: 0, plan: 0, paid: 0, total: 0, sessionStart: Date.now() }
  store.saveSettings(req.djId, { dashboard: dash })
  res.json({ success: true })
})

// 📊 스푼 자체 DJ 월간 랭킹 (초이스/좋아요/방송시간)
app.post('/dashboard/rank/scan', auth.requireAuth, async (req, res) => {
  const r = await scanDashRank()
  res.json(r)
})
app.get('/dashboard/rank/search/:tag', auth.requireAuth, (req, res) => {
  const r = searchDashRank(req.params.tag)
  res.json(r)
})
// 대시보드에 "본인 고유닉"을 등록 + 즉시 랭킹 조회. 반복문구/단축키의 {nickname}{tag}{rank}
// {choice_rank}{like_rank}{time_rank} 변수는 전부 여기서 등록한 값을 기준으로 채워진다.
app.post('/dashboard/rank/register', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'dashboard', req.djId)) return res.json({ success: false, error: '대시보드 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const dash = getDashboardData(req.djId, settings)
  const tag = String((req.body || {}).tag || '').trim().replace(/^@/, '')
  if (!tag) return res.json({ success: false, error: '고유닉을 입력해주세요' })
  dash.djTag = tag
  store.saveSettings(req.djId, { dashboard: dash })
  const r = await refreshDashboardRankFor(req.djId, settings)
  if (!r.success) return res.json({ success: false, error: r.error || '랭킹 조회에 실패했어요', djTag: tag })
  res.json({ success: true, data: r.data })
})

// 🎡 돌림판 룰렛
app.get('/wheel/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getWheelSettings(req.djId, settings) })
})
app.post('/wheel/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'wheelroulette', req.djId)) return res.json({ success: false, error: '돌림판 룰렛 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getWheelSettings(req.djId, settings)
  const { activePage, pages } = req.body || {}
  if (Number.isInteger(activePage) && activePage >= 0 && activePage < WHEEL_PAGE_COUNT) cfg.activePage = activePage
  if (Array.isArray(pages)) {
    cfg.pages = cfg.pages.map((p, i) => {
      const src = pages[i]
      if (!src || typeof src !== 'object') return p
      return {
        items: Array.isArray(src.items)
          ? src.items.filter(it => it && typeof it.label === 'string' && it.label.trim()).map(it => ({
              label: String(it.label).slice(0, 80),
              weight: Math.max(0, Math.min(10000, Number(it.weight) || 1)),
              color: (typeof it.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(it.color)) ? it.color : '#888',
            })).slice(0, 30)
          : p.items,
        soundEnabled: src.soundEnabled !== false,
        ttsEnabled: src.ttsEnabled !== false,
        spinSeconds: Math.max(2, Math.min(15, Number(src.spinSeconds) || p.spinSeconds || 5)),
        resultTemplate: (typeof src.resultTemplate === 'string' && src.resultTemplate.trim()) ? src.resultTemplate.slice(0, 300) : p.resultTemplate,
      }
    })
  }
  store.saveSettings(req.djId, { wheelRoulette: cfg })
  res.json({ success: true })
})
app.post('/wheel/spin-result', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'wheelroulette', req.djId)) return res.json({ success: false, error: '돌림판 룰렛 메뉴가 꺼져있어요.' })
  const { label, pageIndex, resultTemplate } = req.body || {}
  const cleanLabel = String(label || '').trim().slice(0, 200)
  if (!cleanLabel) return res.json({ success: false, error: '결과 값이 없어요' })
  const tmpl = (typeof resultTemplate === 'string' && resultTemplate.trim()) ? resultTemplate : null
  let finalTmpl = tmpl
  if (!finalTmpl) {
    const cfg = getWheelSettings(req.djId, settings)
    const idx = Number.isInteger(pageIndex) ? pageIndex : cfg.activePage
    const page = cfg.pages[idx] || cfg.pages[0]
    finalTmpl = (page && page.resultTemplate) || '🎡 돌림판 결과: {result}'
  }
  const text = finalTmpl.replace('{result}', cleanLabel)
  setTimeout(() => sendChatToRoom(req.djId, text), 300)
  res.json({ success: true })
})

// 🎟️ 쿠폰 확인
app.get('/coupon/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getCouponCheckSettings(req.djId, settings) })
})
app.post('/coupon/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'couponcheck', req.djId)) return res.json({ success: false, error: '쿠폰 확인 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getCouponCheckSettings(req.djId, settings)
  const { title, footer, showZeroRoulette, cmdCoupon, cmdGive, cmdSync } = req.body || {}
  if (title != null) cfg.title = String(title).slice(0, 100)
  if (footer != null) cfg.footer = String(footer).slice(0, 100)
  if (showZeroRoulette != null) cfg.showZeroRoulette = !!showZeroRoulette
  if (cmdCoupon != null) cfg.cmdCoupon = String(cmdCoupon).trim() || '!쿠폰'
  if (cmdGive != null) cfg.cmdGive = String(cmdGive).trim() || '!룰렛권지급'
  if (cmdSync != null) cfg.cmdSync = String(cmdSync).trim() || '!쿠폰동기화'
  store.saveSettings(req.djId, { couponCheck: cfg })
  res.json({ success: true })
})

// 📝 메모장 — 실시간 접속자 목록 + 이미 메모 남긴 유저 목록을 함께 내려준다.
app.get('/usernotes/data', auth.requireAuth, async (req, res) => {
  const djId = req.djId
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'usernotes', djId)) return res.json({ success: false, error: '메모장 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const notes = getUserNotesData(djId, settings)
  let live = []
  const room = getRoom(djId)
  if (room.isConnected && room.autoJoinedFor) {
    try {
      const accessToken = tokenManager.getAccessToken(SHARED_TOKEN_DJID)
      live = await fetchLiveMembers(room.autoJoinedFor, accessToken, 5)
      // 실시간 접속자 API가 프로필 사진을 안 줄 수 있어서, 이미 채팅/좋아요/선물에서
      // 실제로 확인된 프로필 사진(캐시)이 있으면 그걸 우선 사용한다 — 훨씬 더 잘 맞음.
      live = live.map(m => ({ ...m, imgUrl: getCachedProfileUrl(room, m.tag, m.nickname) || m.imgUrl || '' }))
    } catch (e) { live = [] }
  }
  res.json({ success: true, notes, live })
})
app.post('/usernotes/save', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'usernotes', req.djId)) return res.json({ success: false, error: '메모장 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const notes = getUserNotesData(req.djId, settings)
  const { tag, nickname, memo, imgUrl } = req.body || {}
  const key = String(tag || nickname || '').trim().replace(/^@/, '')
  if (!key) return res.json({ success: false, error: '고유닉/닉네임이 없어요' })
  if (!notes[key]) notes[key] = { nickname: nickname || key, tag: tag || '', imgUrl: '', memo: '' }
  if (nickname) notes[key].nickname = nickname
  if (tag) notes[key].tag = tag
  if (imgUrl) notes[key].imgUrl = imgUrl
  notes[key].memo = String(memo || '').slice(0, 2000)
  notes[key].updatedAt = Date.now()
  store.saveSettings(req.djId, { userNotes: notes })
  res.json({ success: true })
})
app.post('/usernotes/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const notes = getUserNotesData(req.djId, settings)
  const key = String((req.body || {}).tag || '').trim()
  delete notes[key]
  store.saveSettings(req.djId, { userNotes: notes })
  res.json({ success: true })
})

// 🔔 디스코드 방송 알림
app.get('/discordnotify/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  res.json({ success: true, settings: getDiscordNotifySettings(req.djId, settings), room: { watchingTag: getRoom(req.djId).watchingTag || '', isConnected: getRoom(req.djId).isConnected } })
})
app.post('/discordnotify/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'discordnotify', req.djId)) return res.json({ success: false, error: '디스코드 알림 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getDiscordNotifySettings(req.djId, settings)
  const { webhookUrl, manualStreamName, enabled, title, description, streamUrlTemplate, cooldownMinutes } = req.body || {}
  if (webhookUrl != null) cfg.webhookUrl = String(webhookUrl).trim()
  if (manualStreamName != null) cfg.manualStreamName = String(manualStreamName).trim().replace(/^@+/, '')
  if (enabled != null) cfg.enabled = !!enabled
  if (title != null) cfg.title = String(title).slice(0, 200)
  if (description != null) cfg.description = String(description).slice(0, 1500)
  if (streamUrlTemplate != null) cfg.streamUrlTemplate = String(streamUrlTemplate).slice(0, 300)
  if (cooldownMinutes != null) cfg.cooldownMinutes = Math.max(0, Math.min(1440, Number(cooldownMinutes) || 0))
  store.saveSettings(req.djId, { discordNotify: cfg })
  res.json({ success: true })
})
app.post('/discordnotify/test', auth.requireAuth, async (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'discordnotify', req.djId)) return res.json({ success: false, error: '디스코드 알림 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const cfg = getDiscordNotifySettings(req.djId, settings)
  const room = getRoom(req.djId)
  const finalName = (cfg.manualStreamName || '').trim().replace(/^@+/, '') || String(room.watchingTag || '').replace(/^@+/, '').trim()
  const r = await sendDiscordNotify(cfg, finalName)
  res.json(r.ok ? { success: true } : { success: false, error: r.error })
})
app.post('/discordnotify/reset-cooldown', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const cfg = getDiscordNotifySettings(req.djId, settings)
  cfg.lastSentAt = 0
  cfg.lastStreamName = ''
  store.saveSettings(req.djId, { discordNotify: cfg })
  res.json({ success: true })
})

// 🤝 팔로우 자동승인 (관리자 전용 — 채널 ID/팔로우 실행이 전부 관리자 계정 기준이라서)
app.get('/autofollow/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 설정할 수 있어요' })
  const cfg = getAutoFollowSettings()
  res.json({ success: true, settings: cfg })
})
app.post('/autofollow/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 설정할 수 있어요' })
  const cfg = getAutoFollowSettings()
  const { channelId, codeLength, expireMinutes, cmd } = req.body || {}
  if (channelId != null) cfg.channelId = String(channelId).trim().replace(/\D/g, '')
  if (codeLength != null) cfg.codeLength = Math.max(4, Math.min(16, Number(codeLength) || 8))
  if (expireMinutes != null) cfg.expireMinutes = Math.max(1, Math.min(1440, Number(expireMinutes) || 60))
  if (cmd != null) cfg.cmd = String(cmd).trim() || '!팔로우신청'
  store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
  res.json({ success: true })
})
// 🖱️ 웹 화면 "팔로잉 신청" 버튼 — 채팅 없이도 아무 로그인한 DJ가 바로 인증번호를 받을 수 있게 한다.
app.post('/autofollow/request', auth.requireAuth, (req, res) => {
  const cfg = getAutoFollowSettings()
  if (!cfg.channelId) return res.json({ success: false, error: '아직 관리자가 팔로우 자동승인을 설정하지 않았어요.' })
  const code = generateFollowCode(Number(cfg.codeLength) || 8)
  cfg.pending[code] = {
    nickname: req.djId,
    tag: '',
    djId: req.djId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + Math.max(1, Number(cfg.expireMinutes) || 60) * 60000,
  }
  store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
  const boardUrl = `https://www.spooncast.net/kr/channel/${cfg.channelId}/tab/follower-posts`
  res.json({ success: true, code, expireMinutes: cfg.expireMinutes || 60, boardUrl })
})
// 팬보드 바로가기 링크만 가볍게 조회 (인증번호 발급 전에도 버튼을 바로 보여주기 위함)
app.get('/autofollow/board-link', auth.requireAuth, (req, res) => {
  const cfg = getAutoFollowSettings()
  if (!cfg.channelId) return res.json({ success: false })
  res.json({ success: true, boardUrl: `https://www.spooncast.net/kr/channel/${cfg.channelId}/tab/follower-posts` })
})
app.post('/autofollow/poll-now', auth.requireAuth, async (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 사용할 수 있어요' })
  await pollAutoFollowBoard()
  res.json({ success: true })
})
app.post('/autofollow/pending/delete', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 사용할 수 있어요' })
  const cfg = getAutoFollowSettings()
  const code = String((req.body || {}).code || '').trim().toUpperCase()
  delete cfg.pending[code]
  store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
  res.json({ success: true })
})
app.post('/autofollow/history/clear', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 사용할 수 있어요' })
  const cfg = getAutoFollowSettings()
  cfg.history = []
  store.saveSettings(SHARED_TOKEN_DJID, { autoFollow: cfg })
  res.json({ success: true })
})

// 🎣 낚시 게임
app.get('/stock/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const nextPrice = Math.max(0, Math.round(((stock.nextPriceAt || Date.now()) - Date.now()) / 60000))
  const nextNews = Math.max(0, Math.round(((stock.nextNewsAt || Date.now()) - Date.now()) / 60000))
  const nextDividend = Math.max(0, Math.round(((stock.nextDividendAt || Date.now()) - Date.now()) / 60000))
  const nextEvent = Math.max(0, Math.round(((stock.nextEventAt || Date.now()) - Date.now()) / 60000))
  res.json({ success: true, config: stock.config, stocks: stock.stocks, jackpot: stock.jackpot, userCount: Object.keys(stock.users).length, nextPrice, nextNews, nextDividend, nextEvent })
})
app.post('/stock/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'stock', req.djId)) return res.json({ success: false, error: '증권거래소 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const stock = getStockSettings(req.djId, settings)
  const body = req.body || {}
  const numKeys = ['startMoney', 'likeMoney', 'chatMoney', 'spoonMoney', 'attendMoney', 'priceIntervalMin', 'priceMinPct', 'priceMaxPct', 'priceFloor', 'newsIntervalMin', 'dividendIntervalMin', 'eventIntervalMin', 'eventChancePct', 'depositInterestPct', 'depositInterestCap', 'loanLimit', 'loanInterestPct', 'autoLoanAmount', 'jackpotSeed']
  const cmdKeys = ['cmdStart', 'cmdAttend', 'cmdRule', 'cmdMyInfo', 'cmdMyMoney', 'cmdStockList', 'cmdMyStock', 'cmdRanking', 'cmdJackpot', 'cmdDeposit', 'cmdWithdraw', 'cmdLoan', 'cmdRepay', 'cmdSlot', 'cmdRoulette', 'cmdOddEven', 'cmdDice', 'cmdLotto', 'cmdShop', 'cmdBuy', 'cmdUse', 'cmdStockCreate', 'cmdStockDelete', 'cmdGiveMoney']
  if (body.enabled != null) stock.config.enabled = !!body.enabled
  numKeys.forEach(k => { if (body[k] != null) stock.config[k] = Number(body[k]) || 0 })
  cmdKeys.forEach(k => { if (body[k] != null) { let v = String(body[k]).trim(); if (v && !v.startsWith('!')) v = '!' + v; if (v) stock.config[k] = v.slice(0, 30) } })
  if (Array.isArray(body.goodNews)) stock.config.goodNews = body.goodNews.filter(r => Array.isArray(r) && r[0]).map(r => [String(r[0]).slice(0, 60), Number(r[1]) || 0]).slice(0, 50)
  if (Array.isArray(body.badNews)) stock.config.badNews = body.badNews.filter(r => Array.isArray(r) && r[0]).map(r => [String(r[0]).slice(0, 60), Number(r[1]) || 0]).slice(0, 50)
  if (Array.isArray(body.items)) stock.config.items = body.items.filter(it => it && it.name).map(it => ({ name: String(it.name).slice(0, 30), price: Number(it.price) || 0, desc: String(it.desc || '').slice(0, 60) })).slice(0, 20)
  store.saveSettings(req.djId, { stock })
  res.json({ success: true })
})
app.post('/stock/stocks', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'stock', req.djId)) return res.json({ success: false, error: '증권거래소 메뉴가 꺼져있어요.' })
  const stock = getStockSettings(req.djId, settings)
  const body = req.body || {}
  const name = String(body.name || '').trim()
  const price = Number(body.price) || 0
  if (!name || price <= 0) return res.json({ success: false, error: '종목명과 시작가를 입력해주세요.' })
  if (stock.stocks.length >= 10) return res.json({ success: false, error: '종목은 최대 10개까지 운영할 수 있어요.' })
  if (stock.stocks.find(s => s.name === name)) return res.json({ success: false, error: '이미 있는 종목명이에요.' })
  let divRate = body.dividendRate != null ? Number(body.dividendRate) : NaN
  if (isNaN(divRate)) divRate = Math.round((0.5 + Math.random() * 2.5) * 2) / 2
  stock.stocks.push({ name, price, dividendRate: divRate, lastPct: 0 })
  store.saveSettings(req.djId, { stock })
  res.json({ success: true, stocks: stock.stocks })
})
app.post('/stock/stocks/:name/update', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const st = stock.stocks.find(s => s.name === req.params.name)
  if (!st) return res.json({ success: false, error: '없는 종목이에요.' })
  const body = req.body || {}
  if (body.price != null) st.price = Math.max(1, Number(body.price) || st.price)
  if (body.dividendRate != null) st.dividendRate = Number(body.dividendRate) || 0
  store.saveSettings(req.djId, { stock })
  res.json({ success: true, stocks: stock.stocks })
})
app.post('/stock/stocks/:name/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const idx = stock.stocks.findIndex(s => s.name === req.params.name)
  if (idx < 0) return res.json({ success: false, error: '없는 종목이에요.' })
  const st = stock.stocks[idx]
  for (const nick in stock.users) {
    const u = stock.users[nick]
    const h = u.holdings[st.name]
    if (h && h.qty > 0) { u.cash += h.qty * st.price; delete u.holdings[st.name] }
  }
  stock.stocks.splice(idx, 1)
  store.saveSettings(req.djId, { stock })
  res.json({ success: true, stocks: stock.stocks })
})
app.post('/stock/jackpot', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const amt = Number((req.body || {}).amount)
  if (!Number.isFinite(amt) || amt < 0) return res.json({ success: false, error: '올바른 금액을 입력해주세요.' })
  stock.jackpot = amt
  store.saveSettings(req.djId, { stock })
  res.json({ success: true, jackpot: stock.jackpot })
})
// 📋 명령어 보기 — 이 계정에 현재 켜져있는 모든 모듈의 채팅 명령어를 한 번에 모아서 보여준다.
const FISHING_STATIC_CMDS = ['!낚시', '!돈줘', '!잔액', '!상태', '!지갑', '!레벨', '!도감', '!도감공유', '!상점', '!구매', '!아이템상점', '!아이템구매', '!슬롯', '!주사위', '!홀', '!짝', '!송금', '!도둑', '!돈주기', '!대출', '!상환', '!신용정보', '!컬렉션', '!낚시도움말', '!낚시명령어']
app.get('/commands/list', auth.requireAuth, (req, res) => {
  const djId = req.djId
  const settings = store.getSettings(djId) || {}
  const on = (key) => isModuleOn(settings, key, djId)
  const groups = []

  if (on('shortcuts') && Array.isArray(settings.commands) && settings.commands.length) {
    groups.push({ key: 'shortcuts', icon: '⌨️', label: '단축키 명령어', items: settings.commands.map(c => ({ cmd: c.trigger, desc: String(c.response || '').slice(0, 40) })).filter(x => x.cmd) })
  }
  if (on('request') && settings.songRequest) {
    const s = settings.songRequest
    groups.push({
      key: 'request', icon: '🎵', label: '신청곡 관리', items: [
        { cmd: s.cmdRequest, desc: '신청곡 접수' }, { cmd: s.cmdRemove, desc: '내 신청곡 취소' }, { cmd: s.cmdReset, desc: '전체 초기화 (관리자)' },
        { cmd: s.cmdClose, desc: '접수 마감 (관리자)' }, { cmd: s.cmdOpen, desc: '접수 재개 (관리자)' },
        { cmd: s.cmdPriorityOn, desc: '우선모드 켜기 (관리자)' }, { cmd: s.cmdPriorityOff, desc: '우선모드 끄기 (관리자)' },
        { cmd: s.cmdNameOn, desc: '신청자명 표시 켜기 (관리자)' }, { cmd: s.cmdNameOff, desc: '신청자명 표시 끄기 (관리자)' },
        { cmd: s.cmdRecommend, desc: '멜론 차트 랜덤 추천곡' },
      ].filter(x => x.cmd)
    })
  }
  if (on('shield') && settings.shield && settings.shield.cmd) {
    groups.push({ key: 'shield', icon: '🛡️', label: '실드 관리', items: [{ cmd: settings.shield.cmd, desc: '실드 개수 조회/적립' }] })
  }
  if (on('funding') && settings.funding && settings.funding.cmd) {
    groups.push({ key: 'funding', icon: '💰', label: '펀딩 관리', items: [{ cmd: settings.funding.cmd, desc: '펀딩 현황 조회' }] })
  }
  if (on('flag') && settings.flags && settings.flags.cmd) {
    groups.push({ key: 'flag', icon: '🚩', label: '단비 깃발', items: [{ cmd: settings.flags.cmd, desc: '깃발 현황 조회' }] })
  }
  if (on('loyalty')) {
    const act = getActivitySettings(djId, settings)
    groups.push({
      key: 'loyalty', icon: '⭐', label: '애청지수', items: [
        { cmd: act.cmdMyInfo, desc: '내 애청지수 조회' }, { cmd: act.cmdCreate, desc: '애청지수 데이터 생성' }, { cmd: act.cmdDelete, desc: '애청지수 데이터 삭제' },
        { cmd: act.cmdRank, desc: '랭킹 조회' }, { cmd: act.cmdLotto, desc: '복권 사용' }, { cmd: act.cmdAttend, desc: '출석 체크' },
        { cmd: act.cmdLottoGive, desc: '복권 지급 (관리자)' }, { cmd: act.cmdShop, desc: '상점 조회' },
      ].filter(x => x.cmd)
    })
  }
  if (on('lottoauto')) {
    const la = getLottoAutoSettings(djId, settings)
    groups.push({
      key: 'lottoauto', icon: '🎟️', label: '복권 자동지급', items: [
        { cmd: la.cmdStatus, desc: '자동지급 상태 확인' }, { cmd: la.cmdNow, desc: '즉시 지급 실행 (관리자)' },
        { cmd: la.cmdPause, desc: '자동지급 정지 (관리자)' }, { cmd: la.cmdResume, desc: '자동지급 재개 (관리자)' }, { cmd: la.cmdRefresh, desc: '설정 갱신 (관리자)' },
      ].filter(x => x.cmd)
    })
  }
  if (on('reactiontimer') && settings.reminderTimer && settings.reminderTimer.cmd) {
    groups.push({ key: 'reactiontimer', icon: '⏰', label: '리액션 타이머', items: [{ cmd: settings.reminderTimer.cmd, desc: '[명령어] [분] [내용] 형식으로 예약 알림 등록' }] })
  }
  if (on('dday') && settings.dday && settings.dday.cmd) {
    groups.push({ key: 'dday', icon: '📅', label: '디데이', items: [{ cmd: settings.dday.cmd, desc: '디데이 등록/조회' }] })
  }
  if (on('raffle') && settings.raffle && settings.raffle.cmd) {
    groups.push({ key: 'raffle', icon: '🎊', label: '추첨', items: [{ cmd: settings.raffle.cmd, desc: '추첨 실행 (관리자)' }] })
  }
  if (on('dice') && settings.dice && settings.dice.cmd) {
    groups.push({ key: 'dice', icon: '🎲', label: '주사위', items: [{ cmd: settings.dice.cmd, desc: '주사위 굴리기' }] })
  }
  if (on('roulette')) {
    const items = []
    const list = (settings.roulette && Array.isArray(settings.roulette.list)) ? settings.roulette.list : []
    list.forEach((rt, i) => {
      const idx = i + 1
      const name = rt.name || `룰렛${idx}`
      items.push({ cmd: `!룰렛${idx}`, desc: `[${name}] 돌리기 (뒤에 숫자 붙이면 여러 번: !룰렛${idx} 3)` })
      items.push({ cmd: `!룰렛메뉴${idx}`, desc: `[${name}] 항목 목록 확인` })
      items.push({ cmd: `!룰렛지급${idx}`, desc: `[${name}] 권 지급 (관리자, 예: !룰렛지급${idx} 고유닉 1)` })
    })
    items.push(
      { cmd: '!킵', desc: '내 킵목록 조회 (뒤에 페이지 번호 가능)' },
      { cmd: '!킵확인N', desc: '[고유닉] 다른 사람 킵목록 조회 (예: !킵확인1 고유닉)' },
      { cmd: '!킵추가', desc: '[고유닉] [내용] 킵 추가 (관리자)' },
      { cmd: '!킵사용', desc: '[번호] [수량] 킵 사용 (관리자)' },
      { cmd: '!이벤트', desc: '내 이벤트목록 조회' },
      { cmd: '!이벤트확인N', desc: '[고유닉] 다른 사람 이벤트목록 조회' },
      { cmd: '!이벤트사용', desc: '[번호] [수량] 이벤트 항목 사용 (관리자)' },
      { cmd: '!내카드', desc: '내 기타목록 조회' },
      { cmd: '!내카드확인N', desc: '[고유닉] 다른 사람 기타목록 조회' },
      { cmd: '!내카드사용', desc: '[번호] [수량] 기타 항목 사용 (관리자)' },
    )
    groups.push({ key: 'roulette', icon: '🎡', label: '룰렛', items })
  }
  if (on('auction') && settings.auction && settings.auction.config) {
    const acfg = settings.auction.config
    groups.push({
      key: 'auction', icon: '🔨', label: '경매', items: [
        { cmd: acfg.cmd, desc: '진행중인 경매 현황 조회' },
        { cmd: acfg.cmd + ' 참여', desc: '경매 참여 등록 (참여 후 보내는 선물이 자동 반영됨)' },
        { cmd: acfg.cmdMyBid, desc: '내 참여 현황/당첨 확률 조회' },
        { cmd: acfg.cmdEnd, desc: '진행중인 경매 즉시 종료 및 추첨 (관리자)' },
        { cmd: acfg.cmdCancel, desc: '진행중인 경매 취소 (관리자)' },
      ].filter(x => x.cmd)
    })
  }
  if (on('couponcheck') && settings.couponCheck) {
    const cc = settings.couponCheck
    groups.push({
      key: 'couponcheck', icon: '🎟️', label: '쿠폰 확인', items: [
        { cmd: cc.cmdCoupon, desc: '보유 쿠폰 조회' }, { cmd: cc.cmdGive, desc: '룰렛권 지급 (관리자)' }, { cmd: cc.cmdSync, desc: '쿠폰 동기화 (관리자)' },
      ].filter(x => x.cmd)
    })
  }
  if (on('fishing')) {
    groups.push({ key: 'fishing', icon: '🎣', label: '낚시 게임', items: FISHING_STATIC_CMDS.map(c => ({ cmd: c, desc: '' })) })
  }
  if (on('stock')) {
    const stock = getStockSettings(djId, settings)
    const cfg = stock.config
    const labelMap = {
      cmdStart: '게임 시작', cmdAttend: '출석', cmdRule: '룰설명', cmdMyInfo: '내 자산 정보', cmdMyMoney: '내 현금 조회',
      cmdStockList: '전체 시세 조회', cmdMyStock: '내 포트폴리오', cmdRanking: '자산 랭킹', cmdJackpot: '잭팟 조회',
      cmdDeposit: '예금', cmdWithdraw: '출금', cmdLoan: '대출', cmdRepay: '대출 상환',
      cmdSlot: '슬롯머신', cmdRoulette: '룰렛', cmdOddEven: '홀짝', cmdDice: '주사위', cmdLotto: '복권',
      cmdShop: '아이템 상점', cmdBuy: '아이템 구매', cmdUse: '아이템 사용',
      cmdStockCreate: '종목 설립 (관리자)', cmdStockDelete: '종목 폐지 (관리자)', cmdGiveMoney: '머니 지급 (관리자)',
    }
    groups.push({ key: 'stock', icon: '🍞', label: '증권거래소', items: Object.keys(labelMap).map(k => ({ cmd: cfg[k], desc: labelMap[k] })).filter(x => x.cmd) })
  }

  const total = groups.reduce((s, g) => s + g.items.length, 0)
  res.json({ success: true, groups, total })
})

// ── 🔨 경매 시스템 API ──
// ── 🎁 랜덤박스 API ──
// ── ⚔️ 검키우기 설정 API (관리자 sum 계정 아래 공용 설정) ──
app.get('/swordgame/settings', auth.requireAuth, (req, res) => {
  ensureSwordSettingsLoaded()
  res.json({ success: true, settings: localSettings, userCount: localUsers.size })
})
app.post('/swordgame/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'swordgame', req.djId)) return res.json({ success: false, error: '검키우기 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  ensureSwordSettingsLoaded()
  const b = req.body || {}
  const numKeys = ['initial_gold', 'daily_money', 'like_reward', 'spoon_to_gold_rate', 'enhance_cooldown', 'battle_cooldown', 'dungeon_cooldown', 'sell_price_multiplier', 'battle_reward_base']
  if (b.enabled != null) localSettings.enabled = !!b.enabled
  numKeys.forEach(k => { if (b[k] != null) localSettings[k] = Number(b[k]) || 0 })
  if (Array.isArray(b.enhance_success_rates)) {
    localSettings.enhance_success_rates = b.enhance_success_rates.map(r => ({
      level: Number(r.level) || 0, cost: Number(r.cost) || 0,
      success_rate: Number(r.success_rate) || 0, fail_rate: Number(r.fail_rate) || 0,
      down_rate: Number(r.down_rate) || 0, destroy_rate: Number(r.destroy_rate) || 0,
    }))
  }
  if (Array.isArray(b.weapon_names)) {
    localSettings.weapon_names = b.weapon_names.map(w => ({ level: Number(w.level) || 0, name: String(w.name || '').slice(0, 30) }))
  }
  persistSwordSettings()
  res.json({ success: true, settings: localSettings })
})
app.post('/swordgame/reset-defaults', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'swordgame', req.djId)) return res.json({ success: false, error: '검키우기 메뉴가 꺼져있어요.' })
  localSettings = null
  initializeSettings()
  persistSwordSettings()
  res.json({ success: true, settings: localSettings })
})

app.get('/randombox/list', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const rb = getRandomBoxSettings(req.djId, settings)
  res.json({ success: true, list: rb.list })
})
app.post('/randombox/create', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'randombox', req.djId)) return res.json({ success: false, error: '랜덤박스 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const rb = getRandomBoxSettings(req.djId, settings)
  const b = req.body || {}
  const name = String(b.name || '').trim() || `랜덤박스${rb.list.length + 1}`
  const box = {
    name,
    triggerMode: ['exact', 'combo', 'distribute', 'sticker'].includes(b.triggerMode) ? b.triggerMode : 'exact',
    triggerAmount: Math.max(1, Number(b.triggerAmount) || 10),
    triggerSticker: String(b.triggerSticker || '').trim(),
    triggerStickerPayout: ['exact', 'combo', 'distribute'].includes(b.triggerStickerPayout) ? b.triggerStickerPayout : 'combo',
    triggerStickerCount: Math.max(1, Number(b.triggerStickerCount) || 1),
    resultTemplate: String(b.resultTemplate || '').trim() || '🎁 [{박스명}] {닉네임}님의 결과 👉 {결과}',
    items: [],
  }
  rb.list.push(box)
  store.saveSettings(req.djId, { randomBox: rb })
  res.json({ success: true, list: rb.list })
})
app.post('/randombox/:idx/update', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const rb = getRandomBoxSettings(req.djId, settings)
  const idx = parseInt(req.params.idx, 10)
  const box = rb.list[idx]
  if (!box) return res.json({ success: false, error: '없는 랜덤박스예요.' })
  const b = req.body || {}
  if (b.name != null) box.name = String(b.name).trim() || box.name
  if (b.triggerMode != null && ['exact', 'combo', 'distribute', 'sticker'].includes(b.triggerMode)) box.triggerMode = b.triggerMode
  if (b.triggerAmount != null) box.triggerAmount = Math.max(1, Number(b.triggerAmount) || 10)
  if (b.triggerSticker != null) box.triggerSticker = String(b.triggerSticker).trim()
  if (b.triggerStickerPayout != null && ['exact', 'combo', 'distribute'].includes(b.triggerStickerPayout)) box.triggerStickerPayout = b.triggerStickerPayout
  if (b.triggerStickerCount != null) box.triggerStickerCount = Math.max(1, Number(b.triggerStickerCount) || 1)
  if (b.resultTemplate != null) box.resultTemplate = String(b.resultTemplate).trim() || box.resultTemplate
  if (Array.isArray(b.items)) box.items = b.items.filter(it => it && it.name).map(it => ({ name: String(it.name).slice(0, 60), percent: Math.max(0.01, Number(it.percent) || 1) })).slice(0, 100)
  store.saveSettings(req.djId, { randomBox: rb })
  res.json({ success: true, list: rb.list })
})
app.post('/randombox/:idx/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const rb = getRandomBoxSettings(req.djId, settings)
  const idx = parseInt(req.params.idx, 10)
  if (!rb.list[idx]) return res.json({ success: false, error: '없는 랜덤박스예요.' })
  rb.list.splice(idx, 1)
  store.saveSettings(req.djId, { randomBox: rb })
  res.json({ success: true, list: rb.list })
})

app.get('/auction/list', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const a = getAuctionSettings(req.djId, settings)
  const list = [...a.list].sort((x, y) => {
    if (x.status === 'active' && y.status !== 'active') return -1
    if (x.status !== 'active' && y.status === 'active') return 1
    return y.createdAt - x.createdAt
  }).map(x => ({ ...x, participantCount: Object.keys(x.bids || {}).length }))
  res.json({ success: true, config: a.config, list })
})
app.post('/auction/create', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'auction', req.djId)) return res.json({ success: false, error: '경매 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const a = getAuctionSettings(req.djId, settings)
  if (auctionActive(a)) return res.json({ success: false, error: '이미 진행중인 경매가 있어요. 먼저 종료하거나 취소한 뒤에 새 경매를 등록해주세요.' })
  const b = req.body || {}
  const itemName = String(b.itemName || '').trim()
  const endAt = Number(b.endAt)
  if (!itemName) return res.json({ success: false, error: '물건 이름을 입력해주세요' })
  if (!endAt || endAt <= Date.now()) return res.json({ success: false, error: '종료 시간을 미래로 설정해주세요' })
  const visibility = ['public', 'price_blind', 'info_blind', 'full_blind'].includes(b.visibility) ? b.visibility : 'public'
  const auc = {
    id: a.nextId++, itemName, status: 'active', visibility,
    endAt, createdAt: Date.now(), joined: {}, bids: {}, winner: null,
  }
  a.list.push(auc)
  saveAuction(req.djId, a)
  res.json({ success: true, auction: auc })
})
app.post('/auction/:id/end', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const a = getAuctionSettings(req.djId, settings)
  const id = parseInt(req.params.id, 10)
  const auc = a.list.find(x => x.id === id)
  if (!auc) return res.json({ success: false, error: '없는 경매예요.' })
  if (auc.status !== 'active') return res.json({ success: false, error: '이미 종료되었거나 취소된 경매예요.' })
  auctionEnd(req.djId, a, id, 'ended')
  res.json({ success: true })
})
app.post('/auction/:id/cancel', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const a = getAuctionSettings(req.djId, settings)
  const id = parseInt(req.params.id, 10)
  const auc = a.list.find(x => x.id === id)
  if (!auc) return res.json({ success: false, error: '없는 경매예요.' })
  if (auc.status !== 'active') return res.json({ success: false, error: '이미 종료되었거나 취소된 경매예요.' })
  auctionEnd(req.djId, a, id, 'cancelled')
  res.json({ success: true })
})
app.post('/auction/:id/delete', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const a = getAuctionSettings(req.djId, settings)
  const id = parseInt(req.params.id, 10)
  const idx = a.list.findIndex(x => x.id === id)
  if (idx < 0) return res.json({ success: false, error: '없는 경매예요.' })
  if (a.list[idx].status === 'active') return res.json({ success: false, error: '진행중인 경매는 먼저 종료/취소해주세요.' })
  a.list.splice(idx, 1)
  saveAuction(req.djId, a)
  res.json({ success: true })
})
app.post('/auction/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'auction', req.djId)) return res.json({ success: false, error: '경매 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const a = getAuctionSettings(req.djId, settings)
  const b = req.body || {}
  if (b.enabled != null) a.config.enabled = !!b.enabled
  if (b.announceOnBid != null) a.config.announceOnBid = !!b.announceOnBid
  const cmdKeys = ['cmd', 'cmdMyBid', 'cmdEnd', 'cmdCancel']
  cmdKeys.forEach(k => { if (b[k] != null) { let v = String(b[k]).trim(); if (v && !v.startsWith('!')) v = '!' + v; if (v) a.config[k] = v.slice(0, 30) } })
  saveAuction(req.djId, a)
  res.json({ success: true })
})

app.get('/stock/leaderboard', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const list = Object.values(stock.users).filter(u => u.started).map(u => ({ tag: u.tag, nickname: u.nickname, total: stkTotalAssets(stock, u), cash: u.cash || 0, loan: u.loan || 0, creditBad: !!u.creditBad })).sort((a, b) => b.total - a.total).slice(0, 20)
  res.json({ success: true, users: list })
})
app.post('/stock/reset', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  stock.users = {}
  stock.chatAccrual = {}
  store.saveSettings(req.djId, { stock })
  res.json({ success: true })
})

// ── 🍞 증권거래소 유저 관리 화면 (전부 고유닉 기준) ──
app.get('/stock/users', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const q = String(req.query.q || '').trim().toLowerCase()
  let list = Object.values(stock.users).map(u => ({
    tag: u.tag, nickname: u.nickname,
    cash: u.cash || 0, deposit: u.deposit || 0, loan: u.loan || 0,
    stockValue: (() => { let v = 0; for (const name in u.holdings) { const h = u.holdings[name]; const st = stock.stocks.find(s => s.name === name); if (st && h) v += h.qty * st.price }; return v })(),
    total: stkTotalAssets(stock, u),
    started: !!u.started, creditBad: !!u.creditBad,
  }))
  if (q) list = list.filter(u => u.tag.includes(q) || String(u.nickname || '').toLowerCase().includes(q))
  list.sort((a, b) => b.total - a.total)
  res.json({ success: true, users: list, count: list.length })
})
app.post('/stock/users/:tag/adjust', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const tag = String(req.params.tag || '').trim().toLowerCase()
  const delta = Number((req.body || {}).delta)
  if (!tag || !Number.isFinite(delta) || delta === 0) return res.json({ success: false, error: '올바른 금액을 입력해주세요.' })
  const u = stock.users[tag]
  if (!u) return res.json({ success: false, error: '없는 유저예요.' })
  u.cash = Math.max(0, (u.cash || 0) + delta)
  store.saveSettings(req.djId, { stock })
  setTimeout(() => sendChatToRoom(req.djId, `🎁 [운영자] ${u.nickname}님(@${u.tag}) 잔액이 ${delta > 0 ? '+' : ''}${delta.toLocaleString()}원 조정됐어요. (현재 현금: ${Math.round(u.cash).toLocaleString()}원)`), 300)
  res.json({ success: true, user: u })
})
app.delete('/stock/users/:tag', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const stock = getStockSettings(req.djId, settings)
  const tag = String(req.params.tag || '').trim().toLowerCase()
  if (!stock.users[tag]) return res.json({ success: false, error: '없는 유저예요.' })
  delete stock.users[tag]
  delete stock.chatAccrual[tag]
  store.saveSettings(req.djId, { stock })
  res.json({ success: true })
})

app.get('/fishing/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const fishing = getFishingSettings(req.djId, settings)
  res.json({ success: true, config: fishing.config, userCount: Object.keys(fishing.users).length })
})
app.post('/fishing/settings', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'fishing', req.djId)) return res.json({ success: false, error: '낚시 게임 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const fishing = getFishingSettings(req.djId, settings)
  const body = req.body || {}
  const numKeys = ['fishingCooldown', 'dailyMoney', 'slotMinBet', 'diceWinExp', 'diceLoseExp', 'creditTier1Points', 'creditTier1Loan', 'creditTier2Points', 'creditTier2Loan', 'creditTier3Points', 'creditTier3Loan', 'theftBaseRate', 'theftLevelBonus', 'theftMaxRate']
  const textKeys = ['fishList', 'eventFishList', 'shopProducts', 'itemShop', 'collections', 'djTags']
  if (body.enabled != null) fishing.config.enabled = !!body.enabled
  numKeys.forEach(k => { if (body[k] != null) fishing.config[k] = Number(body[k]) || 0 })
  textKeys.forEach(k => { if (body[k] != null) fishing.config[k] = String(body[k]).slice(0, 20000) })
  store.saveSettings(req.djId, { fishing })
  res.json({ success: true })
})
app.get('/fishing/leaderboard', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const fishing = getFishingSettings(req.djId, settings)
  const list = Object.values(fishing.users).sort((a, b) => (b.balance || 0) - (a.balance || 0)).slice(0, 20)
    .map(u => ({ tag: u.tag, nickname: u.nickname, balance: u.balance || 0, level: u.level || 1, total_fish_count: u.total_fish_count || 0 }))
  res.json({ success: true, users: list })
})
app.post('/fishing/reset', auth.requireAuth, (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (req.djId !== SHARED_TOKEN_DJID) {
    // 관리자가 아니어도 본인 계정 방송 데이터는 리셋 가능 (자기 방송이니까)
  }
  const fishing = getFishingSettings(req.djId, settings)
  fishing.users = {}
  store.saveSettings(req.djId, { fishing })
  res.json({ success: true })
})

// ── 🎣 팝블리네 낚시대회 (fishing 게임과 별개의 독립 모듈) ──
app.get('/fishtournament/settings', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  res.json({ success: true, config: ft.config, userCount: Object.keys(ft.users).length })
})
app.post('/fishtournament/settings', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  if (!isModuleOn(settings, 'fishtournament', req.djId)) return res.json({ success: false, error: '팝블리네 낚시대회 메뉴가 꺼져있어요. 사이드바에서 먼저 켜주세요.' })
  const ft = getFishTournamentSettings(req.djId, settings)
  const body = req.body || {}
  const textKeys = ['shopTitle', 'startCommand', 'shopCommand', 'voucherCommand', 'myCatchCommand', 'giveCommand', 'listCommand', 'resetCommand', 'logCommand', 'helpCommand', 'rankCommand', 'rankTitle']
  for (let i = 1; i <= FT_KEEP_SLOTS; i++) textKeys.push('keep' + i + 'Name')
  if (body.enabled != null) ft.config.enabled = !!body.enabled
  if (body.giveAdminOnly != null) ft.config.giveAdminOnly = !!body.giveAdminOnly
  if (body.staffFreeSpin != null) ft.config.staffFreeSpin = !!body.staffFreeSpin
  if (body.rankTopN != null) ft.config.rankTopN = Number(body.rankTopN) || 5
  textKeys.forEach(k => { if (body[k] != null) ft.config[k] = String(body[k]).slice(0, 20000) })
  if (Array.isArray(body.baits)) {
    ft.config.baits = body.baits.slice(0, 200).map(b => ({
      name: String(b.name || '').slice(0, 60),
      cmd: String(b.cmd || '').slice(0, 60),
      priceLabel: String(b.priceLabel || '').slice(0, 60),
      rouletteIdx: Math.min(FT_ROULETTE_SLOTS, Math.max(1, parseInt(b.rouletteIdx, 10) || 1)),
    })).filter(b => b.name && b.cmd)
  }
  for (let i = 1; i <= FT_ROULETTE_SLOTS; i++) {
    const key = 'roulette' + i
    if (Array.isArray(body[key])) {
      ft.config[key] = body[key].slice(0, 200).map(r => ({
        content: String(r.content || '').slice(0, 60),
        score: parseInt(r.score, 10) || 0,
        chance: parseFloat(r.chance) || 0,
        keepIdx: Math.min(FT_KEEP_SLOTS, Math.max(1, parseInt(r.keepIdx, 10) || 1)),
      })).filter(r => r.content)
    }
  }
  saveFishTournament(req.djId, ft)
  res.json({ success: true })
})
app.get('/fishtournament/leaderboard', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  const list = Object.values(ft.users).map(u => ({
    tag: u.tag, nickname: u.nickname,
    total: Object.values(u.tanks || {}).reduce((s, t) => s + (t.total || 0), 0),
    vouchers: Object.values(u.vouchers || {}).reduce((s, n) => s + (n || 0), 0),
  })).sort((a, b) => b.total - a.total).slice(0, 20)
  res.json({ success: true, users: list })
})
// 닉네임/고유닉으로 검색 가능한 등록 유저 목록. 유저 관리/유저 어항 탭에서 사용.
app.get('/fishtournament/users', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  const q = String(req.query.q || '').trim().toLowerCase()
  let list = Object.values(ft.users)
  if (q) list = list.filter(u => String(u.nickname || '').toLowerCase().includes(q) || String(u.tag || '').toLowerCase().includes(q))
  list = list.map(u => ({
    tag: u.tag,
    nickname: u.nickname,
    vouchers: u.vouchers || {},
    voucherTotal: Object.values(u.vouchers || {}).reduce((s, n) => s + (n || 0), 0),
    tanks: u.tanks || {},
    total: Object.values(u.tanks || {}).reduce((s, t) => s + (t.total || 0), 0),
    registeredAt: u.registeredAt,
  })).sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || '')))
  res.json({ success: true, users: list, count: list.length })
})
app.post('/fishtournament/give', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  const { tag, nickname, baitName, count } = req.body || {}
  if (!tag || !baitName) return res.json({ success: false, error: '대상과 미끼이름이 필요합니다.' })
  const baits = _ftGetBaitList(ft.config)
  const bait = _ftFindBaitByName(baits, baitName)
  if (!bait) return res.json({ success: false, error: '해당 이름의 미끼를 찾을 수 없습니다.' })
  const user = getFtUser(ft, String(tag).replace(/^@/, ''), nickname)
  const key = bait.cmd.toLowerCase()
  user.vouchers[key] = (user.vouchers[key] || 0) + (Number(count) || 1)
  saveFishTournament(req.djId, ft)
  res.json({ success: true, voucherCount: user.vouchers[key] })
})
app.post('/fishtournament/reset', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  const { tag } = req.body || {}
  if (tag) {
    const u = ft.users[String(tag).replace(/^@/, '')]
    if (u) { u.vouchers = {}; u.tanks = {} }
  } else {
    ft.users = {}
  }
  saveFishTournament(req.djId, ft)
  res.json({ success: true })
})
// 👤 유저 어항: DJ가 특정 유저의 어항 기록을 수동으로 추가/삭제 (룰렛 결과 보정용)
app.post('/fishtournament/tank/add', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  const { tag, nickname, keepIdx, content, score, qty } = req.body || {}
  const name = String(content || '').trim()
  if (!tag || !name) return res.json({ success: false, error: '대상과 물고기 이름이 필요합니다.' })
  const idx = Math.min(FT_KEEP_SLOTS, Math.max(1, parseInt(keepIdx, 10) || 1))
  const cnt = Math.max(1, parseInt(qty, 10) || 1)
  const sc = parseInt(score, 10) || 0
  const user = getFtUser(ft, String(tag).replace(/^@/, ''), nickname)
  const tank = _ftEnsureTank(user, idx)
  if (!tank.items[name]) tank.items[name] = { score: sc, qty: 0 }
  tank.items[name].score = sc
  tank.items[name].qty += cnt
  tank.total = Object.values(tank.items).reduce((s, it) => s + (it.score || 0) * (it.qty || 0), 0)
  saveFishTournament(req.djId, ft)
  res.json({ success: true, tank })
})
app.post('/fishtournament/tank/remove', auth.requireAuth, requireRequestModuleAccess('fishtournament'), (req, res) => {
  const settings = store.getSettings(req.djId) || {}
  const ft = getFishTournamentSettings(req.djId, settings)
  const { tag, keepIdx, content, qty } = req.body || {}
  const name = String(content || '').trim()
  const idx = Math.min(FT_KEEP_SLOTS, Math.max(1, parseInt(keepIdx, 10) || 1))
  const user = ft.users[String(tag || '').replace(/^@/, '')]
  const tank = user && user.tanks[String(idx)]
  if (!tank || !tank.items[name]) return res.json({ success: false, error: '해당 항목을 찾을 수 없습니다.' })
  const removeCnt = qty == null ? tank.items[name].qty : Math.max(1, parseInt(qty, 10) || 1)
  tank.items[name].qty -= removeCnt
  if (tank.items[name].qty <= 0) delete tank.items[name]
  tank.total = Object.values(tank.items).reduce((s, it) => s + (it.score || 0) * (it.qty || 0), 0)
  saveFishTournament(req.djId, ft)
  res.json({ success: true, tank })
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
  const { listType, action, text, amount } = req.body || {}
  const key = listType === 'keep' ? 'keepList' : listType === 'event' ? 'eventList' : 'miscList'
  const settings = store.getSettings(req.djId) || {}
  const rec = getHistoryRec(settings, req.params.tag)
  if (action === 'add' && text) rec[key][text] = (rec[key][text] || 0) + 1
  else if (action === 'inc' && text) rec[key][text] = (rec[key][text] || 0) + 1
  else if (action === 'dec' && text) {
    if (rec[key][text] != null) {
      rec[key][text] -= 1
      if (rec[key][text] <= 0) delete rec[key][text]
    }
  }
  else if (action === 'set' && text) {
    const n = Math.max(0, Math.floor(Number(amount) || 0))
    if (n <= 0) delete rec[key][text]
    else rec[key][text] = n
  }
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
          stopStockTimers(djId)
          clearReminderTimers(room)
          clearTtsAccess(room)
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
  stopStockTimers(djId)
  clearReminderTimers(room)
  clearTtsAccess(room)
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

// 🏆 채팅 화면 하단 "오늘의 MVP" — 선물/좋아요/채팅 각 1명씩
app.get('/chat/today-mvp', auth.requireAuth, (req, res) => {
  const room = getRoom(req.djId)
  const bucket = getTodayMvpBucket(room)
  const topOf = (map) => {
    const entries = Object.values(map)
    if (!entries.length) return null
    return entries.reduce((a, b) => (b.value > a.value ? b : a))
  }
  res.json({ success: true, gift: topOf(bucket.gift), like: topOf(bucket.like), chat: topOf(bucket.chat) })
})

// 📢 관리자 실시간 공지 — djId를 안 붙이고 브로드캐스트해서, 지금 접속해있는 모든 DJ의
// 웹 화면(채팅창)에 전부 나타나게 한다. (SSE 필터 로직상 djId가 없는 메시지는 전체에게 전달됨)
app.post('/admin/announce', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '관리자만 공지를 보낼 수 있어요' })
  const message = String((req.body || {}).message || '').trim()
  if (!message) return res.json({ success: false, error: '공지 내용을 입력해주세요' })
  broadcast({ type: 'announce', message, ts: Date.now() })
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

// 어떤 라우트에서도 처리되지 못한 오류(예: 업로드 파일이 body 용량 제한을 넘어서 express.json이
// 자체적으로 거부하는 경우 등)가 나면, Express 기본 HTML 에러 페이지 대신 JSON으로 내려준다.
// 이게 없으면 프론트엔드에서 "Unexpected token '<', <!DOCTYPE..." 같은 혼란스러운 에러만 보이게 된다.
app.use((err, req, res, next) => {
  console.log('[처리되지 않은 오류]', err && err.message)
  if (res.headersSent) return next(err)
  const status = (err && err.status) || (err && err.statusCode) || 500
  const msg = status === 413
    ? '업로드한 파일이 너무 커요. 20MB 이하로 줄여서 다시 시도해주세요.'
    : ((err && err.message) || '서버 오류가 발생했어요')
  res.status(status).json({ success: false, error: msg })
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
