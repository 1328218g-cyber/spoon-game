const WebSocket = require('ws')
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const tokenManager = require('./tokenManager')
const store = require('./store')
const auth = require('./auth')
const { buildMigrationPatch } = require('./localMigrate')
const r2Backup = require('./r2Backup')

// 🛡️ 치명적 오류로 서버 전체가 죽는 것을 방지 — 처리 안 된 예외(uncaughtException)나
// 처리 안 된 프로미스 거부(unhandledRejection)가 하나라도 나오면 Node.js는 기본적으로
// 프로세스 전체를 즉시 종료시킨다. 이렇게 되면 "가끔씩 본섭이 다운되는" 원인 파악이 안 되고,
// 그냥 Railway가 재시작해줄 때까지(또는 수동 재시작 전까지) 완전히 접속 불가 상태가 된다.
// 여기서 잡아서 로그만 남기고 프로세스는 계속 살려두면, 웬만한 오류는 그 순간의 요청/타이머만
// 실패하고 넘어가고 서비스 전체는 안 죽는다. (진짜 메모리 부족 등 복구 불가능한 상태라면
// 어차피 Railway의 헬스체크/재시작이 알아서 처리해준다.)
process.on('uncaughtException', (err) => {
  console.error('[치명적 오류 — uncaughtException] 서버는 계속 실행됩니다:', err && err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[치명적 오류 — unhandledRejection] 서버는 계속 실행됩니다:', reason)
})
// 🔮 사주팔자 — package.json에 npm install 전이어도 서버 전체가 죽지 않도록 안전하게 불러온다.
// (설치 안 된 상태로 배포되면 require 자체가 예외를 던져서 서버가 통째로 크래시하는 문제가 있었음)
let calculateSaju = null, calculateSajuSimple = null
try {
  ; ({ calculateSaju, calculateSajuSimple } = require('@fullstackfamily/manseryeok'))
} catch (e) {
  console.log('[사주팔자] @fullstackfamily/manseryeok 패키지가 설치되지 않았어요. "npm install @fullstackfamily/manseryeok --save" 실행 후 다시 배포해주세요. 그 전까지 사주팔자 기능은 자동으로 비활성화됩니다.')
}

const app = express()
app.set('trust proxy', 1) // Railway는 프록시 뒤에 있어서, 이걸 켜야 req.ip가 실제 접속자 IP를 가리킴 (중복가입 방지에 사용)
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '85mb' })) // 이미지 업로드가 60MB까지 허용되면서(base64 인코딩 시 약 1.33배) 여유있게 상향
app.use(require('express').static(__dirname + '/public'))

// 🎵 입장/좋아요/지정인사 등에 첨부하는 음원 파일 — 예전엔 base64로 인코딩해서 djs.json 안에
// 직접 저장했는데, 이게 파일 하나당 최대 1MB까지 그대로 djs.json에 쌓이면서 (그리고 store.js
// 캐시 때문에 메모리에도 통째로 올라가면서) 결국 서버가 메모리 초과(OOM)로 죽는 사고가 났다.
// 그래서 지금은 실제 파일로 Volume(store.DATA_DIR)에 저장하고, 설정에는 URL 경로만 남긴다.
const SOUNDS_DIR = path.join(store.DATA_DIR, 'sounds')
if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true })
// 🔊 기본 알림음(default-chime.mp3, reaction-timer-alert.mp3)이 아직 없으면 자동으로 채워넣는다.
// (SOUNDS_DIR는 git 추적 폴더가 아니라 런타임 데이터 폴더라, git에 파일을 올려도 여기엔 안 생김)
try {
  const defaultSounds = require('./defaultSounds')
  Object.entries(defaultSounds).forEach(([filename, base64]) => {
    const filePath = path.join(SOUNDS_DIR, filename)
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
      console.log(`[기본 알림음] ${filename} 생성됨`)
    }
  })
} catch (e) {
  console.log('[기본 알림음] 초기화 실패:', e.message)
}
app.use('/sounds', require('express').static(SOUNDS_DIR, { maxAge: '30d' }))

// 🖼️ 박제판 배경 이미지 등, base64를 djs.json에 직접 안 넣기 위한 이미지 전용 저장소.
// sounds와 완전히 같은 이유/같은 방식 — Volume에 실제 파일로 저장하고 URL만 설정에 남긴다.
const IMAGES_DIR = path.join(store.DATA_DIR, 'images')
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true })
app.use('/images', require('express').static(IMAGES_DIR, { maxAge: '30d' }))

// 🔤 내정보 웹페이지에 쓸 수 있는, 관리자가 직접 첨부한 폰트 파일(woff2/woff/ttf/otf).
// sounds/images와 완전히 같은 이유/같은 방식 — Volume에 실제 파일로 저장하고 URL만 설정에 남긴다.
const FONTS_DIR = path.join(store.DATA_DIR, 'fonts')
if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true })
app.use('/fonts', require('express').static(FONTS_DIR, { maxAge: '30d' }))

const GW_BASE = 'https://kr-gw.spooncast.net'
const API_BASE = 'https://api.spooncast.net'
const KR_API_BASE = 'https://kr-api.spooncast.net'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 👋 입장/좋아요/퇴장 기본 인사 문구 — DJ가 설정 화면에서 한 번도 "저장"을 안 눌러도
// (즉 settings.joinMessages 등이 아직 서버에 없어도) 모듈만 켜면 바로 동작하도록 하는 기본값.
// DJ가 실제로 설정 화면에서 저장하면 그 값으로 대체된다.
const DEFAULT_JOIN_MESSAGES = [{ id: 0, enabled: true, target: '', text: '{nickname}님 반가워요! ❤️', delay: 1, sound: '' }]
const DEFAULT_LIKE_MESSAGES = [{ id: 0, enabled: true, target: '', text: '{nickname}님 좋아요 감사해요! 💓', delay: 1, sound: '' }]
const DEFAULT_LEAVE_MESSAGES = [{ id: 0, enabled: true, target: '', text: '{nickname}님 다음에 또 만나요! 👋', delay: 1, sound: '' }]

const zlib = require('zlib')

// JSON 텍스트는 반복되는 필드명이 많아서 압축이 매우 잘 된다 (보통 80~95% 줄어듦).
// Base44 텍스트 필드 용량 제한에 걸리는 걸 피하려고, 보낼 때 gzip 압축 후 base64로 인코딩한다.
function compressForBackup(obj) {
  const json = JSON.stringify(obj)
  return zlib.gzipSync(Buffer.from(json, 'utf-8')).toString('base64')
}
// 압축된 데이터를 원래대로 복원한다. 혹시 예전에 비압축으로 저장된 백업이 남아있을 수도 있어서,
// gzip 해제가 실패하면 그냥 평범한 JSON 문자열로 간주하고 그대로 파싱을 시도한다(하위 호환).
function decompressBackup(rawStr) {
  try {
    const buf = Buffer.from(rawStr, 'base64')
    const decompressed = zlib.gunzipSync(buf).toString('utf-8')
    return JSON.parse(decompressed)
  } catch (e) {
    return JSON.parse(rawStr) // 압축 안 된 예전 형식 fallback
  }
}

// 🌐 외부(Base44) 자동 백업 — Railway 볼륨이 또 손상되는 최악의 경우를 대비해서, 완전히 별개의
// 외부 서버에도 유저 데이터를 주기적으로 복사해둔다. DJ별로 개별 레코드로 저장해서, 나중에 필요할 때
// 특정 고유닉(djId) 하나만 콕 집어서 복구할 수 있게 한다. 환경변수로 안 넣어두면 아래 기본값
// (2026-08-10 정식 배포 시 확인된 고정 주소)을 그대로 쓴다 — 보안이 신경쓰이면 Railway Variables에
// BASE44_BACKUP_URL / BASE44_BACKUP_KEY로 옮기고 아래 기본값은 지워도 된다.
// ✅ 2026-08-10: Base44 앱을 정식 배포(Publish)해서 고정 도메인(tested-snap-vault-sync.base44.app)을
// 받았다. "preview--..." 처럼 계속 바뀌던 임시 주소 문제는 이제 해결됨.
const BASE44_BACKUP_URL = process.env.BASE44_BACKUP_URL || 'https://tested-snap-vault-sync.base44.app/functions/saveBackup'
const BASE44_BACKUP_KEY = process.env.BASE44_BACKUP_KEY || '1328218'
// 🔄 복구용 조회 함수 — 같은 Base44 앱 도메인
const BASE44_RESTORE_URL = process.env.BASE44_RESTORE_URL || 'https://tested-snap-vault-sync.base44.app/functions/getBackup'
const BASE44_RESTORE_KEY = process.env.BASE44_RESTORE_KEY || BASE44_BACKUP_KEY
// 📋 백업 목록 조회 함수 — 특정 djId로 저장된 백업들을 최신순으로 여러 개 보여줄 때 사용
const BASE44_LIST_URL = process.env.BASE44_LIST_URL || 'https://tested-snap-vault-sync.base44.app/functions/listBackups'
const BASE44_LIST_KEY = process.env.BASE44_LIST_KEY || BASE44_BACKUP_KEY
async function fetchBackupFromBase44(djId) {
  const res = await fetch(`${BASE44_RESTORE_URL}?djId=${encodeURIComponent(djId)}`, {
    headers: { 'x-api-key': BASE44_RESTORE_KEY },
  })
  if (res.status === 404) return { found: false }
  if (!res.ok) throw new Error(`getBackup 응답 ${res.status}`)
  const body = await res.json()
  // 응답 구조를 정확히 몰라서 여러 형태를 다 시도해본다 (raw entity 반환일 수도, 단순화된 형태일 수도 있음)
  const rec = body.record || body.result || body
  const rawData = rec.data != null ? rec.data : (body.data != null ? body.data : null)
  if (rawData == null) return { found: false, raw: body }
  const parsed = typeof rawData === 'string' ? decompressBackup(rawData) : rawData
  return { found: true, timestamp: rec.timestamp || body.timestamp || null, data: parsed, raw: body }
}
// 📋 특정 djId로 저장된 백업들을 최신순으로 최대 20개까지 가져온다 (목록에서 골라서 복구하기 위함).
async function listBackupsFromBase44(djId, limit = 20) {
  const res = await fetch(`${BASE44_LIST_URL}?djId=${encodeURIComponent(djId)}&limit=${limit}`, {
    headers: { 'x-api-key': BASE44_LIST_KEY },
  })
  if (res.status === 404) return { items: [], raw: null }
  if (!res.ok) throw new Error(`listBackups 응답 ${res.status}`)
  const body = await res.json()
  console.log(`[listBackups 원본응답] djId=${djId}:`, JSON.stringify(body).slice(0, 800))
  // 응답 구조가 배열 자체일 수도, { results: [...] } 형태일 수도 있어서 여러 형태 다 시도
  const items = Array.isArray(body) ? body
    : Array.isArray(body.results) ? body.results
    : Array.isArray(body.records) ? body.records
    : Array.isArray(body.data) ? body.data
    : Array.isArray(body.backups) ? body.backups
    : Array.isArray(body.items) ? body.items
    : []
  const parsed = items.map(item => {
    let parsedData = null
    try { parsedData = typeof item.data === 'string' ? decompressBackup(item.data) : item.data } catch (e) { /* 이 항목만 건너뜀 */ }
    return { timestamp: item.timestamp, data: parsedData }
  }).filter(item => item.data != null)
  return { items: parsed, raw: parsed.length ? null : body } // 파싱 결과가 비었을 때만 원본을 같이 돌려줘서 진단 가능하게
}
// 📦 백업 범위를 줄인다 — 이미지/음원처럼 용량 큰 항목이 섞여있는 전체 계정 대신,
// 룰렛/룰렛기록/애청지수/반복문구/단축명령어 이 5개만 뽑아서 백업한다.
function extractBackupSubset(djRecord) {
  const s = (djRecord && djRecord.settings) || {}
  return {
    roulette: s.roulette || null,
    rouletteHistory: s.rouletteHistory || null,
    activity: s.activity || null,
    entryDataRepeat: (s.entryData && s.entryData.repeat) || [], // 반복문구는 entryData 안의 한 카테고리라 이것만 뽑음
    commands: s.commands || null, // 단축명령어
  }
}

// ⏭️ 자동 백업 변경감지용 — djId별로 "마지막에 실제로 Base44에 보낸 내용"을 기억해둔다.
// (서버 재시작하면 초기화되는데, 그러면 다음 자동백업 1번은 그냥 다시 보내지는 정도라 문제 없음)
const lastBackupSubsetStr = new Map()

async function backupOneDjToBase44(djId, djRecord) {
  const subset = extractBackupSubset(djRecord)
  const compressedData = compressForBackup(subset)
  const bodyStr = JSON.stringify({ timestamp: new Date().toISOString(), djId, data: compressedData })
  const res = await fetch(BASE44_BACKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BASE44_BACKUP_KEY },
    body: bodyStr,
  })
  const sizeBytes = Buffer.byteLength(bodyStr, 'utf-8')
  if (!res.ok) {
    // ⚠️ 진단용 — 실패하면 보낸 데이터 크기랑 Base44가 돌려준 실제 에러 본문을 로그 + 반환값 둘 다에 남긴다.
    const errText = await res.text().catch(() => '(응답 본문 읽기 실패)')
    console.log(`[Base44 백업 실패 상세] djId=${djId} 요청크기(압축후)=${sizeBytes}바이트 status=${res.status} 응답본문:`, errText.slice(0, 500))
    return { ok: false, status: res.status, sizeBytes, errText: errText.slice(0, 500) }
  }
  return { ok: true, status: res.status, sizeBytes }
}
async function backupToBase44() {
  const snapshot = store.getRawSnapshot()
  const djIds = Object.keys(snapshot)
  let okCount = 0, failCount = 0, skipCount = 0
  for (const id of djIds) {
    try {
      // ⏭️ 자동 백업 전용 변경감지 — 지난번에 보낸 것과 지금 데이터가 똑같으면 그냥 건너뛴다.
      // (수동으로 "지금 바로 백업" 누르는 버튼은 이 로직을 안 거치고 항상 그대로 실행됨)
      const subsetStr = JSON.stringify(extractBackupSubset(snapshot[id]))
      if (lastBackupSubsetStr.get(id) === subsetStr) { skipCount++; continue }
      const res = await backupOneDjToBase44(id, snapshot[id])
      if (res.ok) { okCount++; lastBackupSubsetStr.set(id, subsetStr) }
      else { failCount++; console.log(`[Base44 백업] ${id} 실패 응답:`, res.status) }
    } catch (e) {
      failCount++
      console.log(`[Base44 백업] ${id} 오류:`, e.message)
    }
  }
  console.log(`[Base44 백업] 완료 — 성공 ${okCount}건 / 실패 ${failCount}건 / 변경없음(건너뜀) ${skipCount}건 (전체 ${djIds.length}명)`)
}

// ⚠️ 지금은 djId별 멀티 계정 대신, 대부분의 DJ가 관리자(sum) 계정의 토큰을 공유해서 사용한다.
// (tokenManager 자체는 계속 djId 기반 멀티 계정을 지원하므로, 나중에 다시 DJ별로 나누고 싶으면
//  아래 상수 대신 실제 djId를 넘기도록 되돌리기만 하면 된다.)
// ⚠️ SHARED_TOKEN_DJID는 게임/설정 저장용 "관리자 공용 네임스페이스"로도 계속 쓰이기 때문에
// (globalMonsterCatalog, worldBoss 등) 건드리지 않는다 — 웹소켓 접속 계정 선택 로직만 아래 풀로 분리.
const SHARED_TOKEN_DJID = 'sum'

// 🔀 공용 계정 풀 — 스푼이 계정 하나당 동시 접속(웹소켓) 개수를 제한하는 것으로 보여서,
// 공용 계정 하나만 쓰면 동접 DJ가 일정 인원(약 19~20명)을 넘는 순간부터 새 DJ가 방에
// 못 들어가게 된다. 공용 계정을 여러 개 등록해두고, 앞 계정이 SHARED_TOKEN_CAPACITY만큼
// 차면 다음 계정으로 자동으로 넘겨서 받는다.
// 풀에 넣을 계정은 실제로 그 djId로 에디봇에 가입한 뒤 "세션 연결" 화면에서 스푼 세션을
// 올려둬야 한다(=본인 계정 취급). Railway 환경변수 SHARED_TOKEN_POOL에 "sum,sum2"처럼
// 콤마로 나열하면 되고, 안 정해두면 기존처럼 sum 하나만 쓴다.
const SHARED_TOKEN_POOL = (process.env.SHARED_TOKEN_POOL || SHARED_TOKEN_DJID)
  .split(',').map(s => s.trim()).filter(Boolean)
const SHARED_TOKEN_CAPACITY = Number(process.env.SHARED_TOKEN_CAPACITY || 18) // 계정 하나당 이 인원(동접)까지만 받고 다음 계정으로 넘김

// 지금 그 공용 계정 토큰으로 실제 연결돼있는(room.isConnected) DJ가 몇 명인지 센다.
// ⚠️ rooms를 직접 순회만 하고 getRoom()은 절대 안 부른다 — getRoom은 없으면 room을 새로 만들기
// 때문에, 여기서 잘못 부르면 room 개수가 쓸데없이 계속 불어난다.
function countConnectedOnToken(tokenDjId) {
  let n = 0
  for (const djId of Object.keys(rooms)) {
    const room = rooms[djId]
    if (room && room.isConnected && room.tokenDjId === tokenDjId) n++
  }
  return n
}

// 공용 계정 풀 중 지금 제일 여유 있는(세션 연결돼있고, 정원 안 찬) 계정을 고른다.
// 전부 꽉 찼거나 세션이 없으면 그래도 뭔가는 리턴해야 하니 그중 가장 여유 있는 곳으로 폴백한다.
// 🎲 여유 있는(정원 안 찬) 공용 계정 중에서 랜덤으로 하나를 골라서 쓴다 — sum부터 순서대로
// 다 채우고 나서야 sum2로 넘어가는 방식이 아니라, 방송을 시작할 때마다 그때 여유 있는
// 계정들 중 무작위로 배정한다. 여러 계정에 골고루 부하가 퍼지게 하려는 목적.
function pickSharedTokenDjId() {
  const available = []
  for (const tokenDjId of SHARED_TOKEN_POOL) {
    if (!tokenManager.hasCookies(tokenDjId)) continue // 세션 연결 안 된 계정은 건너뜀
    if (!tokenManager.getAccessToken(tokenDjId)) continue // 세션은 있지만 토큰 발급이 안 됐거나 만료된 계정도 건너뜀 (있으면 접속 시도할 때마다 계속 실패함)
    if (countConnectedOnToken(tokenDjId) < SHARED_TOKEN_CAPACITY) available.push(tokenDjId)
  }
  if (available.length) return available[Math.floor(Math.random() * available.length)]
  // 전부 꽉 찼으면(또는 세션 연결된 계정이 하나도 없으면) 그나마 가장 여유 있는 곳으로 폴백한다.
  let fallback = null
  let fallbackCount = Infinity
  for (const tokenDjId of SHARED_TOKEN_POOL) {
    if (!tokenManager.hasCookies(tokenDjId)) continue
    if (!tokenManager.getAccessToken(tokenDjId)) continue
    const count = countConnectedOnToken(tokenDjId)
    if (count < fallbackCount) { fallbackCount = count; fallback = tokenDjId }
  }
  return fallback || SHARED_TOKEN_DJID
}

// 🔀 각 DJ가 본인 스푼 계정 세션을 직접 업로드했으면 그 계정 토큰을 쓰고,
// 안 올렸으면(대부분의 경우) 공용 계정 풀에서 여유 있는 계정을 골라서 쓴다.
// ⚠️ getRoom()을 쓰지 않고 rooms[djId]를 직접 조회한다 — 이 함수는 15초마다 도는
// 자동입장 감시(checkAdminAutoJoin)에서 "가입된 djId 전체"를 대상으로 호출되기 때문에,
// 여기서 room을 새로 만들면 방송 안 하는 계정들 것까지 room 객체가 계속 쌓이게 된다.
// 이미 room이 있는(=실제 접속을 시도해본 적 있는) DJ에 한해서만 배정을 room에 기억해두고
// 재사용한다(재부팅 전까진 안 바뀜) — 없으면 그냥 매번 다시 고르되 아무것도 안 남긴다.
function tokenDjIdFor(djId) {
  if (tokenManager.hasCookies(djId)) return djId
  const existingRoom = rooms[djId]

  // 🎯 DJ가 입장설정에서 특정 공용 계정을 직접 골라뒀으면 1순위로 그 계정을 쓰되,
  // 세션이 없거나 이미 정원(SHARED_TOKEN_CAPACITY)이 꽉 찼으면 자동 배정 로직으로 자연스럽게 넘어간다.
  // (loadDjs가 메모리 캐시라서 여기서 매번 읽어도 부담 없음 — 이 함수는 매우 자주 호출됨)
  try {
    const preferred = store.getSettings(djId)?.preferredTokenDjId
    if (preferred && SHARED_TOKEN_POOL.includes(preferred) && tokenManager.hasCookies(preferred)
      && tokenManager.getAccessToken(preferred) // 세션은 있어도 토큰이 없거나 만료됐으면 이 계정으로 계속 접속 시도해봐야 실패만 반복되니, 그럴 땐 자동배정으로 넘긴다
      && countConnectedOnToken(preferred) < SHARED_TOKEN_CAPACITY) {
      if (existingRoom) existingRoom.tokenDjId = preferred
      return preferred
    }
  } catch (e) {}

  if (existingRoom && existingRoom.tokenDjId && SHARED_TOKEN_POOL.includes(existingRoom.tokenDjId)) {
    return existingRoom.tokenDjId
  }
  const picked = pickSharedTokenDjId()
  if (existingRoom) existingRoom.tokenDjId = picked
  return picked
}

// 🔑 구글 보이스(TTS) API 키 — Railway 환경변수(Variables)에 GOOGLE_TTS_API_KEY로 등록해서 사용한다.
// 절대 프론트엔드(index.html) 코드에 직접 넣지 않는다 — 브라우저 소스보기로 그대로 노출되기 때문.
// 이 키는 서버가 구글 API를 대신 호출할 때만 쓰이고, 클라이언트에는 절대 전달되지 않는다.
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || ''

// 🔗 자체 단축 URL 시스템 — buly.kr 같은 외부 서비스는 클라우드 서버(Railway) IP에서 오는
// 요청을 조용히 막는(응답 자체를 안 주는) 경우가 있어서, 외부 서비스에 의존하지 않고
// 에디봇 서버 자체에서 짧은 링크를 만들어 저장해뒀다가 리다이렉트해준다.
const SHORTLINKS_FILE = path.join(store.DATA_DIR, 'shortlinks.json')
let shortlinksCache = null
function loadShortlinks() {
  if (shortlinksCache) return shortlinksCache
  try {
    shortlinksCache = JSON.parse(fs.readFileSync(SHORTLINKS_FILE, 'utf8'))
  } catch (e) {
    shortlinksCache = {}
  }
  return shortlinksCache
}
function saveShortlinks() {
  try {
    fs.mkdirSync(path.dirname(SHORTLINKS_FILE), { recursive: true })
    fs.writeFileSync(SHORTLINKS_FILE, JSON.stringify(shortlinksCache, null, 2))
  } catch (e) {
    console.log('[단축링크] 저장 실패:', e.message)
  }
}
function makeShortCode() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 헷갈리는 0/O/1/I/l 제외
  const map = loadShortlinks()
  let code
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('') } while (map[code])
  return code
}
app.post('/shorten-url', auth.requireAuth, (req, res) => {
  const longUrl = String((req.body || {}).url || '').trim()
  if (!longUrl) return res.json({ success: false, error: 'URL을 입력해주세요' })
  if (!/^https?:\/\//.test(longUrl)) return res.json({ success: false, error: 'http(s):// 로 시작하는 URL만 단축할 수 있어요' })
  const map = loadShortlinks()
  const existingCode = Object.keys(map).find(c => map[c].url === longUrl) // 같은 주소는 코드 재사용
  const code = existingCode || makeShortCode()
  if (!existingCode) { map[code] = { url: longUrl, createdAt: Date.now(), djId: req.djId }; saveShortlinks() }
  res.json({ success: true, shortUrl: `${req.protocol}://${req.get('host')}/s/${code}` })
})
app.get('/s/:code', (req, res) => {
  const map = loadShortlinks()
  const entry = map[req.params.code]
  if (!entry) return res.status(404).send('존재하지 않거나 만료된 링크예요.')
  res.redirect(entry.url)
})

// 디제이별 방(연결) 상태. djId -> { ws, isConnected, streamName, roomToken, autoJoinedFor, checking }
const rooms = {}
function getRoom(djId) {
  if (!rooms[djId]) {
    rooms[djId] = { ws: null, isConnected: false, streamName: '', roomToken: '', autoJoinedFor: '', watchingTag: '', checking: false, liveDjUserId: null, djProfileUrl: '', tagCache: new Map(), tagToNickname: new Map(), profileUrlCache: new Map() }
  }
  return rooms[djId]
}

let sseClients = []

// ══════════════════════════════════════════════════════
// 세션 쿠키 기반 accessToken 자동 갱신 (기본은 관리자 공용 계정, 본인 계정 연결한 DJ는 그 계정으로 개별 갱신)
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

// 🩺 디버그 로그 실시간 방송 — console.log를 가로채서, 서버 로그(Railway)로 나가는 그대로
// 관리자 대시보드의 "디버그 로그" 화면에도 실시간으로 뿌려준다. 새 모듈을 만들 때마다 이 화면에
// 따로 연결할 필요 없이, 그냥 console.log(`[뭐뭐디버그:${djId}] ...`) 찍기만 하면 자동으로 여기
// 보인다 — Railway 로그를 직접 뒤질 필요 없게 하려는 목적.
const _originalConsoleLog = console.log.bind(console)
console.log = function (...args) {
  _originalConsoleLog(...args)
  try {
    const message = args.map(a => {
      if (typeof a === 'string') return a
      try { return JSON.stringify(a) } catch (e) { return String(a) }
    }).join(' ')
    broadcast({ type: 'debuglog', message, ts: Date.now() })
  } catch (e) { /* 로그 방송 자체가 실패해도 원래 로그 출력에는 영향 없게 무시 */ }
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

// 스푼 API가 JSON 대신 HTML(레이트리밋/차단/게이트웨이 에러 페이지 등)을 돌려줄 때가 있다.
// res.json()이 바로 던지는 "Unexpected token '<'" 만으로는 원인을 알 수 없어서, 실패하면
// status 코드 + 응답 본문 앞부분을 같이 남긴다.
async function safeJson(res, label) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    console.log(`[${label}] JSON 파싱 실패 — status=${res.status} 응답 앞부분:`, text.slice(0, 300).replace(/\s+/g, ' '))
    throw e
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
    const json = await safeJson(res, 'tag 조회')
    const profile = (json.results && json.results[0]) || json
    // ⚠️ 스푼 API가 가끔(권한 문제 등으로) 요청한 유저가 아니라 "봇 계정 자신의" 프로필을
    // 잘못 돌려주는 경우가 있다. 응답의 id가 우리가 물어본 userId와 다르면 무조건 무시한다.
    // (이걸 안 걸러내면 서로 다른 시청자의 기록이 전부 봇 계정 태그 하나로 뒤섞여버림)
    const returnedId = profile.id != null ? Number(profile.id) : (profile.user_id != null ? Number(profile.user_id) : null)
    if (returnedId != null && returnedId !== Number(userId)) {
      console.log(`[tag 조회 불일치] 요청 userId=${userId} 응답 id=${returnedId} → 무시하고 null 처리 / 원본응답:`, JSON.stringify(json).slice(0, 500))
      return null
    }
    let tag = profile.tag || profile.tag_name || profile.username || profile.id_name || null
    if (tag) tag = String(tag).replace('@', '').trim()
    if (!tag) {
      // ⚠️ 진단용: 왜 태그를 못 뽑았는지 원본 응답을 그대로 남긴다 (status 코드 + 응답 본문 앞부분)
      console.log(`[tag 추출 실패] userId=${userId} status=${res.status} / 원본응답:`, JSON.stringify(json).slice(0, 500))
    }
    return tag
  } catch (e) {
    console.log('[tag 조회 오류]', e.message)
    return null
  }
}

// /member/{userId}/profile/ 단건 조회가 특정 유저에게서 계속 실패(권한 문제, id 불일치 등)할 때를 위한 보조 수단.
// 실시간 접속자 목록(/lives/{liveId}/members/)에서 같은 id를 찾아 태그를 대신 확보한다.
// (이 목록은 단건 프로필 조회와 다른 엔드포인트라 "봇 계정 자신의 프로필을 잘못 돌려주는" 문제가 없다)
async function fetchUserTagFromLiveMembers(liveId, userId, accessToken) {
  if (!liveId || userId == null || !accessToken) return null
  try {
    const members = await fetchLiveMembers(liveId, accessToken, 3)
    const found = members.find(m => m.id != null && Number(m.id) === Number(userId))
    return (found && found.tag) ? found.tag : null
  } catch (e) {
    return null
  }
}

// 방송(live)과 완전히 무관한 일반 유저 프로필 API. /users/{userId}/follow/ 처럼 이미 다른 기능에서
// userId만으로 쓰고 있는 엔드포인트 계열이라, 방송 멤버 조회가 계속 실패하는 특정 계정도 이쪽은
// 성공할 가능성이 있어 세 번째 보조 수단으로 시도한다. (실제 응답 필드는 확인 전이라 여러 이름을 다 시도)
async function fetchUserTagFromGeneralProfile(userId, accessToken) {
  if (userId == null || !accessToken) return null
  try {
    const res = await fetch(`${KR_API_BASE}/users/${userId}/`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': CHROME_UA,
        'Origin': 'https://www.spooncast.net',
      }
    })
    const json = await res.json()
    const profile = (json.results && json.results[0]) || json
    const returnedId = profile.id != null ? Number(profile.id) : (profile.user_id != null ? Number(profile.user_id) : null)
    if (returnedId != null && returnedId !== Number(userId)) return null // 다른 사람 프로필이면 무시
    let tag = profile.tag || profile.tag_name || profile.username || profile.id_name || null
    if (tag) tag = String(tag).replace('@', '').trim()
    if (!tag) console.log(`[tag 추출 실패(일반프로필)] userId=${userId} status=${res.status} / 원본응답:`, JSON.stringify(json).slice(0, 500))
    return tag
  } catch (e) {
    return null
  }
}

// 한 번 성공적으로 확인된 유저의 태그는 room별로 캐시해서 계속 재사용한다.
// (스푼 프로필 조회 API가 가끔 결과가 오락가락하는 문제가 있어서, 매번 새로 조회하면
//  선물 시점과 명령어 입력 시점에 서로 다른 값이 나와 기록이 어긋나는 문제가 생김.
//  한 번 확실하게(요청 userId와 응답 id가 일치) 확인된 값만 캐시하고, 이후엔 API를 다시 부르지 않는다.)
// 태그 조회 재시도 횟수/간격. 특정 유저에게서 계속 실패하는 문제를 줄이려고 바로 포기하지 않고
// 단건 조회 → 실시간 접속자 목록, 두 소스를 번갈아 몇 차례 더 시도한다 (네트워크/API 일시 오류 대비).
const TAG_RESOLVE_MAX_TRIES = 4
const TAG_RESOLVE_RETRY_DELAY_MS = 450

// 🚪 RoomJoin 시점 태그 조회 추가 재시도 — 방금 막 들어온 유저는 getCachedUserTag의 내부
// 재시도(위 4회)를 전부 거쳐도 스푼 서버에 정보가 아직 안 붙어있어서 실패할 때가 가끔 있다.
// 그 상태로 넘어가면 "지정 인사"가 그 방문 동안은 영영 안 나가고(닉네임 키로 이미 인사 처리됨
// 처리됨), 진짜로 나갔다 다시 들어와야만(퇴장 감지 후 재입장) 다시 시도된다. 그래서 포기하기 전에
// 시간 간격을 늘려가며 몇 번 더 시도한다.
const JOIN_TAG_EXTRA_RETRIES = [1200, 2500, 4000]

async function getCachedUserTag(room, liveId, userId, accessToken) {
  if (userId == null) return null
  if (room && room.tagCache && room.tagCache.has(userId)) {
    return room.tagCache.get(userId)
  }
  let tag = null
  for (let attempt = 1; attempt <= TAG_RESOLVE_MAX_TRIES && !tag; attempt++) {
    tag = await fetchUserTag(liveId, userId, accessToken)
    if (!tag) {
      // 단건 조회 실패 → 실시간 접속자 목록에서 보정 시도 (특정 유저에서 계속 닉네임 키로
      // 기록이 새로 생기는 문제, 즉 고유닉 조회가 매번 실패하는 문제를 줄이기 위함)
      tag = await fetchUserTagFromLiveMembers(liveId, userId, accessToken)
    }
    if (!tag) {
      // 그래도 실패하면 방송과 무관한 일반 유저 프로필 API로 세 번째 시도
      tag = await fetchUserTagFromGeneralProfile(userId, accessToken)
      if (tag) console.log(`[tag 확보] userId=${userId} → 일반 프로필 API에서 확보 성공`)
    }
    if (!tag && attempt < TAG_RESOLVE_MAX_TRIES) {
      await new Promise(r => setTimeout(r, TAG_RESOLVE_RETRY_DELAY_MS))
    }
  }
  if (tag) {
    console.log(`[tag 확보] userId=${userId} → "${tag}"`)
  } else {
    console.log(`[tag 조회 최종실패] userId=${userId} — ${TAG_RESOLVE_MAX_TRIES}회 재시도 후에도 고유닉을 확인 못함`)
  }
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
      const json = await safeJson(res, 'fetchLiveMembers')
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
      const id = m.id != null ? Number(m.id) : (m.user_id != null ? Number(m.user_id) : (m.user && m.user.id != null ? Number(m.user.id) : null))
      return { id, tag, nickname: nickname || tag, imgUrl }
    }).filter(Boolean)
  } catch (e) {
    console.log('[fetchLiveMembers 오류]', e.message)
    return []
  }
}

// 지금 방송에 실제로 접속 중인 사람인지 태그 또는 닉네임으로 확인한다. (룰렛지급/복권지급/상점 등
// DJ가 직접 대상을 지정하는 명령어에서, 고유닉을 잘못 입력해도 조용히 지급되던 문제를 막기 위해 사용)
async function findLiveMemberByNickOrTag(djId, liveId, input) {
  const norm = String(input || '').trim().toLowerCase()
  if (!norm) return null
  const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
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
      djProfileUrl: live.author?.profile_url || live.author?.profileUrl || live.author?.image_url || live.user?.profile_url || live.user?.profileUrl || '',
    }
  } catch (e) {
    console.log('[stream_name 오류]', e.message)
    return { streamName: String(liveId), djUserId: null, djProfileUrl: '' }
  }
}

// 📢 공지사항 변경 — PUT https://kr-api.spooncast.net/lives/{liveId}/ (개발자도구로 실측 확인된 주소).
// ⚠️ 실제 응답을 확인해보니, 웹소켓 이벤트(LiveMetaUpdate)는 camelCase(bgImageUrl, isMute...)를 쓰는데
// 이 REST API는 snake_case(img_url, is_mute...)를 쓰는 완전히 다른 스키마였다. 그래서 room.lastLiveMeta를
// 그대로 보내면 필드 이름이 하나도 안 맞아서 전부 무시됐다(200은 오지만 반영 안 됨).
// → GET으로 스푼이 실제로 쓰는 스키마 그대로 현재 상태를 받아온 뒤, 그 안에서 "공지" 필드를 바꾼다.
// ⚠️ "welcome_message"가 실제 앱 Payload 캡처로 확인된 정확한 필드명이다.
// ⚠️ GET 응답을 통째로 다시 PUT하면 403이 났다 — room_token(서명된 임시 토큰), url_hls(서명된 스트림
//   주소), author(읽기 전용 프로필) 같은 서버 전용/읽기 전용 필드까지 같이 보내서 거부된 것으로 보인다.
//   그래서 실제 앱 Payload 캡처에서 확인된 "진짜로 수정 가능한 필드들"만 화이트리스트로 추려서 보낸다.
const NOTICE_FIELD_NAME = 'welcome_message'
const LIVE_EDITABLE_FIELDS = [
  'title', 'welcome_message', 'type', 'categories', 'tags', 'allow_donations',
  'engine', 'invite_member_ids', 'is_adult', 'is_save', 'is_access_ghost_user',
  'is_live_call', 'is_live_call_donation', 'donation',
]
async function updateSpoonNotice(djId, liveId, newNotice) {
  const room = getRoom(djId)
  const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
  if (!accessToken || !liveId) return { ok: false, error: '방송에 연결돼있지 않아요' }
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': CHROME_UA,
    'Origin': 'https://www.spooncast.net',
    'Referer': `https://www.spooncast.net/kr/live/${liveId}`,
  }
  // ⚠️ 채팅 전송(sendChatToRoom)처럼, "지금 이 방송에 실시간으로 들어와있다"는 걸 증명하는
  // roomToken도 같이 실어보낸다. 이게 빠져있어서 서버가 조용히 무시했을 가능성이 있다.
  if (room.roomToken) headers['x-live-authorization'] = `Bearer ${room.roomToken}`
  // ⚠️ 진짜 브라우저는 같은 도메인 요청에 쿠키를 자동으로 같이 보내는데, 우리 서버는 지금까지
  // 쿠키를 전혀 안 보내고 있었다. title은 반영되고 welcome_message만 무시되는 패턴을 보면,
  // 민감한 필드(공지처럼 사람들에게 바로 노출되는 텍스트)에 세션 쿠키 기반 추가 검증이 있을 수 있다.
  const cookieHeader = tokenManager.getCookieHeader(tokenDjIdFor(djId))
  if (cookieHeader) headers['Cookie'] = cookieHeader
  try {
    // 1) 먼저 GET으로 스푼이 실제로 쓰는 스키마(snake_case) 그대로 현재 상태를 받아온다.
    const getRes = await fetch(`${KR_API_BASE}/lives/${liveId}/`, { headers })
    const getText = await getRes.text().catch(() => '')
    if (!getRes.ok) {
      console.log(`[공지변경:${djId}] GET 실패 status=${getRes.status}:`, getText.slice(0, 500))
      return { ok: false, error: `현재 상태 조회 실패 (${getRes.status})` }
    }
    const getBody = JSON.parse(getText)
    const current = (getBody.results && getBody.results[0]) || getBody
    console.log(`[공지변경:${djId}] GET으로 받은 현재 ${NOTICE_FIELD_NAME} 값:`, current[NOTICE_FIELD_NAME])

    // 2) 읽기전용/서버전용 필드는 빼고, 실제로 수정 가능한 필드들만 골라서 새 본문을 만든다.
    const updated = {}
    for (const key of LIVE_EDITABLE_FIELDS) {
      if (current[key] !== undefined) updated[key] = current[key]
    }
    updated[NOTICE_FIELD_NAME] = newNotice
    // device_unique_id는 실제 앱 Payload에서 UA 문자열을 정리해서 보내던 필드 — 형식만 비슷하게 맞춰서 채운다.
    updated.device_unique_id = CHROME_UA.replace(/\s+/g, '').toLowerCase()
    console.log(`[공지변경:${djId}] 추려서 보낼 본문:`, JSON.stringify(updated).slice(0, 500))

    // 3) 그대로 PUT
    const putRes = await fetch(`${KR_API_BASE}/lives/${liveId}/`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    })
    const putText = await putRes.text().catch(() => '')
    console.log(`[공지변경:${djId}] PUT 응답 status=${putRes.status}:`, putText.slice(0, 1500))
    if (!putRes.ok) return { ok: false, error: `응답 ${putRes.status}`, detail: putText.slice(0, 300) }

    // 4) 실제로 반영됐는지 응답에서 다시 확인
    const putBody = JSON.parse(putText)
    const after = (putBody.results && putBody.results[0]) || putBody
    if (after[NOTICE_FIELD_NAME] === newNotice) {
      return { ok: true }
    }
    console.log(`[공지변경:${djId}] ⚠️ PUT은 성공했지만 반영 확인 안 됨. 응답의 ${NOTICE_FIELD_NAME}:`, after[NOTICE_FIELD_NAME])
    return { ok: false, error: `"${NOTICE_FIELD_NAME}" 필드가 정확한 공지 필드가 아닐 수 있어요 (반영 안 됨)` }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function sendChatToRoom(djId, message) {
  const room = getRoom(djId)
  const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
  if (!room.streamName || !accessToken) {
    console.log(`[채팅전송 실패][${djId}] streamName=${room.streamName || '없음'}, accessToken=${accessToken ? '있음' : '없음'} — 메시지가 전송되지 않았어요:`, message)
    return false
  }
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
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.log(`[채팅전송 실패][${djId}] 응답 ${res.status}:`, body.slice(0, 300), '— 메시지:', message)
      // ⚠️ 404는 "이 방송(streamName)이 더 이상 존재하지 않는다"는 뜻이다 — 방송이 이미
      // 끝났는데 WS 쪽에는 아직 종료 이벤트가 안 와서 room.isConnected가 계속 true로 남아있는
      // 상태(좀비 연결)일 가능성이 크다. 이걸 그냥 두면 채팅 전송이 계속 404로 실패하다가
      // 한참 뒤에야 스푼 쪽에서 강제로 WS를 끊어버려서 "가끔씩 봇이 팅긴다"처럼 보인다.
      // 여기서 바로 ws를 끊어버리면 기존 ws.on('close') 정리 로직이 그대로 타면서(자동입장이면)
      // 곧바로 재접속을 시도하게 된다.
      if (res.status === 404 && room.ws) {
        console.log(`[${djId}] 채팅 전송 404 — 방송이 끝난 것으로 보여 연결을 정리합니다.`)
        try { room.ws.terminate() } catch (e) { /* 이미 끊어졌으면 무시 */ }
      }
      return false
    }
    console.log(`[채팅:${djId}]`, message, '응답:', res.status)
    return true
  } catch (e) {
    console.log(`[채팅:${djId} 오류]`, e.message)
    return false
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
const EXPIRY_EXEMPT_KEYS = ['chat', 'entrysettings', 'funding', 'roulettelog', 'reactiontimer', 'dday']
const NEW_MODULE_DEFAULT_OFF_KEYS = ['lottoauto', 'reactiontimer', 'dday', 'raffle', 'dice', 'soundfx', 'tts', 'wheelroulette', 'couponcheck', 'usernotes', 'discordnotify', 'fishing', 'stock', 'auction', 'randombox', 'swordgame', 'mynotes', 'pickboard', 'webpickboard', 'mafia', 'liverank', 'saju', 'memo2', 'plansub', 'viptier', 'managertoken', 'lottorank', 'trophyboard', 'monstercatch', 'myinfo', 'blinddate', 'tower'] // 새로 추가하는 모듈은 여기에 키를 등록한다 (fishtournament·chuseokevent는 아래 "요청 모듈" 접근 목록으로 관리되므로 이 목록에서 제외) — giftcapture는 기본 ON이라 여기 목록에서 제외 — tower(무한의 탑)는 안 쓰기로 해서 기본 꺼짐으로 내림
function isAccountExpired(settings, djId) {
  if (djId === 'sum') return false
  return !!(settings && settings.expiresAt && Date.now() > new Date(settings.expiresAt).getTime())
}
function isModuleOn(settings, key, djId) {
  if (isAccountExpired(settings, djId) && !EXPIRY_EXEMPT_KEYS.includes(key)) return false
  if (djId && !hasRestrictedModeAccess(djId, key, settings)) return false
  const v = settings && settings.moduleEnabled ? settings.moduleEnabled[key] : undefined
  if (v === undefined) return !NEW_MODULE_DEFAULT_OFF_KEYS.includes(key)
  return v !== false
}

// ══════════════════════════════════════════════════════
// 🔒 제한 모드(화이트리스트 모드) — 켜두면 관리자(sum) 빼고는 alwaysOnKeys에 있는 몇 개 메뉴(기본:
// 대시보드/채팅/입장설정)만 승인 없이 쓸 수 있고, 그 외 모든 메뉴는 "요청 모듈" 허용목록에
// 그 djId가 들어있어야만 열린다 (기존 요청모듈 관리 화면에서 모듈 선택 후 그 유저를 추가하면 됨).
// 대시보드는 조금 특별해서, alwaysOnKeys에 있어도 base44 연동이 켜져있으면 base44 쪽 유효회원
// 판정(settings.base44Status.found)까지 추가로 통과해야 한다 — base44Enabled가 꺼져있으면 이 조건은 건너뛴다.
// 이 기능 자체는 기본 꺼짐이라, 관리자가 admin 페이지에서 켜기 전까지는 기존 동작과 완전히 같다.
// ══════════════════════════════════════════════════════
function getRestrictedModeConfig() {
  const settings = store.getSettings(SHARED_TOKEN_DJID) || {}
  const DEFAULT_ALWAYS_ON = ['dashboard', 'myinfo', 'modulerequest', 'autojoin', 'botreboot', 'linkshortener', 'giftcapture', 'giftgallery', 'monstercatch', 'reversi', 'liverank', 'mafia']
  if (!settings.restrictedMode) {
    settings.restrictedMode = { enabled: true, alwaysOnKeys: DEFAULT_ALWAYS_ON, base44Enabled: false, base44AuthKey: '', base44IntervalMin: 5 }
    store.saveSettings(SHARED_TOKEN_DJID, { restrictedMode: settings.restrictedMode })
  }
  if (!Array.isArray(settings.restrictedMode.alwaysOnKeys)) settings.restrictedMode.alwaysOnKeys = DEFAULT_ALWAYS_ON
  return settings.restrictedMode
}
function base44IsMemberActive(djId, settings) {
  const status = settings && settings.base44Status
  return !!(status && status.found === true)
}
// 요청 모듈 허용목록 조회 (관리자 sum 계정의 settings.requestModules 배열: { targetPanel, allowedDjIds }).
// 원래는 fishtournament 같은 특수 패널 전용이었지만, 아래 hasRestrictedModeAccess가 targetPanel 자리에
// 아무 모듈 키(key)나 넣어서 재사용한다 — 관리자가 "요청 모듈" 관리 화면에서 그 모듈을 선택해 유저를
// 추가하면, 제한 모드가 켜져있을 때 그 유저에게만 해당 메뉴가 열리는 식으로 그대로 동작한다.
function isRequestModuleAllowed(targetPanel, djId) {
  if (djId === 'sum') return true // 관리자는 모든 요청 모듈에 항상 접근 가능
  const list = store.getRequestModules()
  return list.some(m => m.targetPanel === targetPanel && (m.allowedDjIds || []).includes(djId))
}
// 🔒 신규가입 유저에게 항상 보이는 메뉴 — 관리자 화면에서 값을 바꾼 적 없이도(설정에 뭐가 저장돼있든)
// 무조건 이 12개로 고정한다. 예전에 admin 화면에서 한 번 저장했던 값이 계속 남아서 안 바뀌는
// 문제가 있었어서, 아예 저장된 값을 안 쓰고 코드에 직접 박아둔다.
const RESTRICTED_MODE_ALWAYS_ON_KEYS = ['dashboard', 'myinfo', 'modulerequest', 'autojoin', 'botreboot', 'linkshortener', 'giftcapture', 'giftgallery', 'monstercatch', 'reversi', 'liverank', 'mafia']
function hasRestrictedModeAccess(djId, key, settings) {
  const cfg = getRestrictedModeConfig()
  if (djId === SHARED_TOKEN_DJID) return true // 관리자는 항상 전체 허용
  if (key === 'dashboard' && cfg.base44Enabled && !base44IsMemberActive(djId, settings)) return false
  if (RESTRICTED_MODE_ALWAYS_ON_KEYS.includes(key)) return true
  return isRequestModuleAllowed(key, djId) // 기존 요청모듈 허용목록을 그대로 재사용 (targetPanel=모듈 키)
}
// 베이스44(외부 회원관리 서버)에 djId 한 명의 회원 상태를 조회해서 settings.base44Status에 캐싱한다.
// 매 요청마다 외부 API를 부르면 느리고 위험하니, 아래 startBase44Checker()가 주기적으로만 갱신한다.
// base44 getMember API를 직접 호출하는 공용 함수 — auth_key 없으면 호출 자체를 안 하고 null을 돌려준다.
async function base44FetchMember(uniqueNick) {
  const cfg = getRestrictedModeConfig()
  if (!cfg.base44AuthKey) return null
  const res = await fetch('https://massive-user-vault-flow.base44.app/functions/getMember', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_key: cfg.base44AuthKey, unique_nick: uniqueNick, nickname: uniqueNick })
  })
  return res.json().catch(() => ({}))
}
async function checkBase44MemberStatus(djId) {
  const cfg = getRestrictedModeConfig()
  if (!cfg.base44Enabled || !cfg.base44AuthKey) return
  try {
    const data = await base44FetchMember(djId) || {}
    const status = {
      found: !!data.found,
      reason: data.reason || null,
      expireAt: data.expire_at || null,
      isTester: !!data.is_tester,
      isPermanent: !!data.is_permanent,
      checkedAt: Date.now(),
    }
    store.saveSettings(djId, { base44Status: status })
  } catch (e) {
    console.log(`[base44][${djId}] 조회 실패:`, e.message)
  }
}
let base44Timer = null
function startBase44Checker() {
  if (base44Timer) { clearInterval(base44Timer); base44Timer = null }
  const cfg = getRestrictedModeConfig()
  if (!cfg.base44Enabled) return
  const intervalMs = Math.max(1, Number(cfg.base44IntervalMin) || 5) * 60000
  const run = async () => {
    const c = getRestrictedModeConfig()
    if (!c.base44Enabled) return
    for (const djId of store.listDjIds()) {
      if (djId === SHARED_TOKEN_DJID) continue
      await checkBase44MemberStatus(djId)
    }
  }
  run()
  base44Timer = setInterval(run, intervalMs)
}
app.get('/restrictedmode-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  res.json({ success: true, data: getRestrictedModeConfig() })
})
app.post('/restrictedmode-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const cfg = getRestrictedModeConfig()
  const { base44Enabled, base44AuthKey, base44IntervalMin } = req.body || {}
  if (base44Enabled != null) cfg.base44Enabled = !!base44Enabled
  if (base44AuthKey != null) cfg.base44AuthKey = String(base44AuthKey).trim()
  if (base44IntervalMin != null) cfg.base44IntervalMin = Math.max(1, Math.min(120, parseInt(base44IntervalMin, 10) || 5))
  store.saveSettings(SHARED_TOKEN_DJID, { restrictedMode: cfg })
  startBase44Checker()
  res.json({ success: true })
})
// 관리자가 특정 유저 한 명만 즉시 다시 조회하고 싶을 때 (매번 몇 분씩 기다리지 않도록)
app.post('/restrictedmode-admin/recheck/:djId', auth.requireAuth, async (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  await checkBase44MemberStatus(req.params.djId)
  const settings = store.getSettings(req.params.djId) || {}
  res.json({ success: true, status: settings.base44Status || null })
})
// 관리자가 아무 고유닉이나 입력해서 base44에 직접 유료 여부/남은 기간을 즉석에서 조회한다.
// (로컬 djId 계정이랑 무관하게, base44 쪽 데이터만 그대로 보여준다 — 조회 결과를 저장하진 않음)
app.post('/restrictedmode-admin/base44-lookup', auth.requireAuth, async (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const cfg = getRestrictedModeConfig()
  if (!cfg.base44AuthKey) return res.json({ success: false, error: 'base44 auth_key가 아직 설정 안 됐어요. 위에서 먼저 저장해주세요.' })
  const uniqueNick = String((req.body || {}).uniqueNick || '').trim()
  if (!uniqueNick) return res.json({ success: false, error: '고유닉을 입력해주세요' })
  try {
    const data = await base44FetchMember(uniqueNick)
    res.json({ success: true, data })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})
// 🎫 일반 유저 본인용 — 회원가입 후 본인 계정(djId)이 base44에서 유료회원으로 잡히는지 스스로
// 확인할 수 있게 해준다. 관리자용 조회와 달리 본인 djId로만 조회 가능(다른 사람 조회는 못 함)하고,
// 매번 base44에 실시간으로 물어본다(캐시된 값이 아니라 방금 결제했는지도 바로 확인 가능하도록).
app.get('/base44/mine', auth.requireAuth, async (req, res) => {
  const cfg = getRestrictedModeConfig()
  if (!cfg.base44AuthKey) return res.json({ success: false, error: '아직 이용권 확인 기능이 준비되지 않았어요. 잠시 후 다시 시도해주세요.' })
  try {
    const data = await base44FetchMember(req.djId)
    res.json({ success: true, data })
  } catch (e) {
    res.json({ success: false, error: '조회 중 오류가 발생했어요.' })
  }
})
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
      const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
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

// 🚩 깃발 목표(goal)가 있으면 그 이상 못 올라가게 막고, 이번 적립으로 "방금 막 채워졌는지"를 알려준다.
// (goal이 0/미설정이면 상한 없이 그냥 누적 — 목표 없는 깃발은 완료 개념이 없다)
const DEFAULT_FLAG_FULL_MSG = '🎉 [{title}] 깃발을 다 찾았어요! ({current}/{goal})'
function applyFlagDelta(flag, delta) {
  const goal = Number(flag.goal) || 0
  const before = Number(flag.current) || 0
  const wasFull = goal > 0 && before >= goal
  let next = before + delta
  if (goal > 0) next = Math.min(next, goal)
  flag.current = next
  const isFull = goal > 0 && next >= goal
  return { justCompleted: isFull && !wasFull }
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

  const { justCompleted } = applyFlagDelta(flag, delta)
  store.saveSettings(djId, { flags })
  broadcast({ type: 'flags', djId, items: flags.items })
  setTimeout(() => sendChatToRoom(djId, renderFlagTemplate(flag.template, flag, idx1)), 400)
  if (justCompleted) {
    setTimeout(() => sendChatToRoom(djId, renderFlagTemplate(flag.msgFull || DEFAULT_FLAG_FULL_MSG, flag, idx1)), 900)
  }
}

// 선물(도네이션) 수신 시 "자동 적립" 깃발에 수량만큼 자동 반영
function handleFlagAutoDonation(djId, settings, amount) {
  if (!isModuleOn(settings, 'flag', djId)) return
  const flags = settings.flags
  if (!flags || !flags.items || !flags.items.length || !amount) return
  let changed = false
  const completed = []
  flags.items.forEach((f, i) => {
    if (f.mode === 'auto') {
      const { justCompleted } = applyFlagDelta(f, amount)
      changed = true
      if (justCompleted) completed.push({ flag: f, idx1: i + 1 })
    }
  })
  if (changed) {
    store.saveSettings(djId, { flags })
    broadcast({ type: 'flags', djId, items: flags.items })
    completed.forEach(({ flag, idx1 }) => {
      setTimeout(() => sendChatToRoom(djId, renderFlagTemplate(flag.msgFull || DEFAULT_FLAG_FULL_MSG, flag, idx1)), 900)
    })
  }
}

// 💰 펀딩 — 깃발의 "자동 적립(mode==='auto')"과 동일한 방식. 항목별로 자동 적립을 켜두면
// 선물(스푼) 받을 때마다 그 항목의 current에 자동으로 더해진다.
function handleFundingAutoDonation(djId, settings, amount) {
  if (!isModuleOn(settings, 'funding', djId)) return
  const funding = settings.funding
  if (!funding || !funding.items || !funding.items.length || !amount) return
  let changed = false
  funding.items.forEach(it => {
    if (it.mode === 'auto') { it.current = (it.current || 0) + amount; changed = true }
  })
  if (changed) {
    store.saveSettings(djId, { funding })
    broadcast({ type: 'funding', djId, items: funding.items })
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

// ============================================================
// 💘 소개팅 매니저 — 커플 목록 / 강전 후보 스택 / 비토·비마 스푼 지갑
// (참고: 별도 소개팅 매니저 확장앱의 커플·강전·지갑 기능을 에디봇 채팅 명령어 방식으로 이식)
// ============================================================

// 구버전 계정은 settings에 blindDate 필드가 없을 수 있으므로, 처음 쓰는 시점에 기본값을 채워 저장해둔다.
function getBlindDateSettings(djId, settings) {
  if (!settings.blindDate) {
    settings.blindDate = {
      cmdCouple: '!커플', cmdStrong: '!강전', cmdWalletView: '!지갑', cmdWalletAdd: '!비토', cmdWalletSub: '!비마',
      pageSize: 10, couples: [], strongCandidates: [], wallet: { balance: 0, updatedAt: null },
    }
    store.saveSettings(djId, { blindDate: settings.blindDate })
  }
  if (!settings.blindDate.wallet) settings.blindDate.wallet = { balance: 0, updatedAt: null }
  if (!settings.blindDate.couples) settings.blindDate.couples = []
  if (!settings.blindDate.strongCandidates) settings.blindDate.strongCandidates = []
  return settings.blindDate
}

function bdNextId(list) {
  return (list.reduce((max, it) => Math.max(max, Number(it.id) || 0), 0)) + 1
}

// 등록된 커플/강전 목록을 다른 페이지네이션 명령어(!킵 등)와 동일한 형식으로 출력한다.
function bdPaginate(items, page, pageSize, formatLine, emptyMsg, header, cmdHint) {
  if (!items.length) return emptyMsg
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const cur = Math.max(1, Math.min(page || 1, totalPages))
  const start = (cur - 1) * pageSize
  const pageItems = items.slice(start, start + pageSize)
  let msg = `${header} (${cur}/${totalPages}페이지, 총 ${items.length}개)\n`
  pageItems.forEach((it, i) => { msg += formatLine(it, start + i + 1) + '\n' })
  if (totalPages > 1) {
    const next = cur < totalPages ? cur + 1 : 1
    msg += `\n💡 ${cmdHint} ${next} 로 다른 페이지 확인`
  }
  return msg.trim()
}

// !커플 목록 [페이지] / !커플 추가 태그1 태그2 [강제] / !커플 삭제 [번호] / !커플 초기화 / !커플 전체초기화
function handleBlindDateCoupleCommand(djId, room, bd, text, isDj, isManager) {
  const base = bd.cmdCouple
  if (!base) return
  const raw = String(text || '').trim()
  if (!raw.startsWith(base)) return
  const rest = raw.slice(base.length).trim()
  const parts = rest.split(/\s+/).filter(Boolean)
  const sub = parts[0] || ''
  const canManage = isDj || isManager

  if (sub === '목록' || sub === '') {
    const page = parseInt(parts[1], 10) || 1
    const msg = bdPaginate(
      bd.couples, page, bd.pageSize || 10,
      (c, idx) => `${idx}. ${c.nickA}${c.forced ? '💍' : '💕'}${c.nickB}`,
      '💕 등록된 커플이 없습니다.', '💕 커플 목록', `${base} 목록`
    )
    setTimeout(() => sendChatToRoom(djId, msg), 400)
    return
  }

  if (sub === '추가') {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 커플 추가 권한이 없어요'), 400); return }
    const args = parts.slice(1)
    const forced = args.some(p => p === '강제')
    const tagArgs = args.filter(p => p !== '강제') // @ 없이 고유닉만 입력해도 됨 (혹시 @가 붙어있어도 알아서 제거)
    if (tagArgs.length < 2) { setTimeout(() => sendChatToRoom(djId, `❌ 사용법: ${base} 추가 태그1 태그2 [강제]`), 400); return }
    const tagA = tagArgs[0].replace('@', '').toLowerCase()
    const tagB = tagArgs[1].replace('@', '').toLowerCase()
    if (!tagA || !tagB || tagA === tagB) { setTimeout(() => sendChatToRoom(djId, '❌ 같은 사람은 커플로 등록할 수 없어요'), 400); return }
    const nickA = resolveNicknameFromInput(room, tagArgs[0])
    const nickB = resolveNicknameFromInput(room, tagArgs[1])
    const dup = bd.couples.find(c => (c.tagA === tagA && c.tagB === tagB) || (c.tagA === tagB && c.tagB === tagA))
    if (dup) { setTimeout(() => sendChatToRoom(djId, '❌ 이미 등록된 커플이에요'), 400); return }
    bd.couples.push({ id: bdNextId(bd.couples), tagA, nickA, tagB, nickB, forced, createdAt: new Date().toISOString() })
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'couples', couples: bd.couples })
    setTimeout(() => sendChatToRoom(djId, `✅ 커플 등록 완료! ${nickA}${forced ? '💍' : '💕'}${nickB}`), 400)
    return
  }

  if (sub === '삭제') {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 커플 삭제 권한이 없어요'), 400); return }
    const idx1 = parseInt(parts[1], 10)
    const target = idx1 ? bd.couples[idx1 - 1] : null
    if (!target) { setTimeout(() => sendChatToRoom(djId, `❌ 사용법: ${base} 삭제 [번호]`), 400); return }
    bd.couples.splice(idx1 - 1, 1)
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'couples', couples: bd.couples })
    setTimeout(() => sendChatToRoom(djId, `✅ ${idx1}번 커플 삭제 완료`), 400)
    return
  }

  if (sub === '초기화') {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 커플 초기화 권한이 없어요'), 400); return }
    bd.couples = bd.couples.filter(c => c.forced) // 강제 커플은 일반 초기화로 지워지지 않음
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'couples', couples: bd.couples })
    setTimeout(() => sendChatToRoom(djId, '✅ 일반 커플 전체 삭제 완료 (강제 커플은 유지)'), 400)
    return
  }

  if (sub === '전체초기화') {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 커플 초기화 권한이 없어요'), 400); return }
    bd.couples = []
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'couples', couples: bd.couples })
    setTimeout(() => sendChatToRoom(djId, '✅ 커플 전체 삭제 완료 (강제 커플 포함)'), 400)
    return
  }
}

// !강전 목록 [페이지] / !강전 태그 [±숫자] / !강전 삭제 태그 / !강전 초기화
function handleBlindDateStrongCommand(djId, room, bd, text, isDj, isManager) {
  const base = bd.cmdStrong
  if (!base) return
  const raw = String(text || '').trim()
  if (!raw.startsWith(base)) return
  const rest = raw.slice(base.length).trim()
  const parts = rest.split(/\s+/).filter(Boolean)
  const sub = parts[0] || ''
  const canManage = isDj || isManager

  if (sub === '목록' || sub === '') {
    const page = parseInt(parts[1], 10) || 1
    const msg = bdPaginate(
      bd.strongCandidates, page, bd.pageSize || 10,
      (c, idx) => `${idx}. ${c.nickname} - ${c.stack}`,
      '🔥 등록된 강전 후보가 없습니다.', '🔥 강전 목록', `${base} 목록`
    )
    setTimeout(() => sendChatToRoom(djId, msg), 400)
    return
  }

  if (sub === '삭제') {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 강전 삭제 권한이 없어요'), 400); return }
    const tagArg = parts[1]
    if (!tagArg) { setTimeout(() => sendChatToRoom(djId, `❌ 사용법: ${base} 삭제 태그`), 400); return }
    const tag = tagArg.replace('@', '').toLowerCase()
    const before = bd.strongCandidates.length
    bd.strongCandidates = bd.strongCandidates.filter(c => c.tag !== tag)
    if (bd.strongCandidates.length === before) { setTimeout(() => sendChatToRoom(djId, '❌ 등록되지 않은 대상이에요'), 400); return }
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'strong', strongCandidates: bd.strongCandidates })
    setTimeout(() => sendChatToRoom(djId, '✅ 강전 후보 삭제 완료'), 400)
    return
  }

  if (sub === '초기화') {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 강전 초기화 권한이 없어요'), 400); return }
    bd.strongCandidates = []
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'strong', strongCandidates: bd.strongCandidates })
    setTimeout(() => sendChatToRoom(djId, '✅ 강전 후보 전체 삭제 완료'), 400)
    return
  }

  // 목록/삭제/초기화가 아니면 나머지는 전부 "태그 [증감]" 형태로 취급 (@ 붙여도, 안 붙여도 동작)
  {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 강전 조절 권한이 없어요'), 400); return }
    const tag = sub.replace('@', '').toLowerCase()
    if (!tag) return
    const nickname = resolveNicknameFromInput(room, sub)
    const delta = (parts[1] != null && /^[+-]?\d+$/.test(parts[1])) ? parseInt(parts[1], 10) : 1
    let cand = bd.strongCandidates.find(c => c.tag === tag)
    if (!cand) {
      if (delta <= 0) { setTimeout(() => sendChatToRoom(djId, '❌ 등록되지 않은 대상이에요'), 400); return }
      cand = { id: bdNextId(bd.strongCandidates), tag, nickname, stack: 0, updatedAt: new Date().toISOString() }
      bd.strongCandidates.push(cand)
    }
    cand.nickname = nickname
    cand.stack = (cand.stack || 0) + delta
    cand.updatedAt = new Date().toISOString()
    if (cand.stack <= 0) {
      bd.strongCandidates = bd.strongCandidates.filter(c => c.tag !== tag) // 스택 0 되면 자동 삭제
      store.saveSettings(djId, { blindDate: bd })
      broadcast({ type: 'blinddate', djId, section: 'strong', strongCandidates: bd.strongCandidates })
      setTimeout(() => sendChatToRoom(djId, `✅ ${nickname}님 강전 스택 소진 - 목록에서 삭제`), 400)
      return
    }
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'strong', strongCandidates: bd.strongCandidates })
    setTimeout(() => sendChatToRoom(djId, `✅ ${nickname}님 강전 스택: ${cand.stack}`), 400)
    return
  }
}

// !지갑 / !지갑 초기화 / !비토 [숫자] / !비마 [숫자] — 전부 DJ·매니저 전용 (README 기준: 조회도 DJ/매니저만)
function handleBlindDateWalletCommand(djId, bd, text, isDj, isManager) {
  const canManage = isDj || isManager
  const raw = String(text || '').trim()

  if (bd.cmdWalletView && raw === bd.cmdWalletView) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 지갑 조회 권한이 없어요'), 400); return }
    setTimeout(() => sendChatToRoom(djId, `💰 현재 지갑: ${(bd.wallet.balance || 0).toLocaleString()}개`), 400)
    return
  }
  if (bd.cmdWalletView && raw === `${bd.cmdWalletView} 초기화`) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 지갑 초기화 권한이 없어요'), 400); return }
    bd.wallet.balance = 0
    bd.wallet.updatedAt = new Date().toISOString()
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'wallet', wallet: bd.wallet })
    setTimeout(() => sendChatToRoom(djId, '✅ 지갑 초기화 완료 (0개)'), 400)
    return
  }
  if (bd.cmdWalletAdd && raw.startsWith(bd.cmdWalletAdd)) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 지갑 조절 권한이 없어요'), 400); return }
    const rest = raw.slice(bd.cmdWalletAdd.length).trim()
    const amount = parseInt(rest, 10)
    if (!rest || !Number.isFinite(amount) || amount <= 0) { setTimeout(() => sendChatToRoom(djId, `❌ 사용법: ${bd.cmdWalletAdd} [숫자]`), 400); return }
    bd.wallet.balance = (bd.wallet.balance || 0) + amount
    bd.wallet.updatedAt = new Date().toISOString()
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'wallet', wallet: bd.wallet })
    setTimeout(() => sendChatToRoom(djId, `✅ 비토 ${amount.toLocaleString()}개 추가! 현재: ${bd.wallet.balance.toLocaleString()}개`), 400)
    return
  }
  if (bd.cmdWalletSub && raw.startsWith(bd.cmdWalletSub)) {
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '❌ 지갑 조절 권한이 없어요'), 400); return }
    const rest = raw.slice(bd.cmdWalletSub.length).trim()
    const amount = parseInt(rest, 10)
    if (!rest || !Number.isFinite(amount) || amount <= 0) { setTimeout(() => sendChatToRoom(djId, `❌ 사용법: ${bd.cmdWalletSub} [숫자]`), 400); return }
    bd.wallet.balance = (bd.wallet.balance || 0) - amount
    bd.wallet.updatedAt = new Date().toISOString()
    store.saveSettings(djId, { blindDate: bd })
    broadcast({ type: 'blinddate', djId, section: 'wallet', wallet: bd.wallet })
    setTimeout(() => sendChatToRoom(djId, `▼ 비마 ${amount.toLocaleString()}개 차감! 현재: ${bd.wallet.balance.toLocaleString()}개`), 400)
    return
  }
}

// 소개팅 매니저 통합 진입점 — 메인 채팅 디스패치 체인에서 호출된다
function handleBlindDateCommand(djId, room, settings, text, isDj, isManager) {
  if (!isModuleOn(settings, 'blinddate', djId)) return
  if (!String(text || '').trim().startsWith('!')) return
  const bd = getBlindDateSettings(djId, settings)
  handleBlindDateCoupleCommand(djId, room, bd, text, isDj, isManager)
  handleBlindDateStrongCommand(djId, room, bd, text, isDj, isManager)
  handleBlindDateWalletCommand(djId, bd, text, isDj, isManager)
}

// 단축키 명령어 쿨타임 추적용 (메모리에만 유지, 재시작하면 초기화됨 — 큰 문제 없음)
const commandCooldowns = new Map() // `${djId}:${trigger}` -> timestamp(ms)

// 단축키 명령어 처리: 등록해둔 트리거와 채팅이 정확히 일치하면 응답 전송
// actTag: 이 채팅 이벤트에서 이미 한 번 조회해둔 고유닉(있으면 재사용, API 중복 호출/실패 방지)
async function handleShortcutCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  if (!isModuleOn(settings, 'shortcuts', djId)) return
  const commands = settings.commands
  if (!commands || !commands.length) return

  // ⚠️ 특수문자/장식문자(예: 《_ ᴇɴᴛʀʏ _》 같은 폰트 변형 유니코드)는 겉보기엔 똑같아도
  // 입력 경로(관리자 화면 vs 스푼 채팅)에 따라 내부적으로 다른 바이트 조합(정규화 형태)으로
  // 인코딩될 수 있어서, 그냥 === 비교로는 서로 달라서 안 맞을 수 있다. NFC로 정규화하고,
  // 눈에는 안 보이지만 값이 다를 수 있는 제로폭 문자·줄바꿈 종류·순서표시자까지 같이 걷어낸
  // 뒤 비교하면 이런 경우까지 훨씬 안정적으로 같은 문자로 인식된다.
  const stripInvisible = s => String(s || '')
    .replace(/[\u200B-\u200F\uFEFF\u2028\u2029\u00A0]/g, m => (m === '\u00A0' ? ' ' : ''))
    .trim()
  const msg = stripInvisible(text).normalize('NFC')

  // 기본은 "정확히 일치"할 때만 실행되지만, 명령어별로 "메시지 앞부분만 일치해도 실행"(prefixMatch)을
  // 켜두면 그 트리거로 시작하기만 해도 실행된다 — 외부 확장 프로그램이 "!《_ᴇɴᴛʀʏ_》 [유저정보 등]"
  // 처럼 트리거 뒤에 추가 내용을 자동으로 붙여서 보내는 경우까지 인식하기 위함.
  // 여러 트리거가 동시에 앞부분과 겹치면 가장 긴(더 구체적인) 트리거를 우선한다.
  const normalized = commands.map(c => ({ cmd: c, norm: stripInvisible(c.trigger).normalize('NFC') })).filter(x => x.norm)
  let cmd = (normalized.find(x => x.norm === msg) || {}).cmd
  if (!cmd) {
    const prefixHits = normalized.filter(x => x.cmd.prefixMatch && msg.startsWith(x.norm))
    if (prefixHits.length) cmd = prefixHits.reduce((a, b) => (b.norm.length > a.norm.length ? b : a)).cmd
  }
  if (!cmd) {
    // ⚠️ 진단용: '!'로 시작하는데(=명령어처럼 보이는데) 등록된 트리거랑 하나도 안 맞으면
    // 실제로 도착한 원문을 문자 코드까지 남긴다. 특수문자가 스푼 쪽에서 다른 문자로
    // 바뀌어서 오는 경우(예: '<' → '&lt;') 여기 로그로 바로 확인 가능하다.
    // 장식 문자가 섞인 긴 명령어도 진단할 수 있게 길이 제한을 넉넉하게 뒀다.
    if (msg.startsWith('!') && msg.length <= 40) {
      console.log(`[단축키 불일치] 원문="${msg}" 문자코드=[${Array.from(msg).map(c => c.codePointAt(0)).join(',')}]`)
    }
    return
  }

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
    if (!tag) tag = await getCachedUserTag(room, liveId, authorId, tokenManager.getAccessToken(tokenDjIdFor(djId)))
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

  sendChatSplit(djId, response, 100, 600)
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
      perms: [], // DJ 외에 리셋/마감/접수/우선온오프/이름온오프를 쓸 수 있는 고유닉 목록 (실드 관리와 동일한 방식)
      doneTemplate: '✅ [{artist} - {title}] 신청 완료! (대기: {count}번)',
      listTitle: '🎵 현재 신청곡 목록 🎵', listItemTemplate: '{index}. {artist} - {title}',
      maxCharsPerMsg: 100, msgIntervalMs: 600, items: [],
      searchSites: { spotify: false, appleMusic: false }, // 🎧 음원 사이트 빠른 검색 노출 여부 (로컬봇 기본값과 동일하게 기본은 둘 다 꺼짐)
    }
    // 최초 1회는 실제로 저장해서, 이후 /settings 조회(웹 화면)에서도 같은 값이 보이도록 한다.
    store.saveSettings(djId, { songRequest: settings.songRequest })
  }
  if (!settings.songRequest.cmdRecommend) settings.songRequest.cmdRecommend = '!추천곡'
  if (!settings.songRequest.searchSites) settings.songRequest.searchSites = { spotify: false, appleMusic: false }
  if (settings.songRequest.verifyOriginalOnRequest == null) settings.songRequest.verifyOriginalOnRequest = false
  return settings.songRequest
}

// 🎬 유튜브 완곡 재생 — 로컬봇(Electron)이 신청곡 탭에서 쓰던 것과 100% 동일한 방식.
// iTunes 미리듣기 같은 건 로컬봇에 없어서 여기서도 안 쓴다 — 오직 유튜브 한 가지.
// 실제 재생은 프론트에서 공식 유튜브 IFrame Player API로 하기 때문에, 여기서는
// "재생 버튼을 눌렀을 때 후보 영상 목록을 찾아주는" 역할만 한다 — 미리 검색해두지 않고,
// 로컬봇과 동일하게 재생 버튼을 누른 그 순간에 검색한다.
function scoreYoutubeCandidate(title, channelTitle, artist, songTitle) {
  const videoTitle = String(title || '').toLowerCase()
  const channel = String(channelTitle || '').toLowerCase()
  const artistL = String(artist || '').toLowerCase()
  const titleL = String(songTitle || '').toLowerCase()
  let score = 0
  // "- Topic" 채널은 YouTube Music이 자동 생성하는 공식 오디오 채널 — 최우선
  if (channel.endsWith(' - topic') || channel.includes('- topic')) score += 100
  if (artistL && channel.includes(artistL)) score += 30
  if (channel.includes('vevo') || channel.includes('official')) score += 25
  if (/\b(official\s*audio|audio\s*only|official\s*sound|lyrics?|가사)\b/.test(videoTitle)) score += 40
  const negativeKeywords = ['cover', '커버', 'remix', '리믹스', 'live', '라이브', 'lesson', '강의',
    'reaction', '리액션', 'tutorial', 'karaoke', '노래방', 'mr', '반주',
    'instrumental', 'piano', '피아노', 'acoustic', 'slowed', 'sped up',
    'nightcore', 'mashup', '매쉬업', 'parody', '패러디']
  for (const kw of negativeKeywords) { if (videoTitle.includes(kw)) score -= 40 }
  if (/\b(m\/v|mv|official\s*(music\s*)?video)\b/.test(videoTitle)) score += 20
  if (artistL && titleL && videoTitle.includes(artistL) && videoTitle.includes(titleL)) score += 15
  return score
}

// 🔑 유튜브 Data API v3 키 — 관리자(sum)가 관리자 페이지에서 최대 3개까지 등록해둘 수 있다.
// 등록된 키가 있으면 그걸 최우선으로 쓰고, 없으면 기존처럼 Railway 환경변수
// (YOUTUBE_API_KEYS, 콤마로 여러 개 가능 — 예전 방식인 YOUTUBE_API_KEY 단일값도 계속 지원)를,
// 그것도 없으면 로컬봇 시절부터 쓰던 단비님 소유의 키를 마지막 폴백으로 쓴다.
function getYoutubeApiKeys() {
  const fromAdmin = store.getYoutubeApiKeys()
  if (fromAdmin.length) return fromAdmin
  const fromEnv = (process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  if (fromEnv.length) return fromEnv
  return ['AIzaSyAIm_oM2903zJF1vkPbjd42VxlUn5KVDmY']
}

// 🚦 키 하나가 일일 쿼터를 다 쓰면(quotaExceeded 등 403 에러) 그 키를 대략 24시간(구글 쿼터
// 리셋 주기와 비슷하게) 동안 건너뛰고 다음 등록 키로 자동 전환한다. 메모리에만 기록하므로
// 서버 재시작되면 초기화된다 — 그래도 다음 검색 때 다시 시도해보면 되니 문제 없다.
const ytKeyExhaustedUntil = {} // key -> timestampMs
const YT_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000

function isYoutubeQuotaError(errObj) {
  if (!errObj) return false
  const reasons = (errObj.errors || []).map(e => e.reason)
  return errObj.code === 403 && (reasons.includes('quotaExceeded') || reasons.includes('dailyLimitExceeded') || reasons.includes('rateLimitExceeded'))
}

async function fetchYoutubeSearchJson(query, key) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=10&key=${key}`
  try {
    const r = await fetch(url)
    return await r.json()
  } catch (e) {
    return { error: { message: e.message } }
  }
}

// 로컬봇과 100% 동일한 검색 로직 + 다중 키 자동 전환:
// 1) "가수 제목 audio" + "가수 제목" 두 쿼리를 병렬로 검색 (videoEmbeddable=true, videoCategoryId=10=음악)
// 2) 등록된 키 중 하나가 쿼터 초과면 다음 키로 넘어가서 재시도
// 3) 결과 병합 + 중복 제거
// 4) 반주/노래방(MR·Instrumental·Karaoke 등) 키워드 필터링 — 검색어 자체에 그 단어가 없으면 제외
// 5) 원곡/공식 오디오 우선 점수(scoreYoutubeCandidate)로 정렬
async function searchYoutubeVideo(artist, title) {
  if (!artist && !title) return null
  const keys = getYoutubeApiKeys()
  if (!keys.length) return null
  const now = Date.now()
  const available = keys.filter(k => !ytKeyExhaustedUntil[k] || ytKeyExhaustedUntil[k] <= now)
  const tryOrder = available.length ? available : keys // 전부 소진 표시돼있어도 리셋 시점이 부정확할 수 있으니 일단 재시도는 해본다

  for (const key of tryOrder) {
    try {
      const q1 = `${artist} ${title} audio`
      const q2 = `${artist} ${title}`
      const [r1, r2] = await Promise.all([
        fetchYoutubeSearchJson(q1, key),
        fetchYoutubeSearchJson(q2, key),
      ])
      const err = r1.error || r2.error
      if (err && isYoutubeQuotaError(err)) {
        ytKeyExhaustedUntil[key] = now + YT_QUOTA_COOLDOWN_MS
        console.log(`[유튜브 API] 키(${key.slice(0, 6)}...) 쿼터 초과 → 다음 등록 키로 자동 전환`)
        continue
      }
      if (r1.error && r2.error) {
        console.log('[신청곡 유튜브 검색 API 오류]', (r1.error || r2.error).message)
        continue // 이 키에서만 나는 일시적 오류일 수 있으니 다음 키로 넘어가서 한 번 더 시도
      }

      const seen = new Set()
      const merged = []
      ;[...(r1.items || []), ...(r2.items || [])].forEach(item => {
        const vid = item.id && item.id.videoId
        if (vid && !seen.has(vid)) { seen.add(vid); merged.push(item) }
      })
      if (!merged.length) return null

      const instKeywords = ['mr', '반주', 'instrumental', 'inst.', 'inst', 'piano', '피아노', 'karaoke', '노래방', '엠알', '반주음악', 'instrumental version', 'karaoke version']
      const userSearchQuery = `${artist} ${title}`.toLowerCase()
      const filtered = merged.filter(item => {
        const vTitle = (item.snippet.title || '').toLowerCase()
        const isInstInTitle = instKeywords.some(kw => vTitle.includes(kw))
        const isInstInQuery = instKeywords.some(kw => userSearchQuery.includes(kw))
        return !(isInstInTitle && !isInstInQuery)
      })
      const finalCandidates = filtered.length > 0 ? filtered : merged

      const scored = finalCandidates.map(item => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        score: scoreYoutubeCandidate(item.snippet.title, item.snippet.channelTitle, artist, title),
      })).sort((a, b) => b.score - a.score)

      // hasOriginal: MR/반주/노래방 키워드가 아닌 "원곡"으로 보이는 후보가 실제로 있었는지.
      // filtered가 비어서 merged(MR 포함 전체)로 폴백한 경우엔 false — 신청 접수 시 원곡 없음 판단에 쓴다.
      return { candidates: scored, matchedTitle: scored[0].title, hasOriginal: filtered.length > 0 }
    } catch (e) {
      console.log('[신청곡 유튜브 검색 실패]', artist, title, e.message)
      continue
    }
  }
  return null // 등록된 키를 전부 시도했는데도 결과를 못 얻음
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

async function handleSongRequestCommand(djId, room, settings, author, authorId, text, liveId) {
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

    // 🎬 켜져있으면 접수 즉시 유튜브에서 원곡 존재 여부를 확인한다. MR/반주/노래방 버전만 나오거나
    // 아예 검색 결과가 없으면 접수하지 않고 안내만 보낸다 (원곡위주로만 큐에 쌓이도록).
    if (sr.verifyOriginalOnRequest) {
      const yt = await searchYoutubeVideo(artist, title)
      if (!yt || !yt.candidates.length) {
        setTimeout(() => sendChatToRoom(djId, `❌ [${artist} - ${title}] 유튜브에서 찾을 수 없어요. 가수/제목을 다시 확인해주세요.`), 400)
        return
      }
      if (!yt.hasOriginal) {
        setTimeout(() => sendChatToRoom(djId, `❌ [${artist} - ${title}] 원곡을 찾지 못했어요 (MR·반주·노래방 버전만 검색돼요). 다른 곡을 신청해주세요.`), 400)
        return
      }
      // 나중에 재생 버튼을 누를 때 다시 검색하지 않도록, 지금 찾은 후보를 그대로 캐싱해둔다.
      item.matchedTitle = yt.matchedTitle
      item.ytCandidates = yt.candidates.slice(0, 5).map(c => ({ id: c.videoId, title: c.title }))
    }

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

  // 아래는 전부 DJ 또는 등록된 관리 권한자(고유닉)만 사용 가능 (실드 관리와 동일한 방식)
  const perms = (sr.perms || []).map(t => String(t).replace('@', '').toLowerCase())
  const authorNorm = String(author || '').toLowerCase()
  let isPermUser = perms.some(p => p === authorNorm || String(resolveNicknameFromInput(room, p) || '').toLowerCase() === authorNorm)
  if (!isPermUser && perms.length && liveId) {
    try {
      const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
      const freshMembers = await fetchLiveMembers(liveId, accessToken, 5)
      const me = freshMembers.find(u => u.nickname && u.nickname.toLowerCase() === authorNorm)
      if (me && me.tag) {
        rememberTagNickname(room, me.tag, author)
        isPermUser = perms.includes(me.tag.toLowerCase())
      }
    } catch (e) {
      console.log('[신청곡 권한 재조회 오류]', e.message)
    }
  }
  if (!isDj && !isPermUser) return

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
      cmdLottoGive: '!복권지급', cmdLottoTransfer: '!복권양도', cmdShop: '!상점', cmdAt: '@',
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
      msgLottoNone: '⚠️ {nickname}님의 복권이 없습니다.',
      users: {}
    }
    store.saveSettings(djId, { activity: settings.activity })
  }
  if (!settings.activity.users) settings.activity.users = {}
  if (!settings.activity.cmdLottoTransfer) settings.activity.cmdLottoTransfer = '!복권양도'
  if (!settings.activity.msgLottoNone) settings.activity.msgLottoNone = '⚠️ {nickname}님의 복권이 없습니다.'
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

// 채팅/좋아요 이벤트로 받은 닉네임을 그대로 덮어쓰면, 특정 이벤트에서 스푼 API가 닉네임 대신
// 태그(랜덤 문자열)를 잘못 실어보낼 때 이미 알고 있던 진짜 닉네임이 태그로 덮어써지는 문제가
// 있었다. 새 값이 태그와 완전히 같고, 이미 그와 다른(=진짜로 보이는) 닉네임이 저장돼있으면
// 덮어쓰지 않는다.
function actSafeSetNickname(d, nickname, tag) {
  if (!nickname) return
  if (tag && String(nickname).toLowerCase() === String(tag).toLowerCase()
    && d.nickname && String(d.nickname).toLowerCase() !== String(tag).toLowerCase()) {
    return
  }
  d.nickname = nickname
}

// 🚨 스푼 태그 조회 API가 가끔 부정확한 값을 돌려주는 문제가 있다(코드 내 다른 주석에서도
// "결과가 오락가락한다"고 확인됨). 애청지수는 보통 태그를 도감 key로 그대로 쓰기 때문에,
// 이 d.tag 필드를 이벤트 올 때마다 최신값으로 무조건 덮어쓰면 — 어쩌다 한 번 잘못된 태그가
// 섞여 들어왔을 때 원래 정상이던 태그가 오염되고, 그 다음부터는 (key로도, 저장된 tag로도)
// 이 사람을 다시 못 찾게 돼서 "애청지수 정보가 사라진 것처럼" 보이는 원인이 된다.
// → 이미 key와 일치하는 정상 태그가 있으면 건드리지 않고, 비어있을 때만 채워넣는다.
function actSafeSetTag(d, key, tag) {
  if (!tag) return
  if (d.tag && d.tag === key) {
    if (tag !== d.tag) console.log(`[애청지수][태그방어] key=${key} 저장된tag=${d.tag} 이번에받은tag=${tag} → 무시(기존 유지)`)
    return // 이미 키와 일치하는 정상 태그 — 잘못된 새 값으로부터 보호
  }
  d.tag = tag
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
  actSafeSetNickname(d, author, tag)
  actSafeSetTag(d, key, tag)
  if (profileUrl) d.imgUrl = profileUrl
  d.chat = (d.chat || 0) + 1
  const chatTier = getVipTierForTag(settings, tag)
  const chatMulti = chatTier ? (Number(settings.vipTier?.tiers?.find(t => t.name === chatTier.tier)?.expMulti) || 1) : 1
  const chatExp = Math.round((Number(act.scoreChat) || 2) * chatMulti)
  actGrantExp(djId, act, key, chatExp)
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
  actSafeSetNickname(d, author, tag)
  actSafeSetTag(d, key, tag)
  if (profileUrl) d.imgUrl = profileUrl
  d.heart = (d.heart || 0) + 1
  const heartExp = Number(act.scoreHeart) || 1
  actGrantExp(djId, act, key, heartExp)
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
  actSafeSetTag(d, key, tag)
  const now = Date.now()
  const interval = 30 * 60 * 1000
  if (now - (d.lastAttendTime || 0) < interval) return
  d.lastAttendTime = now
  d.attend = (d.attend || 0) + 1
  const attendExp = Number(act.scoreAttend) || 10
  actGrantExp(djId, act, key, attendExp)
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
  actSafeSetTag(d, key, tag)
  const exchange = Number(act.lottoExchange) || 22
  const expPerPoint = Number(act.scoreLottoPoint) || 5
  d.lp = (d.lp || 0) + amount
  if (amount > 0 && expPerPoint > 0) {
    actGrantExp(djId, act, key, amount * expPerPoint)
  }
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
    if (!tag) { setTimeout(() => sendChatToRoom(djId, TAG_RETRY_MSG), 400); return } // 고유닉 확정 전에는 신규 등록(닉네임 키) 금지
    actEnsureUser(act, tag, author, tag)
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
    let out = actFormat(act.msgMyInfo, { nickname: d.nickname || author, tag: d.tag || '', rank, level, exp: curExp, nextExp, heart: d.heart || 0, chat: d.chat || 0, attend: d.attend || 0, lp: d.lp || 0, lpMax, lotto: d.lotto || 0 })
    // 🌟 귀빈 등급 시스템을 켜둔 경우에만, 내정보 맨 아래에 그 사람 등급을 같이 보여준다.
    if (isModuleOn(settings, 'viptier', djId)) {
      const tierRec = getVipTierForTag(settings, d.tag || tag)
      if (tierRec) out += `\n등급 : ${tierRec.tier} (${tierRec.score}점)`
    }
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
      if ((d.lotto || 0) < 1) { setTimeout(() => sendChatToRoom(djId, actFormat(act.msgLottoNone, { nickname: author })), 400); return }
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
    if (count <= 0 || (d.lotto || 0) <= 0) { setTimeout(() => sendChatToRoom(djId, actFormat(act.msgLottoNone, { nickname: author })), 400); return }
    const useCount = Math.min(count, 100, d.lotto || 0) // ⚠️ !복권 10000처럼 큰 숫자를 넣어도 한 번에 최대 100장까지만 처리한다
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

  // 🎁 !복권양도 [고유닉] [수량] — DJ/매니저 권한과 무관하게, 본인이 갖고 있는 복권을 다른 등록된
  // 애청지수 유저에게 나눠줄 수 있는 명령어. 대상은 반드시 이미 애청지수에 등록돼 있어야 한다
  // (오타로 새 유저가 조용히 생기는 걸 막기 위해 !복권지급과 달리 자동 신규등록은 하지 않는다).
  const cmdLottoTransfer = act.cmdLottoTransfer || '!복권양도'
  if (first === cmdLottoTransfer) {
    const d = act.users[key]
    if (!d) { setTimeout(() => sendChatToRoom(djId, actFormat(act.msgNoInfo, { nickname: author })), 400); return }
    const targetNick = parts[1]
    const amount = parseInt(parts[2], 10)
    if (!targetNick || isNaN(amount) || amount <= 0) { setTimeout(() => sendChatToRoom(djId, `⚠️ 사용법: ${cmdLottoTransfer} [고유닉] [수량] (1장 이상)`), 400); return }
    const targetKey = findActUserKey(act, targetNick)
    if (!targetKey) { setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetNick}' 님은 애청지수 정보가 없어요.`), 400); return }
    if (targetKey === key) { setTimeout(() => sendChatToRoom(djId, `⚠️ 본인에게는 양도할 수 없어요.`), 400); return }
    if ((d.lotto || 0) < amount) { setTimeout(() => sendChatToRoom(djId, `⚠️ 보유한 복권(${d.lotto || 0}장)보다 많이 양도할 수 없어요.`), 400); return }
    const t = act.users[targetKey]
    d.lotto -= amount
    t.lotto = (t.lotto || 0) + amount
    save()
    setTimeout(() => sendChatToRoom(djId, `🎁 ${d.nickname || author}님이 ${t.nickname || targetNick}님에게 복권 ${amount}장을 양도했습니다! (${d.nickname || author}: ${d.lotto}장 / ${t.nickname || targetNick}: ${t.lotto}장)`), 400)
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
    // 신규 등록은 무조건 고유닉 기준으로만 한다 — 닉네임을 키로 쓰지 않는다.
    let found = null
    if (!existingKey) {
      found = await findLiveMemberByNickOrTag(djId, liveId, targetNick)
      if (!found) {
        setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetNick}' 님을 지금 방송에서 찾을 수 없어요. 닉네임/고유닉을 다시 확인해주세요.`), 400)
        return
      }
      if (!found.tag) { setTimeout(() => sendChatToRoom(djId, TAG_RETRY_MSG), 400); return }
    }
    const key = existingKey || found.tag.toLowerCase()
    const d = actEnsureUser(act, key, existingKey ? act.users[existingKey].nickname : (found.nickname || found.tag), existingKey ? null : found.tag)
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
    // 신규 등록은 무조건 고유닉 기준으로만 한다 — 닉네임을 키로 쓰지 않는다.
    let found = null
    if (!existingKey) {
      found = await findLiveMemberByNickOrTag(djId, liveId, targetNick)
      if (!found) {
        setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetNick}' 님을 지금 방송에서 찾을 수 없어요. 닉네임/고유닉을 다시 확인해주세요.`), 400)
        return
      }
      if (!found.tag) { setTimeout(() => sendChatToRoom(djId, TAG_RETRY_MSG), 400); return }
    }
    const key = existingKey || found.tag.toLowerCase()
    const d = actEnsureUser(act, key, existingKey ? act.users[existingKey].nickname : (found.nickname || found.tag), existingKey ? null : found.tag)
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
    const out0 = actFormat(act.msgMyInfo, { nickname: d.nickname || key, tag: d.tag || '', rank, level, exp: curExp, nextExp, heart: d.heart || 0, chat: d.chat || 0, attend: d.attend || 0, lp: d.lp || 0, lpMax, lotto: d.lotto || 0 })
    let out = out0
    if (isModuleOn(settings, 'viptier', djId)) {
      const tierRec = getVipTierForTag(settings, d.tag || key)
      if (tierRec) out += `\n등급 : ${tierRec.tier} (${tierRec.score}점)`
    }
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

  // 🔁 중복 지급 방지 — 방송이 끊겼다 재연결되면 타이머가 처음부터 다시 시작되는 구조라서,
  // 재연결이 짧은 간격으로 반복되거나(방송 튕김) 여러 경로가 겹치면 같은 주기 안에 두 번
  // 지급될 수 있었다. "정기" 실행(타이머에 의한 자동 실행)은 마지막 지급 이후 설정된 주기의
  // 최소 90% 이상 지나야만 다시 지급되게 막는다 — 어떤 이유로 타이머가 여러 번 겹쳐 돌아도
  // 실제 지급 간격은 항상 보장된다. "!자동복권즉시"/웹의 수동 지급은 DJ가 의도적으로 지금
  // 당장 지급하려는 것이므로 이 쿨다운의 영향을 받지 않는다.
  if (reason === '정기' && cfg.lastRunAt) {
    const intervalMs = Math.max(1, Math.min(1440, parseInt(cfg.intervalMin, 10) || 30)) * 60 * 1000
    const elapsed = Date.now() - cfg.lastRunAt
    if (elapsed < intervalMs * 0.9) {
      console.log(`[자동복권:${djId}/${reason}] 최근에 이미 지급해서 건너뜀 (마지막 지급 ${Math.round(elapsed / 1000)}초 전)`)
      return { ok: false, why: 'cooldown' }
    }
  }

  const amount = Math.max(1, Math.min(1000, parseInt(cfg.amount, 10) || 1))

  let members = []
  try {
    const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
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
    setTimeout(() => sendChatToRoom(djId, `🎟️ 자동 복권 지급: 현재 접속 중인 ${count}명에게 ${amount}장씩 지급했어요!`), delay)
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
  if (room.lottoAutoFirstTimeout) { clearTimeout(room.lottoAutoFirstTimeout); room.lottoAutoFirstTimeout = null }
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
  // 🔁 방송이 끊겼다 재연결되면 이 함수가 다시 호출되는데, 예전엔 그때마다 무조건 "지금부터
  // 다시 N분"으로 리셋돼서 재연결이 잦을수록 실제 지급 간격이 계속 늘어졌다. 이제 마지막
  // 지급 시각(cfg.lastRunAt) 기준으로 원래 주기에서 얼마나 남았는지 계산해서 그만큼만 먼저
  // 기다리고, 그 이후로는 정상 주기로 돈다 — "N분마다 지급"이라는 스케줄이 재연결과 무관하게
  // 최대한 유지된다. (실제 지급 자체는 runLottoAutoOnce 안의 쿨다운 체크로 한 번 더 보호됨)
  let firstDelay = ms
  if (cfg.lastRunAt) {
    const elapsed = Date.now() - cfg.lastRunAt
    firstDelay = Math.max(5000, ms - elapsed) // 재연결 직후 바로 쏘지 않게 최소 5초는 텀을 둠
  }
  room.lottoAutoFirstTimeout = setTimeout(() => {
    runLottoAutoOnce(djId, room, liveId, '정기').catch(e => console.log(`[자동복권:${djId}] 타이머 실행 오류`, e.message))
    room.lottoAutoTimer = setInterval(() => {
      runLottoAutoOnce(djId, room, liveId, '정기').catch(e => console.log(`[자동복권:${djId}] 타이머 실행 오류`, e.message))
    }, ms)
  }, firstDelay)
  console.log(`[자동복권:${djId}] 타이머 시작 — 주기 ${min}분 (첫 지급까지 ${Math.round(firstDelay / 1000)}초)`)
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
// 🐾 몬스터 잡기 — DJ가 설정한 시간마다 채팅에 랜덤 몬스터(스푼 공식 스티커 기반)가 나타나고,
// 시청자가 명령어로 잡으면 각자 도감에 기록되는 수집형 미니게임. 잡기 방식은 "선착순 1명"
// 또는 "등장 시간 동안 각자 확률판정" 중 설정에서 고를 수 있다.
// 잡으려면 "포획볼"이 있어야 한다 — !모험시작으로 기본 지급받고, 그 뒤로는 상점 구매(복권 소모)
// / 채팅 중 랜덤 획득 / 스푼(선물) 보낼 때 랜덤 획득, 세 가지 방법으로 더 모을 수 있다.
// 🐾 몬스터잡기를 처음 켜는 계정은 빈 목록이 아니라 이 기본 프리셋(포켓몬 1세대, 타입 포함)으로
// 자동 시작한다 — 관리자가 버튼을 따로 안 눌러도 바로 대결/타입 상성이 정상 작동한다.
const MC_DEFAULT_MONSTERS = [{"id": "pkmn-001", "name": "이상해씨", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png", "weight": 31, "catchRate": 50, "power": 318, "trait": "도감 001번 · 타입 풀/독 · HP 45 / 공격 49 / 방어 49 / 특수 65 / 스피드 45", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-002", "evolveCount": 16, "legendary": false}, {"id": "pkmn-002", "name": "이상해풀", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/2.png", "weight": 41, "catchRate": 50, "power": 405, "trait": "도감 002번 · 타입 풀/독 · HP 60 / 공격 62 / 방어 63 / 특수 80 / 스피드 60", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-003", "evolveCount": 32, "legendary": false}, {"id": "pkmn-003", "name": "이상해꽃", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/3.png", "weight": 54, "catchRate": 50, "power": 525, "trait": "도감 003번 · 타입 풀/독 · HP 80 / 공격 82 / 방어 83 / 특수 100 / 스피드 80", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-004", "name": "파이리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/4.png", "weight": 27, "catchRate": 50, "power": 309, "trait": "도감 004번 · 타입 불꽃 · HP 39 / 공격 52 / 방어 43 / 특수 60 / 스피드 65", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-005", "evolveCount": 16, "legendary": false}, {"id": "pkmn-005", "name": "리자드", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/5.png", "weight": 39, "catchRate": 50, "power": 405, "trait": "도감 005번 · 타입 불꽃 · HP 58 / 공격 64 / 방어 58 / 특수 80 / 스피드 80", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-006", "evolveCount": 36, "legendary": false}, {"id": "pkmn-006", "name": "리자몽", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/6.png", "weight": 52, "catchRate": 50, "power": 534, "trait": "도감 006번 · 타입 불꽃/비행 · HP 78 / 공격 84 / 방어 78 / 특수 109 / 스피드 100", "types": ["불꽃", "비행"], "moves": ["불꽃세례", "화염방사", "불대문자", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-007", "name": "꼬부기", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/7.png", "weight": 36, "catchRate": 50, "power": 314, "trait": "도감 007번 · 타입 물 · HP 44 / 공격 48 / 방어 65 / 특수 50 / 스피드 43", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-008", "evolveCount": 16, "legendary": false}, {"id": "pkmn-008", "name": "어니부기", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/8.png", "weight": 46, "catchRate": 50, "power": 405, "trait": "도감 008번 · 타입 물 · HP 59 / 공격 63 / 방어 80 / 특수 65 / 스피드 58", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-009", "evolveCount": 36, "legendary": false}, {"id": "pkmn-009", "name": "거북왕", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/9.png", "weight": 60, "catchRate": 50, "power": 530, "trait": "도감 009번 · 타입 물 · HP 79 / 공격 83 / 방어 100 / 특수 85 / 스피드 78", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-010", "name": "캐터피", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10.png", "weight": 27, "catchRate": 50, "power": 195, "trait": "도감 010번 · 타입 벌레 · HP 45 / 공격 30 / 방어 35 / 특수 20 / 스피드 45", "types": ["벌레"], "moves": ["더블니들", "독침", "바늘미사일"], "evolvesTo": "pkmn-011", "evolveCount": 7, "legendary": false}, {"id": "pkmn-011", "name": "단데기", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/11.png", "weight": 35, "catchRate": 50, "power": 205, "trait": "도감 011번 · 타입 벌레 · HP 50 / 공격 20 / 방어 55 / 특수 25 / 스피드 30", "types": ["벌레"], "moves": ["더블니들", "독침", "바늘미사일"], "evolvesTo": "pkmn-012", "evolveCount": 10, "legendary": false}, {"id": "pkmn-012", "name": "버터플", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/12.png", "weight": 37, "catchRate": 50, "power": 395, "trait": "도감 012번 · 타입 벌레/비행 · HP 60 / 공격 45 / 방어 50 / 특수 90 / 스피드 70", "types": ["벌레", "비행"], "moves": ["더블니들", "독침", "바늘미사일", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-013", "name": "뿔충이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/13.png", "weight": 23, "catchRate": 50, "power": 195, "trait": "도감 013번 · 타입 벌레/독 · HP 40 / 공격 35 / 방어 30 / 특수 20 / 스피드 50", "types": ["벌레", "독"], "moves": ["더블니들", "독침", "바늘미사일", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-014", "evolveCount": 7, "legendary": false}, {"id": "pkmn-014", "name": "딱충이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/14.png", "weight": 32, "catchRate": 50, "power": 205, "trait": "도감 014번 · 타입 벌레/독 · HP 45 / 공격 25 / 방어 50 / 특수 25 / 스피드 35", "types": ["벌레", "독"], "moves": ["더블니들", "독침", "바늘미사일", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-015", "evolveCount": 10, "legendary": false}, {"id": "pkmn-015", "name": "독침붕", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/15.png", "weight": 35, "catchRate": 50, "power": 395, "trait": "도감 015번 · 타입 벌레/독 · HP 65 / 공격 90 / 방어 40 / 특수 45 / 스피드 75", "types": ["벌레", "독"], "moves": ["더블니들", "독침", "바늘미사일", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-016", "name": "구구", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/16.png", "weight": 27, "catchRate": 50, "power": 251, "trait": "도감 016번 · 타입 노말/비행 · HP 40 / 공격 45 / 방어 40 / 특수 35 / 스피드 56", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-017", "evolveCount": 18, "legendary": false}, {"id": "pkmn-017", "name": "피죤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/17.png", "weight": 39, "catchRate": 50, "power": 349, "trait": "도감 017번 · 타입 노말/비행 · HP 63 / 공격 60 / 방어 55 / 특수 50 / 스피드 71", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-018", "evolveCount": 36, "legendary": false}, {"id": "pkmn-018", "name": "피죤투", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/18.png", "weight": 53, "catchRate": 50, "power": 479, "trait": "도감 018번 · 타입 노말/비행 · HP 83 / 공격 80 / 방어 75 / 특수 70 / 스피드 101", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-019", "name": "꼬렛", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/19.png", "weight": 22, "catchRate": 50, "power": 253, "trait": "도감 019번 · 타입 노말 · HP 30 / 공격 56 / 방어 35 / 특수 25 / 스피드 72", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "pkmn-020", "evolveCount": 20, "legendary": false}, {"id": "pkmn-020", "name": "레트라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/20.png", "weight": 38, "catchRate": 50, "power": 413, "trait": "도감 020번 · 타입 노말 · HP 55 / 공격 81 / 방어 60 / 특수 50 / 스피드 97", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-021", "name": "깨비참", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/21.png", "weight": 23, "catchRate": 50, "power": 262, "trait": "도감 021번 · 타입 노말/비행 · HP 40 / 공격 60 / 방어 30 / 특수 31 / 스피드 70", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-022", "evolveCount": 20, "legendary": false}, {"id": "pkmn-022", "name": "깨비드릴조", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/22.png", "weight": 43, "catchRate": 50, "power": 442, "trait": "도감 022번 · 타입 노말/비행 · HP 65 / 공격 90 / 방어 65 / 특수 61 / 스피드 100", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-023", "name": "아보", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/23.png", "weight": 26, "catchRate": 50, "power": 288, "trait": "도감 023번 · 타입 독 · HP 35 / 공격 60 / 방어 44 / 특수 40 / 스피드 55", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-024", "evolveCount": 22, "legendary": false}, {"id": "pkmn-024", "name": "아보크", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/24.png", "weight": 43, "catchRate": 50, "power": 448, "trait": "도감 024번 · 타입 독 · HP 60 / 공격 95 / 방어 69 / 특수 65 / 스피드 80", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-025", "name": "피카츄", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png", "weight": 25, "catchRate": 50, "power": 320, "trait": "도감 025번 · 타입 전기 · HP 35 / 공격 55 / 방어 40 / 특수 50 / 스피드 90", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-026", "evolveCount": 10, "legendary": false}, {"id": "pkmn-026", "name": "라이츄", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/26.png", "weight": 38, "catchRate": 50, "power": 485, "trait": "도감 026번 · 타입 전기 · HP 60 / 공격 90 / 방어 55 / 특수 90 / 스피드 110", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-027", "name": "모래두지", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/27.png", "weight": 45, "catchRate": 50, "power": 300, "trait": "도감 027번 · 타입 땅 · HP 50 / 공격 75 / 방어 85 / 특수 20 / 스피드 40", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-028", "evolveCount": 22, "legendary": false}, {"id": "pkmn-028", "name": "고지", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/28.png", "weight": 62, "catchRate": 50, "power": 450, "trait": "도감 028번 · 타입 땅 · HP 75 / 공격 100 / 방어 110 / 특수 45 / 스피드 65", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-029", "name": "니드런♀", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/29.png", "weight": 36, "catchRate": 50, "power": 275, "trait": "도감 029번 · 타입 독 · HP 55 / 공격 47 / 방어 52 / 특수 40 / 스피드 41", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-030", "evolveCount": 16, "legendary": false}, {"id": "pkmn-030", "name": "니드리나", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/30.png", "weight": 46, "catchRate": 50, "power": 365, "trait": "도감 030번 · 타입 독 · HP 70 / 공격 62 / 방어 67 / 특수 55 / 스피드 56", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-031", "evolveCount": 16, "legendary": false}, {"id": "pkmn-031", "name": "니드퀸", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/31.png", "weight": 59, "catchRate": 50, "power": 505, "trait": "도감 031번 · 타입 독/땅 · HP 90 / 공격 92 / 방어 87 / 특수 75 / 스피드 76", "types": ["독", "땅"], "moves": ["독침", "오물공격", "독찌르기", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-032", "name": "니드런♂", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/32.png", "weight": 29, "catchRate": 50, "power": 273, "trait": "도감 032번 · 타입 독 · HP 46 / 공격 57 / 방어 40 / 특수 40 / 스피드 50", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-033", "evolveCount": 16, "legendary": false}, {"id": "pkmn-033", "name": "니드리노", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/33.png", "weight": 39, "catchRate": 50, "power": 365, "trait": "도감 033번 · 타입 독 · HP 61 / 공격 72 / 방어 57 / 특수 55 / 스피드 65", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-034", "evolveCount": 16, "legendary": false}, {"id": "pkmn-034", "name": "니드킹", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/34.png", "weight": 53, "catchRate": 50, "power": 505, "trait": "도감 034번 · 타입 독/땅 · HP 81 / 공격 102 / 방어 77 / 특수 85 / 스피드 85", "types": ["독", "땅"], "moves": ["독침", "오물공격", "독찌르기", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-035", "name": "삐삐", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/35.png", "weight": 39, "catchRate": 50, "power": 323, "trait": "도감 035번 · 타입 노말 · HP 70 / 공격 45 / 방어 48 / 특수 60 / 스피드 35", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "pkmn-036", "evolveCount": 10, "legendary": false}, {"id": "pkmn-036", "name": "픽시", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/36.png", "weight": 56, "catchRate": 50, "power": 483, "trait": "도감 036번 · 타입 노말 · HP 95 / 공격 70 / 방어 73 / 특수 95 / 스피드 60", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-037", "name": "식스테일", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/37.png", "weight": 26, "catchRate": 50, "power": 299, "trait": "도감 037번 · 타입 불꽃 · HP 38 / 공격 41 / 방어 40 / 특수 50 / 스피드 65", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-038", "evolveCount": 10, "legendary": false}, {"id": "pkmn-038", "name": "나인테일", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/38.png", "weight": 49, "catchRate": 50, "power": 505, "trait": "도감 038번 · 타입 불꽃 · HP 73 / 공격 76 / 방어 75 / 특수 81 / 스피드 100", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-039", "name": "푸린", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/39.png", "weight": 45, "catchRate": 50, "power": 270, "trait": "도감 039번 · 타입 노말 · HP 115 / 공격 45 / 방어 20 / 특수 45 / 스피드 20", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "pkmn-040", "evolveCount": 16, "legendary": false}, {"id": "pkmn-040", "name": "푸크린", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/40.png", "weight": 62, "catchRate": 50, "power": 435, "trait": "도감 040번 · 타입 노말 · HP 140 / 공격 70 / 방어 45 / 특수 85 / 스피드 45", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-041", "name": "주뱃", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/41.png", "weight": 25, "catchRate": 50, "power": 245, "trait": "도감 041번 · 타입 독/비행 · HP 40 / 공격 45 / 방어 35 / 특수 30 / 스피드 55", "types": ["독", "비행"], "moves": ["독침", "오물공격", "독찌르기", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-042", "evolveCount": 22, "legendary": false}, {"id": "pkmn-042", "name": "골뱃", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/42.png", "weight": 48, "catchRate": 50, "power": 455, "trait": "도감 042번 · 타입 독/비행 · HP 75 / 공격 80 / 방어 70 / 특수 65 / 스피드 90", "types": ["독", "비행"], "moves": ["독침", "오물공격", "독찌르기", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-043", "name": "뚜벅쵸", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/43.png", "weight": 33, "catchRate": 50, "power": 320, "trait": "도감 043번 · 타입 풀/독 · HP 45 / 공격 50 / 방어 55 / 특수 75 / 스피드 30", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-044", "evolveCount": 21, "legendary": false}, {"id": "pkmn-044", "name": "냄새꼬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/44.png", "weight": 43, "catchRate": 50, "power": 395, "trait": "도감 044번 · 타입 풀/독 · HP 60 / 공격 65 / 방어 70 / 특수 85 / 스피드 40", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-045", "evolveCount": 10, "legendary": false}, {"id": "pkmn-045", "name": "라플레시아", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/45.png", "weight": 53, "catchRate": 50, "power": 490, "trait": "도감 045번 · 타입 풀/독 · HP 75 / 공격 80 / 방어 85 / 특수 110 / 스피드 50", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-046", "name": "파라스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/46.png", "weight": 30, "catchRate": 50, "power": 285, "trait": "도감 046번 · 타입 벌레/풀 · HP 35 / 공격 70 / 방어 55 / 특수 45 / 스피드 25", "types": ["벌레", "풀"], "moves": ["더블니들", "독침", "바늘미사일", "덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "pkmn-047", "evolveCount": 24, "legendary": false}, {"id": "pkmn-047", "name": "파라섹트", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/47.png", "weight": 47, "catchRate": 50, "power": 405, "trait": "도감 047번 · 타입 벌레/풀 · HP 60 / 공격 95 / 방어 80 / 특수 60 / 스피드 30", "types": ["벌레", "풀"], "moves": ["더블니들", "독침", "바늘미사일", "덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-048", "name": "콘팡이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/48.png", "weight": 37, "catchRate": 50, "power": 305, "trait": "도감 048번 · 타입 벌레/독 · HP 60 / 공격 55 / 방어 50 / 특수 40 / 스피드 45", "types": ["벌레", "독"], "moves": ["더블니들", "독침", "바늘미사일", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-049", "evolveCount": 31, "legendary": false}, {"id": "pkmn-049", "name": "도나리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/49.png", "weight": 43, "catchRate": 50, "power": 450, "trait": "도감 049번 · 타입 벌레/독 · HP 70 / 공격 65 / 방어 60 / 특수 90 / 스피드 90", "types": ["벌레", "독"], "moves": ["더블니들", "독침", "바늘미사일", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-050", "name": "디그다", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/50.png", "weight": 12, "catchRate": 50, "power": 265, "trait": "도감 050번 · 타입 땅 · HP 10 / 공격 55 / 방어 25 / 특수 35 / 스피드 95", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-051", "evolveCount": 26, "legendary": false}, {"id": "pkmn-051", "name": "닥트리오", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/51.png", "weight": 28, "catchRate": 50, "power": 425, "trait": "도감 051번 · 타입 땅 · HP 35 / 공격 100 / 방어 50 / 특수 50 / 스피드 120", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-052", "name": "나옹", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/52.png", "weight": 25, "catchRate": 50, "power": 290, "trait": "도감 052번 · 타입 노말 · HP 40 / 공격 45 / 방어 35 / 특수 40 / 스피드 90", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "pkmn-053", "evolveCount": 28, "legendary": false}, {"id": "pkmn-053", "name": "페르시온", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/53.png", "weight": 42, "catchRate": 50, "power": 440, "trait": "도감 053번 · 타입 노말 · HP 65 / 공격 70 / 방어 60 / 특수 65 / 스피드 115", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-054", "name": "고라파덕", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/54.png", "weight": 33, "catchRate": 50, "power": 320, "trait": "도감 054번 · 타입 물 · HP 50 / 공격 52 / 방어 48 / 특수 65 / 스피드 55", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-055", "evolveCount": 33, "legendary": false}, {"id": "pkmn-055", "name": "골덕", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/55.png", "weight": 53, "catchRate": 50, "power": 500, "trait": "도감 055번 · 타입 물 · HP 80 / 공격 82 / 방어 78 / 특수 95 / 스피드 85", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-056", "name": "망키", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/56.png", "weight": 25, "catchRate": 50, "power": 305, "trait": "도감 056번 · 타입 격투 · HP 40 / 공격 80 / 방어 35 / 특수 35 / 스피드 70", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "pkmn-057", "evolveCount": 28, "legendary": false}, {"id": "pkmn-057", "name": "라이관", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/57.png", "weight": 42, "catchRate": 50, "power": 455, "trait": "도감 057번 · 타입 격투 · HP 65 / 공격 105 / 방어 60 / 특수 60 / 스피드 95", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-058", "name": "가디", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/58.png", "weight": 33, "catchRate": 50, "power": 350, "trait": "도감 058번 · 타입 불꽃 · HP 55 / 공격 70 / 방어 45 / 특수 70 / 스피드 60", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-059", "evolveCount": 10, "legendary": false}, {"id": "pkmn-059", "name": "윈디", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/59.png", "weight": 57, "catchRate": 50, "power": 555, "trait": "도감 059번 · 타입 불꽃 · HP 90 / 공격 110 / 방어 80 / 특수 100 / 스피드 95", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-060", "name": "발챙이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/60.png", "weight": 27, "catchRate": 50, "power": 300, "trait": "도감 060번 · 타입 물 · HP 40 / 공격 50 / 방어 40 / 특수 40 / 스피드 90", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-061", "evolveCount": 25, "legendary": false}, {"id": "pkmn-061", "name": "슈륙챙이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/61.png", "weight": 43, "catchRate": 50, "power": 385, "trait": "도감 061번 · 타입 물 · HP 65 / 공격 65 / 방어 65 / 특수 50 / 스피드 90", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-062", "evolveCount": 10, "legendary": false}, {"id": "pkmn-062", "name": "강챙이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/62.png", "weight": 62, "catchRate": 50, "power": 510, "trait": "도감 062번 · 타입 물/격투 · HP 90 / 공격 95 / 방어 95 / 특수 70 / 스피드 70", "types": ["물", "격투"], "moves": ["물대포", "파도타기", "하이드로펌프", "태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-063", "name": "캐이시", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/63.png", "weight": 13, "catchRate": 50, "power": 310, "trait": "도감 063번 · 타입 에스퍼 · HP 25 / 공격 20 / 방어 15 / 특수 105 / 스피드 90", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "pkmn-064", "evolveCount": 16, "legendary": false}, {"id": "pkmn-064", "name": "윤겔라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/64.png", "weight": 23, "catchRate": 50, "power": 400, "trait": "도감 064번 · 타입 에스퍼 · HP 40 / 공격 35 / 방어 30 / 특수 120 / 스피드 105", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "pkmn-065", "evolveCount": 10, "legendary": false}, {"id": "pkmn-065", "name": "후딘", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/65.png", "weight": 33, "catchRate": 50, "power": 500, "trait": "도감 065번 · 타입 에스퍼 · HP 55 / 공격 50 / 방어 45 / 특수 135 / 스피드 120", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-066", "name": "알통몬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/66.png", "weight": 40, "catchRate": 50, "power": 305, "trait": "도감 066번 · 타입 격투 · HP 70 / 공격 80 / 방어 50 / 특수 35 / 스피드 35", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "pkmn-067", "evolveCount": 28, "legendary": false}, {"id": "pkmn-067", "name": "근육몬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/67.png", "weight": 50, "catchRate": 50, "power": 405, "trait": "도감 067번 · 타입 격투 · HP 80 / 공격 100 / 방어 70 / 특수 50 / 스피드 45", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "pkmn-068", "evolveCount": 10, "legendary": false}, {"id": "pkmn-068", "name": "괴력몬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/68.png", "weight": 57, "catchRate": 50, "power": 505, "trait": "도감 068번 · 타입 격투 · HP 90 / 공격 130 / 방어 80 / 특수 65 / 스피드 55", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-069", "name": "모다피", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/69.png", "weight": 28, "catchRate": 50, "power": 300, "trait": "도감 069번 · 타입 풀/독 · HP 50 / 공격 75 / 방어 35 / 특수 70 / 스피드 40", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-070", "evolveCount": 21, "legendary": false}, {"id": "pkmn-070", "name": "우츠동", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/70.png", "weight": 38, "catchRate": 50, "power": 390, "trait": "도감 070번 · 타입 풀/독 · HP 65 / 공격 90 / 방어 50 / 특수 85 / 스피드 55", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-071", "evolveCount": 10, "legendary": false}, {"id": "pkmn-071", "name": "우츠보트", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/71.png", "weight": 48, "catchRate": 50, "power": 490, "trait": "도감 071번 · 타입 풀/독 · HP 80 / 공격 105 / 방어 65 / 특수 100 / 스피드 70", "types": ["풀", "독"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-072", "name": "왕눈해", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/72.png", "weight": 25, "catchRate": 50, "power": 335, "trait": "도감 072번 · 타입 물/독 · HP 40 / 공격 40 / 방어 35 / 특수 50 / 스피드 70", "types": ["물", "독"], "moves": ["물대포", "파도타기", "하이드로펌프", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-073", "evolveCount": 30, "legendary": false}, {"id": "pkmn-073", "name": "독파리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/73.png", "weight": 48, "catchRate": 50, "power": 515, "trait": "도감 073번 · 타입 물/독 · HP 80 / 공격 70 / 방어 65 / 특수 80 / 스피드 100", "types": ["물", "독"], "moves": ["물대포", "파도타기", "하이드로펌프", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-074", "name": "꼬마돌", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/74.png", "weight": 47, "catchRate": 50, "power": 300, "trait": "도감 074번 · 타입 바위/땅 · HP 40 / 공격 80 / 방어 100 / 특수 30 / 스피드 20", "types": ["바위", "땅"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-075", "evolveCount": 25, "legendary": false}, {"id": "pkmn-075", "name": "데구리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/75.png", "weight": 57, "catchRate": 50, "power": 390, "trait": "도감 075번 · 타입 바위/땅 · HP 55 / 공격 95 / 방어 115 / 특수 45 / 스피드 35", "types": ["바위", "땅"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-076", "evolveCount": 10, "legendary": false}, {"id": "pkmn-076", "name": "딱구리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/76.png", "weight": 70, "catchRate": 50, "power": 495, "trait": "도감 076번 · 타입 바위/땅 · HP 80 / 공격 120 / 방어 130 / 특수 55 / 스피드 45", "types": ["바위", "땅"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-077", "name": "포니타", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/77.png", "weight": 35, "catchRate": 50, "power": 410, "trait": "도감 077번 · 타입 불꽃 · HP 50 / 공격 85 / 방어 55 / 특수 65 / 스피드 90", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-078", "evolveCount": 40, "legendary": false}, {"id": "pkmn-078", "name": "날쌩마", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/78.png", "weight": 45, "catchRate": 50, "power": 500, "trait": "도감 078번 · 타입 불꽃 · HP 65 / 공격 100 / 방어 70 / 특수 80 / 스피드 105", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-079", "name": "야돈", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/79.png", "weight": 52, "catchRate": 50, "power": 315, "trait": "도감 079번 · 타입 물/에스퍼 · HP 90 / 공격 65 / 방어 65 / 특수 40 / 스피드 15", "types": ["물", "에스퍼"], "moves": ["물대포", "파도타기", "하이드로펌프", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "pkmn-080", "evolveCount": 37, "legendary": false}, {"id": "pkmn-080", "name": "야도란", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/80.png", "weight": 68, "catchRate": 50, "power": 490, "trait": "도감 080번 · 타입 물/에스퍼 · HP 95 / 공격 75 / 방어 110 / 특수 100 / 스피드 30", "types": ["물", "에스퍼"], "moves": ["물대포", "파도타기", "하이드로펌프", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-081", "name": "코일", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/81.png", "weight": 32, "catchRate": 50, "power": 325, "trait": "도감 081번 · 타입 전기 · HP 25 / 공격 35 / 방어 70 / 특수 95 / 스피드 45", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-082", "evolveCount": 10, "legendary": false}, {"id": "pkmn-082", "name": "레어코일", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/82.png", "weight": 48, "catchRate": 50, "power": 465, "trait": "도감 082번 · 타입 전기 · HP 50 / 공격 60 / 방어 95 / 특수 120 / 스피드 70", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-083", "name": "파오리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/83.png", "weight": 36, "catchRate": 50, "power": 377, "trait": "도감 083번 · 타입 노말/비행 · HP 52 / 공격 90 / 방어 55 / 특수 58 / 스피드 60", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-084", "name": "두두", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/84.png", "weight": 27, "catchRate": 50, "power": 310, "trait": "도감 084번 · 타입 노말/비행 · HP 35 / 공격 85 / 방어 45 / 특수 35 / 스피드 75", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-085", "evolveCount": 31, "legendary": false}, {"id": "pkmn-085", "name": "두트리오", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/85.png", "weight": 43, "catchRate": 50, "power": 470, "trait": "도감 085번 · 타입 노말/비행 · HP 60 / 공격 110 / 방어 70 / 특수 60 / 스피드 110", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-086", "name": "쥬쥬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/86.png", "weight": 40, "catchRate": 50, "power": 325, "trait": "도감 086번 · 타입 물 · HP 65 / 공격 45 / 방어 55 / 특수 45 / 스피드 45", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-087", "evolveCount": 34, "legendary": false}, {"id": "pkmn-087", "name": "쥬레곤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/87.png", "weight": 57, "catchRate": 50, "power": 475, "trait": "도감 087번 · 타입 물/얼음 · HP 90 / 공격 70 / 방어 80 / 특수 70 / 스피드 70", "types": ["물", "얼음"], "moves": ["물대포", "파도타기", "하이드로펌프", "얼음뭉치", "얼음빔", "눈보라"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-088", "name": "질퍽이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/88.png", "weight": 43, "catchRate": 50, "power": 325, "trait": "도감 088번 · 타입 독 · HP 80 / 공격 80 / 방어 50 / 특수 40 / 스피드 25", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-089", "evolveCount": 38, "legendary": false}, {"id": "pkmn-089", "name": "질뻐크", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/89.png", "weight": 60, "catchRate": 50, "power": 500, "trait": "도감 089번 · 타입 독 · HP 105 / 공격 105 / 방어 75 / 특수 65 / 스피드 50", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-090", "name": "셀러", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/90.png", "weight": 43, "catchRate": 50, "power": 305, "trait": "도감 090번 · 타입 물 · HP 30 / 공격 65 / 방어 100 / 특수 45 / 스피드 40", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-091", "evolveCount": 10, "legendary": false}, {"id": "pkmn-091", "name": "파르셀", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/91.png", "weight": 77, "catchRate": 50, "power": 525, "trait": "도감 091번 · 타입 물/얼음 · HP 50 / 공격 95 / 방어 180 / 특수 85 / 스피드 70", "types": ["물", "얼음"], "moves": ["물대포", "파도타기", "하이드로펌프", "얼음뭉치", "얼음빔", "눈보라"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-092", "name": "고오스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/92.png", "weight": 20, "catchRate": 50, "power": 310, "trait": "도감 092번 · 타입 고스트/독 · HP 30 / 공격 35 / 방어 30 / 특수 100 / 스피드 80", "types": ["고스트", "독"], "moves": ["핥기", "나이트헤드", "꿈먹기", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-093", "evolveCount": 25, "legendary": false}, {"id": "pkmn-093", "name": "고우스트", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/93.png", "weight": 30, "catchRate": 50, "power": 405, "trait": "도감 093번 · 타입 고스트/독 · HP 45 / 공격 50 / 방어 45 / 특수 115 / 스피드 95", "types": ["고스트", "독"], "moves": ["핥기", "나이트헤드", "꿈먹기", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-094", "evolveCount": 10, "legendary": false}, {"id": "pkmn-094", "name": "팬텀", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/94.png", "weight": 40, "catchRate": 50, "power": 500, "trait": "도감 094번 · 타입 고스트/독 · HP 60 / 공격 65 / 방어 60 / 특수 130 / 스피드 110", "types": ["고스트", "독"], "moves": ["핥기", "나이트헤드", "꿈먹기", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-095", "name": "롱스톤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/95.png", "weight": 65, "catchRate": 50, "power": 385, "trait": "도감 095번 · 타입 바위/땅 · HP 35 / 공격 45 / 방어 160 / 특수 30 / 스피드 70", "types": ["바위", "땅"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-096", "name": "슬리프", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/96.png", "weight": 35, "catchRate": 50, "power": 328, "trait": "도감 096번 · 타입 에스퍼 · HP 60 / 공격 48 / 방어 45 / 특수 43 / 스피드 42", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "pkmn-097", "evolveCount": 10, "legendary": false}, {"id": "pkmn-097", "name": "슬리퍼", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/97.png", "weight": 52, "catchRate": 50, "power": 483, "trait": "도감 097번 · 타입 에스퍼 · HP 85 / 공격 73 / 방어 70 / 특수 73 / 스피드 67", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-098", "name": "크랩", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/98.png", "weight": 40, "catchRate": 50, "power": 325, "trait": "도감 098번 · 타입 물 · HP 30 / 공격 105 / 방어 90 / 특수 25 / 스피드 50", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-099", "evolveCount": 28, "legendary": false}, {"id": "pkmn-099", "name": "킹크랩", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/99.png", "weight": 57, "catchRate": 50, "power": 475, "trait": "도감 099번 · 타입 물 · HP 55 / 공격 130 / 방어 115 / 특수 50 / 스피드 75", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-100", "name": "찌리리공", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/100.png", "weight": 30, "catchRate": 50, "power": 330, "trait": "도감 100번 · 타입 전기 · HP 40 / 공격 30 / 방어 50 / 특수 55 / 스피드 100", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-101", "evolveCount": 30, "legendary": false}, {"id": "pkmn-101", "name": "붐볼", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/101.png", "weight": 43, "catchRate": 50, "power": 490, "trait": "도감 101번 · 타입 전기 · HP 60 / 공격 50 / 방어 70 / 특수 80 / 스피드 150", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-102", "name": "아라리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/102.png", "weight": 47, "catchRate": 50, "power": 325, "trait": "도감 102번 · 타입 풀/에스퍼 · HP 60 / 공격 40 / 방어 80 / 특수 60 / 스피드 40", "types": ["풀", "에스퍼"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "pkmn-103", "evolveCount": 10, "legendary": false}, {"id": "pkmn-103", "name": "나시", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/103.png", "weight": 60, "catchRate": 50, "power": 530, "trait": "도감 103번 · 타입 풀/에스퍼 · HP 95 / 공격 95 / 방어 85 / 특수 125 / 스피드 55", "types": ["풀", "에스퍼"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-104", "name": "텅구리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/104.png", "weight": 48, "catchRate": 50, "power": 320, "trait": "도감 104번 · 타입 땅 · HP 50 / 공격 50 / 방어 95 / 특수 40 / 스피드 35", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-105", "evolveCount": 28, "legendary": false}, {"id": "pkmn-105", "name": "텅부리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/105.png", "weight": 57, "catchRate": 50, "power": 425, "trait": "도감 105번 · 타입 땅 · HP 60 / 공격 80 / 방어 110 / 특수 50 / 스피드 45", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-106", "name": "시라소몬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/106.png", "weight": 34, "catchRate": 50, "power": 455, "trait": "도감 106번 · 타입 격투 · HP 50 / 공격 120 / 방어 53 / 특수 35 / 스피드 87", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-107", "name": "홍수몬", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/107.png", "weight": 43, "catchRate": 50, "power": 455, "trait": "도감 107번 · 타입 격투 · HP 50 / 공격 105 / 방어 79 / 특수 35 / 스피드 76", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-108", "name": "내루미", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/108.png", "weight": 55, "catchRate": 50, "power": 385, "trait": "도감 108번 · 타입 노말 · HP 90 / 공격 55 / 방어 75 / 특수 60 / 스피드 30", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-109", "name": "또가스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/109.png", "weight": 45, "catchRate": 50, "power": 340, "trait": "도감 109번 · 타입 독 · HP 40 / 공격 65 / 방어 95 / 특수 60 / 스피드 35", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-110", "evolveCount": 35, "legendary": false}, {"id": "pkmn-110", "name": "또도가스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/110.png", "weight": 62, "catchRate": 50, "power": 490, "trait": "도감 110번 · 타입 독 · HP 65 / 공격 90 / 방어 120 / 특수 85 / 스피드 60", "types": ["독"], "moves": ["독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-111", "name": "뿔카노", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/111.png", "weight": 58, "catchRate": 50, "power": 345, "trait": "도감 111번 · 타입 땅/바위 · HP 80 / 공격 85 / 방어 95 / 특수 30 / 스피드 25", "types": ["땅", "바위"], "moves": ["구멍파기", "지진", "땅가르기", "돌떨구기", "스톤샤워", "바위깨기"], "evolvesTo": "pkmn-112", "evolveCount": 42, "legendary": false}, {"id": "pkmn-112", "name": "코뿌리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/112.png", "weight": 75, "catchRate": 50, "power": 485, "trait": "도감 112번 · 타입 땅/바위 · HP 105 / 공격 130 / 방어 120 / 특수 45 / 스피드 40", "types": ["땅", "바위"], "moves": ["구멍파기", "지진", "땅가르기", "돌떨구기", "스톤샤워", "바위깨기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-113", "name": "럭키", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/113.png", "weight": 85, "catchRate": 50, "power": 450, "trait": "도감 113번 · 타입 노말 · HP 250 / 공격 5 / 방어 5 / 특수 35 / 스피드 50", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-114", "name": "덩쿠리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/114.png", "weight": 60, "catchRate": 50, "power": 435, "trait": "도감 114번 · 타입 풀 · HP 65 / 공격 55 / 방어 115 / 특수 100 / 스피드 60", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-115", "name": "캥카", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/115.png", "weight": 62, "catchRate": 50, "power": 490, "trait": "도감 115번 · 타입 노말 · HP 105 / 공격 95 / 방어 80 / 특수 40 / 스피드 90", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-116", "name": "쏘드라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/116.png", "weight": 33, "catchRate": 50, "power": 295, "trait": "도감 116번 · 타입 물 · HP 30 / 공격 40 / 방어 70 / 특수 70 / 스피드 60", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-117", "evolveCount": 32, "legendary": false}, {"id": "pkmn-117", "name": "시드라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/117.png", "weight": 50, "catchRate": 50, "power": 440, "trait": "도감 117번 · 타입 물 · HP 55 / 공격 65 / 방어 95 / 특수 95 / 스피드 85", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-118", "name": "콘치", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/118.png", "weight": 35, "catchRate": 50, "power": 320, "trait": "도감 118번 · 타입 물 · HP 45 / 공격 67 / 방어 60 / 특수 35 / 스피드 63", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-119", "evolveCount": 33, "legendary": false}, {"id": "pkmn-119", "name": "왕콘치", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/119.png", "weight": 48, "catchRate": 50, "power": 450, "trait": "도감 119번 · 타입 물 · HP 80 / 공격 92 / 방어 65 / 특수 65 / 스피드 68", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-120", "name": "별가사리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/120.png", "weight": 28, "catchRate": 50, "power": 340, "trait": "도감 120번 · 타입 물 · HP 30 / 공격 45 / 방어 55 / 특수 70 / 스피드 85", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-121", "evolveCount": 30, "legendary": false}, {"id": "pkmn-121", "name": "아쿠스타", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/121.png", "weight": 48, "catchRate": 50, "power": 520, "trait": "도감 121번 · 타입 물/에스퍼 · HP 60 / 공격 75 / 방어 85 / 특수 100 / 스피드 115", "types": ["물", "에스퍼"], "moves": ["물대포", "파도타기", "하이드로펌프", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-122", "name": "마임맨", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/122.png", "weight": 35, "catchRate": 50, "power": 460, "trait": "도감 122번 · 타입 에스퍼 · HP 40 / 공격 45 / 방어 65 / 특수 100 / 스피드 90", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-123", "name": "스라크", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/123.png", "weight": 50, "catchRate": 50, "power": 500, "trait": "도감 123번 · 타입 벌레/비행 · HP 70 / 공격 110 / 방어 80 / 특수 55 / 스피드 105", "types": ["벌레", "비행"], "moves": ["더블니들", "독침", "바늘미사일", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-124", "name": "루주라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/124.png", "weight": 33, "catchRate": 50, "power": 455, "trait": "도감 124번 · 타입 얼음/에스퍼 · HP 65 / 공격 50 / 방어 35 / 특수 115 / 스피드 95", "types": ["얼음", "에스퍼"], "moves": ["얼음뭉치", "얼음빔", "눈보라", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-125", "name": "에레브", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/125.png", "weight": 41, "catchRate": 50, "power": 490, "trait": "도감 125번 · 타입 전기 · HP 65 / 공격 83 / 방어 57 / 특수 95 / 스피드 105", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-126", "name": "마그마", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/126.png", "weight": 10, "catchRate": 40, "power": 495, "trait": "도감 126번 · 타입 불꽃 · HP 65 / 공격 95 / 방어 57 / 특수 100 / 스피드 93", "types": ["불꽃"], "moves": ["불꽃숨결", "화염방사", "도깨비불", "사이코키네시스"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-127", "name": "쁘사이저", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/127.png", "weight": 10, "catchRate": 40, "power": 500, "trait": "도감 127번 · 타입 벌레 · HP 65 / 공격 125 / 방어 100 / 특수 55 / 스피드 85", "types": ["벌레"], "moves": ["가위교차", "헤드번트", "지구던지기", "데인지"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-128", "name": "켄타로스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/128.png", "weight": 10, "catchRate": 40, "power": 490, "trait": "도감 128번 · 타입 노말 · HP 75 / 공격 100 / 방어 95 / 특수 40 / 스피드 110", "types": ["노말"], "moves": ["몸통박치기", "돌진", "불대타", "천둥엄니"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-129", "name": "잉어킹", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/129.png", "weight": 10, "catchRate": 40, "power": 200, "trait": "도감 129번 · 타입 물 · HP 20 / 공격 10 / 방어 55 / 특수 15 / 스피드 80", "types": ["물"], "moves": ["퍼덕이기", "물보라"], "evolvesTo": "pkmn-130", "evolveCount": 10, "legendary": false}, {"id": "pkmn-130", "name": "갸라도스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/130.png", "weight": 10, "catchRate": 40, "power": 540, "trait": "도감 130번 · 타입 물/비행 · HP 95 / 공격 125 / 방어 79 / 특수 60 / 스피드 81", "types": ["물", "비행"], "moves": ["용의분노", "파도타기", "맹렬한기세", "각다귀"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-131", "name": "라프라스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/131.png", "weight": 10, "catchRate": 40, "power": 535, "trait": "도감 131번 · 타입 물/얼음 · HP 130 / 공격 85 / 방어 80 / 특수 85 / 스피드 60", "types": ["물", "얼음"], "moves": ["냉동빔", "파도타기", "몸통박치기", "노래하기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-132", "name": "메타몽", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/132.png", "weight": 10, "catchRate": 40, "power": 288, "trait": "도감 132번 · 타입 노말 · HP 48 / 공격 48 / 방어 48 / 특수 48 / 스피드 48", "types": ["노말"], "moves": ["변신"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-133", "name": "이브이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/133.png", "weight": 10, "catchRate": 40, "power": 325, "trait": "도감 133번 · 타입 노말 · HP 55 / 공격 55 / 방어 50 / 특수 45 / 스피드 55", "types": ["노말"], "moves": ["몸통박치기", "모래뿌리기", "꼬리흔들기"], "evolvesTo": "pkmn-134", "evolveCount": 10, "legendary": false}, {"id": "pkmn-134", "name": "샤미드", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/134.png", "weight": 10, "catchRate": 40, "power": 525, "trait": "도감 134번 · 타입 물 · HP 130 / 공격 65 / 방어 60 / 특수 110 / 스피드 65", "types": ["물"], "moves": ["파도타기", "냉동빔", "고속스핀"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-135", "name": "쥬피썬더", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/135.png", "weight": 10, "catchRate": 40, "power": 525, "trait": "도감 135번 · 타입 전기 · HP 65 / 공격 65 / 방어 60 / 특수 110 / 스피드 130", "types": ["전기"], "moves": ["십만볼트", "전광석화", "전기쇼크"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-136", "name": "부스터", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/136.png", "weight": 41, "catchRate": 50, "power": 495, "trait": "도감 136번 · 타입 불꽃 · HP 65 / 공격 95 / 방어 57 / 특수 100 / 스피드 93", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-137", "name": "폴리곤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/137.png", "weight": 45, "catchRate": 50, "power": 395, "trait": "도감 137번 · 타입 노말 · HP 65 / 공격 60 / 방어 70 / 특수 85 / 스피드 40", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-138", "name": "암나이트", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/138.png", "weight": 45, "catchRate": 50, "power": 355, "trait": "도감 138번 · 타입 바위/물 · HP 35 / 공격 40 / 방어 100 / 특수 90 / 스피드 35", "types": ["바위", "물"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-139", "evolveCount": 10, "legendary": false}, {"id": "pkmn-139", "name": "암스타", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/139.png", "weight": 65, "catchRate": 50, "power": 495, "trait": "도감 139번 · 타입 바위/물 · HP 70 / 공격 60 / 방어 125 / 특수 115 / 스피드 55", "types": ["바위", "물"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-140", "name": "투구", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/140.png", "weight": 40, "catchRate": 50, "power": 355, "trait": "도감 140번 · 타입 바위/물 · HP 30 / 공격 80 / 방어 90 / 특수 55 / 스피드 55", "types": ["바위", "물"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-141", "evolveCount": 10, "legendary": false}, {"id": "pkmn-141", "name": "투구푸스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/141.png", "weight": 55, "catchRate": 50, "power": 495, "trait": "도감 141번 · 타입 바위/물 · HP 60 / 공격 115 / 방어 105 / 특수 65 / 스피드 80", "types": ["바위", "물"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-142", "name": "프테라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/142.png", "weight": 55, "catchRate": 50, "power": 500, "trait": "도감 142번 · 타입 바위/비행 · HP 65 / 공격 125 / 방어 100 / 특수 55 / 스피드 85", "types": ["바위", "비행"], "moves": ["돌떨구기", "스톤샤워", "바위깨기", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-143", "name": "잠만보", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/143.png", "weight": 57, "catchRate": 50, "power": 490, "trait": "도감 143번 · 타입 노말 · HP 75 / 공격 100 / 방어 95 / 특수 40 / 스피드 110", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-144", "name": "프리져", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/144.png", "weight": 25, "catchRate": 50, "power": 200, "trait": "도감 144번 · 타입 얼음/비행 · HP 20 / 공격 10 / 방어 55 / 특수 15 / 스피드 80", "types": ["얼음", "비행"], "moves": ["얼음뭉치", "얼음빔", "눈보라", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 20, "legendary": true}, {"id": "pkmn-145", "name": "썬더", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/145.png", "weight": 58, "catchRate": 50, "power": 540, "trait": "도감 145번 · 타입 전기/비행 · HP 95 / 공격 125 / 방어 79 / 특수 60 / 스피드 81", "types": ["전기", "비행"], "moves": ["전기쇼크", "10만볼트", "번개", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": true}, {"id": "pkmn-146", "name": "파이어", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/146.png", "weight": 70, "catchRate": 50, "power": 535, "trait": "도감 146번 · 타입 불꽃/비행 · HP 130 / 공격 85 / 방어 80 / 특수 85 / 스피드 60", "types": ["불꽃", "비행"], "moves": ["불꽃세례", "화염방사", "불대문자", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": true}, {"id": "pkmn-147", "name": "미뇽", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/147.png", "weight": 32, "catchRate": 50, "power": 288, "trait": "도감 147번 · 타입 드래곤 · HP 48 / 공격 48 / 방어 48 / 특수 48 / 스피드 48", "types": ["드래곤"], "moves": ["용의숨결", "용의파동", "역린"], "evolvesTo": "pkmn-148", "evolveCount": 10, "legendary": false}, {"id": "pkmn-148", "name": "신뇽", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/148.png", "weight": 35, "catchRate": 50, "power": 325, "trait": "도감 148번 · 타입 드래곤 · HP 55 / 공격 55 / 방어 50 / 특수 45 / 스피드 55", "types": ["드래곤"], "moves": ["용의숨결", "용의파동", "역린"], "evolvesTo": "pkmn-149", "evolveCount": 10, "legendary": false}, {"id": "pkmn-149", "name": "망나뇽", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/149.png", "weight": 63, "catchRate": 50, "power": 525, "trait": "도감 149번 · 타입 드래곤/비행 · HP 130 / 공격 65 / 방어 60 / 특수 110 / 스피드 65", "types": ["드래곤", "비행"], "moves": ["용의숨결", "용의파동", "역린", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 10, "legendary": false}, {"id": "pkmn-150", "name": "뮤츠", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/150.png", "weight": 42, "catchRate": 50, "power": 525, "trait": "도감 150번 · 타입 에스퍼 · HP 65 / 공격 65 / 방어 60 / 특수 110 / 스피드 130", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": true}, {"id": "pkmn-151", "name": "뮤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/151.png", "weight": 42, "catchRate": 50, "power": 525, "trait": "도감 151번 · 타입 에스퍼 · HP 65 / 공격 130 / 방어 60 / 특수 95 / 스피드 65", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 10, "legendary": true}]

function getMonsterCatchSettings(djId, settings) {
  if (!settings.monsterCatch) {
    settings.monsterCatch = {
      enabled: false,
      spawnIntervalMin: 5,
      catchWindowSec: 60,
      catchMode: 'first', // 'first' | 'all'
      cmdCatch: '!잡기',
      cmdDex: '!도감',
      cmdRanking: '!랭킹', // 🏆 트레이너 랭킹 (가장 강한 몬스터 공격력 기준, 전체/이 방 상위 5명)
      spawnMsg: '🐾 야생의 [{monster}]이(가) 나타났습니다! {cmd}로 잡아보세요! ({sec}초 안에 사라져요)',
      legendarySpawnMsg: '✨전설 등장✨ 전설의 [{monster}]이(가) 나타났습니다!! {cmd}로 잡아보세요! ({sec}초 안에 사라져요)',
      catchSuccessMsg: '🎉 {nickname}님이 [{monster}]을(를) 잡았습니다! (도감 {count}번째 · 남은 포획볼 {balls}개)',
      catchFailMsg: '💨 {nickname}님, [{monster}]을(를) 놓쳤어요... (남은 포획볼 {balls}개)',
      despawnMsg: '💨 [{monster}]이(가) 도망가버렸어요...',
      monsters: MC_DEFAULT_MONSTERS.map(m => ({ ...m })), // { id, name, image, weight, catchRate } — 기본으로 포켓몬 1세대(타입 포함) 채워서 시작
      collections: {}, // key: 고유닉(또는 닉네임) → { [monsterId]: count }

      // 🎒 포획볼 경제
      cmdStart: '!모험시작',
      cmdBag: '!포획볼',
      cmdBuyBall: '!포획볼구매',
      startBalls: 5,
      buyPrice: 10, // 복권 몇 장당 포획볼 1개
      chatBallChance: 2, // 채팅 한 번당 % 확률로 포획볼 1개 획득
      giftBallChance: 30, // 선물(스푼) 보낼 때 % 확률로 포획볼 획득
      giftBallCount: 1,
      chatCountThreshold: 5, // 채팅 N번마다 (확률과 별개로) 확정 지급
      chatCountReward: 3, // 위 N번 채웠을 때 지급되는 포획볼 개수
      bags: {}, // key: 고유닉 → 보유 포획볼 수 (등록 안 했으면 키 자체가 없음)
      chatCounts: {}, // key: 고유닉 → 누적 채팅 횟수(N번마다 지급 카운터용)
      msgStart: '🎒 {nickname}님, 모험을 시작했어요! 포획볼 {balls}개를 받았어요. {cmdCatch}로 몬스터를 잡아보세요!',
      msgAlreadyStarted: '🎒 {nickname}님은 이미 모험 중이에요! (보유 포획볼: {balls}개)',
      msgBag: '🎒 {nickname}님의 포획볼: {balls}개 (고급: {greatBalls}개)',
      msgNoBalls: '⚠️ {nickname}님, 포획볼이 없어요! {cmdBuyBall}로 구매하거나 채팅/선물로 획득해보세요.',
      msgNoAdventure: '⚠️ {nickname}님, 아직 모험을 시작 안 했어요! {cmdStart}로 먼저 시작해주세요.',
      msgBuySuccess: '🎒 {nickname}님이 복권 {cost}장으로 포획볼 {amount}개를 구매했어요! (보유: {balls}개)',
      msgBuyFail: '⚠️ {nickname}님, 복권이 부족해요! (보유 복권: {lotto}장, 필요: {cost}장)',
      msgChatBall: '🎁 {nickname}님이 채팅 중 포획볼을 주웠어요! (보유: {balls}개)',
      msgChatCountBall: '🎁 {nickname}님이 채팅 {count}번 달성! 포획볼 {reward}개를 받았어요! (보유: {balls}개)',
      msgGiftBall: '🎁 {nickname}님이 선물과 함께 포획볼 {amount}개를 발견했어요! (보유: {balls}개)',

      // ⚔️ 대결(PvP) — 각자 보유 몬스터 중 가장 강한 걸로 자동 대결. 공격기/특성은 전부 DJ가
      // 직접 짓는 오리지널 설정이다 (실제 게임 데이터 아님).
      cmdBattle: '!대결',
      battleWinPoints: 10, // 🏆 대결 승리 시 이긴 사람에게 지급하는 도감 포인트(레벨업에 쓰는 그 포인트)
      battleCooldownSec: 60, // ⏱ 같은 사람이 !대결을 다시 쓸 수 있는 최소 간격(초) — 도배/포인트 파밍 방지
      msgBattleCooldown: '⏱ {nickname}님, 아직 대결 쿨타임이에요! ({sec}초 후 다시 시도해주세요)',
      msgBattleUsage: '⚠️ 사용법: {cmdBattle} [고유닉]',
      msgBattleSelfError: '⚠️ 본인과는 대결할 수 없어요!',
      msgBattleNoMonsters: '⚠️ {nickname}님, 아직 잡은 몬스터가 없어서 대결할 수 없어요! {cmdCatch}로 먼저 몬스터를 잡아보세요.',
      msgBattleTargetNoMonsters: '⚠️ 상대방({target})이 아직 잡은 몬스터가 없어서 대결할 수 없어요!',
      msgBattleResult: '⚔️ {nickname}님의 [{myMonster}] VS {target}님의 [{targetMonster}]!\n🏆 {winner}님의 [{winnerMonster}]이(가) "{move}"(으)로 승리했습니다! {effect}\n✨ 포인트 +{amount}',

      // 🌟 진화 — 같은 몬스터를 정해진 마리 수만큼 모으면 다른 몬스터로 바뀐다. evolvesTo/evolveCount는
      // 몬스터 하나하나에 개별로 붙는 값(monsters 배열 각 항목)이라 여기 기본값에는 없다.
      cmdEvolve: '!진화',
      autoEvolve: false, // 켜두면 잡는 순간 조건 충족 시 자동으로 진화, 꺼두면 !진화 명령어로 직접
      msgEvolveUsage: '⚠️ 사용법: {cmdEvolve} [몬스터이름]',
      msgEvolveNotFound: '⚠️ [{monster}]은(는) 도감에 없는 몬스터예요.',
      msgEvolveNoTarget: '⚠️ [{monster}]은(는) 진화할 수 없는 몬스터예요.',
      msgEvolveFail: '⚠️ [{monster}] {need}마리가 필요해요! (현재 {owned}마리 보유)',
      msgEvolveSuccess: '✨ {nickname}님의 [{monster}] {need}마리가 진화해서 [{targetMonster}]이(가) 되었습니다!',
      msgAutoEvolve: '✨ {nickname}님의 [{monster}]이(가) 자동으로 진화해서 [{targetMonster}]이(가) 되었습니다!',

      // 🗑️ 유저 정보 리셋 — DJ/매니저 전용. 고유닉을 지정해서 그 사람의 몬스터잡기 정보(포획볼/
      // 고급볼/도감/채팅카운트)만 초기화한다. 전역 공용 데이터라 어느 디제이 방에서 써도 동일하게 반영됨.
      cmdUserReset: '!리셋',
      msgUserResetUsage: '⚠️ 사용법: {cmdUserReset} [고유닉]',
      msgUserResetNoAuth: '⚠️ DJ 또는 매니저만 사용할 수 있어요.',
      msgUserResetNotFound: "⚠️ '{target}'님의 몬스터잡기 정보가 없어요.",
      msgUserResetSuccess: '🗑️ {target}님의 몬스터잡기 정보를 초기화했어요.',

      // 🎾 포획볼 지급 — DJ/매니저 전용. 고유닉을 지정해서 포획볼(일반)을 지급/차감한다.
      // 대상이 아직 !모험시작을 안 했어도 자동으로 등록하며 지급한다 (음수 입력 시 차감).
      cmdBallGive: '!볼지급',
      msgBallGiveUsage: '⚠️ 사용법: {cmdBallGive} [고유닉] [수량] (음수 입력 시 차감)',
      msgBallGiveNoAuth: '⚠️ DJ 또는 매니저만 사용할 수 있어요.',
      msgBallGiveSuccess: '🎾 {target}님의 포획볼이 {amount}개 {action}되었습니다. (현재: {balls}개)',

      // 🌿 보스 몬스터 — 정해진 시간마다 자동으로 "풀" 타입 몬스터 중 하나가 보스로 등장한다.
      // {cmdBossJoin}으로 참여하면 각자 가장 강한 몬스터의 공격력이 보스 체력에 더해지고,
      // 참여 시간이 끝나면 자동으로 격파 처리되며(체력 = 참여자 총 공격력) 가장 강한 공격력을
      // 기여한 사람이 MVP로 랜덤 이로치 몬스터 1마리를 받는다.
      bossEnabled: true,
      bossMonsterName: '풀잎',
      bossPower: 100, // ⚔️ 보스 공격력(체력 역할) — 참여자 총 공격력이 이걸 넘어야 처치 성공
      bossIntervalMin: 60,
      bossJoinWindowSec: 90,
      cmdBossJoin: '!참여',
      msgBossSpawn: '🌿 야생의 보스 [{monster}]이(가) 나타났습니다! (공격력 {bossPower}) {cmdBossJoin}로 함께 싸워보세요! ({sec}초 안에 참여 마감)',
      msgBossJoin: '⚔️ {nickname}님이 보스전에 참여했어요! (공격력 {power})',
      msgBossAlreadyJoined: '⚠️ {nickname}님은 이미 참여했어요!',
      msgBossNoMonsters: '⚠️ {nickname}님, 참여하려면 몬스터를 먼저 잡아야 해요!',
      msgBossNoActive: '⚠️ 지금 진행 중인 보스전이 없어요.',
      msgBossNoParticipants: '💨 아무도 도전하지 않아서 보스 [{monster}]이(가) 조용히 사라졌어요...',
      msgBossFail: '💔 참여 {count}명 · 총 공격력 {totalPower}(으)로는 보스 [{monster}](공격력 {bossPower})를 처치하지 못했어요...',
      msgBossResult: '🎉 보스 [{monster}] 격파! 참여 {count}명 · 총 공격력 {totalPower}\n🎲 주사위 대결 결과 {mvpNickname}님이 {mvpPower} 눈으로 승리! → 🌈이로치 [{reward}] 획득!',

      // 🎲 보스 격파 후 "누가 보상을 가져갈지"는 대미지(공격력)가 아니라, 참여자들이 채팅으로
      // 주사위를 굴려서 가장 높은 눈이 나온 사람이 가져간다. (참여했지만 안 굴린 사람은 탈락)
      cmdBossRoll: '!주사위',
      bossRollWindowSec: 30, // ⏱ 격파 후 주사위를 굴릴 수 있는 시간(초)
      msgBossRollPrompt: '⚔️ 보스 [{monster}] 격파! 보상은 주사위 대결로 정해요 — 참여자분들은 {sec}초 안에 {cmd}로 주사위를 굴려주세요!',
      msgBossRollResult: '🎲 {nickname}님이 주사위를 굴려 {roll}이 나왔어요!',
      msgBossRollAlready: '⚠️ {nickname}님은 이미 주사위를 굴렸어요! ({roll})',
      msgBossRollNotParticipant: '⚠️ 보스전에 참여하지 않으셨어요.',
      msgBossRollNoOne: '💨 아무도 주사위를 굴리지 않아서 보상이 사라졌어요...',
    }
    store.saveSettings(djId, { monsterCatch: settings.monsterCatch })
  }
  const mc = settings.monsterCatch
  if (!Array.isArray(mc.monsters)) mc.monsters = []
  if (!mc.collections || typeof mc.collections !== 'object') mc.collections = {}
  if (!mc.bags || typeof mc.bags !== 'object') mc.bags = {}
  if (!mc.greatBags || typeof mc.greatBags !== 'object') mc.greatBags = {} // 🎾 고급 몬스터볼 보유 개수 (key: 고유닉)
  if (mc.cmdStart == null) mc.cmdStart = '!모험시작'
  if (mc.cmdBag == null) mc.cmdBag = '!포획볼'
  if (mc.cmdBuyBall == null) mc.cmdBuyBall = '!포획볼구매'
  if (mc.startBalls == null) mc.startBalls = 5
  if (mc.buyPrice == null) mc.buyPrice = 10
  if (mc.chatBallChance == null) mc.chatBallChance = 2
  if (mc.giftBallChance == null) mc.giftBallChance = 30
  if (mc.giftBallCount == null) mc.giftBallCount = 1
  if (mc.chatCountThreshold == null) mc.chatCountThreshold = 5
  if (mc.chatCountReward == null) mc.chatCountReward = 3
  if (!mc.chatCounts || typeof mc.chatCounts !== 'object') mc.chatCounts = {}
  if (mc.msgChatCountBall == null) mc.msgChatCountBall = '🎁 {nickname}님이 채팅 {count}번 달성! 포획볼 {reward}개를 받았어요! (보유: {balls}개)'
  if (mc.legendarySpawnMsg == null) mc.legendarySpawnMsg = '✨전설 등장✨ 전설의 [{monster}]이(가) 나타났습니다!! {cmd}로 잡아보세요! ({sec}초 안에 사라져요)'
  if (mc.greatBallBonus == null) mc.greatBallBonus = 5 // 🎾 고급 몬스터볼 사용 시 잡기 확률에 더해줄 %p
  // 🏪 상점 — 지정 스티커를 선물하거나 지정 스푼을 donate하면 자동으로 아이템을 지급한다.
  // kind: 'ball'(몬스터볼) | 'greatball'(고급몬스터볼, +greatBallBonus%p) | 'box'(희귀상자, 랜덤 몬스터 즉시 지급)
  if (!mc.shop || typeof mc.shop !== 'object') mc.shop = {}
  if (mc.shop.cmdShop == null) mc.shop.cmdShop = '!상점'
  if (!Array.isArray(mc.shop.items)) {
    mc.shop.items = [
      { id: 'shop_ball', name: '몬스터볼', kind: 'ball', triggerMode: 'sticker', triggerSticker: '', triggerAmount: 0, payout: 'combo', thresholdCount: 1, grantCount: 1 },
      { id: 'shop_greatball', name: '고급몬스터볼', kind: 'greatball', triggerMode: 'sticker', triggerSticker: '', triggerAmount: 0, payout: 'combo', thresholdCount: 1, grantCount: 1 },
      { id: 'shop_box', name: '희귀상자', kind: 'box', triggerMode: 'sticker', triggerSticker: '', triggerAmount: 0, payout: 'combo', thresholdCount: 1, grantCount: 1 },
    ]
  }
  if (mc.shop.msgShopList == null) mc.shop.msgShopList = '🏪 상점 목록\n{목록}\n💡 스티커를 선물하거나 지정된 스푼을 후원하면 자동으로 지급돼요!'
  if (mc.shop.msgBuyBall == null) mc.shop.msgBuyBall = '🎾 {nickname}님이 몬스터볼 {amount}개를 구매했어요! (보유: {balls}개)'
  if (mc.shop.msgBuyGreatBall == null) mc.shop.msgBuyGreatBall = '🌟 {nickname}님이 고급몬스터볼 {amount}개를 구매했어요! (보유: {greatBalls}개)'
  if (mc.shop.msgBuyBox == null) mc.shop.msgBuyBox = '🎁 {nickname}님이 희귀상자를 열어 [{monster}]을(를) 획득했어요!'
  if (mc.cmdBattle == null) mc.cmdBattle = '!대결'
  if (mc.battleWinPoints == null) mc.battleWinPoints = 10
  if (mc.battleCooldownSec == null) mc.battleCooldownSec = 60
  if (mc.msgBattleCooldown == null) mc.msgBattleCooldown = '⏱ {nickname}님, 아직 대결 쿨타임이에요! ({sec}초 후 다시 시도해주세요)'
  if (mc.msgBattleUsage == null) mc.msgBattleUsage = '⚠️ 사용법: {cmdBattle} [고유닉]'
  if (mc.msgBattleSelfError == null) mc.msgBattleSelfError = '⚠️ 본인과는 대결할 수 없어요!'
  if (mc.msgBattleNoMonsters == null) mc.msgBattleNoMonsters = '⚠️ {nickname}님, 아직 잡은 몬스터가 없어서 대결할 수 없어요! {cmdCatch}로 먼저 몬스터를 잡아보세요.'
  if (mc.msgBattleTargetNoMonsters == null) mc.msgBattleTargetNoMonsters = '⚠️ 상대방({target})이 아직 잡은 몬스터가 없어서 대결할 수 없어요!'
  if (mc.msgBattleResult == null) mc.msgBattleResult = '⚔️ {nickname}님의 [{myMonster}] VS {target}님의 [{targetMonster}]!\n🏆 {winner}님의 [{winnerMonster}]이(가) "{move}"(으)로 승리했습니다! {effect}\n✨ 포인트 +{amount}'
  if (mc.cmdEvolve == null) mc.cmdEvolve = '!진화'
  if (mc.autoEvolve == null) mc.autoEvolve = false
  if (mc.msgEvolveUsage == null) mc.msgEvolveUsage = '⚠️ 사용법: {cmdEvolve} [몬스터이름]'
  if (mc.msgEvolveNotFound == null) mc.msgEvolveNotFound = '⚠️ [{monster}]은(는) 도감에 없는 몬스터예요.'
  if (mc.msgEvolveNoTarget == null) mc.msgEvolveNoTarget = '⚠️ [{monster}]은(는) 진화할 수 없는 몬스터예요.'
  if (mc.msgEvolveFail == null) mc.msgEvolveFail = '⚠️ [{monster}] {need}마리가 필요해요! (현재 {owned}마리 보유)'
  if (mc.msgEvolveSuccess == null) mc.msgEvolveSuccess = '✨ {nickname}님의 [{monster}] {need}마리가 진화해서 [{targetMonster}]이(가) 되었습니다!'
  if (mc.msgAutoEvolve == null) mc.msgAutoEvolve = '✨ {nickname}님의 [{monster}]이(가) 자동으로 진화해서 [{targetMonster}]이(가) 되었습니다!'
  if (mc.cmdUserReset == null) mc.cmdUserReset = '!리셋'
  if (mc.msgUserResetUsage == null) mc.msgUserResetUsage = '⚠️ 사용법: {cmdUserReset} [고유닉]'
  if (mc.msgUserResetNoAuth == null) mc.msgUserResetNoAuth = '⚠️ DJ 또는 매니저만 사용할 수 있어요.'
  if (mc.msgUserResetNotFound == null) mc.msgUserResetNotFound = "⚠️ '{target}'님의 몬스터잡기 정보가 없어요."
  if (mc.msgUserResetSuccess == null) mc.msgUserResetSuccess = '🗑️ {target}님의 몬스터잡기 정보를 초기화했어요.'
  if (mc.cmdBallGive == null) mc.cmdBallGive = '!볼지급'
  if (mc.msgBallGiveUsage == null) mc.msgBallGiveUsage = '⚠️ 사용법: {cmdBallGive} [고유닉] [수량] (음수 입력 시 차감)'
  if (mc.msgBallGiveNoAuth == null) mc.msgBallGiveNoAuth = '⚠️ DJ 또는 매니저만 사용할 수 있어요.'
  if (mc.msgBallGiveSuccess == null) mc.msgBallGiveSuccess = '🎾 {target}님의 포획볼이 {amount}개 {action}되었습니다. (현재: {balls}개)'
  if (mc.bossEnabled == null) mc.bossEnabled = true
  if (mc.cmdRanking == null) mc.cmdRanking = '!랭킹'
  if (mc.bossMonsterName == null) mc.bossMonsterName = '풀잎'
  if (mc.bossPower == null) mc.bossPower = 100
  if (mc.bossIntervalMin == null) mc.bossIntervalMin = 60
  if (mc.bossJoinWindowSec == null) mc.bossJoinWindowSec = 90
  if (mc.cmdBossJoin == null) mc.cmdBossJoin = '!참여'
  if (mc.msgBossSpawn == null) mc.msgBossSpawn = '🌿 야생의 보스 [{monster}]이(가) 나타났습니다! (공격력 {bossPower}) {cmdBossJoin}로 함께 싸워보세요! ({sec}초 안에 참여 마감)'
  if (mc.msgBossFail == null) mc.msgBossFail = '💔 참여 {count}명 · 총 공격력 {totalPower}(으)로는 보스 [{monster}](공격력 {bossPower})를 처치하지 못했어요...'
  if (mc.msgBossJoin == null) mc.msgBossJoin = '⚔️ {nickname}님이 보스전에 참여했어요! (공격력 {power})'
  if (mc.msgBossAlreadyJoined == null) mc.msgBossAlreadyJoined = '⚠️ {nickname}님은 이미 참여했어요!'
  if (mc.msgBossNoMonsters == null) mc.msgBossNoMonsters = '⚠️ {nickname}님, 참여하려면 몬스터를 먼저 잡아야 해요!'
  if (mc.msgBossNoActive == null) mc.msgBossNoActive = '⚠️ 지금 진행 중인 보스전이 없어요.'
  if (mc.msgBossNoParticipants == null) mc.msgBossNoParticipants = '💨 아무도 도전하지 않아서 보스 [{monster}]이(가) 조용히 사라졌어요...'
  if (mc.msgBossResult == null) mc.msgBossResult = '🎉 보스 [{monster}] 격파! 참여 {count}명 · 총 공격력 {totalPower}\n🎲 주사위 대결 결과 {mvpNickname}님이 {mvpPower} 눈으로 승리! → 🌈이로치 [{reward}] 획득!'
  if (mc.cmdBossRoll == null) mc.cmdBossRoll = '!주사위'
  if (mc.bossRollWindowSec == null) mc.bossRollWindowSec = 30
  if (mc.msgBossRollPrompt == null) mc.msgBossRollPrompt = '⚔️ 보스 [{monster}] 격파! 보상은 주사위 대결로 정해요 — 참여자분들은 {sec}초 안에 {cmd}로 주사위를 굴려주세요!'
  if (mc.msgBossRollResult == null) mc.msgBossRollResult = '🎲 {nickname}님이 주사위를 굴려 {roll}이 나왔어요!'
  if (mc.msgBossRollAlready == null) mc.msgBossRollAlready = '⚠️ {nickname}님은 이미 주사위를 굴렸어요! ({roll})'
  if (mc.msgBossRollNotParticipant == null) mc.msgBossRollNotParticipant = '⚠️ 보스전에 참여하지 않으셨어요.'
  if (mc.msgBossRollNoOne == null) mc.msgBossRollNoOne = '💨 아무도 주사위를 굴리지 않아서 보상이 사라졌어요...'

  // 🗺️ 던전 탐험 — 채팅 명령어가 아니라 웹 도감 페이지의 "탐험" 버튼으로만 진행한다. 2~4명이 파티를
  // 꾸려서(각자 몬스터 1마리씩 데려옴) 층마다 등장하는 던전 몬스터와 맞붙는다. 던전 몬스터는 항상
  // 일반 카탈로그 몬스터를 그대로 참조하되 공격력을 2배로 쳐서(더 강하게) 등장하고, 타입 상성까지
  // 반영한 "파티 총 피해량"이 그 층의 체력(공격력*2) 이상이면 그 층 클리어. 한 층이라도 못 넘으면
  // 던전 실패. 전 층 클리어하면 보상 포인트를 파티원 수만큼 균등하게 나눠 받는다.
  if (!Array.isArray(mc.dungeons)) {
    mc.dungeons = [
      { id: 'dg_easy', name: '초급 던전', floors: [], rewardPoints: 20 },
    ]
  }
  mc.dungeons.forEach(d => { if (!Array.isArray(d.floors)) d.floors = [] }) // 예전 형식(requiredPower 단일값) 호환 — 층 목록 없으면 빈 배열로
  if (mc.dungeonMinParty == null) mc.dungeonMinParty = 2 // 👥 최소 파티 인원 (사람 수)
  if (mc.dungeonMaxParty == null) mc.dungeonMaxParty = 4 // 👥 최대 파티 인원 (사람 수)
  if (mc.dungeonMonstersPerMember == null) mc.dungeonMonstersPerMember = 3 // 🐾 인당 데려가는 몬스터 마리 수
  if (mc.dungeonCooldownSec == null) mc.dungeonCooldownSec = 60 // ⏱ 같은 사람이 다시 탐험을 돌 수 있는 최소 간격(초) — 포인트 파밍 방지

  // 🌐 포획볼/고급볼/도감(잡은 몬스터)/채팅카운트는 디제이별로 따로 두지 않고, 전체 플랫폼
  // 공용 저장소를 그대로 참조한다 — A디제이 방에서 모험 시작하고 몬스터를 모았으면 B디제이
  // 방에 가서도 이어서 쓸 수 있게 하기 위함. mc.bags 등은 이제부터 이 공용 객체의 참조라서,
  // 여기서 값을 바꾸면 바로 다른 디제이의 mc에도 똑같이 반영된다 (같은 객체를 보고 있으므로).
  let globalDex
  try {
    globalDex = store.loadGlobalMonsterDex()
  } catch (e) {
    console.log('[몬스터잡기] 전역 유저 데이터 로드 실패, 임시 빈 데이터로 대체:', e && e.message)
    globalDex = { bags: {}, greatBags: {}, collections: {}, chatCounts: {} }
  }
  mc.bags = globalDex.bags
  mc.greatBags = globalDex.greatBags
  mc.collections = globalDex.collections
  mc.chatCounts = globalDex.chatCounts

  // 🐾 자동 카탈로그 동기화(self-heal) — 예전엔 "저장" 버튼을 눌러야만 이 디제이의 몬스터
  // 목록이 전역 카탈로그(globalMonsterDex.json)에 반영됐다. 그래서 저장이 누락된 경우
  // (예: 일괄등록 후 저장을 안 누른 경우) 다른 디제이 방에서 !도감을 치면 이 디제이가
  // 등록해둔 몬스터 이름을 못 찾아서 "(알 수 없는 몬스터 #id)"로 깨지는 문제가 있었다.
  // 설정을 불러올 때마다(=이 함수가 호출될 때마다) 가볍게 동기화해서 이런 누락을 스스로
  // 고치도록 한다. upsertMonsterCatalog는 실제로 값이 달라질 때만 저장하므로 대부분의
  // 호출에서는 비교만 하고 끝나 비용이 거의 없다.
  if (mc.monsters && mc.monsters.length) {
    try { store.upsertMonsterCatalog(mc.monsters) } catch (e) {}
  }
  // 🌍 관리자(sum)가 "전체 몬스터 도감 통합 관리"를 켜뒀으면, 이 디제이가 개인적으로
  // 등록해둔 몬스터 목록 대신 관리자가 설정한 목록을 그대로 쓴다 — 그래야 어느 방에
  // 들어가도 동일한 몬스터가 나오고 동일한 타입 상성이 적용된다. 이 디제이 본인의
  // monsters 배열 자체는 손대지 않고(나중에 통합 관리를 끄면 다시 원래 목록으로 돌아옴),
  // 반환하는 mc 객체에서만 monsters를 바꿔치기한다.
  try {
    const gmc = getGlobalMonsterCatalog()
    if (gmc.enabled && gmc.monsters && gmc.monsters.length) {
      mc.monsters = gmc.monsters
      mc._globalCatalogActive = true
    } else {
      mc._globalCatalogActive = false
    }
  } catch (e) { mc._globalCatalogActive = false }
  // 🌍 관리자(sum)가 "던전/보스 통합 관리"를 켜뒀으면, 이 디제이가 개인적으로 설정해둔 던전 목록/
  // 파티 규칙/보스 스탯/주사위 설정 대신 관리자가 설정한 값을 그대로 쓴다 — 몬스터 도감 통합
  // 관리와 완전히 같은 방식(이 디제이 본인의 값 자체는 안 건드리고, 반환하는 mc에서만 덮어침).
  try {
    const gdb = getGlobalDungeonBossConfig()
    if (gdb.enabled) {
      mc.dungeons = gdb.dungeons
      mc.dungeonMinParty = gdb.dungeonMinParty
      mc.dungeonMaxParty = gdb.dungeonMaxParty
      mc.dungeonMonstersPerMember = gdb.dungeonMonstersPerMember
      mc.dungeonCooldownSec = gdb.dungeonCooldownSec
      mc.bossEnabled = gdb.bossEnabled
      mc.bossMonsterName = gdb.bossMonsterName
      mc.bossPower = gdb.bossPower
      mc.bossIntervalMin = gdb.bossIntervalMin
      mc.bossJoinWindowSec = gdb.bossJoinWindowSec
      mc.cmdBossJoin = gdb.cmdBossJoin
      mc.cmdBossRoll = gdb.cmdBossRoll
      mc.bossRollWindowSec = gdb.bossRollWindowSec
      mc._globalDungeonBossActive = true
    } else {
      mc._globalDungeonBossActive = false
    }
  } catch (e) { mc._globalDungeonBossActive = false }
  return mc
}

// 🌍 관리자(sum) 전용 — 전체 몬스터 도감 통합 관리. 관리자 계정의 settings 안에 저장해두고,
// 켜져있으면 모든 디제이의 getMonsterCatchSettings()가 이 목록을 그대로 쓰도록 위에서 덮어친다.
function getGlobalMonsterCatalog() {
  const settings = store.getSettings(SHARED_TOKEN_DJID) || {}
  if (!settings.globalMonsterCatalog) {
    settings.globalMonsterCatalog = { enabled: false, monsters: [] }
    store.saveSettings(SHARED_TOKEN_DJID, { globalMonsterCatalog: settings.globalMonsterCatalog })
  }
  if (!Array.isArray(settings.globalMonsterCatalog.monsters)) settings.globalMonsterCatalog.monsters = []
  return settings.globalMonsterCatalog
}

// 🌍 관리자(sum) 전용 — 던전/보스 통합 관리. 켜두면 각 디제이가 개인적으로 설정해둔 던전 목록/파티
// 규칙/보스 스탯/주사위 설정 대신, 여기서 설정한 값을 모든 디제이 방이 동일하게 쓴다. 몬스터 도감
// 통합 관리(getGlobalMonsterCatalog)랑 완전히 같은 패턴 — getMonsterCatchSettings 안에서 자동으로
// 덮어치고, 저장 API에서는 켜져있는 동안 해당 필드 저장을 막는다.
function getGlobalDungeonBossConfig() {
  const settings = store.getSettings(SHARED_TOKEN_DJID) || {}
  if (!settings.globalDungeonBossConfig) {
    settings.globalDungeonBossConfig = {
      enabled: false,
      dungeons: [], dungeonMinParty: 2, dungeonMaxParty: 4, dungeonMonstersPerMember: 3, dungeonCooldownSec: 60,
      bossEnabled: true, bossMonsterName: '풀잎', bossPower: 100, bossIntervalMin: 60, bossJoinWindowSec: 90, cmdBossJoin: '!참여',
      cmdBossRoll: '!주사위', bossRollWindowSec: 30,
    }
    store.saveSettings(SHARED_TOKEN_DJID, { globalDungeonBossConfig: settings.globalDungeonBossConfig })
  }
  if (!Array.isArray(settings.globalDungeonBossConfig.dungeons)) settings.globalDungeonBossConfig.dungeons = []
  return settings.globalDungeonBossConfig
}

// 🌐 포획볼/도감 등 "유저 공용 데이터"가 바뀌었을 때 저장 — 디제이별 settings 파일이 아니라
// globalMonsterDex.json 하나에만 반영한다 (mc.bags 등은 이미 그 공용 객체를 직접 참조하고
// 있으므로, 여기선 디스크에 내려쓰기만 하면 된다).
function mcSaveUserData() {
  store.saveGlobalMonsterDex()
}

// 디제이별 커스텀 설정(멘트/명령어/몬스터 목록/상점 구성 등)만 그 디제이의 settings 파일에 저장한다.
// mc 안의 bags/greatBags/collections/chatCounts(전역 공용 데이터)는 통째로 노출/중복저장되지
// 않도록 mcConfigOnly()로 제외한 뒤 저장한다.
function mcConfigOnly(mc) {
  const { bags, greatBags, collections, chatCounts, ...configOnly } = mc
  return configOnly
}
function mcSaveConfig(djId, mc) {
  store.saveSettings(djId, { monsterCatch: mcConfigOnly(mc) })
}

function mcFormat(tpl, data) {
  const v = (val) => (val === undefined || val === null || val === '') ? '0' : String(val)
  return String(tpl || '')
    .replace(/{nickname}/g, data.nickname || '')
    .replace(/{monster}/g, data.monster || '')
    .replace(/{cmd}/g, data.cmd || '')
    .replace(/{cmdCatch}/g, data.cmdCatch || '')
    .replace(/{sec}/g, v(data.sec))
    .replace(/{count}/g, v(data.count))
    .replace(/{balls}/g, v(data.balls))
    .replace(/{greatBalls}/g, v(data.greatBalls))
    .replace(/{cost}/g, v(data.cost))
    .replace(/{amount}/g, v(data.amount))
    .replace(/{reward}/g, v(data.reward))
    .replace(/{lotto}/g, v(data.lotto))
    .replace(/{cmdBuyBall}/g, data.cmdBuyBall || '')
    .replace(/{cmdStart}/g, data.cmdStart || '')
    .replace(/{cmdBattle}/g, data.cmdBattle || '')
    .replace(/{target}/g, data.target || '')
    .replace(/{myMonster}/g, data.myMonster || '')
    .replace(/{targetMonster}/g, data.targetMonster || '')
    .replace(/{winner}/g, data.winner || '')
    .replace(/{winnerMonster}/g, data.winnerMonster || '')
    .replace(/{loserMonster}/g, data.loserMonster || '')
    .replace(/{move}/g, data.move || '')
    .replace(/{effect}/g, data.effect || '')
    .replace(/{need}/g, v(data.need))
    .replace(/{owned}/g, v(data.owned))
    .replace(/{cmdEvolve}/g, data.cmdEvolve || '')
    .replace(/{cmdUserReset}/g, data.cmdUserReset || '')
    .replace(/{action}/g, data.action || '')
    .replace(/{cmdBallGive}/g, data.cmdBallGive || '')
    .replace(/{cmdBossJoin}/g, data.cmdBossJoin || '')
    .replace(/{power}/g, v(data.power))
    .replace(/{totalPower}/g, v(data.totalPower))
    .replace(/{mvpNickname}/g, data.mvpNickname || '')
    .replace(/{mvpPower}/g, v(data.mvpPower))
    .replace(/{bossPower}/g, v(data.bossPower))
    .replace(/{roll}/g, v(data.roll))
    .replace(/{cmdBossRoll}/g, data.cmdBossRoll || '')
}

function mcPickMonster(mc) {
  const list = (mc.monsters || []).filter(m => m.name && Number(m.weight) > 0)
  if (!list.length) return null
  const total = list.reduce((s, m) => s + Number(m.weight), 0)
  let r = Math.random() * total
  for (const m of list) {
    r -= Number(m.weight)
    if (r <= 0) return m
  }
  return list[list.length - 1]
}
// 🌟 거다이맥스 보상용 — 거다이맥스 폼이 있는 화이트리스트(MC_GMAX_ELIGIBLE_IDS) 안에서만 랜덤으로 고른다.
function mcPickGmaxMonster(mc) {
  const list = (mc.monsters || []).filter(m => m.name && Number(m.weight) > 0 && mcIsGmaxEligible(m.id))
  if (!list.length) return null
  const total = list.reduce((s, m) => s + Number(m.weight), 0)
  let r = Math.random() * total
  for (const m of list) {
    r -= Number(m.weight)
    if (r <= 0) return m
  }
  return list[list.length - 1]
}

// ══════════════════════════════════════════════════════
// 🔥 타입(속성) 상성표 — 포켓몬 세대1 상성 그대로. 값은 데미지 배율(2=효과 굉장함, 0.5=별로,
// 0=효과 없음, 표시 없으면 1배). [공격타입][방어타입] 형태로 조회한다.
const MC_TYPE_NAMES = ['노말', '불꽃', '물', '전기', '풀', '얼음', '격투', '독', '땅', '비행', '에스퍼', '벌레', '바위', '고스트', '드래곤', '악', '강철', '페어리']
const MC_TYPE_CHART = {
  '노말': { '고스트': 0 },
  '불꽃': { '불꽃': 0.5, '물': 0.5, '풀': 2, '얼음': 2, '벌레': 2, '바위': 0.5, '드래곤': 0.5, '강철': 2 },
  '물': { '불꽃': 2, '물': 0.5, '풀': 0.5, '땅': 2, '바위': 2, '드래곤': 0.5 },
  '전기': { '물': 2, '전기': 0.5, '풀': 0.5, '땅': 0, '비행': 2, '드래곤': 0.5 },
  '풀': { '불꽃': 0.5, '물': 2, '풀': 0.5, '독': 0.5, '땅': 2, '비행': 0.5, '벌레': 0.5, '바위': 2, '드래곤': 0.5, '강철': 0.5 },
  '얼음': { '불꽃': 0.5, '물': 0.5, '풀': 2, '얼음': 0.5, '땅': 2, '비행': 2, '드래곤': 2, '강철': 0.5 },
  '격투': { '노말': 2, '얼음': 2, '독': 0.5, '비행': 0.5, '에스퍼': 0.5, '벌레': 0.5, '바위': 2, '고스트': 0, '악': 2, '강철': 2, '페어리': 0.5 },
  '독': { '풀': 2, '독': 0.5, '땅': 0.5, '바위': 0.5, '고스트': 0.5, '강철': 0, '페어리': 2 },
  '땅': { '불꽃': 2, '전기': 2, '풀': 0.5, '독': 2, '비행': 0, '바위': 2, '벌레': 0.5, '강철': 2 },
  '비행': { '전기': 0.5, '풀': 2, '격투': 2, '벌레': 2, '바위': 0.5, '강철': 0.5 },
  '에스퍼': { '격투': 2, '독': 2, '에스퍼': 0.5, '악': 0, '강철': 0.5 },
  '벌레': { '불꽃': 0.5, '풀': 2, '격투': 0.5, '독': 0.5, '비행': 0.5, '에스퍼': 2, '고스트': 0.5, '악': 2, '강철': 0.5, '페어리': 0.5 },
  '바위': { '불꽃': 2, '얼음': 2, '격투': 0.5, '땅': 0.5, '비행': 2, '벌레': 2, '강철': 0.5 },
  '고스트': { '노말': 0, '에스퍼': 2, '고스트': 2, '악': 0.5 },
  '드래곤': { '드래곤': 2, '강철': 0.5, '페어리': 0 },
  '악': { '격투': 0.5, '에스퍼': 2, '고스트': 2, '악': 0.5, '페어리': 0.5 },
  '강철': { '불꽃': 0.5, '물': 0.5, '전기': 0.5, '얼음': 2, '바위': 2, '강철': 0.5, '페어리': 2 },
  '페어리': { '불꽃': 0.5, '격투': 2, '독': 0.5, '드래곤': 2, '악': 2, '강철': 0.5 },
}
// 공격 타입(들) vs 방어 타입(들)의 종합 배율을 계산한다 — 이중 타입은 배율을 곱해서 누적한다
// (예: 얼음 공격이 풀/땅 방어 상대에게 2×2=4배). 공격 쪽이 여러 타입이면 그중 가장 유리한
// 배율(최댓값)을 쓴다 — 어떤 기술을 냈는지는 몰라도 "그 몬스터가 가장 잘 먹히는 방식으로 싸웠다"는 셈이다.
function mcTypeMultiplier(attackerTypes, defenderTypes) {
  const atkTypes = (Array.isArray(attackerTypes) && attackerTypes.length) ? attackerTypes : ['노말']
  const defTypes = (Array.isArray(defenderTypes) && defenderTypes.length) ? defenderTypes : ['노말']
  let best = 0
  atkTypes.forEach(atk => {
    let mult = 1
    defTypes.forEach(def => {
      const chart = MC_TYPE_CHART[atk]
      const v = chart && chart[def] != null ? chart[def] : 1
      mult *= v
    })
    if (mult > best) best = mult
  })
  return best
}
function mcTypeEffectText(mult) {
  if (mult === 0) return '❌ 효과가 없다!'
  if (mult >= 2) return '💥 효과가 굉장했다!'
  if (mult < 1) return '🔸 효과가 별로였다...'
  return ''
}

// 대결에 쓸 "가장 강한 보유 몬스터"를 골라준다 (공격력 기준). 잡은 게 없으면 null.
const MC_SHINY_PREFIX = 'shiny_' // ✨ 이로치 몬스터는 원본 도감 id 앞에 이 접두사를 붙인 별도 id로 취급한다
const MC_SHINY_POWER_MULT = 1.1  // 이로치는 같은 몬스터의 일반 개체보다 공격력 10% 더 강함
const MC_SHINY_CHANCE = 0.1      // 희귀상자를 열었을 때 이로치가 나올 확률 (10%)
function mcIsShinyId(id) { return typeof id === 'string' && id.startsWith(MC_SHINY_PREFIX) }
function mcBaseIdFromShiny(id) { return mcIsShinyId(id) ? id.slice(MC_SHINY_PREFIX.length) : id }

// 🌟 거다이맥스 — 이로치와 똑같은 방식(원본 도감 id 앞에 별도 접두사)으로 취급하는 영구 변종.
// 이로치보다 더 희귀하고(3%) 공격력 보너스도 더 크다(+30%). id 하나엔 접두사가 하나만 붙을 수 있어서
// 이로치와 거다이맥스를 동시에 가질 순 없다 — 잡을 때/상자를 열 때 거다이맥스 확률을 먼저 굴리고,
// 거다이맥스가 안 나왔을 때만 이로치 확률을 굴린다(어떤 몬스터 종이든 확률적으로 나올 수 있음).
const MC_GMAX_PREFIX = 'gmax_'
const MC_GMAX_POWER_MULT = 1.3
const MC_GMAX_CHANCE = 0.03
function mcIsGmaxId(id) { return typeof id === 'string' && id.startsWith(MC_GMAX_PREFIX) }
function mcBaseIdFromGmax(id) { return mcIsGmaxId(id) ? id.slice(MC_GMAX_PREFIX.length) : id }
// 🌟 거다이맥스는 실제 포켓몬 게임과 동일하게 "거다이맥스 폼이 있는 종"만 나올 수 있다 — 기본값은 1세대(도감 001~151)
// 기준으로 실제 거다이맥스가 존재하는 12종: 이상해꽃/리자몽/거북왕/버터플/피카츄/나옹/괴력몬/팬텀/킹크랩/라프라스/이브이/잠만보.
// 관리자(sum)가 admin 페이지에서 이 목록을 직접 추가/제거할 수 있다(settings.gmaxConfig.eligibleIds) — 여기 있는 배열은
// 최초 1회 생성될 때만 쓰이는 기본값이고, 실제 판정은 getGmaxConfig()가 저장된 목록을 기준으로 한다.
const MC_GMAX_ELIGIBLE_IDS = ['pkmn-003', 'pkmn-006', 'pkmn-009', 'pkmn-012', 'pkmn-025', 'pkmn-052', 'pkmn-068', 'pkmn-094', 'pkmn-099', 'pkmn-131', 'pkmn-133', 'pkmn-143']
function getGmaxConfig() {
  const settings = store.getSettings(SHARED_TOKEN_DJID) || {}
  if (!settings.gmaxConfig) {
    settings.gmaxConfig = { eligibleIds: [...MC_GMAX_ELIGIBLE_IDS] }
    store.saveSettings(SHARED_TOKEN_DJID, { gmaxConfig: settings.gmaxConfig })
  }
  if (!Array.isArray(settings.gmaxConfig.eligibleIds)) settings.gmaxConfig.eligibleIds = [...MC_GMAX_ELIGIBLE_IDS]
  return settings.gmaxConfig
}
function mcIsGmaxEligible(id) { return getGmaxConfig().eligibleIds.includes(id) }

// id(이로치/거다이맥스 id 포함)로 실제 몬스터 정의 + 표시용 이름 + 실제 공격력을 한 번에 계산해준다.
function mcResolveMonster(id, monsters, tag) {
  const gmax = mcIsGmaxId(id)
  const shiny = !gmax && mcIsShinyId(id)
  const baseId = gmax ? mcBaseIdFromGmax(id) : mcBaseIdFromShiny(id)
  const m = (monsters || []).find(mm => mm.id === baseId)
  if (!m) return null
  const basePower = Number(m.power) || 10
  let power = gmax ? Math.round(basePower * MC_GMAX_POWER_MULT) : (shiny ? Math.round(basePower * MC_SHINY_POWER_MULT) : basePower)
  if (tag) power += mcLevelBonus(mcMonsterLevel(tag, id)) // 🆙 웹 도감에서 레벨업한 만큼 공격력 보너스
  return {
    monster: m,
    shiny,
    gmax,
    name: gmax ? `🌟거다이맥스 ${m.name}` : (shiny ? `🌈이로치 ${m.name}` : m.name),
    power,
  }
}

function mcPickStrongest(collection, monsters, tag) {
  const owned = Object.keys(collection || {}).filter(id => collection[id] > 0)
  if (!owned.length) return null
  // 🥊 웹 도감에서 "대결할 몬스터"로 직접 선택해둔 게 있으면(보유 중인 한) 그걸 최우선으로 쓴다.
  if (tag) {
    const selected = mcGetWebData().selected[tag]
    if (selected && owned.includes(String(selected))) {
      const resolved = mcResolveMonster(selected, monsters, tag)
      if (resolved) return { ...resolved.monster, name: resolved.name, power: resolved.power }
    }
  }
  // ✨ 대결(배틀) 시 전설 몬스터를 1순위로 사용한다 — 보유한 전설 몬스터가 있으면 그중 가장 강한
  // 걸 쓰고, 전설이 하나도 없을 때만 기존처럼 전체 보유 몬스터 중 가장 강한 걸 쓴다.
  // (이로치 여부와 무관하게 "전설 원본 몬스터의 이로치"도 전설 취급한다)
  const pickStrongestFrom = (idList) => {
    let best = null
    idList.forEach(id => {
      const resolved = mcResolveMonster(id, monsters, tag)
      if (!resolved) return
      if (!best || resolved.power > best.power) best = { id, resolved }
    })
    return best ? { ...best.resolved.monster, name: best.resolved.name, power: best.resolved.power } : null
  }
  const legendaryOwned = owned.filter(id => {
    const resolved = mcResolveMonster(id, monsters, tag)
    return resolved && resolved.monster.legendary
  })
  if (legendaryOwned.length) return pickStrongestFrom(legendaryOwned)
  return pickStrongestFrom(owned)
}

// 🏆 !도감 / !랭킹에서 공통으로 쓰는 "이 트레이너의 대표(에이스) 몬스터" 계산 — 레벨업 보너스까지
// 반영한 실제 공격력 기준으로 가장 강한 걸 찾는다 (mcPickStrongest와 별개로, 여기선 레벨 숫자도 같이 필요해서 직접 계산한다).
function mcComputeTrainerAce(collection, monsters, tag) {
  const owned = Object.keys(collection || {}).filter(id => collection[id] > 0)
  let best = null
  owned.forEach(id => {
    const resolved = mcResolveMonster(id, monsters, tag)
    // ⚠️ 레벨은 반드시 id를 그대로(이로치면 접두사 포함) 써서 조회해야 한다 — 레벨업/공격력
    // 계산(mcResolveMonster 내부)도 이 방식으로 조회하고, 이로치와 일반은 서로 다른 레벨을
    // 따로 관리하기 때문이다. 여기서 mcBaseIdFromShiny로 접두사를 벗겨서 조회하면, 이로치
    // 몬스터는 실제 레벨(예: 70)이 있어도 항상 "레벨 1"로 잘못 표시된다(공격력은 내부적으로
    // 이미 올바른 id로 조회해서 정확한데, 화면 표시만 따로 어긋나 보이는 버그가 있었다).
    if (resolved && (!best || resolved.power > best.power)) {
      best = { power: resolved.power, name: resolved.name, level: mcMonsterLevel(tag, id) }
    }
  })
  return best
}
// 🌍 전체 트레이너 랭킹(에이스 공격력 내림차순) — mc.collections는 djId별 설정 안에 있지만
// 실제로는 전역 공유 데이터라서, 이 랭킹은 어느 방에서 계산해도 전체 플랫폼 기준이 된다.
function mcComputeGlobalRanking(mc) {
  const allTags = Object.keys(mc.collections || {})
  return allTags
    .map(t => ({ tag: t, ace: mcComputeTrainerAce(mc.collections[t], mc.monsters, t) }))
    .filter(r => r.ace)
    .sort((a, b) => b.ace.power - a.ace.power)
}

// ══════════════════════════════════════════════════════
// 🐾 몬스터 웹 도감 — 웹뽑기판/마피아와 같은 register→code→채팅인증 패턴을 그대로 재사용해서,
// 시청자가 웹페이지에서 로그인 없이 "본인 도감"을 확인하고, 대결에 쓸 몬스터를 직접 고르고,
// 중복 몬스터를 분해해서 나온 포인트(경험치)로 원하는 몬스터를 레벨업(공격력 강화)할 수 있다.
// 몬스터잡기 자체가 디제이 구분 없는 전체 플랫폼 공용 시스템이라(어느 방에서 잡든 같은 도감),
// 이 웹 도감 데이터도 djId로 안 나누고 파일 하나에 전부 저장한다. store.js의 정확한 저장
// 스키마에 의존하지 않도록 이 기능 전용 파일을 따로 둔다.
const MC_WEB_FILE = path.join(store.DATA_DIR, 'monsterWebData.json')
let mcWebDataCache = null
function mcGetWebData() {
  if (mcWebDataCache) return mcWebDataCache
  try {
    mcWebDataCache = JSON.parse(fs.readFileSync(MC_WEB_FILE, 'utf8'))
  } catch (e) {
    mcWebDataCache = {}
  }
  if (!mcWebDataCache.levels) mcWebDataCache.levels = {} // { tag: { monsterId: { level, exp } } }
  if (!mcWebDataCache.selected) mcWebDataCache.selected = {} // { tag: monsterId }
  if (!mcWebDataCache.points) mcWebDataCache.points = {} // { tag: number } — 분해로 모은 경험치 포인트
  if (!mcWebDataCache.webUsers) mcWebDataCache.webUsers = {} // { webUserId: tag }
  if (!mcWebDataCache.authKeys) mcWebDataCache.authKeys = {} // { code: { webUserId, expiresAt } }
  if (!mcWebDataCache.profiles) mcWebDataCache.profiles = {} // { tag: profileImageUrl } — 인증 시점에 채팅 이벤트에서 캡처
  if (!mcWebDataCache.reversiStats) mcWebDataCache.reversiStats = {} // { tag: { wins, losses, draws } } — 리버시 누적 전적
  return mcWebDataCache
}
function mcSaveWebData() {
  // 🐌 이 파일은 도감/분해/레벨업/월드보스 보상 등 아주 자주 호출되는데, 매번 동기(blocking)로
  // 디스크에 쓰면 그 사이 다른 모든 요청(채팅 명령어 포함)이 멈춰버린다. 여러 명이 동시에
  // 몬스터를 잡거나 분해하면 이게 겹겹이 쌓여서 전체적으로 느려지는 원인이 될 수 있다.
  // 그래서 즉시 쓰지 않고 300ms 안에 여러 번 호출돼도 마지막 한 번만, 비동기로 쓰도록 묶는다.
  clearTimeout(mcSaveWebDataDebounce)
  mcSaveWebDataDebounce = setTimeout(() => {
    fs.mkdir(path.dirname(MC_WEB_FILE), { recursive: true }, () => {
      fs.writeFile(MC_WEB_FILE, JSON.stringify(mcWebDataCache, null, 2), (err) => {
        if (err) console.log('[몬스터 웹도감] 저장 실패:', err.message)
      })
    })
  }, 300)
}
let mcSaveWebDataDebounce = null
const mcDungeonCooldownMap = new Map() // 🗺️ 던전 탐험 쿨타임 — key: 고유닉(tag) -> 마지막 탐험 시각(ms). 서버 재시작하면 초기화되는 인메모리 값(대결 쿨타임과 동일한 방식)
const MC_LEVEL_ATTACK_BONUS = 3 // 레벨 1당 공격력 +3
function mcLevelBonus(level) { return Math.max(0, (Number(level) || 1) - 1) * MC_LEVEL_ATTACK_BONUS }
function mcMonsterLevel(tag, monsterId) {
  const d = mcGetWebData()
  const entry = d.levels[tag] && d.levels[tag][monsterId]
  return entry ? entry.level : 1
}
function mcLevelUpCost(currentLevel) { return currentLevel * 10 } // 레벨이 높을수록 다음 레벨 비용이 커진다
function mcDismantlePoints(basePower, shiny, gmax) { return Math.round(Math.max(1, Math.round((Number(basePower) || 10) / 3)) * (gmax ? 1.3 : (shiny ? 1.1 : 1))) }
const MC_AUTH_KEY_TTL_MS = 10 * 60 * 1000
function mcGenAuthKey(d) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let key
  do { key = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('') } while (d.authKeys[key])
  return key
}
function mcCleanExpiredKeys(d) {
  const now = Date.now()
  for (const k of Object.keys(d.authKeys)) { if (!d.authKeys[k] || d.authKeys[k].expiresAt < now) delete d.authKeys[k] }
}
// 💬 웹 도감 인증 — 몬스터잡기 모듈이 켜져있는 어느 방에서든(도감이 전체 공용이라) 채팅으로
// "!도감인증 코드"(또는 코드만 딱)를 치면 그 채팅 계정(고유닉)과 웹 세션을 연결해준다.
async function handleMonsterDexCommand(djId, settings, author, actTag, text, profileUrl) {
  // ⚠️ /register, /data(웹페이지) 쪽은 "몬스터잡기 OR 리버시" 둘 중 하나만 켜있어도 동작하게
  // 되어있는데, 여기(채팅으로 코드 인증하는 부분)만 몬스터잡기 단독 체크라 리버시만 켜놓은
  // 방에서는 코드를 채팅에 쳐도 영영 인증이 안 되고 웹페이지가 로딩 상태로 멈춰있었다.
  if (!isModuleOn(settings, 'monstercatch', djId) && !isModuleOn(settings, 'reversi', djId)) return
  // ⚠️ mc.collections/mc.levels/mc.points 등은 전부 "소문자로 통일한 고유닉"을 키로 쓰고 있어서
  // (다른 몬스터잡기 명령어들이 다 key.toLowerCase()로 처리함), 여기도 반드시 소문자로 맞춰야
  // 웹 도감이 실제 채팅에서 잡은 기록과 같은 사람으로 인식된다. 이걸 안 맞추면 대소문자가
  // 하나라도 다를 때 웹 도감이 전부 "???"(못 찾음)로 나오고 레벨도 항상 1로 보인다.
  const tag = actTag ? String(actTag).replace(/^@/, '').trim().toLowerCase() : ''
  const msg = String(text || '').trim()
  const d = mcGetWebData()

  const tryAuth = (code) => {
    if (!tag) return sendChatSplit(djId, '⚠️ 고유닉 정보를 확인할 수 없어요. 잠시 후 다시 시도해주세요.', 150, 300)
    mcCleanExpiredKeys(d)
    const entry = d.authKeys[code]
    if (!entry) return sendChatSplit(djId, '⚠️ 유효하지 않거나 만료된 인증코드예요. 웹 도감 페이지에서 다시 발급받아주세요.', 150, 300)
    d.webUsers[entry.webUserId] = tag
    if (profileUrl) d.profiles[tag] = profileUrl // 🖼️ 인증 순간의 채팅 이벤트에 실려온 프로필 이미지를 같이 저장 (리버시 등에서 표시용)
    delete d.authKeys[code]
    mcSaveWebData()
    return sendChatSplit(djId, `✅ ${author}님 웹 도감 인증 완료! 이제 웹에서 본인 도감을 확인할 수 있어요.`, 150, 300)
  }

  if (msg.startsWith('!')) {
    const parts = msg.split(/\s+/)
    if (parts[0] === '!도감인증') {
      const code = String(parts[1] || '').trim().toUpperCase()
      if (!code) return sendChatSplit(djId, '사용법: !도감인증 코드6자리', 150, 300)
      return tryAuth(code)
    }
    return
  }
  const rawCode = msg.replace(/\s+/g, '').toUpperCase()
  if (/^[A-Z0-9]{6}$/.test(rawCode)) {
    mcCleanExpiredKeys(d)
    if (d.authKeys[rawCode]) return tryAuth(rawCode)
  }
}

// ══════════════════════════════════════════════════════
// 👤 내정보 웹페이지 — DJ 방(djId)별로, 시청자가 로그인 없이 웹페이지에서 인증코드를 발급받고
// 채팅으로 그 코드를 치면(웹뽑기판/마피아/몬스터도감과 동일한 register→code→채팅인증 패턴)
// 애청지수·복권·킵/이벤트/기타 목록·룰렛권 보유 현황을 채팅 명령어 없이 한 화면에서 볼 수 있다.
// 애청지수(activity)·룰렛기록(rouletteHistory)은 djId별 settings 안에 이미 있는 데이터를 그대로
// 읽어서 보여주기만 하고, 이 모듈이 새로 저장하는 건 인증코드↔웹세션 연결 정보뿐이다.
function getMyInfoSettings(djId, settings) {
  if (!settings.myinfo) {
    settings.myinfo = { webUsers: {}, authKeys: {}, cmdAuth: '!내정보인증' }
    store.saveSettings(djId, { myinfo: settings.myinfo })
  }
  const mi = settings.myinfo
  if (!mi.webUsers || typeof mi.webUsers !== 'object') mi.webUsers = {}
  if (!mi.authKeys || typeof mi.authKeys !== 'object') mi.authKeys = {}
  if (!mi.cmdAuth) mi.cmdAuth = '!내정보인증'
  if (!mi.postRewardGiven || typeof mi.postRewardGiven !== 'object') mi.postRewardGiven = {} // 포스트 좋아요/댓글 첫 참여 보상을 이미 받은 tag 기록
  return mi
}
function saveMyInfo(djId, mi) { store.saveSettings(djId, { myinfo: mi }) }

// 🎰 포스트에 좋아요 또는 댓글을 처음 남긴 시청자에게 딱 한 번(좋아요든 댓글이든, 둘 중 먼저 한 쪽
// 기준으로) 복권 10장을 지급한다. 애청지수(loyalty) 모듈이 켜져있을 때만 지급하고, 이미 받았으면
// 조용히 건너뛴다. 지급했으면 지급한 개수를, 아니면 0을 반환한다.
function grantFirstPostRewardIfEligible(djId, settings, mi, tag) {
  if (!tag || !isModuleOn(settings, 'loyalty', djId)) return 0
  if (mi.postRewardGiven[tag]) return 0
  const act = getActivitySettings(djId, settings)
  const actKey = actResolveKey(act, null, tag) || tag
  const d = actEnsureUser(act, actKey, null, tag)
  const bonus = 10
  d.lotto = (d.lotto || 0) + bonus
  mi.postRewardGiven[tag] = Date.now()
  store.saveSettings(djId, { activity: act, myinfo: mi })
  return bonus
}

const MI_AUTH_KEY_TTL_MS = 10 * 60 * 1000
function miRand(max) { return Math.floor(Math.random() * max) }
function miGenAuthKey(mi) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let key
  do { key = Array.from({ length: 6 }, () => chars[miRand(chars.length)]).join('') } while (mi.authKeys[key])
  return key
}
function miCleanExpiredKeys(mi) {
  const now = Date.now()
  for (const k of Object.keys(mi.authKeys)) { if (!mi.authKeys[k] || mi.authKeys[k].expiresAt < now) delete mi.authKeys[k] }
}
function miHandleAuth(djId, mi, tag, author, code) {
  if (!tag) return sendChatSplit(djId, '⚠️ 고유닉 정보를 확인할 수 없어요. 잠시 후 다시 시도해주세요.', 150, 300)
  miCleanExpiredKeys(mi)
  const entry = mi.authKeys[code]
  if (!entry) return sendChatSplit(djId, '⚠️ 유효하지 않거나 만료된 인증코드예요. 웹페이지에서 다시 발급받아주세요.', 150, 300)
  mi.webUsers[entry.webUserId] = tag
  delete mi.authKeys[code]
  saveMyInfo(djId, mi)
  return sendChatSplit(djId, `✅ ${author}님 내정보 웹페이지 인증 완료! 이제 웹에서 본인 정보를 바로 확인할 수 있어요.`, 150, 300)
}

// 채팅 명령어 처리: "!내정보인증 코드6자리" 또는 코드만 딱 (다른 웹인증 모듈들과 동일한 방식)
function handleMyInfoCommand(djId, settings, author, actTag, text) {
  if (!isModuleOn(settings, 'myinfo', djId)) return
  const mi = getMyInfoSettings(djId, settings)
  const msg = String(text || '').trim()
  const tag = actTag ? String(actTag).replace(/^@/, '').trim() : ''

  // ⚠️ 웹뽑기판/마피아/몬스터도감 등 여러 모듈이 같은 "코드만 딱 치면 인식" 방식을 같이 쓰기
  // 때문에, 여기서 못 찾았다고 바로 "잘못된 코드"라고 단정하면 안 된다 — 다른 모듈용 코드일
  // 수도 있어서, 조용히 넘겨서 뒤에 있는 다른 모듈 핸들러가 확인하게 둔다.
  if (!msg.startsWith('!')) {
    const rawCode = msg.replace(/\s+/g, '').toUpperCase()
    if (/^[A-Z0-9]{6}$/.test(rawCode)) {
      miCleanExpiredKeys(mi)
      if (mi.authKeys[rawCode]) return miHandleAuth(djId, mi, tag, author, rawCode)
    }
    return
  }
  const parts = msg.split(/\s+/)
  if (parts[0] === (mi.cmdAuth || '!내정보인증')) {
    if (!tag) return sendChatSplit(djId, '⚠️ 고유닉 정보를 확인할 수 없어요. 잠시 후 다시 시도해주세요.', 150, 300)
    const code = String(parts[1] || '').trim().toUpperCase()
    if (!code) return sendChatSplit(djId, `사용법: ${mi.cmdAuth} 코드6자리`, 150, 300)
    return miHandleAuth(djId, mi, tag, author, code)
  }
}

// 한 시청자(tag 기준)의 애청지수·복권·킵/이벤트/기타 목록·룰렛권 보유 현황을 웹페이지용으로
// 한 번에 모아준다. 애청지수는 "!내정보 생성"으로 등록된 사람만 데이터가 있고, 미등록이어도
// 룰렛/킵 기록은 태그만 있으면 조회되므로 각각 따로 registered 여부를 표시한다.
async function miBuildProfile(djId, settings, tag) {
  const act = getActivitySettings(djId, settings)
  const actKey = actResolveKey(act, null, tag) // 닉네임은 수시로 바뀌므로 태그로만 조회
  const ad = actKey ? act.users[actKey] : null
  const lvInfo = actGetLevel(ad ? (ad.exp || 0) : 0, act.lvBase)

  const rec = (settings.rouletteHistory && settings.rouletteHistory[tag]) || { coupons: {}, wins: [], keepList: {}, miscList: {}, eventList: {} }
  const nickname = (ad && ad.nickname) || rec.nickname || tag

  // 🖼️ 프로필 이미지 — 채팅/하트로 이미 캐시된 게 있으면 그걸 쓰고, 없으면 스푼 검색 API로
  // 한 번 직접 조회해서 알아온다 (내정보 페이지 헤더에 실제 프로필 사진을 보여주기 위함).
  let imgUrl = (ad && ad.imgUrl) || ''
  if (!imgUrl) {
    const room = getRoom(djId)
    imgUrl = getCachedProfileUrl(room, tag, nickname) || ''
  }
  if (!imgUrl) {
    try {
      const info = await fetchUserStatusByTag(tag)
      if (info && info.photoUrl) imgUrl = info.photoUrl
    } catch (e) { /* 조회 실패해도 그냥 기본 아이콘으로 보여주면 되니 무시 */ }
  }

  const rouletteList = (settings.roulette && Array.isArray(settings.roulette.list)) ? settings.roulette.list : []
  const coupons = Object.entries(rec.coupons || {})
    .map(([idx, count]) => ({ idx: Number(idx), name: (rouletteList[Number(idx) - 1] && rouletteList[Number(idx) - 1].name) || `룰렛${idx}`, count: Number(count) || 0 }))
    .filter(c => c.count > 0)
    .sort((a, b) => a.idx - b.idx)
  const toList = (obj) => Object.entries(obj || {}).map(([name, count]) => ({ name, count: Number(count) || 0 })).sort((a, b) => b.count - a.count)

  return {
    nickname,
    imgUrl,
    loyalty: ad ? {
      registered: true,
      level: lvInfo.level, exp: lvInfo.curExp, nextExp: lvInfo.nextExp,
      rank: actRank(act.users, actKey),
      heart: ad.heart || 0, chat: ad.chat || 0, attend: ad.attend || 0,
      lp: ad.lp || 0, lpMax: Number(act.lottoExchange) || 22,
      lotto: ad.lotto || 0,
    } : { registered: false, lotto: 0 },
    coupons,
    keepList: toList(rec.keepList),
    eventList: toList(rec.eventList),
    miscList: toList(rec.miscList),
  }
}


// 봇이 방송에 새로 연결될 때(ws open)마다 호출 — 이번 방송에서 몬스터 등장 타이머를 새로 시작.
// 📢 전체방 반복 공지 — 지금 방송 연결되어있는(isConnected) 모든 디제이 방에 정해진 간격마다
// 같은 문구를 채팅으로 뿌린다. 서버 전체에 딱 하나만 도는 전역 타이머(방마다 따로 있는 게 아님).
let globalAnnounceTimer = null
// 🛡️ store.js에 getGlobalAnnounce/setGlobalAnnounce가 아직 없는 배포본에서도 서버가
// 죽지 않도록(uncaughtException) 안전하게 감싼 함수. store.js에 실제 함수가 추가되면
// 자동으로 그쪽을 우선 사용한다.
function getGlobalAnnounceSafe() {
  if (typeof store.getGlobalAnnounce === 'function') {
    try { return store.getGlobalAnnounce() } catch (e) { console.log('[전체방 공지] store.getGlobalAnnounce 호출 실패:', e.message) }
  }
  return { enabled: false, message: '', intervalMin: 30, excludeDjIds: [] }
}
function startGlobalAnnounceTimer() {
  if (globalAnnounceTimer) { clearInterval(globalAnnounceTimer); globalAnnounceTimer = null }
  const cfg = getGlobalAnnounceSafe()
  if (!cfg.enabled || !cfg.message) { console.log('[전체방 공지] 타이머 시작 안 함 — 꺼져있거나 문구가 비어있어요'); return }
  const intervalMs = Math.max(1, Math.min(720, parseInt(cfg.intervalMin, 10) || 30)) * 60 * 1000
  globalAnnounceTimer = setInterval(() => {
    const cur = getGlobalAnnounceSafe() // 매번 최신 설정으로 다시 읽어서, 중간에 문구/제외목록이 바뀌어도 바로 반영
    if (!cur.enabled || !cur.message) return
    const excludeSet = new Set((cur.excludeDjIds || []).map(x => String(x).trim().toLowerCase()))
    let sentCount = 0
    Object.keys(rooms).forEach(djId => {
      const room = rooms[djId]
      if (!room || !room.isConnected) return
      if (excludeSet.has(String(djId).trim().toLowerCase())) return
      sendChatToRoom(djId, cur.message)
      sentCount++
    })
    console.log(`[전체방 공지] "${cur.message}" — ${sentCount}개 방에 전송됨 (제외 ${excludeSet.size}명)`)
  }, intervalMs)
  console.log(`[전체방 공지] 타이머 시작됨 — ${Math.round(intervalMs / 60000)}분마다 전체 방송 중인 방에 전송`)
}

function startMonsterCatchTimer(djId) {
  const room = getRoom(djId)
  if (room.monsterCatchTimer) { clearInterval(room.monsterCatchTimer); room.monsterCatchTimer = null }
  if (room.monsterCatchFirstSpawnTimeout) { clearTimeout(room.monsterCatchFirstSpawnTimeout); room.monsterCatchFirstSpawnTimeout = null }
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'monstercatch', djId)) { console.log(`[몬스터잡기][${djId}] 타이머 시작 안 함 — 사이드바 모듈이 꺼져있어요`); return }
  const mc = getMonsterCatchSettings(djId, settings)
  if (!mc.monsters.length) { console.log(`[몬스터잡기][${djId}] 타이머 시작 안 함 — 등록된 몬스터가 0마리예요`); return }
  const min = Math.max(1, Math.min(180, parseInt(mc.spawnIntervalMin, 10) || 5))
  // 🐾 [업데이트] 예전엔 타이머를 시작해도 첫 등장까지 설정한 시간(예: 5분) 전체를 그대로
  // 기다려야 했다. 방송 입장하거나 모듈을 막 켰을 때 그 즉시 기본 1마리를 먼저 등장시키고,
  // 그다음부터 설정한 주기로 카운터를 시작하도록 바꾼다. (방 연결 직후 채팅 전송이 씹히지
  // 않도록 살짝 지연을 둔다)
  room.monsterCatchFirstSpawnTimeout = setTimeout(() => {
    try { spawnMonster(djId) } catch (e) { console.log(`[몬스터잡기][${djId}] 첫 스폰 중 오류:`, e && e.stack || e) }
  }, 5000)
  room.monsterCatchTimer = setInterval(() => {
    try { spawnMonster(djId) } catch (e) { console.log(`[몬스터잡기][${djId}] 스폰 중 오류:`, e && e.stack || e) }
  }, min * 60 * 1000)
  console.log(`[몬스터잡기][${djId}] 타이머 시작됨 — 5초 뒤 첫 등장, 이후 ${min}분마다 등장 (몬스터 ${mc.monsters.length}종 등록됨)`)
}

function spawnMonster(djId) {
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  console.log(`[몬스터잡기][${djId}] spawnMonster 호출됨 — moduleOn=${isModuleOn(settings, 'monstercatch', djId)}, streamName=${room.streamName || '없음'}`)
  if (!isModuleOn(settings, 'monstercatch', djId)) { console.log(`[몬스터잡기][${djId}] 스폰 취소 — 모듈이 꺼져있어요`); return }
  const mc = getMonsterCatchSettings(djId, settings)
  if (room._activeMonster) { console.log(`[몬스터잡기][${djId}] 스폰 건너뜀 — 이미 [${room._activeMonster.name}]이(가) 등장 중`); return }
  const picked = mcPickMonster(mc)
  if (!picked) { console.log(`[몬스터잡기][${djId}] 스폰 실패 — 등장 가능한(가중치>0) 몬스터가 없어요`); return }
  const sec = Math.max(5, Math.min(600, parseInt(mc.catchWindowSec, 10) || 60))
  room._activeMonster = { id: picked.id, name: picked.name, catchRate: picked.catchRate, caught: false, attempted: new Set() }
  const tpl = picked.legendary ? (mc.legendarySpawnMsg || mc.spawnMsg) : mc.spawnMsg
  const msg = mcFormat(tpl, { monster: picked.name, cmd: mc.cmdCatch || '!잡기', sec })
  if (msg) sendChatToRoom(djId, msg)
  console.log(`[몬스터잡기][${djId}] [${picked.name}] 등장${picked.legendary ? ' (전설)' : ''}`)
  room._activeMonsterTimeout = setTimeout(() => {
    const active = room._activeMonster
    if (active && !active.caught) {
      const despawn = mcFormat(mc.despawnMsg, { monster: active.name })
      if (despawn) sendChatToRoom(djId, despawn)
    }
    room._activeMonster = null
  }, sec * 1000)
}

function handleMonsterCatchCommand(djId, room, settings, author, tag, text, authorId) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const msg = String(text || '').trim()
  const key = String(tag || '').trim().toLowerCase()

  // 🗑️ !리셋 [고유닉] — DJ/매니저 전용. 고유닉 조회가 실패해서(key가 비어있어도) 관리자가
  // 다른 유저를 지정해서 리셋할 수 있어야 하므로, 아래는 key(자기 자신의 고유닉) 확인보다 먼저 처리한다.
  const cmdUserReset = mc.cmdUserReset || '!리셋'
  if (msg === cmdUserReset || msg.startsWith(cmdUserReset + ' ')) {
    const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
    const act = getActivitySettings(djId, settings)
    const isManager = !isDj && (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase())
    if (!isDj && !isManager) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgUserResetNoAuth, {})), 400); return }
    const targetRaw = msg.slice(cmdUserReset.length).trim()
    if (!targetRaw) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgUserResetUsage, { cmdUserReset })), 400); return }
    const targetKey = targetRaw.replace('@', '').trim().toLowerCase()
    const existed = mc.bags[targetKey] != null || mc.collections[targetKey] != null || mc.greatBags[targetKey] != null || mc.chatCounts[targetKey] != null
    if (!existed) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgUserResetNotFound, { target: targetRaw })), 400); return }
    delete mc.bags[targetKey]
    delete mc.greatBags[targetKey]
    delete mc.collections[targetKey]
    delete mc.chatCounts[targetKey]
    mcSaveUserData()
    setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgUserResetSuccess, { target: targetRaw })), 400)
    return
  }

  // 🎾 !볼지급 [고유닉] [수량] — DJ/매니저 전용. 대상이 !모험시작 전이어도 자동으로 등록하며 지급한다.
  const cmdBallGive = mc.cmdBallGive || '!볼지급'
  if (msg === cmdBallGive || msg.startsWith(cmdBallGive + ' ')) {
    const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
    const act = getActivitySettings(djId, settings)
    const isManager = !isDj && (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase())
    if (!isDj && !isManager) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBallGiveNoAuth, {})), 400); return }
    const parts = msg.slice(cmdBallGive.length).trim().split(/\s+/)
    const targetRaw = parts[0] || ''
    const amount = parseInt(parts[1], 10)
    if (!targetRaw || isNaN(amount) || amount === 0) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBallGiveUsage, { cmdBallGive })), 400); return }
    const targetKey = targetRaw.replace('@', '').trim().toLowerCase()
    if (mc.bags[targetKey] == null) mc.bags[targetKey] = 0 // 모험 시작 전이어도 지급 시점에 자동 등록
    mc.bags[targetKey] = Math.max(0, mc.bags[targetKey] + amount)
    mcSaveUserData()
    const action = amount > 0 ? '지급' : '차감'
    setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBallGiveSuccess, { target: targetRaw, amount: Math.abs(amount), action, balls: mc.bags[targetKey] })), 400)
    return
  }

  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵

  // 🎒 !모험시작 — 최초 1회, 기본 포획볼 지급
  if (msg === (mc.cmdStart || '!모험시작')) {
    if (mc.bags[key] != null) {
      setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgAlreadyStarted, { nickname: author, balls: mc.bags[key], greatBalls: mc.greatBags[key] || 0 })), 400)
      return
    }
    const start = Math.max(0, parseInt(mc.startBalls, 10) || 5)
    mc.bags[key] = start
    mc.greatBags[key] = 0
    mcSaveUserData()
    setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgStart, { nickname: author, balls: start, cmdCatch: mc.cmdCatch || '!잡기' })), 400)
    return
  }

  // 🎒 !포획볼 — 보유 수량 확인
  if (msg === (mc.cmdBag || '!포획볼')) {
    if (mc.bags[key] == null) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgNoAdventure, { nickname: author, cmdStart: mc.cmdStart || '!모험시작' })), 400); return }
    setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBag, { nickname: author, balls: mc.bags[key], greatBalls: mc.greatBags[key] || 0 })), 400)
    return
  }

  // 🎒 !포획볼구매 [수량] — 복권으로 구매 (기본 1개)
  const cmdBuyBall = mc.cmdBuyBall || '!포획볼구매'
  if (msg === cmdBuyBall || msg.startsWith(cmdBuyBall + ' ')) {
    if (mc.bags[key] == null) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgNoAdventure, { nickname: author, cmdStart: mc.cmdStart || '!모험시작' })), 400); return }
    const amount = Math.max(1, Math.min(999, parseInt(msg.slice(cmdBuyBall.length).trim(), 10) || 1))
    const price = Math.max(1, parseInt(mc.buyPrice, 10) || 10)
    const cost = amount * price
    const act = getActivitySettings(djId, settings)
    const actKey = findActUserKey(act, tag || author)
    const lotto = actKey ? (act.users[actKey].lotto || 0) : 0
    if (!actKey || lotto < cost) {
      setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBuyFail, { nickname: author, cost, lotto })), 400)
      return
    }
    act.users[actKey].lotto = lotto - cost
    mc.bags[key] = (mc.bags[key] || 0) + amount
    store.saveSettings(djId, { activity: act }) // 복권은 이 디제이 방 전용 재화라 그대로 djId 범위에 저장
    mcSaveUserData() // 포획볼은 전역 공용 데이터라 별도 저장
    setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBuySuccess, { nickname: author, cost, amount, balls: mc.bags[key] })), 400)
    return
  }

  // 📖 !도감, !도감1, !도감2 ... — 잡은 몬스터가 많아지면 한 메시지에 다 담다가 스푼 채팅 글자수
  // 제한에 걸려서 목록이 잘리는 문제가 있었다. 그래서 13마리씩 페이지로 잘라서 보여주고,
  // 숫자를 붙여서(예: !도감2) 원하는 페이지를 바로 조회할 수 있게 한다. (킵목록 확인N과 같은 방식)
  const cmdDex = mc.cmdDex || '!도감'
  if (msg === cmdDex) {
    const owned = mc.collections[key] || {}
    const ownedIds = Object.keys(owned)
    if (!ownedIds.length) { setTimeout(() => sendChatToRoom(djId, `📖 ${author}님의 도감은 아직 비어있어요. ${mc.cmdCatch || '!잡기'}로 몬스터를 모아보세요!`), 400); return }

    let catalog = {}
    try { catalog = store.loadGlobalMonsterDex().catalog || {} } catch (e) {}
    const allKnownIds = new Set([...mc.monsters.map(m => m.id), ...Object.keys(catalog)])
    const totalTypes = allKnownIds.size

    const normalDiscovered = ownedIds.filter(id => !mcIsShinyId(id) && !mcIsGmaxId(id)).length
    const shinyDiscovered = ownedIds.filter(id => mcIsShinyId(id)).length
    const gmaxDiscovered = ownedIds.filter(id => mcIsGmaxId(id)).length
    const points = mcGetWebData().points[key] || 0
    const ranking = mcComputeGlobalRanking(mc)
    const myRankIdx = ranking.findIndex(r => r.tag.toLowerCase() === key.toLowerCase())
    const ace = myRankIdx !== -1 ? ranking[myRankIdx].ace : mcComputeTrainerAce(owned, mc.monsters, key)

    const out = `📖 ${author}님의 도감 요약\n`
      + `-${ace ? ace.name : '(없음)'} ${ace ? ace.level : 0}Lv 공격:${ace ? ace.power : 0}\n`
      + `-일반: ${normalDiscovered}/${totalTypes}\n`
      + `-이로치 ${shinyDiscovered}/${totalTypes}\n`
      + `-거다이맥스 ${gmaxDiscovered}/${totalTypes}\n`
      + `-남은포인트:${points}\n`
      + `-순위:${myRankIdx !== -1 ? myRankIdx + 1 : '순위없음'}`
    sendChatSplit(djId, out, 150, 500)
    return
  }

  // 🏆 !랭킹 — 각 트레이너가 보유한 몬스터 중 "가장 강한 몬스터의 공격력"(대결에 실제로 쓰이는
  // 값, mcPickStrongest와 동일 기준)을 기준으로 순위를 매긴다. mc.collections는 djId별 설정
  // 안에 있지만 실제로는 전역 공유 데이터라서, 여기서 계산한 전체 랭킹은 어느 방에서든
  // 몬스터를 잡은 모든 트레이너를 다 포함한다(=현재 방 유저만이 아니라 전체 플랫폼 기준).
  // "현재 방 랭킹"은 이 방의 애청지수(활동 기록)에 등록된 사람들로만 한 번 더 좁혀서 계산한다.
  const cmdRanking = mc.cmdRanking || '!랭킹'
  if (msg === cmdRanking) {
    const globalRanking = mcComputeGlobalRanking(mc)

    const act = getActivitySettings(djId, settings)
    const roomTagSet = new Set(Object.values(act.users || {}).map(u => (u.tag || '').toLowerCase()).filter(Boolean))
    const roomRanking = globalRanking.filter(r => roomTagSet.has(r.tag.toLowerCase()))

    const nameOfTag = (t) => {
      const actEntry = Object.values(act.users || {}).find(u => (u.tag || '').toLowerCase() === t.toLowerCase())
      if (actEntry && actEntry.nickname) return actEntry.nickname
      return resolveNicknameFromInput(room, t) || t
    }
    const fmtList = (list) => list.length
      ? list.slice(0, 5).map((r, i) => `${i + 1}위 ${nameOfTag(r.tag)}\n${r.ace.name} Lv${r.ace.level} (공격력:${r.ace.power})`).join('\n')
      : '(아직 데이터가 없어요)'

    const out = `🏆 트레이너 랭킹 (가장 강한 몬스터 공격력 기준)\n\n🌍 월드 랭킹\n${fmtList(globalRanking)}\n\n🏠 우리방 랭킹\n${fmtList(roomRanking)}`
    sendChatSplit(djId, out, 150, 500)
    return
  }

  if (msg !== (mc.cmdCatch || '!잡기')) return
  const active = room._activeMonster
  if (!active) return // 등장한 몬스터가 없으면 조용히 무시

  // 🎾 포획볼이 있어야 시도할 수 있다 — 모험 시작 안 했거나 볼(일반+고급)이 하나도 없으면 안내만 하고 끝 (시도로 안 침)
  // 고급 몬스터볼은 "각자 확률판정" 모드에서만 보너스가 의미 있으니 그 모드일 때만 우선 소모하고,
  // "선착순" 모드(어차피 첫 시도자 무조건 성공)에서는 일반 볼부터 써서 고급볼을 아껴준다.
  if (mc.bags[key] == null) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgNoAdventure, { nickname: author, cmdStart: mc.cmdStart || '!모험시작' })), 300); return }
  const preferGreatBall = mc.catchMode === 'all'
  const hasGreatBall = (mc.greatBags[key] || 0) > 0
  const hasNormalBall = (mc.bags[key] || 0) > 0
  if (!hasGreatBall && !hasNormalBall) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgNoBalls, { nickname: author, cmdBuyBall: mc.cmdBuyBall || '!포획볼구매' })), 300); return }
  const useGreatBall = preferGreatBall ? hasGreatBall : (hasNormalBall ? false : hasGreatBall)
  const rateBonus = useGreatBall ? Math.max(0, Number(mc.greatBallBonus) || 0) : 0

  if (mc.catchMode === 'all') {
    if (active.attempted.has(key)) return // 같은 스폰에 중복 시도 방지
    active.attempted.add(key)
    if (useGreatBall) mc.greatBags[key] -= 1; else mc.bags[key] -= 1 // 포획볼은 성공/실패 상관없이 시도하는 순간 소모
    const rate = Math.max(0, Math.min(100, (Number(active.catchRate) || 50) + rateBonus))
    const success = Math.random() * 100 < rate
    if (success) {
      const grant = mcGrantCaughtMonster(mc, key, active.id)
      mcSaveUserData()
      const monsterLabel = grant.isGmax ? `🌟거다이맥스 ${active.name}` : (grant.isShiny ? `🌈이로치 ${active.name}` : active.name)
      setTimeout(() => sendChatToRoom(djId, mcFormat(mc.catchSuccessMsg, { nickname: author, monster: monsterLabel, count: grant.count, balls: mc.bags[key], greatBalls: mc.greatBags[key] })), 300)
      if (!grant.isShiny) mcCheckAutoEvolve(djId, mc, key, grant.grantId, author) // 이로치는 별도 개체로 취급해 진화 대상에서 제외(거다이맥스는 진화 가능)
    } else {
      mcSaveUserData()
      setTimeout(() => sendChatToRoom(djId, mcFormat(mc.catchFailMsg, { nickname: author, monster: active.name, balls: mc.bags[key], greatBalls: mc.greatBags[key] })), 300)
    }
    return
  }

  // 선착순 1명 — catchRate는 여기선 안 쓰고(각자 확률판정 모드 전용), 첫 시도자는 항상 성공한다.
  if (active.caught) return // 이미 잡혔으면 조용히 무시 (도배 방지)
  active.caught = true
  if (useGreatBall) mc.greatBags[key] -= 1; else mc.bags[key] -= 1
  if (room._activeMonsterTimeout) { clearTimeout(room._activeMonsterTimeout); room._activeMonsterTimeout = null }
  const grant = mcGrantCaughtMonster(mc, key, active.id)
  mcSaveUserData()
  const monsterLabel = grant.isGmax ? `🌟거다이맥스 ${active.name}` : (grant.isShiny ? `🌈이로치 ${active.name}` : active.name)
  setTimeout(() => sendChatToRoom(djId, mcFormat(mc.catchSuccessMsg, { nickname: author, monster: monsterLabel, count: grant.count, balls: mc.bags[key], greatBalls: mc.greatBags[key] })), 300)
  room._activeMonster = null
  if (!grant.isShiny) mcCheckAutoEvolve(djId, mc, key, grant.grantId, author) // 이로치는 별도 개체로 취급해 진화 대상에서 제외(거다이맥스는 진화 가능)
}

// 채팅 한 번 칠 때마다 소소한 확률로 포획볼 1개 획득 (모험을 시작한 유저만 대상)
// 🌟 진화 — 같은 몬스터를 정해진 마리 수만큼 모으면 다른 몬스터로 바뀐다 (수동: !진화 [이름]).
// 거다이맥스는 이름 앞에 "거다이맥스 " 또는 "🌟거다이맥스 "를 붙여서 입력하면 거다이맥스 개체 쪽 도감을 대상으로 진화한다.
function handleMonsterEvolveCommand(djId, room, settings, author, tag, text) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const cmdEvolve = mc.cmdEvolve || '!진화'
  const msg = String(text || '').trim()
  if (msg !== cmdEvolve && !msg.startsWith(cmdEvolve + ' ')) return

  const rawName = msg.slice(cmdEvolve.length).trim()
  if (!rawName) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveUsage, { cmdEvolve })), 400); return }

  let requestGmax = false
  let monsterName = rawName
  for (const p of ['🌟거다이맥스 ', '거다이맥스 ']) {
    if (monsterName.startsWith(p)) { requestGmax = true; monsterName = monsterName.slice(p.length).trim(); break }
  }

  const mon = mc.monsters.find(m => m.name === monsterName)
  if (!mon) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveNotFound, { monster: rawName })), 400); return }
  if (!mon.evolvesTo) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveNoTarget, { monster: mon.name })), 400); return }
  const target = mc.monsters.find(m => m.id === mon.evolvesTo)
  if (!target) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveNoTarget, { monster: mon.name })), 400); return }
  if (requestGmax && !mcIsGmaxEligible(mon.id)) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveNotFound, { monster: rawName })), 400); return }

  const key = String(tag || '').trim().toLowerCase()
  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵
  const need = Math.max(1, parseInt(mon.evolveCount, 10) || 10)
  const sourceId = requestGmax ? MC_GMAX_PREFIX + mon.id : mon.id
  const targetId = requestGmax ? MC_GMAX_PREFIX + target.id : target.id
  const owned = (mc.collections[key] && mc.collections[key][sourceId]) || 0
  if (owned < need) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveFail, { monster: rawName, need, owned })), 400); return }

  mc.collections[key][sourceId] -= need
  mc.collections[key][targetId] = (mc.collections[key][targetId] || 0) + 1
  mcSaveUserData()
  const label = requestGmax ? '🌟거다이맥스 ' : ''
  setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgEvolveSuccess, { nickname: author, monster: label + mon.name, need, targetMonster: label + target.name })), 400)
}

// 잡기 성공 직후에 호출 — "자동 진화"가 켜져있고 조건이 채워졌으면 조용히 즉시 진화시킨다.
// 🌈🌟 잡기 성공 시 이 함수로 도감에 넣는다 — 희귀상자랑 같은 확률로 이로치/거다이맥스가 나온다.
// 거다이맥스(MC_GMAX_CHANCE)는 MC_GMAX_ELIGIBLE_IDS에 있는 종만 대상이고, 그 외엔 이로치(MC_SHINY_CHANCE)만 굴린다.
function mcGrantCaughtMonster(mc, key, monsterId) {
  const isGmax = mcIsGmaxEligible(monsterId) && Math.random() < MC_GMAX_CHANCE
  const isShiny = !isGmax && Math.random() < MC_SHINY_CHANCE
  const grantId = isGmax ? MC_GMAX_PREFIX + monsterId : (isShiny ? MC_SHINY_PREFIX + monsterId : monsterId)
  if (!mc.collections[key]) mc.collections[key] = {}
  mc.collections[key][grantId] = (mc.collections[key][grantId] || 0) + 1
  return { grantId, isShiny, isGmax, count: mc.collections[key][grantId] }
}

// 🌿 보스 몬스터 — 이 방의 등록된 몬스터 중 "풀" 타입만 골라서 랜덤으로 하나 뽑는다.
// 포켓몬 일괄등록(POKEMON_GEN1_DATA)은 typeNames 필드가 있고, 직접 등록한 몬스터는 그게 없을
// 수 있어서 trait(설명) 텍스트에 "타입 ... 풀..."이 포함되어 있는지도 같이 확인한다.
// 🌿 보스 몬스터는 랜덤이 아니라 DJ가 지정한 고유 이름(기본값 "풀잎")을 가진 고정 보스다.

function startBossTimer(djId) {
  const room = getRoom(djId)
  if (room.bossTimer) { clearInterval(room.bossTimer); room.bossTimer = null }
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  if (!mc.bossEnabled) { console.log(`[보스몬스터][${djId}] 타이머 시작 안 함 — "보스 몬스터" 설정이 꺼져있어요`); return }
  const min = Math.max(1, Math.min(720, parseInt(mc.bossIntervalMin, 10) || 60))
  room.bossTimer = setInterval(() => {
    try { spawnBoss(djId) } catch (e) { console.log(`[보스몬스터][${djId}] 등장 중 오류:`, e && e.stack || e) }
  }, min * 60 * 1000)
  console.log(`[보스몬스터][${djId}] 타이머 시작됨 — ${min}분마다 등장`)
}

function spawnBoss(djId) {
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  if (!mc.bossEnabled) return
  if (room.currentBoss && room.currentBoss.active) return // 이미 보스전 진행 중이면 중복 등장 방지
  const bossPower = Math.max(1, Number(mc.bossPower) || 100)
  const monster = { name: mc.bossMonsterName || '풀잎' } // 랜덤이 아니라 DJ가 지정한 고정 보스 이름
  const windowSec = Math.max(10, Math.min(1800, parseInt(mc.bossJoinWindowSec, 10) || 90))
  room.currentBoss = { active: true, monster, power: bossPower, participants: {}, spawnedAt: Date.now() }
  sendChatToRoom(djId, mcFormat(mc.msgBossSpawn, { monster: monster.name, cmdBossJoin: mc.cmdBossJoin, sec: windowSec, bossPower }))
  room.bossResolveTimeout = setTimeout(() => {
    try { resolveBoss(djId) } catch (e) { console.log(`[보스몬스터][${djId}] 결과 처리 중 오류:`, e && e.stack || e) }
  }, windowSec * 1000)
}

function handleBossJoinCommand(djId, room, settings, author, tag, text) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const msg = String(text || '').trim()
  if (msg !== (mc.cmdBossJoin || '!참여')) return
  if (!room.currentBoss || !room.currentBoss.active) { setTimeout(() => sendChatToRoom(djId, mc.msgBossNoActive), 300); return }
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return
  if (room.currentBoss.participants[key]) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBossAlreadyJoined, { nickname: author })), 300); return }
  const myMon = mcPickStrongest(mc.collections[key], mc.monsters, key)
  if (!myMon) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBossNoMonsters, { nickname: author })), 300); return }
  const power = Number(myMon.power) || 10
  room.currentBoss.participants[key] = { nickname: author, power }
  setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBossJoin, { nickname: author, power })), 300)
}

function resolveBoss(djId) {
  const room = getRoom(djId)
  if (!room.currentBoss || !room.currentBoss.active) return
  const settings = store.getSettings(djId) || {}
  const mc = getMonsterCatchSettings(djId, settings)
  const boss = room.currentBoss
  room.currentBoss = null
  if (room.bossResolveTimeout) { clearTimeout(room.bossResolveTimeout); room.bossResolveTimeout = null }

  const participants = Object.values(boss.participants || {})
  if (!participants.length) {
    sendChatToRoom(djId, mcFormat(mc.msgBossNoParticipants, { monster: boss.monster.name }))
    return
  }
  // 🌿 보스 체력(공격력)을 참여자들의 총 공격력이 넘어야 처치 성공. 못 넘으면 보상 없이 실패 처리.
  const totalPower = participants.reduce((s, p) => s + p.power, 0)
  const bossPower = Math.max(1, Number(boss.power) || 100)
  if (totalPower < bossPower) {
    sendChatToRoom(djId, mcFormat(mc.msgBossFail, { monster: boss.monster.name, count: participants.length, totalPower, bossPower }))
    return
  }

  // 🎲 격파 성공 — 누가 보상을 가져갈지는 대미지(공격력) 순이 아니라, 참여자들이 채팅으로
  // 주사위를 굴려서 가장 높은 눈이 나온 사람이 가져간다. 여기서 바로 보상을 지급하지 않고,
  // 주사위를 굴릴 수 있는 시간(cmdBossRoll 창)을 연 뒤 resolveBossLoot()에서 최종 지급한다.
  const rollWindowSec = Math.max(5, Math.min(600, parseInt(mc.bossRollWindowSec, 10) || 30))
  room.bossLootRoll = {
    boss, participants: boss.participants, rolls: {}, totalPower, resolvedAt: Date.now() + rollWindowSec * 1000,
  }
  sendChatToRoom(djId, mcFormat(mc.msgBossRollPrompt, { monster: boss.monster.name, cmd: mc.cmdBossRoll || '!주사위', cmdBossRoll: mc.cmdBossRoll || '!주사위', sec: rollWindowSec }))
  room.bossLootRollTimeout = setTimeout(() => {
    try { resolveBossLoot(djId) } catch (e) { console.log(`[보스몬스터][${djId}] 주사위 결과 처리 중 오류:`, e && e.stack || e) }
  }, rollWindowSec * 1000)
}

// 🎲 보스전 참여자만 굴릴 수 있는 전용 주사위 — 사이드바의 "주사위" 모듈(!주사위, 아무나 사용 가능)과는
// 별개다. 이 명령어는 room.bossLootRoll이 열려있을 때만 반응하고, 보스전에 참여했던 사람만, 한 번만
// 굴릴 수 있다.
function handleBossRollCommand(djId, room, settings, author, tag, text) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const msg = String(text || '').trim()
  if (msg !== (mc.cmdBossRoll || '!주사위')) return
  const loot = room.bossLootRoll
  if (!loot) return // 지금 열려있는 주사위 판이 없으면 조용히 무시 (일반 채팅과 섞이지 않게)
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return
  if (!loot.participants[key]) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBossRollNotParticipant, { nickname: author })), 300); return }
  if (loot.rolls[key] != null) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBossRollAlready, { nickname: author, roll: loot.rolls[key].roll })), 300); return }
  const roll = Math.floor(Math.random() * 100) + 1 // 1~100 — 더 촘촘해서 동점이 잘 안 남
  loot.rolls[key] = { nickname: author, roll }
  setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBossRollResult, { nickname: author, roll })), 300)
}

function resolveBossLoot(djId) {
  const room = getRoom(djId)
  const loot = room.bossLootRoll
  if (!loot) return
  room.bossLootRoll = null
  if (room.bossLootRollTimeout) { clearTimeout(room.bossLootRollTimeout); room.bossLootRollTimeout = null }
  const settings = store.getSettings(djId) || {}
  const mc = getMonsterCatchSettings(djId, settings)
  const boss = loot.boss
  const participants = Object.values(loot.participants || {})

  const rollKeys = Object.keys(loot.rolls)
  if (!rollKeys.length) {
    sendChatToRoom(djId, mcFormat(mc.msgBossRollNoOne, { monster: boss.monster.name }))
    return
  }
  // 🎲 가장 높은 눈이 나온 사람 — 동점이면(1~100이라 흔치 않지만) 그중 랜덤으로 한 명.
  let bestRoll = -1
  let winners = []
  rollKeys.forEach(k => {
    const r = loot.rolls[k].roll
    if (r > bestRoll) { bestRoll = r; winners = [k] }
    else if (r === bestRoll) { winners.push(k) }
  })
  const winnerKey = winners[Math.floor(Math.random() * winners.length)]
  const winnerNickname = loot.rolls[winnerKey].nickname

  let rewardName = '(보상 없음)'
  if (boss.isWorldBoss) {
    // 🏆 월드보스는 관리자가 설정해둔 보상 목록(복권/이로치몬스터/포획볼/고급볼 등)을 그대로 지급한다.
    rewardName = grantWorldBossRewards(djId, settings, mc, winnerKey, winnerNickname)
    mcSaveUserData()
  } else {
    // 🌈 (기존 방식) 일반 보스는 주사위 우승자에게 랜덤 이로치 몬스터 1마리를 준다.
    const picked = mcPickMonster(mc)
    if (picked) {
      const grantId = MC_SHINY_PREFIX + picked.id
      if (!mc.collections[winnerKey]) mc.collections[winnerKey] = {}
      mc.collections[winnerKey][grantId] = (mc.collections[winnerKey][grantId] || 0) + 1
      rewardName = picked.name
      mcSaveUserData()
    }
  }

  sendChatToRoom(djId, mcFormat(mc.msgBossResult, {
    monster: boss.monster.name,
    count: participants.length,
    totalPower: loot.totalPower,
    mvpNickname: winnerNickname,
    mvpPower: bestRoll,
    reward: rewardName,
  }))
}


// ══════════════════════════════════════════════════════
// 🌍 월드보스 — 관리자(sum) 계정에서 딱 한 번만 설정해두면, 지금 방송 연결되어있고
// 몬스터잡기가 켜져있는 "모든 방"에 정해진 간격마다 동시에 같은 보스가 등장한다. 각 방의
// 참여/처치 로직은 기존 보스 시스템(room.currentBoss, resolveBoss)을 그대로 재사용하고,
// 참여 명령어도 그 방 DJ가 이미 설정해둔 것(mc.cmdBossJoin)을 그대로 쓴다 — 시청자 입장에서는
// "이번엔 좀 더 강한 보스가 나왔다" 정도로만 느껴지고 새로 배울 명령어가 없다.
function getWorldBossSettings() {
  const settings = store.getSettings(SHARED_TOKEN_DJID) || {}
  if (!settings.worldBoss) {
    settings.worldBoss = {
      enabled: false,
      monsterName: '월드보스',
      power: 500,
      intervalMin: 60,
      joinWindowSec: 90,
      spawnMsg: '🌍 월드보스 [{monster}]이(가) 나타났습니다! (공격력 {bossPower}) {cmdBossJoin}로 함께 싸워보세요! ({sec}초 안에 참여 마감)',
      // 🏆 처치 성공 시 MVP(1등, 총 공격력 가장 많이 기여한 사람)에게만 자동 지급되는 보상 목록.
      // type: 'lotto'(복권) | 'shinyMonster'(이로치 몬스터, monsterId 비우면 랜덤) | 'gmaxMonster'(거다이맥스 몬스터, monsterId 비우면 화이트리스트 내 랜덤) | 'ball'(포획볼) | 'greatBall'(고급볼)
      rewards: [],
    }
    store.saveSettings(SHARED_TOKEN_DJID, { worldBoss: settings.worldBoss })
  }
  if (!Array.isArray(settings.worldBoss.rewards)) settings.worldBoss.rewards = []
  return settings.worldBoss
}
// 🏆 월드보스 처치 시 MVP(1등)에게만 설정해둔 보상을 그대로 지급한다. 지급은 그 보스가 등장한
// "그 방"의 경제(포획볼/고급볼/복권/도감)에 반영된다 — 월드보스가 여러 방에서 동시에 등장해도
// 각 방은 독립적으로 처리되므로 자연스럽게 방마다 따로 지급된다.
function grantWorldBossRewards(djId, settings, mc, mvpKey, mvpNickname) {
  const wb = getWorldBossSettings()
  const rewards = wb.rewards || []
  if (!rewards.length) return '(보상 없음)'
  const parts = []
  let actChanged = false
  let act = null
  for (const r of rewards) {
    if (r.type === 'lotto') {
      const amount = Math.max(1, Number(r.amount) || 1)
      if (!act) act = getActivitySettings(djId, settings)
      const key = findActUserKey(act, mvpKey) || mvpKey
      actEnsureUser(act, key, mvpNickname, mvpKey)
      act.users[key].lotto = (act.users[key].lotto || 0) + amount
      parts.push(`🎟️복권 ${amount}장`)
      actChanged = true
    } else if (r.type === 'shinyMonster') {
      const picked = r.monsterId ? mc.monsters.find(m => String(m.id) === String(r.monsterId)) : mcPickMonster(mc)
      if (picked) {
        const grantId = MC_SHINY_PREFIX + picked.id
        if (!mc.collections[mvpKey]) mc.collections[mvpKey] = {}
        mc.collections[mvpKey][grantId] = (mc.collections[mvpKey][grantId] || 0) + 1
        parts.push(`🌈이로치 ${picked.name}`)
      }
    } else if (r.type === 'gmaxMonster') {
      const picked = r.monsterId
        ? (mcIsGmaxEligible(String(r.monsterId)) ? mc.monsters.find(m => String(m.id) === String(r.monsterId)) : null)
        : mcPickGmaxMonster(mc)
      if (picked) {
        const grantId = MC_GMAX_PREFIX + picked.id
        if (!mc.collections[mvpKey]) mc.collections[mvpKey] = {}
        mc.collections[mvpKey][grantId] = (mc.collections[mvpKey][grantId] || 0) + 1
        parts.push(`🌟거다이맥스 ${picked.name}`)
      }
    } else if (r.type === 'ball') {
      const amount = Math.max(1, Number(r.amount) || 1)
      mc.bags[mvpKey] = (mc.bags[mvpKey] || 0) + amount
      parts.push(`🎒포획볼 ${amount}개`)
    } else if (r.type === 'greatBall') {
      const amount = Math.max(1, Number(r.amount) || 1)
      mc.greatBags[mvpKey] = (mc.greatBags[mvpKey] || 0) + amount
      parts.push(`⚡고급볼 ${amount}개`)
    } else if (r.type === 'point') {
      // 🐾 웹 도감(레벨업에 쓰는) 포인트를 직접 적립해준다.
      const amount = Math.max(1, Number(r.amount) || 1)
      const wd = mcGetWebData()
      wd.points[mvpKey] = (wd.points[mvpKey] || 0) + amount
      mcSaveWebData()
      parts.push(`✨포인트 ${amount}P`)
    }
  }
  if (actChanged) store.saveSettings(djId, { activity: act })
  return parts.length ? parts.join(', ') : '(보상 없음)'
}
function spawnWorldBoss(djId, wb) {
  const room = getRoom(djId)
  const settings = store.getSettings(djId) || {}
  if (!isModuleOn(settings, 'monstercatch', djId)) return false
  const mc = getMonsterCatchSettings(djId, settings)
  if (room.currentBoss && room.currentBoss.active) return false // 이미 그 방에 보스전이 진행 중이면 건너뜀
  const bossPower = Math.max(1, Number(wb.power) || 500)
  const monster = { name: wb.monsterName || '월드보스' }
  const windowSec = Math.max(10, Math.min(1800, parseInt(wb.joinWindowSec, 10) || 90))
  room.currentBoss = { active: true, monster, power: bossPower, participants: {}, spawnedAt: Date.now(), isWorldBoss: true }
  sendChatToRoom(djId, mcFormat(wb.spawnMsg, { monster: monster.name, cmdBossJoin: mc.cmdBossJoin, sec: windowSec, bossPower }))
  room.bossResolveTimeout = setTimeout(() => {
    try { resolveBoss(djId) } catch (e) { console.log(`[월드보스][${djId}] 결과 처리 중 오류:`, e && e.stack || e) }
  }, windowSec * 1000)
  return true
}
function spawnWorldBossEverywhere() {
  const wb = getWorldBossSettings()
  if (!wb.enabled) return 0
  let count = 0
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (!room.isConnected) continue
    const settings = store.getSettings(djId) || {}
    if (!isModuleOn(settings, 'monstercatch', djId)) continue
    if (spawnWorldBoss(djId, wb)) count++
  }
  console.log(`[월드보스] 동시 등장 처리 완료 — ${count}개 방`)
  return count
}
let worldBossTimer = null
function startWorldBossTimer() {
  if (worldBossTimer) { clearInterval(worldBossTimer); worldBossTimer = null }
  const wb = getWorldBossSettings()
  if (!wb.enabled) { console.log('[월드보스] 타이머 시작 안 함 — 비활성화 상태'); return }
  const min = Math.max(1, Math.min(720, parseInt(wb.intervalMin, 10) || 60))
  worldBossTimer = setInterval(() => {
    try { spawnWorldBossEverywhere() } catch (e) { console.log('[월드보스] 등장 처리 중 오류:', e && e.stack || e) }
  }, min * 60 * 1000)
  console.log(`[월드보스] 타이머 시작됨 — ${min}분마다 전체 방 동시 등장`)
}
app.get('/worldboss-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  res.json({ success: true, data: getWorldBossSettings() })
})
app.get('/worldboss-admin/monster-catalog', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const catalog = mcAdminCatalog()
  res.json({ success: true, monsters: catalog.map(m => ({ id: m.id, name: m.name, isGmaxEligible: mcIsGmaxEligible(m.id) })) })
})

// 🌟 관리자(sum) 전용 — 거다이맥스 가능 몬스터 목록을 admin 페이지에서 직접 설정한다.
// 이 목록은 몬스터잡기(잡기/상자열기 거다이맥스 확률)와 월드보스 처치 보상(gmaxMonster) 둘 다에
// 그대로 반영된다(mcIsGmaxEligible이 여기 저장된 값을 기준으로 판정하므로 별도 동기화가 필요없다).
app.get('/gmax-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const catalog = mcAdminCatalog()
  const cfg = getGmaxConfig()
  res.json({ success: true, eligibleIds: cfg.eligibleIds, monsters: catalog.map(m => ({ id: m.id, name: m.name })) })
})
app.post('/gmax-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const cfg = getGmaxConfig()
  const { eligibleIds } = req.body || {}
  if (Array.isArray(eligibleIds)) {
    const catalog = mcAdminCatalog()
    const validIds = new Set(catalog.map(m => m.id))
    cfg.eligibleIds = eligibleIds.map(id => String(id || '').trim()).filter(id => validIds.has(id)).slice(0, 300)
  }
  store.saveSettings(SHARED_TOKEN_DJID, { gmaxConfig: cfg })
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════
// 🌍 관리자(sum) 전용 — 전체 몬스터 도감 통합 관리. 켜두면 모든 디제이 방이 개인 목록 대신
// 이 목록을 동일하게 쓴다 (getMonsterCatchSettings 안에서 자동으로 덮어친다).
app.get('/globalmonstercatalog-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  res.json({ success: true, data: getGlobalMonsterCatalog() })
})
app.post('/globalmonstercatalog-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const gmc = getGlobalMonsterCatalog()
  const { enabled, monsters } = req.body || {}
  if (enabled != null) gmc.enabled = !!enabled
  if (Array.isArray(monsters)) {
    gmc.monsters = monsters.map((m, i) => ({
      id: m.id && !String(m.id).startsWith('new') ? m.id : ('gmon' + Date.now() + Math.floor(Math.random() * 1000) + i),
      name: String(m.name || '').trim().slice(0, 40),
      image: String(m.image || ''),
      weight: Math.max(1, Math.min(1000, parseInt(m.weight, 10) || 10)),
      catchRate: Math.max(1, Math.min(100, parseInt(m.catchRate, 10) || 50)),
      power: Math.max(1, Math.min(9999, parseInt(m.power, 10) || 10)),
      trait: String(m.trait || '').trim().slice(0, 60),
      types: Array.isArray(m.types) ? m.types.filter(t => MC_TYPE_NAMES.includes(t)).slice(0, 2) : [],
      moves: Array.isArray(m.moves)
        ? m.moves.map(x => String(x || '').trim().slice(0, 30)).filter(Boolean).slice(0, 6)
        : String(m.moves || '').split(',').map(x => x.trim().slice(0, 30)).filter(Boolean).slice(0, 6),
      evolvesTo: String(m.evolvesTo || '').trim(),
      evolveCount: Math.max(1, Math.min(999, parseInt(m.evolveCount, 10) || 10)),
      legendary: !!m.legendary,
    })).filter(m => m.name)
    try { store.upsertMonsterCatalog(gmc.monsters) } catch (e) {} // 이름 조회용 전역 카탈로그에도 반영
  }
  store.saveSettings(SHARED_TOKEN_DJID, { globalMonsterCatalog: gmc })
  res.json({ success: true, data: gmc })
})
// 🌍 관리자(sum) 전용 — 던전/보스 통합 관리. 켜두면 모든 디제이 방이 개인 설정 대신 이 값을 동일하게
// 쓴다 (getMonsterCatchSettings 안에서 자동으로 덮어친다). 멘트 문구는 대상이 아니라 디제이별로
// 계속 따로 커스텀 가능 — 여기선 던전 목록/파티 규칙/보스 스탯/주사위 설정 같은 "숫자·목록" 값만 다룬다.
app.get('/globaldungeonboss-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  res.json({ success: true, data: getGlobalDungeonBossConfig(), catalog: mcCatalog(SHARED_TOKEN_DJID).map(m => ({ id: m.id, name: m.name, image: m.image, power: m.power })) })
})
app.post('/globaldungeonboss-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const gdb = getGlobalDungeonBossConfig()
  const {
    enabled, dungeons, dungeonMinParty, dungeonMaxParty, dungeonMonstersPerMember, dungeonCooldownSec,
    bossEnabled, bossMonsterName, bossPower, bossIntervalMin, bossJoinWindowSec, cmdBossJoin,
    cmdBossRoll, bossRollWindowSec,
  } = req.body || {}
  if (enabled != null) gdb.enabled = !!enabled
  if (Array.isArray(dungeons)) {
    gdb.dungeons = dungeons.map((d, i) => ({
      id: d.id && !String(d.id).startsWith('new') ? d.id : ('gdg' + Date.now() + Math.floor(Math.random() * 1000) + i),
      name: String(d.name || '').trim().slice(0, 40) || `던전 ${i + 1}`,
      floors: Array.isArray(d.floors) ? d.floors.map(f => ({ monsterId: String(f.monsterId || '') })).filter(f => f.monsterId) : [],
      rewardPoints: Math.max(0, Math.min(999999, parseInt(d.rewardPoints, 10) || 0)),
    }))
  }
  if (dungeonMinParty != null || dungeonMaxParty != null) {
    let minP = Math.max(1, Math.min(8, parseInt(dungeonMinParty, 10) || 2))
    let maxP = Math.max(1, Math.min(8, parseInt(dungeonMaxParty, 10) || 4))
    if (minP > maxP) maxP = minP
    gdb.dungeonMinParty = minP
    gdb.dungeonMaxParty = maxP
  }
  if (dungeonMonstersPerMember != null) gdb.dungeonMonstersPerMember = Math.max(1, Math.min(6, parseInt(dungeonMonstersPerMember, 10) || 3))
  if (dungeonCooldownSec != null) gdb.dungeonCooldownSec = Math.max(0, Math.min(3600, parseInt(dungeonCooldownSec, 10) || 0))
  if (bossEnabled != null) gdb.bossEnabled = !!bossEnabled
  if (bossMonsterName != null) gdb.bossMonsterName = String(bossMonsterName).trim() || '풀잎'
  if (bossPower != null) gdb.bossPower = Math.max(1, Math.min(1000000, parseInt(bossPower, 10) || 100))
  if (bossIntervalMin != null) gdb.bossIntervalMin = Math.max(1, Math.min(720, parseInt(bossIntervalMin, 10) || 60))
  if (bossJoinWindowSec != null) gdb.bossJoinWindowSec = Math.max(10, Math.min(1800, parseInt(bossJoinWindowSec, 10) || 90))
  if (cmdBossJoin != null) gdb.cmdBossJoin = String(cmdBossJoin).trim() || '!참여'
  if (cmdBossRoll != null) gdb.cmdBossRoll = String(cmdBossRoll).trim() || '!주사위'
  if (bossRollWindowSec != null) gdb.bossRollWindowSec = Math.max(5, Math.min(600, parseInt(bossRollWindowSec, 10) || 30))
  store.saveSettings(SHARED_TOKEN_DJID, { globalDungeonBossConfig: gdb })
  // ⏱ 활성화 상태에 따라 각 방의 타이머 주기가 바뀌었을 수 있으니, 지금 접속 중인 모든 방의
  // 보스 타이머를 재시작해서 곧바로 새 설정이 반영되게 한다.
  try { store.listDjIds().forEach(id => startBossTimer(id)) } catch (e) {}
  res.json({ success: true, data: gdb })
})
app.post('/worldboss-admin/settings', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const wb = getWorldBossSettings()
  const { enabled, monsterName, power, intervalMin, joinWindowSec, spawnMsg, rewards } = req.body || {}
  if (enabled != null) wb.enabled = !!enabled
  if (monsterName != null) wb.monsterName = String(monsterName).trim() || '월드보스'
  if (power != null) wb.power = Math.max(1, Math.min(1000000, parseInt(power, 10) || 500))
  if (intervalMin != null) wb.intervalMin = Math.max(1, Math.min(720, parseInt(intervalMin, 10) || 60))
  if (joinWindowSec != null) wb.joinWindowSec = Math.max(10, Math.min(1800, parseInt(joinWindowSec, 10) || 90))
  if (spawnMsg != null) wb.spawnMsg = spawnMsg
  if (Array.isArray(rewards)) {
    wb.rewards = rewards
      .filter(r => r && ['lotto', 'shinyMonster', 'gmaxMonster', 'ball', 'greatBall', 'point'].includes(r.type))
      .map(r => ({
        type: r.type,
        amount: (r.type === 'shinyMonster' || r.type === 'gmaxMonster') ? null : Math.max(1, Math.min(9999, parseInt(r.amount, 10) || 1)),
        monsterId: (r.type === 'shinyMonster' || r.type === 'gmaxMonster') ? String(r.monsterId || '').trim() : undefined,
      }))
      .slice(0, 20)
  }
  store.saveSettings(SHARED_TOKEN_DJID, { worldBoss: wb })
  startWorldBossTimer() // 활성화/간격이 바뀌었을 수 있으니 타이머 재시작
  res.json({ success: true, data: wb })
})
app.post('/worldboss-admin/spawn-now', auth.requireAuth, (req, res) => {
  if (req.djId !== SHARED_TOKEN_DJID) return res.status(403).json({ success: false, error: '권한이 없어요' })
  const count = spawnWorldBossEverywhere()
  res.json({ success: true, count })
})

function mcCheckAutoEvolve(djId, mc, key, grantId, author) {
  if (!mc.autoEvolve) return
  const gmax = mcIsGmaxId(grantId)
  const baseId = mcBaseIdFromGmax(grantId)
  const mon = mc.monsters.find(m => m.id === baseId)
  if (!mon || !mon.evolvesTo) return
  const target = mc.monsters.find(m => m.id === mon.evolvesTo)
  if (!target) return
  const need = Math.max(1, parseInt(mon.evolveCount, 10) || 10)
  const sourceId = gmax ? MC_GMAX_PREFIX + mon.id : mon.id
  const targetId = gmax ? MC_GMAX_PREFIX + target.id : target.id
  const owned = (mc.collections[key] && mc.collections[key][sourceId]) || 0
  if (owned < need) return
  mc.collections[key][sourceId] -= need
  mc.collections[key][targetId] = (mc.collections[key][targetId] || 0) + 1
  mcSaveUserData()
  const label = gmax ? '🌟거다이맥스 ' : ''
  setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgAutoEvolve, { nickname: author, monster: label + mon.name, targetMonster: label + target.name })), 500)
}

function handleMonsterCatchChatBallHook(djId, settings, author, tag) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵
  if (mc.bags[key] == null) return // 모험 시작 안 한 사람은 대상 아님
  const chance = Math.max(0, Math.min(100, Number(mc.chatBallChance) || 0))
  console.log(`[몬스터잡기][${djId}] 채팅확률 체크 — author=${author} chatBallChance(저장값)=${mc.chatBallChance} 계산된chance=${chance}`)
  if (chance <= 0 || Math.random() * 100 >= chance) return
  mc.bags[key] += 1
  mcSaveUserData()
  sendChatToRoom(djId, mcFormat(mc.msgChatBall, { nickname: author, balls: mc.bags[key] }))
}

// 💬 채팅 N번마다 (확률과 무관하게) 포획볼 M개를 확정 지급. chatBallChance(확률)와는 별개로 동시에 동작한다.
function handleMonsterCatchChatCountHook(djId, settings, author, tag) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵
  if (mc.bags[key] == null) return // 모험 시작 안 한 사람은 대상 아님
  const threshold = Math.max(1, parseInt(mc.chatCountThreshold, 10) || 5)
  const reward = Math.max(1, parseInt(mc.chatCountReward, 10) || 1)
  mc.chatCounts[key] = (mc.chatCounts[key] || 0) + 1
  if (mc.chatCounts[key] < threshold) { mcSaveUserData(); return }
  mc.chatCounts[key] = 0 // 다음 N번을 위해 리셋
  mc.bags[key] += reward
  mcSaveUserData()
  sendChatToRoom(djId, mcFormat(mc.msgChatCountBall, { nickname: author, count: threshold, reward, balls: mc.bags[key] }))
}

// 선물(스푼) 보낼 때마다 소소한 확률로 포획볼 획득 (모험을 시작한 유저만 대상)
function handleMonsterCatchGiftBallHook(djId, settings, author, tag) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵
  if (mc.bags[key] == null) return
  const chance = Math.max(0, Math.min(100, Number(mc.giftBallChance) || 0))
  if (chance <= 0 || Math.random() * 100 >= chance) return
  const amount = Math.max(1, parseInt(mc.giftBallCount, 10) || 1)
  mc.bags[key] += amount
  mcSaveUserData()
  sendChatToRoom(djId, mcFormat(mc.msgGiftBall, { nickname: author, amount, balls: mc.bags[key] }))
}

// 🏪 상점 — 아이템마다 지정한 스티커를 선물하거나 지정 스푼을 후원하면, 그 판정 방식(정확히 일치하는
// 즉시 지급/콤보만큼/개수당 배분)에 따라 자동으로 아이템을 지급한다. 랜덤박스와 같은 트리거 매칭
// 함수(checkStickerTrigger/calcAutoGrantCount)를 그대로 재사용한다. 모험을 시작한 유저만 대상이다.
function handleMonsterCatchShopTrigger(djId, settings, author, tag, amount, comboCount, sticker = '') {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵
  if (mc.bags[key] == null) return // 모험 시작 안 한 사람은 상점 이용 대상 아님
  const items = (mc.shop && Array.isArray(mc.shop.items)) ? mc.shop.items : []
  if (!items.length) return

  for (const item of items) {
    const triggerCount = item.triggerMode === 'sticker'
      ? checkStickerTrigger(item.triggerSticker, sticker, comboCount, item.payout, item.thresholdCount)
      : calcAutoGrantCount(item.payout === 'exact' ? 'exact' : (item.payout === 'distribute' ? 'distribute' : 'combo'), item.triggerAmount, amount, comboCount)
    if (triggerCount <= 0) continue
    const grantCount = Math.max(1, parseInt(item.grantCount, 10) || 1)
    const totalGrant = triggerCount * grantCount

    if (item.kind === 'greatball') {
      mc.greatBags[key] = (mc.greatBags[key] || 0) + totalGrant
      mcSaveUserData()
      sendChatToRoom(djId, mcFormat(mc.shop.msgBuyGreatBall, { nickname: author, amount: totalGrant, balls: mc.bags[key], greatBalls: mc.greatBags[key] }))
    } else if (item.kind === 'box') {
      if (!mc.collections[key]) mc.collections[key] = {}
      for (let i = 0; i < totalGrant; i++) {
        const picked = mcPickMonster(mc)
        if (!picked) continue
        // ✨🌟 희귀상자에서만 일정 확률로 "이로치"/"거다이맥스"(색다른 개체) 몬스터가 나온다. 거다이맥스는
        // MC_GMAX_ELIGIBLE_IDS에 있는 종만 대상이고, 더 희귀하며 공격력 보너스도 더 크다. 도감에는 각각
        // 별도 항목(🌈이로치/🌟거다이맥스 OOO)으로 쌓인다.
        const isGmax = mcIsGmaxEligible(picked.id) && Math.random() < MC_GMAX_CHANCE
        const isShiny = !isGmax && Math.random() < MC_SHINY_CHANCE
        const grantId = isGmax ? MC_GMAX_PREFIX + picked.id : (isShiny ? MC_SHINY_PREFIX + picked.id : picked.id)
        const displayName = isGmax ? `🌟거다이맥스 ${picked.name}` : (isShiny ? `🌈이로치 ${picked.name}` : picked.name)
        mc.collections[key][grantId] = (mc.collections[key][grantId] || 0) + 1
        sendChatToRoom(djId, mcFormat(mc.shop.msgBuyBox, { nickname: author, monster: displayName }))
        if (!isShiny) mcCheckAutoEvolve(djId, mc, key, grantId, author) // 이로치는 별도 개체로 취급해 진화 대상에서 제외(거다이맥스는 진화 가능)
      }
      mcSaveUserData()
    } else {
      mc.bags[key] = (mc.bags[key] || 0) + totalGrant
      mcSaveUserData()
      sendChatToRoom(djId, mcFormat(mc.shop.msgBuyBall, { nickname: author, amount: totalGrant, balls: mc.bags[key], greatBalls: mc.greatBags[key] || 0 }))
    }
  }
}

// 🏪 !상점 — 등록된 아이템과 구매 방법(스티커/스푼)을 안내한다.
function handleMonsterCatchShopCommand(djId, settings, author, text) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const cmdShop = (mc.shop && mc.shop.cmdShop) || '!상점'
  if (String(text || '').trim() !== cmdShop) return
  const items = (mc.shop && Array.isArray(mc.shop.items)) ? mc.shop.items : []
  if (!items.length) { setTimeout(() => sendChatToRoom(djId, '🏪 상점에 등록된 아이템이 없어요.'), 400); return }
  const kindLabel = { ball: '몬스터볼', greatball: '고급몬스터볼', box: '희귀상자' }
  const lines = items.map((item, i) => {
    const how = item.triggerMode === 'sticker'
      ? `스티커 [${item.triggerSticker || '(미설정)'}] 선물`
      : `${item.triggerAmount || 0}스푼 후원`
    return `${i + 1}. ${item.name || kindLabel[item.kind] || '아이템'} — ${how}`
  }).join('\n')
  const text2 = String(mc.shop.msgShopList || '🏪 상점 목록\n{목록}').replace(/{목록}/g, lines)
  setTimeout(() => sendChatToRoom(djId, text2), 400)
}

// 🐾 !몬스터도움말 / !몬스터명령어 — 이 방에서 실제로 쓰이는(디제이가 커스텀했으면 그 값 그대로)
// 몬스터 잡기 관련 명령어를 전부 정리해서 안내한다. 다른 모듈의 *도움말 패턴과 동일한 방식.
function handleMonsterCatchHelpCommand(djId, settings, text) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const msg = String(text || '').trim()
  if (msg !== '!몬스터도움말' && msg !== '!몬스터명령어') return
  const mc = getMonsterCatchSettings(djId, settings)
  const cmdCatch = mc.cmdCatch || '!잡기'
  const cmdDex = mc.cmdDex || '!도감'
  const cmdStart = mc.cmdStart || '!모험시작'
  const cmdBag = mc.cmdBag || '!포획볼'
  const cmdBuyBall = mc.cmdBuyBall || '!포획볼구매'
  const cmdBattle = mc.cmdBattle || '!대결'
  const cmdEvolve = mc.cmdEvolve || '!진화'
  const cmdShop = (mc.shop && mc.shop.cmdShop) || '!상점'
  const modeLabel = mc.catchMode === 'all' ? '각자 확률판정 (콤보로 여러 명 동시 시도 가능)' : '선착순 1명 (첫 시도자 무조건 성공)'
  const spawnMin = mc.spawnIntervalMin || 5
  const catchSec = mc.catchWindowSec || 60

  const lines = [
    '🐾 몬스터 잡기 명령어',
    '',
    `📢 채팅에 랜덤 몬스터가 ${spawnMin}분마다 등장해요 (${catchSec}초 안에 ${cmdCatch}로 잡아야 해요) · 현재 방식: ${modeLabel}`,
    '',
    `${cmdStart} — 처음 한 번, 모험 시작 + 기본 포획볼 지급 (이거 먼저 해야 아래 명령어들 사용 가능)`,
    `${cmdCatch} — 지금 등장한 몬스터 잡기 시도 (포획볼 1개 소모, 고급몬스터볼 있으면 그거 먼저 사용)`,
    `${cmdBag} — 내 포획볼/고급몬스터볼 보유 개수 확인`,
    `${cmdBuyBall} [수량] — 복권으로 포획볼 구매 (예: ${cmdBuyBall} 3)`,
    `${cmdDex} — 내가 잡은 몬스터 도감 확인 (13마리 넘으면 ${cmdDex}2, ${cmdDex}3...으로 다음 페이지)`,
    `${cmdEvolve} [몬스터이름] — 같은 몬스터를 정해진 마리 수만큼 모아서 진화${mc.autoEvolve ? ' (자동진화 켜져있어서 조건 채우면 자동으로도 진화돼요)' : ''}`,
    `${cmdBattle} [상대 고유닉] — 서로 가장 강한 몬스터로 대결`,
    `${cmdShop} — 상점 목록 확인 (지정 스티커 선물하거나 지정 스푼 후원하면 포획볼/고급몬스터볼/희귀상자 자동 지급)`,
    '',
    '💡 채팅을 치거나 선물을 보내면 확률적으로/일정 횟수마다 포획볼을 추가로 얻을 수도 있어요.',
  ]
  sendChatSplit(djId, lines.join('\n'), 150, 600)
}

// ⚔️ !대결 [고유닉] — 각자 보유 몬스터 중 가장 강한 걸(공격력 기준)로 자동 대결. 승률은 두
// 공격력의 비율로 계산해서, 약한 쪽도 이길 가능성은 있지만 강한 쪽이 유리하게 설계했다.
function handleMonsterBattleCommand(djId, room, settings, author, tag, text) {
  if (!isModuleOn(settings, 'monstercatch', djId)) return
  const mc = getMonsterCatchSettings(djId, settings)
  const cmdBattle = mc.cmdBattle || '!대결'
  const msg = String(text || '').trim()
  if (msg !== cmdBattle && !msg.startsWith(cmdBattle + ' ')) return

  const targetNick = msg.slice(cmdBattle.length).trim()
  if (!targetNick) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBattleUsage, { cmdBattle })), 400); return }

  const key = String(tag || '').trim().toLowerCase()
  if (!key) return // 고유닉을 아직 못 받아온 경우, 닉네임으로 대신 섞이지 않게 조용히 스킵
  const targetKey = targetNick.toLowerCase()
  if (key === targetKey) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBattleSelfError, { nickname: author })), 400); return }

  // ⏱ 같은 사람이 짧은 시간 안에 !대결을 반복해서 포인트만 파밍하는 걸 막는 쿨타임.
  const cooldownSec = Math.max(0, parseInt(mc.battleCooldownSec, 10) || 0)
  if (cooldownSec > 0) {
    if (!room._battleCooldown) room._battleCooldown = new Map()
    const lastAt = room._battleCooldown.get(key) || 0
    const remainMs = cooldownSec * 1000 - (Date.now() - lastAt)
    if (remainMs > 0) {
      setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBattleCooldown, { nickname: author, sec: Math.ceil(remainMs / 1000) })), 400)
      return
    }
  }

  const myMon = mcPickStrongest(mc.collections[key], mc.monsters, key)
  if (!myMon) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBattleNoMonsters, { nickname: author, cmdCatch: mc.cmdCatch || '!잡기' })), 400); return }
  const targetMon = mcPickStrongest(mc.collections[targetKey], mc.monsters, targetKey)
  if (!targetMon) { setTimeout(() => sendChatToRoom(djId, mcFormat(mc.msgBattleTargetNoMonsters, { nickname: author, target: targetNick })), 400); return }

  // 실제로 대결이 진행되는 시점부터 쿨타임을 시작한다 (사용법 오류/상대 몬스터 없음 등으로
  // 실패한 경우는 쿨타임을 소모하지 않아서, 실수로 잘못 친 것까지 벌주지 않는다).
  if (cooldownSec > 0) {
    if (!room._battleCooldown) room._battleCooldown = new Map()
    room._battleCooldown.set(key, Date.now())
  }

  const myBasePower = Math.max(1, Number(myMon.power) || 10)
  const targetBasePower = Math.max(1, Number(targetMon.power) || 10)
  // 🔥 타입 상성 적용 — 서로의 타입으로 서로에게 얼마나 잘 먹히는지 배율을 구해서 공격력에 곱한다.
  const myTypeMult = mcTypeMultiplier(myMon.types, targetMon.types)
  const targetTypeMult = mcTypeMultiplier(targetMon.types, myMon.types)
  const myPower = myBasePower * myTypeMult
  const targetPower = targetBasePower * targetTypeMult
  // ⚔️ [업데이트] 예전엔 공격력 비율로 "확률"만 정해서, 공격력이 낮아도 가끔 이기는 확률형이었다.
  // 이제 실제 공격력(타입 상성 반영)을 그대로 기준으로 삼아서, 더 유리한 쪽이 항상 이긴다.
  // 공격력이 정확히 같을 때만 50:50 무작위로 승패를 가른다.
  const iWin = myPower === targetPower ? Math.random() < 0.5 : myPower > targetPower
  const winnerMonster = iWin ? myMon : targetMon
  const loserMonster = iWin ? targetMon : myMon
  const winnerName = iWin ? author : targetNick
  const winnerKey = iWin ? key : targetKey
  const winnerMult = iWin ? myTypeMult : targetTypeMult
  const moveList = (winnerMonster.moves && winnerMonster.moves.length) ? winnerMonster.moves : ['공격']
  const move = moveList[Math.floor(Math.random() * moveList.length)]
  const effectText = mcTypeEffectText(winnerMult)

  // 🏆 승자에게 도감 포인트 지급 (레벨업에 쓰는 그 포인트) — 몬스터 웹 도감 데이터에 바로 적립.
  const winPoints = Math.max(0, parseInt(mc.battleWinPoints, 10) || 0)
  if (winPoints > 0) {
    const wd = mcGetWebData()
    wd.points[winnerKey] = (wd.points[winnerKey] || 0) + winPoints
    mcSaveWebData()
  }

  const line = mcFormat(mc.msgBattleResult, {
    nickname: author, target: targetNick,
    myMonster: myMon.name, targetMonster: targetMon.name,
    winner: winnerName, winnerMonster: winnerMonster.name, loserMonster: loserMonster.name,
    move, effect: effectText, amount: winPoints,
  })
  setTimeout(() => sendChatToRoom(djId, line), 400)
}

// ══════════════════════════════════════════════════════
// 🎟️ 복권 차등지급 — 방송에 입장한 순서대로 등수(1등, 2등, ...)를 매겨서, 등수별로 정해진
// 수량의 복권을 차등 지급한다. 입장 즉시 "몇 등으로 오셨습니다" 안내만 나가고, 실제 지급은
// delaySec(기본 60초) 후 그때까지 방송에 남아있는 경우에만 이뤄진다 (바로 들어왔다 나가는
// 뜨내기 시청자에게 헛지급되는 걸 막기 위함). 애청지수(내정보)가 없는 유저는 지급 없이
// 안내 멘트만 나간다.

function getLottoRankSettings(djId, settings) {
  if (!settings.lottoRankGive) {
    settings.lottoRankGive = {
      enabled: false,
      ranks: [
        { rank: 1, amount: 5 },
        { rank: 2, amount: 3 },
        { rank: 3, amount: 2 },
        { rank: 4, amount: 1 },
        { rank: 5, amount: 1 },
      ],
      delaySec: 60,
      msgJoinRank: '👏 {nickname}님 {rank}등으로 오셨습니다! ({delay}초 후 복권 {amount}장 지급 예정)',
      msgGive: '🎟️ {nickname}님 {rank}등 복권 {amount}장 지급 완료! (보유: {lotto}장)',
      msgNoInfo: '⚠️ {nickname}님은 내정보가 없어서 복권이 지급되지 않았습니다.',
    }
    store.saveSettings(djId, { lottoRankGive: settings.lottoRankGive })
  }
  if (!Array.isArray(settings.lottoRankGive.ranks)) settings.lottoRankGive.ranks = []
  return settings.lottoRankGive
}

function lottoRankFormat(tpl, data) {
  const v = (val) => (val === undefined || val === null || val === '') ? '0' : String(val)
  return String(tpl || '')
    .replace(/{nickname}/g, data.nickname || '')
    .replace(/{tag}/g, data.tag || '')
    .replace(/{rank}/g, v(data.rank))
    .replace(/{amount}/g, v(data.amount))
    .replace(/{lotto}/g, v(data.lotto))
    .replace(/{delay}/g, v(data.delay))
}

// 봇이 방송에 새로 연결될 때(ws open)마다 호출해서, "이번 방송에서 몇 번째로 들어왔는지"를
// 처음부터 다시 센다.
function resetLottoRankCounter(room) {
  room._lottoRankCounter = 0
}

// 입장 이벤트(웹소켓 RoomJoin / 명단폴링 공용, sendJoinMessage에서 호출)마다 실행.
// 등수 안내는 즉시, 실제 복권 지급은 delaySec 후 생존 여부를 확인하고 진행한다.
function handleLottoRankJoin(djId, room, settings, author, tag) {
  if (!isModuleOn(settings, 'lottorank', djId)) return
  const cfg = getLottoRankSettings(djId, settings)
  if (cfg.enabled === false) return
  const ranks = (cfg.ranks || []).filter(r => r && Number(r.rank) > 0).sort((a, b) => Number(a.rank) - Number(b.rank))
  if (!ranks.length) return

  room._lottoRankCounter = (room._lottoRankCounter || 0) + 1
  const rank = room._lottoRankCounter
  const rankCfg = ranks.find(r => Number(r.rank) === rank)
  if (!rankCfg) return // 설정해둔 등수 범위를 벗어나면 조용히 패스 (예: 5명까지만 설정했는데 6번째로 온 경우)

  const amount = Math.max(1, Number(rankCfg.amount) || 1)
  const delaySec = Math.max(5, Math.min(600, Number(cfg.delaySec) || 60))
  const key = String(tag || author || '').trim().toLowerCase()

  const announce = lottoRankFormat(cfg.msgJoinRank, { nickname: author, tag, rank, amount, delay: delaySec })
  if (announce) setTimeout(() => sendChatToRoom(djId, announce), 300)

  setTimeout(() => {
    // 지급 시점에 아직 방송에 남아있는지 먼저 확인 — 바로 들어왔다 나간 사람은 조용히 건너뜀
    if (key && room._lastLiveMembers && !room._lastLiveMembers.has(key)) return

    const liveSettings = store.getSettings(djId) || {}
    if (!isModuleOn(liveSettings, 'lottorank', djId)) return
    if (!isModuleOn(liveSettings, 'loyalty', djId)) return
    const act = getActivitySettings(djId, liveSettings)
    const actKey = actResolveKey(act, author, tag)
    if (!actKey) {
      const noInfoMsg = lottoRankFormat(cfg.msgNoInfo, { nickname: author, tag, rank, amount })
      if (noInfoMsg) sendChatToRoom(djId, noInfoMsg)
      return
    }
    const d = act.users[actKey]
    d.lotto = (d.lotto || 0) + amount
    store.saveSettings(djId, { activity: act })
    const giveMsg = lottoRankFormat(cfg.msgGive, { nickname: d.nickname || author, tag, rank, amount, lotto: d.lotto })
    if (giveMsg) sendChatToRoom(djId, giveMsg)
  }, delaySec * 1000)
}

// ══════════════════════════════════════════════════════
// 🔔 리액션 타이머 기본 알림음 — 볼륨/서버 볼륨과 무관하게 항상 재생 가능하도록 파일 경로가
// 아니라 base64로 코드에 직접 심어뒀다 (재배포/볼륨 초기화와도 무관하게 항상 동작).
// DJ가 관리자 패널에서 다른 음원으로 바꾸면 그때부터는 그 커스텀 음원이 우선 사용된다.
const DEFAULT_REACTION_SOUND_B64 = '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'
const DEFAULT_REACTION_SOUND_BUFFER = Buffer.from(DEFAULT_REACTION_SOUND_B64, 'base64')
app.get('/sounds/reaction-timer-default.mp3', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Cache-Control', 'public, max-age=604800')
  res.send(DEFAULT_REACTION_SOUND_BUFFER)
})

// ⏰ 리액션 타이머 — "[명령어] [분] [내용]"으로 등록하면 그 시간 후에 채팅으로 알려준다.
// 등록된 타이머 목록은 명령어만 입력하면 확인할 수 있다. (누구나 등록 가능, 방 재접속 시 초기화됨)

function getReminderSettings(djId, settings) {
  if (!settings.reminderTimer) {
    settings.reminderTimer = {
      cmd: '!리액션',
      registerMsg: '⏰ {min}분 후 알림: {content}',
      alertMsg: '🔔 {content} 시간이 됐습니다!',
      soundUrl: '', // 비어있으면 기본 알림음(DEFAULT_REACTION_SOUND_BUFFER) 사용
      soundVolume: 100,
    }
    store.saveSettings(djId, { reminderTimer: settings.reminderTimer })
  }
  if (settings.reminderTimer.soundVolume == null) settings.reminderTimer.soundVolume = 100
  if (settings.reminderTimer.soundUrl == null) settings.reminderTimer.soundUrl = ''
  return settings.reminderTimer
}

function clearReminderTimers(room) {
  if (!room.reminderTimers) return
  room.reminderTimers.forEach(t => { if (t.handle) clearTimeout(t.handle) })
  room.reminderTimers = []
}

function handleReminderCommand(djId, room, settings, author, authorId, text) {
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
  // ⏰ {cmd} 중지 [번호] — 위 목록에 나오는 번호로 타이머를 제거한다. 방송 진행에 영향을 주는
  // 기능이라 DJ 본인만 사용 가능하게 제한한다 (등록은 누구나, 중지는 DJ만).
  const stopMatch = msg.match(new RegExp(`^${escapeRegExp(cmd)}\\s+중지\\s+(\\d+)$`))
  if (stopMatch) {
    const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
    if (!isDj) { setTimeout(() => sendChatToRoom(djId, '⚠️ 타이머 중지는 DJ만 사용할 수 있어요.'), 400); return }
    const idx = parseInt(stopMatch[1], 10) - 1
    if (idx < 0 || idx >= room.reminderTimers.length) { setTimeout(() => sendChatToRoom(djId, `⚠️ ${idx + 1}번 타이머를 찾을 수 없어요. ${cmd}로 목록을 먼저 확인해주세요.`), 400); return }
    const [removed] = room.reminderTimers.splice(idx, 1)
    if (removed && removed.handle) clearTimeout(removed.handle)
    setTimeout(() => sendChatToRoom(djId, `⏰ ${idx + 1}번 타이머(${removed.content})를 중지했어요.`), 400)
    return
  }
  if (msg.startsWith(cmd + ' ')) {
    // ⏰ 등록도 DJ 전용으로 제한 (중지랑 동일 기준). isDj는 위 "중지" 분기에서도 쓰는 계산이지만
    // 여기선 별도 분기라 다시 계산한다.
    const isDjRegister = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
    if (!isDjRegister) { setTimeout(() => sendChatToRoom(djId, '⚠️ 리액션 타이머 등록은 DJ만 사용할 수 있어요.'), 400); return }
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
      // 🔔 타이머가 실제로 울릴 때, 방송 화면(웹)을 보고 있는 브라우저에서 알림음을 2번 재생한다.
      // 커스텀 음원을 등록해뒀으면 그걸, 아니면 기본 내장음을 쓰도록 URL/볼륨을 같이 실어보낸다.
      const soundUrl = cfg.soundUrl || '/sounds/reaction-timer-default.mp3'
      broadcast({ type: 'reactiontimersound', djId, soundUrl, volume: cfg.soundVolume != null ? cfg.soundVolume : 100 })
    }, min * 60000)
    room.reminderTimers.push({ id, content, author, dueAt, handle })
    const regText = (cfg.registerMsg || '⏰ {min}분 후 알림: {content}').replace(/\{min\}/g, min).replace(/\{content\}/g, content)
    setTimeout(() => sendChatToRoom(djId, regText), 400)
    return
  }
}

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// 🔮 사주팔자 — 생년월일(시)을 입력하면 만세력 라이브러리(@fullstackfamily/manseryeok, MIT,
// KASI 한국천문연구원 데이터 기반)로 실제 사주팔자(년/월/일/시주)를 계산하고, 일간(日干) 오행과
// 사주 내 오행 분포를 바탕으로 풀이를 보여준다. 무작위 텍스트가 아니라 실제 계산된 결과.
const SAJU_STEM_ELEMENT = { '갑': '목', '을': '목', '병': '화', '정': '화', '무': '토', '기': '토', '경': '금', '신': '금', '임': '수', '계': '수' }
const SAJU_BRANCH_ELEMENT = { '인': '목', '묘': '목', '사': '화', '오': '화', '진': '토', '술': '토', '축': '토', '미': '토', '신': '금', '유': '금', '자': '수', '해': '수' }
const SAJU_BRANCH_ZODIAC = { '자': '쥐', '축': '소', '인': '호랑이', '묘': '토끼', '진': '용', '사': '뱀', '오': '말', '미': '양', '신': '원숭이', '유': '닭', '술': '개', '해': '돼지' }
const SAJU_ELEMENT_DESC = {
  '목': '성장과 추진력이 강점이에요. 리더십이 있고 유연하게 상황에 적응하지만, 가끔 고집이 세질 때가 있어요.',
  '화': '열정적이고 표현력이 풍부해요. 사교성이 좋아서 주변에 사람이 잘 모이지만, 성격이 급해질 때는 한 박자 쉬어가세요.',
  '토': '안정적이고 신뢰감을 주는 타입이에요. 포용력이 넓지만, 변화 앞에서는 다소 신중하고 느린 편이에요.',
  '금': '원칙적이고 결단력이 있어요. 분석적이고 맺고 끊음이 확실하지만, 가끔 냉정해 보일 수 있어요.',
  '수': '지혜롭고 유연한 사고를 가졌어요. 적응력이 좋지만, 생각이 많아지고 예민해질 때가 있어요.',
}

function getSajuSettings(djId, settings) {
  if (!settings.saju) {
    settings.saju = { cmd: '!사주' }
    store.saveSettings(djId, { saju: settings.saju })
  }
  return settings.saju
}

function handleSajuCommand(djId, room, settings, author, authorId, text) {
  if (!isModuleOn(settings, 'saju', djId)) return
  const cfg = getSajuSettings(djId, settings)
  const cmd = cfg.cmd || '!사주'
  const msg = String(text || '').trim()
  if (msg !== cmd && !msg.startsWith(cmd + ' ')) return

  if (!calculateSaju || !calculateSajuSimple) {
    setTimeout(() => sendChatToRoom(djId, `🔮 사주팔자 기능이 아직 서버에 설치 중이에요. 잠시 후 다시 시도해주세요.`), 400)
    return
  }

  const rest = msg.slice(cmd.length).trim()
  const m = rest.match(/^(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})(?:\s+(\d{1,2}))?$/)
  if (!rest || !m) {
    setTimeout(() => sendChatToRoom(djId, `🔮 사용법: ${cmd} [생년월일] [태어난시(선택)]\n예) ${cmd} 1995.08.15 14\n(시간 몰라도 괜찮아요, 안 적으면 년/월/일주만 봐드려요)`), 400)
    return
  }
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
  const hasHour = m[4] != null
  const h = hasHour ? parseInt(m[4], 10) : undefined
  const validDate = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2050 && (!hasHour || (h >= 0 && h <= 23))
  if (!validDate) {
    setTimeout(() => sendChatToRoom(djId, `🔮 날짜를 다시 확인해주세요. (지원 범위: 1900~2050년, 시는 0~23)`), 400)
    return
  }

  let saju
  try {
    saju = hasHour ? calculateSaju(y, mo, d, h) : calculateSajuSimple(y, mo, d)
  } catch (e) {
    setTimeout(() => sendChatToRoom(djId, `🔮 사주 계산에 실패했어요. 날짜를 다시 확인해주세요. (${e.message})`), 400)
    return
  }

  const pillars = [saju.yearPillar, saju.monthPillar, saju.dayPillar, hasHour ? saju.hourPillar : null].filter(Boolean)
  const chars = pillars.flatMap(p => [p[0], p[1]])
  const counts = {}
  chars.forEach(c => {
    const el = SAJU_STEM_ELEMENT[c] || SAJU_BRANCH_ELEMENT[c]
    if (el) counts[el] = (counts[el] || 0) + 1
  })
  const dayStem = saju.dayPillar[0]
  const dayElement = SAJU_STEM_ELEMENT[dayStem]
  const zodiac = SAJU_BRANCH_ZODIAC[saju.yearPillar[1]] || ''
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const most = sorted[0]
  const missing = ['목', '화', '토', '금', '수'].filter(e => !counts[e])
  const dateStr = `${y}.${String(mo).padStart(2, '0')}.${String(d).padStart(2, '0')}`

  const lines = [
    `🔮 [${author}]님의 사주팔자`,
    `${dateStr}${hasHour ? ' ' + h + '시' : ''} · ${zodiac}띠`,
    `년주 ${saju.yearPillar} · 월주 ${saju.monthPillar} · 일주 ${saju.dayPillar}${hasHour ? ' · 시주 ' + saju.hourPillar : ''}`,
    `일간(나): ${dayStem}(${dayElement}) — ${SAJU_ELEMENT_DESC[dayElement] || ''}`,
  ]
  if (most) lines.push(`✨ 사주에 ${most[0]}(${most[1]}개) 기운이 가장 강해요.`)
  if (missing.length) lines.push(`부족한 기운: ${missing.join(', ')}`)
  if (!hasHour) lines.push(`(태어난 시각까지 알면 시주까지 봐드려요: ${cmd} ${dateStr} 14)`)

  sendChatSplit(djId, lines.join('\n'), 150, 600)
}

// ══════════════════════════════════════════════════════
// 🌦️ 날씨 조회 — "!날씨 [지역]"으로 현재 날씨(온도/체감/습도/바람/하늘상태)를 채팅에 알려준다.
// API 키가 필요 없는 Open-Meteo(무료, 상업적 이용도 가능)를 쓴다:
//  1) 지오코딩 API로 지역명 → 위경도 변환 (한국어 지명 검색 지원)
//  2) 날씨 API로 그 위경도의 현재 날씨 조회
// 같은 지역을 반복 조회할 때 API를 매번 두 번씩 때리지 않도록 10분 캐시를 둔다.
const WEATHER_CODE_MAP = {
  0: '☀️ 맑음', 1: '🌤️ 대체로 맑음', 2: '⛅ 구름 조금', 3: '☁️ 흐림',
  45: '🌫️ 안개', 48: '🌫️ 서리 안개',
  51: '🌦️ 이슬비(약)', 53: '🌦️ 이슬비', 55: '🌦️ 이슬비(강)',
  56: '🌧️❄️ 언 이슬비(약)', 57: '🌧️❄️ 언 이슬비(강)',
  61: '🌧️ 비(약)', 63: '🌧️ 비', 65: '🌧️ 비(강)',
  66: '🌧️❄️ 언 비(약)', 67: '🌧️❄️ 언 비(강)',
  71: '🌨️ 눈(약)', 73: '🌨️ 눈', 75: '🌨️ 눈(강)', 77: '🌨️ 싸락눈',
  80: '🌦️ 소나기(약)', 81: '🌦️ 소나기', 82: '🌦️ 소나기(강)',
  85: '🌨️ 눈소나기(약)', 86: '🌨️ 눈소나기(강)',
  95: '⛈️ 뇌우', 96: '⛈️ 뇌우(우박 약)', 99: '⛈️ 뇌우(우박 강)',
}
const weatherCache = new Map() // key: 정규화된 지역명 → { data, expiresAt }

function getWeatherSettings(djId, settings) {
  if (!settings.weather) {
    settings.weather = {
      cmd: '!날씨',
      defaultLocation: '서울',
      template: '{emoji} [{location}]\n현재 {temp}°C (체감 {feels}°C)\n· 습도 {humidity}% · 바람 {wind}m/s\n· {condition}',
      notFoundMsg: '⚠️ \'{query}\' 지역을 찾을 수 없어요. 다른 지명으로 다시 시도해주세요. (예: {cmd} 서울, {cmd} 부산, {cmd} 제주)',
    }
    store.saveSettings(djId, { weather: settings.weather })
  }
  return settings.weather
}

async function geocodeLocation(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=ko&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } })
  const data = await res.json()
  const hit = data && Array.isArray(data.results) ? data.results[0] : null
  if (!hit) return null
  const nameParts = [hit.name]
  if (hit.admin1 && hit.admin1 !== hit.name) nameParts.push(hit.admin1)
  return { latitude: hit.latitude, longitude: hit.longitude, displayName: nameParts.join(' ') }
}

async function fetchCurrentWeather(latitude, longitude) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=Asia%2FSeoul`
  const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } })
  const data = await res.json()
  return data && data.current ? data.current : null
}

async function getWeatherForQuery(query) {
  const key = String(query || '').trim().toLowerCase()
  const cached = weatherCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.data
  const geo = await geocodeLocation(query)
  if (!geo) { weatherCache.delete(key); return null }
  const cur = await fetchCurrentWeather(geo.latitude, geo.longitude)
  if (!cur) return null
  const result = {
    location: geo.displayName,
    temp: Math.round(cur.temperature_2m),
    feels: Math.round(cur.apparent_temperature),
    humidity: Math.round(cur.relative_humidity_2m),
    wind: cur.wind_speed_10m,
    condition: WEATHER_CODE_MAP[cur.weather_code] || `날씨코드 ${cur.weather_code}`,
  }
  weatherCache.set(key, { data: result, expiresAt: Date.now() + 10 * 60 * 1000 })
  return result
}

function handleWeatherCommand(djId, room, settings, author, authorId, text) {
  const cfg = getWeatherSettings(djId, settings)
  const cmd = cfg.cmd || '!날씨'
  const msg = String(text || '').trim()
  if (msg !== cmd && !msg.startsWith(cmd + ' ')) return

  const query = msg.slice(cmd.length).trim() || cfg.defaultLocation || '서울'
  getWeatherForQuery(query).then(w => {
    if (!w) {
      const notFound = (cfg.notFoundMsg || '').replace(/{query}/g, query).replace(/{cmd}/g, cmd)
      if (notFound) sendChatToRoom(djId, notFound)
      return
    }
    const wind = typeof w.wind === 'number' ? w.wind.toFixed(1) : w.wind
    const emoji = (w.condition || '').split(' ')[0] || '🌤️'
    const line = (cfg.template || '')
      .replace(/{emoji}/g, emoji)
      .replace(/{location}/g, w.location)
      .replace(/{temp}/g, w.temp)
      .replace(/{feels}/g, w.feels)
      .replace(/{humidity}/g, w.humidity)
      .replace(/{wind}/g, wind)
      .replace(/{condition}/g, w.condition)
    sendChatToRoom(djId, line)
  }).catch(e => {
    console.log('[날씨 조회 실패]', query, e.message)
    sendChatToRoom(djId, `⚠️ 날씨 조회 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.`)
  })
}

// 📅 디데이 — "[명령어] [MM-DD] [내용]"으로 등록(DJ 전용)하면, 명령어만 입력했을 때
// 등록된 디데이 목록과 남은/지난 일수를 보여준다. MM-DD는 매년 반복되는 날짜로 계산하고,
// YYYY.MM.DD / YYYY-MM-DD 처럼 연도까지 입력하면 그 해 그 날짜 딱 한 번만 기준으로 계산한다.

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

// 📝 메모2 — "메모장"(웹 화면 전용)과 달리, 채팅 명령어로 DJ/매니저가 메모를 남기고
// 누구나 채팅으로 조회할 수 있는 공개 메모 게시판. 매니저 권한은 실드 관리/신청곡 관리와
// 동일한 방식(고유닉 목록 + 즉시 재조회)으로 체크한다.
function getMemo2Settings(djId, settings) {
  if (!settings.memo2) {
    settings.memo2 = { cmd: '!메모', cmdDelete: '!메모제거', items: [], perms: [] }
    store.saveSettings(djId, { memo2: settings.memo2 })
  }
  if (!settings.memo2.items) settings.memo2.items = []
  if (!settings.memo2.perms) settings.memo2.perms = []
  if (!settings.memo2.cmdDelete) settings.memo2.cmdDelete = '!메모제거'
  return settings.memo2
}

async function handleMemo2Command(djId, room, settings, author, authorId, text, liveId) {
  if (!isModuleOn(settings, 'memo2', djId)) return
  const cfg = getMemo2Settings(djId, settings)
  const msg = String(text || '').trim()
  const cmd = cfg.cmd || '!메모'
  const cmdDelete = cfg.cmdDelete || '!메모제거'

  if (msg === cmd) {
    if (!cfg.items.length) { setTimeout(() => sendChatToRoom(djId, '📝 등록된 메모가 없어요.'), 400); return }
    const lines = cfg.items.map((it, i) => `${i + 1}. ${it.text}`)
    sendChatSplit(djId, ['📝 등록된 메모'].concat(lines).join('\n'), 100, 600)
    return
  }

  const isAddCmd = msg.startsWith(cmd + ' ')
  const isDeleteCmd = msg.startsWith(cmdDelete + ' ')
  if (!isAddCmd && !isDeleteCmd) return

  // 여기부터는 DJ 또는 등록된 관리 권한자(고유닉)만 사용 가능 (실드 관리/신청곡 관리와 동일한 방식)
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  const perms = (cfg.perms || []).map(t => String(t).replace('@', '').toLowerCase())
  const authorNorm = String(author || '').toLowerCase()
  let isPermUser = perms.some(p => p === authorNorm || String(resolveNicknameFromInput(room, p) || '').toLowerCase() === authorNorm)
  if (!isPermUser && perms.length && liveId) {
    try {
      const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
      const freshMembers = await fetchLiveMembers(liveId, accessToken, 5)
      const me = freshMembers.find(u => u.nickname && u.nickname.toLowerCase() === authorNorm)
      if (me && me.tag) {
        rememberTagNickname(room, me.tag, author)
        isPermUser = perms.includes(me.tag.toLowerCase())
      }
    } catch (e) {
      console.log('[메모2 권한 재조회 오류]', e.message)
    }
  }
  if (!isDj && !isPermUser) return

  if (isDeleteCmd) {
    const idx = parseInt(msg.slice(cmdDelete.length).trim(), 10)
    if (!idx || idx < 1 || idx > cfg.items.length) { setTimeout(() => sendChatToRoom(djId, `📝 사용법: ${cmdDelete} [번호] (예: ${cmdDelete} 1)`), 400); return }
    const removed = cfg.items.splice(idx - 1, 1)[0]
    store.saveSettings(djId, { memo2: cfg })
    setTimeout(() => sendChatToRoom(djId, `🗑️ ${idx}번 메모를 삭제했어요. ("${removed.text}")`), 400)
    return
  }

  const content = msg.slice(cmd.length).trim()
  if (!content) { setTimeout(() => sendChatToRoom(djId, `📝 사용법: ${cmd} [내용]`), 400); return }
  if (cfg.items.length >= 100) { setTimeout(() => sendChatToRoom(djId, '📝 등록 가능한 메모는 최대 100개예요. 오래된 메모를 지워주세요.'), 400); return }
  cfg.items.push({ id: 'm2_' + Date.now() + Math.floor(Math.random() * 1000), text: content, author, createdAt: Date.now() })
  store.saveSettings(djId, { memo2: cfg })
  setTimeout(() => sendChatToRoom(djId, `📝 메모가 등록됐어요. (${cfg.items.length}번째)`), 400)
}

// 💎 구독자 플랜 월간 지급 — 채팅 이벤트에 실시간으로 딸려오는 generator.subscribeToDj(구독자 여부)를
// 그 순간 바로 확인해서, 이번 달에 아직 못 받은 구독자면 자동으로 복권/룰렛권을 지급한다.
// 별도 등록 절차가 필요 없고(고유닉 조회만 되면 끝), "이번 달에 받았는지"만 고유닉 기준으로 기록해둔다.
// (7월에 받았으면 8월에 다시 받을 수 있는 구조 — grants[tag]에 마지막으로 받은 월(YYYY-MM)만 저장)
function getPlanSubSettings(djId, settings) {
  if (!settings.planSub) {
    settings.planSub = {
      // 기본값 — 아래 levelRewards에 매칭되는 등급이 없을 때(또는 등급 정보를 못 받았을 때) 사용
      rewardType: 'lotto', // 'lotto'(복권) | 'roulette'(룰렛권)
      rouletteIdx: 1,       // rewardType이 roulette일 때 몇 번 룰렛권을 줄지
      amount: 1,
      message: '💎 {nickname}님, 이번 달 구독 감사해요! {보상} 지급해드렸어요.',
      // 플랜 등급(userPlanLevel)별로 다르게 주고 싶을 때 등록. level 값은 스푼에서 오는 그대로
      // 문자/숫자를 적으면 되고(예: "1","2","BASIC" 등 — 실제 뭐가 오는지는 이벤트 뷰어로 확인),
      // 여기 등록 안 된 등급은 그냥 위 기본값이 적용된다.
      levelRewards: [], // [{ level:'1', rewardType:'lotto', rouletteIdx:1, amount:1, message:'' }]
      grants: {}, // { [고유닉]: { month: 'YYYY-MM', nickname } }
    }
    store.saveSettings(djId, { planSub: settings.planSub })
  }
  if (!settings.planSub.grants) settings.planSub.grants = {}
  if (!settings.planSub.levelRewards) settings.planSub.levelRewards = []
  return settings.planSub
}

function handlePlanSubHook(djId, settings, author, tag, isSubscribe, userPlanLevel) {
  if (!isSubscribe) return // 구독자 아니면 상관없음
  if (!isModuleOn(settings, 'plansub', djId)) return
  if (!tag) return // ⚠️ 무조건 고유닉 기반 — 고유닉 없으면 절대 지급/기록 안 함 (닉네임 키 생성 금지)
  const cfg = getPlanSubSettings(djId, settings)
  const key = String(tag).trim().toLowerCase()
  const month = thisMonthKST()
  const already = cfg.grants[key]
  if (already && already.month === month) return // 이번 달에 이미 지급함

  // 플랜 등급(userPlanLevel)에 맞는 개별 설정이 있으면 그걸 쓰고, 없으면 기본값을 쓴다.
  const levelStr = userPlanLevel != null ? String(userPlanLevel) : null
  let levelCfg = levelStr ? (cfg.levelRewards || []).find(r => String(r.level) === levelStr) : null
  // 🆕 처음 보는 등급이면, 수동으로 미리 등록 안 해놔도 자동으로 "구독자플랜N" 이름을 붙여서 만들어준다.
  // (10/20/30처럼 10 단위로 오는 걸 1/2/3단계로 자동 환산 — 나중에 DJ가 설정 화면에서 이름/보상 직접 조정 가능)
  if (levelStr && !levelCfg) {
    const num = Number(userPlanLevel)
    const planNo = (!isNaN(num) && num > 0 && num % 10 === 0) ? (num / 10) : userPlanLevel
    levelCfg = {
      level: levelStr,
      label: `구독자플랜${planNo}`,
      rewardType: cfg.rewardType,
      rouletteIdx: cfg.rouletteIdx,
      amount: cfg.amount,
      message: '',
    }
    if (!cfg.levelRewards) cfg.levelRewards = []
    cfg.levelRewards.push(levelCfg)
    console.log(`[구독자플랜] 새 등급 자동 등록: level=${levelStr} → "${levelCfg.label}" (기본값으로 시작, 설정 화면에서 조정 가능)`)
  }
  const rule = levelCfg || cfg

  let rewardLabel = ''
  if (rule.rewardType === 'roulette') {
    const rec = getHistoryRecByIdentity(settings, tag, author)
    if (!rec) return // 이 순간 고유닉 기록 조회 자체가 실패하면(극히 드묾) 그냥 넘어가고 다음 채팅 때 재시도됨
    const idx = Number(rule.rouletteIdx) || 1
    rec.coupons[idx] = Number(rec.coupons[idx] || 0) + (Number(rule.amount) || 1)
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    rewardLabel = `룰렛${idx}권 ${Number(rule.amount) || 1}장`
  } else {
    const act = getActivitySettings(djId, settings)
    const existingKey = actResolveKey(act, author, tag) // ⚠️ 미등록 유저면 null — 자동 등록 안 하고 조용히 무시
    if (!existingKey) { console.log(`[구독자플랜] ${author} 애청지수 미등록 — 복권 지급 무시`); return }
    const d = actEnsureUser(act, existingKey, author, tag)
    d.lotto = Math.max(0, (d.lotto || 0) + (Number(rule.amount) || 1))
    store.saveSettings(djId, { activity: act })
    rewardLabel = `복권 ${Number(rule.amount) || 1}장`
  }

  cfg.grants[key] = { month, nickname: author, level: levelStr, label: rule.label || null }
  store.saveSettings(djId, { planSub: cfg })

  const text = (rule.message || cfg.message || '💎 {nickname}님, 이번 달 구독 감사해요! {보상} 지급해드렸어요.')
    .replace(/{nickname}/g, author).replace(/{보상}/g, rewardLabel).replace(/{플랜}/g, rule.label || '')
  setTimeout(() => sendChatToRoom(djId, text), 500)
}

// 🌟 통합 귀빈 등급 시스템 — 구독자/팬랭킹/VIP등급/온도(애정도)를 하나의 점수로 합산해서
// 자체 등급(일반/단골/찐팬/VIP 등, 이름·구간 다 커스텀 가능)을 자동으로 매긴다.
// 이벤트가 올 때마다(채팅/입장) 그 순간 확인 가능한 필드로 점수를 다시 계산해서 갱신하는 방식이라
// 별도 등록 절차가 없고, 언제나 "가장 최근 확인된 값" 기준으로 유지된다. 무조건 고유닉 기반.
function getVipTierSettings(djId, settings) {
  if (!settings.vipTier) {
    settings.vipTier = {
      cmd: '!내등급',
      weights: { subscribe: 30, fanRankTop3: 40, fanRankTop10: 20, vipGradePoint: 10, tempTop: 20 },
      tiers: [
        { name: '일반', min: 0, expMulti: 1, bonusSpins: 0 },
        { name: '단골', min: 30, expMulti: 1.2, bonusSpins: 0 },
        { name: '찐팬', min: 60, expMulti: 1.5, bonusSpins: 1 },
        { name: 'VIP', min: 90, expMulti: 2, bonusSpins: 2 },
      ],
      users: {}, // { [고유닉]: { score, tier, nickname, updatedAt } }
    }
    store.saveSettings(djId, { vipTier: settings.vipTier })
  }
  if (!settings.vipTier.users) settings.vipTier.users = {}
  if (!settings.vipTier.weights) settings.vipTier.weights = { subscribe: 30, fanRankTop3: 40, fanRankTop10: 20, vipGradePoint: 10, tempTop: 20 }
  if (!settings.vipTier.tiers || !settings.vipTier.tiers.length) {
    settings.vipTier.tiers = [
      { name: '일반', min: 0, expMulti: 1, bonusSpins: 0 },
      { name: '단골', min: 30, expMulti: 1.2, bonusSpins: 0 },
      { name: '찐팬', min: 60, expMulti: 1.5, bonusSpins: 1 },
      { name: 'VIP', min: 90, expMulti: 2, bonusSpins: 2 },
    ]
  }
  return settings.vipTier
}

// 그 순간 이벤트에서 확인 가능한 필드만으로 점수를 계산한다 (없는 필드는 그냥 0점 취급).
function computeVipScore(gen, weights) {
  if (!gen) return 0
  let score = 0
  if (gen.subscribeToDj) score += Number(weights.subscribe) || 0
  const fanRank = gen.fanRank != null ? Number(gen.fanRank) : null
  if (fanRank != null && fanRank > 0) {
    if (fanRank <= 3) score += Number(weights.fanRankTop3) || 0
    else if (fanRank <= 10) score += Number(weights.fanRankTop10) || 0
  }
  if (gen.vipGrade != null && !isNaN(Number(gen.vipGrade))) score += Number(gen.vipGrade) * (Number(weights.vipGradePoint) || 0)
  if (gen.isHighTemperature || gen.temperatureType === 'TOP_RANK_3') score += Number(weights.tempTop) || 0
  return score
}
// tiers는 min 오름차순이어야 함 — 점수 이상인 것 중 가장 높은 구간을 찾는다.
function getTierForScore(tiers, score) {
  const sorted = [...(tiers || [])].sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0))
  let matched = sorted[0] || { name: '일반', min: 0, expMulti: 1, bonusSpins: 0 }
  for (const t of sorted) {
    if (score >= (Number(t.min) || 0)) matched = t
  }
  return matched
}
// 채팅/입장 이벤트마다 호출해서 그 유저의 등급을 최신 상태로 갱신한다. 반환값은 매칭된 tier 객체(또는 null).
let settingsDirty = false // 채팅마다 도는 고빈도 갱신용 — true면 다음 flush 타이밍에 한 번 저장

// 🔢 입장 메시지의 {count} — 이 사람이 지금까지 이 방에 누적으로 몇 번 입장했는지.
// 고유닉(태그) 기준으로 세고, 태그를 아직 못 받아온 경우에만 닉네임으로 대신 센다
// (닉네임은 겹칠 수 있어서 태그보다 부정확하지만, 아예 안 세는 것보단 낫다).
// updateVipTierForUser/updateTempRanking이랑 같은 패턴으로, 매번 디스크에 쓰지 않고
// dirty 플래그만 세워서 8초마다 몰아서 저장한다.
function incrementVisitCount(djId, settings, author, tag) {
  const key = String(tag || author || '').trim().toLowerCase()
  if (!key) return 1
  if (!settings.visitCounts) settings.visitCounts = { users: {} }
  if (!settings.visitCounts.users) settings.visitCounts.users = {}
  const prev = (settings.visitCounts.users[key] && settings.visitCounts.users[key].count) || 0
  const count = prev + 1
  settings.visitCounts.users[key] = { count, nickname: author, updatedAt: Date.now() }
  settingsDirty = true
  return count
}

function updateVipTierForUser(djId, settings, author, tag, gen) {
  if (!isModuleOn(settings, 'viptier', djId)) return null
  if (!tag) return null // ⚠️ 무조건 고유닉 기반 — 고유닉 없으면 등급 기록 자체를 안 만든다
  const cfg = getVipTierSettings(djId, settings)
  const gain = computeVipScore(gen, cfg.weights) // 이번 이벤트에서 조건 만족한 만큼의 점수
  const key = String(tag).trim().toLowerCase()
  const prevScore = (cfg.users[key] && cfg.users[key].score) || 0
  const score = prevScore + gain // 📈 누적 — 기존 점수에 그대로 더한다 (매번 새로 계산해서 덮어쓰지 않음)
  const tier = getTierForScore(cfg.tiers, score)
  cfg.users[key] = { score, tier: tier.name, nickname: author, updatedAt: Date.now() }
  settingsDirty = true // ⚡ 채팅마다 매번 디스크에 즉시 쓰면 느려져서, 메모리만 갱신하고 저장은 주기적으로 몰아서
  return tier
}
// 저장된 값 기준으로 그 유저의 현재 등급 정보를 가져온다 (이벤트 없이 그냥 조회만 할 때).
function getVipTierForTag(settings, tag) {
  if (!tag) return null
  const cfg = settings.vipTier
  if (!cfg || !cfg.users) return null
  return cfg.users[String(tag).trim().toLowerCase()] || null
}

function handleVipTierCommand(djId, settings, author, tag, text) {
  if (!isModuleOn(settings, 'viptier', djId)) return
  const cfg = getVipTierSettings(djId, settings)
  const msg = String(text || '').trim()
  if (msg !== (cfg.cmd || '!내등급')) return
  const rec = tag ? cfg.users[String(tag).trim().toLowerCase()] : null
  if (!rec) { setTimeout(() => sendChatToRoom(djId, `🌟 ${author}님의 등급 정보를 아직 확인 중이에요. 채팅 한 번 더 남겨주세요!`), 400); return }
  setTimeout(() => sendChatToRoom(djId, `🌟 ${author}님의 등급은 [${rec.tier}] 입니다! (점수: ${rec.score}점)`), 400)
}

// 🌡️ 스푼 온도 랭킹 — 채팅/입장 이벤트에 실려오는 favoriteTemperature(애정도 온도)를 그때그때
// 고유닉 기준으로 기록해두고, !온도 치면 지금까지 확인된 사람들 중 온도 상위 10명을 보여준다.
// 무조건 고유닉 기반 — 고유닉 없으면 기록하지 않는다.
function updateTempRanking(djId, settings, author, tag, gen) {
  if (!tag || !gen || gen.favoriteTemperature == null) return
  const temp = Number(gen.favoriteTemperature)
  if (isNaN(temp)) return
  if (!settings.tempRanking) settings.tempRanking = { users: {} }
  if (!settings.tempRanking.users) settings.tempRanking.users = {}
  const key = String(tag).trim().toLowerCase()
  settings.tempRanking.users[key] = { nickname: author, temp, updatedAt: Date.now() }
  settingsDirty = true // ⚡ 위와 동일한 이유로 즉시 저장 대신 dirty 표시만
}

// ⚡ 위 두 함수처럼 "채팅 한 줄마다" 도는 고빈도 갱신들은 즉시 store.saveSettings()를 부르지 않고
// dirty 플래그만 세워둔다. saveSettings 없이도 메모리 캐시(참조)에는 이미 반영돼있어서 즉시
// 조회(!내등급, !온도)는 정상 동작하고, 디스크 반영만 아래 인터벌로 몰아서 8초에 한 번 처리한다.
setInterval(() => {
  if (settingsDirty) {
    settingsDirty = false
    store.flush()
  }
}, 8000)

function handleTempRankCommand(djId, settings, text) {
  const msg = String(text || '').trim()
  if (msg !== '!온도') return
  const users = (settings.tempRanking && settings.tempRanking.users) || {}
  const sorted = Object.values(users).sort((a, b) => b.temp - a.temp).slice(0, 10)
  if (!sorted.length) { setTimeout(() => sendChatToRoom(djId, '🌡️ 아직 확인된 온도 정보가 없어요.'), 400); return }
  const lines = ['🌡️ 스푼 온도 랭킹 TOP 10'].concat(sorted.map((u, i) => `${i + 1}. ${u.nickname} - ${u.temp.toFixed(1)}°`))
  sendChatSplit(djId, lines.join('\n'), 150, 600)
}

// 💰 매니저 토큰(매토) — DJ가 매니저들의 점수(토큰)를 번호로 관리하는 시스템.
// 무조건 고유닉 기반: 매니저는 DJ가 직접 고유닉을 입력해서 등록/삭제하므로 API 조회가 필요 없다.
// 권한: DJ, 이미 등록된 매니저(managers 목록에 있는 사람), 그리고 관리자 계정(고유닉 sum)만
// 관리 명령어를 쓸 수 있다. 일반 시청자는 !매토, !설명서만 사용 가능.
// 🌡️ 온도 설정 — 시청자의 스푼 온도(favoriteTemperature)가 지정한 값에 도달하면, 그 사람을
// 축하하는 멘트를 자동으로 채팅에 보낸다. 같은 사람이 같은 구간을 여러 번 못 넘도록(채팅마다
// 온도가 갱신되므로) announced에 "그 사람이 이미 받은 구간 id 목록"을 기록해둔다.
function getTempMilestoneSettings(djId, settings) {
  if (!settings.tempMilestone) {
    settings.tempMilestone = {
      enabled: false,
      items: [], // { id, temp, message }
      announced: {}, // key: 고유닉 → [넘은 구간 id 목록]
    }
    store.saveSettings(djId, { tempMilestone: settings.tempMilestone })
  }
  if (!Array.isArray(settings.tempMilestone.items)) settings.tempMilestone.items = []
  if (!settings.tempMilestone.announced || typeof settings.tempMilestone.announced !== 'object') settings.tempMilestone.announced = {}
  return settings.tempMilestone
}

function checkTempMilestones(djId, settings, author, tag, temp) {
  const tm = getTempMilestoneSettings(djId, settings)
  if (!tm.enabled || !tm.items.length) return
  const key = String(tag || '').trim().toLowerCase()
  if (!key) return
  if (!tm.announced[key]) tm.announced[key] = []
  let changed = false
  tm.items.forEach(item => {
    const threshold = Number(item.temp)
    if (isNaN(threshold) || temp < threshold) return
    if (tm.announced[key].includes(item.id)) return // 이미 이 구간 축하 멘트를 받은 사람
    tm.announced[key].push(item.id)
    changed = true
    const msg = String(item.message || '').replace(/{nickname}/g, author || '').replace(/{temp}/g, temp.toFixed(1)).replace(/{threshold}/g, String(threshold))
    if (msg) setTimeout(() => sendChatToRoom(djId, msg), 400)
  })
  if (changed) settingsDirty = true // 채팅마다 도는 고빈도 갱신이라 즉시 저장 대신 dirty만 표시(위 온도랭킹과 동일한 방식)
}

function getManagerTokenSettings(djId, settings) {
  if (!settings.managerToken) {
    settings.managerToken = {
      title: '💰=====매니저 토큰=====💰',
      content1: '',
      content2: '',
      managers: [], // [{ tag, nickname, score }]
    }
    store.saveSettings(djId, { managerToken: settings.managerToken })
  }
  if (!settings.managerToken.managers) settings.managerToken.managers = []
  return settings.managerToken
}

function managerTokenHasPermission(cfg, room, authorId, tag) {
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (isDj) return true
  if (tag && String(tag).trim().toLowerCase() === 'sum') return true
  if (tag && cfg.managers.some(m => String(m.tag).toLowerCase() === String(tag).trim().toLowerCase())) return true
  return false
}

function formatManagerTokenList(cfg) {
  const lines = []
  if (cfg.title) lines.push(cfg.title)
  if (cfg.content1) lines.push(cfg.content1)
  if (cfg.content2) lines.push(cfg.content2)
  if (!cfg.managers.length) {
    lines.push('등록된 매니저가 없어요.')
  } else {
    cfg.managers.forEach((m, i) => lines.push(`${i + 1}. ${m.nickname} - ${m.score}점`))
  }
  return lines.join('\n')
}

const MANAGER_TOKEN_HELP = [
  '📖 매토 명령어 설명서',
  '── 누구나 사용 가능 ──',
  '!매토 : 등록된 매니저와 점수 확인',
  '!설명서 : 이 안내 다시 보기',
  '── DJ/매니저 전용 ──',
  '!추가/매니저 [고유닉] (닉네임) : 매니저 추가',
  '!삭제/매니저 [고유닉] : 매니저 삭제',
  '!적립 [번호] [점수] : 점수 적립/차감 (마이너스 가능)',
  '!제목 [내용] : 목록 제목 변경',
  '!내용1 [내용] : 안내문구1 변경',
  '!내용2 [내용] : 안내문구2 변경',
].join('\n')

// 📢 !공지 [내용] — DJ 전용, 방송 공지사항을 채팅 명령어로 바로 변경
async function handleNoticeCommand(djId, room, settings, author, authorId, text) {
  const msg = String(text || '').trim()
  if (!msg.startsWith('!공지 ')) return
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (!isDj) return
  const newNotice = msg.slice('!공지 '.length).trim()
  if (!newNotice) { setTimeout(() => sendChatToRoom(djId, '⚠️ 사용법: !공지 [내용]'), 400); return }
  const result = await updateSpoonNotice(djId, room.liveId, newNotice)
  if (result.ok) {
    setTimeout(() => sendChatToRoom(djId, `✅ 공지사항이 변경됐어요: ${newNotice}`), 400)
  } else {
    setTimeout(() => sendChatToRoom(djId, `❌ 공지 변경 실패: ${result.error}`), 400)
  }
}

// 📢 !웹공지 [내용] / !웹공지끄기 / !웹공지폰트 [폰트이름] — DJ 전용, "내정보" 웹페이지
// 포스트 탭 상단에 뜨는 실시간 공지 배너를 방송 중 채팅으로 바로 바꾼다. 위의 !공지(스푼 앱
// 자체 방송 공지사항을 바꾸는 명령어)와는 완전히 별개 — 이건 에디봇 내정보 웹페이지 전용 배너다.
async function handleWebNoticeCommand(djId, room, settings, author, authorId, text) {
  const msg = String(text || '').trim()
  const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
  if (!isDj) return
  const cur = settings.myinfoNotice || { text: '', font: 'default' }

  if (msg === '!웹공지끄기') {
    store.saveSettings(djId, { myinfoNotice: { text: '', font: cur.font || 'default' } })
    setTimeout(() => sendChatToRoom(djId, '✅ 웹페이지 실시간 공지를 껐어요'), 400)
    return
  }

  if (msg.startsWith('!웹공지폰트 ')) {
    const query = msg.slice('!웹공지폰트 '.length).trim()
    if (!query || query === '기본') {
      store.saveSettings(djId, { myinfoNotice: { text: cur.text || '', font: 'default' } })
      setTimeout(() => sendChatToRoom(djId, '✅ 웹공지 폰트를 기본으로 되돌렸어요'), 400)
      return
    }
    const found = store.getMyinfoFonts().find(f => f.name.includes(query))
    if (!found) { setTimeout(() => sendChatToRoom(djId, `❌ "${query}" 이름의 폰트를 찾을 수 없어요`), 400); return }
    store.saveSettings(djId, { myinfoNotice: { text: cur.text || '', font: found.id } })
    setTimeout(() => sendChatToRoom(djId, `✅ 웹공지 폰트가 "${found.name}"(으)로 바뀌었어요`), 400)
    return
  }

  if (!msg.startsWith('!웹공지 ')) return
  const newText = msg.slice('!웹공지 '.length).trim()
  if (!newText) { setTimeout(() => sendChatToRoom(djId, '⚠️ 사용법: !웹공지 [내용]'), 400); return }
  store.saveSettings(djId, { myinfoNotice: { text: newText, font: cur.font || 'default' } })
  setTimeout(() => sendChatToRoom(djId, `✅ 웹페이지 실시간 공지가 바뀌었어요: ${newText}`), 400)
}

function handleManagerTokenCommand(djId, room, settings, author, authorId, tag, text) {
  if (!isModuleOn(settings, 'managertoken', djId)) return
  const cfg = getManagerTokenSettings(djId, settings)
  const msg = String(text || '').trim()

  if (msg === '!매토') {
    sendChatSplit(djId, formatManagerTokenList(cfg), 150, 600)
    return
  }
  if (msg === '!설명서') {
    sendChatSplit(djId, MANAGER_TOKEN_HELP, 150, 600)
    return
  }

  // 아래부터는 DJ/매니저/관리자(sum)만 사용 가능
  const isAddManager = msg.startsWith('!추가/매니저 ')
  const isRemoveManager = msg.startsWith('!삭제/매니저 ')
  const isDeposit = msg.startsWith('!적립 ')
  const isTitle = msg.startsWith('!제목 ')
  const isContent1 = msg.startsWith('!내용1 ')
  const isContent2 = msg.startsWith('!내용2 ')
  if (!isAddManager && !isRemoveManager && !isDeposit && !isTitle && !isContent1 && !isContent2) return

  if (!managerTokenHasPermission(cfg, room, authorId, tag)) {
    setTimeout(() => sendChatToRoom(djId, '⚠️ 매토 관리 명령어는 DJ/매니저만 사용할 수 있어요.'), 400)
    return
  }

  if (isAddManager) {
    const rest = msg.slice('!추가/매니저 '.length).trim().split(/\s+/)
    const newTag = (rest[0] || '').replace('@', '').trim()
    const nickname = rest.slice(1).join(' ').trim() || newTag
    if (!newTag) { setTimeout(() => sendChatToRoom(djId, '⚠️ 사용법: !추가/매니저 [고유닉] (닉네임)'), 400); return }
    if (cfg.managers.some(m => String(m.tag).toLowerCase() === newTag.toLowerCase())) {
      setTimeout(() => sendChatToRoom(djId, `⚠️ 이미 등록된 매니저예요. (@${newTag})`), 400)
      return
    }
    cfg.managers.push({ tag: newTag, nickname, score: 0 })
    store.saveSettings(djId, { managerToken: cfg })
    setTimeout(() => sendChatToRoom(djId, `✅ 매니저 추가 완료: ${nickname} (@${newTag})`), 400)
    setTimeout(() => sendChatSplit(djId, formatManagerTokenList(cfg), 150, 600), 900)
    return
  }

  if (isRemoveManager) {
    const targetTag = msg.slice('!삭제/매니저 '.length).trim().replace('@', '')
    if (!targetTag) { setTimeout(() => sendChatToRoom(djId, '⚠️ 사용법: !삭제/매니저 [고유닉]'), 400); return }
    const before = cfg.managers.length
    cfg.managers = cfg.managers.filter(m => String(m.tag).toLowerCase() !== targetTag.toLowerCase())
    if (cfg.managers.length === before) {
      setTimeout(() => sendChatToRoom(djId, `⚠️ 등록되지 않은 고유닉이에요. (@${targetTag})`), 400)
      return
    }
    store.saveSettings(djId, { managerToken: cfg })
    setTimeout(() => sendChatToRoom(djId, `🗑️ 매니저 삭제 완료: @${targetTag}`), 400)
    setTimeout(() => sendChatSplit(djId, formatManagerTokenList(cfg), 150, 600), 900)
    return
  }

  if (isDeposit) {
    const parts = msg.slice('!적립 '.length).trim().split(/\s+/)
    const idx = parseInt(parts[0], 10)
    const scoreDelta = parseInt(parts[1], 10)
    if (!idx || idx < 1 || idx > cfg.managers.length || isNaN(scoreDelta)) {
      setTimeout(() => sendChatToRoom(djId, `⚠️ 사용법: !적립 [번호] [점수] (예: !적립 1 100)`), 400)
      return
    }
    const m = cfg.managers[idx - 1]
    m.score = (m.score || 0) + scoreDelta
    store.saveSettings(djId, { managerToken: cfg })
    setTimeout(() => sendChatToRoom(djId, `${scoreDelta >= 0 ? '✅' : '➖'} ${m.nickname}님 ${scoreDelta >= 0 ? '+' : ''}${scoreDelta}점 (현재 ${m.score}점)`), 400)
    setTimeout(() => sendChatSplit(djId, formatManagerTokenList(cfg), 150, 600), 900)
    return
  }

  if (isTitle) {
    cfg.title = msg.slice('!제목 '.length).trim()
    store.saveSettings(djId, { managerToken: cfg })
    setTimeout(() => sendChatToRoom(djId, '✅ 제목이 변경됐어요.'), 400)
    return
  }
  if (isContent1) {
    cfg.content1 = msg.slice('!내용1 '.length).trim()
    store.saveSettings(djId, { managerToken: cfg })
    setTimeout(() => sendChatToRoom(djId, '✅ 안내문구1이 변경됐어요.'), 400)
    return
  }
  if (isContent2) {
    cfg.content2 = msg.slice('!내용2 '.length).trim()
    store.saveSettings(djId, { managerToken: cfg })
    setTimeout(() => sendChatToRoom(djId, '✅ 안내문구2가 변경됐어요.'), 400)
    return
  }
}

function getDdaySettings(djId, settings) {
  if (!settings.dday) {
    settings.dday = { cmd: '!디데이', registerMsg: '📅 디데이 등록: {content} ({date})', items: [] }
    store.saveSettings(djId, { dday: settings.dday })
  }
  if (!settings.dday.items) settings.dday.items = []
  return settings.dday
}

// DJ 입력값(2026.05.04 / 2026-05-04 / 05-04 / 05.04)을 저장용 표준 형식으로 변환.
// 연도가 있으면 "YYYY-MM-DD"(한 번뿐인 날짜), 없으면 "MM-DD"(매년 반복)로 통일한다.
function normalizeDdayDate(raw) {
  const s = String(raw || '').trim()
  const full = s.match(/^(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})$/)
  if (full) {
    const y = full[1], mo = String(full[2]).padStart(2, '0'), d = String(full[3]).padStart(2, '0')
    // 실존하는 날짜인지 확인 (예: 2026-02-30 같은 잘못된 날짜 방지)
    const check = new Date(Number(y), Number(mo) - 1, Number(d))
    if (check.getFullYear() != y || check.getMonth() != Number(mo) - 1 || check.getDate() != Number(d)) return null
    return `${y}-${mo}-${d}`
  }
  const md = s.match(/^(\d{1,2})[.\-](\d{1,2})$/)
  if (md) {
    const mo = String(md[1]).padStart(2, '0'), d = String(md[2]).padStart(2, '0')
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null
    return `${mo}-${d}`
  }
  return null
}

// 저장된 날짜(YYYY-MM-DD 또는 MM-DD)를 기준으로 오늘로부터 며칠 남았는지 계산.
// YYYY-MM-DD는 그 해 그 날짜 딱 한 번, MM-DD는 매년 반복(지났으면 내년 걸로) 계산한다.
function calcNextDdayDiff(dateStr) {
  const s = String(dateStr || '')
  const now = new Date()
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const full = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (full) {
    const target = new Date(parseInt(full[1], 10), parseInt(full[2], 10) - 1, parseInt(full[3], 10))
    return Math.round((target - today0) / 86400000)
  }

  const m = s.match(/^(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10)
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
    const m = rest.match(/^(\S+)\s+(.+)$/)
    const date = m ? normalizeDdayDate(m[1]) : null
    if (!m || !date) {
      setTimeout(() => sendChatToRoom(djId, `📅 사용법: ${cmd} [날짜] [내용]\n・매년 반복: ${cmd} 12-25 크리스마스\n・특정 날짜: ${cmd} 2026.05.04 이브날`), 400)
      return
    }
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

  const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
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
      chimeUrl: '', // 읽기 전 알림음 — 비어있으면 기본 합성음(삐 소리), 채워지면 업로드한 오디오 파일 재생
      // { '태그또는닉네임(소문자)': { voice:'브라우저/구글 음성', typecastVoiceId:'', typecastVoiceName:'' } }
      voicePresets: {},
    }
    store.saveSettings(djId, { tts: settings.tts })
  }
  if (!settings.tts.voicePresets) settings.tts.voicePresets = {}
  if (settings.tts.chimeUrl == null) settings.tts.chimeUrl = ''
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
function thisMonthKST() {
  return todayKST().slice(0, 7) // "YYYY-MM"
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
let dashRankCache = { next_choice: [], free_like: [], live_time: [], lastScanned: 0, prevRank: { next_choice: {}, free_like: {}, live_time: {} } }
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
      // 🔺🔻 변동 표시를 위해, 새로 스캔하기 직전에 지금까지의 순위를 태그별로 스냅샷해둔다.
      const prevMap = {}
      dashRankCache[type].forEach((item, i) => { const t = item && item.author && item.author.tag; if (t) prevMap[t] = i + 1 })
      if (Object.keys(prevMap).length) dashRankCache.prevRank[type] = prevMap
      dashRankCache[type] = await fetchMonthlyRank(type, accessToken)
      // 🩺 "컷" 점수 필드명이 실제로 뭔지 확실치 않아서, 스캔할 때마다 1위 항목의 원본 키/값
      // 구조를 통째로 로그에 남긴다 — 화면에 컷 숫자가 안 맞거나 "-"로 나오면 이 로그를 보고
      // 정확한 필드명을 알아내서 liveRankCutValue의 candidates 배열에 그대로 추가하면 된다.
      if (dashRankCache[type][0]) {
        console.log(`[월간DJ컷랭킹] ${type} 1위 항목 원본 구조:`, JSON.stringify(dashRankCache[type][0]).slice(0, 800))
      } else {
        console.log(`[월간DJ컷랭킹] ${type} 결과가 0건이에요 (API 응답 자체를 못 받았을 수 있어요)`)
      }
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

// 입장/좋아요/퇴장 멘트(입장 설정)에 {rank}{choice_rank}{like_rank}{time_rank}가 쓰였을 때만
// buildDashboardRankVars를 조회해서 채워준다 (안 쓰였으면 조회 자체를 건너뛰어 불필요한 연산 방지).
function applyDashboardRankVars(text, settings) {
  const s = String(text || '')
  if (!/{rank}|{choice_rank}|{like_rank}|{time_rank}/.test(s)) return s
  const rv = buildDashboardRankVars(settings)
  return s
    .replace(/{rank}/g, rv.rank)
    .replace(/{choice_rank}/g, rv.choice_rank)
    .replace(/{like_rank}/g, rv.like_rank)
    .replace(/{time_rank}/g, rv.time_rank)
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
  const liveRankTargets = []
  for (const djId of store.listDjIds()) {
    const room = getRoom(djId)
    if (!room.isConnected) continue
    const settings = store.getSettings(djId) || {}
    if (isModuleOn(settings, 'dashboard', djId)) {
      const dash = getDashboardData(djId, settings)
      if (dash.djTag) targets.push(djId)
    }
    if (isModuleOn(settings, 'liverank', djId)) {
      const tag = getLiveRankDjTag(settings)
      if (tag) liveRankTargets.push(djId)
    }
  }
  if (!targets.length && !liveRankTargets.length) return
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
  for (const djId of liveRankTargets) {
    const settings = store.getSettings(djId) || {}
    const lr = getLiveRankSettings(djId, settings)
    recordLiveRankHistory(djId, lr, getLiveRankDjTag(settings))
  }
  if (targets.length) console.log(`[대시보드랭킹] 자동 갱신 완료 (${targets.length}개 계정)`)
  if (liveRankTargets.length) console.log(`[월간DJ컷랭킹] 자동 갱신 완료 (${liveRankTargets.length}개 계정)`)
}, DASH_RANK_AUTO_REFRESH_MS)

// ══════════════════════════════════════════════════════
// 🔴 실시간 랭킹 — 스푼 초이스(next_choice) 월간 랭킹에서 등록한 고유닉의 현재 순위와,
// 바로 위/아래 등수 DJ와의 점수 차이를 보여주는 독립 모듈. 스캔할 때마다(자동 10분 주기 +
// 수동 새로고침) 순위 스냅샷을 기록해서 "순위 변화" 흐름도 같이 보여준다.
// ⚠️ "컷" 점수 필드명은 스푼 응답 원문을 직접 확인 못해서 여러 후보 필드명을 순서대로
// 시도한다 — 값이 하나도 안 잡히면 순위(신뢰도 100%)만 정상 표시되고 점수차만 "-"로 나온다.
function getLiveRankSettings(djId, settings) {
  if (!settings.liveRank) {
    settings.liveRank = { history: [], manualTag: '' }
    store.saveSettings(djId, { liveRank: settings.liveRank })
  }
  if (!Array.isArray(settings.liveRank.history)) settings.liveRank.history = []
  if (settings.liveRank.manualTag == null) settings.liveRank.manualTag = ''
  return settings.liveRank
}
// 기본은 "자동입장"에 등록해둔 고유닉을 그대로 재사용하지만, 수동으로 직접 등록해둔 고유닉이
// 있으면(예: 자동입장과 다른 계정의 랭킹을 보고 싶을 때) 그걸 우선한다.
function getLiveRankDjTag(settings) {
  if (settings.liveRank && settings.liveRank.manualTag) return String(settings.liveRank.manualTag).trim()
  if (settings.autoJoinTag) return String(settings.autoJoinTag).trim()
  if (Array.isArray(settings.autoJoinTags) && settings.autoJoinTags.length) return String(settings.autoJoinTags[0]).trim()
  return ''
}
function liveRankCutValue(item) {
  if (!item) return null
  const candidates = ['score', 'cut_score', 'next_choice_score', 'choice_score', 'total_score', 'cut', 'value', 'point', 'points']
  for (const key of candidates) {
    const v = item[key]
    if (v != null && !isNaN(Number(v))) return Number(v)
  }
  return null
}
const LIVE_RANK_CHECKPOINTS = [1, 10, 110, 410]
function liveRankBracketLabel(rank) {
  for (let i = 0; i < LIVE_RANK_CHECKPOINTS.length; i++) {
    const cur = LIVE_RANK_CHECKPOINTS[i]
    const next = LIVE_RANK_CHECKPOINTS[i + 1]
    if (rank <= cur) return `~${cur}위 구간`
    if (!next) return `${cur}위 이하 구간`
    if (rank > cur && rank <= next) return `${cur + 1}~${next}위 구간`
  }
  return ''
}
// 랭킹 API의 author 객체에서 프로필 사진 URL을 뽑아낸다. 다른 스푼 API(검색/멤버 프로필)와
// 마찬가지로 필드명이 응답마다 조금씩 다를 수 있어서 여러 후보를 순서대로 시도한다.
function liveRankPhotoUrl(item) {
  const a = item && item.author
  if (!a) return ''
  return a.profile_url || a.profileUrl || a.image_url || a.imageUrl || a.thumbnail_url || a.thumbnailUrl || a.photo_url || ''
}
function buildLiveRankSnapshot(djTag) {
  const list = dashRankCache.next_choice || []
  if (!list.length) return { success: false, error: '랭킹 데이터가 아직 없어요. 잠시 후 다시 시도해주세요.' }
  const idx = list.findIndex(x => x.author && x.author.tag === djTag)
  if (idx === -1) return { success: false, error: '이번 달 초이스 랭킹에서 등록한 고유닉을 찾지 못했어요.', total: list.length }
  const rank = idx + 1
  const item = list[idx]
  const cut = liveRankCutValue(item)
  const above = idx > 0 ? list[idx - 1] : null
  const below = idx < list.length - 1 ? list[idx + 1] : null
  const aboveCut = above ? liveRankCutValue(above) : null
  const belowCut = below ? liveRankCutValue(below) : null

  // 🏆 주요 랭킹 컷(1/10/110/410위)
  const cuts = LIVE_RANK_CHECKPOINTS.map(r => {
    const it = list[r - 1]
    return { rank: r, cut: liveRankCutValue(it), nickname: (it && it.author && it.author.nickname) || '', tag: (it && it.author && it.author.tag) || '', photo: liveRankPhotoUrl(it) }
  })
  // 나보다 순위 숫자가 큰(더 낮은) 체크포인트 대비 여유분
  const comparisons = LIVE_RANK_CHECKPOINTS
    .filter(cp => cp > rank)
    .map(cp => {
      const cpCut = (cuts.find(c => c.rank === cp) || {}).cut
      return { rank: cp, cut: cpCut, diff: (cut != null && cpCut != null) ? cut - cpCut : null }
    })
  // 내 주변 순위 (앞뒤 10명씩) — 직전 스캔 대비 순위 변동(🔺상승/🔻하락)도 같이 계산한다.
  const nearbyStart = Math.max(0, idx - 10)
  const nearbyEnd = Math.min(list.length, idx + 11)
  const prevRankMap = dashRankCache.prevRank.next_choice || {}
  const nearby = list.slice(nearbyStart, nearbyEnd).map((it, i) => {
    const r = nearbyStart + i + 1
    const t = (it.author && it.author.tag) || ''
    const prevR = prevRankMap[t] || null
    const change = prevR ? prevR - r : null // 양수 = 순위 상승(숫자가 작아짐), 음수 = 하락
    return { rank: r, nickname: (it.author && it.author.nickname) || '', tag: t, cut: liveRankCutValue(it), photo: liveRankPhotoUrl(it), isMe: r === rank, change }
  })

  return {
    success: true,
    rank, cut, nickname: (item.author && item.author.nickname) || '', tag: djTag, total: list.length,
    photo: liveRankPhotoUrl(item),
    bracketLabel: liveRankBracketLabel(rank),
    above: above ? { rank: rank - 1, nickname: (above.author && above.author.nickname) || '', tag: (above.author && above.author.tag) || '', cut: aboveCut, photo: liveRankPhotoUrl(above), diff: (cut != null && aboveCut != null) ? aboveCut - cut : null } : null,
    below: below ? { rank: rank + 1, nickname: (below.author && below.author.nickname) || '', tag: (below.author && below.author.tag) || '', cut: belowCut, photo: liveRankPhotoUrl(below), diff: (cut != null && belowCut != null) ? cut - belowCut : null } : null,
    cuts, comparisons, nearby,
  }
}
// 매 스캔 직후 호출 — 순위 스냅샷을 히스토리에 남긴다 (최근 50개까지만 보관)
function recordLiveRankHistory(djId, lr, djTag) {
  if (!djTag) return
  const snap = buildLiveRankSnapshot(djTag)
  if (!snap.success) return
  lr.history.push({ ts: Date.now(), rank: snap.rank, cut: snap.cut })
  if (lr.history.length > 50) lr.history = lr.history.slice(-50)
  store.saveSettings(djId, { liveRank: lr })
}

// 선물을 받으면 오늘 날짜의 스푼 로그에 유저별로 누적 기록한다.
function recordDashboardSpoon(djId, settings, nickname, tag, amount, comboCount) {
  if (!isModuleOn(settings, 'dashboard', djId)) return
  // 대시보드는 통계용이라 굳이 고유닉 조회를 기다릴 필요 없이, 기본은 닉네임을 키로 바로 기록한다.
  // (닉네임이 없는 예외적인 경우에만 고유닉으로 대체)
  const key = nickname ? String(nickname).trim() : (tag ? String(tag).trim().toLowerCase() : null)
  if (!key) return
  const dash = getDashboardData(djId, settings)
  const today = todayKST()
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
  // 대시보드는 통계용이라 기본은 닉네임을 키로 바로 기록한다 (닉네임 없는 예외적인 경우만 고유닉으로 대체).
  const key = nickname ? String(nickname).trim() : (tag ? String(tag).trim().toLowerCase() : null)
  if (!key) return
  const dash = getDashboardData(djId, settings)
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
      cmdGive: '!룰렛지급',   // 🆕 번호가 뒤에 바로 붙는 접두어 방식 (예: !룰렛지급1) — "!룰렛N" 뽑기 명령어랑 같은 스타일
      cmdSync: '!쿠폰동기화', // 마찬가지로 접두어로 쓴다 (예: !쿠폰동기화1)
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
  const givePrefix = cfg.cmdGive || '!룰렛지급'
  const syncPrefix = cfg.cmdSync || '!쿠폰동기화'

  if (first === cmdCoupon) {
    const act = getActivitySettings(djId, settings)
    const key = findActUserKey(act, author)
    const lotto = key ? (act.users[key].lotto || 0) : 0
    const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
    const authorTag = await getCachedUserTag(room, liveId, authorId, accessToken)
    if (authorTag) rememberTagNickname(room, authorTag, author)
    const rec = getHistoryRecByIdentity(settings, authorTag, author)
    if (!rec) { setTimeout(() => sendChatToRoom(djId, TAG_RETRY_MSG), 400); return }
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

  // 🎯 !룰렛지급1, !룰렛지급2 ... 처럼 룰렛 번호가 명령어 뒤에 바로 붙는 방식 (기존 "!룰렛N" 뽑기
  // 명령어랑 같은 스타일). 대상 자리에 "전체"를 쓰면 지금까지 등록된 유저 전원에게 한 번에 지급/동기화된다.
  let mode = null, rouletteNo = null
  if (first.startsWith(givePrefix) && /^\d+$/.test(first.slice(givePrefix.length))) {
    mode = 'give'; rouletteNo = parseInt(first.slice(givePrefix.length), 10)
  } else if (first.startsWith(syncPrefix) && /^\d+$/.test(first.slice(syncPrefix.length))) {
    mode = 'sync'; rouletteNo = parseInt(first.slice(syncPrefix.length), 10)
  }
  if (mode) {
    const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId
    const act = getActivitySettings(djId, settings)
    const grantList = (act.grantNicknames || []).map(n => String(n || '').trim().toLowerCase())
    const canManage = isDj || grantList.includes(String(author || '').trim().toLowerCase())
    if (!canManage) { setTimeout(() => sendChatToRoom(djId, '⚠️ 매니저 이상만 사용 가능합니다.'), 400); return }

    const targetInput = parts[1]
    const countVal = parseInt(parts[2], 10)
    if (!targetInput || isNaN(countVal)) {
      setTimeout(() => sendChatToRoom(djId, `사용법: ${first} 고유닉 3  (전체에게 주려면: ${first} 전체 3)`), 400)
      return
    }

    // 🌐 "전체" — 지금 이 방에 실시간으로 접속 중인 사람 전원에게 한 번에 지급/동기화
    // (예전 기록이 있는지랑 상관없이, 지금 방에 있는 사람만 대상)
    if (targetInput === '전체') {
      if (!room._lastLiveMembers || !room._lastLiveMembers.size) {
        setTimeout(() => sendChatToRoom(djId, '⚠️ 지금 방에 접속 중인 사람이 없어요.'), 400)
        return
      }
      let count = 0
      for (const info of room._lastLiveMembers.values()) {
        if (!info.tag) continue // 고유닉을 아직 못 알아낸 사람은 건너뜀 (기록 자체를 못 만듦)
        const rec = getHistoryRecByIdentity(settings, info.tag, info.nickname)
        if (!rec) continue
        if (!rec.coupons) rec.coupons = {}
        if (mode === 'give') rec.coupons[rouletteNo] = Number(rec.coupons[rouletteNo] || 0) + countVal
        else rec.coupons[rouletteNo] = Math.max(0, countVal)
        count++
      }
      if (!count) { setTimeout(() => sendChatToRoom(djId, '⚠️ 지급할 대상을 찾지 못했어요.'), 400); return }
      store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
      broadcast({ type: 'roulette', djId, tag: 'all' })
      const label = mode === 'give' ? '지급' : '동기화'
      setTimeout(() => sendChatToRoom(djId, `✅ 지금 접속 중인 ${count}명에게 룰렛${rouletteNo} 일괄 ${label} 완료! (${countVal}장)`), 400)
      return
    }

    // 이미 그 고유닉으로 기록이 있으면(예: 지금은 방송에 없어도 예전에 확인된 사람) 그대로 처리한다.
    // 처음 보는 입력일 때만, 오타로 조용히 없는 유저가 만들어지지 않게 지금 방에 실제로 있는지 확인한다.
    const cleanTargetInput = String(targetInput || '').replace('@', '').trim().toLowerCase()
    let targetTag = null
    let targetName = targetInput
    if (settings.rouletteHistory && settings.rouletteHistory[cleanTargetInput]) {
      targetTag = cleanTargetInput
      targetName = settings.rouletteHistory[cleanTargetInput].nickname || targetInput
    } else {
      const found = await findLiveMemberByNickOrTag(djId, liveId, targetInput)
      if (!found) {
        setTimeout(() => sendChatToRoom(djId, `⚠️ '${targetInput}' 님을 지금 방송에서 찾을 수 없어요.`), 400)
        return
      }
      targetTag = found.tag
      targetName = found.nickname || found.tag
    }
    const rec = getHistoryRecByIdentity(settings, targetTag, targetName)
    if (!rec) { setTimeout(() => sendChatToRoom(djId, TAG_RETRY_MSG), 400); return }
    if (mode === 'give') {
      rec.coupons[rouletteNo] = Number(rec.coupons[rouletteNo] || 0) + countVal
    } else {
      rec.coupons[rouletteNo] = Math.max(0, countVal)
    }
    store.saveSettings(djId, { rouletteHistory: settings.rouletteHistory })
    broadcast({ type: 'roulette', djId, tag: targetTag || targetName })
    const label = mode === 'give' ? '지급' : '동기화'
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

  const accessToken = tokenManager.getAccessToken(tokenDjIdFor(djId))
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
// 🌾 농장 키우기 — 방치형 미니게임. 씨앗을 심어두면 시간이 지나서 자동으로 자라고,
// 나중에 채팅으로 수확만 하면 되는, 낚시 게임과 결이 비슷한 경제 게임이다. 실시간 조작이
// 전혀 필요 없어서(그냥 시간 지나면 상태만 바뀜) 서버 부담이 제일 적다.
// ══════════════════════════════════════════════════════

const FARM_DEFAULT_CROPS = '상추,5,50,20,3,6\n당근,15,150,60,2,5\n감자,30,300,140,2,4\n토마토,60,600,320,1,3\n수박,180,1500,1000,1,2'
// 형식: 이름,성장시간(분),씨앗가격,판매가(개당),최소수확개수,최대수확개수

function getFarmSettings(djId, settings) {
  if (!settings.farm) {
    settings.farm = {
      config: {
        enabled: true,
        plotCount: 4,
        startMoney: 1000,
        cropList: FARM_DEFAULT_CROPS,
        cmdFarm: '!농장', cmdShop: '!작물상점', cmdPlant: '!심기', cmdHarvest: '!수확', cmdHelp: '!농장도움말',
      },
      users: {}, // { tag: {...} }
    }
    store.saveSettings(djId, { farm: settings.farm })
  }
  if (!settings.farm.config) settings.farm.config = {}
  if (!settings.farm.users) settings.farm.users = {}
  return settings.farm
}

function _farmSplitLines(text) {
  if (!text || typeof text !== 'string') return []
  return text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
}
function _farmParseCrops(text) {
  return _farmSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 6 || !p[0]) return null
    return {
      name: p[0],
      growMinutes: Math.max(1, parseInt(p[1]) || 1),
      seedPrice: Math.max(0, parseInt(p[2]) || 0),
      sellPrice: Math.max(0, parseInt(p[3]) || 0),
      minYield: Math.max(1, parseInt(p[4]) || 1),
      maxYield: Math.max(1, parseInt(p[5]) || 1),
    }
  }).filter(Boolean)
}
function _farmNewUser(tag, nickname, startMoney) {
  return { tag, nickname: nickname || tag, money: startMoney || 0, plots: [], totalHarvests: 0 }
}
function getFarmUser(farm, tag, nickname) {
  if (!tag) return null
  const plotCount = Math.max(1, farm.config.plotCount || 4)
  if (!farm.users[tag]) {
    const user = _farmNewUser(tag, nickname, farm.config.startMoney)
    user.plots = Array.from({ length: plotCount }, () => null)
    farm.users[tag] = user
  } else {
    const user = farm.users[tag]
    if (nickname && user.nickname !== nickname) user.nickname = nickname
    // 관리자가 나중에 칸 수를 늘리면 기존 유저 칸도 자동으로 늘어난다 (줄이는 건 심어놓은 게
    // 있을 수 있어서 안 건드림 — 넘치는 칸은 그냥 화면에 계속 보여준다)
    while (user.plots.length < plotCount) user.plots.push(null)
  }
  return farm.users[tag]
}
function saveFarmUser(djId, farm) {
  store.saveSettings(djId, { farm })
}
function farmReply(djId, msg) {
  sendChatSplit(djId, msg, 150, 500)
}
function farmFmtRemain(ms) {
  const totalSec = Math.ceil(ms / 1000)
  const m = Math.floor(totalSec / 60), s = totalSec % 60
  return m > 0 ? `${m}분 ${s}초` : `${s}초`
}
function farmPlotStatus(plot, crops, now) {
  if (!plot) return { state: 'empty' }
  const crop = crops.find(c => c.name === plot.crop)
  if (!crop) return { state: 'empty' } // 관리자가 작물을 목록에서 지워버린 경우 — 심어놓은 게 있어도 알 수 없으니 빈 칸 취급
  const elapsed = now - new Date(plot.plantedAt).getTime()
  const remain = crop.growMinutes * 60000 - elapsed
  if (remain <= 0) return { state: 'ready', crop }
  return { state: 'growing', crop, remainMs: remain }
}

async function handleFarmCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  const farm = getFarmSettings(djId, settings)
  if (!farm.config.enabled) return
  if (!isModuleOn(settings, 'farm', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const parts = msg.split(/\s+/)
  const cmd = parts[0]
  const cfg = farm.config
  const CMDS = [cfg.cmdFarm, cfg.cmdShop, cfg.cmdPlant, cfg.cmdHarvest, cfg.cmdHelp]
  if (!CMDS.includes(cmd)) return

  if (cmd === cfg.cmdHelp) {
    farmReply(djId, `🌾 농장 명령어\n${cfg.cmdFarm} — 내 농장 상태 보기\n${cfg.cmdShop} — 작물 목록/가격 보기\n${cfg.cmdPlant} [작물] [칸번호] — 씨앗 심기\n${cfg.cmdHarvest} [칸번호(생략시 전체)] — 수확하기`)
    return
  }
  if (!actTag) { farmReply(djId, '❌ 고유닉이 있어야 농장을 이용할 수 있어요.'); return }

  const crops = _farmParseCrops(cfg.cropList)
  const user = getFarmUser(farm, actTag, author)

  if (cmd === cfg.cmdShop) {
    if (!crops.length) { farmReply(djId, '❌ 등록된 작물이 없어요.'); return }
    let out = '🌱 작물 상점\n'
    crops.forEach(c => { out += `• ${c.name} — 씨앗 ₩${c.seedPrice.toLocaleString()} / 성장 ${c.growMinutes}분 / 수확당 ₩${c.sellPrice.toLocaleString()} (${c.minYield}~${c.maxYield}개)\n` })
    farmReply(djId, out.trim())
    return
  }

  if (cmd === cfg.cmdFarm) {
    const now = Date.now()
    let out = `👤 ${author}님의 농장\n💰 보유금: ₩${user.money.toLocaleString()}\n`
    user.plots.forEach((plot, i) => {
      const st = farmPlotStatus(plot, crops, now)
      if (st.state === 'empty') out += `${i + 1}번 칸: 비어있음\n`
      else if (st.state === 'growing') out += `${i + 1}번 칸: ${st.crop.name} 재배중 (${farmFmtRemain(st.remainMs)} 남음)\n`
      else out += `${i + 1}번 칸: ${st.crop.name} 수확 가능! 🌾\n`
    })
    saveFarmUser(djId, farm)
    farmReply(djId, out.trim())
    return
  }

  if (cmd === cfg.cmdPlant) {
    const cropName = parts[1]
    const plotNum = parseInt(parts[2])
    if (!cropName || !plotNum) { farmReply(djId, `사용법: ${cfg.cmdPlant} [작물이름] [칸번호]`); return }
    const crop = crops.find(c => c.name === cropName)
    if (!crop) { farmReply(djId, `❌ '${cropName}' 작물을 찾을 수 없어요. ${cfg.cmdShop}으로 확인해보세요.`); return }
    const idx = plotNum - 1
    if (idx < 0 || idx >= user.plots.length) { farmReply(djId, `❌ 칸 번호는 1~${user.plots.length} 사이여야 해요.`); return }
    const st = farmPlotStatus(user.plots[idx], crops, Date.now())
    if (st.state !== 'empty') { farmReply(djId, `❌ ${plotNum}번 칸엔 이미 뭔가 심어져 있어요.`); return }
    if (user.money < crop.seedPrice) { farmReply(djId, `❌ 씨앗값이 부족해요. (필요 ₩${crop.seedPrice.toLocaleString()} / 보유 ₩${user.money.toLocaleString()})`); return }
    user.money -= crop.seedPrice
    user.plots[idx] = { crop: crop.name, plantedAt: new Date().toISOString() }
    saveFarmUser(djId, farm)
    farmReply(djId, `🌱 ${plotNum}번 칸에 ${crop.name}을(를) 심었어요! ${crop.growMinutes}분 후에 수확할 수 있어요.`)
    return
  }

  if (cmd === cfg.cmdHarvest) {
    const now = Date.now()
    const targetIdx = parts[1] ? parseInt(parts[1]) - 1 : null
    if (targetIdx != null && (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= user.plots.length)) {
      farmReply(djId, `❌ 칸 번호는 1~${user.plots.length} 사이여야 해요.`); return
    }
    const indexes = targetIdx != null ? [targetIdx] : user.plots.map((_, i) => i)
    let totalMoney = 0
    const harvested = []
    for (const i of indexes) {
      const st = farmPlotStatus(user.plots[i], crops, now)
      if (st.state !== 'ready') continue
      const yieldCount = Math.floor(Math.random() * (st.crop.maxYield - st.crop.minYield + 1)) + st.crop.minYield
      const earned = yieldCount * st.crop.sellPrice
      totalMoney += earned
      user.money += earned
      user.totalHarvests = (user.totalHarvests || 0) + 1
      user.plots[i] = null
      harvested.push(`${st.crop.name} ${yieldCount}개 (₩${earned.toLocaleString()})`)
    }
    if (!harvested.length) { farmReply(djId, targetIdx != null ? '❌ 아직 수확할 수 없어요.' : '❌ 지금 수확할 수 있는 칸이 없어요.'); return }
    saveFarmUser(djId, farm)
    farmReply(djId, `🌾 수확 완료!\n${harvested.join('\n')}\n💰 총 ₩${totalMoney.toLocaleString()} 획득 (잔액: ₩${user.money.toLocaleString()})`)
    return
  }
}


// ══════════════════════════════════════════════════════
// 🗼 무한의 탑 — 진짜 방치형 등반 게임. 층마다 클리어에 걸리는 시간이 정해져 있고, 채팅을 안 쳐도
// 그 시간이 지나면 서버가 알아서 그 층을 클리어된 걸로 계산해둔다. !탑을 치는 순간 "마지막으로
// 확인한 뒤로 흐른 시간"을 몰아서 계산해 그동안 오른 층수를 한 번에 반영한다(며칠 만에 들어와도
// 문제없음). 대신 층마다 필요한 전투력이 있어서, 전투력이 부족한 층에서는 멈추고 골드 모아
// !탑강화로 뚫어야 한다 — 멈춰있는 동안 흐른 시간은 사라지지 않고 그대로 쌓여있다가, 강화해서
// 전투력이 그 층을 넘는 순간 곧바로 다음 층 진행에 반영된다.
// 층을 클리어할 때마다 확률로 장비(무기/방어구/장신구)가 드롭되고, 장착하면 기본 전투력에
// 보너스가 더해진다 — 그래서 실제 전투력은 항상 "기본 전투력 + 장착 장비 보너스 합"으로 계산한다.
// ══════════════════════════════════════════════════════

const TOWER_DEFAULT_ITEMS = '낡은 검,weapon,5,common,50\n강철검,weapon,15,rare,15\n미스릴검,weapon,40,epic,4\n전설의 검,weapon,100,legendary,1\n가죽갑옷,armor,5,common,50\n사슬갑옷,armor,15,rare,15\n판금갑옷,armor,40,epic,4\n용비늘갑옷,armor,100,legendary,1\n낡은 반지,accessory,5,common,50\n마력 반지,accessory,15,rare,15\n현자의 목걸이,accessory,40,epic,4\n왕의 인장,accessory,100,legendary,1'
// 형식: 이름,부위(weapon/armor/accessory),전투력보너스,등급,드롭가중치
const TOWER_RARITY_EMOJI = { common: '⚪', rare: '🔵', epic: '🟣', legendary: '🟡' }
const TOWER_SLOT_LABEL = { weapon: '무기', armor: '방어구', accessory: '장신구' }

function getTowerSettings(djId, settings) {
  if (!settings.tower) {
    settings.tower = {
      config: {
        enabled: true,
        baseSeconds: 60,          // 1층 클리어 기본 소요시간(초)
        perFloorSeconds: 10,      // 층마다 추가되는 소요시간(초) — 올라갈수록 오래 걸림
        startPower: 10,
        powerPerFloor: 8,         // 그 층 돌파에 필요한 전투력 = floor * powerPerFloor
        goldPerFloor: 50,         // 층 클리어 보상 골드 = floor * goldPerFloor
        upgradeBaseCost: 100,
        upgradeCostGrowth: 1.15,  // 강화할수록 비용이 이 배율만큼 증가
        upgradePowerGain: 5,
        maxCatchUpFloors: 500,    // 한 번에 몰아서 계산할 최대 층 수 (안전장치)
        itemDropChance: 20,       // 층 클리어 시 아이템이 나올 확률(%)
        itemList: TOWER_DEFAULT_ITEMS,
        cmdTower: '!탑', cmdUpgrade: '!탑강화', cmdHelp: '!탑도움말',
        cmdInfo: '!탑정보', cmdItems: '!탑아이템', cmdEquip: '!탑장착',
      },
      users: {}, // { tag: {...} }
    }
    store.saveSettings(djId, { tower: settings.tower })
  }
  if (!settings.tower.config) settings.tower.config = {}
  if (!settings.tower.users) settings.tower.users = {}
  return settings.tower
}
function _towerSplitLines(text) {
  if (!text || typeof text !== 'string') return []
  return text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
}
function _towerParseItems(text) {
  return _towerSplitLines(text).map(line => {
    const p = line.split(',').map(s => s.trim())
    if (p.length < 5 || !p[0]) return null
    const slot = ['weapon', 'armor', 'accessory'].includes(p[1]) ? p[1] : 'weapon'
    return { name: p[0], slot, powerBonus: Math.max(0, parseInt(p[2]) || 0), rarity: p[3] || 'common', weight: Math.max(0, parseFloat(p[4]) || 0) }
  }).filter(Boolean)
}
function _towerNewUser(tag, nickname, startPower) {
  return {
    tag, nickname: nickname || tag, floor: 1, power: startPower || 10, gold: 0, upgradeCount: 0,
    lastCheckAt: new Date().toISOString(), totalGoldEarned: 0, totalItemsFound: 0,
    items: [], equipped: { weapon: null, armor: null, accessory: null },
  }
}
function getTowerUser(tower, tag, nickname) {
  if (!tag) return null
  if (!tower.users[tag]) {
    tower.users[tag] = _towerNewUser(tag, nickname, tower.config.startPower)
  } else {
    const user = tower.users[tag]
    if (nickname && user.nickname !== nickname) user.nickname = nickname
    // 이 기능들이 추가되기 전부터 있던 유저는 필드가 없을 수 있어서 처음 불러올 때 채워준다
    if (!Array.isArray(user.items)) user.items = []
    if (!user.equipped) user.equipped = { weapon: null, armor: null, accessory: null }
    if (user.totalGoldEarned == null) user.totalGoldEarned = user.gold || 0
    if (user.totalItemsFound == null) user.totalItemsFound = user.items.length
  }
  return tower.users[tag]
}
function saveTowerUser(djId, tower) {
  store.saveSettings(djId, { tower })
}
function towerFmtRemain(sec) {
  sec = Math.max(0, Math.ceil(sec))
  const m = Math.floor(sec / 60), s = sec % 60
  return m > 0 ? `${m}분 ${s}초` : `${s}초`
}
function towerUpgradeCost(cfg, upgradeCount) {
  return Math.round((cfg.upgradeBaseCost || 100) * Math.pow(cfg.upgradeCostGrowth || 1.15, upgradeCount || 0))
}
function towerEquipmentBonus(user) {
  let bonus = 0
  for (const slot of ['weapon', 'armor', 'accessory']) {
    const itemId = user.equipped && user.equipped[slot]
    if (!itemId) continue
    const item = (user.items || []).find(i => i.id === itemId)
    if (item) bonus += item.powerBonus
  }
  return bonus
}
function towerEffectivePower(user) {
  return user.power + towerEquipmentBonus(user)
}
function towerRollItemDrop(cfg) {
  const chance = cfg.itemDropChance != null ? cfg.itemDropChance : 20
  if (Math.random() * 100 >= chance) return null
  const items = _towerParseItems(cfg.itemList)
  if (!items.length) return null
  const total = items.reduce((s, i) => s + i.weight, 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const it of items) { roll -= it.weight; if (roll <= 0) return it }
  return items[items.length - 1]
}
// 🧮 마지막 확인 이후 흐른 시간을 몰아서 계산 — 클리어할 수 있는 층은 전부 클리어 처리하고,
// 전투력(장비 보너스 포함)이 부족한 층에서 막히면 그 자리에서 멈춘다(시간은 안 버리고 그대로 들고 있음).
// 층을 클리어할 때마다 확률로 장비도 같이 드롭된다.
function towerResolveProgress(user, cfg, now) {
  const maxFloors = cfg.maxCatchUpFloors || 500
  let cursor = new Date(user.lastCheckAt).getTime()
  let floorsClimbed = 0, goldEarned = 0, stuck = false
  const itemsDropped = []
  for (let i = 0; i < maxFloors; i++) {
    const clearMs = ((cfg.baseSeconds || 60) + (user.floor - 1) * (cfg.perFloorSeconds || 10)) * 1000
    if (now - cursor < clearMs) break // 아직 이 층을 클리어할 만큼 시간이 안 지남
    const requiredPower = user.floor * (cfg.powerPerFloor || 8)
    if (towerEffectivePower(user) < requiredPower) { stuck = true; break } // 전투력 부족 — 시간은 그대로 쌓아둔 채 멈춤
    const gold = user.floor * (cfg.goldPerFloor || 50)
    user.gold += gold
    user.totalGoldEarned = (user.totalGoldEarned || 0) + gold
    goldEarned += gold
    user.floor += 1
    cursor += clearMs // 남는 시간은 다음 층으로 이월
    floorsClimbed++
    const dropped = towerRollItemDrop(cfg)
    if (dropped) {
      const item = {
        id: 'it_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: dropped.name, slot: dropped.slot, powerBonus: dropped.powerBonus, rarity: dropped.rarity,
        obtainedAt: new Date().toISOString(),
      }
      user.items.push(item)
      user.totalItemsFound = (user.totalItemsFound || 0) + 1
      itemsDropped.push(item)
    }
  }
  if (!stuck) user.lastCheckAt = new Date(cursor).toISOString() // 막히지 않았으면 계산이 끝난 지점까지 시계를 당겨둔다
  return { floorsClimbed, goldEarned, stuck, itemsDropped }
}

async function handleTowerCommand(djId, room, settings, author, authorId, liveId, text, actTag) {
  const tower = getTowerSettings(djId, settings)
  if (!tower.config.enabled) return
  if (!isModuleOn(settings, 'tower', djId)) return
  const msg = String(text || '').trim()
  if (!msg.startsWith('!')) return
  const parts = msg.split(/\s+/)
  const cmd = parts[0]
  const cfg = tower.config
  const CMDS = [cfg.cmdTower, cfg.cmdUpgrade, cfg.cmdHelp, cfg.cmdInfo, cfg.cmdItems, cfg.cmdEquip]
  if (!CMDS.includes(cmd)) return

  if (cmd === cfg.cmdHelp) {
    farmReply(djId, `🗼 무한의 탑 명령어\n${cfg.cmdTower} — 진행상황 확인 (안 쳐도 시간 지나면 알아서 올라가 있어요)\n${cfg.cmdUpgrade} — 골드로 전투력 강화\n${cfg.cmdInfo} — 캐릭터 정보(누적 기록 + 장착 장비)\n${cfg.cmdItems} — 보유 아이템 목록\n${cfg.cmdEquip} [번호] — 아이템 장착`)
    return
  }
  if (!actTag) { farmReply(djId, '❌ 고유닉이 있어야 탑에 도전할 수 있어요.'); return }

  const user = getTowerUser(tower, actTag, author)
  const now = Date.now()
  const result = towerResolveProgress(user, cfg, now)

  if (cmd === cfg.cmdTower) {
    const totalPower = towerEffectivePower(user)
    let out = `🗼 ${author}님의 탑 진행상황\n📍 현재 ${user.floor}층 · ⚔️ 전투력 ${totalPower} · 💰 골드 ${user.gold.toLocaleString()}\n`
    if (result.floorsClimbed > 0) {
      out += `\n✨ 그동안 ${result.floorsClimbed}층 올랐어요! (+₩${result.goldEarned.toLocaleString()})\n`
      if (result.itemsDropped.length) out += `🎁 아이템 획득: ${result.itemsDropped.map(it => `${TOWER_RARITY_EMOJI[it.rarity] || ''}${it.name}`).join(', ')}\n`
    }
    if (result.stuck) {
      const requiredPower = user.floor * (cfg.powerPerFloor || 8)
      out += `\n🚧 ${user.floor}층에서 막혔어요 (필요 전투력 ${requiredPower} / 보유 ${totalPower})\n${cfg.cmdUpgrade}로 강화하거나 ${cfg.cmdItems}로 장비를 확인해보세요.`
    } else {
      const clearSec = ((cfg.baseSeconds || 60) + (user.floor - 1) * (cfg.perFloorSeconds || 10))
      const elapsedSec = (now - new Date(user.lastCheckAt).getTime()) / 1000
      out += `\n⏳ 다음 층까지 ${towerFmtRemain(clearSec - elapsedSec)} 남음 (자동 진행 중)`
    }
    saveTowerUser(djId, tower)
    farmReply(djId, out.trim())
    return
  }

  if (cmd === cfg.cmdUpgrade) {
    const cost = towerUpgradeCost(cfg, user.upgradeCount)
    if (user.gold < cost) { saveTowerUser(djId, tower); farmReply(djId, `❌ 골드가 부족해요. (필요 ₩${cost.toLocaleString()} / 보유 ₩${user.gold.toLocaleString()})`); return }
    user.gold -= cost
    user.power += (cfg.upgradePowerGain || 5)
    user.upgradeCount++
    // 강화 직후 다시 한번 진행 계산 — 방금 뚫린 층이 있으면 바로 반영해서 보여준다
    const after = towerResolveProgress(user, cfg, now)
    saveTowerUser(djId, tower)
    let out = `⚔️ 강화 완료! 전투력 ${towerEffectivePower(user)} (₩${cost.toLocaleString()} 사용)`
    if (after.floorsClimbed > 0) {
      out += `\n✨ 막혔던 층이 뚫려서 ${after.floorsClimbed}층 더 올랐어요! (+₩${after.goldEarned.toLocaleString()})`
      if (after.itemsDropped.length) out += `\n🎁 아이템 획득: ${after.itemsDropped.map(it => `${TOWER_RARITY_EMOJI[it.rarity] || ''}${it.name}`).join(', ')}`
    }
    farmReply(djId, out)
    return
  }

  if (cmd === cfg.cmdInfo) {
    const bonus = towerEquipmentBonus(user)
    const total = user.power + bonus
    let out = `📋 ${author}님의 탑 캐릭터 정보\n📍 현재 층: ${user.floor}층\n⚔️ 전투력: ${total} (기본 ${user.power} + 장비 ${bonus})\n`
    out += `💰 누적 획득 골드: ₩${(user.totalGoldEarned || 0).toLocaleString()}\n🛠️ 강화 횟수: ${user.upgradeCount || 0}회\n`
    out += `🎒 보유 아이템: ${(user.items || []).length}개 (누적 발견 ${user.totalItemsFound || 0}개)\n\n장착 중인 장비:\n`
    for (const slot of ['weapon', 'armor', 'accessory']) {
      const itemId = user.equipped[slot]
      const item = itemId ? (user.items || []).find(i => i.id === itemId) : null
      out += `${TOWER_SLOT_LABEL[slot]}: ${item ? `${TOWER_RARITY_EMOJI[item.rarity] || ''}${item.name} (+${item.powerBonus})` : '없음'}\n`
    }
    saveTowerUser(djId, tower)
    farmReply(djId, out.trim())
    return
  }

  if (cmd === cfg.cmdItems) {
    if (!(user.items || []).length) { saveTowerUser(djId, tower); farmReply(djId, `🎒 보유한 아이템이 없어요. 층을 클리어하면 확률로 나와요.`); return }
    let out = `🎒 ${author}님의 아이템 (${cfg.cmdEquip} [번호]로 장착)\n`
    user.items.forEach((it, i) => {
      const equipped = user.equipped[it.slot] === it.id
      out += `${i + 1}. ${TOWER_RARITY_EMOJI[it.rarity] || ''}${it.name} [${TOWER_SLOT_LABEL[it.slot]}] +${it.powerBonus}${equipped ? ' (장착중)' : ''}\n`
    })
    saveTowerUser(djId, tower)
    farmReply(djId, out.trim())
    return
  }

  if (cmd === cfg.cmdEquip) {
    const num = parseInt(parts[1])
    if (!num || num < 1 || num > (user.items || []).length) { saveTowerUser(djId, tower); farmReply(djId, `사용법: ${cfg.cmdEquip} [번호] (${cfg.cmdItems}으로 번호 확인)`); return }
    const item = user.items[num - 1]
    user.equipped[item.slot] = item.id
    saveTowerUser(djId, tower)
    farmReply(djId, `⚔️ ${TOWER_RARITY_EMOJI[item.rarity] || ''}${item.name} 장착했어요! (${TOWER_SLOT_LABEL[item.slot]}, +${item.powerBonus})`)
    return
  }
}


// ══════════════════════════════════════════════════════
// 🎁 뽑기판 — 하트/스푼/채팅/퀴즈로 포인트를 모아 "뽑기권"을 얻고,
// 뽑기판의 번호를 골라 상품을 뽑는 미니게임. 원래 에디봇 데스크탑(Electron)의
// 외부 모듈로 만들어졌던 걸 그대로 웹 버전으로 이식했다.
// ══════════════════════════════════════════════════════

const PB_NUMBER_EMOJIS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']
function pbToEmojiNumber(num) {
  return String(num).padStart(2, '0').split('').map(n => PB_NUMBER_EMOJIS[n] || n).join('')
}

function pbDefaultConfig() {
  return {
    authenticated: true,
    tableSize: 60,
    boardPageSize: 60,
    placementMode: 'mixed', // 'mixed'(고정+자동) | 'fixedOnly'(고정 번호만)
    heartNeed: 50, giftNeed: 1000, chatNeed: 900, quizNeed: 100,
    giveHeart: 1, giveGiftRate: 1, giveChat: 1, giveHeartPresent: 10,
    gameEnabled: true, gameWinRate: 33,
    quizEnabled: true, quizIntervalMin: 5, quizTimeoutSec: 6, quizReward: 50,
    emptyText: '꽝', winPrefix: '🎉', losePrefix: '👁️👅👁️',
    cmdBoard: '!뽑기판', cmdPick: '!뽑기', cmdGive: '!뽑기지급', cmdRemove: '!뽑기제거', cmdTransfer: '!뽑기양도', cmdReset: '!뽑기정보',
  }
}
function pbCreateBoard(size) { return Array.from({ length: size }, (_, i) => i + 1) }
function pbRand(max, min = 0) { return Math.floor(Math.random() * max) + min }

function pbNormalizeItems(items) {
  const result = []
  for (const raw of Array.isArray(items) ? items : []) {
    const name = String(raw.name || '').trim()
    if (!name) continue
    const count = Math.max(1, Number(raw.count || 1))
    const fixedNumbers = Array.isArray(raw.fixedNumbers)
      ? raw.fixedNumbers.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0)
      : String(raw.fixedNumbers || '').split(',').map(v => Number(String(v).trim())).filter(v => Number.isInteger(v) && v > 0)
    result.push({
      id: raw.id || ('item_' + Date.now() + '_' + Math.random().toString(16).slice(2)),
      name,
      description: String(raw.description || ''),
      count,
      fixedNumbers,
      enabled: raw.enabled !== false,
      assignedNumbers: [],
    })
  }
  return result
}
function pbNormalizeQuiz(list) {
  return (Array.isArray(list) ? list : [])
    .map(q => ({ question: String(q.question || '').trim(), answer: String(q.answer || '').trim() }))
    .filter(q => q.question && q.answer)
}

// 고정 번호를 먼저 배치하고, "고정+자동" 모드면 남은 수량을 빈 칸에 랜덤 배치한다.
function pbRecalcBoard(pb) {
  const tableSize = Math.max(1, Number(pb.config.tableSize) || 60)
  pb.board = pbCreateBoard(tableSize)
  const used = new Set()
  const available = pbCreateBoard(tableSize)
  pb.items = pbNormalizeItems(pb.items)

  for (const item of pb.items) {
    if (!item.enabled) continue
    const fixed = item.fixedNumbers.filter(n => n >= 1 && n <= tableSize).filter(n => !used.has(n))
    const limit = Math.min(item.count, fixed.length)
    for (let i = 0; i < limit; i++) {
      used.add(fixed[i]); item.assignedNumbers.push(fixed[i])
      const idx = available.indexOf(fixed[i]); if (idx >= 0) available.splice(idx, 1)
    }
  }
  if (pb.config.placementMode !== 'fixedOnly') {
    for (const item of pb.items) {
      if (!item.enabled) continue
      while (item.assignedNumbers.length < item.count 