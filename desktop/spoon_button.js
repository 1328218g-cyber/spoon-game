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

  function mount() {
    hideBadge()
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
    bar.appendChild(lst); bar.appendChild(add)
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

  setInterval(() => { try { reportSlot() } catch (_) {} try { placeMenuBar(lastSlot && lastSlot !== 'null') } catch (_) {} }, 500)
  window.addEventListener('resize', () => { try { reportSlot() } catch (_) {} try { placeMenuBar(lastSlot && lastSlot !== 'null') } catch (_) {} })
  let hideTimer = null
  const scheduleHide = () => { if (hideTimer) return; hideTimer = setTimeout(() => { hideTimer = null; try { hideAudioPanel() } catch (_) {} try { mount() } catch (_) {} }, 300) } // 화면이 다시 그려지면서 버튼이 지워졌으면 다시 띄운다
  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 300)
    hideAudioPanel()
    new MutationObserver(scheduleHide).observe(document.body, { childList: true, subtree: true })
  }
  startObserver()
})()
