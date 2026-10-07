// preload-menu.js — 방송 창 "메뉴 바로가기" 팝업 창용.
// "자동 로그인 유지"를 안 켜서 로그인 정보가 에디냥 창에만 있으면, main.js 가 넘겨준 로그인 정보를 이 창에만 넣어준다.
// (이 창에는 방송하기 기능(window.bcast)을 열어주지 않는다 — 봇 소리가 방송에 두 번 섞이지 않게)
try {
  const a = process.argv.find((x) => x.startsWith('--edi-auth='))
  if (a) {
    const o = JSON.parse(Buffer.from(a.slice('--edi-auth='.length), 'base64').toString('utf8'))
    if (o && o.t && !localStorage.getItem('djToken') && !sessionStorage.getItem('djToken')) {
      sessionStorage.setItem('djToken', String(o.t))
      sessionStorage.setItem('djId', String(o.id || ''))
    }
  }
} catch (_) {}
