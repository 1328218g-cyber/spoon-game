// spoon_button.js — 📻 방송 창(스푼 웹)에 띄우는 "🎙️ 방송하기" 버튼.
//  · 누르면 방송 창 옆에 방송하기 팝업 창이 바로 열린다 (main.js 'bcast:show-panel' → 서버 /bcpanel).
//  · 버튼을 끌면 원하는 곳으로 옮길 수 있고, 옮긴 위치는 이 PC에 기억된다 (다음에 켜도 그 자리).
//  · 기본 위치는 화면 위쪽 오른편(스푼 방송 화면 상단 프로필 근처).
//  · 스푼 방송 화면 왼쪽 "오디오 설정" 칸의 내용을 감추고, 그 자리에 에디냥 방송하기 화면을 고정으로 넣는다.
//    (그 칸의 위치·크기를 main.js 에 알려주면 main.js 가 그 자리에 방송하기 화면(서버 /bcpanel)을 겹쳐 띄운다)
//    그 칸을 못 찾는 화면(방송 시작 전 등)에서는 🎙️ 버튼이 보이고, 누르면 방송하기 창이 따로 열린다.
(function () {
  if (window.__ediBcastBtn) return
  window.__ediBcastBtn = true
  const KEY = 'edinyang_bcbtn_pos'
  let ipc = null
  try { ipc = window.require ? window.require('electron').ipcRenderer : null } catch (_) { ipc = null }

  // 방송 창 왼쪽 아래 "🎙️ 에디냥 사운드 적용 중" 알림(엔진 배지)은 감춘다 — 상태는 방송하기 화면에서 보인다
  function hideBadge() {
    if (document.getElementById('__ediHideBadgeCss')) return
    const root = document.head || document.documentElement
    if (!root) return
    const s = document.createElement('style')
    s.id = '__ediHideBadgeCss'
    s.textContent = '#__ediAudioBadge{display:none!important}'
    root.appendChild(s)
  }
  hideBadge()

  // 🗑️ 떠 있는 보라색 "🎙️ 방송하기" 버튼은 없앰 (방송하기는 왼쪽 고정 화면 · 위쪽 메뉴 바로가기 · 에디냥 창에서 열어요)
  const SHOW_FLOAT_BTN = false
  function mount() {
    hideBadge()
    if (!SHOW_FLOAT_BTN) return
    if (!document.body) return setTimeout(mount, 300)
    if (document.getElementById('__ediBcastBtn')) return
    const b = document.createElement('div')
    b.id = '__ediBcastBtn'
    b.textContent = '🎙️ 방송하기'
    b.title = '누르면 방송하기 창이 열려요 · 끌어서 위치를 옮길 수 있어요'
    b.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'padding:8px 14px', 'border-radius:999px',
      'background:#7c3aed', 'color:#fff', 'font:800 13px/1 "Segoe UI",sans-serif', 'cursor:grab',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)', 'user-select:none', 'touch-action:none', 'white-space:nowrap',
    ].join(';')
    document.body.appendChild(b)

    // 위치 — 저장된 곳, 없으면 위쪽 오른편
    const clamp = (x, y) => {
      const w = b.offsetWidth || 110, h = b.offsetHeight || 32
      return [Math.max(0, Math.min(window.innerWidth - w, x)), Math.max(0, Math.min(window.innerHeight - h, y))]
    }
    const place = (x, y) => { const [cx, cy] = clamp(x, y); b.style.left = cx + 'px'; b.style.top = cy + 'px'; b.style.right = 'auto' }
    let saved = null
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null') } catch (_) {}
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') place(saved.x, saved.y)
    else place(window.innerWidth - (b.offsetWidth || 110) - 16, 12)
    window.addEventListener('resize', () => { const r = b.getBoundingClientRect(); place(r.left, r.top) })

    // 끌기 / 누르기 구분 (4px 넘게 움직이면 끌기)
    let drag = null
    b.addEventListener('pointerdown', (e) => {
      const r = b.getBoundingClientRect()
      drag = { sx: e.clientX, sy: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false }
      try { b.setPointerCapture(e.pointerId) } catch (_) {}
      b.style.cursor = 'grabbing'
      e.preventDefault()
    })
    b.addEventListener('pointermove', (e) => {
      if (!drag) return
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return
      drag.moved = true
      place(e.clientX - drag.dx, e.clientY - drag.dy)
    })
    b.addEventListener('pointerup', () => {
      if (!drag) return
      const wasDrag = drag.moved
      drag = null
      b.style.cursor = 'grab'
      if (wasDrag) {
        const r = b.getBoundingClientRect()
        try { localStorage.setItem(KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })) } catch (_) {}
      } else if (ipc) {
        ipc.send('bcast:show-panel')
      }
    })
  }
  mount()

  // 🙈 스푼 방송 화면 왼쪽 "오디오 설정" 칸 → 내용만 감추고 자리는 남겨서 방송하기 화면 자리로 쓴다.
  // 스푼 화면 코드(클래스 이름)는 수시로 바뀔 수 있어서, "오디오 설정" 제목을 찾아 그 칸 전체(가운데 방송 화면·
  // 오른쪽 청취자 칸과 나란히 있는 칸)를 찾는다. 엉뚱한 곳을 건드리지 않게 크기·내용을 확인한다.
  let slotEl = null
  function hideAudioPanel() {
    if (slotEl && slotEl.isConnected) return
    if (!document.body) return
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,span,div,strong'))
      .filter((el) => el.childElementCount === 0 && (el.textContent || '').trim() === '오디오 설정')
    for (const h of heads) {
      let col = h
      // 위로 올라가면서, 옆에 나란히 있는 칸(형제)이 2개 이상이고 그 중에 방송 화면/청취자 칸이 있는 지점을 찾는다
      while (col && col.parentElement && col.parentElement !== document.body) {
        const parent = col.parentElement
        const sibs = Array.from(parent.children).filter((c) => c !== col && c.offsetWidth > 0)
        const looksLikeRow = sibs.length >= 1 && sibs.some((c) => /청취자|대화를 입력|라이브 종료|Top\s*\d/.test(c.textContent || ''))
        if (looksLikeRow) break
        col = parent
      }
      if (!col || !col.parentElement || col.parentElement === document.body) continue
      const w = col.getBoundingClientRect().width
      const txt = col.textContent || ''
      // 안전장치: 화면 절반보다 넓거나, 채팅 입력·청취자 목록이 들어있으면 엉뚱한 칸이니 건드리지 않는다
      if (w > window.innerWidth * 0.5 || /청취자|대화를 입력/.test(txt)) continue
      col.style.visibility = 'hidden' // 자리는 그대로 두고 내용만 감춘다 (그 위에 방송하기 화면이 올라감)
      col.dataset.ediSlot = 'audio'
      slotEl = col
      return
    }
  }
  // 방송하기 화면 자리(위치·크기)를 main.js 에 알려준다 — 바뀌었을 때만
  let lastSlot = ''
  function reportSlot() {
    let rect = null
    if (slotEl && slotEl.isConnected) {
      const r = slotEl.getBoundingClientRect()
      if (r.width > 120 && r.height > 200) rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(Math.min(r.height, window.innerHeight - Math.max(0, r.top))) }
    } else slotEl = null
    const key = JSON.stringify(rect)
    const btn = document.getElementById('__ediBcastBtn')
    if (btn) btn.style.display = rect ? 'none' : '' // 왼쪽에 방송하기 화면이 고정으로 보이면 버튼은 필요 없음
    if (key === lastSlot) return
    lastSlot = key
    if (ipc) ipc.send('bcast:slot', rect)
  }
  // 🐱 방송 화면 위쪽(로고 ~ 라이브 종료 사이)에 에디냥 메뉴 바로가기 — 누르면 그 메뉴가 팝업 창으로 열린다
  //  ＋ 를 누르면 에디냥 메뉴 목록이 나오고, 체크한 메뉴가 바로가기로 추가된다 (이 PC에 기억)
  const MKEY = 'edinyang_menu_shortcuts'
  let shortcuts = []
  try { shortcuts = JSON.parse(localStorage.getItem(MKEY) || '[]').filter((x) => x && typeof x.p === 'string') } catch (_) { shortcuts = [] }
  const saveShortcuts = () => { try { localStorage.setItem(MKEY, JSON.stringify(shortcuts)) } catch (_) {} }
  let menus = null // 에디냥 창에서 받아온 메뉴 목록 [{p,l,ic,e}]
  function iconEl(m) {
    if (m.ic) {
      const img = document.createElement('img')
      img.alt = ''
      img.addEventListener('error', () => { const i = document.createElement('i'); i.textContent = m.e || '🔹'; img.replaceWith(i) })
      img.src = m.ic
      return img
    }
    const i = document.createElement('i'); i.textContent = m.e || '🔹'; return i
  }
  function menuCss() {
    if (document.getElementById('__ediMenuCss')) return
    const st = document.createElement('style')
    st.id = '__ediMenuCss'
    st.textContent = [
      '#__ediMenuBar{position:fixed;z-index:2147483645;display:none;align-items:center;gap:6px;font:700 12px/1 "Segoe UI",sans-serif;white-space:nowrap}',
      '#__ediMenuBar .lst{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;min-width:0;flex:0 1 auto}',
      '#__ediMenuBar .lst::-webkit-scrollbar{display:none}',
      '#__ediMenuBar button{all:unset;box-sizing:border-box;cursor:pointer;height:30px;padding:0 11px;border-radius:999px;background:#f3f0ff;color:#4c1d95;border:1px solid #ddd6fe;display:inline-flex;align-items:center;gap:5px;flex-shrink:0}',
      '#__ediMenuBar button:hover{background:#ede9fe}',
      '#__ediMenuBar img,#__ediMenuPick img{width:16px;height:16px;object-fit:contain}',
      '#__ediMenuBar i,#__ediMenuPick i{font-style:normal}',
      '#__ediMenuBar .add{width:30px;padding:0;justify-content:center;font-size:18px;font-weight:600;background:#7c3aed;color:#fff;border-color:#7c3aed}',
      '#__ediMenuBar .add:hover{background:#6d28d9}',
      '#__ediMenuBar .cap{width:auto;height:36px;padding:0 16px;gap:6px;font-size:15px;font-weight:800;background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;border:none;box-shadow:0 4px 14px rgba(124,58,237,.35)}',
      '#__ediMenuBar .cap b{font-size:20px;line-height:1}',
      '#__ediMenuBar .cap:hover{filter:brightness(1.08)}',
      '#__ediMenuPick{position:fixed;z-index:2147483647;width:280px;max-height:65vh;display:flex;flex-direction:column;background:#fff;color:#222;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.25);font:500 13px/1.3 "Segoe UI",sans-serif;overflow:hidden}',
      '#__ediMenuPick .hd{padding:11px 12px 4px;font-weight:800}',
      '#__ediMenuPick .sub{padding:0 12px 6px;font-size:11.5px;color:#888}',
      '#__ediMenuPick input.q{margin:2px 10px 6px;padding:7px 10px;border:1px solid #ddd;border-radius:8px;font:inherit;outline:none;background:#fff;color:#222}',
      '#__ediMenuPick .items{overflow-y:auto;padding:2px 6px 8px}',
      '#__ediMenuPick label{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer}',
      '#__ediMenuPick label:hover{background:#f5f3ff}',
      '#__ediMenuPick input[type=checkbox]{accent-color:#7c3aed;margin:0}',
      '#__ediMenuPick .empty{padding:16px 12px;color:#888;text-align:center}',
    ].join('')
    ;(document.head || document.documentElement).appendChild(st)
  }
  function menuBar() {
    let bar = document.getElementById('__ediMenuBar')
    if (bar || !document.body) return bar
    menuCss()
    bar = document.createElement('div')
    bar.id = '__ediMenuBar'
    const lst = document.createElement('div'); lst.className = 'lst'
    const add = document.createElement('button'); add.className = 'add'; add.textContent = '+'; add.title = '바로가기 메뉴 추가·빼기'
    add.addEventListener('click', (e) => { e.stopPropagation(); togglePicker() })
    // 📸 캡처 — 가운데 방송 화면 칸(선물 애니메이션 포함)을 사진으로 저장 + 복사
    const cap = document.createElement('button'); cap.className = 'add cap'; cap.innerHTML = '<b>📸</b>캡처'; cap.title = '방송 화면 캡처 (사진 › 에디냥 캡처 폴더에 저장 · 복사)'
    cap.addEventListener('click', (e) => { e.stopPropagation(); captureNow() })
    bar.appendChild(lst); bar.appendChild(cap); bar.appendChild(add)
    bar.addEventListener('mousedown', (e) => e.stopPropagation()) // ＋ 를 다시 누르면 닫히게 (바깥 클릭 닫기와 겹치지 않게)
    document.body.appendChild(bar)
    renderBar()
    return bar
  }
  function renderBar() {
    const bar = document.getElementById('__ediMenuBar'); if (!bar) return
    const lst = bar.querySelector('.lst'); lst.innerHTML = ''
    shortcuts.forEach((m) => {
      const b = document.createElement('button')
      b.title = `${m.l} — 누르면 팝업 창으로 열려요`
      b.appendChild(iconEl(m))
      const t = document.createElement('span'); t.textContent = m.l; b.appendChild(t)
      b.addEventListener('click', () => { if (ipc) ipc.send('bcast:open-menu', { p: m.p, l: m.l }) })
      lst.appendChild(b)
    })
  }
  // ＋ 메뉴 고르기 창
  function closePicker() { const pk = document.getElementById('__ediMenuPick'); if (pk) pk.remove() }
  function togglePicker() {
    if (document.getElementById('__ediMenuPick')) return closePicker()
    menuCss()
    const pk = document.createElement('div')
    pk.id = '__ediMenuPick'
    pk.innerHTML = '<div class="hd">🐱 바로가기 메뉴</div><div class="sub">체크한 메뉴가 위쪽에 버튼으로 생겨요</div><input class="q" placeholder="메뉴 찾기"><div class="items"><div class="empty">메뉴 불러오는 중…</div></div>'
    pk.addEventListener('mousedown', (e) => e.stopPropagation())
    pk.querySelector('input.q').addEventListener('input', renderPicker)
    pk.querySelector('input.q').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closePicker() })
    document.body.appendChild(pk)
    placePicker()
    renderPicker()
    if (ipc) ipc.send('bcast:menus')
  }
  function placePicker() {
    const pk = document.getElementById('__ediMenuPick'); const add = document.querySelector('#__ediMenuBar .add')
    if (!pk || !add) return
    const r = add.getBoundingClientRect()
    pk.style.top = Math.round(r.bottom + 8) + 'px'
    pk.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - pk.offsetWidth - 8, r.right - pk.offsetWidth))) + 'px'
  }
  function renderPicker() {
    const pk = document.getElementById('__ediMenuPick'); if (!pk) return
    const box = pk.querySelector('.items')
    if (menus === null) return
    if (!menus.length) { box.innerHTML = '<div class="empty">에디냥 창에서 먼저 로그인해 주세요</div>'; return }
    const q = (pk.querySelector('input.q').value || '').trim().toLowerCase()
    box.innerHTML = ''
    const on = new Set(shortcuts.map((x) => x.p))
    menus.filter((m) => !q || m.l.toLowerCase().includes(q)).forEach((m) => {
      const lb = document.createElement('label')
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = on.has(m.p)
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!shortcuts.some((x) => x.p === m.p)) shortcuts.push({ p: m.p, l: m.l, ic: m.ic || '', e: m.e || '' }) }
        else shortcuts = shortcuts.filter((x) => x.p !== m.p)
        saveShortcuts(); renderBar()
      })
      const t = document.createElement('span'); t.textContent = m.l
      lb.appendChild(cb); lb.appendChild(iconEl(m)); lb.appendChild(t)
      box.appendChild(lb)
    })
    if (!box.children.length) box.innerHTML = '<div class="empty">찾는 메뉴가 없어요</div>'
  }
  // main.js 가 에디냥 창의 메뉴 목록을 넣어준다
  window.__ediMenus = (list) => {
    menus = Array.isArray(list) ? list.filter((m) => m && typeof m.p === 'string' && typeof m.l === 'string') : []
    // 이름·아이콘이 바뀐 메뉴는 바로가기에도 반영
    let changed = false
    shortcuts.forEach((s) => { const m = menus.find((x) => x.p === s.p); if (m && (m.l !== s.l || (m.ic || '') !== s.ic)) { s.l = m.l; s.ic = m.ic || ''; s.e = m.e || ''; changed = true } })
    if (changed) { saveShortcuts(); renderBar() }
    renderPicker()
  }
  document.addEventListener('mousedown', closePicker)
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker() })

  function findLiveEnd() {
    const el = Array.from(document.querySelectorAll('button,a,span,div,p')).find((x) => x.childElementCount === 0 && (x.textContent || '').trim() === '라이브 종료' && x.offsetWidth > 0)
    return el ? (el.closest('button') || el) : null
  }
  function placeMenuBar(onAir) {
    const bar = menuBar()
    if (!bar) return
    const end = onAir ? findLiveEnd() : null
    const r = end && end.getBoundingClientRect()
    if (!r || r.top > 120) { bar.style.display = 'none'; closePicker(); return } // 위쪽 막대에 "라이브 종료" 가 있는 방송 화면일 때만
    bar.style.display = 'flex'
    const LOGO = 120 // 왼쪽 로고 자리는 비워둔다
    const room = Math.max(40, r.left - 12 - LOGO)
    bar.style.maxWidth = room + 'px' // 바로가기가 많으면 옆으로 밀어서 본다
    const w = bar.offsetWidth, h = bar.offsetHeight
    const left = Math.max(LOGO, Math.min(r.left - 12 - w, (window.innerWidth - w) / 2))
    bar.style.left = Math.round(left) + 'px'
    bar.style.top = Math.max(4, Math.round(r.top + (r.height - h) / 2)) + 'px'
    placePicker()
  }

  // 🎁 선물 이펙트 — 스푼 모바일처럼 선물을 받으면 가운데 방송 화면 위에 선물 애니메이션을 크게 (main.js 가 넣어준다)
  //  · 스푼 원본 애니메이션(lottie)이 있으면 그걸로, 없으면 선물 그림을 크게 튀어나오게
  //  · 한 번에 하나씩 차례로 · 같은 사람이 같은 선물을 연달아 보내면 콤보 숫자만 올라간다
  const giftQ = []
  let giftCur = null
  function giftCss() {
    if (document.getElementById('__ediGiftCss')) return
    const st = document.createElement('style')
    st.id = '__ediGiftCss'
    st.textContent = [
      '#__ediGift{position:fixed;z-index:2147483640;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}',
      '#__ediGift .anim{position:relative;display:flex;align-items:center;justify-content:center}',
      '#__ediGift .anim svg{width:100%!important;height:100%!important}',
      '#__ediGift .anim img{max-width:70%;max-height:70%;object-fit:contain;animation:__ediRise 3s cubic-bezier(.2,.8,.3,1) forwards;filter:drop-shadow(0 10px 30px rgba(0,0,0,.45))}',
      '#__ediGift .cap{position:absolute;left:4%;bottom:7%;display:flex;align-items:center;gap:10px;padding:7px 16px 7px 7px;border-radius:999px;background:linear-gradient(90deg,rgba(124,58,237,.92),rgba(236,72,153,.85));color:#fff;font:800 14px/1.3 "Segoe UI",sans-serif;max-width:88%;word-break:keep-all;box-shadow:0 8px 24px rgba(0,0,0,.4);animation:__ediCapUp .5s cubic-bezier(.2,.9,.3,1.2)}',
      '#__ediGift .cap .th{width:40px;height:40px;flex:none;border-radius:50%;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden}',
      '#__ediGift .cap .th img{width:34px;height:34px;object-fit:contain;animation:none;filter:none;max-width:none;max-height:none}',
      '#__ediGift .cap .tx{min-width:0}',
      '#__ediGift .cap .tx small{display:block;font-weight:600;font-size:12px;opacity:.85}',
      '#__ediGift.out .cap{animation:__ediCapAway .4s ease forwards}',
      '#__ediGift .cap b{color:#fde68a}',
      '#__ediGift .combo{display:inline-block;margin-left:8px;color:#fde047;font-size:22px;font-style:italic;text-shadow:0 2px 6px rgba(0,0,0,.4)}',
      '#__ediGift .combo.bump{animation:__ediBump .3s ease}',
      '#__ediGift.out .anim{animation:__ediOut .35s ease forwards}',
      '@keyframes __ediPop{0%{transform:scale(.2);opacity:0}14%{transform:scale(1.12);opacity:1}22%{transform:scale(.96)}30%{transform:scale(1)}85%{transform:scale(1) translateY(-4%);opacity:1}100%{transform:scale(1.05) translateY(-8%);opacity:0}}',
      '@keyframes __ediCapUp{from{transform:translateY(160%);opacity:0}to{transform:none;opacity:1}}',
      '@keyframes __ediCapAway{to{transform:translateY(-60%);opacity:0}}',
      '@keyframes __ediRise{0%{transform:translateY(60%) scale(.5);opacity:0}25%{transform:translateY(-6%) scale(1.08);opacity:1}35%{transform:translateY(0) scale(1)}80%{transform:translateY(-6%) scale(1);opacity:1}100%{transform:translateY(-30%) scale(1.02);opacity:0}}',
      '@keyframes __ediBump{0%{transform:scale(1)}50%{transform:scale(1.5)}100%{transform:scale(1)}}',
      '@keyframes __ediOut{to{opacity:0}}',
    ].join('')
    ;(document.head || document.documentElement).appendChild(st)
  }
  // 가운데 방송 화면 칸 (왼쪽 방송하기 칸 바로 옆) — 못 찾으면 창 가운데
  function giftArea() {
    try {
      if (slotEl && slotEl.isConnected && slotEl.parentElement) {
        const sibs = Array.from(slotEl.parentElement.children).filter((c) => c !== slotEl && c.offsetWidth > 120 && c.offsetHeight > 200)
        const mid = sibs.find((c) => c.getBoundingClientRect().left >= slotEl.getBoundingClientRect().right - 2 && !/청취자/.test((c.textContent || '').slice(0, 400))) || sibs[0]
        if (mid) {
          const r = mid.getBoundingClientRect()
          const right = sibs.find((c) => c !== mid && c.getBoundingClientRect().left >= r.right - 2) // 오른쪽 청취자 칸
          const rr = right ? right.getBoundingClientRect() : null
          return { x: r.left, y: Math.max(0, r.top), w: r.width, h: Math.min(r.height, window.innerHeight - Math.max(0, r.top)), el: mid,
            side: rr && rr.width > 120 ? { x: rr.left, y: Math.max(0, rr.top), w: rr.width, h: Math.min(rr.height, window.innerHeight - Math.max(0, rr.top)) } : null }
        }
      }
    } catch (_) {}
    const w = Math.min(window.innerWidth, 600), h = Math.min(window.innerHeight, 800)
    return { x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2, w, h }
  }
  // 💬 선물 애니메이션이 나오는 동안 방송 화면 칸의 내용(프로필·숫자·채팅·입력창)만 감춘다 — 배경은 그대로
  //  · 칸 안을 위에서부터 훑으면서, 칸의 30% 이상을 차지하는 큰 칸(배경·채팅 목록 같은 틀)은 남기고 그 안으로 들어가고,
  //    그보다 작은 것(프로필·숫자 알약·채팅 한 줄·버튼 등)은 통째로 잠깐 안 보이게 한다 → 끝나면 원래대로
  let chatHidden = null
  function hideChat(col) {
    if (chatHidden || !col) return
    try {
      if (!document.getElementById('__ediChatHideCss')) {
        const st = document.createElement('style'); st.id = '__ediChatHideCss'
        st.textContent = '.__ediHid{visibility:hidden!important}'
        ;(document.head || document.documentElement).appendChild(st)
      }
      const cr = col.getBoundingClientRect(), A = Math.max(1, cr.width * cr.height), list = []
      const walk = (el, depth) => {
        for (const c of Array.from(el.children)) {
          if (c.id && c.id.indexOf('__edi') === 0) continue
          const r = c.getBoundingClientRect(), area = r.width * r.height
          if (area <= 0) continue
          if (area >= A * 0.3 && depth < 12) walk(c, depth + 1) // 큰 틀(배경 등)은 남기고 안쪽만
          else if (!c.classList.contains('__ediHid')) { c.classList.add('__ediHid'); list.push(c) }
        }
      }
      walk(col, 0)
      chatHidden = list
    } catch (_) { chatHidden = null }
  }
  function showChat() {
    if (!chatHidden) return
    const list = chatHidden; chatHidden = null
    list.forEach((c) => { try { c.classList.remove('__ediHid') } catch (_) {} })
  }
  const giftKey = (g) => g.nick + '|' + g.sticker

  // 📸 선물이 나오는 동안 오른쪽 청취자 칸 가운데에 큰 캡처 버튼을 띄운다 (애니메이션이 끝나고 조금 뒤에 사라짐)
  let capBtnTimer = null
  function showCapBtn() {
    clearTimeout(capBtnTimer)
    let b = document.getElementById('__ediCapBtn')
    if (!b) {
      if (!document.getElementById('__ediCapBtnCss')) {
        const st = document.createElement('style'); st.id = '__ediCapBtnCss'
        st.textContent = '#__ediCapBtn{all:unset;position:fixed;z-index:2147483645;transform:translate(-50%,-50%);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 26px;border-radius:22px;background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;font:800 16px/1.2 "Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(124,58,237,.45);animation:__ediCapIn .3s ease,__ediCapPulse 1.4s ease-in-out .3s infinite}' +
          '#__ediCapBtn b{font-size:40px;line-height:1}#__ediCapBtn small{font-weight:600;font-size:11.5px;opacity:.9}#__ediCapBtn:hover{filter:brightness(1.08)}#__ediCapBtn:active{transform:translate(-50%,-50%) scale(.95)}' +
          '@keyframes __ediCapIn{from{opacity:0;transform:translate(-50%,-40%) scale(.8)}to{opacity:1;transform:translate(-50%,-50%)}}' +
          '@keyframes __ediCapPulse{0%,100%{box-shadow:0 10px 30px rgba(124,58,237,.45)}50%{box-shadow:0 10px 40px rgba(236,72,153,.75)}}'
        ;(document.head || document.documentElement).appendChild(st)
      }
      b = document.createElement('button'); b.id = '__ediCapBtn'
      b.innerHTML = '<b>📸</b><span>지금 캡처</span><small>선물 장면 저장 · 복사</small>'
      b.addEventListener('click', (e) => { e.stopPropagation(); captureNow() })
      document.body.appendChild(b)
    }
    const a = giftArea()
    const box = a.side || { x: a.x + a.w + 10, y: a.y, w: Math.max(160, window.innerWidth - (a.x + a.w) - 20), h: a.h }
    b.style.left = Math.round(box.x + box.w / 2) + 'px'
    b.style.top = Math.round(box.y + box.h / 2) + 'px'
  }
  function hideCapBtn(later) {
    clearTimeout(capBtnTimer)
    capBtnTimer = setTimeout(() => { const b = document.getElementById('__ediCapBtn'); if (b) b.remove() }, later || 0)
  }

  // 📸 캡처 — main.js 가 방송 화면 칸만 찍어서 저장한다
  function captureNow() {
    if (!ipc) return
    const a = giftArea()
    ipc.send('bcast:capture', { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) })
  }
  window.__ediCaptured = (r) => {
    try {
      // 찰칵 — 화면 칸이 하얗게 번쩍
      const a = giftArea(), f = document.createElement('div')
      f.style.cssText = `position:fixed;left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px;background:#fff;opacity:.7;z-index:2147483646;pointer-events:none;transition:opacity .35s ease`
      document.body.appendChild(f); requestAnimationFrame(() => { f.style.opacity = '0' }); setTimeout(() => f.remove(), 400)
      const t = document.createElement('div')
      t.textContent = r && r.ok ? '📸 캡처 저장 · 복사됨 — 사진 › 에디냥 캡처 (누르면 폴더 열기)' : '❌ 캡처 실패: ' + ((r && r.error) || '')
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;background:rgba(17,17,17,.88);color:#fff;font:700 13px/1.4 "Segoe UI",sans-serif;padding:9px 16px;border-radius:12px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)'
      if (r && r.ok) t.addEventListener('click', () => { if (ipc) ipc.send('bcast:capture-folder') })
      document.body.appendChild(t); setTimeout(() => t.remove(), 3500)
    } catch (_) {}
  }
  window.__ediGiftFx = (g, anim) => {
    if (!g || !document.body) return
    g.anim = anim || null
    // 지금 보이는 것과 같은 사람·같은 선물이면 콤보만 올린다
    if (giftCur && giftKey(giftCur.g) === giftKey(g)) {
      giftCur.g.combo = Math.max(giftCur.g.combo, g.combo > 1 ? g.combo : giftCur.g.combo + 1)
      const c = giftCur.el.querySelector('.combo')
      if (c) { c.textContent = 'x' + giftCur.g.combo; c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump') }
      giftCur.extend()
      return
    }
    const q = giftQ.find((x) => giftKey(x) === giftKey(g))
    if (q) { q.combo = Math.max(q.combo, g.combo > 1 ? g.combo : q.combo + 1); return }
    giftQ.push(g)
    if (giftQ.length > 15) giftQ.splice(0, giftQ.length - 15) // 너무 많이 밀리면 오래된 것부터 건너뛴다
    if (!giftCur) giftNext()
  }
  function giftNext() {
    const g = giftQ.shift()
    if (!g) { giftCur = null; showChat(); hideCapBtn(3000); return }
    giftCss()
    const a = giftArea()
    hideChat(a.el)
    showCapBtn()
    const el = document.createElement('div')
    el.id = '__ediGift'
    el.style.left = a.x + 'px'; el.style.top = a.y + 'px'; el.style.width = a.w + 'px'; el.style.height = a.h + 'px'
    const size = Math.min(a.w, a.h * 0.85)
    // 스푼 애니메이션은 대부분 폰 화면(세로) 비율로 만들어져 있어서, 세로 애니메이션은 방송 화면 칸을 꽉 채운다 (폰에서 보는 것처럼)
    const aw = g.anim && +g.anim.w, ah = g.anim && +g.anim.h
    const tall = aw > 0 && ah > 0 && ah / aw > 1.15
    // 칸 비율이 애니메이션과 비슷하면 꽉 채우고(가장자리 조금 잘림), 많이 다르면 잘리지 않게 전체를 보여준다
    const fill = tall && Math.min(a.w / a.h, aw / ah) / Math.max(a.w / a.h, aw / ah) > 0.85
    const box = document.createElement('div'); box.className = 'anim'
    if (tall) { box.style.position = 'absolute'; box.style.inset = '0'; box.style.width = '100%'; box.style.height = '100%' }
    else { box.style.width = size + 'px'; box.style.height = size + 'px' }
    // 아래에서 쓱 올라오는 선물 카드 (선물 그림 · 보낸 사람 · 선물 이름 · 콤보)
    const cap = document.createElement('div'); cap.className = 'cap'
    const th = document.createElement('div'); th.className = 'th'
    if (g.image) { const ti = document.createElement('img'); ti.alt = ''; ti.addEventListener('error', () => { th.textContent = '🎁' }); ti.src = g.image; th.appendChild(ti) } else th.textContent = '🎁'
    const tx = document.createElement('div'); tx.className = 'tx'
    const nm = document.createElement('b'); nm.textContent = g.nick || '누군가'
    const sm = document.createElement('small'); sm.textContent = `${g.sticker || '선물'}${g.amount ? ` · ${g.amount}스푼` : ''} 보냈어요`
    tx.appendChild(nm); tx.appendChild(sm)
    const cb = document.createElement('span'); cb.className = 'combo'; cb.textContent = g.combo > 1 ? 'x' + g.combo : ''
    cap.appendChild(th); cap.appendChild(tx); cap.appendChild(cb)
    el.appendChild(box) // 아래 선물 카드(보낸 사람·선물 글씨)는 안 띄운다 — 애니메이션만
    document.getElementById('__ediGift') && document.getElementById('__ediGift').remove()
    document.body.appendChild(el)
    let player = null, timer = null, done = false
    const finish = () => {
      if (done) return; done = true
      clearTimeout(timer)
      el.classList.add('out')
      setTimeout(() => { try { if (player) player.destroy() } catch (_) {} el.remove(); giftNext() }, 350)
    }
    const cur = { g, el, extend: () => {
      // 콤보가 이어지면 조금 더 보여준다 (애니메이션은 다시 처음부터)
      clearTimeout(timer); timer = setTimeout(finish, player ? 9000 : 3000)
      try { if (player) player.goToAndPlay(0, true) } catch (_) {}
      const img = box.querySelector('img'); if (img) { img.style.animation = 'none'; void img.offsetWidth; img.style.animation = '' }
    } }
    giftCur = cur
    const L = window.__ediLottie
    if (g.anim && L && L.loadAnimation) {
      try {
        let base = ''
        try { base = g.lottieUrl ? g.lottieUrl.replace(/[^/]*$/, '') : '' } catch (_) {}
        player = L.loadAnimation({ container: box, renderer: 'svg', loop: false, autoplay: true, animationData: g.anim, assetsPath: base || undefined, rendererSettings: { preserveAspectRatio: tall && fill ? 'xMidYMid slice' : 'xMidYMid meet' } })
        player.addEventListener('complete', finish)
        player.addEventListener('data_failed', finish)
        timer = setTimeout(finish, 9000) // 너무 긴 애니메이션은 9초에서 끊기
        return
      } catch (_) { player = null; box.innerHTML = '' }
    }
    if (g.image) {
      const img = document.createElement('img'); img.alt = ''
      img.addEventListener('error', () => { img.remove(); const t = document.createElement('div'); t.textContent = '🎁'; t.style.cssText = 'font-size:' + Math.round(size * 0.4) + 'px;animation:__ediRise 3s cubic-bezier(.2,.8,.3,1) forwards'; box.appendChild(t) })
      img.src = g.image
      box.appendChild(img)
    } else {
      const t = document.createElement('div'); t.textContent = '🎁'; t.style.cssText = 'font-size:' + Math.round(size * 0.4) + 'px;animation:__ediRise 3s cubic-bezier(.2,.8,.3,1) forwards'; box.appendChild(t)
    }
    timer = setTimeout(finish, 3000)
  }

  // 📦 컨텐츠 — 오른쪽 "실시간 랭킹" 탭을 "컨텐츠"로 바꾸고, 누르면 그 아래 칸에 📊 투표함 · ✉️ 편지함 · 🎮 라이브게임
  //  (스푼 PC 웹에는 없는 모바일 기능 · 투표 번호/편지함 번호는 스푼 이벤트를 에디냥 봇이 받아서 알려줌)
  let playTimer = null, playKind = 'poll', contentsTab = null
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  function patchItemTab() { // (이름은 예전 그대로 — 화면이 다시 그려질 때마다 불림)
    const tabs = [...document.querySelectorAll('button,[role=tab],li,a,div,span')].filter((el) => !el.closest('#__ediContents') && el.children.length <= 2 && /^(실시간 랭킹|컨텐츠)$/.test((el.textContent || '').trim()))
    for (const el of tabs) {
      let tab = el
      while (tab.parentElement && /^(실시간 랭킹|컨텐츠)$/.test((tab.parentElement.textContent || '').trim())) tab = tab.parentElement
      // 위쪽 큰 탭만 (청취자 탭 안의 '실시간 랭킹' 버튼은 제외) — 같은 줄에 '받은 아이템'·'보관함' 탭이 있는 것
      const row = tab.parentElement; if (!row || !/받은 아이템/.test(row.textContent || '') || !/보관함/.test(row.textContent || '')) continue
      if (tab.dataset.ediContents) continue
      tab.dataset.ediContents = '1'; contentsTab = tab
      // 글자(텍스트)만 바꿔요 — 감싸고 있는 칸을 지우면 스푼의 가운데 정렬이 깨져서 글씨가 위로 붙어요
      const tw = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT)
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.nodeValue.trim() === '실시간 랭킹') { n.nodeValue = n.nodeValue.replace('실시간 랭킹', '컨텐츠'); break } }
      tab.addEventListener('click', () => setTimeout(openContents, 60), true) // 스푼이 탭을 바꾼 뒤 그 아래 칸을 덮어요
      // 다른 탭을 누르면 닫기
      ;[...row.children].forEach((sib) => { if (sib !== tab && !sib.dataset.ediOther) { sib.dataset.ediOther = '1'; sib.addEventListener('click', closeContents, true) } })
    }
    placeContents()
  }
  function contentsRect() {
    if (!contentsTab || !contentsTab.isConnected) return null
    const row = contentsTab.parentElement, rr = row.getBoundingClientRect()
    // 탭 줄 아래 ~ 오른쪽 칸 끝까지 (탭 줄을 감싼 칸 기준)
    let col = row; for (let i = 0; i < 4 && col.parentElement; i++) { const r = col.parentElement.getBoundingClientRect(); if (r.height > rr.height * 4) { col = col.parentElement; break } col = col.parentElement }
    const cr = col.getBoundingClientRect()
    return { col, x: rr.left, y: rr.bottom, w: rr.width, h: Math.max(200, Math.min(cr.bottom, window.innerHeight) - rr.bottom) }
  }
  function placeContents() {
    const box = document.getElementById('__ediContents'); if (!box) return
    const r = contentsRect(); if (!r) return closeContents()
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' })
    // 칸에 transform이 걸려 있으면 fixed 기준이 바뀌어요 — 실제 위치를 재서 맞춰요
    const b = box.getBoundingClientRect(), dx = b.left - r.x, dy = b.top - r.y
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) Object.assign(box.style, { left: (r.x - dx) + 'px', top: (r.y - dy) + 'px' })
  }
  function closeContents() { const b = document.getElementById('__ediContents'); if (b) b.remove(); clearInterval(playTimer); playTimer = null }
  function openContents() {
    if (document.getElementById('__ediContents')) return
    const r = contentsRect(); if (!r) return
    const box = document.createElement('div'); box.id = '__ediContents'
    // 오른쪽 칸 안에 넣고 z-index도 낮게 — 스푼의 투표 결과 같은 팝업이 위에 보이도록 (예전엔 맨 위에 떠서 팝업을 가렸어요)
    box.style.cssText = `position:fixed;z-index:5;background:#fff;color:#111;overflow:auto;font:13px/1.5 "Segoe UI","Malgun Gothic",sans-serif`
    const chip = 'padding:7px 14px;border-radius:999px;border:1px solid #d1d5db;font-size:13px;cursor:pointer;background:#fff;white-space:nowrap'
    box.innerHTML = `<div style="display:flex;gap:8px;align-items:center;padding:14px 16px;border-bottom:1px solid #f3f4f6;flex-wrap:wrap">${[['poll', '📊 투표함'], ['mailbox', '✉️ 편지함'], ['livegame', '🎮 라이브게임']].map(([k, l]) => `<span data-k="${k}" style="${chip}">${l}</span>`).join('')}<span id="__ctRef" title="새로고침" style="margin-left:auto;font-size:18px;cursor:pointer">↻</span></div><div id="__ediPlayOut" style="padding:12px 16px 18px"></div>`
    ;(r.col && r.col !== document.documentElement ? r.col : document.body).appendChild(box); placeContents()
    box.querySelectorAll('[data-k]').forEach((c) => { c.onclick = () => playOpen(c.dataset.k) })
    box.querySelector('#__ctRef').onclick = () => playOpen(playKind)
    playOpen(playKind)
  }
  function playOpen(kind) {
    playKind = kind
    const box = document.getElementById('__ediContents'), out = document.getElementById('__ediPlayOut'); if (!box || !out) return
    box.querySelectorAll('[data-k]').forEach((c) => { const on = c.dataset.k === kind; c.style.background = on ? '#111' : '#fff'; c.style.color = on ? '#fff' : '#374151'; c.style.borderColor = on ? '#111' : '#d1d5db' })
    clearInterval(playTimer); playTimer = null
    if (kind === 'livegame') { out.innerHTML = '<div style="font-weight:700">○ 라이브게임</div><div style="color:#64748b;font-size:12px">준비 중이에요</div>'; return }
    out.innerHTML = '<div style="color:#64748b">⏳ 불러오는 중…</div>'
    const ch = kind === 'poll' ? 'bcast:poll' : 'bcast:mailbox'
    const load = () => { if (ipc) ipc.send(ch, {}) }
    load(); playTimer = setInterval(load, kind === 'poll' ? 5000 : 8000)
  }
  const inp = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e5e7eb;border-radius:9px;font:inherit;margin-top:6px'
  const bigBtn = (bg) => `width:100%;margin-top:8px;padding:10px;border-radius:10px;border:none;background:${bg};color:#fff;font-weight:800;cursor:pointer;font:inherit;font-weight:800`
  const resBox = '<div id="__ctRes" style="margin-top:8px;font-size:12px"></div>'
  // 만들기/종료 결과 (스푼이 거절하면 이유를 그대로 보여줘요 — 그걸 보고 보낼 값을 맞춰요)
  window.__ediPlayCreated = (r) => {
    const el = document.getElementById('__ctRes'); if (!el) return
    if (r && r.ok) { el.style.color = '#16a34a'; el.textContent = '✅ ' + (r.msg || '완료'); setTimeout(() => playOpen(playKind), 1200) }
    else { el.style.color = '#dc2626'; el.innerHTML = '❌ ' + esc((r && r.error) || '실패') + (r && r.body ? `<pre style="white-space:pre-wrap;word-break:break-all;font-size:10px;background:#fef2f2;border-radius:6px;padding:6px;margin:4px 0 0;max-height:120px;overflow:auto">${esc(r.body)}</pre>` : '') }
  }
  const sendPlay = (msg) => { const el = document.getElementById('__ctRes'); if (el) { el.style.color = '#64748b'; el.textContent = '⏳ 스푼에 보내는 중…' } clearInterval(playTimer); playTimer = null; if (ipc) ipc.send('bcast:play-act', msg) }
  // 📊 투표 — 진행 중이면 선택지·총 투표 수 + 종료, 없으면 만들기
  window.__ediPoll = (r) => {
    const out = document.getElementById('__ediPlayOut'); if (!out || playKind !== 'poll') return
    if (document.activeElement && out.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return // 입력 중엔 다시 그리지 않음
    if (!r || (r.error && !r.poll)) { out.innerHTML = `<div style="color:#dc2626">❌ ${esc((r && r.error) || '실패')}</div>`; return }
    if (!r.poll || !r.poll.id || /END|CLOSE|FINISH|DONE/i.test(r.poll.command || '')) {
      out.innerHTML = `<div style="font-weight:700">○ 진행 중인 투표 없음</div>
        <input id="__pT" placeholder="투표 제목" maxlength="40" style="${inp}">
        <div id="__pOpts">${[1, 2].map((i) => `<input class="__pO" placeholder="선택지 ${i}" maxlength="20" style="${inp}">`).join('')}</div>
        <div id="__pAdd" style="margin-top:6px;color:#7c3aed;font-size:12px;cursor:pointer">＋ 선택지 추가 (최대 5개)</div>
        <button id="__pGo" style="${bigBtn('#db2777')}">투표 시작</button>${resBox}`
      out.querySelector('#__pAdd').onclick = () => { const w = out.querySelector('#__pOpts'); const n = w.querySelectorAll('.__pO').length; if (n >= 5) return; w.insertAdjacentHTML('beforeend', `<input class="__pO" placeholder="선택지 ${n + 1}" maxlength="20" style="${inp}">`) }
      out.querySelector('#__pGo').onclick = () => {
        const title = out.querySelector('#__pT').value.trim(), items = [...out.querySelectorAll('.__pO')].map((x) => x.value.trim()).filter(Boolean)
        if (!title || items.length < 2) return window.__ediPlayCreated({ error: '제목과 선택지 2개 이상을 적어주세요' })
        if (new Set(items).size !== items.length) return window.__ediPlayCreated({ error: '같은 선택지가 있어요 — 선택지는 서로 다르게 적어주세요' })
        sendPlay({ act: 'poll-create', title, items })
      }
      return
    }
    const d = r.detail || {}
    const raw = (d.items || d.options || r.poll.options || []).slice().sort((a, b) => (Number(a && a.item_order) || 0) - (Number(b && b.item_order) || 0))
    const total = Math.max(Number(r.poll.total) || 0, Number(d.poll_count) || 0)
    out.innerHTML = `<div style="font-weight:700">● ${esc(d.title || r.poll.title || '투표')} <span style="color:#db2777">${total}표</span></div>` +
      (raw.length ? raw.map((o, i) => `<div style="padding:8px 10px;margin:6px 0;border:1px solid #f1f5f9;border-radius:10px;background:#fafafa"><b style="color:#db2777;margin-right:6px">${i + 1}</b>${esc((o && (o.name || o.title)) || o)}${o && o.count != null ? ` <span style="color:#64748b;float:right">${Number(o.count)}표</span>` : ''}</div>`).join('') : '') +
      `<button id="__pEnd" style="${bigBtn('#475569')}">투표 종료</button>${resBox}`
    out.querySelector('#__pEnd').onclick = () => sendPlay({ act: 'poll-end', id: r.poll.id })
  }
  const ago = (t) => { const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000); return s < 60 ? '방금' : s < 3600 ? Math.floor(s / 60) + '분 전' : Math.floor(s / 3600) + '시간 전' }
  // ✉️ 편지함 — 진행 중이면 사연 목록 + 닫기, 없으면 열기
  window.__ediMailbox = (r) => {
    const out = document.getElementById('__ediPlayOut'); if (!out || playKind !== 'mailbox') return
    if (document.activeElement && out.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return
    if (!r || (r.error && !r.mailbox)) { out.innerHTML = `<div style="color:#dc2626">❌ ${esc((r && r.error) || '실패')}</div>`; return }
    if (!r.mailbox || !r.mailbox.id || /END|CLOSE|FINISH|DONE/i.test(r.mailbox.command || '')) {
      out.innerHTML = `<div style="font-weight:700">○ 진행 중인 편지함 없음</div>
        <input id="__mT" placeholder="편지함 제목 (예: 신청곡 접수 받아요)" maxlength="40" style="${inp}">
        <button id="__mGo" style="${bigBtn('#db2777')}">편지함 열기</button>${resBox}`
      out.querySelector('#__mGo').onclick = () => { const title = out.querySelector('#__mT').value.trim(); if (!title) return window.__ediPlayCreated({ error: '편지함 제목을 적어주세요' }); sendPlay({ act: 'mailbox-create', title }) }
      return
    }
    const list = (r.messages || []).slice().sort((a, b) => new Date(b.created) - new Date(a.created))
    out.innerHTML = `<div style="font-weight:700">● ${esc(r.mailbox.title || '편지함')} <span style="color:#db2777">${list.length || r.mailbox.count || 0}개</span></div>` +
      `<button id="__mEnd" style="${bigBtn('#475569')}">편지함 닫기</button>${resBox}` +
      (r.error ? `<div style="color:#dc2626;font-size:12px;margin-top:6px">❌ ${esc(r.error)}</div>` : '') +
      `<div style="margin-top:8px">${list.length ? list.map((m) => `<div style="display:flex;gap:8px;padding:8px 0;border-top:1px solid #f1f5f9">${m.is_anonymous || !m.profile_url ? '<div style="width:32px;height:32px;border-radius:50%;background:#e5e7eb;flex-shrink:0;display:flex;align-items:center;justify-content:center">✉️</div>' : `<img src="${esc(m.profile_url)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0">`}<div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px">${m.is_anonymous ? '익명' : esc(m.nickname || '?')} <span style="color:#94a3b8;font-weight:400">${esc(ago(m.created))}</span></div><div style="white-space:pre-wrap;word-break:break-all">${esc(m.message)}</div></div><div style="align-self:center;flex-shrink:0;display:flex;flex-direction:column;gap:4px">${r.currentId != null && String(r.currentId) === String(m.id) ? '<span style="padding:5px 9px;border-radius:8px;background:#fce7f3;color:#db2777;font-size:11px;font-weight:800;text-align:center">공개 중</span>' : `<button data-mid="${esc(m.id)}" style="padding:5px 9px;border-radius:8px;border:1px solid #f9a8d4;background:#fff;color:#db2777;font:inherit;font-size:11px;font-weight:800;cursor:pointer">공개</button>`}<button data-del="${esc(m.id)}" style="padding:5px 9px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#64748b;font:inherit;font-size:11px;font-weight:800;cursor:pointer">삭제</button></div></div>`).join('') : '<div style="color:#64748b">아직 받은 사연이 없어요</div>'}</div>`
    out.querySelector('#__mEnd').onclick = () => sendPlay({ act: 'mailbox-end', id: r.mailbox.id })
    // 사연 공개 — 시청자 화면에 이 사연이 떠요 (모바일 DJ의 "공개"와 같은 기능)
    out.querySelectorAll('button[data-mid]').forEach((b) => { b.onclick = () => { const n = Number(b.dataset.mid); sendPlay({ act: 'mailbox-show', id: r.mailbox.id, msgId: Number.isFinite(n) ? n : b.dataset.mid }) } })
    // 사연 하나 삭제 (한 번 더 물어봐요)
    out.querySelectorAll('button[data-del]').forEach((b) => { b.onclick = () => { if (!confirm('이 사연을 삭제할까요?')) return; const n = Number(b.dataset.del); sendPlay({ act: 'mailbox-remove', id: r.mailbox.id, msgId: Number.isFinite(n) ? n : b.dataset.del }) } })
  }
  window.addEventListener('resize', placeContents)

  // 🎁 청취자 목록에서 시청자를 누르면 복권 · 룰렛권을 바로 지급 (에디냥 "실시간 지급"과 같은 기능)
  //  · 메뉴 맨 아래 "스푼 프로필 보기"를 누르면 원래 스푼 동작(프로필 창)으로 넘어가요
  let grantBypass = false
  function listenerRow(t) {
    if (!t || !t.closest || t.closest('#__ediGrant,#__ediPlay,#__ediMenuBar')) return null
    // 위로 올라가면서 "아바타 이미지 + 짧은 글자"를 가진 줄을 찾고, 그 줄이 "누적 N명/애칭온도"가 있는 청취자 목록 안인지 확인
    let row = null
    for (let el = t, i = 0; el && el !== document.body && i < 8; el = el.parentElement, i++) {
      const r = el.getBoundingClientRect()
      if (r.height >= 36 && r.height <= 120 && el.querySelector('img') && (el.textContent || '').trim().length <= 60) { row = el; break }
    }
    if (!row) return null
    let inList = false
    for (let el = row.parentElement, i = 0; el && el !== document.body && i < 6; el = el.parentElement, i++) {
      if (/누적\s*\d+\s*명|애칭온도|현재\s*\d+\s*명/.test((el.textContent || '').slice(0, 300))) { inList = true; break }
    }
    if (!inList) return null
    const lines = (row.innerText || '').split('\n').map((x) => x.trim()).filter((x) => x && !/°C|^\d+$|^(DJ|매니저|팬)$/.test(x))
    return lines[0] ? { row, nick: lines[0] } : null
  }
  // 마우스를 청취자 위에 올리면 접속자 목록을 미리 받아둬요 (누르는 순간 바로 뜨게)
  let prefetchAt = 0
  document.addEventListener('pointerover', (e) => {
    if (!ipc || Date.now() - prefetchAt < 20000) return
    if (!listenerRow(e.target)) return
    prefetchAt = Date.now(); ipc.send('bcast:grant-prefetch')
  }, true)
  document.addEventListener('click', (e) => {
    if (grantBypass || !ipc) return
    const hit = listenerRow(e.target)
    if (!hit) return
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
    openGrant(hit)
  }, true)
  function openGrant(hit) {
    let box = document.getElementById('__ediGrant'); if (box) box.remove()
    box = document.createElement('div'); box.id = '__ediGrant'
    const r = hit.row.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 16)
    box.style.cssText = `position:fixed;z-index:2147483646;top:${Math.round(Math.min(r.bottom + 4, window.innerHeight - 300))}px;left:${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left)))}px;width:${w}px;background:#fff;color:#111;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);font:13px/1.5 "Segoe UI","Malgun Gothic",sans-serif;padding:12px`
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;font-weight:800">🎁 <span style="flex:1;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(hit.nick)}</span><span id="__ediGrantX" style="cursor:pointer;padding:0 4px">✕</span></div><div id="__ediGrantBody" style="margin-top:8px;color:#64748b">⏳ 불러오는 중…</div>`
    document.body.appendChild(box)
    box.querySelector('#__ediGrantX').onclick = () => box.remove()
    box._row = hit.row
    ipc.send('bcast:grant-menu', { nick: hit.nick })
  }
  window.__ediGrantMenu = (m) => {
    const box = document.getElementById('__ediGrant'), body = document.getElementById('__ediGrantBody'); if (!box || !body) return
    const prof = `<div style="margin-top:10px;text-align:right"><span id="__ediGrantProf" style="cursor:pointer;color:#7c3aed;font-size:12px">스푼 프로필 보기 ›</span></div>`
    const bindProf = () => { const p = document.getElementById('__ediGrantProf'); if (p) p.onclick = () => { const row = box._row; box.remove(); grantBypass = true; try { row && row.click() } finally { grantBypass = false } } }
    if (!m || m.error) { body.innerHTML = `<div style="color:#dc2626">❌ ${esc((m && m.error) || '실패')}</div>` + prof; bindProf(); return }
    const btn = 'padding:7px 10px;border-radius:9px;border:1px solid #e5e7eb;background:#f8fafc;font-weight:700;cursor:pointer'
    const num = 'width:52px;padding:6px;border:1px solid #e5e7eb;border-radius:8px;text-align:center'
    body.innerHTML = `<div id="__gTag" style="color:#94a3b8;font-size:11px">${m.tag ? '@' + esc(m.tag) : '⏳ 고유닉 확인 중…'}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px"><b style="flex:1">🎫 복권</b><input id="__gL" type="number" min="1" value="1" style="${num}"><button data-g="lotto" style="${btn}">지급</button></div>
      ${(m.roulettes || []).length ? `<div style="display:flex;align-items:center;gap:6px;margin-top:8px"><select id="__gRi" style="flex:1;min-width:0;padding:6px;border:1px solid #e5e7eb;border-radius:8px">${m.roulettes.map((n, i) => `<option value="${i + 1}">🎡 룰렛${i + 1}${n ? ' ' + esc(n) : ''}</option>`).join('')}</select><input id="__gR" type="number" min="1" value="1" style="${num}"><button data-g="roulette" style="${btn}">지급</button></div>` : '<div style="margin-top:8px;color:#94a3b8;font-size:12px">🎡 등록된 룰렛이 없어요</div>'}
      <div id="__gOut" style="margin-top:8px;font-size:12px;color:#16a34a"></div>` + prof
    bindProf()
    box._tag = m.tag || ''; box._nick = m.nick
    const setBtns = () => body.querySelectorAll('button[data-g]').forEach((b) => { b.disabled = !box._tag; b.style.opacity = box._tag ? '1' : '.5' })
    box._setTag = (t) => { box._tag = t; const el = document.getElementById('__gTag'); if (el) el.textContent = '@' + t; setBtns() }
    setBtns()
    body.querySelectorAll('button[data-g]').forEach((b) => {
      b.onclick = () => {
        if (!box._tag) return
        const kind = b.dataset.g
        const amount = Math.max(1, Math.floor(Number(document.getElementById(kind === 'lotto' ? '__gL' : '__gR').value) || 1))
        const idx = kind === 'roulette' ? Number(document.getElementById('__gRi').value) : 0
        document.getElementById('__gOut').style.color = '#64748b'; document.getElementById('__gOut').textContent = '⏳ 지급 중…'
        ipc.send('bcast:grant', { kind, tag: box._tag, nick: m.nick, idx, amount })
      }
    })
  }
  // 고유닉이 나중에 확인되면 버튼을 켜요 (못 찾으면 안내)
  window.__ediGrantTag = (r) => {
    const box = document.getElementById('__ediGrant'); if (!box || !box._setTag) return
    if (r && r.tag) return box._setTag(r.tag)
    const el = document.getElementById('__gTag'); if (!el) return
    el.style.color = '#dc2626'
    el.innerHTML = '❌ ' + esc((r && r.error) || '고유닉을 못 찾았어요') + ' <span id="__gRetry" style="cursor:pointer;color:#7c3aed;margin-left:4px">다시 시도</span>'
    const rt = document.getElementById('__gRetry')
    if (rt) rt.onclick = () => { el.style.color = '#94a3b8'; el.textContent = '⏳ 고유닉 확인 중…'; ipc.send('bcast:grant-menu', { nick: box._nick, retryOnly: true }) }
  }
  window.__ediGrantDone = (r) => {
    const out = document.getElementById('__gOut'); if (!out) return
    out.style.color = r && r.ok ? '#16a34a' : '#dc2626'
    out.textContent = r && r.ok ? '✅ ' + r.msg : '❌ ' + ((r && r.error) || '실패')
    // 지급되면 잠깐 결과만 보여주고 저절로 닫혀요
    if (r && r.ok) { const box = document.getElementById('__ediGrant'); setTimeout(() => { if (box && box.isConnected && document.getElementById('__gOut') === out) box.remove() }, 1200) }
  }

  setInterval(() => { try { reportSlot() } catch (_) {} try { placeMenuBar(lastSlot && lastSlot !== 'null') } catch (_) {} try { placeContents() } catch (_) {} }, 500)
  window.addEventListener('resize', () => { try { reportSlot() } catch (_) {} try { placeMenuBar(lastSlot && lastSlot !== 'null') } catch (_) {} })
  let hideTimer = null
  const scheduleHide = () => { if (hideTimer) return; hideTimer = setTimeout(() => { hideTimer = null; try { hideAudioPanel() } catch (_) {} try { mount() } catch (_) {} try { patchItemTab() } catch (_) {} }, 300) } // 화면이 다시 그려지면서 버튼이 지워졌으면 다시 띄운다
  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 300)
    hideAudioPanel()
    new MutationObserver(scheduleHide).observe(document.body, { childList: true, subtree: true })
  }
  startObserver()
})()
