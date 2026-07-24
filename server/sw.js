// 최소한의 서비스워커 — 실시간 데이터(SSE/API)는 캐시하지 않고,
// PWA 설치 조건을 만족시키는 용도로만 사용합니다.
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  self.clients.claim();
});

// fetch 이벤트를 가로채지 않고 그대로 네트워크로 흘려보냅니다.
// (실시간 봇 데이터라서 캐싱하면 오히려 오작동할 수 있어요)
self.addEventListener('fetch', (e) => {});