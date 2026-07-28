#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// 로컬 에디봇(Electron) 데이터 → 웹 에디봇(store.js) 설정 마이그레이션 (관리자용 CLI)
//
// 사용법:
//   node migrate-local-data.js <djId> <로컬설정파일.json>
// 예시:
//   node migrate-local-data.js pop324 ./spoon_bot_settings_2026-07-28.json
//
// ⚠️ 실행 전 준비물
//   1. 웹봇에 <djId> 계정이 이미 회원가입되어 있어야 해요. (비밀번호는 그대로 유지되고, 설정값만 덮어씁니다)
//   2. 이 스크립트와 localMigrate.js를 store.js와 같은 폴더(서버 루트)에 두고 실행하세요.
//   3. 되도록 서버(index.js)를 잠깐 멈춘 상태에서 실행하세요. (같은 djs.json 파일에 동시에 쓰기 충돌 방지)
//
// 실제 변환 로직은 localMigrate.js에 공용 모듈로 분리되어 있고, 유저 본인이 웹 화면에서
// 셀프서비스로 마이그레이션할 때(/account/migrate-local API)도 같은 로직을 함께 사용한다.
// ══════════════════════════════════════════════════════════════

const fs = require('fs');
const store = require('./store');
const { buildMigrationPatch } = require('./localMigrate');

const [, , djId, localFilePath] = process.argv;

if (!djId || !localFilePath) {
  console.error('사용법: node migrate-local-data.js <djId> <로컬설정파일.json>');
  process.exit(1);
}

if (!store.exists(djId)) {
  console.error(`❌ "${djId}" 계정이 웹봇에 아직 없어요. 먼저 웹봇에서 회원가입부터 진행해주세요.`);
  process.exit(1);
}

if (!fs.existsSync(localFilePath)) {
  console.error(`❌ 파일을 찾을 수 없어요: ${localFilePath}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(localFilePath, 'utf-8'));
const { patch, report } = buildMigrationPatch(raw);
const ok = store.saveSettings(djId, patch);

console.log('\n========================================');
console.log(ok ? `✅ "${djId}" 계정에 마이그레이션 완료!` : `❌ 저장 실패 — 계정이 존재하는지 다시 확인해주세요.`);
console.log('========================================');
report.forEach(line => console.log(line));
console.log('\n마이그레이션 후 웹봇에 로그인해서 각 메뉴를 한 번씩 확인해주세요. (특히 룰렛 기록)');