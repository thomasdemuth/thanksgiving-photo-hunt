// TV view for home base. Kept calm and simple: a map of where everyone is, one column per team
// showing the photos they've sent, and a big pop-up whenever a new photo comes in.
// No password and no buttons: it only gets what the room may see, and the host controls it from the admin page.
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

  // Settings come from the server (the host sets them on the admin page). Same defaults as the server.
  const DEFAULTS = { noSpoilers: true, players: false, trails: false, names: true, spots: false, popups: true, joinCode: true, sound: true, speed: 1 };
  const opt = (k) => (T.d?.tv && k in T.d.tv ? T.d.tv[k] : DEFAULTS[k]);

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = { d: null, offset: 0, gameKey: null, pings: {}, lastPing: 0, seen: null, queue: [], showing: false, revealShownFor: null, map: null, L: null, markers: {}, trails: {}, sig: {} };

  async function api(path) {
    const res = await fetch('/api/tv' + path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ---------- layout ----------
  function boot() {
    $('#app').innerHTML = `
      <div class="tv-shell">
        <div class="tv-map-wrap"><div id="tvMap"></div><div id="cornerQr"></div><div id="over"></div></div>
        <div class="tv-side">
          <header class="tv-top">
            <span class="tv-title" id="title">🦃 Photo Hunt</span>
            <span class="tv-clock" id="clock"></span>
            <span class="tv-status" id="status"></span>
          </header>
          <div class="tv-teams" id="teams"></div>
        </div>
      </div>`;
    T.map = L.map('tvMap', { zoomControl: false, zoomSnap: 0.1 }).setView([40.728, -74.005], 15);
    addBaseMap(T.map);
    T.L = { area: L.layerGroup().addTo(T.map), spots: L.layerGroup().addTo(T.map), trails: L.layerGroup().addTo(T.map), players: L.layerGroup().addTo(T.map) };
    T.markers = {}; T.trails = {}; T.sig = {};
    tick();
    soundHint();
    clearInterval(T.timer); T.timer = setInterval(tick, POLL_MS);
    if (!T.clockTimer) T.clockTimer = setInterval(renderClock, 1000);
  }
  window.addEventListener('resize', () => { if (T.map) { T.map.invalidateSize(); fit(); } });

  // ---------- settings (changed from the admin page) ----------
  function applySettings(trailsChanged) {
    T.sig = {};
    if (trailsChanged) { T.pings = {}; T.lastPing = 0; } // fetch the whole trail history next time
    T.L?.trails.clearLayers(); T.trails = {};
    T.L?.players.clearLayers(); T.markers = {};
    if (!opt('popups')) T.queue = [];
    if (T.revealRun) T.revealRun.speed = opt('speed');
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
    if (T.busy || document.hidden) return;
    T.busy = true;
    try {
      let d = await api('?since=' + T.lastPing + (T.v && T.d ? '&v=' + encodeURIComponent(T.v) : ''));
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
        if (hadOld) d = await api('?since=0');
      }
      T.offset = d.now - Date.now();
      for (const p of d.pings || []) {
        (T.pings[p.player_id] ||= []).push([p.lat, p.lng]);
        if (p.at > T.lastPing) T.lastPing = p.at;
      }
      const prevTv = T.d?.tv;
      T.d = d; T.v = d.v; T.down = false;
      // The host changed a TV setting: redraw the map layers (and pop-ups, sound) to match.
      if (JSON.stringify(d.tv) !== JSON.stringify(prevTv)) { applySettings(!!prevTv && prevTv.trails !== d.tv?.trails); return; }
      render();
    } catch (e) {
      T.down = true; renderClock();
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
    if (changed('area', JSON.stringify([d.game.boundary, d.game.home]))) drawArea();
    renderTeams(); renderSpots(); renderPlayers(); renderOverlay(); renderAnnounce();
    queueNew();
    // The admin pressed "Play How to play on the TV" (only plays if pressed in the last minute).
    const tut = d.game.tutorial_at;
    if (tut && tut !== T.tutSeen) { T.tutSeen = tut; if (d.now - tut < 60000 && !d.game.revealed) playTutorial(); }
    if (!tut && T.tutSeen) { T.tutSeen = null; stopTutorial(); }
    // One-off commands from the admin page: show the results again, skip to the winner, back to the map.
    const cmd = d.game.cmd;
    if (cmd && cmd.at !== T.cmdSeen) {
      const first = T.cmdSeen === undefined; T.cmdSeen = cmd.at;
      if (!first && d.now - cmd.at < 60000) runCmd(cmd.cmd);
    } else if (!cmd) T.cmdSeen = null;
    const rkey = d.game.id + ':' + d.game.revealed;
    if (d.game.revealed && T.revealShownFor !== rkey) { T.revealShownFor = rkey; showReveal(); }
    if (!d.game.revealed) { $('#reveal')?.remove(); T.revealShownFor = null; }
  }

  function runCmd(c) {
    if (c === 'replay' && T.d.game.revealed) { $('#milesShow')?.remove(); showReveal(); }
    if (c === 'skip' && T.revealRun) T.revealRun.fast = true;
    if (c === 'miles') showMiles();
    if (c === 'close') { T.revealRun = null; $('#reveal')?.remove(); $('#milesShow')?.remove(); $('#tvAnn')?.remove(); stopTutorial(); document.querySelectorAll('.pop-back').forEach((x) => x.remove()); }
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
    // Before the start: just the team names, with everyone who has joined listed big underneath.
    if (['setup', 'starting'].includes(d.game.status)) {
      T.knownNames ||= new Set();
      // Random teams not revealed yet: everyone in one list, no teams.
      if (d.game.random_teams && !d.game.teams_ready) {
        const names = d.players.map((p) => p.name);
        const html = `<div class="tcol pre solo">
            <div class="thead" style="background:#5b4636"><div class="row1"><span class="nm">🎲 Who's playing</span></div><div class="sub">${names.length} here · teams will be picked at random</div></div>
            <div class="tnames grid ${names.length > 18 ? 'many' : ''}">${names.length ? names.map((n) => `<div class="pname ${T.knownNames.has('all' + n) ? '' : 'new'}" style="--c:#e8590c">${esc(n)}</div>`).join('') : '<div class="tempty">Waiting for players…</div>'}</div>
          </div>`;
        if (changed('teams', html.replace(/ new"/g, '"'))) {
          $('#teams').innerHTML = html;
          const fresh = names.some((n) => !T.knownNames.has('all' + n));
          names.forEach((n) => T.knownNames.add('all' + n));
          if (fresh && T.namesPrimed) Sound.chime();
          T.namesPrimed = true;
        }
        T.teamsHidden = true;
        return;
      }
      const justShown = T.teamsHidden; T.teamsHidden = false;
      if (justShown) { Sound.whoosh(); setTimeout(() => Sound.fanfare(), 300); T.namesPrimed = false; }
      const html = order.map((t) => `<div class="tcol pre">
          <div class="thead" style="background:${esc(t.color)}"><div class="row1"><span class="nm">${esc(t.name)}</span></div></div>
          <div class="tnames ${t.members.length > 6 ? 'many' : ''}">${t.members.length ? t.members.map((n) => `<div class="pname ${T.knownNames.has(t.id + n) ? '' : 'new'}" style="--c:${esc(t.color)}">${esc(n)}</div>`).join('')
            : '<div class="tempty">Waiting for players…</div>'}</div>
        </div>`).join('');
      if (changed('teams', html.replace(/ new"/g, '"'))) {
        $('#teams').innerHTML = html;
        const fresh = order.some((t) => t.members.some((n) => !T.knownNames.has(t.id + n)));
        order.forEach((t) => t.members.forEach((n) => T.knownNames.add(t.id + n)));
        if (fresh && T.namesPrimed) Sound.chime();
        T.namesPrimed = true;
      }
      return;
    }
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
    const h = T.d.game.home;
    if (h) L.marker([h.lat, h.lng], { icon: L.divIcon({ className: '', html: '<div class="home-pin">🏠</div>', iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false, zIndexOffset: 400 })
      .bindTooltip(esc(h.label), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'home-label' }).addTo(T.L.area);
    fit();
  }
  function fit() {
    const b = T.d?.game?.boundary, h = T.d?.game?.home;
    if (!T.map || !b) return;
    T.map.invalidateSize();
    // Tight fit so the streets are as big as possible; the map is the whole left side of the TV.
    T.map.fitBounds(h ? [...b, [h.lat, h.lng]] : b, { padding: [10, 10], animate: false });
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
    // Small join code during the game for anyone who arrives late.
    const corner = g.status === 'live' && opt('joinCode');
    if (changed('corner', corner)) {
      $('#cornerQr').innerHTML = corner ? (() => { const q = qrcode(0, 'M'); q.addData(location.origin + '/'); q.make(); return `<div class="corner-qr">${q.createSvgTag({ cellSize: 4, margin: 1, scalable: true })}<span>Late? Scan to join</span></div>`; })() : '';
    }
  }

  // The host's message ("Dinner's ready!"), big across the screen for half a minute.
  function renderAnnounce() {
    const a = T.d.game.announce;
    if (!a) { T.annAt = null; $('#tvAnn')?.remove(); return; }
    if (a.at === T.annAt) return;
    const first = T.annAt === undefined; T.annAt = a.at;
    if (first && T.d.now - a.at > 120000) return; // the TV just opened: don't replay an old message
    $('#tvAnn')?.remove();
    const el = document.createElement('div'); el.id = 'tvAnn'; el.className = 'tv-ann';
    el.innerHTML = `<div class="tv-ann-box"><div class="tv-ann-icon">📣</div><div><div class="tv-ann-from">Message from the host</div><div class="tv-ann-text">${esc(a.text)}</div></div></div>`;
    el.onclick = () => el.remove();
    document.body.appendChild(el);
    Sound.chime(); setTimeout(() => Sound.chime(), 900);
    clearTimeout(T.annTimer); T.annTimer = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, 30000);
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
    if ($('#reveal') || $('#tut')) { await wait(2000); return nextPop(); } // wait while the results or the demo are up
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
      // Soft tick for a finger tap in the demo, and a camera shutter.
      tap() { if (!ready()) return; tone(1400, ctx.currentTime, 0.06, 'sine', 0.05); },
      shutter() { if (!ready()) return; const t = ctx.currentTime; noise(t, 0.05, 0.22, 'highpass', 1800); noise(t + 0.08, 0.07, 0.16, 'bandpass', 1200); },
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
    if (need && !el) { el = document.createElement('div'); el.id = 'soundHint'; el.className = 'sound-hint'; el.textContent = '🔈 Click anywhere once for sound and full screen'; document.body.appendChild(el); }
    if (!need && el) el.remove();
  }
  ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => Sound.unlock(), { passive: true }));
  // Browsers only allow full screen after a click, so the first click on the TV turns it on.
  document.addEventListener('click', () => { if (!T.fsTried && !document.fullscreenElement) { T.fsTried = true; fullscreen(); } });

  // ---------- "How to play" demo for the TV (the admin starts it; T plays it here too) ----------
  async function playTutorial() {
    stopTutorial(true);
    const run = T.tutRun = {};
    const alive = () => T.tutRun === run;
    const later = (ms, fn) => setTimeout(() => { if (alive()) fn(); }, ms);
    document.querySelectorAll('.pop-back').forEach((x) => x.remove());
    const d = T.d;
    const teams = d.teams.length ? d.teams : [{ name: 'Red', color: '#ee352e', members: [] }, { name: 'Blue', color: '#0039a6', members: [] }];
    const t0 = teams[0], t1 = teams[1] || teams[0];
    const names = [...new Set(teams.flatMap((t) => t.members))];
    const sample = (names.length >= 3 ? names : [...names, 'Grandma', 'Mike', 'Ava', 'Leo'].filter((n, i, a) => a.indexOf(n) === i)).slice(0, 4);
    const me = sample[0];
    const ptsFor = (lvl) => d.photos.find((p) => p.difficulty === lvl)?.points ?? lvl;
    const qr = (() => { const q = qrcode(0, 'M'); q.addData(location.origin + '/'); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); })();
    const diffTag = (lvl) => `<span class="tp-diff d${lvl}">${'EMH'[lvl - 1]}</span>`;

    const el = document.createElement('div');
    el.id = 'tut'; el.className = 'tut';
    el.innerHTML = `<div class="tut-stage">
        <div class="tut-text"><div class="tut-step" id="tutStep"></div><h1 id="tutTitle"></h1><p id="tutSub"></p></div>
        <div class="tut-phone"><div class="tut-notch"></div><div class="tut-screen" id="tutScreen"></div></div>
        <div class="tut-side" id="tutSide"></div>
      </div>
      <div class="tut-dots" id="tutDots"></div>`;
    document.body.appendChild(el);
    const scr = () => $('#tutScreen');
    // A finger tap on something inside the phone.
    const tap = (sel) => {
      const s = scr(), target = s?.querySelector(sel); if (!target) return;
      const a = s.getBoundingClientRect(), b = target.getBoundingClientRect();
      const f = document.createElement('span'); f.className = 'tut-tap';
      f.style.left = (b.left - a.left + b.width / 2) + 'px'; f.style.top = (b.top - a.top + b.height / 2) + 'px';
      s.appendChild(f); target.classList.add('pressed'); Sound.tap();
      setTimeout(() => { f.remove(); target.classList.remove('pressed'); }, 900);
    };
    const type = (sel, text, ms) => { let i = 0; const iv = setInterval(() => { const e = scr()?.querySelector(sel); if (!alive() || !e || i >= text.length) { clearInterval(iv); return; } e.textContent = text.slice(0, ++i); }, ms); };
    // Swap the phone's screen, keeping any finger tap that is still fading out.
    const show = (html) => { const s = scr(); if (!s) return; const taps = [...s.querySelectorAll('.tut-tap')]; s.innerHTML = html; taps.forEach((t) => s.appendChild(t)); };
    const total = d.photos.length || 60;
    const DN = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
    const ptsTxt = (l) => `${ptsFor(l)} point${ptsFor(l) === 1 ? '' : 's'}`;
    const byDiff = (l) => d.photos.filter((p) => p.difficulty === l);
    const first = d.photos.slice(0, 4);
    const TICON = {
      photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
      map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
      scores: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
    };
    // Pieces of the real phone screens.
    const tabs = (on) => `<div class="tp-tabs">${[['photos', 'Photos'], ['map', 'Map'], ['scores', 'Scores']].map(([k, l]) => `<span class="${k === on ? 'on' : ''}" id="tpTab-${k}">${TICON[k]}${l}</span>`).join('')}</div>`;
    const head = (sent) => `<div class="tp-head"><div class="tp-row"><span class="tp-dot" style="background:${esc(t0.color)}">${esc(t0.name[0])}</span>${esc(t0.name)} team<span class="grow"></span><span class="tp-hb" id="tpHelp">?</span><span class="tp-hb" id="tpAa">Aa</span></div>
      <div class="tp-score"><b>${sent}</b>&nbsp;of ${total} sent<span class="grow"></span>🤫 points at the end</div></div>`;
    const seg = (on, sent) => `<div class="tp-seg"><span class="${on === 'todo' ? 'on' : ''}" id="tpTodo">To find · ${total - sent}</span><span class="${on === 'sent' ? 'on' : ''}" id="tpSentTab">Sent · ${sent}</span></div>`;
    const chips = (on) => `<div class="tp-chips2">${['All', 'Easy', 'Medium', 'Hard'].map((c, i) => `<span class="${i === on ? 'on' : ''}" id="tpChip${i}">${i ? `<i class="tp-diff d${i}">${'EMH'[i - 1]}</i>` : ''}${c}</span>`).join('')}</div>`;
    const img = (p, i, cls = '') => p ? `<img class="${cls}" src="${esc(p.thumb)}" alt="">` : `<div class="tp-fake ${cls}" style="background:hsl(${i * 50 + 20} 45% 55%)"></div>`;
    const tile = (p, i) => `<div class="tp-tile" id="tpTile${i}">${img(p, i)}<span class="tp-n">#${p ? d.photos.indexOf(p) + 1 : i + 1}</span>${diffTag(p?.difficulty || (i % 3) + 1)}<span class="tp-pts">${ptsFor(p?.difficulty || (i % 3) + 1)} pt${ptsFor(p?.difficulty || (i % 3) + 1) === 1 ? '' : 's'}</span></div>`;
    const grid = (list) => `<div class="tp-grid">${(list.length ? list : [null, null]).slice(0, 4).map(tile).join('')}</div>`;
    const photosTab = (chip, list, sent = 0) => `${head(sent)}<div class="tp-body">${seg('todo', sent)}${chips(chip)}${grid(list)}</div>${tabs('photos')}`;
    const p2 = d.photos[1];
    const bigImg = (cls = '') => p2 ? `<img class="tp-big ${cls}" src="${esc(p2.image)}" alt="">` : `<div class="tp-big tp-fake ${cls}" style="background:hsl(70 45% 55%)"></div>`;
    const detail = (extra = '') => `${head(0)}<div class="tp-body tp-pad2"><div class="tp-back">← Back to photos</div><div class="tp-zoomwrap">${bigImg('zoomable')}</div>
      <div class="tp-h">#2 <span class="tp-muted">· ${DN[p2?.difficulty || 2]} · ${ptsTxt(p2?.difficulty || 2)}</span></div>
      ${p2?.hint ? `<div class="tp-hint"><b>Hint:</b> ${esc(p2.hint)}</div>` : ''}${extra}<div class="tp-btn orange" id="tpFound">📸 I found it! Take the picture</div></div>${tabs('photos')}`;
    // "Your team's picture": the same spot, framed a little differently.
    const proof = (cls = '') => p2 ? `<img class="tp-proofimg ${cls}" src="${esc(p2.image)}" alt="">` : `<div class="tp-fake tp-proofimg ${cls}" style="background:hsl(80 40% 50%)"></div>`;
    const walk = () => {
      const path = scr()?.querySelector('#tpPath'); if (!path) return;
      const len = path.getTotalLength(); path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
      const start = performance.now(), D = 6000;
      (function step(now) {
        if (!alive() || !path.isConnected) return;
        const k = Math.min(1, (now - start) / D), ease = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        path.style.strokeDashoffset = len * (1 - ease);
        const p = path.getPointAtLength(len * ease), q = path.getPointAtLength(Math.max(0, len * ease - 22));
        const s = scr(), meDot = s.querySelector('#tpMe'), mate = s.querySelector('#tpMate'), mn = s.querySelector('#tpMateName');
        meDot.setAttribute('cx', p.x); meDot.setAttribute('cy', p.y); mate.setAttribute('cx', q.x - 9); mate.setAttribute('cy', q.y + 4);
        mn.setAttribute('x', q.x - 9); mn.setAttribute('y', q.y - 7);
        if (k < 1) setTimeout(() => step(performance.now()), 33); else Sound.chime();
      })(start);
    };
    const mateName = sample[1] || 'Mike';
    const mapTab = `${head(1)}<div class="tp-body tp-map"><svg viewBox="0 0 200 300" preserveAspectRatio="xMidYMid slice">
        <rect width="200" height="300" fill="#ecebe4"/><rect x="112" y="14" width="70" height="62" rx="4" fill="#cfe3c4"/>
        ${[40, 100, 160].map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="300" stroke="#fff" stroke-width="9"/>`).join('')}${[50, 125, 200, 275].map((y) => `<line x1="0" y1="${y}" x2="200" y2="${y}" stroke="#fff" stroke-width="9"/>`).join('')}
        <line x1="0" y1="300" x2="200" y2="0" stroke="#fff" stroke-width="7"/>
        <path id="tpPath" d="M40 290 L40 200 L100 200 L100 125 L160 125 L160 92" fill="none" stroke="#1a73e8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
        <g transform="translate(40 125)"><circle r="9" fill="#00933c" stroke="#fff" stroke-width="2.5"/><text y="3.5" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">✓</text></g>
        <g transform="translate(160 80)"><path d="M0 12 C-9 0 -9 -12 0 -12 C9 -12 9 0 0 12Z" fill="#e8590c"/><text y="-2" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">2</text></g>
        <circle id="tpMate" cx="31" cy="294" r="6" fill="${esc(t0.color)}" stroke="#fff" stroke-width="2.5"/><circle id="tpMe" cx="40" cy="290" r="7.5" fill="#1a73e8" stroke="#fff" stroke-width="3"/>
        <text id="tpMateName" x="31" y="283" font-size="9" font-weight="700" fill="#333" text-anchor="middle">${esc(mateName)}</text>
      </svg>
      <div class="tp-key"><div><i style="background:#1a73e8"></i>You + your trail</div><div><i style="background:${esc(t0.color)}"></i>Teammates</div><div><i style="background:#00933c"></i>Sent</div></div>
      <div class="tp-mapbtns"><span>Whole area</span><span class="on" id="tpShowMe">Show me</span></div></div>${tabs('map')}`;
    const sentTiles = `<div class="tp-grid">${[1, 3].map((i) => { const p = d.photos[i]; return `<div class="tp-tile" id="tpP${i}">${p ? `<img class="tp-proofimg" src="${esc(p.thumb)}" alt="">` : img(null, i, 'tp-proofimg')}${img(p, i, 'tp-inset')}<span class="tp-n">#${i + 1}</span><span class="tp-sent">✓ ${esc(i === 1 ? me : mateName)}</span></div>`; }).join('')}</div>`;
    // The phone's "?" guide: cards with Next / Back and Skip. Same words as the phone's short "How to play" list.
    const GUIDE = [['🔎', 'Pick any photo. Harder ones are worth more.'], ['🚶', 'Walk to the spot with your team.'], ['📸', 'Stand right there and take a picture.'], ['🤫', 'Results stay secret until the end.'], ['🏁', 'Come back when time is up.']];
    const guideCard = (k) => `<div class="tp-gtop"><span class="on">1. The game</span><span>2. Using the app</span><u id="tpGotIt">Skip</u></div>
      <div class="tp-gart">${GUIDE[k][0]}</div><p class="tp-gtext">${GUIDE[k][1]}</p>
      <div class="tp-gdots">${GUIDE.map((_, j) => `<i class="${j === k ? 'on' : ''}"></i>`).join('')}</div><div class="tp-btn" id="tpNext">Next →</div>`;
    const SENT = [2, 3, 1];
    const roster = (t, i) => {
      const ns = t.members.length ? t.members.slice(0, 3) : sample.slice(i, i + 2), c = ns.map(() => 0);
      for (let k = 0; k < SENT[i]; k++) c[k % ns.length]++; // the players' counts add up to the team's
      return ns.map((n, j) => `<span>${esc(n)} <b>${c[j]}</b></span>`).join('');
    };

    const scenes = [
      { title: 'Scan the code with your phone', sub: 'Open your camera, point it at the code, and tap the link. Then type your first name and pick your team.', dur: 9000,
        side: `<div class="tut-qr">${qr}<p>${esc(location.host)}</p></div>`,
        screen: `<div class="tp-pad"><div class="tp-turkey">🦃</div><div class="tp-h">${esc(d.game.name)}</div><div class="tp-label">Your first name</div><div class="tp-input"><span id="tpName"></span><i class="tp-caret"></i></div><div class="tp-btn" id="tpNext">Next</div></div>`,
        steps: [[700, () => type('#tpName', me, 160)], [2600, () => tap('#tpNext')], [3000, () => show(`<div class="tp-pad"><div class="tp-h">Hi ${esc(me)}!</div><p class="tp-muted">Pick your team.</p>${teams.slice(0, 4).map((t, i) => `<div class="tp-team" id="tpTeam${i}" style="background:${esc(t.color)}">${esc(t.name)}</div>`).join('')}</div>`)], [5000, () => tap('#tpTeam0')],
          [5500, () => show(`<div class="tp-pad tp-center"><div class="tp-turkey">📍</div><div class="tp-h">One more step</div><p class="tp-muted">Your phone asks to use your location. Tap <b>Allow</b>.</p><div class="tp-allow"><b>Allow location?</b><div><span>Don't Allow</span><span id="tpAllow">Allow</span></div></div></div>`)], [7500, () => tap('#tpAllow')]] },

      { title: 'Wait in the lobby', sub: 'Your screen turns your team\'s color. You can switch teams until the host presses Start. Then everyone counts down together.', dur: 9000,
        screen: `<div class="tp-lobby" style="background:${esc(t0.color)}"><div class="tp-badge" style="color:${esc(t0.color)}">${esc(t0.name[0])}</div><p>You're <b>${esc(me)}</b> on the <b>${esc(t0.name)}</b> team</p><div class="tp-h">Waiting for other players to join</div><div class="tp-chips" id="tpChips"></div></div>`,
        steps: [...sample.map((n, i) => [600 + i * 900, () => { const c = scr()?.querySelector('#tpChips'); if (c) { c.insertAdjacentHTML('beforeend', `<span class="tp-chip">${esc(n)}</span>`); Sound.tap(); } }]),
          ...[3, 2, 1].map((n, i) => [5000 + i * 900, () => { show(`<div class="tp-lobby tp-center" style="background:${esc(t0.color)}"><p>Get ready!</p><div class="tp-cd">${n}</div></div>`); Sound.ding(n === 1 ? 3 : 1); }]),
          [7700, () => { show(`<div class="tp-lobby tp-center" style="background:${esc(t0.color)}"><div class="tp-cd go">GO!</div><p>Happy hunting 🦃</p></div>`); Sound.ding(3); }]] },

      { title: 'The Photos tab', sub: 'Every photo to find is here. Tap Easy, Medium or Hard to see only those, and pick what to go after.', dur: 10000,
        screen: photosTab(0, first),
        side: `<div class="tut-callouts"><div><b>To find / Sent</b> switches between photos you still need and ones your team sent</div><div><b>E · M · H</b> shows one difficulty at a time</div></div>`,
        steps: [[2000, () => tap('#tpChip1')], [2350, () => show(photosTab(1, byDiff(1)))], [4400, () => tap('#tpChip3')], [4750, () => show(photosTab(3, byDiff(3)))], [6800, () => tap('#tpChip0')], [7150, () => show(photosTab(0, first))]] },

      { title: 'Easy, Medium or Hard', sub: `Easy photos are big, well-known spots. Medium ones take a closer look. Hard ones are small details you could walk right past, so they're worth the most.`, dur: 10000,
        screen: `${head(0)}<div class="tp-body tp-diffs">${[1, 2, 3].map((l) => `<div class="tp-drow" style="animation-delay:${(l - 1) * 0.7}s">${img(byDiff(l)[0], l)}<div><b>${diffTag(l)} ${DN[l]}</b><span>${ptsTxt(l)}</span></div></div>`).join('')}</div>${tabs('photos')}`,
        side: `<div class="tut-pts">${[1, 2, 3].map((l) => `<div class="tut-pt d${l}"><span>${'EMH'[l - 1]}</span><b>${DN[l]}</b><em>${ptsTxt(l)}</em></div>`).join('')}<p class="tut-note">Harder photos = more points.<br>Every team can find every photo.</p></div>`,
        steps: [[700, () => Sound.ding(1)], [1400, () => Sound.ding(2)], [2100, () => Sound.ding(3)]] },

      { title: 'Tap a photo to see it big', sub: 'Pinch with two fingers to zoom in on the details. When you think you\'re standing in that spot, tap "I found it!"', dur: 9000,
        screen: photosTab(0, first),
        steps: [[1300, () => tap('#tpTile1')], [1700, () => show(detail())], [3600, () => scr()?.querySelector('.zoomable')?.classList.add('zoomed')], [6400, () => scr()?.querySelector('.zoomable')?.classList.remove('zoomed')]] },

      { title: 'The Map tab', sub: 'The blue line is where you\'ve walked. Teammates show with their names, and ✓ marks spots your team sent. The photo spots aren\'t on the map. That\'s the hunt!', dur: 10000,
        screen: photosTab(0, first, 1),
        steps: [[700, () => tap('#tpTab-map')], [1050, () => { show(mapTab); walk(); }], [8200, () => tap('#tpShowMe')]] },

      { title: 'Stand where the photo was taken', sub: 'Tap "I found it!" and take a picture. Your phone tells the game where you are, so get right to the spot. Close calls go to the host.', dur: 9000,
        screen: detail(),
        steps: [[1500, () => tap('#tpFound')], [2000, () => show(`<div class="tp-cam">${bigImg()}<i class="c1"></i><i class="c2"></i><i class="c3"></i><i class="c4"></i><div class="tp-shutter" id="tpShutter"></div></div>`)],
          [3800, () => { tap('#tpShutter'); Sound.shutter(); scr()?.insertAdjacentHTML('beforeend', '<div class="tp-flash"></div>'); }],
          [4600, () => show(`${head(1)}<div class="tp-body tp-pad2 tp-center"><div class="tp-locating"></div><div class="tp-h">Getting your location…</div></div>${tabs('photos')}`)],
          [6000, () => { show(`${head(1)}<div class="tp-body tp-pad2 tp-center tp-done"><div class="tp-turkey">📸</div><div class="tp-h big">Sent!</div><p class="tp-muted">Your picture and location are in. You'll find out what counted at the end.</p></div>${tabs('photos')}`); Sound.chime(); }]] },

      { title: 'See what your team sent', sub: 'Tap "Sent" to see your team\'s pictures, with the photo you were hunting in the corner. Tap one to compare them side by side. Wrong spot? Tap "Send it again." The newest one counts.', dur: 10000,
        screen: photosTab(0, first, 2),
        steps: [[1200, () => tap('#tpSentTab')], [1550, () => show(`${head(2)}<div class="tp-body">${seg('sent', 2)}${chips(0)}${sentTiles}</div>${tabs('photos')}`)], [3800, () => tap('#tpP1')],
          [4150, () => show(`${head(2)}<div class="tp-body tp-pad2"><div class="tp-back">← Back to photos</div><div class="tp-compare"><figure>${bigImg()}<figcaption>The photo</figcaption></figure><figure><div class="tp-proofbox">${proof()}</div><figcaption>Your team's picture · ${esc(me)}</figcaption></figure></div>
            <div class="tp-ok">✓ Sent by ${esc(me)}. You'll find out if it counted at the end.</div><div class="tp-btn ghost" id="tpAgain">Wrong spot? Send it again</div></div>${tabs('photos')}`)],
          [7800, () => tap('#tpAgain')]] },

      { title: 'Results stay secret!', sub: 'Nobody sees what counted until the end, not even your team. Your phone and the TV show when another team finds something.', dur: 8500,
        screen: `${head(2)}<div class="tp-body">${seg('sent', 2)}${sentTiles}</div>${tabs('photos')}<div class="tp-toast" id="tpToast"><i style="background:${esc(t1.color)}"></i><span><b>${esc(t1.name)} team</b> found something!</span></div>`,
        side: `<div class="tut-tvpop" id="tpTv"><div class="h" style="background:${esc(t1.color)}">📸 New photo from the ${esc(t1.name)} team</div><div class="b">${img(d.photos[3], 3)}${img(d.photos[2], 2)}</div><div class="v">Results at the end! 🤫</div></div>`,
        steps: [[2000, () => { scr()?.querySelector('#tpToast')?.classList.add('on'); $('#tpTv')?.classList.add('on'); Sound.chime(); }]] },

      { title: 'The Scores tab', sub: 'Points stay secret until the end. Until then, see how many photos each team, and each player, has sent.', dur: 9000,
        screen: photosTab(0, first, 2),
        steps: [[1000, () => tap('#tpTab-scores')], [1350, () => show(`${head(2)}<div class="tp-body tp-pad2"><div class="tp-note">🤫 <b>Points are secret until the end.</b> For now you can see how many photos everyone has sent.</div>
          <div class="tp-card"><b>Photos sent</b>${teams.slice(0, 3).map((t, i) => `<div class="tp-srow"><span class="tp-dot" style="background:${esc(t.color)}">${esc(t.name[0])}</span><div class="grow"><b>${esc(t.name)}</b><div class="tp-roster">${roster(t, i)}</div></div><span class="tp-big-n">${SENT[i]}<small>sent</small></span></div>`).join('')}</div></div>${tabs('scores')}`)]] },

      { title: 'Need help? Tap the ? button', sub: 'The ? at the top opens a quick guide. Swipe or tap Next to go through it. Aa makes the text bigger. If a red "Location is off" bar shows up, tap "Fix it."', dur: 9500,
        screen: photosTab(0, first, 2),
        steps: [[1200, () => tap('#tpHelp')], [1550, () => scr()?.insertAdjacentHTML('beforeend', `<div class="tp-sheet"><div>${guideCard(0)}</div></div>`)],
          [2800, () => tap('#tpNext')], [3150, () => { const c = scr()?.querySelector('.tp-sheet > div'); if (c) c.innerHTML = guideCard(1); }],
          [4200, () => tap('#tpGotIt')], [4550, () => scr()?.querySelector('.tp-sheet')?.remove()], [5300, () => tap('#tpAa')], [5650, () => scr()?.classList.add('bigtext')],
          [7000, () => { scr()?.classList.remove('bigtext'); scr()?.querySelector('.tp-head')?.insertAdjacentHTML('beforeend', '<div class="tp-locbar"><span>📍 <b>Location is off.</b></span><span class="fix" id="tpFix">Fix it</span></div>'); }], [8300, () => tap('#tpFix')]] },

      { title: 'Come back when time is up', sub: 'Head back to home base. The winners are revealed right here on the TV, photo by photo!', dur: 9000,
        screen: `<div class="tp-over tp-center"><div class="tp-turkey">🏁</div><div class="tp-h big">Game over!</div><p>See the results on the main screen.</p></div>`,
        side: `<div class="tut-win"><div class="tut-trophy">🏆</div>${teams.slice(0, 4).map((t, i) => `<div class="tut-wteam" style="background:${esc(t.color)};animation-delay:${1 + i * .5}s">${esc(t.name)}</div>`).join('')}<p>And the winner is…</p></div>`,
        steps: [[3500, () => { Sound.fanfare(); confetti(); }]] },
    ];

    $('#tutDots').innerHTML = scenes.map(() => '<i></i>').join('');
    // tv#tut=6 starts at step 6 (handy for checking one step).
    const from = Math.max(0, (+new URLSearchParams(location.hash.slice(1)).get('tut') || 1) - 1);
    for (let i = from; i < scenes.length; i++) {
      if (!alive()) return;
      const sc = scenes[i];
      $('#tutStep').textContent = `Step ${i + 1} of ${scenes.length}`;
      $('#tutTitle').textContent = sc.title; $('#tutSub').textContent = sc.sub;
      el.querySelector('.tut-text').classList.remove('in'); void el.offsetWidth; el.querySelector('.tut-text').classList.add('in');
      $('#tutSide').innerHTML = sc.side || '';
      show(sc.screen);
      el.querySelectorAll('#tutDots i').forEach((dot, j) => { dot.className = j < i ? 'done' : j === i ? 'on' : ''; dot.style.setProperty('--dur', sc.dur + 'ms'); });
      if (i) Sound.whoosh();
      (sc.steps || []).forEach(([ms, fn]) => later(ms, fn));
      await wait(sc.dur);
    }
    if (!alive()) return;
    el.querySelector('.tut-stage').innerHTML = `<div class="tut-end"><div style="font-size:5em">🦃</div><h1>Happy hunting!</h1><p>Scan the code to join.</p></div>`;
    $('#tutDots').innerHTML = '';
    Sound.crash();
    await wait(4000);
    if (alive()) stopTutorial();
  }
  function stopTutorial(instant) {
    T.tutRun = null;
    const e = $('#tut'); if (!e) return;
    if (instant) { e.remove(); return; }
    e.classList.add('out'); setTimeout(() => e.remove(), 500);
  }

  // ---------- final reveal: count up every photo, Easy → Medium → Hard, then the winner ----------
  async function showReveal() {
    stopTutorial(true);
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
    const run = (T.revealRun = { fast: false, speed: opt('speed') });
    const o = document.createElement('div');
    o.className = 'reveal'; o.id = 'reveal';
    o.innerHTML = `<div class="rv-stage"><div class="rv-title" id="rvTitle"></div><div class="rv-sub" id="rvSub"></div><div class="rv-round" id="rvRound"></div></div>
      <div class="rv-lanes" id="rvLanes">${teams.map((t) => `
        <div class="lane" data-team="${esc(t.id)}" style="--c:${esc(t.color)}">
          <div class="ln-name">${esc(t.name)}<small>${esc(t.members.join(', '))}</small></div>
          <div class="ln-track"><div class="ln-fill"></div></div>
          <div class="ln-score">0</div>
        </div>`).join('')}</div>`;
    document.body.appendChild(o);
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

    const teamOf = (id) => teams.find((t) => t.id === id);
    const proof = (f) => f && f.proof_key ? `/img/${f.proof_key}` : null;
    const dist = (m) => (m < 15 ? 'Right there!' : m < 1609 ? `${Math.round((m * 3.28) / 10) * 10} ft away` : `${(m / 1609).toFixed(1)} mi away`);
    // "So close": a wrong answer within a few circles of the spot.
    const soClose = (f, p) => f && !yes(f) && f.distance_m != null && f.distance_m <= Math.max((p.radius_m || 25) * 4, 60);

    // Step 4 of each photo: every team's picture, closest first; distances revealed from farthest to closest.
    async function howClose(p, level) {
      const rows = teams.map((t) => ({ t, f: answer(t, p) })).filter((r) => r.f && r.f.distance_m != null).sort((a, b) => a.f.distance_m - b.f.distance_m);
      if (!rows.length) return;
      $('#rvSub').textContent = 'How close did everyone get?';
      $('#rvRound').innerHTML = `<div class="rnd close">
        <figure class="rnd-target"><div class="rnd-frame"><img class="rnd-photo" src="${esc(p.image)}" alt=""></div><figcaption><b>#${numOf(p.id)}</b>${p.title ? ' · ' + esc(p.title) : ''} · the real spot</figcaption></figure>
        <div class="rnd-answers" style="--n:${rows.length}">${rows.map(({ t, f }, k) => `
          <div class="ans ${yes(f) ? 'yes' : 'no'}" data-t="${esc(t.id)}" style="--c:${esc(t.color)};animation-delay:${k * 0.15}s">
            <div class="ans-h">${esc(t.name)}</div>
            <div class="ans-pic">${proof(f) ? `<img src="${esc(proof(f))}" alt="">` : '<div class="ans-nopic">No picture</div>'}<div class="ans-badge">${yes(f) ? '✓' : '✕'}</div></div>
            <div class="ans-dist">?</div>
          </div>`).join('')}</div></div>`;
      Sound.chime();
      await pause(2600);
      for (const { t, f } of [...rows].reverse()) {
        if (!live() || run.fast) return;
        const card = o.querySelector(`.rnd.close .ans[data-t="${CSS.escape(t.id)}"]`);
        card.querySelector('.ans-dist').textContent = dist(f.distance_m).replace('Right there!', 'Right there').replace(' away', '');
        card.classList.add('shown');
        if (soClose(f, p)) { card.insertAdjacentHTML('beforeend', '<div class="ans-tag so">So close! 😩</div>'); Sound.buzz(); await pause(2000); }
        else { Sound.tap(); await pause(1300); }
      }
      const best = rows[0], card = o.querySelector(`.rnd.close .ans[data-t="${CSS.escape(best.t.id)}"]`);
      card.classList.add('closest');
      card.insertAdjacentHTML('beforeend', '<div class="ans-tag best">🎯 Closest</div>');
      Sound.ding(level);
      await pause(3600);
    }

    // After the last photo, before the winner: miles walked, then a few fun stats, one card at a time.
    async function byTheNumbers() {
      title('By the numbers', 'Before we crown a winner…');
      $('#rvRound').innerHTML = '';
      Sound.swell(2.6);
      await pause(3200);
      const walk = d.walk;
      if (walk && walk.teams && teams.some((t) => walk.teams[t.id]?.miles > 0)) {
        if (!live() || run.fast) return;
        const order = [...teams].sort((a, b) => (walk.teams[a.id]?.miles || 0) - (walk.teams[b.id]?.miles || 0));
        const most = Math.max(0.01, ...teams.map((t) => walk.teams[t.id]?.miles || 0));
        title('🥾 Miles walked', 'How far did each team go?');
        $('#rvRound').innerHTML = `<div class="walk">${order.map((t) => `<div class="walk-row" data-t="${esc(t.id)}" style="--c:${esc(t.color)}"><div class="walk-name">${esc(t.name)}</div><div class="walk-track"><div class="walk-fill"></div></div><div class="walk-mi">–</div></div>`).join('')}
          <div class="walk-foot" id="walkFoot"></div></div>`;
        await pause(1800);
        for (const t of order) {
          if (!live() || run.fast) return;
          const mi = walk.teams[t.id]?.miles || 0, row = o.querySelector(`.walk-row[data-t="${CSS.escape(t.id)}"]`);
          row.classList.add('on');
          row.querySelector('.walk-fill').style.width = (100 * mi) / most + '%';
          countUp(row.querySelector('.walk-mi'), mi, 1400 / run.speed, (v) => `${v.toFixed(2)} mi`);
          Sound.tap();
          await pause(2000);
        }
        const foot = [];
        if (walk.top) foot.push(`Farthest walker: <b>${esc(walk.top.name)}</b> (${esc(teamOf(walk.top.team_id)?.name || '')}) · ${walk.top.miles.toFixed(2)} mi`);
        if (walk.total_miles) foot.push(`All together: <b>${walk.total_miles.toFixed(1)} miles</b>`);
        $('#walkFoot').innerHTML = foot.join('<br>');
        Sound.ding(2);
        await pause(4500);
      }
      // Fun stats from the answers.
      const sent = d.finds.filter((f) => f.player_id), right = d.finds.filter(yes);
      const withD = (arr) => arr.filter((f) => f.distance_m != null && d.photos.some((p) => p.id === f.photo_id));
      const closest = withD(right).sort((a, b) => a.distance_m - b.distance_m)[0];
      const miss = withD(d.finds.filter((f) => !yes(f) && f.player_id)).sort((a, b) => a.distance_m - b.distance_m)[0];
      const first = [...sent].sort((a, b) => a.created_at - b.created_at)[0];
      const byPerson = {}; sent.forEach((f) => { const k = f.player_name || ''; if (k) byPerson[k] = (byPerson[k] || 0) + 1; });
      const topP = Object.entries(byPerson).sort((a, b) => b[1] - a[1])[0];
      const ph = (f) => d.photos.find((p) => p.id === f.photo_id);
      const tname = (f) => esc(teamOf(f.team_id)?.name || '');
      const cards = [];
      cards.push({ icon: '📸', big: `${sent.length}`, cap: `photos sent · <b>${right.length}</b> counted` });
      if (closest) cards.push({ icon: '🎯', big: dist(closest.distance_m), cap: `Closest shot: <b>${tname(closest)}</b> at #${numOf(closest.photo_id)}${ph(closest)?.title ? ' · ' + esc(ph(closest).title) : ''}`, img: proof(closest), c: teamOf(closest.team_id)?.color });
      if (miss) cards.push({ icon: '😩', big: dist(miss.distance_m).replace(' away', ''), cap: `So close! <b>${tname(miss)}</b> missed #${numOf(miss.photo_id)}${ph(miss)?.title ? ' · ' + esc(ph(miss).title) : ''} by this much`, img: proof(miss), c: teamOf(miss.team_id)?.color });
      if (first && d.game.started_at) cards.push({ icon: '⚡', big: `${Math.max(1, Math.round((first.created_at - d.game.started_at) / 60000))} min`, cap: `First photo of the game: <b>${esc(first.player_name || '')}</b> (${tname(first)})`, img: proof(first), c: teamOf(first.team_id)?.color });
      if (topP && topP[1] > 1) cards.push({ icon: '🏅', big: `${topP[1]}`, cap: `Most photos by one person: <b>${esc(topP[0])}</b>` });
      for (const c of cards) {
        if (!live() || run.fast) return;
        title('By the numbers', '');
        $('#rvRound').innerHTML = `<div class="rv-stat ${c.img ? 'has-img' : ''}">${c.img ? `<img class="rv-stat-img" src="${esc(c.img)}" alt="" style="border-color:${esc(c.c || '#fff')}">` : ''}<div><div class="rv-stat-icon">${c.icon}</div><div class="rv-stat-big">${c.big}</div><div class="rv-stat-cap">${c.cap}</div></div></div>`;
        Sound.ding(1);
        await pause(5000);
      }
    }
    function countUp(el, to, ms, fmt) {
      const t0 = performance.now();
      (function step(now) { const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1 && el.isConnected) requestAnimationFrame(step); })(t0);
    }

    // During the photo rounds the scoreboard is compact (room for 5+ teams); full size again for the finish.
    o.classList.toggle('many', teams.length >= 5);
    o.classList.add('rounds');
    title('The results are in!', 'Let\'s go through every photo…');
    Sound.swell(3.4);
    await pause(3600);
    for (const level of [1, 2, 3]) {
      if (!live()) return;
      if (run.fast) break;
      const photos = d.photos.filter((p) => p.difficulty === level && teams.some((t) => answer(t, p)));
      const pts = d.photos.find((p) => p.difficulty === level)?.points ?? level;
      $('#rvRound').innerHTML = '';
      title(`${DIFF[level]} photos`, `${pts} point${pts === 1 ? '' : 's'} each · ${photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} to check` : 'nobody tried one!'}`);
      Sound.whoosh();
      await pause(2800);
      for (const [i, p] of photos.entries()) {
        if (!live()) return;
        if (run.fast) break;
        // 1. The photo, and every team's answer next to it.
        $('#rvTitle').textContent = `${DIFF[level]} photos`;
        $('#rvSub').textContent = `Photo ${i + 1} of ${photos.length}`;
        $('#rvRound').innerHTML = `<div class="rnd">
          <figure class="rnd-target" id="rndTarget"><div class="rnd-frame"><img class="rnd-photo" src="${esc(p.image)}" alt=""><div class="rnd-map" id="rndMap"></div></div><figcaption><b>#${numOf(p.id)}</b>${p.title ? ' · ' + esc(p.title) : ''} · ${p.points} pt${p.points === 1 ? '' : 's'}</figcaption></figure>
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
        // Build the map now (hidden) so its tiles load while the answers are stamped.
        Sound.chime();
        await pause(3000);
        // 2. Stamp each answer: green check or red X, then add the points.
        for (const t of teams) {
          const f = answer(t, p); if (!f) continue;
          if (!live()) return;
          const card = o.querySelector(`.ans[data-t="${CSS.escape(t.id)}"]`);
          const ok = yes(f);
          card.classList.add(ok ? 'yes' : 'no');
          card.querySelector('.ans-stamp').innerHTML = ok ? `<span>✓</span><b>+${p.points}</b>` : '<span>✕</span>';
          if (ok) { Sound.ding(level); setScore(t.id, score[t.id] + p.points); } else Sound.buzz();
          await pause(1000);
        }
        await pause(1200);
        // 3. Where it really was: the map fades in over the photo, then each team's spot drops in.
        let where = null;
        if (p.lat != null && p.lng != null && live() && !run.fast) {
          $('#rvSub').textContent = 'Here\'s where it was';
          // The answers make way (their points are on the scoreboard) and the photo grows to fill the stage...
          const rnd = o.querySelector('.rnd'), pic = o.querySelector('.rnd-photo');
          rnd.classList.add('fade');
          await pause(400);
          glide(pic, () => rnd.classList.add('wide'), 900 / run.speed);
          // Build the map now, at its full size, hidden under the big photo so its tiles load meanwhile.
          // Never let a map problem stop the show: without it, the photo just stays up big.
          try { where = spotMap(p, teams, answer); } catch { $('#rndMap')?.remove(); }
          Sound.whoosh();
          await pause(2200);
          if (!live()) return;
          // ...then shrinks into the corner, showing the map close in on the real spot underneath...
          if (where) glide(pic, () => $('#rndTarget').classList.add('map'), 1300 / run.speed);
          await pause(1500);
          // ...then the map zooms out until every team's spot fits.
          if (where && live() && !run.fast) where.zoomOut(1.8 / run.speed);
          if (where) await pause(2100);
          for (const drop of where ? where.drops : []) {
            if (!live() || run.fast) break;
            drop(); Sound.tap();
            await pause(900);
          }
          await pause(2800);
        } else await pause(800);
        try { where?.map.remove(); } catch { /* already gone */ }
        // 4. How close was everyone? Each team's own picture, closest first, distances from farthest to closest.
        if (live() && !run.fast) await howClose(p, level);
      }
    }
    if (!live()) return;
    // Make sure the bars end on the official scores (also after "Skip").
    teams.forEach((t) => setScore(t.id, t.score));
    // By the numbers: miles walked, then a few fun stats, before the final reveal.
    if (!run.fast) await byTheNumbers();
    if (!live()) return;
    $('#rvRound').innerHTML = '';
    o.classList.remove('rounds');
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
    await wait(run.fast ? 900 : 2600);
    if (!live()) return;
    // Places from last up to second, one at a time; the winner's lane stays a mystery.
    const PLACE = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
    if (!run.fast && ranked.length > 1) {
      o.classList.add('countdown');
      for (let i = ranked.length - 1; i >= 1; i--) {
        if (!live()) return;
        const t = ranked[i], gap = ranked[0].score - t.score;
        title(`In ${PLACE[i] || (i + 1) + 'th'} place…`, '');
        Sound.whoosh();
        await pause(i === 1 ? 2600 : 1800);
        if (!live()) return;
        lane(t.id).classList.add('placed');
        lane(t.id).querySelector('.ln-name').insertAdjacentHTML('afterbegin', `<span class="ln-rank">${i + 1}</span>`);
        $('#rvSub').innerHTML = `<b style="color:${esc(t.color)}">${esc(t.name)}</b> · ${t.score} point${t.score === 1 ? '' : 's'}${i === 1 && gap <= 2 ? (gap === 0 ? ' · tied on points, but the winner got there first!' : ` · so close! Just ${gap} point${gap === 1 ? '' : 's'} behind`) : ''}`;
        if (i === 1) Sound.buzz(); else Sound.ding(1);
        await pause(i === 1 ? 4200 : 2800);
      }
    }
    lane(ranked[0].id).querySelector('.ln-name').insertAdjacentHTML('afterbegin', '<span class="ln-rank">1</span>');
    ranked.slice(1).forEach((t, k) => { const n = lane(t.id).querySelector('.ln-name'); if (!n.querySelector('.ln-rank')) n.insertAdjacentHTML('afterbegin', `<span class="ln-rank">${k + 2}</span>`); });
    if (!live()) return;
    title('And the winner is…');
    $('#rvRound').innerHTML = '<div class="rv-win"><div class="rv-trophy wait">🥁</div></div>';
    Sound.swell(5.0);
    await wait(run.fast ? 2000 : 5200);
    if (!live()) return;
    const w = ranked[0], tie = ranked[1] && ranked[1].score === w.score;
    title(`${w.name} team wins!`, `${w.score} points${tie ? ' · tied, but they got there first' : ''} · ${w.members.join(', ')}`);
    $('#rvTitle').style.color = w.color;
    o.classList.remove('countdown');
    lane(w.id).classList.add('winner');
    $('#rvRound').innerHTML = `<div class="rv-win"><div class="rv-trophy">🏆</div><div class="rv-wname" style="color:${esc(w.color)}">${esc(w.name)}</div><div class="rv-wpts">${w.score} points · ${w.found} photo${w.found === 1 ? '' : 's'} right</div></div>`;
    $('#rvSkip')?.remove();
    Sound.crash(); Sound.fanfare();
    confetti();
  }
  // Just the miles walked, on its own (admin TV card → "Show miles walked"). Stays up until "Back to the map".
  function showMiles() {
    const d = T.d, walk = d.walk;
    stopTutorial(true);
    $('#milesShow')?.remove();
    const o = document.createElement('div');
    o.className = 'reveal miles-only'; o.id = 'milesShow';
    const teams = [...d.teams].sort((a, b) => (walk?.teams?.[a.id]?.miles || 0) - (walk?.teams?.[b.id]?.miles || 0));
    const most = Math.max(0.01, ...teams.map((t) => walk?.teams?.[t.id]?.miles || 0));
    const has = walk && teams.some((t) => walk.teams?.[t.id]?.miles > 0);
    o.innerHTML = `<div class="rv-stage"><div class="rv-title in">🥾 Miles walked</div><div class="rv-sub">${has ? 'How far did each team go?' : 'No walking trails recorded yet.'}</div>
      <div class="rv-round">${has ? `<div class="walk">${teams.map((t) => `<div class="walk-row" data-t="${esc(t.id)}" style="--c:${esc(t.color)}"><div class="walk-name">${esc(t.name)}</div><div class="walk-track"><div class="walk-fill"></div></div><div class="walk-mi">–</div></div>`).join('')}
      <div class="walk-foot" id="walkFoot"></div></div>` : ''}</div></div>`;
    document.body.appendChild(o);
    if (!has) return;
    Sound.whoosh();
    teams.forEach((t, i) => setTimeout(() => {
      if (!o.isConnected) return;
      const mi = walk.teams[t.id]?.miles || 0, row = o.querySelector(`.walk-row[data-t="${CSS.escape(t.id)}"]`);
      row.classList.add('on');
      row.querySelector('.walk-fill').style.width = (100 * mi) / most + '%';
      const el = row.querySelector('.walk-mi'), t0 = performance.now();
      (function step(now) { const k = Math.min(1, (now - t0) / 1400); el.textContent = `${(mi * (1 - Math.pow(1 - k, 3))).toFixed(2)} mi`; if (k < 1 && el.isConnected) requestAnimationFrame(step); })(t0);
      Sound.tap();
    }, 1200 + i * 1800));
    setTimeout(() => {
      if (!o.isConnected) return;
      const foot = [];
      if (walk.top) foot.push(`Farthest walker: <b>${esc(walk.top.name)}</b> (${esc(d.teams.find((t) => t.id === walk.top.team_id)?.name || '')}) · ${walk.top.miles.toFixed(2)} mi`);
      if (walk.total_miles) foot.push(`All together: <b>${walk.total_miles.toFixed(1)} miles</b>`);
      $('#walkFoot').innerHTML = foot.join('<br>');
      Sound.ding(2);
    }, 1200 + teams.length * 1800 + 600);
  }
  // Move an element smoothly to wherever a class change puts it (measure, change, animate back from the old spot).
  function glide(el, change, ms) {
    const a = el.getBoundingClientRect();
    change();
    const b = el.getBoundingClientRect();
    if (!b.width) return;
    el.animate([{ transformOrigin: 'top left', transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})` },
      { transformOrigin: 'top left', transform: 'none' }], { duration: ms, easing: 'cubic-bezier(.4, 0, .2, 1)' });
  }
  // The "here's where it was" map for one photo in the results show: the real spot with its circle,
  // and a dot for each team where they took their picture (added one at a time with drops()).
  // Built hidden, so the tiles load while the answers are stamped. Null if the photo has no location.
  function spotMap(p, teams, answer) {
    const el = $('#rndMap');
    if (!el || p.lat == null || p.lng == null) return null;
    const map = L.map(el, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.25 });
    addBaseMap(map);
    const spot = [p.lat, p.lng];
    L.circle(spot, { radius: p.radius_m || 25, color: '#fff', weight: 3, dashArray: '6 6', fillColor: '#00933c', fillOpacity: 0.3 }).addTo(map);
    L.marker(spot, { icon: L.divIcon({ className: 'rv-pin', html: '<span>📍</span>', iconSize: [40, 40], iconAnchor: [20, 38] }), zIndexOffset: 1000 }).addTo(map);
    const pts = [spot];
    const drops = [];
    const SIDES = ['top', 'right', 'bottom', 'left'], OFF = { top: [0, -14], bottom: [0, 14], left: [-14, 0], right: [14, 0] };
    let near = 0;
    // Try the preferred side first, then the others; keep the one that bumps into the least
    // (other labels, the pin, the photo in the corner, or the map's edge).
    const placed = [];
    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    // Where a label can go: each side right next to the dot, then nudged further along that side.
    const SPOTS = (pref) => [pref, ...SIDES.filter((x) => x !== pref)].flatMap((sd) => sd === 'top' || sd === 'bottom'
      ? [[sd, OFF[sd]], [sd, [0, OFF[sd][1] * 3.4]], [sd, [-90, OFF[sd][1]]], [sd, [90, OFF[sd][1]]]]
      : [[sd, OFF[sd]], [sd, [OFF[sd][0], -36]], [sd, [OFF[sd][0], 36]]]);
    function placeLabel(dot, text, pref) {
      const box = el.getBoundingClientRect(), pin = el.querySelector('.rv-pin')?.getBoundingClientRect(), photo = el.parentElement.querySelector('.rnd-photo')?.getBoundingClientRect();
      const avoid = [...placed, ...(pin ? [pin] : []), ...(photo ? [photo] : [])];
      const put = ([sd, off]) => {
        dot.unbindTooltip();
        dot.bindTooltip(text, { permanent: true, direction: sd, offset: off, className: 'rv-tip' }).openTooltip();
        return dot.getTooltip().getElement().getBoundingClientRect();
      };
      let best = null;
      for (const [i, c] of SPOTS(pref).entries()) {
        const r = put(c);
        const outside = r.width * r.height - area(r, box);
        const cost = outside * 3 + avoid.reduce((sum, q) => sum + area(r, q), 0) + i; // + i: prefer earlier spots on a tie
        if (!best || cost < best.cost) best = { c, cost, r };
        if (cost - i === 0) break;
      }
      best.r = put(best.c);
      placed.push(best.r);
    }
    teams.forEach((t) => {
      const f = answer(t, p);
      if (!f || f.lat == null || f.lng == null) return;
      const at = [f.lat, f.lng];
      pts.push(at);
      // Put the label on the side of the dot away from the spot, so labels near the pin don't pile up.
      // Dots right on the spot take turns going up, right, down, left.
      const dy = f.lat - p.lat, dx = (f.lng - p.lng) * Math.cos(p.lat * Math.PI / 180);
      const side = Math.hypot(dx, dy) < 0.00008 ? SIDES[near++ % 4] : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'top' : 'bottom');
      drops.push(() => {
        L.polyline([at, spot], { color: t.color, weight: 4, dashArray: '2 9', opacity: 0.95 }).addTo(map);
        const dot = L.circleMarker(at, { radius: 12, color: '#fff', weight: 3, fillColor: t.color, fillOpacity: 1, className: 'rv-dot' }).addTo(map);
        placeLabel(dot, `${esc(t.name)} · ${f.distance_m != null ? feet(f.distance_m) : ''}`, side);
      });
    });
    // Start close in on the spot (what the photo shows), then zoom out to fit everyone.
    const close = () => map.setView(spot, 19, { animate: false });
    const zoomOut = (secs) => {
      if (pts.length < 2) return map.flyTo(spot, 18, { duration: secs });
      // Room for labels on every side, and keep dots out from under the photo in the bottom-right corner.
      const sz = map.getSize();
      map.flyToBounds(pts, { paddingTopLeft: [300, 80], paddingBottomRight: [Math.max(300, sz.x * 0.25), Math.max(80, sz.y * 0.32)], maxZoom: 18, duration: secs });
    };
    close();
    return { map, close, zoomOut, drops };
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
    if (k === 'escape') runCmd('close');
  });

  wake();
  boot();
})();
