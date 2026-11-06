// Player app. Plain JS, no build step. Three views (Photos, Map, Scores) plus a photo detail.
(() => {
  const POLL_MS = 15000;
  const LOC_MS = 30000;
  const DIFF = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full */ } },
    del: (k) => localStorage.removeItem(k),
  };

  const S = {
    token: store.get('token'),
    data: null, view: 'photos', filter: 'todo', detail: null,
    fix: null, locDenied: false, offset: 0, sig: '', map: null, layers: null,
  };
  if (store.get('big')) document.body.classList.add('big');

  // ---------- network ----------
  async function api(path, body, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
    try {
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(S.token ? { 'x-player': S.token } : {}) },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === 'not_joined') { resetPlayer(); throw Object.assign(new Error('not_joined'), { handled: true }); }
      if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { server: true });
      return data;
    } finally { clearTimeout(timer); }
  }

  function resetPlayer() {
    // Token no longer valid (e.g. a new game was created): start fresh.
    store.del('token');
    location.reload();
  }

  // ---------- location ----------
  function getFix(timeoutMs = 12000, goodEnough = 25) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no_geo'));
      let best = null;
      const done = (err) => {
        navigator.geolocation.clearWatch(watch); clearTimeout(timer);
        if (best) resolve(best); else reject(err || new Error('timeout'));
      };
      const watch = navigator.geolocation.watchPosition((p) => {
        const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() };
        if (!best || fix.acc <= best.acc) best = fix;
        gotFix(fix);
        if (fix.acc <= goodEnough) done();
      }, (err) => { if (err.code === 1) { S.locDenied = true; renderTop(); } done(err); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: timeoutMs });
      const timer = setTimeout(() => done(), timeoutMs);
    });
  }

  function gotFix(fix) {
    S.fix = fix; S.locDenied = false;
    const gid = S.data?.game?.id;
    if (gid) {
      const trail = store.get('trail-' + gid, []);
      const last = trail[trail.length - 1];
      if (!last || dist(last[0], last[1], fix.lat, fix.lng) > 15) {
        trail.push([fix.lat, fix.lng]); if (trail.length > 2000) trail.shift();
        store.set('trail-' + gid, trail);
      }
    }
    if (S.view === 'map') updateMap();
  }

  function dist(a, b, c, d) {
    const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 6371000;
  }

  function locTick() {
    if (document.hidden || !navigator.geolocation || !S.token) return;
    navigator.geolocation.getCurrentPosition(
      (p) => gotFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() }),
      (err) => { if (err.code === 1) { S.locDenied = true; renderTop(); } },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
  }

  // ---------- join ----------
  async function showJoin() {
    const app = $('#app');
    let info;
    try { info = await api('/api/game'); } catch (e) {
      app.innerHTML = `<div class="screen center stack"><h1>🦃 Photo Hunt</h1><p class="error">Can't reach the game. Check your signal.</p><button class="btn-primary btn-big" onclick="location.reload()">Try again</button></div>`;
      return;
    }
    if (!info.game) {
      app.innerHTML = `<div class="screen center stack"><h1>🦃 Photo Hunt</h1><p>No game is set up yet. Check back soon!</p><button class="btn-big" onclick="location.reload()">Refresh</button></div>`;
      return;
    }
    app.innerHTML = `
      <div class="screen stack">
        <h1>🦃 ${esc(info.game.name)}</h1>
        <p>Find the spots in the photos, then check in when you're there.</p>
        <form id="nameForm" class="stack">
          <label for="name">Your first name</label>
          <input id="name" autocomplete="given-name" autocapitalize="words" maxlength="30" required>
          <button class="btn-primary btn-big">Next</button>
        </form>
        <p id="joinErr" class="error"></p>
      </div>`;
    $('#name').focus();
    $('#nameForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const name = $('#name').value.trim();
      if (!name) return;
      try {
        const { matches } = await api('/api/lookup', { name });
        if (matches.length) askIsThisYou(name, matches, info); else pickTeam(name, info);
      } catch (e) { $('#joinErr').textContent = e.message; }
    };
  }

  function askIsThisYou(name, matches, info) {
    $('#app').innerHTML = `
      <div class="screen stack">
        <h2>Welcome back?</h2>
        ${matches.map((m) => `<button class="btn-big" data-id="${esc(m.id)}"><span class="swatch" style="background:${esc(m.color)}"></span> Yes, I'm ${esc(m.name)} on ${esc(m.team)} team</button>`).join('')}
        <button class="btn-big" id="newMe">No, I'm someone new</button>
      </div>`;
    document.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => finishJoin({ player_id: b.dataset.id }));
    $('#newMe').onclick = () => pickTeam(name, info);
  }

  function pickTeam(name, info) {
    $('#app').innerHTML = `
      <div class="screen stack">
        <h2>Hi ${esc(name)}! Pick your team</h2>
        ${info.teams.map((t) => `<button class="team-btn" style="background:${esc(t.color)}" data-team="${esc(t.id)}">${esc(t.name)} team <span style="opacity:.85;font-weight:400">· ${t.players} playing</span></button>`).join('')}
        <button class="btn-small" id="back">Back</button>
        <p id="joinErr" class="error"></p>
      </div>`;
    document.querySelectorAll('[data-team]').forEach((b) => b.onclick = () => finishJoin({ name, team_id: b.dataset.team }));
    $('#back').onclick = showJoin;
  }

  async function finishJoin(body) {
    try {
      const r = await api('/api/join', body);
      S.token = r.token; store.set('token', r.token);
      showLocationAsk();
    } catch (e) { const el = $('#joinErr'); if (el) el.textContent = e.message; else alert(e.message); }
  }

  function showLocationAsk() {
    $('#app').innerHTML = `
      <div class="screen stack">
        <h2>One more step</h2>
        <p>The game needs your location to check you in. Your phone will show a box like this. <b>Tap "Allow".</b></p>
        <div class="card" style="max-width:320px;margin:0 auto;text-align:center;background:#f2f2f7">
          <p style="font-size:.85em"><b>"${esc(location.host)}" Would Like to Use Your Current Location</b></p>
          <div class="row" style="justify-content:center;font-size:.85em"><span class="muted" style="padding:.4em 1em">Don't Allow</span><span style="padding:.4em 1em;border:3px solid var(--brand);border-radius:10px;font-weight:800">Allow</span></div>
        </div>
        <button class="btn-primary btn-big" id="askLoc">OK, ask me</button>
      </div>`;
    $('#askLoc').onclick = () => {
      $('#askLoc').disabled = true; $('#askLoc').textContent = 'Waiting…';
      getFix(10000, 100).catch(() => {}).finally(startGame);
    };
  }

  // ---------- main ----------
  function startGame() {
    $('#app').innerHTML = `
      <div class="topbar" id="top"></div>
      <main class="with-tabs">
        <div class="screen" id="vPhotos"></div>
        <div class="screen hidden" id="vMap"><div id="mapBanner"></div><div id="map"></div><div class="row" style="margin-top:.6em"><button class="grow" id="centerMe">📍 Show me on the map</button></div></div>
        <div class="screen hidden" id="vScores"></div>
        <div class="screen hidden detail" id="vDetail"></div>
      </main>
      <nav class="tabs">
        <button data-view="photos"><span class="ico">🖼️</span>Photos</button>
        <button data-view="map"><span class="ico">🗺️</span>Map</button>
        <button data-view="scores"><span class="ico">🏆</span>Scores</button>
      </nav>
      <input type="file" accept="image/*" capture="environment" id="cam" class="hidden">`;
    document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => go(b.dataset.view));
    $('#centerMe').onclick = () => { if (S.fix && S.map) S.map.setView([S.fix.lat, S.fix.lng], 17); else locTick(); };
    $('#cam').onchange = onPhotoTaken;
    go('photos');
    poll();
    setInterval(poll, POLL_MS);
    setInterval(locTick, LOC_MS);
    setInterval(renderClock, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); locTick(); } });
    window.addEventListener('online', flushQueue);
    window.addEventListener('popstate', () => { if (S.detail) closeDetail(true); });
  }

  function go(view) {
    S.view = view; S.detail = null;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $('#vPhotos').classList.toggle('hidden', view !== 'photos');
    $('#vMap').classList.toggle('hidden', view !== 'map');
    $('#vScores').classList.toggle('hidden', view !== 'scores');
    $('#vDetail').classList.add('hidden');
    if (view === 'map') openMap();
    renderAll(true);
    window.scrollTo(0, 0);
  }

  async function poll() {
    if (!S.token) return;
    try {
      const body = S.fix && Date.now() - S.fix.at < 60000 ? { lat: S.fix.lat, lng: S.fix.lng, acc: S.fix.acc } : {};
      const d = await api('/api/poll', body, { timeout: 12000 });
      S.offset = d.now - Date.now();
      S.data = d;
      renderAll();
      flushQueue();
    } catch (e) {
      if (!e.handled) renderTop(true);
    }
  }

  const myTeam = () => S.data?.teams.find((t) => t.id === S.data.me.team_id);
  const findFor = (photoId) => {
    const mine = S.data.finds.filter((f) => f.photo_id === photoId && f.team_id === S.data.me.team_id);
    return mine.find((f) => f.status === 'auto' || f.status === 'approved') || mine.find((f) => f.status === 'pending') || null;
  };

  function renderAll(force) {
    if (!S.data) return;
    renderTop();
    const sig = JSON.stringify([S.data.finds.map((f) => [f.id, f.status]), S.data.photos.map((p) => p.id + p.points + p.difficulty + (p.hint || '')), S.data.teams.map((t) => t.score + t.name), S.data.game.status, S.filter]);
    if (!force && sig === S.sig) return;
    S.sig = sig;
    renderPhotos(); renderScores();
    if (S.detail) renderDetail();
    if (S.view === 'map') updateMap();
  }

  function rankText(n) { return n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'); }

  function clockText() {
    const g = S.data?.game;
    if (!g) return '';
    if (g.status === 'setup') return 'Starts soon';
    if (g.status === 'ended') return 'Game over';
    if (!g.ends_at) return 'Game on!';
    const left = Math.max(0, g.ends_at - (Date.now() + S.offset));
    if (!left) return 'Game over';
    const m = Math.floor(left / 60000), h = Math.floor(m / 60), s = Math.floor(left / 1000) % 60;
    return (h ? `${h}:${String(m % 60).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`) + ' left';
  }
  function renderClock() { const el = $('#clock'); if (el) el.textContent = clockText(); }

  function renderTop(offline) {
    const top = $('#top');
    if (!top || !S.data) return;
    const t = myTeam();
    const rank = S.data.teams.indexOf(t) + 1;
    top.innerHTML = `
      <span class="team"><span class="swatch" style="background:${esc(t?.color)}"></span>${esc(t?.name)}</span>
      <span>${t?.score ?? 0} pts · ${rankText(rank)}</span>
      <span class="grow" id="clock">${offline ? '⚠️ No signal' : clockText()}</span>
      <button id="bigBtn" aria-label="Bigger text">Aa</button>`;
    $('#bigBtn').onclick = () => { const on = document.body.classList.toggle('big'); store.set('big', on); };
  }

  function banners() {
    const g = S.data.game;
    let html = '';
    if (S.locDenied) html += `<div class="banner"><b>Location is off.</b> You need it to check in. On iPhone: Settings → Privacy → Location Services → Safari Websites → "While Using". Then reload this page.</div>`;
    if (g.status === 'setup') html += `<div class="banner">The game hasn't started yet. You can look at the photos now.</div>`;
    if (g.status === 'ended') html += `<div class="banner"><b>Game over!</b> Head to the meet-up spot. See the Scores tab.</div>`;
    const q = store.get('queue', []);
    if (q.length) html += `<div class="banner">📶 ${q.length} check-in${q.length > 1 ? 's' : ''} waiting for signal. We'll send ${q.length > 1 ? 'them' : 'it'} automatically.</div>`;
    return html;
  }

  function renderPhotos() {
    const el = $('#vPhotos');
    const photos = S.data.photos;
    const found = photos.filter((p) => findFor(p.id)?.status !== undefined && findFor(p.id).status !== 'pending');
    const todo = photos.filter((p) => !found.includes(p));
    const list = S.filter === 'todo' ? todo : found;
    el.innerHTML = `
      ${banners()}
      <div class="filters">
        <button data-f="todo" class="${S.filter === 'todo' ? 'on' : ''}">To find (${todo.length})</button>
        <button data-f="found" class="${S.filter === 'found' ? 'on' : ''}">Found (${found.length})</button>
      </div>
      ${list.length ? '' : `<p class="center muted">${S.filter === 'todo' ? (photos.length ? 'You found them all! 🎉' : 'No photos yet.') : 'Nothing found yet. Get hunting!'}</p>`}
      <div class="grid">
        ${list.map((p) => {
          const f = findFor(p.id);
          return `<button class="tile" data-photo="${esc(p.id)}">
            <img src="${esc(p.thumb)}" alt="${esc(p.title || 'Photo')}" loading="lazy">
            ${f ? `<div class="done ${f.status === 'pending' ? 'wait' : ''}"><span class="check">${f.status === 'pending' ? '⏳' : '✓'}</span>${f.status === 'pending' ? 'Judge checking' : 'Found by ' + esc(f.player_name || 'judge')}</div>` : ''}
            <div class="meta"><span class="pill diff-${p.difficulty}">${DIFF[p.difficulty]}</span><b>${p.points} pt${p.points === 1 ? '' : 's'}</b></div>
          </button>`;
        }).join('')}
      </div>`;
    el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; renderAll(true); });
    el.querySelectorAll('[data-photo]').forEach((b) => b.onclick = () => openDetail(b.dataset.photo));
  }

  function openDetail(pid) {
    S.detail = pid;
    history.pushState({ detail: pid }, '');
    $('#vPhotos').classList.add('hidden');
    $('#vDetail').classList.remove('hidden');
    renderDetail();
    window.scrollTo(0, 0);
    // Warm up GPS so the check-in is quick.
    if (S.data.game.status === 'live') locTick();
  }
  function closeDetail(fromPop) {
    S.detail = null;
    $('#vDetail').classList.add('hidden');
    $('#vPhotos').classList.remove('hidden');
    if (!fromPop) history.back();
  }

  function renderDetail() {
    const p = S.data.photos.find((x) => x.id === S.detail);
    const el = $('#vDetail');
    if (!p) { closeDetail(); return; }
    const f = findFor(p.id);
    const live = S.data.game.status === 'live';
    el.innerHTML = `
      <div class="stack">
        <button id="backBtn">← Back to photos</button>
        <img class="full" src="${esc(p.image)}" alt="${esc(p.title || 'Photo')}">
        <p class="muted center" style="font-size:.8em">Pinch the photo to zoom in.</p>
        <div class="row"><span class="pill diff-${p.difficulty}">${DIFF[p.difficulty]}</span><b>${p.points} point${p.points === 1 ? '' : 's'}</b>${p.title ? `<span class="grow">${esc(p.title)}</span>` : ''}</div>
        ${p.hint ? `<div class="banner"><b>Hint:</b> ${esc(p.hint)}</div>` : ''}
        ${f && f.status !== 'pending' ? `<div class="banner" style="background:#e8f5ec;border-color:#9fd3ae"><b>✓ Your team found this</b> (${esc(f.player_name || 'judge')})</div>`
          : f ? `<div class="banner"><b>⏳ The judge is checking this one.</b></div>`
          : live ? `<button class="btn-primary btn-big" id="foundBtn">📸 I found it!</button>
                    <button class="btn-small" id="noPicBtn" style="width:100%">Check in without a picture</button>`
          : `<div class="banner">${S.data.game.status === 'setup' ? "You can check in once the game starts." : 'The game is over.'}</div>`}
      </div>`;
    $('#backBtn').onclick = () => closeDetail();
    const fb = $('#foundBtn');
    if (fb) fb.onclick = () => { S.warm = getFix(15000, 20); S.pending = { photo_id: p.id }; $('#cam').value = ''; $('#cam').click(); };
    const nb = $('#noPicBtn');
    if (nb) nb.onclick = () => { S.warm = getFix(15000, 20); S.pending = { photo_id: p.id }; checkIn(null); };
  }

  // ---------- check-in ----------
  async function onPhotoTaken(ev) {
    const file = ev.target.files[0];
    if (!file || !S.pending) return;
    checkIn(file);
  }

  async function checkIn(file) {
    modal(`<div class="spinner"></div><h2>Checking where you are…</h2><p class="muted">Hold still for a few seconds.</p>`);
    let proof = null;
    if (file) proof = await shrink(file, 900, 0.6).catch(() => null);
    let fix;
    try { fix = await S.warm; } catch {
      modal(`<div class="big-emoji">📍</div><h2>We couldn't find your location</h2>
        <p>Make sure Location is turned on for this website, step outside if you can, and try again.</p>
        <button class="btn-primary btn-big" data-close>OK</button>`);
      return;
    }
    const attempt = { photo_id: S.pending.photo_id, lat: fix.lat, lng: fix.lng, acc: fix.acc, ask_judge: 0, proof: proof ? await blobToDataUrl(proof) : null, at: Date.now() };
    send(attempt);
  }

  async function send(attempt, fromQueue) {
    const fd = new FormData();
    fd.append('photo_id', attempt.photo_id);
    fd.append('lat', attempt.lat); fd.append('lng', attempt.lng); fd.append('acc', attempt.acc ?? '');
    fd.append('ask_judge', attempt.ask_judge ? '1' : '0');
    if (attempt.proof) fd.append('proof', dataUrlToBlob(attempt.proof), 'proof.jpg');
    let r;
    try { r = await api('/api/checkin', fd, { timeout: 30000 }); } catch (e) {
      if (e.handled) return true;
      if (e.server) { modal(`<div class="big-emoji">😕</div><h2>${esc(e.message)}</h2><button class="btn-primary btn-big" data-close>OK</button>`); return true; }
      // No signal: save and send later.
      if (!fromQueue) {
        const q = store.get('queue', []); q.push(attempt); store.set('queue', q);
        modal(`<div class="big-emoji">📶</div><h2>No signal right now</h2><p>We saved your check-in and will send it as soon as you're back online. Keep hunting!</p><button class="btn-primary btn-big" data-close>OK</button>`);
        renderAll(true);
      }
      return false;
    }
    showResult(r, attempt);
    poll();
    return true;
  }

  async function flushQueue() {
    const q = store.get('queue', []);
    if (!q.length || S.flushing) return;
    S.flushing = true;
    try {
      while (q.length) {
        const ok = await send(q[0], true);
        if (!ok) break;
        q.shift(); store.set('queue', q);
      }
    } finally { S.flushing = false; renderAll(true); }
  }

  function showResult(r, attempt) {
    const away = (m) => m >= 1000 ? `${(m / 1609).toFixed(1)} miles` : `${Math.round(m / 10) * 10 || m} m (${Math.round(m * 3.28)} ft)`;
    if (r.result === 'auto') {
      modal(`<div class="big-emoji">🎉</div><h1>Found it!</h1><h2>+${r.points} point${r.points === 1 ? '' : 's'}</h2><button class="btn-primary btn-big" data-close data-back>Back to photos</button>`);
      confetti();
    } else if (r.result === 'pending') {
      modal(`<div class="big-emoji">🧐</div><h2>Close! The judge will check.</h2><p>You'll see it on your photos once it's approved.</p><button class="btn-primary btn-big" data-close data-back>Back to photos</button>`);
    } else if (r.result === 'far') {
      modal(`<div class="big-emoji">🔍</div><h2>Not quite.</h2><p>You're about <b>${away(r.distance)}</b> away.</p>
        <button class="btn-primary btn-big" data-close>Keep looking</button>
        <button class="btn-big" id="askJudge" style="margin-top:.6em">Ask the judge</button>`);
      $('#askJudge').onclick = () => { modal('<div class="spinner"></div><h2>Sending to the judge…</h2>'); send({ ...attempt, ask_judge: 1 }); };
    } else if (r.result === 'already') {
      modal(`<div class="big-emoji">✅</div><h2>Your team already found this one.</h2><button class="btn-primary btn-big" data-close data-back>Back to photos</button>`);
    } else if (r.result === 'pending_exists') {
      modal(`<div class="big-emoji">⏳</div><h2>The judge is already checking this one for your team.</h2><button class="btn-primary btn-big" data-close>OK</button>`);
    } else if (r.result === 'not_started') {
      modal(`<div class="big-emoji">⏰</div><h2>The game hasn't started yet.</h2><button class="btn-primary btn-big" data-close>OK</button>`);
    } else if (r.result === 'ended') {
      modal(`<div class="big-emoji">🏁</div><h2>The game is over.</h2><p>Head to the meet-up spot!</p><button class="btn-primary btn-big" data-close>OK</button>`);
    }
  }

  function modal(html) {
    let o = $('#modal');
    if (!o) { o = document.createElement('div'); o.id = 'modal'; o.className = 'overlay'; document.body.appendChild(o); }
    o.innerHTML = `<div class="card stack">${html}</div>`;
    o.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => { o.remove(); if (b.hasAttribute('data-back') && S.detail) closeDetail(); });
  }

  // ---------- images ----------
  async function shrink(file, max, quality) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    }
    const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  }
  const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  function dataUrlToBlob(u) {
    const [head, b64] = u.split(','); const bin = atob(b64); const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: head.match(/:(.*?);/)[1] });
  }

  // ---------- scores ----------
  function renderScores() {
    const el = $('#vScores');
    const g = S.data.game;
    const winner = g.status === 'ended' && S.data.teams[0];
    el.innerHTML = `
      ${winner ? `<div class="card center" style="margin-bottom:1em"><div class="big-emoji">🏆</div><h1 style="color:${esc(winner.color)}">${esc(winner.name)} team wins!</h1><p>${winner.score} points</p></div>` : ''}
      <h2>Scores</h2>
      ${S.data.teams.map((t, i) => `
        <div class="score-row ${t.id === S.data.me.team_id ? 'me' : ''}">
          <span class="rank">${rankText(i + 1)}</span>
          <span class="swatch" style="background:${esc(t.color)}"></span>
          <span class="grow" style="flex:1"><b>${esc(t.name)}</b><br><span class="muted" style="font-size:.8em">${t.found} found · ${t.players} player${t.players === 1 ? '' : 's'}</span></span>
          <span class="pts">${t.score}</span>
        </div>`).join('')}
      <p class="muted" style="margin-top:1em;font-size:.85em">You're playing as <b>${esc(S.data.me.name)}</b>. ${S.data.photos.length} photos in this game.</p>`;
  }

  // ---------- map ----------
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (S.leafletLoading) return S.leafletLoading;
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
    S.leafletLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return S.leafletLoading;
  }

  async function openMap() {
    locTick();
    try { await loadLeaflet(); } catch { $('#mapBanner').innerHTML = '<div class="banner">The map needs a signal to load. Try again in a moment.</div>'; return; }
    if (!S.map) {
      S.map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(S.map);
      S.layers = { boundary: L.layerGroup().addTo(S.map), trail: L.layerGroup().addTo(S.map), pins: L.layerGroup().addTo(S.map), me: L.layerGroup().addTo(S.map) };
      S.mapFitted = false;
    }
    setTimeout(() => { S.map.invalidateSize(); updateMap(); }, 50);
  }

  function updateMap() {
    if (!S.map || !S.data) return;
    const { boundary, trail, pins, me } = S.layers;
    boundary.clearLayers(); trail.clearLayers(); pins.clearLayers(); me.clearLayers();
    let poly;
    if (S.data.game.boundary) {
      poly = L.polygon(S.data.game.boundary, { color: '#b4471f', weight: 4, dashArray: '8 6', fillOpacity: 0.04 }).addTo(boundary);
    }
    const t = store.get('trail-' + S.data.game.id, []);
    if (t.length > 1) L.polyline(t, { color: '#1d4ed8', weight: 4, opacity: 0.25 }).addTo(trail);
    const color = myTeam()?.color || '#15803d';
    S.data.finds.filter((f) => f.team_id === S.data.me.team_id && f.lat != null).forEach((f) => {
      const p = S.data.photos.find((x) => x.id === f.photo_id);
      L.circleMarker([f.lat, f.lng], { radius: 11, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
        .bindPopup(`<b>${esc(p?.title || 'Found')}</b><br>${esc(f.player_name || '')}${f.status === 'pending' ? ' (judge checking)' : ''}`).addTo(pins);
    });
    if (S.fix) {
      L.circle([S.fix.lat, S.fix.lng], { radius: S.fix.acc, color: '#2563eb', weight: 1, fillOpacity: 0.1 }).addTo(me);
      L.circleMarker([S.fix.lat, S.fix.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).bindTooltip('You').addTo(me);
    }
    if (!S.mapFitted) {
      if (poly) { S.map.fitBounds(poly.getBounds(), { padding: [20, 20] }); S.mapFitted = true; }
      else if (S.fix) { S.map.setView([S.fix.lat, S.fix.lng], 16); S.mapFitted = true; }
    }
  }

  // ---------- confetti ----------
  function confetti() {
    const c = document.createElement('canvas'); c.id = 'confetti'; document.body.appendChild(c);
    c.width = innerWidth; c.height = innerHeight;
    const ctx = c.getContext('2d');
    const colors = ['#d62828', '#f77f00', '#fcbf49', '#15803d', '#1d4ed8', '#b4471f'];
    const bits = Array.from({ length: 140 }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5, vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, r: Math.random() * 6.28, s: 6 + Math.random() * 6, col: colors[(Math.random() * colors.length) | 0] }));
    const start = performance.now();
    (function frame(tm) {
      ctx.clearRect(0, 0, c.width, c.height);
      bits.forEach((b) => { b.x += b.vx; b.y += b.vy; b.vy += 0.05; b.r += 0.1; ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.col; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore(); });
      if (tm - start < 3000) requestAnimationFrame(frame); else c.remove();
    })(start);
  }

  // ---------- boot ----------
  if (S.token) startGame(); else showJoin();
})();
