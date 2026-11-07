// TV view for home base. Kept calm and simple: a map of where everyone is, one column per team
// showing the photos they've sent, and a big pop-up whenever a new photo comes in.
// Uses the admin password (shared with /admin on this browser).
(() => {
  const POLL_MS = 3000;  // the server answers "nothing new" cheaply, so check often
  const POP_MS = 9000;       // how long a new photo stays on screen
  const STALE_MS = 5 * 60000;
  const DIFF = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  // Same base map as the player and admin pages, with the OpenStreetMap backup.
  const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
  const TILE_ATTR = '© <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, USGS, OpenStreetMap';
  const BACKUP_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const BACKUP_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  function addBaseMap(map) {
    const opts = { maxZoom: 20, maxNativeZoom: 19 };
    map.attributionControl.setPrefix(false);
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

  // Settings, remembered on this TV.
  const SETTINGS = {
    noSpoilers: { label: 'No spoilers', help: 'Hide points, right/wrong and distances until you reveal the results.', def: false },
    popups: { label: 'Pop up new photos', help: 'Show each new photo big in the middle of the screen.', def: true },
    trails: { label: 'Walking trails', help: 'Draw the path each player has walked.', def: true },
    names: { label: 'Names on the map', help: 'Label each player\'s dot with their name.', def: true },
    spots: { label: 'Photo spots on the map', help: 'Show every hunt spot, numbered, like the host sees them. Careful: players could peek!', def: false },
    sound: { label: 'Sound', help: 'A chime for new photos, and music for the final reveal.', def: true },
  };
  const opt = (k) => { const v = localStorage.getItem('tv-' + k); return v === null ? SETTINGS[k].def : v === '1'; };
  const setOpt = (k, v) => localStorage.setItem('tv-' + k, v ? '1' : '0');

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = { pw: localStorage.getItem('adminPw'), d: null, offset: 0, gameKey: null, pings: {}, lastPing: 0, seen: null, queue: [], showing: false, revealShownFor: null, map: null, L: null, markers: {}, trails: {}, sig: {} };

  async function api(path) {
    const res = await fetch('/api/admin' + path, { headers: { 'x-admin': T.pw || '' } });
    if (res.status === 401) { localStorage.removeItem('adminPw'); T.pw = null; login('Wrong password.'); throw Object.assign(new Error('auth'), { auth: true }); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function login(err) {
    clearInterval(T.timer); T.timer = null;
    $('#app').innerHTML = `
      <div class="tv-login card stack">
        <h1 class="center">📺 Photo Hunt TV</h1>
        <form id="lf" class="stack"><label for="pw">Admin password</label><input id="pw" type="password" autocomplete="current-password" required autofocus>
        <button class="btn-primary btn-big">Start the TV view</button></form>
        <p class="error center">${esc(err || '')}</p>
      </div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      T.pw = $('#pw').value.trim();
      try { await api('/login'); localStorage.setItem('adminPw', T.pw); boot(); } catch { /* login() already shown */ }
    };
  }

  // ---------- layout ----------
  function boot() {
    $('#app').innerHTML = `
      <div class="tv-shell">
        <header class="tv-top">
          <span class="tv-title" id="title">🦃 Photo Hunt</span>
          <span class="tv-status" id="status"></span>
          <span class="tv-clock" id="clock"></span>
          <button class="tv-gear" id="gear">⚙ Settings</button>
        </header>
        <div class="tv-main">
          <div class="tv-map-wrap"><div id="tvMap"></div><div id="over"></div></div>
          <div class="tv-teams" id="teams"></div>
        </div>
      </div>`;
    T.map = L.map('tvMap', { zoomControl: false, zoomSnap: 0.25 }).setView([40.728, -74.005], 15);
    addBaseMap(T.map);
    T.L = { area: L.layerGroup().addTo(T.map), spots: L.layerGroup().addTo(T.map), trails: L.layerGroup().addTo(T.map), players: L.layerGroup().addTo(T.map) };
    T.markers = {}; T.trails = {}; T.sig = {};
    $('#gear').onclick = (e) => { e.stopPropagation(); toggleSettings(); };
    tick();
    soundHint();
    clearInterval(T.timer); T.timer = setInterval(tick, POLL_MS);
    if (!T.clockTimer) T.clockTimer = setInterval(renderClock, 1000);
  }
  window.addEventListener('resize', () => { if (T.map) { T.map.invalidateSize(); fit(); } });

  // ---------- settings ----------
  function toggleSettings() {
    if ($('#settings')) { $('#settings').remove(); return; }
    const box = document.createElement('div');
    box.className = 'settings'; box.id = 'settings';
    box.onclick = (e) => e.stopPropagation();
    box.innerHTML = `<h3>TV settings</h3>
      ${Object.entries(SETTINGS).map(([k, s]) => `<label><input type="checkbox" data-opt="${k}" ${opt(k) ? 'checked' : ''}><span><b>${s.label}</b><span>${s.help}</span></span></label>`).join('')}
      <div class="row"><button id="fsBtn">⛶ Full screen</button>${T.d?.game?.revealed ? '<button id="rvBtn">🏆 Show results again</button>' : ''}</div>
      <p class="small muted" style="margin:.6em 0 0">Keys: F full screen, H no spoilers, R show results again.</p>`;
    document.body.appendChild(box);
    box.querySelectorAll('[data-opt]').forEach((c) => c.onchange = () => { setOpt(c.dataset.opt, c.checked); applySettings(); });
    $('#fsBtn').onclick = fullscreen;
    const rv = $('#rvBtn'); if (rv) rv.onclick = () => { box.remove(); showReveal(); };
  }
  document.addEventListener('click', () => $('#settings')?.remove());
  function applySettings() {
    T.sig = {};
    T.L?.trails.clearLayers(); T.trails = {};
    T.L?.players.clearLayers(); T.markers = {};
    if (!opt('popups')) T.queue = [];
    soundHint();
    if (T.d) render();
  }
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  const hide = () => opt('noSpoilers') && !T.d?.game?.revealed;

  // ---------- data ----------
  async function tick() {
    if (T.busy || !T.pw || document.hidden) return;
    T.busy = true;
    try {
      let d = await api('/tv?since=' + T.lastPing + (T.v && T.d ? '&v=' + encodeURIComponent(T.v) : ''));
      if (d.same && T.d) {
        // Nothing changed except people moving: update dots, trails and the clock.
        T.offset = d.now - Date.now();
        for (const p of d.pings || []) { (T.pings[p.player_id] ||= []).push([p.lat, p.lng]); if (p.at > T.lastPing) T.lastPing = p.at; }
        T.d.players = d.players; T.d.now = d.now; T.down = false; // spots, finds etc. unchanged
        renderPlayers(); renderClock(); renderStatus();
        return;
      }
      // A new game, or the admin reset this one: start the trails and pop-ups over.
      const key = d.game ? d.game.id + ':' + (d.game.started_at || 0) : null;
      if (d.game && key !== T.gameKey) {
        const hadOld = T.gameKey !== null && T.lastPing > 0;
        T.gameKey = key; T.pings = {}; T.lastPing = 0; T.seen = null; T.queue = []; T.revealShownFor = null; T.teamOrder = null;
        T.L.trails.clearLayers(); T.L.players.clearLayers(); T.markers = {}; T.trails = {}; T.sig = {};
        if (hadOld) d = await api('/tv?since=0');
      }
      T.offset = d.now - Date.now();
      for (const p of d.pings || []) {
        (T.pings[p.player_id] ||= []).push([p.lat, p.lng]);
        if (p.at > T.lastPing) T.lastPing = p.at;
      }
      T.d = d; T.v = d.v; T.down = false;
      render();
    } catch (e) {
      if (!e.auth) { T.down = true; renderClock(); }
    } finally { T.busy = false; }
  }

  // ---------- helpers ----------
  const teamOf = (id) => T.d.teams.find((t) => t.id === id) || { name: '?', color: '#888' };
  const playerOf = (id) => T.d.players.find((p) => p.id === id);
  const photoOf = (id) => T.d.photos.find((p) => p.id === id);
  const numOf = (id) => T.d.photos.findIndex((p) => p.id === id) + 1;
  const feet = (m) => (m < 15 ? 'right there' : `${Math.round((m * 3.28) / 10) * 10} ft away`);
  const placeText = (n) => ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] || n + 'th';
  // Plain-words result for one answer. Empty while "No spoilers" is on.
  function verdict(f) {
    const none = { cls: '', short: '', long: '' };
    if (hide()) return none;
    const dist = f.distance_m != null ? feet(f.distance_m) : '';
    return {
      auto: { cls: 'yes', short: `✓ ${dist}`, long: '✓ Right spot!' },
      approved: { cls: 'yes', short: '✓ Judge: yes', long: '✓ The judge said yes' },
      pending: { cls: 'wait', short: `? ${dist}`, long: 'Close! The judge will check' },
      far: { cls: 'no', short: `✕ ${dist}`, long: '✕ Not the right spot' },
      rejected: { cls: 'no', short: '✕ Judge: no', long: '✕ The judge said no' },
    }[f.status] || none;
  }
  const changed = (key, val) => { if (T.sig[key] === val) return false; T.sig[key] = val; return true; };

  // ---------- render ----------
  function render() {
    const d = T.d;
    if (!d.game) { $('#over').innerHTML = '<div class="map-over"><div><h1>No game yet</h1><p>Create one on the admin page.</p></div></div>'; return; }
    $('#title').textContent = '🦃 ' + d.game.name;
    renderStatus();
    renderClock();
    if (changed('area', JSON.stringify(d.game.boundary))) drawArea();
    renderTeams(); renderSpots(); renderPlayers(); renderOverlay();
    queueNew();
    const rkey = d.game.id + ':' + d.game.revealed;
    if (d.game.revealed && T.revealShownFor !== rkey) { T.revealShownFor = rkey; showReveal(); }
    if (!d.game.revealed) { $('#reveal')?.remove(); T.revealShownFor = null; }
  }

  function renderStatus() {
    const d = T.d;
    const out = d.players.filter((p) => p.last_seen_at && d.now - p.last_seen_at < STALE_MS).length;
    $('#status').textContent = d.game.status === 'live' ? `${out} of ${d.players.length} players out hunting` : `${d.players.length} players`;
  }

  function renderClock() {
    const g = T.d?.game;
    if (!g) return;
    let c;
    if (T.down) c = 'Reconnecting…';
    else if (g.status === 'setup') c = 'Starting soon';
    else if (g.status === 'starting') {
      const n = Math.ceil((g.started_at - (Date.now() + T.offset)) / 1000);
      if (n <= 0) { g.status = 'live'; T.sig.over = null; renderOverlay(); c = ''; } // countdown over: open the map
      else { c = `Starting in ${n}`; const el = $('#cdNum'); if (el && el.textContent !== String(n)) { el.textContent = n; el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); Sound.ding(n <= 3 ? 3 : 1); } }
    }
    else if (g.status === 'ended') c = g.revealed ? 'Final results' : 'Time\'s up!';
    else if (!g.ends_at) c = '';
    else {
      const left = Math.max(0, g.ends_at - (Date.now() + T.offset));
      const m = Math.floor(left / 60000), h = Math.floor(m / 60), s = Math.floor(left / 1000) % 60;
      c = left ? (h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`) + ' left' : 'Time\'s up!';
    }
    $('#clock').textContent = c;
  }

  // One column per team, always in the same order so nothing jumps around.
  function renderTeams() {
    const d = T.d, h = hide();
    const ranked = [...d.teams].sort((a, b) => b.score - a.score || a.reached_at - b.reached_at);
    T.teamOrder ||= [];
    for (const t of d.teams) if (!T.teamOrder.includes(t.id)) T.teamOrder.push(t.id);
    const order = [...d.teams].sort((a, b) => T.teamOrder.indexOf(a.id) - T.teamOrder.indexOf(b.id));
    const anyPoints = d.teams.some((t) => t.score > 0);
    const html = order.map((t) => {
      const mine = d.finds.filter((f) => f.team_id === t.id).sort((a, b) => b.created_at - a.created_at);
      const tiles = mine.slice(0, 40).map((f) => {
        const p = photoOf(f.photo_id), v = verdict(f);
        const img = f.proof_key ? `/img/${f.proof_key}` : p?.thumb;
        return `<div class="tt ${v.cls} ${T.freshIds?.has(f.id) ? 'fresh' : ''}"><img src="${esc(img)}" alt="" loading="lazy"><span class="n">#${numOf(f.photo_id)}</span>
          <div class="cap">${v.short || (p ? DIFF[p.difficulty] : '')}</div></div>`;
      }).join('');
      const place = !h && anyPoints ? ranked.indexOf(t) + 1 : 0;
      return `<div class="tcol">
        <div class="thead" style="background:${esc(t.color)}">
          <div class="row1"><span class="nm">${esc(t.name)}</span>${place ? `<span class="place">${placeText(place)}</span>` : ''}</div>
          ${h ? `<div class="big">${t.submitted}<small>photos sent</small></div>`
            : `<div class="big">${t.score}<small>points</small></div><div class="sub">${t.submitted} photo${t.submitted === 1 ? '' : 's'} sent · ${t.found} right</div>`}
          <div class="who">${t.members.length ? esc(t.members.join(', ')) : 'No players yet'}</div>
        </div>
        <div class="tgrid">${tiles || '<div class="tempty">No photos yet</div>'}${mine.length > 40 ? `<div class="tmore">+ ${mine.length - 40} more</div>` : ''}</div>
      </div>`;
    }).join('');
    if (changed('teams', html)) $('#teams').innerHTML = html;
  }

  // ---------- map ----------
  function drawArea() {
    T.L.area.clearLayers();
    const b = T.d.game.boundary;
    if (!b) return;
    L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], b], { stroke: false, fillColor: '#000', fillOpacity: 0.3, interactive: false }).addTo(T.L.area);
    L.polygon(b, { color: '#e8590c', weight: 4, fill: false, interactive: false }).addTo(T.L.area);
    fit();
  }
  function fit() {
    const b = T.d?.game?.boundary;
    if (!T.map || !b) return;
    T.map.invalidateSize();
    T.map.fitBounds(b, { padding: [24, 24], animate: false });
  }

  // Optional layer: every hunt spot, numbered and colored by difficulty (green Easy, yellow Medium, red Hard).
  const DIFF_COLOR = { 1: '#00933c', 2: '#fccc0a', 3: '#ee352e' };
  function renderSpots() {
    const spots = opt('spots') ? (T.d.spots || []) : [];
    if (!changed('spots', JSON.stringify(spots) + T.d.photos.map((p) => p.id + p.difficulty).join())) return;
    T.L.spots.clearLayers();
    for (const sp of spots) {
      const p = photoOf(sp.id); if (!p) continue;
      const c = DIFF_COLOR[p.difficulty];
      L.circle([sp.lat, sp.lng], { radius: sp.radius_m, color: c, weight: 1, fillOpacity: 0.12, interactive: false }).addTo(T.L.spots);
      L.marker([sp.lat, sp.lng], { icon: L.divIcon({ className: '', html: `<div class="tv-spot d${p.difficulty}" style="background:${c}">${numOf(p.id)}</div>`, iconSize: [24, 24] }), interactive: false, zIndexOffset: -100 }).addTo(T.L.spots);
    }
  }

  // Each player's dot (and trail, if turned on), in their team color.
  function renderPlayers() {
    const d = T.d, seen = new Set();
    for (const p of d.players) {
      const t = teamOf(p.team_id);
      const trail = T.pings[p.id] || [];
      if (opt('trails') && trail.length > 1) {
        if (!T.trails[p.id]) T.trails[p.id] = L.polyline([], { weight: 3, opacity: 0.45, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(T.L.trails);
        T.trails[p.id].setLatLngs(trail).setStyle({ color: t.color });
      }
      if (p.last_lat == null) continue;
      seen.add(p.id);
      const stale = !p.last_seen_at || d.now - p.last_seen_at > STALE_MS;
      const html = `<div class="tv-player ${stale ? 'stale' : ''}" style="background:${esc(t.color)}"></div>`;
      let m = T.markers[p.id];
      if (!m) {
        m = T.markers[p.id] = L.marker([p.last_lat, p.last_lng], { icon: L.divIcon({ className: '', html, iconSize: [18, 18] }), zIndexOffset: 500, interactive: false }).addTo(T.L.players);
        if (opt('names')) m.bindTooltip(esc(p.name), { permanent: true, direction: 'top', offset: [0, -10], className: 'tv-label' });
        m._html = html;
      } else {
        m.setLatLng([p.last_lat, p.last_lng]);
        if (m._html !== html) { m.setIcon(L.divIcon({ className: '', html, iconSize: [18, 18] })); m._html = html; }
      }
    }
    for (const id of Object.keys(T.markers)) if (!seen.has(id)) { T.markers[id].remove(); delete T.markers[id]; }
  }

  function renderOverlay() {
    const d = T.d, g = d.game;
    let html = '';
    if (g.status === 'starting') {
      html = `<div class="map-over cd-over"><div><p>Get ready!</p><div class="tv-cd tick" id="cdNum">${Math.max(1, Math.ceil((g.started_at - (Date.now() + T.offset)) / 1000))}</div><p>The hunt starts in…</p></div></div>`;
    } else if (g.status === 'setup') {
      const url = location.origin + '/';
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      html = `<div class="map-over"><div><h1>Join the hunt!</h1><p>Point your phone's camera at the code.</p>
        <div class="qr">${q.createSvgTag({ cellSize: 8, margin: 2, scalable: true })}</div><p>${esc(url.replace(/^https?:\/\//, ''))}</p></div></div>`;
    } else if (g.status === 'ended' && !g.revealed) {
      html = `<div class="map-over"><div><div style="font-size:3.5em">🏁</div><h1>Time's up!</h1><p>Everyone head back.<br>Results coming soon…</p></div></div>`;
    }
    if (changed('over', html)) $('#over').innerHTML = html;
  }

  // ---------- new-photo pop-up ----------
  function queueNew() {
    const subs = T.d.finds.filter((f) => f.player_id); // photos players sent (not judge add-ins)
    if (!T.seen) { T.seen = new Set(subs.map((f) => f.id)); return; } // don't replay history when the TV opens
    const fresh = subs.filter((f) => !T.seen.has(f.id)).sort((a, b) => a.created_at - b.created_at);
    fresh.forEach((f) => T.seen.add(f.id));
    if (!fresh.length) return;
    // Briefly outline new tiles in their team column.
    T.freshIds = new Set(fresh.map((f) => f.id)); T.sig.teams = null; renderTeams();
    setTimeout(() => { T.freshIds = null; }, 3000);
    if (!opt('popups')) return;
    // Stay close to live: only the latest few.
    T.queue.push(...fresh.map((f) => f.id));
    T.queue = T.queue.slice(-4);
    if (!T.showing) nextPop();
  }

  const preload = (src) => new Promise((res) => {
    if (!src) return res();
    const i = new Image(); const done = () => res(); i.onload = done; i.onerror = done; i.src = src; setTimeout(done, 3000);
  });

  async function nextPop() {
    T.showing = true;
    if ($('#reveal')) { await wait(2000); return nextPop(); } // wait while the results are up
    const id = T.queue.shift();
    if (!id) { T.showing = false; return; }
    const f = T.d.finds.find((x) => x.id === id);
    if (!f || !opt('popups')) return nextPop();
    const t = teamOf(f.team_id), p = photoOf(f.photo_id), pl = playerOf(f.player_id), v = verdict(f);
    const name = pl?.name || f.player_name || 'Someone';
    const proof = f.proof_key ? `/img/${f.proof_key}` : null;
    await Promise.all([preload(p?.image), preload(proof)]);
    const back = document.createElement('div');
    back.className = 'pop-back';
    back.innerHTML = `<div class="pop">
      <div class="pop-head" style="background:${esc(t.color)}">📸 New photo from the ${esc(t.name)} team</div>
      <div class="pop-sub"><b>${esc(name)}</b> found photo <b>#${numOf(f.photo_id)}</b>${p ? ` · ${DIFF[p.difficulty]} · ${p.points} point${p.points === 1 ? '' : 's'}` : ''}</div>
      <div class="pop-pics">
        <figure><img src="${esc(p?.image)}" alt=""><figcaption>The photo they were looking for</figcaption></figure>
        <figure>${proof ? `<img src="${esc(proof)}" alt="">` : '<div class="nopic">No picture</div>'}<figcaption>${esc(name)}'s picture</figcaption></figure>
      </div>
      <div class="pop-verdict ${v.cls}">${v.long || 'Results at the end!'}${v.cls && f.distance_m != null ? `<small>${f.distance_m < 15 ? 'Right at the spot' : feet(f.distance_m) + ' from the spot'}</small>` : ''}</div>
    </div>`;
    back.onclick = () => back.remove();
    document.body.appendChild(back);
    Sound.chime();
    await wait(POP_MS);
    if (back.isConnected) { back.classList.add('out'); await wait(500); back.remove(); }
    nextPop();
  }

  // ---------- sound (made in the browser, no audio files) ----------
  const Sound = (() => {
    let ctx, out, noiseBuf;
    function ac() {
      if (!ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ctx = new C();
        out = ctx.createGain(); out.gain.value = 0.8; out.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const ch = noiseBuf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      }
      return ctx;
    }
    // Browsers only allow sound after someone clicks or presses a key on the page.
    function unlock() { const c = ac(); if (c && c.state === 'suspended') c.resume().then(soundHint, soundHint); else soundHint(); }
    const ready = () => opt('sound') && ctx && ctx.state === 'running';
    function tone(freq, at, dur, type = 'sine', vol = 0.2) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(vol, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(out); o.start(at); o.stop(at + dur + 0.05);
    }
    function noise(at, dur, vol, filter, freq) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; f.type = filter; f.frequency.value = freq;
      g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      s.connect(f).connect(g).connect(out); s.start(at); s.stop(at + dur + 0.05);
      return f;
    }
    return {
      unlock, ready,
      // A bright "ding" per photo; harder photos ring higher.
      ding(level) { if (!ready()) return; const t = ctx.currentTime, f = [0, 660, 880, 1175][level] || 880; tone(f, t, 0.4, 'triangle', 0.22); tone(f * 2, t, 0.25, 'sine', 0.06); },
      // Soft two-note chime for a new photo on the TV.
      chime() { if (!ready()) return; const t = ctx.currentTime; tone(784, t, 0.5, 'sine', 0.18); tone(1047, t + 0.16, 0.7, 'sine', 0.16); },
      // Soft airy sweep between sections (kept quiet and low).
      whoosh() { if (!ready()) return; const t = ctx.currentTime, f = noise(t, 0.6, 0.08, 'lowpass', 300); f.frequency.exponentialRampToValueAtTime(1800, t + 0.5); },
      // Suspense swell (instead of a drum roll): a warm chord that slowly brightens and grows,
      // over a low, gentle rumble. No clicks or hiss.
      swell(sec) {
        if (!ready()) return;
        const t = ctx.currentTime, end = t + sec;
        const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = 0.7;
        filt.frequency.setValueAtTime(250, t); filt.frequency.exponentialRampToValueAtTime(2200, end);
        const pad = ctx.createGain();
        pad.gain.setValueAtTime(0.0001, t); pad.gain.exponentialRampToValueAtTime(0.16, end - 0.05); pad.gain.exponentialRampToValueAtTime(0.0001, end + 0.35);
        filt.connect(pad).connect(out);
        // A minor-ish chord that lifts a step at the end, so it "asks a question".
        [[220, 247], [277, 311], [330, 370], [440, 494]].forEach(([from, to]) => {
          for (const detune of [-6, 6]) {
            const o = ctx.createOscillator(); o.type = 'triangle'; o.detune.value = detune;
            o.frequency.setValueAtTime(from, t); o.frequency.setValueAtTime(from, end - 0.6); o.frequency.exponentialRampToValueAtTime(to, end - 0.05);
            o.connect(filt); o.start(t); o.stop(end + 0.4);
          }
        });
        // Low timpani-like rumble: a deep tone gently pulsing.
        const low = ctx.createOscillator(), lg = ctx.createGain(), lfo = ctx.createOscillator(), lfoG = ctx.createGain();
        low.frequency.value = 55; lfo.frequency.value = 7; lfoG.gain.value = 0.05;
        lg.gain.setValueAtTime(0.0001, t); lg.gain.exponentialRampToValueAtTime(0.18, end - 0.05); lg.gain.exponentialRampToValueAtTime(0.0001, end + 0.3);
        lfo.connect(lfoG).connect(lg.gain);
        low.connect(lg).connect(out); low.start(t); lfo.start(t); low.stop(end + 0.35); lfo.stop(end + 0.35);
      },
      // Low "nope" buzz for an answer that didn't count.
      buzz() { if (!ready()) return; const t = ctx.currentTime; tone(160, t, 0.3, 'square', 0.09); tone(115, t + 0.13, 0.38, 'square', 0.09); },
      // Big warm "ta-da" hit: a deep boom plus a soft bell chord (no harsh cymbal).
      crash() {
        if (!ready()) return;
        const t = ctx.currentTime;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.6);
        g.gain.setValueAtTime(0.45, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g).connect(out); o.start(t); o.stop(t + 1);
        [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, t + i * 0.03, 2.2, 'sine', 0.06));
      },
      fanfare() {
        if (!ready()) return;
        const t = ctx.currentTime + 0.05;
        [[523, 0, 0.16], [659, 0.16, 0.16], [784, 0.32, 0.16], [1047, 0.5, 0.3], [784, 0.82, 0.14], [1047, 0.98, 1.4]].forEach(([f, s, d]) => {
          tone(f, t + s, d + 0.15, 'triangle', 0.22); tone(f / 2, t + s, d + 0.15, 'sawtooth', 0.04);
        });
        [523, 659, 784].forEach((f) => tone(f, t + 0.98, 1.6, 'sine', 0.1));
      },
    };
  })();
  // A small note on screen until sound is allowed.
  function soundHint() {
    const need = opt('sound') && !Sound.ready();
    let el = $('#soundHint');
    if (need && !el) { el = document.createElement('div'); el.id = 'soundHint'; el.className = 'sound-hint'; el.textContent = '🔈 Click anywhere once to turn on sound'; document.body.appendChild(el); }
    if (!need && el) el.remove();
  }
  ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => Sound.unlock(), { passive: true }));

  // ---------- final reveal: count up every photo, Easy → Medium → Hard, then the winner ----------
  async function showReveal() {
    $('#reveal')?.remove();
    document.querySelectorAll('.pop-back').forEach((x) => x.remove());
    const d = T.d;
    const teams = (T.teamOrder || []).map((id) => d.teams.find((t) => t.id === id)).filter(Boolean);
    d.teams.forEach((t) => { if (!teams.includes(t)) teams.push(t); });
    if (!teams.length) return;
    const ranked = [...teams].sort((a, b) => b.score - a.score || a.reached_at - b.reached_at);
    const yes = (f) => f.status === 'auto' || f.status === 'approved';
    // Each team's answer for a photo (at most one), and the photos anyone answered, in number order.
    const answer = (t, p) => d.finds.find((f) => f.team_id === t.id && f.photo_id === p.id) || null;
    const run = (T.revealRun = { fast: false, speed: 1 });
    const o = document.createElement('div');
    o.className = 'reveal'; o.id = 'reveal';
    o.innerHTML = `<div class="rv-btns"><span class="rv-speed">Speed ${[1, 2, 4].map((x) => `<button data-sp="${x}" class="${x === 1 ? 'on' : ''}">${x}×</button>`).join('')}</span><button id="rvSkip">Skip to the winner</button><button id="rvClose">Back to the map</button></div>
      <div class="rv-stage"><div class="rv-title" id="rvTitle"></div><div class="rv-sub" id="rvSub"></div><div class="rv-round" id="rvRound"></div></div>
      <div class="rv-lanes" id="rvLanes">${teams.map((t) => `
        <div class="lane" data-team="${esc(t.id)}" style="--c:${esc(t.color)}">
          <div class="ln-name">${esc(t.name)}<small>${esc(t.members.join(', '))}</small></div>
          <div class="ln-track"><div class="ln-fill"></div></div>
          <div class="ln-score">0</div>
        </div>`).join('')}</div>`;
    document.body.appendChild(o);
    $('#rvClose').onclick = () => o.remove();
    $('#rvSkip').onclick = () => { run.fast = true; $('#rvSkip').remove(); o.querySelector('.rv-speed')?.remove(); };
    o.querySelectorAll('[data-sp]').forEach((b) => b.onclick = () => { run.speed = Number(b.dataset.sp); o.querySelectorAll('[data-sp]').forEach((x) => x.classList.toggle('on', x === b)); });
    const live = () => o.isConnected && T.revealRun === run;
    const pause = (ms) => (run.fast ? Promise.resolve() : wait(ms / run.speed));
    const title = (t, sub = '') => { $('#rvTitle').textContent = t; $('#rvSub').textContent = sub; $('#rvTitle').classList.remove('in'); void $('#rvTitle').offsetWidth; $('#rvTitle').classList.add('in'); };
    const maxScore = Math.max(1, ...teams.map((t) => t.score));
    const score = Object.fromEntries(teams.map((t) => [t.id, 0]));
    const lane = (id) => o.querySelector(`.lane[data-team="${CSS.escape(id)}"]`);
    const setScore = (id, v) => {
      score[id] = v;
      const l = lane(id); if (!l) return;
      l.querySelector('.ln-fill').style.width = (100 * v) / maxScore + '%';
      l.querySelector('.ln-score').textContent = v;
      l.classList.remove('bump'); void l.offsetWidth; l.classList.add('bump');
    };
    // Load every picture up front so nothing pops in late.
    d.finds.forEach((f) => { if (f.proof_key) preload(`/img/${f.proof_key}`); });
    d.photos.forEach((p) => { if (teams.some((t) => answer(t, p))) preload(p.image); });

    title('The results are in!', 'Let\'s go through every photo…');
    Sound.swell(2.6);
    await pause(2800);
    for (const level of [1, 2, 3]) {
      if (!live()) return;
      if (run.fast) break;
      const photos = d.photos.filter((p) => p.difficulty === level && teams.some((t) => answer(t, p)));
      const pts = d.photos.find((p) => p.difficulty === level)?.points ?? level;
      $('#rvRound').innerHTML = '';
      title(`${DIFF[level]} photos`, `${pts} point${pts === 1 ? '' : 's'} each · ${photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} to check` : 'nobody tried one!'}`);
      Sound.whoosh();
      await pause(2000);
      for (const [i, p] of photos.entries()) {
        if (!live()) return;
        if (run.fast) break;
        // 1. The photo, and every team's answer next to it.
        $('#rvTitle').textContent = `${DIFF[level]} photos`;
        $('#rvSub').textContent = `Photo ${i + 1} of ${photos.length}`;
        $('#rvRound').innerHTML = `<div class="rnd">
          <figure class="rnd-target"><img src="${esc(p.image)}" alt=""><figcaption><b>#${numOf(p.id)}</b>${p.title ? ' · ' + esc(p.title) : ''} · ${p.points} pt${p.points === 1 ? '' : 's'}</figcaption></figure>
          <div class="rnd-answers" style="--n:${teams.length}">${teams.map((t, k) => {
            const f = answer(t, p), pl = f && playerOf(f.player_id);
            const img = f && (f.proof_key ? `/img/${f.proof_key}` : null);
            return `<div class="ans ${f ? '' : 'none'}" data-t="${esc(t.id)}" style="--c:${esc(t.color)};animation-delay:${k * 0.25}s">
              <div class="ans-h">${esc(t.name)}</div>
              <div class="ans-pic">${f ? (img ? `<img src="${esc(img)}" alt="">` : `<div class="ans-nopic">${pl ? 'No picture' : 'Added by the judge'}</div>`) : '<div class="ans-nopic">No answer</div>'}
                <div class="ans-stamp"></div></div>
              <div class="ans-by">${f ? esc(pl?.name || 'Judge') : '&nbsp;'}</div>
            </div>`;
          }).join('')}</div></div>`;
        Sound.chime();
        await pause(2200);
        // 2. Stamp each answer: green check or red X, then add the points.
        for (const t of teams) {
          const f = answer(t, p); if (!f) continue;
          if (!live()) return;
          const card = o.querySelector(`.ans[data-t="${CSS.escape(t.id)}"]`);
          const ok = yes(f);
          card.classList.add(ok ? 'yes' : 'no');
          card.querySelector('.ans-stamp').innerHTML = ok ? `<span>✓</span><b>+${p.points}</b>` : '<span>✕</span>';
          if (ok) { Sound.ding(level); setScore(t.id, score[t.id] + p.points); } else Sound.buzz();
          await pause(700);
        }
        await pause(1500);
      }
    }
    if (!live()) return;
    // Make sure the bars end on the official scores (also after "Skip").
    teams.forEach((t) => setScore(t.id, t.score));
    $('#rvRound').innerHTML = '';
    o.querySelector('.rv-speed')?.remove();
    title('Final scores');
    // Slide the lanes into finishing order.
    const box = $('#rvLanes'), before = new Map([...box.children].map((el) => [el, el.getBoundingClientRect().top]));
    ranked.forEach((t) => box.appendChild(lane(t.id)));
    [...box.children].forEach((el) => {
      const dy = before.get(el) - el.getBoundingClientRect().top;
      el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = 'transform .9s cubic-bezier(.3,1.2,.4,1)'; el.style.transform = ''; }));
    });
    ranked.forEach((t, i) => lane(t.id).querySelector('.ln-name').insertAdjacentHTML('afterbegin', `<span class="ln-rank">${i + 1}</span>`));
    await wait(run.fast ? 900 : 1800);
    if (!live()) return;
    title('And the winner is…');
    $('#rvRound').innerHTML = '<div class="rv-win"><div class="rv-trophy wait">🥁</div></div>';
    Sound.swell(3.0);
    await wait(3100);
    if (!live()) return;
    const w = ranked[0], tie = ranked[1] && ranked[1].score === w.score;
    title(`${w.name} team wins!`, `${w.score} points${tie ? ' · tied, but they got there first' : ''} · ${w.members.join(', ')}`);
    $('#rvTitle').style.color = w.color;
    lane(w.id).classList.add('winner');
    $('#rvRound').innerHTML = `<div class="rv-win"><div class="rv-trophy">🏆</div><div class="rv-wname" style="color:${esc(w.color)}">${esc(w.name)}</div><div class="rv-wpts">${w.score} points · ${w.found} photo${w.found === 1 ? '' : 's'} right</div></div>`;
    $('#rvSkip')?.remove();
    Sound.crash(); Sound.fanfare();
    confetti();
  }
  function confetti() {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:3100';
    document.body.appendChild(c);
    c.width = innerWidth; c.height = innerHeight;
    const ctx = c.getContext('2d');
    const colors = ['#e8590c', '#fccc0a', '#00933c', '#ee352e', '#0039a6', '#8b4513', '#fff'];
    const bits = Array.from({ length: 320 }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.6, vx: (Math.random() - 0.5) * 5, vy: 2 + Math.random() * 5, r: Math.random() * 6.28, s: 10 + Math.random() * 10, col: colors[(Math.random() * colors.length) | 0] }));
    const start = performance.now();
    (function frame(tm) {
      ctx.clearRect(0, 0, c.width, c.height);
      bits.forEach((b) => { b.x += b.vx; b.y += b.vy; b.vy += 0.04; b.r += 0.08; ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.col; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore(); });
      if (tm - start < 6000) requestAnimationFrame(frame); else c.remove();
    })(start);
  }

  // ---------- TV niceties: keep the screen awake, hide a still mouse, keyboard shortcuts ----------
  async function wake() { try { T.lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); tick(); } });
  let idleTimer;
  document.addEventListener('mousemove', () => { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000); });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || !T.d) return;
    const k = e.key.toLowerCase();
    if (k === 'f') fullscreen();
    if (k === 'h') { setOpt('noSpoilers', !opt('noSpoilers')); applySettings(); $('#settings')?.remove(); }
    if (k === 'r' && T.d.game?.revealed) showReveal();
    if (k === 'escape') { $('#settings')?.remove(); document.querySelectorAll('.pop-back').forEach((x) => x.remove()); }
  });

  wake();
  if (T.pw) boot(); else login();
})();
