// TV view for home base: live map, every submission and judge's call, scores, and the final reveal.
// Uses the admin password (shared with /admin on this browser).
(() => {
  const POLL_MS = 4000;
  const SPOT_MS = 8000;      // how long a new submission stays on screen
  const JUDGE_MS = 4500;
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

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = {
    pw: localStorage.getItem('adminPw'), d: null, offset: 0, gameId: null,
    pings: {}, lastPing: 0, seen: null, queue: [], showing: false,
    // "No spoilers" hides points and yes/no until the reveal, if players might glance at the TV.
    noSpoilers: localStorage.getItem('tvNoSpoilers') === '1',
    revealShownFor: null, map: null, L: null, markers: {}, trails: {}, sig: {},
  };

  async function api(path) {
    const res = await fetch('/api/admin' + path, { headers: { 'x-admin': T.pw || '' } });
    if (res.status === 401) { localStorage.removeItem('adminPw'); T.pw = null; login('Wrong password.'); throw Object.assign(new Error('auth'), { auth: true }); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function login(err) {
    clearInterval(T.timer); T.timer = null;
    document.body.classList.remove('idle');
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
          <span class="pill" id="pill">…</span>
          <span class="tv-title" id="title">🦃 Photo Hunt</span>
          <span class="tv-sub" id="sub"></span>
          <span class="tv-clock" id="clock"></span>
          <button class="tv-btn" id="spoilBtn" title="Hide points and yes/no until the reveal (key: H)"></button>
          <button class="tv-btn" id="fsBtn" title="Full screen (key: F)">⛶ Full screen</button>
        </header>
        <div class="tv-main">
          <div class="tv-map-wrap"><div id="tvMap"></div><div id="over"></div><div id="spot"></div></div>
          <aside class="tv-side">
            <div class="tv-h"><span id="boardTitle">Scoreboard</span><span id="boardNote"></span></div>
            <div id="board"></div>
            <div class="tv-h" style="margin-top:.4em"><span>Live feed</span><span id="feedCount"></span></div>
            <div class="tv-feed" id="feed"></div>
          </aside>
        </div>
        <footer class="tv-ticker"><span class="lbl">LATEST</span><div class="track"><div class="run" id="ticker"></div></div></footer>
      </div>`;
    T.map = L.map('tvMap', { zoomControl: false, zoomSnap: 0.25, attributionControl: true }).setView([40.728, -74.005], 15);
    addBaseMap(T.map);
    T.L = { area: L.layerGroup().addTo(T.map), subs: L.layerGroup().addTo(T.map), trails: L.layerGroup().addTo(T.map), players: L.layerGroup().addTo(T.map), fx: L.layerGroup().addTo(T.map) };
    T.markers = {}; T.trails = {}; T.sig = {}; T.fitted = false;
    $('#fsBtn').onclick = fullscreen;
    $('#spoilBtn').onclick = toggleSpoilers;
    renderSpoilBtn();
    tick();
    clearInterval(T.timer); T.timer = setInterval(tick, POLL_MS);
    if (!T.clockTimer) T.clockTimer = setInterval(renderClock, 1000);
  }
  window.addEventListener('resize', () => { if (T.map) { T.map.invalidateSize(); fit(); } });

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  function toggleSpoilers() {
    T.noSpoilers = !T.noSpoilers;
    localStorage.setItem('tvNoSpoilers', T.noSpoilers ? '1' : '0');
    renderSpoilBtn(); T.sig = {}; if (T.d) render();
  }
  function renderSpoilBtn() { const b = $('#spoilBtn'); if (b) b.textContent = T.noSpoilers ? '🙈 No spoilers: on' : '👀 No spoilers: off'; }
  const hide = () => T.noSpoilers && !T.d?.game?.revealed;

  // ---------- data ----------
  async function tick() {
    if (T.busy || !T.pw || document.hidden) return;
    T.busy = true;
    try {
      let d = await api('/tv?since=' + T.lastPing);
      if (d.game && d.game.id !== T.gameId) {
        // A fresh game: start the trails and the feed over.
        const hadOld = T.gameId !== null && T.lastPing > 0;
        T.gameId = d.game.id; T.pings = {}; T.lastPing = 0; T.seen = null; T.queue = []; T.revealShownFor = null;
        T.L.subs.clearLayers(); T.L.trails.clearLayers(); T.L.players.clearLayers(); T.markers = {}; T.trails = {}; T.sig = {}; T.fitted = false;
        if (hadOld) d = await api('/tv?since=0');
      }
      T.offset = d.now - Date.now();
      for (const p of d.pings || []) {
        (T.pings[p.player_id] ||= []).push([p.lat, p.lng]);
        if (p.at > T.lastPing) T.lastPing = p.at;
      }
      T.d = d;
      T.down = false;
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
  const timeText = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dot = (c) => `<span class="dot" style="background:${esc(c)}"></span>`;
  function verdict(status) {
    if (hide()) return ['', ''];
    return {
      auto: ['yes', '✓ On the spot'], approved: ['yes', '✓ Judge says yes'], pending: ['wait', '⚖ Judge reviewing'],
      far: ['no', '✕ Too far'], rejected: ['no', '✕ Judge says no'],
    }[status] || ['', ''];
  }
  // Every submission is one event, and every judge's call is another.
  function events() {
    const ev = [];
    for (const f of T.d.finds) {
      ev.push({ key: 'sub:' + f.id, kind: 'sub', at: f.created_at, f });
      if (f.judged_at && !hide()) ev.push({ key: `judge:${f.id}:${f.status}`, kind: 'judge', at: f.judged_at, f });
    }
    return ev.sort((a, b) => b.at - a.at);
  }
  const changed = (key, val) => { if (T.sig[key] === val) return false; T.sig[key] = val; return true; };

  // ---------- render ----------
  function render() {
    const d = T.d;
    if (!d.game) { $('#over').innerHTML = '<div class="map-over"><div><h1>No game yet</h1><p>Create one on the admin page.</p></div></div>'; return; }
    $('#title').textContent = '🦃 ' + d.game.name;
    const out = d.players.filter((p) => p.last_seen_at && d.now - p.last_seen_at < STALE_MS).length;
    $('#sub').textContent = `${d.players.length} players · ${out} out hunting · ${d.photos.length} photos`;
    renderClock();
    if (changed('area', JSON.stringify(d.game.boundary))) drawArea();
    renderBoard(); renderFeed(); renderTicker(); renderPlayers(); renderSubs(); renderOverlay();
    queueNew();
    if (d.game.revealed && T.revealShownFor !== d.game.id + ':' + d.game.revealed) { T.revealShownFor = d.game.id + ':' + d.game.revealed; showReveal(); }
    if (!d.game.revealed) { $('#reveal')?.remove(); T.revealShownFor = null; }
  }

  function clockState() {
    const g = T.d?.game;
    if (!g) return ['', '', ''];
    if (g.status === 'setup') return ['Starts soon', 'STARTING SOON', ''];
    if (g.status === 'ended') return [g.revealed ? 'Final' : 'Time!', g.revealed ? 'FINAL' : 'GAME OVER', 'final'];
    if (!g.ends_at) return [`${Math.floor((Date.now() + T.offset - g.started_at) / 60000)} min in`, 'LIVE', 'live'];
    const left = Math.max(0, g.ends_at - (Date.now() + T.offset));
    if (!left) return ['Time!', 'GAME OVER', 'final'];
    const m = Math.floor(left / 60000), h = Math.floor(m / 60), s = Math.floor(left / 1000) % 60;
    return [(h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`) + ' left', 'LIVE', 'live'];
  }
  function renderClock() {
    if (!T.d) return;
    const [c, p, cls] = clockState();
    $('#clock').textContent = T.down ? 'Reconnecting…' : c;
    const pill = $('#pill'); pill.textContent = p; pill.className = 'pill ' + cls;
  }

  function renderBoard() {
    const d = T.d, h = hide();
    const teams = h ? [...d.teams].sort((a, b) => b.submitted - a.submitted) : d.teams;
    $('#boardTitle').textContent = h ? 'Photos sent' : d.game.revealed ? 'Final scores' : 'Scoreboard';
    $('#boardNote').textContent = h ? 'points at the reveal' : '';
    const html = teams.map((t, i) => `
      <div class="board-row" data-team="${esc(t.id)}">
        <span class="rk">${h ? '' : i + 1}</span>
        <span class="bar" style="background:${esc(t.color)}"></span>
        <div>
          <div class="nm">${esc(t.name)}</div>
          <div class="who">${t.roster.length ? t.roster.map((p) => `${esc(p.name)} <b>${p.submitted}</b>`).join(' · ') : 'No players yet'}</div>
          ${h ? '' : `<div class="diffs">${[1, 2, 3].map((x) => `<span><span class="bullet d${x}">${'EMH'[x - 1]}</span>${t.by_diff[x - 1]}</span>`).join('')}<span>${t.found} of ${t.submitted} counted</span></div>`}
        </div>
        <div class="big">${h ? t.submitted : t.score}<small>${h ? 'sent' : 'points'}</small></div>
      </div>`).join('');
    if (changed('board', html)) {
      const before = Object.fromEntries([...document.querySelectorAll('.board-row')].map((r) => [r.dataset.team, r.querySelector('.big').textContent]));
      $('#board').innerHTML = html;
      // Flash a team's row when its number changes.
      document.querySelectorAll('.board-row').forEach((r) => {
        if (before[r.dataset.team] !== undefined && before[r.dataset.team] !== r.querySelector('.big').textContent) {
          r.classList.add('flash'); setTimeout(() => r.classList.remove('flash'), 1500);
        }
      });
    }
  }

  function feedItem(e, fresh) {
    const f = e.f, t = teamOf(f.team_id), p = photoOf(f.photo_id), pl = playerOf(f.player_id);
    const who = esc(pl?.name || f.player_name || 'Judge');
    if (e.kind === 'judge') {
      const [cls, txt] = verdict(f.status);
      return `<div class="fi ${fresh ? 'new' : ''}"><span class="ph">⚖</span><div class="txt">
        <div class="l1">Judge's call on ${dot(t.color)}<b>${esc(t.name)}</b> #${numOf(f.photo_id)}</div>
        <div class="l2">${cls ? `<span class="vt ${cls}">${txt}</span>` : '<span>Decided</span>'}<span>${timeText(e.at)}</span></div></div></div>`;
    }
    const [cls, txt] = verdict(f.status);
    const img = f.proof_key ? `/img/${f.proof_key}` : p?.thumb;
    return `<div class="fi ${fresh ? 'new' : ''}"><img src="${esc(img)}" alt="" loading="lazy"><div class="txt">
      <div class="l1">${dot(t.color)}<b>${who}</b> sent #${numOf(f.photo_id)} <span style="color:#999">${p ? DIFF[p.difficulty] : ''}</span></div>
      <div class="l2">${cls ? `<span class="vt ${cls}">${txt}</span>` : ''}<span>${esc(t.name)} · ${timeText(e.at)}</span></div></div></div>`;
  }

  function renderFeed() {
    const ev = events();
    $('#feedCount').textContent = `${T.d.finds.length} submitted`;
    if (!changed('feed', ev.map((e) => e.key).join() + hide())) return;
    const prev = T.feedKeys || new Set();
    T.feedKeys = new Set(ev.map((e) => e.key));
    $('#feed').innerHTML = ev.length ? ev.slice(0, 30).map((e) => feedItem(e, prev.size && !prev.has(e.key))).join('')
      : '<div class="tv-empty">Waiting for the first photo…</div>';
  }

  function renderTicker() {
    const d = T.d, ev = events().slice(0, 12);
    const items = [];
    if (!hide() && d.teams.length && d.teams[0].score > 0) items.push(`${d.game.revealed ? '🏆' : '📈'} ${d.teams.map((t) => `${esc(t.name)} ${t.score}`).join(' · ')}`);
    for (const e of ev) {
      const f = e.f, t = teamOf(f.team_id), pl = playerOf(f.player_id), [, txt] = verdict(f.status);
      items.push(e.kind === 'judge'
        ? `⚖ Judge's call on ${esc(t.name)}'s #${numOf(f.photo_id)}${txt ? ': ' + txt : ''}`
        : `${dot(t.color)}${esc(pl?.name || 'Someone')} (${esc(t.name)}) sent #${numOf(f.photo_id)}${txt ? ' · ' + txt : ''}`);
    }
    if (!ev.length) items.push(d.game.status === 'setup' ? 'Scan the code to join the hunt!' : 'The hunt is on! Waiting for the first photo…');
    const html = items.map((x) => `<span>${x}</span>`).join('');
    if (!changed('ticker', html)) return;
    const run = $('#ticker');
    run.innerHTML = html + html; // doubled so the crawl loops seamlessly
    requestAnimationFrame(() => { run.style.animationDuration = Math.max(20, run.scrollWidth / 2 / 90) + 's'; });
  }

  // ---------- map ----------
  function drawArea() {
    T.L.area.clearLayers();
    const b = T.d.game.boundary;
    if (!b) return;
    L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], b], { stroke: false, fillColor: '#000', fillOpacity: 0.35, interactive: false }).addTo(T.L.area);
    L.polygon(b, { color: '#e8590c', weight: 5, fill: false, interactive: false }).addTo(T.L.area);
    fit();
  }
  function fit(animate) {
    const b = T.d?.game?.boundary;
    if (!T.map || !b || T.showing) return;
    T.map.invalidateSize();
    T.map.fitBounds(b, { padding: [30, 30], animate: !!animate });
  }

  // Live dots with names, plus each player's trail since the start.
  function renderPlayers() {
    const d = T.d;
    const seen = new Set();
    for (const p of d.players) {
      const t = teamOf(p.team_id);
      const trail = T.pings[p.id] || [];
      if (trail.length > 1) {
        if (!T.trails[p.id]) T.trails[p.id] = L.polyline([], { weight: 4, opacity: 0.55, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(T.L.trails);
        T.trails[p.id].setLatLngs(trail).setStyle({ color: t.color });
      }
      if (p.last_lat == null) continue;
      seen.add(p.id);
      const stale = !p.last_seen_at || d.now - p.last_seen_at > STALE_MS;
      const html = `<div class="tv-player ${stale ? 'stale' : ''}" style="background:${esc(t.color)}"></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [18, 18] });
      let m = T.markers[p.id];
      if (!m) {
        m = T.markers[p.id] = L.marker([p.last_lat, p.last_lng], { icon, zIndexOffset: 500 })
          .bindTooltip(esc(p.name), { permanent: true, direction: 'top', offset: [0, -10], className: 'tv-label' }).addTo(T.L.players);
        m._html = html;
      } else {
        m.setLatLng([p.last_lat, p.last_lng]);
        if (m._html !== html) { m.setIcon(icon); m._html = html; }
        m.setTooltipContent(esc(p.name));
      }
    }
    for (const id of Object.keys(T.markers)) if (!seen.has(id)) { T.markers[id].remove(); delete T.markers[id]; }
  }

  // Small numbered pins where each photo was sent from.
  function renderSubs() {
    // In "no spoilers" mode the pins would show where each photo is, so leave them off.
    const finds = hide() ? [] : T.d.finds.filter((f) => f.lat != null);
    if (!changed('subs', finds.map((f) => f.id + f.status + f.team_id).join() + hide() + T.d.teams.map((t) => t.color).join())) return;
    T.L.subs.clearLayers();
    for (const f of finds) {
      const t = teamOf(f.team_id), [cls] = verdict(f.status);
      const bg = cls === 'no' ? '#777' : t.color;
      L.marker([f.lat, f.lng], { icon: L.divIcon({ className: '', html: `<div class="tv-sub-pin" style="background:${esc(bg)}">${numOf(f.photo_id)}</div>`, iconSize: [22, 22] }), interactive: false }).addTo(T.L.subs);
    }
  }

  function renderOverlay() {
    const d = T.d, g = d.game;
    let html = '';
    if (g.status === 'setup') {
      const url = location.origin + '/';
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      html = `<div class="map-over"><div class="join-box">
        <div class="qr">${q.createSvgTag({ cellSize: 8, margin: 2, scalable: true })}</div>
        <div><h1>Join the hunt!</h1><p>Point your phone camera at the code.</p><p style="color:#999;margin-top:.3em">${esc(url.replace(/^https?:\/\//, ''))}</p>
          <div class="join-teams">${d.teams.map((t) => `<div>${dot(t.color)}<b>${esc(t.name)}</b><small>${t.members.length ? esc(t.members.join(', ')) : 'no one yet'}</small></div>`).join('')}</div></div>
      </div></div>`;
    } else if (g.status === 'ended' && !g.revealed) {
      html = `<div class="map-over"><div><div style="font-size:4em">🏁</div><h1>Time's up!</h1><p>Hunters, head back to home base.<br>The results are coming up…</p></div></div>`;
    }
    if (changed('over', html)) $('#over').innerHTML = html;
  }

  // ---------- spotlight: new photos and judge's calls ----------
  function queueNew() {
    const ev = events();
    if (!T.seen) { T.seen = new Set(ev.map((e) => e.key)); return; } // don't replay history when the TV opens
    const fresh = ev.filter((e) => !T.seen.has(e.key)).reverse(); // oldest first
    fresh.forEach((e) => T.seen.add(e.key));
    T.queue.push(...fresh);
    // Stay close to live: keep only the latest few, and skip anything older than 3 minutes.
    const cutoff = T.d.now - 3 * 60000;
    T.queue = T.queue.filter((e) => e.at >= cutoff).slice(-5);
    if (!T.showing) nextSpot();
  }

  const preload = (src) => new Promise((res) => {
    if (!src) return res();
    const i = new Image(); const done = () => res(); i.onload = done; i.onerror = done; i.src = src; setTimeout(done, 3000);
  });

  async function nextSpot() {
    // Wait while the final reveal is on screen.
    if ($('#reveal')) { T.showing = true; await wait(2000); return nextSpot(); }
    let e = T.queue.shift();
    while (e && e.kind === 'judge' && hide()) e = T.queue.shift(); // judge calls would hint at yes/no
    if (!e) { T.showing = false; fit(true); return; }
    T.showing = true;
    const f = T.d.finds.find((x) => x.id === e.f.id) || e.f; // use the latest status
    const t = teamOf(f.team_id), p = photoOf(f.photo_id), pl = playerOf(f.player_id);
    const [cls, txt] = verdict(f.status);
    if (e.kind === 'judge') {
      $('#spot').innerHTML = `<div class="judge-spot"><span>⚖ Judge's call</span>${dot(t.color)}<span>${esc(t.name)} #${numOf(f.photo_id)}</span>${cls ? `<span class="vt ${cls}" style="font-size:.8em">${txt}</span>` : ''}</div>`;
      await wait(JUDGE_MS);
    } else {
      const proof = f.proof_key ? `/img/${f.proof_key}` : null;
      await Promise.all([preload(p?.image), preload(proof)]);
      if (f.lat != null && !hide()) {
        T.map.flyTo([f.lat, f.lng], 17, { duration: 1.4 });
        const burst = L.marker([f.lat, f.lng], { icon: L.divIcon({ className: '', html: `<div class="tv-burst" style="color:${esc(t.color)}"><i></i><i></i></div>`, iconSize: [16, 16] }), interactive: false }).addTo(T.L.fx);
        setTimeout(() => burst.remove(), SPOT_MS + 1500);
      }
      $('#spot').innerHTML = `<div class="spot">
        <div class="spot-head" style="background:${esc(t.color)}"><span>${esc(pl?.name || 'The judge')}</span><span style="font-weight:400">· ${esc(t.name)} team</span><span class="kind">${pl ? 'NEW PHOTO' : 'ADDED BY THE JUDGE'}</span></div>
        <div class="spot-pics">
          <figure><img src="${esc(p?.image)}" alt=""><figcaption>THE PHOTO</figcaption></figure>
          <figure>${proof ? `<img src="${esc(proof)}" alt="">` : '<div class="nopic">No picture</div>'}<figcaption>THEIR SHOT</figcaption></figure>
        </div>
        <div class="spot-foot"><span><b>#${numOf(f.photo_id)}</b>${p?.title ? ' · ' + esc(p.title) : ''} · ${p ? `${DIFF[p.difficulty]} · ${p.points} pt${p.points === 1 ? '' : 's'}` : ''}</span>
          ${cls ? `<span class="stamp ${cls}">${txt}</span>` : ''}</div>
      </div>`;
      await wait(SPOT_MS);
    }
    const el = $('#spot').firstElementChild;
    if (el) { el.classList.add('out'); await wait(400); }
    $('#spot').innerHTML = '';
    nextSpot();
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- final reveal: last place first, then the winner ----------
  async function showReveal() {
    $('#reveal')?.remove();
    const teams = T.d.teams;
    if (!teams.length) return;
    const o = document.createElement('div');
    o.className = 'reveal'; o.id = 'reveal';
    o.innerHTML = `<button class="tv-btn close" id="rvClose">Show the map</button>
      <div class="crown">🏆</div><h1 id="rvTitle">And the results are…</h1>
      <div class="rv-list">${teams.map((t, i) => `
        <div class="rv-row ${i === 0 ? 'first' : ''}" style="border-color:${esc(t.color)}" data-i="${i}">
          <span class="rk">${i + 1}</span>
          <div><div class="nm">${esc(t.name)}</div><div class="meta">${[1, 2, 3].map((x) => `<span><span class="bullet d${x}">${'EMH'[x - 1]}</span>${t.by_diff[x - 1]}</span>`).join('')}<span>${t.found} of ${t.submitted} counted</span><span>${esc(t.members.join(', '))}</span></div></div>
          <span class="pts"><span class="n">0</span><small>pts</small></span>
        </div>`).join('')}</div>`;
    document.body.appendChild(o);
    $('#rvClose').onclick = () => o.remove();
    await wait(1800);
    for (let i = teams.length - 1; i >= 0; i--) {
      const row = o.querySelector(`[data-i="${i}"]`);
      if (!row || !o.isConnected) return;
      row.classList.add('in');
      countUp(row.querySelector('.n'), teams[i].score, 1400);
      await wait(i === 0 ? 1600 : 2200);
    }
    if (!o.isConnected) return;
    const h = $('#rvTitle');
    h.textContent = `${teams[0].name} team wins!` + (teams[1] && teams[1].score === teams[0].score ? ' (tie broken by who got there first)' : ''); h.style.color = teams[0].color; h.classList.add('win');
    confetti();
  }
  function countUp(el, to, ms) {
    const start = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - start) / ms);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    })(start);
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

  // ---------- TV niceties ----------
  // Keep the screen awake, hide the mouse when it's still, and keyboard shortcuts.
  async function wake() { try { T.lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); tick(); } });
  let idleTimer;
  document.addEventListener('mousemove', () => { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000); });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || !T.d) return;
    if (e.key === 'f' || e.key === 'F') fullscreen();
    if (e.key === 'h' || e.key === 'H') toggleSpoilers();
    if ((e.key === 'r' || e.key === 'R') && T.d.game?.revealed) showReveal();
  });

  wake();
  if (T.pw) boot(); else login();
})();
