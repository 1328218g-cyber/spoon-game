// server/r2Backup.js
// Cloudflare R2로 "전체" 데이터를 백업한다.
//
// 기존 Base44 자동백업(index.js의 backupToBase44)은 룰렛/애청지수/반복문구/단축명령어 등
// 5개 필드만 뽑아서(extractBackupSubset) 보내는 "축소 백업"이었다. 그건 그대로 두고,
// 여기서는 djs.json 전체(모든 DJ 계정, 모든 설정, 비밀번호 해시 포함)와
// globalMonsterDex.json(몬스터 잡기 전역 데이터), 그리고 sounds 볼륨(입장음 등 음원 파일)까지
// 통째로 R2에 백업해서, Railway Volume이 통째로 날아가는 최악의 경우에도 완전 복구가 가능하게 한다.
//
// R2는 S3 호환 API라 aws-sdk(v3)의 S3Client를 그대로 쓴다.
// 🔮 사주팔자 모듈과 같은 패턴 — 아직 npm install 전이어도 서버 전체가 죽지 않도록
// require를 try/catch로 감싸서, 패키지가 없으면 이 모듈 전체가 조용히 비활성화되게 한다.
let S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand
try {
  ; ({ S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3'))
} catch (e) {
  console.log('[R2 백업] @aws-sdk/client-s3 패키지가 설치되지 않았어요. "npm install @aws-sdk/client-s3 --save" 실행 후 다시 배포해주세요. 그 전까지 R2 백업 기능은 자동으로 비활성화됩니다.')
}

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || ''
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || ''
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || ''
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '')

// 스냅샷 보관 기간 — 이 기간보다 오래된 djs/globalMonsterDex 스냅샷은 cleanupOldSnapshots()가 지운다.
// 환경변수 R2_BACKUP_RETENTION_DAYS로 조절 가능 (기본 14일).
const RETENTION_DAYS = Math.max(1, Number(process.env.R2_BACKUP_RETENTION_DAYS) || 14)

const SNAPSHOT_PREFIX = 'snapshots/'
const SOUNDS_PREFIX = 'sounds/'
const DJ_BACKUP_PREFIX = 'dj-backups/' // 셀프서비스 — DJ 본인이 직접 누르는 계정 전체 백업 (dj-backups/<djId>/<stamp>.json.gz)
const DJ_BACKUP_KEEP_COUNT = 20 // DJ 한 명당 최근 20개까지만 보관, 그 이상은 새로 백업할 때 자동 삭제

const R2_ENABLED = !!(S3Client && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_ENDPOINT)

let s3 = null
if (R2_ENABLED) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  })
  console.log(`[R2 백업] 활성화됨 (버킷: ${R2_BUCKET_NAME}, 보관기간: ${RETENTION_DAYS}일)`)
} else if (S3Client) {
  console.log('[R2 백업] 환경변수가 없어서 비활성화 상태예요. Railway Variables에 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME을 등록해주세요.')
}

function gzipJson(obj) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'))
}

async function putObject(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }))
}

// R2 GetObject 응답의 Body(스트림)를 통째로 Buffer로 모은다.
async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

// gzip 압축된 JSON 오브젝트를 R2에서 받아 원래 JS 객체로 되돌린다.
async function getGzipJsonObject(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
  const buf = await streamToBuffer(res.Body)
  const json = zlib.gunzipSync(buf).toString('utf-8')
  return JSON.parse(json)
}

// 📦 djs.json 전체(축소 없이 모든 계정·모든 설정) + globalMonsterDex.json 전체 스냅샷을
// gzip 압축해서 R2에 올린다. 30분마다 호출된다.
async function backupFullSnapshotToR2(store) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const djsSnapshot = store.getRawSnapshot()
    const mcSnapshot = store.loadGlobalMonsterDex()

    await putObject(`${SNAPSHOT_PREFIX}djs-${stamp}.json.gz`, gzipJson(djsSnapshot), 'application/gzip')
    await putObject(`${SNAPSHOT_PREFIX}globalMonsterDex-${stamp}.json.gz`, gzipJson(mcSnapshot), 'application/gzip')

    console.log(`[R2 백업] 전체 스냅샷 업로드 완료 (djs-${stamp}.json.gz, 계정 ${Object.keys(djsSnapshot).length}개)`)
    return { ok: true, stamp }
  } catch (e) {
    console.log('[R2 백업] 스냅샷 업로드 실패:', e.message)
    return { ok: false, error: e.message }
  }
}

