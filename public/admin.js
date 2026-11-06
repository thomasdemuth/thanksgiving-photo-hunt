// Admin page: photos & teams, map (pins, play area), live game (judge, feed, players), results.
(() => {
  const DIFF = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  const DIFF_COLOR = { 1: '#00933c', 2: '#fccc0a', 3: '#ee352e' };
  const diffTag = (d) => `<span class="diff"><span class="bullet d${d}">${'EMH'[d - 1]}</span>${DIFF[d]}</span>`;
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
  const TABS = { setup: 'Photos & teams', map: 'Map', live: 'Live game', results: 'Results' };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const playerUrl = location.origin + '/';
  const A = { pw: localStorage.getItem('adminPw'), tab: 'setup', d: null, placing: null, drawing: null, maps: {}, sel: null, filter: 'all' };

  async function api(path, method = 'GET', body) {
    const res = await fetch('/api/admin' + path, {
      method,
      headers: { 'x-admin': A.pw || '', ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    if (res.status === 401) { localStorage.removeItem('adminPw'); A.pw = null; login('Wrong password.'); throw new Error('auth'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Something went wrong.'); throw new Error(data.error); }
    return data;
  }

  // ---------- login ----------
  function login(err) {
    $('#app').innerHTML = `
      <div class="login card stack">
        <h1 class="center">🦃 Photo Hunt Admin</h1>
        <form id="lf" class="stack"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required autofocus>
        <button class="btn-primary btn-big">Sign in</button></form>
        <p class="error center">${esc(err || '')}</p>
      </div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      A.pw = $('#pw').value.trim();
      try { await api('/login', 'POST'); localStorage.setItem('adminPw', A.pw); boot(); } catch { /* handled */ }
    };
  }

  // ---------- shell ----------
  async function boot() {
    $('#app').innerHTML = `
      <header class="a-head">
        <span class="brand">🦃 Photo Hunt</span>
        <nav>${Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}">${v}</button>`).join('')}</nav>
        <span class="grow"></span>
        <span id="status"></span>
      </header>
      <div class="wrap" id="body"></div>`;
    document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
    await refresh();
    show(A.d?.game?.status === 'live' ? 'live' : 'setup');
    // One refresh loop for the whole page; it pauses while signed out.
    if (!A.timer) A.timer = setInterval(() => {
      if (A.pw && A.d?.game && (A.tab === 'live' || A.tab === 'results') && !document.hidden) refresh().then(() => render()).catch(() => {});
    }, 5000);
  }

  async function refresh() { A.d = await api('/state'); renderStatus(); }

  function renderStatus() {
    const g = A.d?.game;
    $('#status').innerHTML = g ? `<span class="status ${g.status}">${{ setup: 'Not started', live: 'Live', ended: 'Ended' }[g.status]}</span>` : '';
  }

  function show(tab) {
    A.tab = tab; A.placing = null; A.drawing = null;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    Object.values(A.maps).forEach((m) => m.remove()); A.maps = {};
    $('#body').innerHTML = '';
    render(true);
  }

  function render(full) {
    if (!A.d.game) return renderNoGame();
    if (A.tab === 'setup' && full) renderSetup();
    if (A.tab === 'map' && full) renderMap();
    if (A.tab === 'live') renderLive(full);
    if (A.tab === 'results') renderResults();
  }

  function renderNoGame() {
    $('#body').innerHTML = `<div class="card stack" style="max-width:480px;margin:8vh auto">
      <h1>Create your game</h1><label for="gn">Game name</label><input id="gn" value="Thanksgiving Photo Hunt">
      <button class="btn-primary btn-big" id="mk">Create game</button></div>`;
    $('#mk').onclick = async () => { await api('/game', 'POST', { name: $('#gn').value }); await refresh(); show('setup'); };
  }

  function baseMap(elId) {
    const m = L.map(elId, { zoomControl: true }).setView([40.728, -74.005], 15);
    addBaseMap(m);
    return m;
  }
  function drawArea(layer, b, opts = {}) {
    if (!b) return;
    L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], b], { stroke: false, fillColor: '#000', fillOpacity: 0.3, interactive: false }).addTo(layer);
    L.polygon(b, { color: '#e8590c', weight: 4, fill: false, interactive: false, ...opts }).addTo(layer);
  }
  const numIcon = (n, d, sel) => L.divIcon({ className: '', html: `<div class="num-pin d${d} ${sel ? 'sel' : ''}" style="background:${DIFF_COLOR[d]}">${n}</div>`, iconSize: [24, 24] });

  // ---------- setup ----------
  function renderSetup() {
    const { game, teams, photos, players } = A.d;
    const noPin = photos.filter((p) => p.lat == null).length;
    const counts = [1, 2, 3].map((d) => photos.filter((p) => p.difficulty === d).length);
    $('#body').innerHTML = `
      <div class="layout">
        <div class="stack">
          <div class="card stack">
            <h2>Game</h2>
            <div><label for="gname">Name</label><input id="gname" value="${esc(game.name)}"></div>
            <p class="small muted" style="margin:0">Players join at<br><a href="${esc(playerUrl)}" target="_blank"><b>${esc(playerUrl)}</b></a></p>
            <details><summary class="small muted" style="cursor:pointer">Start over with a fresh game</summary>
              <p class="small" style="margin-top:.6em">Makes a new game with the same photos and play area. Players, finds, and scores are cleared.</p>
              <button class="btn-small btn-bad" id="fresh">Create fresh game</button></details>
          </div>
          <div class="card">
            <h2>Teams <span class="count">${teams.length}</span></h2>
            ${teams.map((t) => {
              const ms = players.filter((p) => p.team_id === t.id);
              return `<div class="team-row"><input type="color" value="${esc(t.color)}" data-tcolor="${t.id}"><input class="grow" value="${esc(t.name)}" data-tname="${t.id}"><button class="x-btn" data-tdel="${t.id}" title="Remove team">✕</button></div>
                ${ms.length ? `<p class="small muted" style="margin:-.2em 0 .6em 48px">${ms.map((p) => esc(p.name)).join(', ')}</p>` : ''}`;
            }).join('')}
            <button class="btn-small" id="addTeam">+ Add team</button>
          </div>
        </div>
        <div class="card stack">
          <h2>Photos <span class="count">${photos.length}</span>
            <span class="grow"></span>
            <span class="small muted" style="font-weight:400">${counts[0]} easy · ${counts[1]} medium · ${counts[2]} hard</span></h2>
          <div class="drop" id="drop">
            <b>Drag photos here</b> or <label class="btn btn-primary btn-small" style="display:inline-flex;margin:0 .3em">Choose photos<input type="file" id="files" accept="image/*" multiple class="hidden"></label>
            <p class="small muted" style="margin:.5em 0 0">Use the original photos so their location comes along. Each one gets pinned on the map automatically.</p>
            <p id="upProg" class="small" style="margin:.4em 0 0"></p>
          </div>
          ${noPin ? `<div class="note"><b>${noPin} photo${noPin > 1 ? 's need' : ' needs'} a pin.</b> No location was saved in ${noPin > 1 ? 'them' : 'it'}. Click "Place pin".</div>` : ''}
          ${photos.length ? `<div class="plist">
            ${photos.map(photoRow).join('')}</div>` : '<p class="muted center">No photos yet.</p>'}
        </div>
      </div>`;

    $('#gname').onchange = (e) => api('/game', 'PATCH', { name: e.target.value });
    $('#fresh').onclick = async () => { if (!confirm('Clear all players, finds and scores and start a fresh game?')) return; await api('/game', 'POST', { name: game.name }); await refresh(); show('setup'); };
    document.querySelectorAll('[data-tcolor]').forEach((i) => i.onchange = () => api('/teams/' + i.dataset.tcolor, 'PATCH', { color: i.value }).then(refresh));
    document.querySelectorAll('[data-tname]').forEach((i) => i.onchange = () => api('/teams/' + i.dataset.tname, 'PATCH', { name: i.value }).then(refresh));
    document.querySelectorAll('[data-tdel]').forEach((b) => b.onclick = async () => { await api('/teams/' + b.dataset.tdel, 'DELETE'); await refresh(); renderSetup(); });
    $('#addTeam').onclick = async () => { await api('/teams', 'POST', { name: 'New team', color: '#7c3aed' }); await refresh(); renderSetup(); };

    const drop = $('#drop');
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
    $('#files').onchange = (e) => upload([...e.target.files]);
    bindRows();
  }

  function photoRow(p, i) {
    return `<div class="prow" data-row="${p.id}">
      <span class="n">${i + 1}</span>
      <img src="/img/${esc(p.thumb_key)}" alt="" loading="lazy">
      <div class="pf">
        <input class="f-title" data-f="title" value="${esc(p.title)}" placeholder="Title (optional)">
        <span class="dseg f-diff">${[1, 2, 3].map((d) => `<button data-d="${d}" class="${p.difficulty === d ? 'on' : ''}">${DIFF[d]}</button>`).join('')}</span>
        <span class="unit f-pts"><input data-f="points" type="number" min="0" value="${p.points}"><i>pts</i></span>
        <span class="unit f-rad" title="Check-in radius"><input data-f="radius_m" type="number" min="5" value="${p.radius_m}"><i>m</i></span>
        <input class="f-hint" data-f="hint" value="${esc(p.hint)}" placeholder="Hint (optional)">
      </div>
      <div class="pact">
        <button class="btn pin-btn ${p.lat == null ? 'need' : ''}" data-place="${p.id}">${p.lat == null ? '📍 Place pin' : '✓ On map'}</button>
        <button class="x-btn" data-pdel="${p.id}" title="Delete photo">✕</button>
      </div>
    </div>`;
  }

  function bindRows() {
    document.querySelectorAll('[data-row]').forEach((row) => {
      const pid = row.dataset.row;
      row.querySelectorAll('[data-f]').forEach((inp) => inp.onchange = async () => {
        const f = inp.dataset.f;
        // The server checks the value; if it says no, put the old value back.
        try { await api('/photos/' + pid, 'PATCH', { [f]: inp.value }); } catch { inp.value = A.d.photos.find((p) => p.id === pid)?.[f] ?? ''; return; }
        await refresh();
      });
      row.querySelectorAll('[data-d]').forEach((b) => b.onclick = async () => {
        row.querySelectorAll('[data-d]').forEach((x) => x.classList.toggle('on', x === b));
        await api('/photos/' + pid, 'PATCH', { difficulty: Number(b.dataset.d) });
        await refresh();
        row.querySelector('[data-f=points]').value = A.d.photos.find((p) => p.id === pid).points;
      });
    });
    document.querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => { if (!confirm('Delete this photo?')) return; await api('/photos/' + b.dataset.pdel, 'DELETE'); await refresh(); render(true); });
    document.querySelectorAll('[data-place]').forEach((b) => b.onclick = () => { A.sel = b.dataset.place; show('map'); if (A.d.photos.find((p) => p.id === b.dataset.place).lat == null) startPlacing(b.dataset.place); });
  }

  async function upload(files) {
    files = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(f.name));
    const prog = $('#upProg');
    let done = 0, pinned = 0, failed = 0;
    for (const file of files) {
      prog.textContent = `Uploading ${done + 1} of ${files.length}…`;
      try {
        let gps = null;
        try { gps = await exifr.gps(file); } catch { /* no location */ }
        const image = await shrink(file, 1600, 0.82);
        const thumb = await shrink(file, 420, 0.6);
        const fd = new FormData();
        fd.append('image', image, 'image.jpg'); fd.append('thumb', thumb, 'thumb.jpg');
        if (gps && Number.isFinite(gps.latitude)) { fd.append('lat', gps.latitude); fd.append('lng', gps.longitude); pinned++; }
        await api('/photos', 'POST', fd);
      } catch (e) { console.error(e); failed++; }
      done++;
    }
    await refresh();
    renderSetup();
    $('#upProg').innerHTML = `<b>Uploaded ${done - failed} photo${done - failed === 1 ? '' : 's'}.</b> ${pinned} pinned automatically.${failed ? ` <span class="error">${failed} failed (HEIC photos may need Safari, or export as JPEG).</span>` : ''}`;
  }

  async function shrink(file, max, quality) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    }
    const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
  }

  // ---------- map ----------
  function renderMap() {
    $('#body').innerHTML = `
      <div class="map-layout">
        <div style="position:relative"><div id="adminMap"></div><div id="mapHint"></div></div>
        <div class="card side">
          <div class="side-head">
            <h2 style="margin-bottom:.2em">Pins <span class="count" id="pinCount"></span></h2>
            <div class="row" style="gap:.3em">
              <button class="btn-small" id="drawBtn">✏️ Redraw play area</button>
              <button class="btn-small" id="defaultBtn" title="Canal, Greenwich, Christopher, 6th Ave">Reset area</button>
            </div>
            <div class="filters" id="chips"></div>
          </div>
          <div class="side-list" id="sideList"></div>
        </div>
      </div>`;
    const m = A.maps.admin = baseMap('adminMap');
    A.areaLayer = L.layerGroup().addTo(m);
    A.pinLayer = L.layerGroup().addTo(m);
    A.ringLayer = L.layerGroup().addTo(m);
    A.markers = {};
    m.on('click', onMapClick);
    m.on('zoomend', drawRings);
    $('#drawBtn').onclick = () => {
      if (A.drawing) return finishDrawing();
      A.drawing = []; A.placing = null;
      $('#drawBtn').textContent = '✓ Done drawing';
      hint('Click each corner of the play area, then click "Done drawing".', true);
      drawArea2();
    };
    $('#defaultBtn').onclick = async () => { if (!confirm('Reset the play area to Canal, Greenwich, Christopher and 6th Ave?')) return; await api('/game', 'PATCH', { boundary: 'default' }); await refresh(); drawArea2(true); };
    drawArea2(true);
    drawPins();
    renderSide();
    const fit = A.d.game.boundary || A.d.photos.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
    if (fit.length) m.fitBounds(fit, { padding: [20, 20] });
    if (A.sel) setTimeout(() => select(A.sel, true), 300);
  }

  function hint(text, cancel) {
    const el = $('#mapHint'); if (!el) return;
    el.innerHTML = text ? `<div class="map-hint">${text}${cancel ? '<button class="btn-small" id="cancelHint">Cancel</button>' : ''}</div>` : '';
    const c = $('#cancelHint');
    if (c) c.onclick = () => { A.placing = null; if (A.drawing) { A.drawing = null; $('#drawBtn').textContent = '✏️ Redraw play area'; drawArea2(); } hint(''); };
  }

  function drawArea2() {
    A.areaLayer.clearLayers();
    if (A.drawing) {
      if (A.drawing.length) { L.polyline(A.drawing, { color: '#e8590c', weight: 3, dashArray: '6 6' }).addTo(A.areaLayer); A.drawing.forEach((p) => L.circleMarker(p, { radius: 6, color: '#e8590c', fillColor: '#fff', fillOpacity: 1 }).addTo(A.areaLayer)); }
    } else drawArea(A.areaLayer, A.d.game.boundary);
  }

  async function finishDrawing() {
    const pts = A.drawing; A.drawing = null;
    $('#drawBtn').textContent = '✏️ Redraw play area';
    hint('');
    if (pts.length >= 3) { await api('/game', 'PATCH', { boundary: pts }); await refresh(); }
    drawArea2();
  }

  const visible = (p) => A.filter === 'all' || (A.filter === 'nopin' ? p.lat == null : p.difficulty === Number(A.filter));

  function drawPins() {
    A.pinLayer.clearLayers(); A.markers = {};
    A.d.photos.forEach((p, i) => {
      if (p.lat == null || !visible(p)) return;
      const mk = L.marker([p.lat, p.lng], { icon: numIcon(i + 1, p.difficulty, A.sel === p.id), draggable: true, riseOnHover: true }).addTo(A.pinLayer);
      mk.bindTooltip(`<img src="/img/${esc(p.thumb_key)}" style="width:140px;border-radius:8px;display:block;margin-bottom:3px"><b>#${i + 1}</b> ${esc(p.title || '')} · ${DIFF[p.difficulty]}`, { direction: 'top', offset: [0, -12] });
      mk.on('click', () => select(p.id));
      mk.on('dragend', async () => { const ll = mk.getLatLng(); await api('/photos/' + p.id, 'PATCH', { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }); await refresh(); drawRings(); });
      A.markers[p.id] = mk;
    });
    drawRings();
  }

  // Check-in circles only when zoomed in, so 60 pins stay readable.
  function drawRings() {
    const m = A.maps.admin; if (!m) return;
    A.ringLayer.clearLayers();
    if (m.getZoom() < 17) return;
    A.d.photos.forEach((p) => { if (p.lat != null && visible(p)) L.circle([p.lat, p.lng], { radius: p.radius_m, color: DIFF_COLOR[p.difficulty], weight: 1, fillOpacity: 0.1, interactive: false }).addTo(A.ringLayer); });
  }

  function renderSide() {
    const ps = A.d.photos;
    const n = { all: ps.length, 1: 0, 2: 0, 3: 0, nopin: 0 };
    ps.forEach((p) => { n[p.difficulty]++; if (p.lat == null) n.nopin++; });
    $('#pinCount').textContent = `${ps.length - n.nopin} of ${ps.length}`;
    $('#chips').innerHTML = [['all', 'All'], ['1', 'Easy'], ['2', 'Medium'], ['3', 'Hard'], ['nopin', 'Needs pin']]
      .filter(([k]) => k !== 'nopin' || n.nopin)
      .map(([k, v]) => `<button class="${A.filter === k ? 'on' : ''}" data-chip="${k}">${v} ${n[k]}</button>`).join('');
    document.querySelectorAll('[data-chip]').forEach((b) => b.onclick = () => { A.filter = b.dataset.chip; drawPins(); renderSide(); });
    $('#sideList').innerHTML = ps.map((p, i) => visible(p) ? `
      <div class="side-item ${A.sel === p.id ? 'sel' : ''}" data-item="${p.id}">
        <img src="/img/${esc(p.thumb_key)}" loading="lazy" alt="">
        <span class="t"><b>#${i + 1}</b> ${esc(p.title || '')}<br><span class="small">${diffTag(p.difficulty)} · ${p.points} pt</span></span>
        ${p.lat == null ? `<button class="btn pin-btn need" data-place2="${p.id}">Place</button>` : ''}
      </div>` : '').join('') || '<p class="muted center small" style="padding:1em">No photos here.</p>';
    document.querySelectorAll('[data-item]').forEach((el) => el.onclick = (e) => { if (!e.target.closest('[data-place2]')) select(el.dataset.item, true); });
    document.querySelectorAll('[data-place2]').forEach((b) => b.onclick = () => { select(b.dataset.place2); startPlacing(b.dataset.place2); });
  }

  function select(pid, fly) {
    A.sel = pid;
    const i = A.d.photos.findIndex((p) => p.id === pid), p = A.d.photos[i];
    Object.entries(A.markers).forEach(([id, mk]) => { const q = A.d.photos.find((x) => x.id === id); const qi = A.d.photos.indexOf(q); mk.setIcon(numIcon(qi + 1, q.difficulty, id === pid)); mk.setZIndexOffset(id === pid ? 1000 : 0); });
    document.querySelectorAll('[data-item]').forEach((el) => el.classList.toggle('sel', el.dataset.item === pid));
    const item = document.querySelector(`[data-item="${pid}"]`); if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (fly && p?.lat != null) A.maps.admin.flyTo([p.lat, p.lng], Math.max(A.maps.admin.getZoom(), 17), { duration: 0.5 });
    if (p && p.lat != null) hint(`<b>#${i + 1}</b> ${esc(p.title || '')} · drag the pin to move it`);
  }

  function startPlacing(pid) {
    A.placing = pid; A.drawing = null;
    const i = A.d.photos.findIndex((p) => p.id === pid);
    hint(`<b>Click the map where photo #${i + 1} was taken.</b>`, true);
  }

  async function onMapClick(e) {
    const ll = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
    if (A.drawing) { A.drawing.push(ll); drawArea2(); return; }
    if (A.placing) {
      const pid = A.placing; A.placing = null; hint('');
      await api('/photos/' + pid, 'PATCH', { lat: ll[0], lng: ll[1] });
      await refresh(); drawPins(); renderSide(); select(pid);
    }
  }

  // ---------- live ----------
  const teamOf = (id) => A.d.teams.find((t) => t.id === id) || { name: '?', color: '#999' };
  const photoOf = (id) => A.d.photos.find((p) => p.id === id);
  const playerOf = (id) => A.d.players.find((p) => p.id === id);
  const numOf = (id) => A.d.photos.findIndex((p) => p.id === id) + 1;
  const ago = (t) => { if (!t) return 'not yet'; const s = Math.round((A.d.now - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  function qrSvg(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); }

  function scoreTiles() {
    return `<div class="tiles">${A.d.scores.map((t, i) => `
      <div class="stat" style="--c:${esc(t.color)}">
        <div class="row" style="justify-content:space-between"><b>${i + 1}. ${esc(t.name)}</b><span class="small muted">${t.players} players</span></div>
        <div class="v">${t.score} <span class="small muted" style="font-weight:400">pts</span></div>
        <div class="counts">${[1, 2, 3].map((d) => `<span><span class="bullet d${d}">${'EMH'[d - 1]}</span>${t.by_diff[d - 1]}</span>`).join('')}<span class="muted">${t.found} found</span></div>
      </div>`).join('')}</div>`;
  }

  function renderLive(full) {
    if (full || !$('#liveRoot')) {
      $('#body').innerHTML = `<div id="liveRoot">
        <div id="tiles"></div>
        <div class="cols">
          <div class="stack">
            <div class="card"><div class="row" style="align-items:flex-start;gap:1em">
              <div class="grow stack" id="controls"></div>
              <div style="width:130px;text-align:center"><div class="qr">${qrSvg(playerUrl)}</div><button class="btn-small" id="tvBtn" style="margin-top:.4em;width:100%">📺 Show on TV</button></div>
            </div></div>
            <div class="card"><h2>Judge queue <span class="count" id="jCount">0</span></h2><div id="judge"></div></div>
            <div class="card"><h2>Activity</h2><div id="manual"></div><div class="feed" id="feed"></div></div>
          </div>
          <div class="stack">
            <div class="card"><h2>Where everyone is</h2><div id="liveMap"></div></div>
            <div class="card"><h2>Players <span class="count" id="pCount">0</span></h2><div id="players"></div></div>
          </div>
        </div></div>`;
      $('#tvBtn').onclick = tv;
      const m = A.maps.live = baseMap('liveMap');
      A.liveLayer = L.layerGroup().addTo(m);
      drawArea(L.layerGroup().addTo(m), A.d.game.boundary);
      if (A.d.game.boundary) m.fitBounds(A.d.game.boundary, { padding: [10, 10] });
    }
    const { game, players, finds, teams, photos } = A.d;
    const busy = document.activeElement && ['SELECT', 'INPUT'].includes(document.activeElement.tagName);
    // Only redraw a section when its content changed, so buttons don't move under the mouse.
    const changed = (key, val) => { if (!full && A.sig?.[key] === val) return false; (A.sig ||= {})[key] = val; return true; };
    $('#tiles').innerHTML = scoreTiles();

    if (changed('controls', game.status + '|' + game.ends_at)) {
      $('#controls').innerHTML = game.status === 'setup' ? `
        <h2>Ready to start?</h2>
        <p class="small muted" style="margin:0"><span id="joinedLine"></span> Scan the code to join.</p>
        <div><label for="mins" class="small">Game length in minutes (optional)</label><input id="mins" type="number" min="5" placeholder="No timer"></div>
        <button class="btn-ok btn-big" id="startBtn">▶ Start the game</button>`
        : game.status === 'live' ? `
        <h2>The game is live</h2>
        <p class="small muted" style="margin:0">${game.ends_at ? `Ends at ${new Date(game.ends_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'No timer. End it when everyone is back.'}</p>
        <button class="btn-big btn-bad" id="endBtn">■ End the game</button>`
        : `<h2>The game is over</h2><div class="row"><button id="reopenBtn">Reopen</button><button id="setupBtn">Back to not started</button></div>`;
      const act = (btn, body, ask, after) => btn && (btn.onclick = async () => {
        if (ask && !confirm(ask)) return;
        btn.disabled = true;
        try { await api('/game', 'PATCH', body()); await refresh(); } finally { btn.disabled = false; }
        after ? after() : render();
      });
      act($('#startBtn'), () => ({ action: 'start', minutes: Number($('#mins').value) || null }), 'Start the game now?');
      act($('#endBtn'), () => ({ action: 'end' }), 'End the game for everyone?', () => show('results'));
      act($('#reopenBtn'), () => ({ action: 'reopen' }));
      act($('#setupBtn'), () => ({ action: 'setup' }), 'Go back to "not started"? Finds stay, but the timer resets.');
    }
    const jl = $('#joinedLine'); if (jl) jl.textContent = `${photos.length} photos · ${players.length} players joined.`;

    // Judge queue
    const pending = finds.filter((f) => f.status === 'pending');
    $('#jCount').textContent = pending.length; $('#jCount').classList.toggle('hot', pending.length > 0);
    if (changed('judge', pending.map((f) => f.id).join())) $('#judge').innerHTML = pending.length ? pending.map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      return `<div class="judge-item">
        <div class="judge-pics"><figure><img src="/img/${esc(p?.thumb_key)}"><figcaption>#${numOf(f.photo_id)} · the photo</figcaption></figure>
          <figure>${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}"></a>` : '<div class="nopic">No picture</div>'}<figcaption>their picture</figcaption></figure></div>
        <p class="small" style="margin:.2em 0 .5em"><span class="swatch" style="background:${esc(t.color)}"></span> <b>${esc(pl?.name || '?')}</b> (${esc(t.name)}) · ${Math.round(f.distance_m)} m from the spot · GPS ±${Math.round(f.accuracy_m || 0)} m</p>
        <div class="row"><button class="btn-ok grow" data-judge="${f.id}" data-s="approved">✓ Approve</button><button class="btn-bad grow" data-judge="${f.id}" data-s="rejected">✕ Reject</button></div></div>`;
    }).join('') : '<p class="muted small" style="margin:0">Nothing to judge right now.</p>';
    document.querySelectorAll('[data-judge]').forEach((b) => b.onclick = async () => {
      b.closest('.judge-item').querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try { await api('/finds/' + b.dataset.judge, 'PATCH', { status: b.dataset.s }); } finally { await refresh(); render(); }
    });

    // Players + manual fixes
    $('#pCount').textContent = players.length;
    if (!busy && changed('players', JSON.stringify(players.map((p) => [p.id, p.team_id, p.name, ago(p.last_seen_at)])) + teams.map((t) => t.id + t.name).join())) {
      $('#players').innerHTML = players.length ? teams.map((t) => {
        const ps = players.filter((p) => p.team_id === t.id);
        return `<div style="margin-bottom:.8em"><div class="row small" style="font-weight:700;margin-bottom:.3em"><span class="swatch" style="background:${esc(t.color)}"></span>${esc(t.name)} <span class="muted" style="font-weight:400">${ps.length}</span></div>` + ps.map((p) => `
          <div class="row" style="padding:.2em 0 .2em 1.4em"><span class="grow small">${esc(p.name)} <span class="muted">· ${ago(p.last_seen_at)}</span></span>
          <select data-move="${p.id}" style="width:auto;min-height:32px;font-size:.8em;padding:.1em .4em">${teams.map((tt) => `<option value="${tt.id}" ${tt.id === t.id ? 'selected' : ''}>${esc(tt.name)}</option>`).join('')}</select></div>`).join('') + '</div>';
      }).join('') : '<p class="muted small" style="margin:0">Nobody yet. Show the QR code.</p>';
      document.querySelectorAll('[data-move]').forEach((s) => s.onchange = async () => { await api('/players/' + s.dataset.move, 'PATCH', { team_id: s.value }); await refresh(); render(); });
    }
    // The hand-add panel is only rebuilt when teams or photos change, so it keeps what you picked.
    if (changed('manual', teams.map((t) => t.id + t.name).join() + photos.map((p) => p.id + p.title).join())) {
      $('#manual').innerHTML = `<details style="margin-bottom:.5em"><summary class="small muted" style="cursor:pointer">Give a team a find by hand</summary><div class="row" style="margin:.5em 0">
        <select id="mTeam" style="width:auto">${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
        <select id="mPhoto" style="width:auto">${photos.map((p, i) => `<option value="${p.id}">#${i + 1} ${esc(p.title || '')}</option>`).join('')}</select>
        <button class="btn-small" id="mAdd">Add</button></div></details>`;
      $('#mAdd').onclick = async () => {
        const team = teamOf($('#mTeam').value), n = numOf($('#mPhoto').value);
        if (!confirm(`Give ${team.name} team photo #${n}?`)) return;
        await api('/finds', 'POST', { team_id: $('#mTeam').value, photo_id: $('#mPhoto').value }); await refresh(); render();
      };
    }

    // Feed
    if (changed('feed', finds.map((f) => f.id + f.status).join() + Math.floor(A.d.now / 60000))) $('#feed').innerHTML = finds.length ? finds.slice(0, 60).map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      const label = { auto: 'Found', approved: 'Approved', pending: 'Waiting', rejected: 'Rejected' }[f.status];
      return `<div class="feed-item"><img src="/img/${esc(f.proof_key || p?.thumb_key)}" alt="" loading="lazy">
        <div class="grow small"><b>${esc(pl?.name || 'Judge')}</b> <span class="swatch" style="background:${esc(t.color)}"></span> ${esc(t.name)} · #${numOf(f.photo_id)} <span class="muted">(${DIFF[p?.difficulty] || ''})</span><br>
        <span class="tag ${f.status}">${label}</span> <span class="muted">${f.distance_m != null ? Math.round(f.distance_m) + ' m · ' : ''}${ago(f.created_at)}</span></div>
        <button class="x-btn" data-fdel="${f.id}" title="Remove this find">✕</button></div>`;
    }).join('') : '<p class="muted small" style="margin:0">No check-ins yet.</p>';
    document.querySelectorAll('[data-fdel]').forEach((b) => b.onclick = async () => { if (!confirm('Remove this find?')) return; await api('/finds/' + b.dataset.fdel, 'DELETE'); await refresh(); render(); });

    // Live map
    A.liveLayer.clearLayers();
    players.filter((p) => p.last_lat != null).forEach((p) => {
      const t = teamOf(p.team_id), stale = A.d.now - p.last_seen_at > 5 * 60000;
      L.marker([p.last_lat, p.last_lng], { icon: L.divIcon({ className: '', html: `<div class="player-pin ${stale ? 'stale' : ''}" style="background:${esc(t.color)}"></div>`, iconSize: [18, 18] }) })
        .bindTooltip(`<b>${esc(p.name)}</b> · ${esc(t.name)}<br>${ago(p.last_seen_at)}`, { direction: 'top', offset: [0, -8] }).addTo(A.liveLayer);
    });
  }

  function tv() {
    const o = document.createElement('div'); o.className = 'tv';
    o.innerHTML = `<button class="close" id="tvClose">Close</button><div style="font-size:3em">🦃</div><h1>${esc(A.d.game.name)}</h1><div class="qr">${qrSvg(playerUrl)}</div><h2 style="margin-top:1em;font-size:2em">Scan with your phone camera to join</h2><p class="muted" style="font-size:1.4em">${esc(playerUrl)}</p>`;
    document.body.appendChild(o);
    $('#tvClose').onclick = () => o.remove();
  }

  // ---------- results ----------
  function renderResults() {
    const { scores, finds } = A.d;
    const winner = scores[0];
    const proofs = finds.filter((f) => f.proof_key && f.status !== 'rejected');
    $('#body').innerHTML = `
      ${winner ? `<div class="winner" style="background:${esc(winner.color)}"><h1>🏆 ${esc(winner.name)} ${A.d.game.status === 'ended' ? 'wins!' : 'is in the lead'}</h1><p style="margin:0">${winner.score} points · ${winner.found} photos found</p></div>` : ''}
      <div class="row" style="margin-bottom:1em"><button class="btn-primary" id="winBtn">🏆 Show winner on TV</button><button id="csvBtn">⬇ Download results (CSV)</button></div>
      ${scoreTiles()}
      <div class="card"><h2>Proof photos <span class="count">${proofs.length}</span></h2><div class="gallery">${proofs.map((f) => { const t = teamOf(f.team_id); return `<figure><a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}" loading="lazy"></a><figcaption><span class="swatch" style="background:${esc(t.color)}"></span> ${esc(playerOf(f.player_id)?.name || '')} · #${numOf(f.photo_id)}</figcaption></figure>`; }).join('') || '<p class="muted small">None yet.</p>'}</div></div>`;
    $('#winBtn').onclick = () => {
      if (!winner) return;
      const o = document.createElement('div'); o.className = 'tv';
      o.innerHTML = `<button class="close" id="tvClose">Close</button><div style="font-size:8em">🏆</div><h1 style="color:${esc(winner.color)};font-size:4.5em">${esc(winner.name)} wins!</h1><h2 style="font-size:2em">${winner.score} points · ${winner.found} photos found</h2>
        <div style="margin-top:1.5em;font-size:1.5em;display:flex;gap:1.5em">${scores.slice(1).map((t, i) => `<span><span class="swatch" style="background:${esc(t.color)}"></span> ${i + 2}. ${esc(t.name)}: <b>${t.score}</b></span>`).join('')}</div>`;
      document.body.appendChild(o); $('#tvClose').onclick = () => o.remove();
    };
    $('#csvBtn').onclick = async () => {
      const res = await fetch('/api/admin/export', { headers: { 'x-admin': A.pw } });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'photo-hunt-results.csv'; a.click();
    };
  }

  if (A.pw) boot().catch(() => {}); else login();
})();
