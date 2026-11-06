// Player app. Plain JS, no build step. Three views (Photos, Map, Scores) plus a photo detail.
(() => {
  const POLL_MS = 15000;
  const LOC_MS = 30000;
  const DIFF = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  // Base map: Esri Topographic (calm gray, street names, subway stations, house numbers up close).
  // If its tiles keep failing, switch to OpenStreetMap automatically.
  const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
  const TILE_ATTR = '© <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, USGS, OpenStreetMap';
  const BACKUP_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const BACKUP_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  function addBaseMap(map) {
    const opts = { maxZoom: 20, maxNativeZoom: 19 };
    map.attributionControl.setPrefix(false); // keep the credit line short on phones
    const main = L.tileLayer(TILES, { ...opts, attribution: TILE_ATTR }).addTo(map);
    let errors = 0, loaded = 0;
    main.on('tileload', () => { loaded++; });
    main.on('tileerror', () => {
      if (++errors >= 6 && loaded < errors && map.hasLayer(main)) {
        map.removeLayer(main);
        L.tileLayer(BACKUP_TILES, { ...opts, attribution: BACKUP_ATTR }).addTo(map);
      }
    });
  }
  const ICON = {
    photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
    scores: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  };
  const $ = (sel) => document.querySelector(sel);
  const diffTag = (d) => `<span class="diff"><span class="bullet d${d}">${'EMH'[d - 1]}</span>${DIFF[d]}</span>`;
  const ptsText = (n) => `${n} pt${n === 1 ? '' : 's'}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }, // false = storage full
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
      // 4xx = the server said no (don't retry). 5xx = treat like no signal and retry later.
      if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { server: res.status < 500, status: res.status });
      return data;
    } finally { clearTimeout(timer); }
  }

  function resetPlayer() {
    // Token no longer valid (e.g. a new game was created): start fresh.
    store.del('token');
    store.del('queue'); // queued check-ins belong to the old game
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
      }, (err) => { if (err.code === 1) { S.locDenied = true; renderAll(true); } done(err); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: timeoutMs });
      const timer = setTimeout(() => done(), timeoutMs);
    });
  }

  function gotFix(fix) {
    const wasDenied = S.locDenied;
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
    if (wasDenied) renderAll(true);
    if (S.view === 'map') updateMe();
  }

  function dist(a, b, c, d) {
    const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 6371000;
  }

  function locTick() {
    if (document.hidden || !navigator.geolocation || !S.token) return;
    navigator.geolocation.getCurrentPosition(
      (p) => gotFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() }),
      (err) => { if (err.code === 1 && !S.locDenied) { S.locDenied = true; renderAll(true); } },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
  }

  // ---------- join ----------
  function hero(title, sub) {
    return `<div class="join-title"><div class="turkey">🦃</div><h1>${esc(title)}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div>`;
  }

  async function showJoin() {
    const app = $('#app');
    let info;
    try { info = await api('/api/game'); } catch (e) {
      app.innerHTML = `<div class="screen stack">${hero('Photo Hunt')}<p class="note center">Can't reach the game. Check your signal.</p><button class="btn-primary btn-big" onclick="location.reload()">Try again</button></div>`;
      return;
    }
    if (!info.game) {
      app.innerHTML = `<div class="screen stack">${hero('Photo Hunt', 'No game is set up yet. Check back soon!')}<button class="btn-big" onclick="location.reload()">Refresh</button></div>`;
      return;
    }
    app.innerHTML = `
      <div class="screen stack">
        ${hero(info.game.name, 'Find the spots in the photos. Check in when you get there. Harder photos are worth more.')}
        <form id="nameForm" class="card stack">
          <label for="name">Your first name</label>
          <input id="name" autocomplete="given-name" autocapitalize="words" maxlength="30" required placeholder="e.g. Mike">
          <button class="btn-primary btn-big">Next</button>
          <p id="joinErr" class="error"></p>
        </form>
      </div>`;
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
        ${hero('Welcome back?')}
        ${matches.map((m) => `<button class="team-btn" style="background:${esc(m.color)}" data-id="${esc(m.id)}"><span>Yes, I'm ${esc(m.name)}</span><small>${esc(m.team)} team</small></button>`).join('')}
        <button class="btn-big" id="newMe">No, I'm someone new</button>
      </div>`;
    document.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => finishJoin({ player_id: b.dataset.id }));
    $('#newMe').onclick = () => pickTeam(name, info);
  }

  function pickTeam(name, info) {
    $('#app').innerHTML = `
      <div class="screen stack">
        <h1>Hi ${esc(name)}!</h1>
        <p class="muted">Pick your team.</p>
        ${info.teams.map((t) => `
          <button class="team-btn" style="background:${esc(t.color)}" data-team="${esc(t.id)}">
            <span>${esc(t.name)}</span>
            <small>${t.members?.length ? esc(t.members.join(', ')) : 'No one yet'}</small>
          </button>`).join('')}
        <button class="btn-ghost" id="back">← Back</button>
        <p id="joinErr" class="error"></p>
      </div>`;
    document.querySelectorAll('[data-team]').forEach((b) => b.onclick = () => finishJoin({ name, team_id: b.dataset.team }));
    $('#back').onclick = showJoin;
  }

  async function finishJoin(body) {
    if (S.joining) return;
    S.joining = true;
    document.querySelectorAll('.team-btn, #newMe').forEach((b) => { b.disabled = true; });
    try {
      const r = await api('/api/join', body);
      S.token = r.token; store.set('token', r.token);
      showLocationAsk();
    } catch (e) {
      const el = $('#joinErr'); if (el) el.textContent = e.message; else alert(e.message);
      document.querySelectorAll('.team-btn, #newMe').forEach((b) => { b.disabled = false; });
    } finally { S.joining = false; }
  }

  function showLocationAsk() {
    $('#app').innerHTML = `
      <div class="screen stack">
        ${hero('One more step', 'The game uses your location to check you in. Your phone will ask. <b>Tap "Allow".</b>')}
        <div class="allow-mock">
          <b>Allow "${esc(location.host)}" to use your current location?</b>
          <div class="btns"><span>Don't Allow</span><span>Allow</span></div>
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
      <header class="sign" id="top"></header>
      <main class="with-tabs">
        <div class="screen" id="vPhotos"></div>
        <div class="screen hidden" id="vMap">
          <div id="mapNote"></div>
          <div class="map-wrap">
            <div id="map"></div>
            <div class="map-key"><div><span class="swatch" style="background:#0039a6"></span> You</div><div id="legendTeam"></div><div><span class="swatch" style="background:#e8590c"></span> Play area edge</div></div>
            <div class="map-buttons"><button id="fitArea">Whole area</button><button class="btn-primary" id="centerMe">Show me</button></div>
          </div>
        </div>
        <div class="screen hidden" id="vScores"></div>
        <div class="screen hidden detail" id="vDetail"></div>
      </main>
      <nav class="tabs">
        ${['photos', 'map', 'scores'].map((v) => `<button data-view="${v}">${ICON[v]}${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
      </nav>
      <input type="file" accept="image/*" capture="environment" id="cam" class="hidden">`;
    document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => go(b.dataset.view));
    $('#fitArea').onclick = () => fitArea();
    $('#centerMe').onclick = () => { if (S.fix && S.map) S.map.flyTo([S.fix.lat, S.fix.lng], 17, { duration: 0.6 }); else locTick(); };
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
    if (S.detail) { S.detail = null; history.back(); } // drop the photo's history entry
    S.view = view;
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
      S.data = d; S.offline = false;
      renderAll();
      flushQueue();
    } catch (e) {
      if (!e.handled) {
        S.offline = true; renderTop();
        if (!S.data) $('#vPhotos').innerHTML = '<div class="empty">Can\'t reach the game right now. Check your signal. Trying again…</div>';
      }
    }
  }

  const myTeam = () => S.data?.teams.find((t) => t.id === S.data.me.team_id);
  const numOf = (pid) => S.data.photos.findIndex((p) => p.id === pid) + 1;
  const findFor = (photoId) => {
    const mine = S.data.finds.filter((f) => f.photo_id === photoId && f.team_id === S.data.me.team_id);
    return mine.find((f) => f.status === 'auto' || f.status === 'approved') || mine.find((f) => f.status === 'pending') || null;
  };

  function renderAll(force) {
    if (!S.data) return;
    renderTop();
    const sig = JSON.stringify([S.data.finds.map((f) => [f.id, f.status]), S.data.photos.map((p) => p.id + p.points + p.difficulty + (p.hint || '')), S.data.teams.map((t) => [t.score, t.name, t.members]), S.data.game.status, S.filter, S.locDenied]);
    if (!force && sig === S.sig) return;
    S.sig = sig;
    renderPhotos(); renderScores();
    if (S.detail) renderDetail();
    if (S.view === 'map') updateMap();
  }

  function rankText(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function clockState() {
    const g = S.data?.game;
    if (!g) return ['', ''];
    if (g.status === 'setup') return ['Starts soon', ''];
    if (g.status === 'ended') return ['Game over', 'over'];
    if (!g.ends_at) return ['Game on', 'live'];
    const left = Math.max(0, g.ends_at - (Date.now() + S.offset));
    if (!left) return ['Game over', 'over'];
    const m = Math.floor(left / 60000), h = Math.floor(m / 60), s = Math.floor(left / 1000) % 60;
    return [(h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`) + ' left', 'live'];
  }
  function renderClock() {
    const el = $('#clock'); if (!el || S.offline) return;
    const [t, c] = clockState(); el.textContent = t; el.className = 'clock ' + c;
  }

  function renderTop() {
    const top = $('#top');
    if (!top || !S.data) return;
    const t = myTeam();
    const rank = S.data.teams.indexOf(t) + 1;
    const total = S.data.photos.length;
    const [ct, cc] = clockState();
    top.innerHTML = `
      <div class="top">
        <span class="team"><span class="bullet" style="background:${esc(t?.color)}">${esc((t?.name || '?')[0])}</span>${esc(t?.name)} team</span>
        <span class="${S.offline ? 'clock over' : 'clock ' + cc}" id="clock">${S.offline ? 'No signal' : ct}</span>
        <button class="text-btn" id="bigBtn" aria-label="Bigger text">Aa</button>
      </div>
      <div class="score"><b>${t?.score ?? 0}</b><span>pts · ${rankText(rank)} of ${S.data.teams.length}</span><span class="grow" style="text-align:right">${t?.found ?? 0} of ${total} found</span></div>
      <div class="progress"><span style="width:${total ? (100 * (t?.found || 0)) / total : 0}%"></span></div>`;
    $('#bigBtn').onclick = () => { const on = document.body.classList.toggle('big'); store.set('big', on); };
  }

  function notes() {
    const g = S.data.game;
    let html = '';
    if (S.locDenied) html += `<div class="note">📍 <b>Location is off.</b> You need it to check in.<br><span class="small">iPhone: Settings → Privacy → Location Services → Safari Websites → While Using. Android: tap the icon left of the web address → Permissions → Location. Then reload.</span></div>`;
    if (g.status === 'setup') html += `<div class="note info">⏳ The game hasn't started yet. Look over the photos and plan your route!</div>`;
    if (g.status === 'ended') html += `<div class="note good">🏁 <b>Game over!</b> Head to the meet-up spot. See Scores.</div>`;
    const q = store.get('queue', []);
    if (q.length) html += `<div class="note">📶 ${q.length} check-in${q.length > 1 ? 's' : ''} waiting for signal. We'll send ${q.length > 1 ? 'them' : 'it'} automatically.</div>`;
    return html ? `<div class="stack" style="margin-bottom:1em">${html}</div>` : '';
  }

  function tile(p) {
    const f = findFor(p.id);
    const done = f && f.status !== 'pending';
    return `<button class="tile ${done ? 'found' : ''}" data-photo="${esc(p.id)}">
      <img src="${esc(p.thumb)}" alt="Photo ${numOf(p.id)}" loading="lazy">
      <span class="num">#${numOf(p.id)}</span>
      ${f ? `<div class="badge ${done ? '' : 'wait'}"><span class="check">${done ? '✓' : '?'}</span>${done ? 'Found by ' + esc(f.player_name || 'judge') : 'Judge checking'}</div>` : ''}
      <div class="meta">${diffTag(p.difficulty)}<b>${ptsText(p.points)}</b></div>
    </button>`;
  }

  function renderPhotos() {
    const el = $('#vPhotos');
    const photos = S.data.photos;
    const isFound = (p) => { const f = findFor(p.id); return f && f.status !== 'pending'; };
    const found = photos.filter(isFound), todo = photos.filter((p) => !isFound(p));
    const list = S.filter === 'todo' ? todo : found;
    el.innerHTML = `
      ${notes()}
      <div class="seg" style="margin-bottom:.8em">
        <button data-f="todo" class="${S.filter === 'todo' ? 'on' : ''}">To find · ${todo.length}</button>
        <button data-f="found" class="${S.filter === 'found' ? 'on' : ''}">Found · ${found.length}</button>
      </div>
      ${list.length ? `<div class="grid">${list.map(tile).join('')}</div>` : `<div class="empty">${S.filter === 'todo' ? (photos.length ? 'Your team found them all!' : 'No photos yet.') : 'Nothing found yet. Get hunting!'}</div>`}
      <p class="muted small center" style="margin-top:1.2em">Every team can find every photo. Easy 1 pt, Medium 2, Hard 3.</p>`;
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
    if (S.data.game.status === 'live') locTick(); // warm up GPS
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
    const others = S.data.teams.filter((t) => t.id !== S.data.me.team_id && S.data.finds.some((x) => x.photo_id === p.id && x.team_id === t.id && x.status !== 'pending'));
    el.innerHTML = `
      <div class="detail-top"><button class="btn-small" id="backBtn">← Back to photos</button><span class="grow"></span>${diffTag(p.difficulty)}<b>${ptsText(p.points)}</b></div>
      <img class="full" src="${esc(p.image)}" alt="Photo ${numOf(p.id)}">
      <h2 style="margin:.6em 0 .2em">#${numOf(p.id)}${p.title ? ' · ' + esc(p.title) : ''}</h2>
      <p class="muted small">Pinch the photo to zoom in.${others.length ? ` Also found by ${others.map((t) => esc(t.name)).join(', ')}.` : ''}</p>
      ${p.hint ? `<div class="note info"><b>Hint:</b> ${esc(p.hint)}</div>` : ''}
      <div class="action">
        ${f && f.status !== 'pending' ? `<div class="note good"><b>✓ Your team found this.</b> ${esc(f.player_name || 'Judge')}</div>`
          : f ? `<div class="note"><b>The judge is checking this one.</b></div>`
          : live ? `<button class="btn-primary btn-big" id="foundBtn">I found it!</button>
                    <button class="btn-ghost btn-big" id="noPicBtn">Check in without a picture</button>`
          : `<div class="note info">${S.data.game.status === 'setup' ? 'You can check in once the game starts.' : 'The game is over.'}</div>`}
      </div>`;
    $('#backBtn').onclick = () => closeDetail();
    const fb = $('#foundBtn');
    if (fb) fb.onclick = () => { S.warm = getFix(15000, 20); S.pending = { photo_id: p.id }; $('#cam').value = ''; $('#cam').click(); };
    const nb = $('#noPicBtn');
    if (nb) nb.onclick = () => { S.warm = getFix(15000, 20); S.pending = { photo_id: p.id }; checkIn(null); };
  }

  // ---------- check-in ----------
  function onPhotoTaken(ev) {
    const file = ev.target.files[0];
    if (file && S.pending) checkIn(file);
  }

  async function checkIn(file) {
    sheet(`<div class="spinner"></div><h2>Checking where you are…</h2><p class="muted">Hold still for a few seconds.</p>`);
    let proof = null;
    if (file) proof = await shrink(file, 900, 0.6).catch(() => null);
    let fix;
    try { fix = await S.warm; } catch {
      // Fall back to a recent background fix, then one more try, before giving up.
      if (S.fix && Date.now() - S.fix.at < 90000) fix = S.fix;
      else fix = await getFix(10000, 50).catch(() => null);
    }
    if (!fix) {
      sheet(`<div class="emoji">📍</div><h2>We couldn't find your location</h2>
        <p class="muted">Make sure Location is on for this website, step out from under any awning, and try again.</p>
        <button class="btn-primary btn-big" data-close>OK</button>`);
      return;
    }
    // "at" is in server time so a check-in sent late (no signal) still counts if it was taken before the end.
    const attempt = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), photo_id: S.pending.photo_id, lat: fix.lat, lng: fix.lng, acc: fix.acc, ask_judge: 0, proof: proof ? await blobToDataUrl(proof) : null, at: Date.now() + S.offset };
    send(attempt);
  }

  async function send(attempt, fromQueue) {
    const fd = new FormData();
    fd.append('photo_id', attempt.photo_id);
    fd.append('lat', attempt.lat); fd.append('lng', attempt.lng); fd.append('acc', attempt.acc ?? '');
    fd.append('ask_judge', attempt.ask_judge ? '1' : '0');
    fd.append('at', Math.round(attempt.at));
    if (attempt.proof) fd.append('proof', dataUrlToBlob(attempt.proof), 'proof.jpg');
    let r;
    try { r = await api('/api/checkin', fd, { timeout: 30000 }); } catch (e) {
      if (e.handled) return true;
      if (e.server) { sheet(`<div class="emoji">😕</div><h2>${esc(e.message)}</h2><button class="btn-primary btn-big" data-close>OK</button>`); return true; }
      if (!fromQueue) {
        const q = store.get('queue', []);
        q.push(attempt);
        // If the phone's storage is full, save it without the picture rather than lose it.
        let saved = store.set('queue', q);
        if (!saved) { q[q.length - 1] = { ...attempt, proof: null }; saved = store.set('queue', q); }
        sheet(saved
          ? `<div class="emoji">📶</div><h2>No signal right now</h2><p class="muted">We saved your check-in and will send it once you're back online. Keep hunting!</p><button class="btn-primary btn-big" data-close>OK</button>`
          : `<div class="emoji">📶</div><h2>No signal right now</h2><p class="muted">We couldn't save this check-in. Try again when you have signal.</p><button class="btn-primary btn-big" data-close>OK</button>`);
        renderAll(true);
      }
      return false;
    }
    showResult(r, attempt);
    poll();
    return true;
  }

  async function flushQueue() {
    if (S.flushing || !store.get('queue', []).length) return;
    S.flushing = true;
    try {
      for (;;) {
        const next = store.get('queue', [])[0];
        if (!next) break;
        const ok = await send(next, true);
        if (!ok) break;
        // Re-read before removing, in case a new check-in was queued while this one was sending.
        store.set('queue', store.get('queue', []).filter((a) => (a.id || a.at) !== (next.id || next.at)));
      }
    } finally { S.flushing = false; renderAll(true); }
  }

  function showResult(r, attempt) {
    const away = (m) => m >= 800 ? `${(m / 1609).toFixed(1)} miles` : `${Math.round(m * 3.28 / 10) * 10} feet`;
    const back = '<button class="btn-primary btn-big" data-close data-back>Back to photos</button>';
    const msgs = {
      auto: `<div class="emoji">🎉</div><h1>Found it!</h1><h2>+${ptsText(r.points)}</h2>${back}`,
      pending: `<div class="emoji">🧐</div><h2>Close! The judge will check.</h2><p class="muted">It'll show on your photos once it's approved.</p>${back}`,
      already: `<div class="emoji">✅</div><h2>Your team already found this one.</h2>${back}`,
      pending_exists: `<div class="emoji">⏳</div><h2>The judge is already checking this one for your team.</h2><button class="btn-primary btn-big" data-close>OK</button>`,
      not_started: `<div class="emoji">⏰</div><h2>The game hasn't started yet.</h2><button class="btn-primary btn-big" data-close>OK</button>`,
      ended: `<div class="emoji">🏁</div><h2>The game is over.</h2><p class="muted">Head to the meet-up spot!</p><button class="btn-primary btn-big" data-close>OK</button>`,
      far: `<div class="emoji">🔍</div><h2>Not quite.</h2><p>You're about <b>${away(r.distance)}</b> away.</p>
        <button class="btn-primary btn-big" data-close>Keep looking</button>
        <button class="btn-big" id="askJudge">I'm sure. Ask the judge.</button>`,
    };
    sheet(msgs[r.result] || msgs.far);
    if (r.result === 'auto') confetti();
    const aj = $('#askJudge');
    if (aj) aj.onclick = () => { sheet('<div class="spinner"></div><h2>Sending to the judge…</h2>'); send({ ...attempt, ask_judge: 1 }); };
  }

  function sheet(html) {
    let o = $('#sheet');
    if (!o) { o = document.createElement('div'); o.id = 'sheet'; o.className = 'sheet'; document.body.appendChild(o); }
    o.innerHTML = `<div class="panel stack">${html}</div>`;
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
      ${winner ? `<div class="winner" style="background:${esc(winner.color)}"><h1>🏆 ${esc(winner.name)} team wins!</h1><p>${winner.score} points</p></div>` : ''}
      <div class="card">
        <h2>Scores</h2>
        ${S.data.teams.map((t, i) => `
          <div class="score-row ${t.id === S.data.me.team_id ? 'me' : ''}">
            <span class="rank">${i + 1}</span>
            <span class="bullet" style="background:${esc(t.color)};font-size:1em">${esc(t.name[0])}</span>
            <div class="grow">
              <b class="name">${esc(t.name)}</b>
              <div class="small muted">${t.members?.length ? esc(t.members.join(', ')) : 'No players yet'}</div>
              <div class="counts">
                ${[1, 2, 3].map((d) => `<span><span class="bullet d${d}">${'EMH'[d - 1]}</span>${t.by_diff?.[d - 1] ?? 0}</span>`).join('')}
                <span class="muted">${t.found} found</span>
              </div>
            </div>
            <span class="pts">${t.score}</span>
          </div>`).join('')}
      </div>
      <p class="muted small center" style="margin-top:1em">Every team can find every photo. Most points wins.<br>Easy 1 pt, Medium 2, Hard 3. You're playing as <b>${esc(S.data.me.name)}</b>.</p>`;
  }

  // ---------- map ----------
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (S.leafletLoading) return S.leafletLoading;
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet.css'; document.head.appendChild(css);
    S.leafletLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/leaflet.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return S.leafletLoading;
  }

  async function openMap() {
    locTick();
    try { await loadLeaflet(); } catch { $('#mapNote').innerHTML = '<div class="note">The map needs a signal to load. Try again in a moment.</div>'; return; }
    if (!S.map) {
      S.map = L.map('map', { zoomControl: false, attributionControl: true, zoomSnap: 0.25 }).setView([40.728, -74.005], 15);
      L.control.zoom({ position: 'topright' }).addTo(S.map);
      addBaseMap(S.map);
      S.layers = { area: L.layerGroup().addTo(S.map), trail: L.layerGroup().addTo(S.map), pins: L.layerGroup().addTo(S.map), me: L.layerGroup().addTo(S.map) };
      S.mapFitted = false;
    }
    setTimeout(() => {
      S.map.invalidateSize();
      updateMap();
      if (!S.mapFitted && S.data?.game.boundary) { fitArea(); S.mapFitted = true; }
    }, 80);
  }

  function updateMap() {
    if (!S.map || !S.data) return;
    const { area, trail, pins } = S.layers;
    area.clearLayers(); trail.clearLayers(); pins.clearLayers();
    const b = S.data.game.boundary;
    if (b) {
      // Dim everything outside the play area.
      L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], b], { stroke: false, fillColor: '#000', fillOpacity: 0.3, interactive: false }).addTo(area);
      L.polygon(b, { color: '#e8590c', weight: 4, fill: false, interactive: false }).addTo(area);
    }
    const t = store.get('trail-' + S.data.game.id, []);
    if (t.length > 1) L.polyline(t, { color: '#0039a6', weight: 3, opacity: 0.35, dashArray: '2 8', lineCap: 'round' }).addTo(trail);
    const team = myTeam(), color = team?.color || '#2f855a';
    $('#legendTeam').innerHTML = `<span class="swatch" style="background:${esc(color)}"></span> Found by your team`;
    const icon = (txt) => L.divIcon({ className: '', html: `<div class="find-pin" style="background:${esc(color)}">${txt}</div>`, iconSize: [24, 24] });
    S.data.finds.filter((f) => f.team_id === S.data.me.team_id && f.lat != null).forEach((f) => {
      const p = S.data.photos.find((x) => x.id === f.photo_id);
      L.marker([f.lat, f.lng], { icon: icon(f.status === 'pending' ? '…' : '✓') })
        .bindPopup(`<img src="${esc(p?.thumb)}" style="width:150px;border-radius:6px;margin-bottom:4px"><b>#${numOf(f.photo_id)}</b> · ${esc(f.player_name || '')}${f.status === 'pending' ? ' (judge checking)' : ''}`).addTo(pins);
    });
    updateMe();
  }

  function fitArea() { if (S.map && S.data?.game.boundary) S.map.fitBounds(S.data.game.boundary, { padding: [12, 12] }); }

  function updateMe() {
    if (!S.map || !S.fix) return;
    const me = S.layers.me; me.clearLayers();
    if (S.fix.acc > 15) L.circle([S.fix.lat, S.fix.lng], { radius: S.fix.acc, color: '#0039a6', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(me);
    L.marker([S.fix.lat, S.fix.lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(me);
  }

  // ---------- confetti ----------
  function confetti() {
    const c = document.createElement('canvas'); c.id = 'confetti'; document.body.appendChild(c);
    c.width = innerWidth; c.height = innerHeight;
    const ctx = c.getContext('2d');
    const colors = ['#e8590c', '#fccc0a', '#00933c', '#ee352e', '#0039a6', '#8b4513'];
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