// 🔊 sounds 볼륨 동기화 — 입장음/좋아요음 등 실제 파일들.
// 매번 전체(현재 1.89GB 이상)를 통째로 다시 올리면 낭비라, R2에 이미 같은 이름·같은 크기로
// 존재하는 파일은 건너뛰고 새 파일이나 크기가 달라진(=내용이 바뀐) 파일만 업로드한다.
// 즉 스냅샷이 아니라 "현재 상태를 그대로 비추는 미러"라서, 정리(cleanup) 대상에서도 제외한다.
async function syncSoundsToR2(soundsDir) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  if (!fs.existsSync(soundsDir)) return { ok: true, uploaded: 0, skipped: 0, failed: 0 }
  let uploaded = 0, skipped = 0, failed = 0
  try {
    const files = fs.readdirSync(soundsDir).filter(f => {
      try { return fs.statSync(path.join(soundsDir, f)).isFile() } catch (e) { return false }
    })
    for (const name of files) {
      const filePath = path.join(soundsDir, name)
      const key = `${SOUNDS_PREFIX}${name}`
      let localSize
      try { localSize = fs.statSync(filePath).size } catch (e) { continue }

      let existingSize = null
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
        existingSize = head.ContentLength
      } catch (e) {
        existingSize = null // 404 등 — 아직 R2에 없는 파일
      }
      if (existingSize === localSize) { skipped++; continue }

      try {
        await putObject(key, fs.createReadStream(filePath))
        uploaded++
      } catch (e) {
        failed++
        console.log(`[R2 백업] 사운드 파일(${name}) 업로드 실패:`, e.message)
      }
    }
    console.log(`[R2 백업] 사운드 동기화 완료 — 신규/변경 ${uploaded}건 / 스킵(동일) ${skipped}건 / 실패 ${failed}건 (전체 ${files.length}개)`)
    return { ok: true, uploaded, skipped, failed }
  } catch (e) {
    console.log('[R2 백업] 사운드 동기화 실패:', e.message)
    return { ok: false, error: e.message }
  }
}

// 🌐 30분마다 호출되는 진입점 — 전체 스냅샷 백업 + 사운드 동기화를 순서대로 실행한다.
async function backupAllToR2(store, soundsDir) {
  if (!R2_ENABLED) return
  await backupFullSnapshotToR2(store)
  await syncSoundsToR2(soundsDir)
}

// 🧹 3일마다 호출 — snapshots/ 아래에서 RETENTION_DAYS(기본 14일)보다 오래된 스냅샷을 지운다.
// (sounds/ 폴더는 스냅샷이 아니라 현재 상태 미러라서 정리 대상에서 제외)
async function cleanupOldSnapshots() {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    let continuationToken = undefined
    let deleted = 0, kept = 0

    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: SNAPSHOT_PREFIX,
        ContinuationToken: continuationToken,
      }))
      for (const obj of (res.Contents || [])) {
        if (obj.LastModified && obj.LastModified.getTime() < cutoff) {
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: obj.Key }))
            deleted++
          } catch (e) {
            console.log(`[R2 백업] 스냅샷(${obj.Key}) 삭제 실패:`, e.message)
          }
        } else {
          kept++
        }
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (continuationToken)

    console.log(`[R2 백업] 오래된 스냅샷 정리 완료 — 삭제 ${deleted}건 / 유지 ${kept}건 (보관기간 ${RETENTION_DAYS}일)`)
    return { ok: true, deleted, kept }
  } catch (e) {
    console.log('[R2 백업] 스냅샷 정리 실패:', e.message)
    return { ok: false, error: e.message }
  }
}

// 📋 R2에 저장된 djs 스냅샷 타임스탬프 목록을 최신순으로 가져온다 (복구할 때 목록에서 고르기 위함).
// key 형태: snapshots/djs-2026-08-25T01-30-00-000Z.json.gz → 타임스탬프 부분만 뽑아서 돌려준다.
async function listSnapshots(limit = 30) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: `${SNAPSHOT_PREFIX}djs-`,
    }))
    const stamps = (res.Contents || [])
      .map(obj => {
        const name = obj.Key.slice(SNAPSHOT_PREFIX.length) // djs-<stamp>.json.gz
        const m = name.match(/^djs-(.+)\.json\.gz$/)
        return m ? { stamp: m[1], lastModified: obj.LastModified, size: obj.Size } : null
      })
      .filter(Boolean)
      .sort((a, b) => (a.stamp < b.stamp ? 1 : -1)) // 최신순
      .slice(0, limit)
    return { ok: true, list: stamps }
  } catch (e) {
    console.log('[R2 백업] 스냅샷 목록 조회 실패:', e.message)
    return { ok: false, error: e.message }
  }
}

