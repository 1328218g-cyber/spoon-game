/* 📚 스티커 컬렉션북 — 화면 (api: { load: () => Promise<{success,stickers,items,since,error}>, reset: () => Promise }) */
window.StickerBook = (function () {
  let SB = null, tab = 'all', cat = '전체', api = null, root = null, lot = null;
  const $q = (s) => root.querySelector(s);
  const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
  const dt = (ms) => { const d = new Date(ms); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let dim = null;
  function modal(html, lock) {
    if (!dim) { dim = document.createElement('div'); dim.className = 'sbw-dim'; dim.onclick = (e) => { if (e.target === dim) dim.classList.remove('on'); }; document.body.appendChild(dim); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dim.classList.remove('on'); }); }
    dim.innerHTML = `<div class="sbw-dlg ${lock ? 'lock' : ''}"><button class="x" type="button">✕</button>${html}</div>`;
    dim.querySelector('.x').onclick = () => dim.classList.remove('on');
    dim.classList.add('on');
  }
  const loadLottie = () => lot || (lot = new Promise((ok) => { if (window.lottie) return ok(window.lottie); const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js'; s.onload = () => ok(window.lottie); s.onerror = () => ok(null); document.head.appendChild(s); }));
  async function load() {
    let d;
    try { d = await api.load(); } catch (e) { d = { success: false, error: e.message }; }
    if (!d || !d.success) { $q('.sb-grid').innerHTML = `<p style="color:var(--sb-muted)">${esc((d && d.error) || '불러오지 못했어요')}</p>`; return; }
    const items = d.items || {};
    SB = d.stickers.map((s, i) => ({ ...s, i, rec: items[s.name] || null }));
    const got = SB.filter((x) => x.rec), total = SB.length;
    $q('.sb-pct').textContent = (total ? Math.round(got.length / total * 100) : 0) + '%'; $q('.sb-cnt').textContent = `${got.length} / ${total}종`;
    requestAnimationFrame(() => { $q('.sb-arc').style.strokeDashoffset = 295.3 * (1 - (total ? got.length / total : 0)); });
    const cnt = got.reduce((a, x) => a + x.rec.cnt, 0), spoon = got.reduce((a, x) => a + x.rec.spoon, 0), ended = got.filter((x) => !x.active).length;
    $q('.sb-stats').innerHTML = `<div class="sb-stat"><b>${fmt(cnt)}개</b>받은 스티커</div><div class="sb-stat"><b>${fmt(spoon)}</b>누적 스푼</div>${ended ? `<div class="sb-stat"><b>${ended}종</b>판매 끝난 스티커</div>` : ''}`;
    const latest = [...got].sort((a, b) => b.rec.last - a.rec.last)[0];
    $q('.sb-latest').innerHTML = latest ? `<div class="sb-stk"><img src="${esc(latest.image)}" alt=""></div>최근 받은 스티커<br><b style="color:var(--sb-text)">${esc(latest.title)}</b>` : '';
    const M = [[10, '🎟️'], [30, '🎨'], [50, '🏅'], [100, '🏆'], [total, '👑']].filter(([n], i, a) => n <= total && (i === a.length - 1 || n < total));
    $q('.sb-track').innerHTML = `<div class="fill" style="width:${total ? got.length / total * 100 : 0}%"></div>` + M.map(([n, ic]) => `<div class="sb-mile ${got.length >= n ? 'ok' : ''}" style="left:${n / total * 100}%"><i>${ic}</i><span>${n === total ? '완성' : n + '종'}</span></div>`).join('');
    const nx = M.find(([n]) => got.length < n);
    $q('.sb-goal').textContent = nx ? `다음 단계까지 ${nx[0] - got.length}종` : '🎉 모든 스티커를 모았어요!';
    $q('.sb-note').textContent = d.since ? `${dt(d.since)}부터 모으는 중 · 선물카드 갤러리에 있던 기록도 같이 넣었어요` : '';
    draw();
  }
  function draw() {
    if (!SB) return;
    const cats = ['전체', ...new Set(SB.map((x) => x.category))];
    const T = [['all', '전체', SB.length], ['got', '받은 스티커', SB.filter((x) => x.rec).length], ['no', '못 받은 스티커', SB.filter((x) => !x.rec).length]];
    $q('.sb-tabs').innerHTML = T.map(([k, t, n]) => `<button type="button" data-k="${k}" class="${tab === k ? 'on' : ''}">${t}<em>${n}</em></button>`).join('');
    $q('.sb-cats').innerHTML = cats.map((c) => { const L = c === '전체' ? SB : SB.filter((x) => x.category === c); return `<button type="button" data-c="${esc(c)}" class="${cat === c ? 'on' : ''}">${esc(c)} ${L.filter((x) => x.rec).length}/${L.length}</button>`; }).join('');
    const q = $q('.sb-q').value.trim();
    let L = SB.filter((x) => (tab === 'all' || (tab === 'got') === !!x.rec) && (cat === '전체' || x.category === cat) && (!q || x.title.includes(q)));
    const so = $q('.sb-sort').value;
    if (so === 'price') L = [...L].sort((a, b) => b.price - a.price);
    if (so === 'cnt') L = [...L].sort((a, b) => ((b.rec && b.rec.cnt) || 0) - ((a.rec && a.rec.cnt) || 0));
    if (so === 'recent') L = [...L].sort((a, b) => ((b.rec && b.rec.last) || 0) - ((a.rec && a.rec.last) || 0));
    $q('.sb-grid').innerHTML = L.length ? L.map((x, k) => `<button type="button" class="sb-slot ${x.rec ? 'got' : 'no'}" data-i="${x.i}" style="--d:${(k % 7) * .3}s">${!x.active ? '<span class="end">판매 끝</span>' : ''}${x.rec ? `<span class="cnt">×${fmt(x.rec.cnt)}</span>` : ''}
      <div class="sb-stk"><img src="${esc(x.image)}" alt="" loading="lazy"></div><div class="nm">${esc(x.title)}</div><div class="pr">${fmt(x.price)} 스푼</div>
      <div class="fs">${x.rec ? '🥇 ' + esc(x.rec.first.n || x.rec.first.h || '?') : '아직 못 받았어요'}</div></button>`).join('') : '<p style="color:var(--sb-muted)">조건에 맞는 스티커가 없어요</p>';
  }
  function detail(x) {
    const r = x.rec, fans = r ? Object.values(r.fans || {}).sort((a, c) => c.c - a.c).slice(0, 5) : [];
    modal(`<div class="big sb-stk"><img src="${esc(x.image)}" alt=""></div><h3>${esc(x.title)}</h3><div class="mu">${esc(x.category)} · ${fmt(x.price)} 스푼${x.active ? '' : ' · <b style="color:#8b5cf6">판매 끝난 스티커</b>'}</div>
      ${r ? `<div class="kv"><div><b>${fmt(r.cnt)}개</b>받은 개수</div><div><b>${fmt(r.spoon)}</b>스푼</div><div><b>${Object.keys(r.fans || {}).length}명</b>보내준 사람</div></div>
        <div class="bx"><h4>👑 처음 보내준 사람</h4><b>${esc(r.first.n || r.first.h || '?')}</b>${r.first.h ? ` <span class="mu">@${esc(r.first.h)}</span>` : ''}<div class="mu" style="text-align:left">${dt(r.first.at)} · 이 스티커의 첫 주인공</div></div>
        <div class="bx"><h4>💛 많이 보내준 사람</h4><div class="rk">${fans.map((f, j) => `<div><span>${['🥇', '🥈', '🥉'][j] || j + 1}</span><span>${esc(f.n)}</span><span>${fmt(f.c)}개</span><span class="bar" style="width:${f.c / fans[0].c * 100}%"></span></div>`).join('')}</div></div>
        <div class="bx"><div class="row2"><span class="mu">처음 받은 날</span><span>${dt(r.first.at)}</span></div><div class="row2"><span class="mu">마지막으로 받은 날</span><span>${dt(r.last)}</span></div></div>`
      : `<p class="mu" style="line-height:1.7;margin-top:12px">🔒 아직 받아본 적 없는 스티커예요<br>처음 보내주는 사람이 <b>이 스티커의 첫 주인공</b>으로 남아요!</p>`}`, !r);
    if (r && x.lottie) loadLottie().then(async (lt) => {
      const box = dim && dim.querySelector('.big'); if (!lt || !box) return;
      try { const data = await (await fetch(x.lottie)).json(); if (!dim.classList.contains('on')) return; box.innerHTML = '<div class="lt"></div>'; lt.loadAnimation({ container: box.firstChild, renderer: 'svg', loop: true, autoplay: true, animationData: data }); } catch (_) {}
    });
  }
  function init(el, a) {
    root = el; api = a;
    if (!root.dataset.sbBound) {
      root.dataset.sbBound = '1';
      $q('.sb-tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { tab = b.dataset.k; draw(); } };
      $q('.sb-cats').onclick = (e) => { const b = e.target.closest('button'); if (b) { cat = b.dataset.c; draw(); } };
      $q('.sb-q').oninput = draw; $q('.sb-sort').onchange = draw;
      $q('.sb-grid').onclick = (e) => { const b = e.target.closest('.sb-slot'); if (b) detail(SB[+b.dataset.i]); };
      $q('.sb-reset').onclick = async () => { if (!confirm('스티커 컬렉션북 기록을 모두 지울까요? 처음 보내준 사람 기록도 같이 지워져요.')) return; try { await api.reset(); } catch (_) {} load(); };
    }
    load();
  }
  return { init };
})();
