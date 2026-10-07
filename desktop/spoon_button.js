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

  function mount() {
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
  setInterval(() => { try { reportSlot() } catch (_) {} }, 500)
  window.addEventListener('resize', () => { try { reportSlot() } catch (_) {} })
  let hideTimer = null
  const scheduleHide = () => { if (hideTimer) return; hideTimer = setTimeout(() => { hideTimer = null; try { hideAudioPanel() } catch (_) {} try { mount() } catch (_) {} }, 300) } // 화면이 다시 그려지면서 버튼이 지워졌으면 다시 띄운다
  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 300)
    hideAudioPanel()
    new MutationObserver(scheduleHide).observe(document.body, { childList: true, subtree: true })
  }
  startObserver()
})()