// 🔍 특정 시점(stamp)의 djs 스냅샷을 실제로 받아온다 (미리보기/복구 둘 다에 쓰임).
async function fetchDjsSnapshot(stamp) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const data = await getGzipJsonObject(`${SNAPSHOT_PREFIX}djs-${stamp}.json.gz`)
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 🔍 같은 시점의 globalMonsterDex 스냅샷도 받아온다 (있으면 같이 복구, 없으면 건너뜀 — 예전 스냅샷 하위호환).
async function fetchGlobalMonsterDexSnapshot(stamp) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const data = await getGzipJsonObject(`${SNAPSHOT_PREFIX}globalMonsterDex-${stamp}.json.gz`)
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ── ☁️ 셀프서비스 — DJ 본인이 직접 누르는 "내 계정 전체" 백업 ──
// 기존 Base44 셀프백업(/mydata/*)은 룰렛/애청지수 등 5개 필드만 뽑아서 저장했는데,
// 여기서는 djs[djId] 레코드 전체(비밀번호 해시 포함, 계정 자체 복구용)를 그대로 gzip해서 저장한다.
// 관리자 전용 전체 스냅샷(snapshots/)과는 별개 경로(dj-backups/<djId>/)를 쓴다.

// 📤 지금 바로 — 이 DJ 레코드 전체를 R2에 새 스냅샷으로 올린다. 저장 후 오래된 것부터 정리해서
// 이 djId 아래엔 최근 DJ_BACKUP_KEEP_COUNT개만 남긴다.
async function backupDjToR2(djId, record) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const key = `${DJ_BACKUP_PREFIX}${djId}/${stamp}.json.gz`
    await putObject(key, gzipJson(record), 'application/gzip')

    // 오래된 백업 정리 — 이 djId 폴더 안에서 최근 DJ_BACKUP_KEEP_COUNT개만 남기고 나머지 삭제
    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, Prefix: `${DJ_BACKUP_PREFIX}${djId}/` }))
    const keys = (listRes.Contents || []).map(o => o.Key).sort() // 이름에 타임스탬프가 있어서 문자열 정렬 = 시간순
    while (keys.length > DJ_BACKUP_KEEP_COUNT) {
      const oldest = keys.shift()
      try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: oldest })) } catch (e) {}
    }

    return { ok: true, stamp }
  } catch (e) {
    console.log(`[R2 백업] ${djId} 셀프 백업 실패:`, e.message)
    return { ok: false, error: e.message }
  }
}

// 📋 이 djId로 저장된 백업 목록(최신순)을 가져온다.
async function listDjBackups(djId, limit = 20) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, Prefix: `${DJ_BACKUP_PREFIX}${djId}/` }))
    const stamps = (res.Contents || [])
      .map(obj => {
        const name = obj.Key.slice(`${DJ_BACKUP_PREFIX}${djId}/`.length) // <stamp>.json.gz
        const m = name.match(/^(.+)\.json\.gz$/)
        return m ? { stamp: m[1], lastModified: obj.LastModified } : null
      })
      .filter(Boolean)
      .sort((a, b) => (a.stamp < b.stamp ? 1 : -1))
      .slice(0, limit)
    return { ok: true, list: stamps }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 🔍 이 djId의 특정 시점 백업 전체 레코드를 받아온다 (미리보기/복구 둘 다에 쓰임).
async function fetchDjBackup(djId, stamp) {
  if (!R2_ENABLED) return { ok: false, reason: 'disabled' }
  try {
    const data = await getGzipJsonObject(`${DJ_BACKUP_PREFIX}${djId}/${stamp}.json.gz`)
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = {
  R2_ENABLED,
  backupAllToR2,
  backupFullSnapshotToR2,
  syncSoundsToR2,
  cleanupOldSnapshots,
  listSnapshots,
  fetchDjsSnapshot,
  fetchGlobalMonsterDexSnapshot,
  backupDjToR2,
  listDjBackups,
  fetchDjBackup,
}