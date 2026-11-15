// Player app. Plain JS, no build step. Three views (Photos, Map, Scores) plus a photo detail.
(() => {
  const POLL_MS = 4000;   // quick check for news; the server answers "nothing new" cheaply
  const LOC_MS = 15000;   // how often to read the phone's location in the background
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
    data: null, view: 'photos', detail: null,
    // Photo list options, remembered on this phone.
    filter: store.get('filter', 'todo'), diff: store.get('diff', 0), sort: store.get('sort', 'num'),
    fix: null, locDenied: false, offset: 0, sig: '', map: null, layers: null, seen: null,
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
      if (res.status === 401 && data.error === 'not_joined') { resetPlayer(data.kicked ? 'kicked' : 'reset'); throw Object.assign(new Error('not_joined'), { handled: true }); }
      // 4xx = the server said no (don't retry). 5xx = treat like no signal and retry later.
      if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { server: res.status < 500, status: res.status });
      return data;
    } finally { clearTimeout(timer); }
  }

  function resetPlayer(why) {
    // Token no longer valid (removed by the host, game reset, or a new game): start fresh.
    try { sessionStorage.setItem('bye', why || 'reset'); } catch { /* private mode */ }
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
      }, (err) => { if (err.code === 1) setLocDenied(true); done(err); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: timeoutMs });
      const timer = setTimeout(() => done(), timeoutMs);
    });
  }

  const posFix = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() });

  function gotFix(fix) {
    const wasDenied = S.locDenied;
    S.fix = fix; S.locDenied = false; S.lowAcc = false;
    const gid = S.data?.game?.id;
    // Walked trail, only while the game is on. Skip fuzzy fixes so the line doesn't zigzag.
    if (gid && S.data.game.status === 'live' && fix.acc <= 50) {
      const trail = store.get(trailKey(), []);
      const last = trail[trail.length - 1];
      if (!last || dist(last[0], last[1], fix.lat, fix.lng) > 12) {
        trail.push([+fix.lat.toFixed(6), +fix.lng.toFixed(6)]); if (trail.length > 3000) trail.shift();
        store.set(trailKey(), trail);
        if (S.view === 'map') drawTrail();
      }
    }
    if (wasDenied) { renderAll(true); S.screenSig = ''; }
    if (S.view === 'map') updateMe();
  }

  function setLocDenied(on) {
    if (S.locDenied === on) return;
    S.locDenied = on;
    if (on) stopWatch();
    S.screenSig = ''; renderAll(true);
  }

  // What to show: 'ok', 'off' (blocked), or 'searching' (allowed, but no fresh location yet).
  function locStatus() {
    if (!navigator.geolocation || S.locDenied) return 'off';
    return S.fix && Date.now() - S.fix.at < 120000 ? 'ok' : 'searching';
  }

  // The browser's own answer, where it gives one: 'granted', 'denied' or 'prompt'. Also notices when the
  // player turns location back on in Settings, so the warning goes away by itself.
  async function watchPermission() {
    try {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      S.perm = st.state;
      if (st.state === 'denied') setLocDenied(true);
      st.onchange = () => {
        S.perm = st.state;
        if (st.state === 'denied') setLocDenied(true);
        else { setLocDenied(false); startWatch(); locTick(); }
      };
    } catch { /* older phones: we find out from the location calls instead */ }
  }

  // Follow the phone the whole time the page is open (phones stop this when the screen locks, so it
  // restarts when the page comes back). locTick below tops it up and restarts it if it goes quiet.
  function startWatch() {
    if (S.watch != null || !navigator.geolocation || document.hidden || S.locDenied) return;
    S.watchAt = Date.now();
    S.watch = navigator.geolocation.watchPosition(
      (p) => gotFix(posFix(p)),
      (err) => { if (err.code === 1) setLocDenied(true); }, // 2 and 3 (no GPS yet / too slow): keep waiting
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  function stopWatch() {
    if (S.watch == null) return;
    navigator.geolocation.clearWatch(S.watch); S.watch = null;
  }

  // One trail per round: a reset (or a new game) starts a fresh line.
  const trailKey = () => `trail-${S.data.game.id}-${S.data.game.started_at || 0}`;

  function dist(a, b, c, d) {
    const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  function insideArea(lat, lng, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // Meters from a point to the nearest edge of the play area.
  function edgeDist(lat, lng, poly) {
    const k = Math.cos(lat * Math.PI / 180) * 111320, m = 110540;
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = (poly[j][1] - lng) * k, ay = (poly[j][0] - lat) * m, bx = (poly[i][1] - lng) * k, by = (poly[i][0] - lat) * m;
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }
  // How far outside the play area this phone is (0 when inside, or when we can't tell).
  function outsideBy() {
    const b = S.data?.game.boundary, f = S.fix;
    if (!b || b.length < 3 || !f || Date.now() - f.at > 60000 || insideArea(f.lat, f.lng, b)) return 0;
    const d = edgeDist(f.lat, f.lng, b);
    return d > Math.max(30, Math.min(f.acc || 0, 80)) ? d : 0; // a little slack for GPS wobble near the line
  }
  const distText = (m) => m < 160 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609).toFixed(m < 1609 ? 2 : 1)} mi`;
  const homeDist = () => { const h = S.data?.game.home, f = S.fix; return h && f && Date.now() - f.at < 180000 ? dist(f.lat, f.lng, h.lat, h.lng) : null; };
  const directionsUrl = (h) => isIOS ? `https://maps.apple.com/?daddr=${h.lat},${h.lng}&dirflg=w` : `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}&travelmode=walking`;

  // Every 15 s: make sure we're following the phone, and ask directly if nothing has come in lately.
  function locTick() {
    if (document.hidden || !navigator.geolocation || !S.token || S.locBusy) return;
    if (S.locDenied && S.perm !== 'prompt' && S.perm !== 'granted') return; // blocked: wait for "Try again" or Settings
    startWatch();
    const age = S.fix ? Date.now() - S.fix.at : Infinity;
    if (age < 25000) return;
    // Quiet for over a minute and a half: the watch is probably stuck, so start it over.
    if (age > 90000 && S.watch != null && Date.now() - S.watchAt > 90000) { stopWatch(); startWatch(); }
    S.locBusy = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { S.locBusy = false; gotFix(posFix(p)); },
      (err) => {
        S.locBusy = false;
        if (err.code === 1) setLocDenied(true);
        else S.lowAcc = !S.lowAcc; // no GPS between tall buildings: try the rougher wifi/cell location next time
      },
      { enableHighAccuracy: !S.lowAcc, maximumAge: 20000, timeout: 14000 });
  }

  // ---------- location help (blocked, or opened inside another app) ----------
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (!/Android/.test(navigator.userAgent) && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|LinkedInApp|GSA\/|Twitter|; wv\)/i.test(navigator.userAgent);
  function locSteps() {
    if (inAppBrowser) return `<p><b>You opened this inside another app</b>, which can't share your location. Tap <b>⋯</b> or the share button and choose <b>Open in ${isIOS ? 'Safari' : 'Chrome'}</b>, or copy this address into ${isIOS ? 'Safari' : 'Chrome'}:</p>
      <p class="loc-url"><b>${esc(location.host)}</b></p>`;
    if (isIOS && /CriOS/.test(navigator.userAgent)) return `<ol class="loc-steps"><li>Open the <b>Settings</b> app → <b>Privacy &amp; Security</b> → <b>Location Services</b>. Make sure it's <b>on</b>.</li>
      <li>In Settings, scroll down to <b>Chrome</b> → <b>Location</b> → <b>While Using the App</b>.</li><li>Come back here and tap <b>Try again</b>.</li></ol>`;
    if (isIOS) return `<ol class="loc-steps"><li>Open the <b>Settings</b> app → <b>Privacy &amp; Security</b> → <b>Location Services</b>. Make sure it's <b>on</b>.</li>
      <li>On that same screen, scroll down to <b>Safari Websites</b> and pick <b>While Using the App</b>.</li>
      <li>Back in Safari, tap <b>aA</b> (or the ☰ icon) next to the web address → <b>Website Settings</b> → <b>Location</b> → <b>Allow</b>.</li>
      <li>Come back here and tap <b>Try again</b>.</li></ol>`;
    return `<ol class="loc-steps"><li>Swipe down from the top of the screen and make sure <b>Location</b> is <b>on</b>.</li>
      <li>Tap the icon to the left of the web address (⚙ or 🔒) → <b>Permissions</b> → <b>Location</b> → <b>Allow</b>.</li>
      <li>Come back here and tap <b>Try again</b>.</li></ol>`;
  }
  // Ask again from a button press (some phones only show the "Allow?" box after a tap).
  async function retryLocation(btn, onOk) {
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await getFix(12000, 150);
      setLocDenied(false); startWatch(); onOk();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Try again';
      const msg = btn.parentElement.querySelector('.loc-msg');
      if (msg) msg.textContent = e && e.code === 1 ? 'Still blocked. Follow the steps above, then try again.' : 'Location is allowed, but your phone couldn\'t find you yet. Step outside or wait a moment.';
      if (e && e.code !== 1) { setLocDenied(false); startWatch(); }
    }
  }
  function showLocHelp() {
    const st = locStatus();
    sheet(st === 'searching' && !inAppBrowser
      ? `<div class="emoji">📡</div><h2>Looking for your location…</h2><p class="muted">Location is allowed, but your phone hasn't found you yet. This is normal indoors or between tall buildings. Step outside for a moment.</p>
        <button class="btn-primary btn-big" id="locRetry">Try again</button><p class="loc-msg muted small"></p><button class="btn-big" data-close>Close</button>`
      : `<div class="emoji">📍</div><h2>Turn on location</h2><p class="muted">The game needs your location to check your photos and show your teammates where you are.</p>
        <div class="loc-help">${locSteps()}</div>
        <button class="btn-primary btn-big" id="locRetry">Try again</button><p class="loc-msg muted small"></p><button class="btn-big" data-close>Not now</button>`);
    $('#sheet').classList.add('tall');
    $('#locRetry').onclick = (ev) => retryLocation(ev.currentTarget, () => { $('#sheet')?.remove(); toast('#00933c', '<b>📍 Location is on.</b> You\'re all set!'); });
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
    // Explain why this phone is back on the join screen.
    let bye = null; try { bye = sessionStorage.getItem('bye'); sessionStorage.removeItem('bye'); } catch { /* ignore */ }
    const byeNote = bye === 'kicked' ? '<p class="note">The host removed you from the game. You can join again below.</p>'
      : bye ? '<p class="note">The host reset the game. Join again to play.</p>' : '';
    app.innerHTML = `
      <div class="screen stack">
        ${byeNote}
        ${hero(info.game.name, 'Find the spots in the photos and snap a picture there. Harder photos are worth more. Results are revealed at the end!')}
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
        if (matches.length) askIsThisYou(name, matches, info); else if (info.game.random_teams) finishJoin({ name }); else pickTeam(name, info);
      } catch (e) { $('#joinErr').textContent = e.message; }
    };
  }

  function askIsThisYou(name, matches, info) {
    $('#app').innerHTML = `
      <div class="screen stack">
        ${hero('Welcome back?')}
        ${matches.map((m) => `<button class="team-btn" style="background:${esc(m.color)}" data-id="${esc(m.id)}"><span>Yes, I'm ${esc(m.name)}</span><small>${m.team ? `${esc(m.team)} team` : 'Already joined'}</small></button>`).join('')}
        <button class="btn-big" id="newMe">No, I'm someone new</button>
      </div>`;
    document.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => finishJoin({ player_id: b.dataset.id }));
    $('#newMe').onclick = () => info.game.random_teams ? finishJoin({ name }) : pickTeam(name, info);
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
      let perm = null;
      try { perm = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* not supported */ }
      if (inAppBrowser || perm === 'denied' || !navigator.geolocation) showLocBlocked();
      else if (perm === 'granted') startGame();
      else showLocationAsk();
    } catch (e) {
      const el = $('#joinErr'); if (el) el.textContent = e.message; else alert(e.message);
      document.querySelectorAll('.team-btn, #newMe').forEach((b) => { b.disabled = false; });
    } finally { S.joining = false; }
  }

  function showLocationAsk() {
    $('#app').innerHTML = `
      <div class="screen stack">
        ${hero('One more step', 'The game uses your location when you submit a photo, and shows your teammates where you are. Your phone will ask. <b>Tap "Allow".</b>')}
        <div class="allow-mock">
          <b>Allow "${esc(location.host)}" to use your current location?</b>
          <div class="btns"><span>Don't Allow</span><span>Allow</span></div>
        </div>
        <button class="btn-primary btn-big" id="askLoc">OK, ask me</button>
      </div>`;
    $('#askLoc').onclick = () => {
      $('#askLoc').disabled = true; $('#askLoc').textContent = 'Waiting…';
      getFix(15000, 150).then(startGame, (e) => {
        if (e && (e.code === 1 || e.message === 'no_geo')) showLocBlocked(); else startGame(); // timeout: keep trying in the game
      });
    };
  }

  // The phone said no without asking (location switched off, or blocked earlier), or the player tapped "Don't Allow".
  function showLocBlocked() {
    $('#app').innerHTML = `
      <div class="screen stack">
        ${hero('Location is blocked', 'Your phone didn\'t let the game see your location. Here\'s how to turn it on:')}
        <div class="card loc-help">${locSteps()}</div>
        <button class="btn-primary btn-big" id="locRetry">Try again</button>
        <p class="loc-msg muted small center"></p>
        <button class="btn-ghost" id="locSkip">Skip for now (you can't send photos without it)</button>
      </div>`;
    $('#locRetry').onclick = (ev) => retryLocation(ev.currentTarget, startGame);
    $('#locSkip').onclick = startGame;
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
            <div class="map-key" id="mapKey"></div>
            <div class="map-buttons"><button id="homeBtn" class="hidden" aria-label="Home base">🏠</button><button id="fitArea">Whole area</button><button class="btn-primary" id="centerMe">Show me</button></div>
          </div>
        </div>
        <div class="screen hidden" id="vScores"></div>
        <div class="screen hidden detail" id="vDetail"></div>
      </main>
      <nav class="tabs">
        ${['photos', 'map', 'scores'].map((v) => `<button data-view="${v}">${ICON[v]}${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
      </nav>
      <input type="file" accept="image/*" capture="environment" id="cam" class="hidden">
      <div class="toasts" id="toasts" aria-live="polite"></div>`;
    document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => go(b.dataset.view));
    $('#fitArea').onclick = () => fitArea();
    $('#homeBtn').onclick = () => { const h = S.data?.game.home; if (h && S.map) S.map.flyTo([h.lat, h.lng], 17, { duration: 0.6 }); };
    $('#centerMe').onclick = () => { if (S.fix && S.map) S.map.flyTo([S.fix.lat, S.fix.lng], 17, { duration: 0.6 }); else locTick(); };
    $('#cam').onchange = onPhotoTaken;
    go('photos');
    poll();
    S.locSince = Date.now();
    watchPermission(); startWatch(); locTick();
    // Check every 4 s, or every 1.5 s in the lobby so everyone's countdown starts together.
    setInterval(() => { if (Date.now() - (S.lastPoll || 0) >= (phase() === 'lobby' ? 1500 : POLL_MS)) poll(); }, 500);
    setInterval(locTick, LOC_MS);
    setInterval(() => { renderClock(); renderScreen(); renderLocBar(); }, 250);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopWatch(); return; }
      poll(); startWatch(); locTick();
    });
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

  async function poll(force) {
    if (!S.token) return;
    if (S.polling) { S.pollAgain = true; return; } // e.g. right after sending a photo: check again when this one finishes
    if (document.hidden && S.data && force !== true) return; // phone locked or app in the background
    S.polling = true;
    S.lastPoll = Date.now();
    try {
      const body = S.fix && Date.now() - S.fix.at < 180000 ? { lat: S.fix.lat, lng: S.fix.lng, acc: S.fix.acc } : {};
      body.loc = locStatus();
      if (S.data && S.v) body.v = S.v; // "I already have this version"
      const d = await api('/api/poll', body, { timeout: 12000 });
      S.offset = d.now - Date.now();
      const wasOffline = S.offline;
      S.offline = false;
      if (d.same && S.data) {
        // Nothing changed: just move teammates' dots.
        S.data.mates = d.mates;
        if (S.view === 'map') updateMates();
        renderScreen();
        if (wasOffline) renderTop();
      } else {
        S.data = d; S.v = d.v;
        announce(d); hostMessage(d.game); teamReveal(d);
        renderAll();
      }
      flushQueue();
    } catch (e) {
      if (!e.handled) {
        S.offline = true; renderTop();
        if (!S.data) $('#vPhotos').innerHTML = '<div class="empty">Can\'t reach the game right now. Check your signal. Trying again…</div>';
      }
    } finally {
      S.polling = false;
      if (S.pollAgain) { S.pollAgain = false; poll(); }
    }
  }

  // "Red team found something!" pop-ups. Other teams stay anonymous; teammates show what they sent.
  function announce(d) {
    const evs = d.events || [];
    if (!S.seen) { S.seen = new Set(evs.map((e) => e.id)); return; } // don't replay old news on open
    const fresh = evs.filter((e) => !S.seen.has(e.id));
    fresh.forEach((e) => S.seen.add(e.id));
    const msgs = [];
    for (const e of fresh) {
      const t = d.teams.find((x) => x.id === e.team_id);
      if (!t) continue;
      if (e.team_id === d.me.team_id) {
        const f = d.finds.find((x) => x.id === e.id);
        if (f && !f.by_me) msgs.push([t.color, `<b>${esc(f.player_name || 'Your team')}</b> sent #${numOf(f.photo_id)}`]);
      } else msgs.push([t.color, `<b>${esc(t.name)} team</b> found something!`]);
    }
    if (msgs.length > 3) { toast('#111', `<b>${msgs.length} new finds</b> while you were away`); return; }
    msgs.forEach(([c, m], i) => setTimeout(() => toast(c, m), i * 700));
  }

  // Random teams: the moment the host reveals them, show this player their team and teammates.
  function teamReveal(d) {
    const g = d.game, t = d.teams.find((x) => x.id === d.me.team_id);
    if (!g.random_teams || !g.teams_ready || !t) { if (!g.teams_ready) $('#teamReveal')?.remove(); return; }
    const key = 'team-' + g.id, val = `${g.teams_at}:${t.id}`;
    if (store.get(key) === val) return;
    store.set(key, val);
    const mates = t.members.filter((n) => n !== d.me.name);
    let o = $('#teamReveal');
    if (!o) { o = document.createElement('div'); o.id = 'teamReveal'; document.body.appendChild(o); }
    o.className = 'team-reveal'; o.style.background = t.color;
    o.innerHTML = `<div class="tr-in"><p class="tr-small">The teams are in!</p><div class="tr-badge" style="color:${esc(t.color)}">${esc(t.name[0])}</div>
      <h1>You're on the<br><span class="tr-team">${esc(t.name)} team!</span></h1>
      ${mates.length ? `<p class="tr-small">You're with</p><div class="tr-mates">${mates.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : '<p class="tr-small">More teammates may join soon.</p>'}
      <button class="btn-big" id="trOk">Let's go!</button></div>`;
    $('#trOk').onclick = () => o.remove();
    if (navigator.vibrate) navigator.vibrate([100, 60, 100, 60, 400]);
    confetti();
  }

  // A message the host sent to everyone ("Dinner's ready, come back!"). Shown once per phone.
  function hostMessage(g) {
    const a = g.announce, key = 'msg-' + g.id;
    if (!a) { $('#hostMsg')?.remove(); return; }
    if (store.get(key, 0) >= a.at) return;
    store.set(key, a.at);
    if (Date.now() + S.offset - a.at > 20 * 60000) return; // old news for someone who just opened the app
    let o = $('#hostMsg');
    if (!o) { o = document.createElement('div'); o.id = 'hostMsg'; o.className = 'sheet host-msg'; document.body.appendChild(o); }
    o.innerHTML = `<div class="panel stack center"><div class="hm-icon">📣</div><div class="small muted">Message from the host · ${timeText(a.at)}</div>
      <p class="hm-text">${esc(a.text)}</p><button class="btn-primary btn-big" id="hmOk">Got it</button></div>`;
    $('#hmOk').onclick = () => o.remove();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
  }

  function toast(color, html) {
    const box = $('#toasts'); if (!box) return;
    box.style.top = Math.round(($('#top')?.getBoundingClientRect().bottom || 90) + 8) + 'px'; // just under the header
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="burst" style="background:${esc(color)}"></span><span>${html}</span>`;
    el.onclick = () => el.remove();
    box.prepend(el);
    while (box.children.length > 3) box.lastChild.remove();
    if (navigator.vibrate) navigator.vibrate(60);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4500);
  }

  const myTeam = () => S.data?.teams.find((t) => t.id === S.data.me.team_id);
  const numOf = (pid) => S.data.photos.findIndex((p) => p.id === pid) + 1;
  // My team's answer for a photo (there's at most one).
  const findFor = (photoId) => S.data.finds.find((f) => f.photo_id === photoId && f.team_id === S.data.me.team_id) || null;
  // Saved on this phone, waiting for signal.
  const queuedFor = (photoId) => store.get('queue', []).some((a) => a.photo_id === photoId);
  const isSent = (photoId) => !!findFor(photoId) || queuedFor(photoId);
  const byWho = (f) => esc(f.player_name || 'the judge');
  const revealed = () => !!S.data?.game.revealed;
  const timeText = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function renderAll(force) {
    if (!S.data) return;
    renderScreen();
    renderTop();
    const sig = JSON.stringify([S.data.finds.map((f) => [f.id, f.counted]), S.data.photos.map((p) => p.id + p.points + p.difficulty + (p.hint || '')),
      S.data.teams.map((t) => [t.score, t.submitted, t.name, t.roster]), S.data.game.status, S.data.game.revealed, S.data.game.home, S.data.game.boundary, S.filter, S.diff, S.sort, S.locDenied, store.get('queue', []).length]);
    if (!force && sig === S.sig) { if (S.view === 'map') updateMates(); return; }
    S.sig = sig;
    renderPhotos(); renderScores();
    if (S.detail) renderDetail();
    if (S.view === 'map') updateMap();
  }

  // ---------- full screens: lobby before the start, countdown, and "game over" ----------
  // Which screen to show right now. Uses the server's clock, so every phone flips at the same moment.
  function phase() {
    const g = S.data?.game;
    if (!g) return 'game';
    const t = Date.now() + S.offset;
    if (g.status === 'setup') return 'lobby';
    if (g.status === 'ended' || (g.ends_at && t >= g.ends_at)) return 'over';
    if (g.started_at && t < g.started_at) return 'countdown';
    if (g.started_at && t < g.started_at + 1500) return 'go';
    return 'game';
  }

  function renderScreen() {
    if (!S.data) return;
    const g = S.data.game, t = Date.now() + S.offset;
    // The countdown just finished on this phone's clock: open the game now, without waiting for the next check.
    if (g.status === 'starting' && t >= g.started_at) { g.status = 'live'; renderAll(true); return; }
    const ph = phase();
    let el = $('#screen');
    if (ph === 'game') {
      if (el) { el.remove(); document.body.classList.remove('locked'); }
      S.screenSig = '';
      // Joined after the start, so never saw the lobby: show the steps once.
      if (S.lastPh !== 'go' && !store.get('howto-seen') && !$('#sheet')) showHowTo();
      S.lastPh = ph;
      return;
    }
    if (!el) { el = document.createElement('div'); el.id = 'screen'; document.body.appendChild(el); }
    document.body.classList.add('locked'); // the game underneath can't scroll or be tapped
    const me = S.data.me, team = myTeam(), color = team?.color || (g.random_teams ? '#5b4636' : '#333');
    let html = '', sig = '';
    if (ph === 'lobby') {
      store.set('howto-seen', true);
      const ls = locStatus();
      const waitTeams = g.random_teams && !team; // teams are being picked at random
      sig = JSON.stringify(['lobby', me, S.data.teams.map((x) => [x.id, x.name, x.color, x.members]), S.data.everyone, g.random_teams, g.teams_ready, S.switching, ls]);
      const teamsHtml = waitTeams ? `
        <h2 class="lob-h">Who's here <span class="lob-count">${(S.data.everyone || []).length}</span></h2>
        <div class="lob-team"><div class="lob-members">${(S.data.everyone || []).map((n) => `<span class="chip ${n === me.name ? 'me' : ''}">${esc(n)}${n === me.name ? ' (you)' : ''}</span>`).join('')}</div></div>`
        : `<h2 class="lob-h">${g.random_teams ? 'Teams (picked at random)' : 'Teams'}</h2>
        <div class="lob-teams">${S.data.teams.map((x) => {
          const mine = x.id === me.team_id;
          return `<div class="lob-team ${mine ? 'mine' : ''}">
            <div class="lob-th"><span class="swatch" style="background:${esc(x.color)}"></span><b>${esc(x.name)}</b><span class="muted small">${x.members.length}</span>
              <span class="grow"></span>${mine ? '<span class="lob-here">Your team</span>' : g.random_teams ? '' : `<button class="btn-small" data-switch="${esc(x.id)}" ${S.switching ? 'disabled' : ''}>Switch to ${esc(x.name)}</button>`}</div>
            <div class="lob-members">${x.members.length ? x.members.map((n) => `<span class="chip ${mine && n === me.name ? 'me' : ''}">${esc(n)}${mine && n === me.name ? ' (you)' : ''}</span>`).join('') : '<span class="muted small">No one yet</span>'}</div>
          </div>`;
        }).join('')}</div>`;
      html = `<div class="lob">
        <div class="lob-top"><span>🦃 ${esc(g.name)}</span></div>
        <div class="lob-hero">
          <div class="lob-badge" style="color:${esc(color)}">${esc(waitTeams ? '?' : (team?.name || '?')[0])}</div>
          <p class="lob-you">${waitTeams ? `You're <b>${esc(me.name)}</b>. The host is picking the teams at random.` : `You're <b>${esc(me.name)}</b> on the <b>${esc(team?.name || '')}</b> team`}</p>
          ${ls === 'ok' ? '<p class="lob-loc ok">📍 Location is on ✓</p>'
            : ls === 'off' ? '<button class="lob-loc off" data-lochelp>📍 Location is off. Tap here to fix it</button>'
            : '<button class="lob-loc" data-lochelp>📡 Finding your location… <u>Help</u></button>'}
          <h1>${waitTeams ? 'Waiting for the teams to be picked' : 'Waiting for other players to join'}</h1>
          <div class="lob-dots"><i></i><i></i><i></i></div>
        </div>
        <div class="lob-how"><h2>How to play</h2>${howToHtml()}</div>
        ${teamsHtml}
        <p class="lob-foot">The hunt starts when the host presses Start. Keep this screen open.</p>
      </div>`;
    } else if (ph === 'countdown' || ph === 'go') {
      const n = Math.max(1, Math.ceil((g.started_at - t) / 1000));
      sig = ph + (ph === 'go' ? '' : n) + color;
      html = ph === 'go'
        ? `<div class="cd"><div class="cd-n go">GO!</div><p>Happy hunting 🦃</p></div>`
        : `<div class="cd"><p>Get ready!</p><div class="cd-n" key="${n}">${n}</div><p>The hunt starts in ${n} second${n === 1 ? '' : 's'}</p></div>`;
      if (ph === 'go' && S.lastPh !== 'go' && navigator.vibrate) navigator.vibrate([150, 80, 300]);
    } else {
      const q = store.get('queue', []).length, h = g.home, hd = homeDist();
      sig = 'over' + q + (h ? h.lat + h.label : '') + (hd == null ? '' : Math.round(hd / 50));
      html = `<div class="cd over"><div class="cd-icon">🏁</div><h1>Game over!</h1><p>${h ? `Head back to <b>${esc(h.label)}</b>. ` : ''}See the results on the main screen.</p>
        ${h ? `<p class="small">${hd != null ? `🏠 ${distText(hd)} away · ` : ''}<a href="${directionsUrl(h)}" target="_blank" rel="noopener" style="color:inherit">Walking directions</a></p>` : ''}
        ${q ? `<p class="small">📶 Sending ${q} saved photo${q > 1 ? 's' : ''} when you have signal. Keep this open for a moment.</p>` : ''}</div>`;
    }
    S.lastPh = ph;
    if (sig === S.screenSig) return;
    S.screenSig = sig;
    el.className = 'screen-full ' + ph;
    el.style.background = ph === 'over' ? '#111' : color;
    el.innerHTML = html;
    el.querySelectorAll('[data-lochelp]').forEach((b) => b.onclick = showLocHelp);
    el.querySelectorAll('[data-switch]').forEach((b) => b.onclick = async () => {
      S.switching = true; renderScreen();
      try { await api('/api/team', { team_id: b.dataset.switch }); } catch (e) { if (!e.handled) alert(e.message); }
      S.switching = false; S.screenSig = ''; poll(true);
    });
  }

  // ---------- how to play (lobby card + "?" button in the game) ----------
  const HOW_STEPS = [
    ['🔎', 'Pick a photo', 'Each photo shows a spot in the neighborhood. Harder ones are worth more points.'],
    ['🚶', 'Find the spot with your team', 'The Map shows where you\'ve walked and where your teammates are.'],
    ['📸', 'Stand where the photo was taken', 'Tap the photo, then <b>"I found it! Take the picture."</b> Your location is sent with it, so get right to the spot.'],
    ['🤫', 'Results stay secret', 'You\'ll only see "Sent." Not sure you got it right? Tap <b>"Submit again"</b>. Only the newest one counts.'],
    ['🏁', 'Come back when time is up', 'The winners are revealed on the TV at home base.'],
  ];
  function howToHtml() {
    return `<ol class="how">${HOW_STEPS.map(([i, t, d]) => `<li><span class="how-i">${i}</span><div><b>${t}</b><p>${d}</p></div></li>`).join('')}</ol>
      <ul class="how-tips">
        <li>Keep this page open. If your phone locks, just open it again. Nothing is lost.</li>
        <li>No signal? Your photo is saved and sends by itself later.</li>
        <li>Tap <b>Aa</b> at the top for bigger text.</li>
      </ul>`;
  }
  function showHowTo() {
    store.set('howto-seen', true);
    sheet(`<h2 style="margin:0">How to play</h2>${howToHtml()}<button class="btn-primary btn-big" data-close>Got it, let's hunt!</button>`);
    $('#sheet').classList.add('tall');
  }

  function rankText(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function clockState() {
    const g = S.data?.game;
    if (!g) return ['', ''];
    if (g.status === 'setup') return ['Starts soon', ''];
    if (g.status === 'ended') return ['Game over', 'over'];
    if (!g.ends_at) return ['', 'live'];
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
    const total = S.data.photos.length;
    const [ct, cc] = clockState();
    const sent = t?.submitted ?? 0;
    // Before the reveal the header only shows how many photos the team has submitted.
    const line = revealed()
      ? `<b>${t?.score ?? 0}</b><span>pts · ${rankText(S.data.teams.indexOf(t) + 1)} of ${S.data.teams.length}</span><span class="grow" style="text-align:right">${t?.found ?? 0} counted</span>`
      : `<b>${sent}</b><span>of ${total} sent</span><span class="grow" style="text-align:right">🤫 points at the end</span>`;
    top.innerHTML = `
      <div class="top">
        <span class="team"><span class="bullet" style="background:${esc(t?.color)}">${esc((t?.name || '?')[0])}</span>${esc(t?.name)} team</span>
        <span class="${S.offline ? 'clock over' : 'clock ' + cc}" id="clock">${S.offline ? 'No signal' : ct}</span>
        <button class="text-btn" id="helpBtn" aria-label="How to play">?</button>
        <button class="text-btn" id="bigBtn" aria-label="Bigger text">Aa</button>
      </div>
      <div class="score">${line}</div>
      <div class="progress"><span style="width:${total ? (100 * sent) / total : 0}%"></span></div>
      <div id="locBar"></div>`;
    S.locBarSig = '';
    renderLocBar();
    $('#helpBtn').onclick = showHowTo;
    $('#bigBtn').onclick = () => { const on = document.body.classList.toggle('big'); store.set('big', on); };
  }

  // A strip under the header on every tab when location isn't working.
  function renderLocBar() {
    const el = $('#locBar'); if (!el) return;
    const st = locStatus();
    const show = st === 'off' || (st === 'searching' && Date.now() - S.locSince > 30000);
    // Outside the orange line while the hunt is on.
    const out = !show && S.data?.game.status === 'live' && phase() === 'game' ? outsideBy() : 0;
    if (out && !S.wasOut && navigator.vibrate) navigator.vibrate([300, 150, 300]);
    S.wasOut = !!out;
    const sig = show ? st : out ? 'out' + Math.round(out / 50) : '';
    if (sig === S.locBarSig) return;
    S.locBarSig = sig;
    el.className = show ? 'loc-bar ' + st : out ? 'loc-bar out' : '';
    el.innerHTML = out ? `<span>🚧 <b>You're outside the game area</b> (${distText(out)} past the orange line). No photos out here.</span><button>Map</button>`
      : !show ? '' : st === 'off'
      ? '<span>📍 <b>Location is off.</b> Teammates can\'t see you and photos can\'t be sent.</span><button>Fix it</button>'
      : '<span>📡 <b>Looking for your location…</b></span><button>Help</button>';
    if (out) el.querySelector('button').onclick = () => { go('map'); setTimeout(() => { if (S.map && S.fix) S.map.fitBounds([...S.data.game.boundary, [S.fix.lat, S.fix.lng]], { padding: [20, 20] }); }, 200); };
    else if (show) el.querySelector('button').onclick = showLocHelp;
  }

  function notes() {
    const g = S.data.game;
    let html = '';
    if (g.status === 'setup') html += `<div class="note info">⏳ The game hasn't started yet. Look over the photos and plan your route!</div>`;
    if (g.status === 'ended' && !g.revealed) html += `<div class="note good">🏁 <b>Game over!</b> Head back to ${g.home ? `<b>${esc(g.home.label)}</b>` : 'home base'}. The results will be revealed there.</div>`;
    if (g.status === 'ended' && g.revealed) html += `<div class="note good">🏆 <b>The results are in!</b> See Scores.</div>`;
    const q = store.get('queue', []);
    if (q.length) html += `<div class="note">📶 ${q.length} photo${q.length > 1 ? 's' : ''} waiting for signal. We'll send ${q.length > 1 ? 'them' : 'it'} automatically.</div>`;
    return html ? `<div class="stack" style="margin-bottom:1em">${html}</div>` : '';
  }

  // Badge on a photo: "Submitted" during the game, then counted / didn't count after the reveal.
  function badge(f, queued) {
    if (!f) return queued ? '<div class="badge wait"><span class="check">📶</span>Waiting for signal</div>' : '';
    if (!revealed()) return `<div class="badge"><span class="check">✓</span>Sent by ${byWho(f)}</div>`;
    return f.counted ? `<div class="badge"><span class="check">✓</span>Counted!</div>` : `<div class="badge no"><span class="check">✕</span>Didn't count</div>`;
  }

  function tile(p) {
    const f = findFor(p.id), q = !f && queuedFor(p.id);
    // Sent with a picture: show your team's picture, with the photo you were hunting in the corner.
    if (f && f.proof) {
      const res = revealed() ? (f.counted ? '<span class="pill yes">✓ Counted</span>' : '<span class="pill no">✕ Didn\'t count</span>') : `<span class="pill">✓ ${esc(f.player_name || 'Sent')}</span>`;
      return `<button class="tile sent-pic" data-photo="${esc(p.id)}">
        <img src="${esc(f.proof)}" alt="Your picture for photo ${numOf(p.id)}" loading="lazy">
        <img class="inset" src="${esc(p.thumb)}" alt="" loading="lazy">
        <span class="num">#${numOf(p.id)}</span>${res}
        <div class="meta">${diffTag(p.difficulty)}<b>${ptsText(p.points)}</b></div>
      </button>`;
    }
    return `<button class="tile ${f || q ? 'found' : ''}" data-photo="${esc(p.id)}">
      <img src="${esc(p.thumb)}" alt="Photo ${numOf(p.id)}" loading="lazy">
      <span class="num">#${numOf(p.id)}</span>
      ${badge(f, q)}
      <div class="meta">${diffTag(p.difficulty)}<b>${ptsText(p.points)}</b></div>
    </button>`;
  }

  function renderPhotos() {
    const el = $('#vPhotos');
    const photos = S.data.photos;
    const byDiff = S.diff ? photos.filter((p) => p.difficulty === S.diff) : photos;
    const done = byDiff.filter((p) => isSent(p.id)), todo = byDiff.filter((p) => !isSent(p.id));
    let list = S.filter === 'todo' ? todo : done;
    if (S.sort !== 'num') list = [...list].sort((a, b) => (S.sort === 'easy' ? a.difficulty - b.difficulty : b.difficulty - a.difficulty) || numOf(a.id) - numOf(b.id));
    const empty = S.filter === 'todo'
      ? (photos.length ? (S.diff ? `No ${DIFF[S.diff]} photos left. Nice!` : 'Your team sent them all!') : 'No photos yet.')
      : (S.diff ? `No ${DIFF[S.diff]} photos sent yet.` : 'Nothing sent yet. Get hunting!');
    el.innerHTML = `
      ${notes()}
      <div class="seg" style="margin-bottom:.6em">
        <button data-f="todo" class="${S.filter === 'todo' ? 'on' : ''}">To find · ${todo.length}</button>
        <button data-f="done" class="${S.filter === 'done' ? 'on' : ''}">Sent · ${done.length}</button>
      </div>
      <div class="chips" role="group" aria-label="Difficulty">
        <button data-d="0" class="${!S.diff ? 'on' : ''}">All</button>
        ${[1, 2, 3].map((d) => `<button data-d="${d}" class="${S.diff === d ? 'on' : ''}"><span class="bullet d${d}">${'EMH'[d - 1]}</span>${DIFF[d]}</button>`).join('')}
      </div>
      <div class="list-tools">
        <span class="muted small">${list.length} photo${list.length === 1 ? '' : 's'}</span>
        <select id="sortSel" aria-label="Sort">
          <option value="num" ${S.sort === 'num' ? 'selected' : ''}>By number</option>
          <option value="easy" ${S.sort === 'easy' ? 'selected' : ''}>Easy first</option>
          <option value="hard" ${S.sort === 'hard' ? 'selected' : ''}>Hard first</option>
        </select>
      </div>
      ${list.length ? `<div class="grid">${list.map(tile).join('')}</div>` : `<div class="empty">${empty}</div>`}
      <p class="muted small center" style="margin-top:1.2em">Every team can find every photo. Easy 1 pt, Medium 2, Hard 3.<br>${revealed() ? 'Tap a photo to see if it counted.' : 'Nobody finds out what counted until the end.'}</p>`;
    el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; store.set('filter', S.filter); renderAll(true); });
    el.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { S.diff = Number(b.dataset.d); store.set('diff', S.diff); renderAll(true); });
    $('#sortSel').onchange = (e) => { S.sort = e.target.value; store.set('sort', S.sort); renderAll(true); };
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
    const others = revealed() ? S.data.teams.filter((t) => t.id !== S.data.me.team_id && S.data.finds.some((x) => x.photo_id === p.id && x.team_id === t.id && x.counted)) : [];
    let action;
    if (f && revealed()) action = f.counted ? `<div class="note good"><b>✓ Counted!</b> ${f.player_name ? 'Sent by ' + byWho(f) : 'Added by the judge'}.</div>` : `<div class="note"><b>✕ Didn't count.</b> Sent by ${byWho(f)}, but it wasn't the right spot.</div>`;
    else if (!f && queuedFor(p.id)) action = `<div class="note">📶 <b>Saved on your phone.</b> It will send by itself when you have signal.</div>`;
    else if (f) action = `<div class="note good"><b>✓ Sent</b> by ${byWho(f)} at ${timeText(f.created_at)}. You'll find out if it counted at the end.</div>
      ${live ? '<button class="btn-ghost btn-big" id="againBtn">Wrong spot? Submit again</button>' : ''}`;
    else if (live) action = `<button class="btn-primary btn-big" id="foundBtn">📸 I found it! Take the picture</button>
      <button class="btn-ghost btn-big" id="noPicBtn">Submit without a picture</button>`;
    else action = `<div class="note info">${S.data.game.status === 'setup' ? 'You can submit once the game starts.' : 'The game is over.'}</div>`;
    el.innerHTML = `
      <div class="detail-top"><button class="btn-small" id="backBtn">← Back to photos</button><span class="grow"></span>${diffTag(p.difficulty)}<b>${ptsText(p.points)}</b></div>
      ${f && f.proof ? `<div class="compare" id="compare">
          <figure><img src="${esc(p.image)}" alt="Photo ${numOf(p.id)}"><figcaption>The photo</figcaption></figure>
          <figure><img src="${esc(f.proof)}" alt="Your team's picture"><figcaption>Your team's picture${f.player_name ? ' · ' + esc(f.player_name) : ''}</figcaption></figure>
        </div>` : `<img class="full" src="${esc(p.image)}" alt="Photo ${numOf(p.id)}">`}
      <h2 style="margin:.6em 0 .2em">#${numOf(p.id)}${p.title ? ' · ' + esc(p.title) : ''}</h2>
      <p class="muted small">${f && f.proof ? 'Tap the pictures to see them bigger.' : 'Pinch the photo to zoom in.'}${others.length ? ` Also found by ${others.map((t) => esc(t.name)).join(', ')}.` : ''}</p>
      ${p.hint ? `<div class="note info"><b>Hint:</b> ${esc(p.hint)}</div>` : ''}
      <div class="action stack">${action}</div>`;
    $('#backBtn').onclick = () => closeDetail();
    const cmp = $('#compare'); if (cmp) cmp.onclick = () => cmp.classList.toggle('big');
    const start = (replace, withPic) => {
      S.warm = getFix(15000, 20); S.pending = { photo_id: p.id, replace };
      if (withPic) { $('#cam').value = ''; $('#cam').click(); } else checkIn(null);
    };
    const fb = $('#foundBtn'); if (fb) fb.onclick = () => start(false, true);
    const nb = $('#noPicBtn'); if (nb) nb.onclick = () => start(false, false);
    const ab = $('#againBtn');
    if (ab) ab.onclick = () => {
      sheet(`<div class="emoji">🔁</div><h2>Submit #${numOf(p.id)} again?</h2><p class="muted">Your team's new picture and location replace the old one. Only the newest one counts.</p>
        <button class="btn-primary btn-big" id="againYes">Take a new picture</button><button class="btn-big" data-close>Cancel</button>`);
      $('#againYes').onclick = () => { $('#sheet')?.remove(); start(true, true); };
    };
  }

  // ---------- check-in ----------
  function onPhotoTaken(ev) {
    const file = ev.target.files[0];
    if (file && S.pending) checkIn(file);
  }

  async function checkIn(file) {
    sheet(`<div class="spinner"></div><h2>Getting your location…</h2><p class="muted">Hold still for a few seconds.</p>`);
    let proof = null;
    if (file) proof = await shrink(file, 900, 0.6).catch(() => null);
    let fix;
    try { fix = await S.warm; } catch {
      // Fall back to a recent background fix, then one more try, before giving up.
      if (S.fix && Date.now() - S.fix.at < 90000) fix = S.fix;
      else fix = await getFix(10000, 50).catch(() => null);
    }
    if (!fix && S.locDenied) { showLocHelp(); return; }
    if (!fix) {
      sheet(`<div class="emoji">📍</div><h2>We couldn't find your location</h2>
        <p class="muted">Make sure Location is on for this website, step out from under any awning, and try again.</p>
        <button class="btn-primary btn-big" data-close>OK</button>`);
      return;
    }
    // "at" is in server time so a check-in sent late (no signal) still counts if it was taken before the end.
    const attempt = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), photo_id: S.pending.photo_id, lat: fix.lat, lng: fix.lng, acc: fix.acc, replace: S.pending.replace ? 1 : 0, proof: proof ? await blobToDataUrl(proof) : null, at: Date.now() + S.offset, round: S.data.game.started_at || 0 };
    send(attempt);
  }

  async function send(attempt, fromQueue) {
    const fd = new FormData();
    fd.append('photo_id', attempt.photo_id);
    fd.append('lat', attempt.lat); fd.append('lng', attempt.lng); fd.append('acc', attempt.acc ?? '');
    fd.append('replace', attempt.replace ? '1' : '0');
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
          ? `<div class="emoji">📶</div><h2>No signal right now</h2><p class="muted">We saved your photo and location and will send them once you're back online. Keep hunting!</p><button class="btn-primary btn-big" data-close data-back>OK</button>`
          : `<div class="emoji">📶</div><h2>No signal right now</h2><p class="muted">We couldn't save this one. Try again when you have signal.</p><button class="btn-primary btn-big" data-close>OK</button>`);
        renderAll(true);
      }
      return false;
    }
    showResult(r, attempt, fromQueue);
    poll(true);
    return true;
  }

  async function flushQueue() {
    if (S.flushing || !store.get('queue', []).length) return;
    S.flushing = true;
    try {
      for (;;) {
        const next = store.get('queue', [])[0];
        if (!next) break;
        // Saved before the admin reset the game: that round is over, so drop it.
        if (S.data && next.round !== undefined && next.round !== (S.data.game.started_at || 0)) {
          store.set('queue', store.get('queue', []).filter((a) => a.id !== next.id));
          continue;
        }
        const ok = await send(next, true);
        if (!ok) break;
        // Re-read before removing, in case a new check-in was queued while this one was sending.
        store.set('queue', store.get('queue', []).filter((a) => (a.id || a.at) !== (next.id || next.at)));
      }
    } finally { S.flushing = false; renderAll(true); }
  }

  function showResult(r, attempt, fromQueue) {
    // Sent from the offline queue: don't pop a sheet over whatever the player is doing now.
    if (fromQueue) {
      const n = numOf(attempt.photo_id);
      if (r.result === 'submitted') toast('#00933c', `<b>Sent!</b> Photo #${n} went through.`);
      else if (r.result === 'already') toast('#666', `Photo #${n}: a teammate already sent this one.`);
      else if (r.result === 'ended') toast('#ee352e', `Photo #${n} arrived too late. The game is over.`);
      return;
    }
    const back = '<button class="btn-primary btn-big" data-close data-back>Back to photos</button>';
    const msgs = {
      submitted: `<div class="emoji">📸</div><h1>Sent!</h1><p class="muted">Your picture and location are in. You'll find out what counted when the results are revealed at the end.</p>${back}`,
      already: `<div class="emoji">✅</div><h2>Your team already sent this one.</h2><p class="muted">Only one answer per team counts. Sending yours replaces your teammate's, even if theirs was right.</p>
        ${back}<button class="btn-big" id="replaceBtn">Send mine instead</button>`,
      not_started: `<div class="emoji">⏰</div><h2>The game hasn't started yet.</h2><button class="btn-primary btn-big" data-close>OK</button>`,
      ended: `<div class="emoji">🏁</div><h2>The game is over.</h2><p class="muted">Head back to home base!</p><button class="btn-primary btn-big" data-close>OK</button>`,
    };
    sheet(msgs[r.result] || `<div class="emoji">😕</div><h2>Something went wrong. Please try again.</h2><button class="btn-primary btn-big" data-close>OK</button>`);
    if (r.result === 'submitted') confetti();
    const rb = $('#replaceBtn');
    if (rb) rb.onclick = () => { sheet('<div class="spinner"></div><h2>Sending…</h2>'); send({ ...attempt, replace: 1 }); };
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
  // During the game: how many photos each team and person has sent. After the reveal: points.
  function renderScores() {
    const el = $('#vScores');
    const g = S.data.game, show = revealed();
    const winner = show && S.data.teams[0];
    const roster = (t) => (t.roster || []).length
      ? `<div class="roster">${t.roster.map((p) => `<span>${esc(p.name)} <b>${p.submitted}</b></span>`).join('')}</div>`
      : '<div class="small muted">No players yet</div>';
    el.innerHTML = `
      ${winner ? `<div class="winner" style="background:${esc(winner.color)}"><h1>🏆 ${esc(winner.name)} team wins!</h1><p>${winner.score} points${S.data.teams[1]?.score === winner.score ? ' · tied, but got there first' : ''}</p></div>` : ''}
      ${!show ? `<div class="note info" style="margin-bottom:1em">🤫 <b>Points are secret until the end.</b> ${g.status === 'ended' ? 'The results will be revealed at home base.' : 'For now you can see how many photos everyone has sent.'}</div>` : ''}
      <div class="card">
        <h2>${show ? 'Final scores' : 'Photos sent'}</h2>
        ${S.data.teams.map((t, i) => `
          <div class="score-row ${t.id === S.data.me.team_id ? 'me' : ''}">
            ${show ? `<span class="rank">${i + 1}</span>` : ''}
            <span class="bullet" style="background:${esc(t.color)};font-size:1em">${esc(t.name[0])}</span>
            <div class="grow">
              <b class="name">${esc(t.name)}</b>
              ${roster(t)}
              ${show ? `<div class="counts">
                ${[1, 2, 3].map((d) => `<span><span class="bullet d${d}">${'EMH'[d - 1]}</span>${t.by_diff?.[d - 1] ?? 0}</span>`).join('')}
                <span class="muted">${t.found} of ${t.submitted} counted</span>
              </div>` : ''}
            </div>
            <span class="pts">${show ? t.score : t.submitted}<small>${show ? 'pts' : 'sent'}</small></span>
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
      S.layers = { area: L.layerGroup().addTo(S.map), trail: L.layerGroup().addTo(S.map), pins: L.layerGroup().addTo(S.map), mates: L.layerGroup().addTo(S.map), me: L.layerGroup().addTo(S.map) };
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
    const { area, pins } = S.layers;
    area.clearLayers(); pins.clearLayers();
    const b = S.data.game.boundary;
    if (b) {
      // Dim everything outside the play area.
      L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], b], { stroke: false, fillColor: '#000', fillOpacity: 0.3, interactive: false }).addTo(area);
      L.polygon(b, { color: '#e8590c', weight: 4, fill: false, interactive: false }).addTo(area);
    }
    const h = S.data.game.home;
    if (h) {
      const hd = homeDist();
      L.marker([h.lat, h.lng], { icon: L.divIcon({ className: '', html: '<div class="home-pin">🏠</div>', iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 800 })
        .bindTooltip(esc(h.label), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'home-label' })
        .bindPopup(`<b>🏠 ${esc(h.label)}</b>${hd != null ? `<br>${distText(hd)} from you` : ''}<br><a href="${directionsUrl(h)}" target="_blank" rel="noopener">Walking directions</a>`)
        .addTo(area);
    }
    $('#homeBtn').classList.toggle('hidden', !h);
    const team = myTeam(), color = team?.color || '#2f855a';
    $('#mapKey').innerHTML = `${h ? `<div><span class="key-home">🏠</span> ${esc(h.label)}</div>` : ''}<div><span class="swatch" style="background:#0039a6"></span> You + your trail</div>
      <div><span class="swatch" style="background:${esc(color)};outline:2px solid #fff;outline-offset:-4px"></span> Teammates</div>
      <div><span class="key-pin" style="background:${esc(color)}">✓</span> Sent by your team</div>`;
    // Spots where your team sent photos, marked with a check.
    const icon = (txt, cls = '') => L.divIcon({ className: '', html: `<div class="find-pin ${cls}" style="background:${esc(color)}">${txt}</div>`, iconSize: [24, 24] });
    S.data.finds.filter((f) => f.team_id === S.data.me.team_id && f.lat != null).forEach((f) => {
      const p = S.data.photos.find((x) => x.id === f.photo_id);
      const mark = revealed() ? (f.counted ? '✓' : '✕') : '✓';
      L.marker([f.lat, f.lng], { icon: icon(mark, revealed() && !f.counted ? 'miss' : '') })
        .bindPopup(`<img src="${esc(p?.thumb)}" style="width:150px;border-radius:6px;margin-bottom:4px"><b>#${numOf(f.photo_id)}</b> · ${esc(f.player_name || '')} · ${timeText(f.created_at)}`).addTo(pins);
    });
    drawTrail(); updateMates(); updateMe();
  }

  // Strava-style line of where this phone has walked during the game.
  function drawTrail() {
    if (!S.map || !S.data) return;
    const t = store.get(trailKey(), []);
    const line = t.length > 1 ? t : [];
    if (!S.trailLine) {
      S.trailCase = L.polyline([], { color: '#fff', weight: 8, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(S.layers.trail);
      S.trailLine = L.polyline([], { color: '#0039a6', weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(S.layers.trail);
    }
    S.trailCase.setLatLngs(line); S.trailLine.setLatLngs(line);
  }

  // Teammates' last known spots (sent every ~25 seconds while their app is open).
  function updateMates() {
    if (!S.map || !S.data) return;
    const layer = S.layers.mates; layer.clearLayers();
    const color = myTeam()?.color || '#2f855a', nowMs = Date.now() + S.offset;
    (S.data.mates || []).forEach((m) => {
      const mins = Math.round((nowMs - m.seen_at) / 60000), stale = mins >= 5;
      L.marker([m.lat, m.lng], { icon: L.divIcon({ className: '', html: `<div class="player-pin ${stale ? 'stale' : ''}" style="background:${esc(color)}"></div>`, iconSize: [18, 18] }), zIndexOffset: 500 })
        .bindTooltip(`${esc(m.name)}${stale ? ` · ${mins} min ago` : ''}`, { permanent: true, direction: 'top', offset: [0, -9], className: 'mate-label' })
        .addTo(layer);
    });
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
