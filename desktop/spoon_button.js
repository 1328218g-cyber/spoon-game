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
  // 🎚️ 방송 화면 위쪽(로고 ~ 라이브 종료 사이)에 빠른 프리셋 버튼 — 숫자 키 1~6 으로도 바꿀 수 있다
  //  번호 순서는 방송하기 화면(index.html BC_PRESETS)의 빠른 프리셋 순서와 같아야 한다
  const PRESETS = ['🎙️ 기본', '🎤 노래방', '📻 라디오', '✨ 깨끗하게', '🌙 ASMR', '🕳️ 동굴']
  let presetCur = ''
  function presetBar() {
    let bar = document.getElementById('__ediPresetBar')
    if (bar || !document.body) return bar
    if (!document.getElementById('__ediPresetCss')) {
      const st = document.createElement('style')
      st.id = '__ediPresetCss'
      st.textContent = '#__ediPresetBar{position:fixed;z-index:2147483645;display:none;gap:6px;align-items:center;font:700 12px/1 "Segoe UI",sans-serif;white-space:nowrap}' +
        '#__ediPresetBar button{all:unset;cursor:pointer;padding:6px 10px;border-radius:999px;background:#f3f0ff;color:#4c1d95;border:1px solid #ddd6fe;display:inline-flex;align-items:center;gap:5px}' +
        '#__ediPresetBar button:hover{background:#ede9fe}' +
        '#__ediPresetBar button.on{background:#7c3aed;color:#fff;border-color:#7c3aed}' +
        '#__ediPresetBar b{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(124,58,237,.15);font-size:10.5px}' +
        '#__ediPresetBar button.on b{background:rgba(255,255,255,.25)}' +
        '#__ediPresetBar.compact{gap:4px}#__ediPresetBar.compact button{padding:5px 7px}#__ediPresetBar.compact .nm{display:none}' +
        '#__ediPresetBar.tiny .em{display:none}'
      ;(document.head || document.documentElement).appendChild(st)
    }
    bar = document.createElement('div')
    bar.id = '__ediPresetBar'
    PRESETS.forEach((n, i) => {
      const b = document.createElement('button')
      b.dataset.name = n
      b.title = `${n} 프리셋 (숫자 키 ${i + 1})`
      const emo = n.split(' ')[0]
      b.innerHTML = `<b>${i + 1}</b><span class="em">${emo}</span><span class="nm">${n.slice(emo.length + 1)}</span>`
      b.addEventListener('click', () => applyPreset(i))
      bar.appendChild(b)
    })
    document.body.appendChild(bar)
    paintPreset()
    return bar
  }
  function paintPreset() {
    const bar = document.getElementById('__ediPresetBar')
    if (bar) bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.name === presetCur))
  }
  window.__ediPresetState = (name) => { presetCur = name || ''; paintPreset() }
  function applyPreset(i) {
    if (!ipc || !PRESETS[i]) return
    presetCur = PRESETS[i]; paintPreset()
    ipc.send('bcast:preset', i)
  }
  // 숫자 키 1~6 — 채팅 입력 중일 때는 동작하지 않는다
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return
    if (!/^[1-9]$/.test(e.key) || !lastSlot || lastSlot === 'null') return // 방송 화면일 때만
    const t = e.target
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    const i = +e.key - 1
    if (!PRESETS[i]) return
    e.preventDefault()
    applyPreset(i)
  }, true)
  function findLiveEnd() {
    const el = Array.from(document.querySelectorAll('button,a,span,div,p')).find((x) => x.childElementCount === 0 && (x.textContent || '').trim() === '라이브 종료' && x.offsetWidth > 0)
    return el ? (el.closest('button') || el) : null
  }
  function placePresetBar(onAir) {
    const bar = presetBar()
    if (!bar) return
    const end = onAir ? findLiveEnd() : null
    if (!end) { bar.style.display = 'none'; return }
    const r = end.getBoundingClientRect()
    if (r.top > 120) { bar.style.display = 'none'; return } // 위쪽 막대에 있는 "라이브 종료" 일 때만
    bar.style.display = 'flex'
    const LOGO = 90 // 왼쪽 로고 자리는 비워둔다
    const room = r.left - 12 - LOGO
    // 자리가 좁으면 이름 → 그림까지 줄이고(번호만), 그래도 안 들어가면 감춘다
    bar.classList.remove('compact', 'tiny')
    if (bar.offsetWidth > room) bar.classList.add('compact')
    if (bar.offsetWidth > room) bar.classList.add('tiny')
    if (bar.offsetWidth > room) { bar.style.display = 'none'; return }
    const w = bar.offsetWidth, h = bar.offsetHeight
    const left = Math.max(LOGO, Math.min(r.left - 12 - w, (window.innerWidth - w) / 2))
    bar.style.left = Math.round(left) + 'px'
    bar.style.top = Math.max(4, Math.round(r.top + (r.height - h) / 2)) + 'px'
  }

  setInterval(() => { try { reportSlot() } catch (_) {} try { placePresetBar(lastSlot && lastSlot !== 'null') } catch (_) {} }, 500)
  window.addEventListener('resize', () => { try { reportSlot() } catch (_) {} try { placePresetBar(lastSlot && lastSlot !== 'null') } catch (_) {} })
  let hideTimer = null
  const scheduleHide = () => { if (hideTimer) return; hideTimer = setTimeout(() => { hideTimer = null; try { hideAudioPanel() } catch (_) {} try { mount() } catch (_) {} }, 300) } // 화면이 다시 그려지면서 버튼이 지워졌으면 다시 띄운다
  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 300)
    hideAudioPanel()
    new MutationObserver(scheduleHide).observe(document.body, { childList: true, subtree: true })
  }
  startObserver()
})()
