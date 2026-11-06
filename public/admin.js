// Admin page: setup (photos, teams), map (pins, play area), live (lobby, judge, feed), results.
(() => {
  const DIFF = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  const DIFF_COLOR = { 1: '#15803d', 2: '#a16207', 3: '#b91c1c' };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const playerUrl = location.origin + '/';
  const A = { pw: localStorage.getItem('adminPw'), tab: 'setup', d: null, placing: null, drawing: null, maps: {} };

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
      <div class="screen stack" style="max-width:420px;margin-top:10vh">
        <h1>🦃 Photo Hunt Admin</h1>
        <form id="lf" class="stack"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
        <button class="btn-primary btn-big">Sign in</button></form>
        <p class="error">${esc(err || '')}</p>
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
      <header class="admin-head">
        <h1>🦃 Admin</h1>
        <nav>${['setup', 'map', 'live', 'results'].map((t) => `<button data-tab="${t}">${{ setup: '1. Photos & teams', map: '2. Map', live: '3. Live game', results: '4. Results' }[t]}</button>`).join('')}</nav>
        <span class="grow"></span>
        <span id="status"></span>
      </header>
      <div class="wrap" id="body"></div>`;
    document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
    await refresh();
    show(A.d?.game ? (A.d.game.status === 'live' ? 'live' : 'setup') : 'setup');
    setInterval(() => { if ((A.tab === 'live' || A.tab === 'results') && !document.hidden) refresh().then(render); }, 5000);
  }

  async function refresh() { A.d = await api('/state'); renderStatus(); }

  function renderStatus() {
    const g = A.d?.game;
    $('#status').innerHTML = g ? `<span class="status ${g.status}">${{ setup: 'Not started', live: 'LIVE', ended: 'Ended' }[g.status]}</span>` : '';
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
    $('#body').innerHTML = `<div class="card stack" style="max-width:520px">
      <h2>Create your game</h2><label for="gn">Game name</label><input id="gn" value="Thanksgiving Photo Hunt">
      <button class="btn-primary" id="mk">Create game</button></div>`;
    $('#mk').onclick = async () => { await api('/game', 'POST', { name: $('#gn').value }); await refresh(); show('setup'); };
  }

  // ---------- setup ----------
  function renderSetup() {
    const { game, teams, photos } = A.d;
    const noPin = photos.filter((p) => p.lat == null);
    $('#body').innerHTML = `
      <div class="cols">
        <div class="card stack">
          <h2>Game</h2>
          <label for="gname">Name</label><input id="gname" value="${esc(game.name)}">
          <p class="muted" style="font-size:.85em">Players join at <b>${esc(playerUrl)}</b></p>
          <details><summary class="muted">Start over with a fresh game</summary>
            <p style="font-size:.85em">Makes a new game with the same photos and play area. All players, finds, and scores are cleared.</p>
            <button class="btn-bad btn-small" id="fresh">Create fresh game</button></details>
        </div>
        <div class="card stack">
          <h2>Teams</h2>
          ${teams.map((t) => `<div class="row"><input type="color" value="${esc(t.color)}" data-tcolor="${t.id}" style="width:56px;padding:2px"><input class="grow" value="${esc(t.name)}" data-tname="${t.id}" style="flex:1;width:auto"><button class="btn-small btn-bad" data-tdel="${t.id}">Remove</button></div>`).join('')}
          <button class="btn-small" id="addTeam">+ Add team</button>
        </div>
      </div>
      <div class="card stack" style="margin-top:1em">
        <h2>Photos (${photos.length})</h2>
        <div class="drop" id="drop">
          <p><b>Drag photos here</b> or</p>
          <label class="btn btn-primary" style="display:inline-flex">Choose photos<input type="file" id="files" accept="image/*" multiple class="hidden"></label>
          <p class="muted" style="font-size:.85em;margin-top:.6em">Use the original photos so their location comes along. Each one gets pinned on the map automatically.</p>
          <p id="upProg"></p>
        </div>
        ${noPin.length ? `<div class="banner"><b>${noPin.length} photo${noPin.length > 1 ? 's' : ''} need a pin.</b> No location was saved in ${noPin.length > 1 ? 'them' : 'it'}. Click "Place on map" below.</div>` : ''}
        <div class="photo-grid">${photos.map(photoCard).join('')}</div>
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
    bindPhotoCards();
  }

  function photoCard(p) {
    return `<div class="card photo-card" data-card="${p.id}">
      <img src="/img/${esc(p.thumb_key)}" alt="" loading="lazy">
      <div class="fields">
        <div class="full"><label>Title (optional)</label><input data-f="title" value="${esc(p.title)}"></div>
        <div><label>Difficulty</label><select data-f="difficulty">${[1, 2, 3].map((d) => `<option value="${d}" ${p.difficulty === d ? 'selected' : ''}>${DIFF[d]}</option>`).join('')}</select></div>
        <div><label>Points</label><input data-f="points" type="number" min="0" value="${p.points}"></div>
        <div><label>Check-in radius (m)</label><input data-f="radius_m" type="number" min="5" value="${p.radius_m}"></div>
        <div><label>Pin</label><button class="btn-small" data-place="${p.id}" style="width:100%">${p.lat == null ? '📍 Place on map' : '✓ Move pin'}</button></div>
        <div class="full"><label>Hint (optional)</label><input data-f="hint" value="${esc(p.hint)}"></div>
        <div class="full" style="text-align:right"><button class="btn-small btn-bad" data-pdel="${p.id}">Delete photo</button></div>
      </div></div>`;
  }

  function bindPhotoCards() {
    document.querySelectorAll('[data-card]').forEach((card) => {
      const pid = card.dataset.card;
      card.querySelectorAll('[data-f]').forEach((inp) => inp.onchange = async () => {
        const f = inp.dataset.f;
        const v = ['difficulty', 'points', 'radius_m'].includes(f) ? Number(inp.value) : inp.value;
        await api('/photos/' + pid, 'PATCH', { [f]: v });
        await refresh();
        if (f === 'difficulty') { const pts = card.querySelector('[data-f=points]'); pts.value = A.d.photos.find((p) => p.id === pid).points; }
      });
    });
    document.querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => { if (!confirm('Delete this photo?')) return; await api('/photos/' + b.dataset.pdel, 'DELETE'); await refresh(); render(true); });
    document.querySelectorAll('[data-place]').forEach((b) => b.onclick = () => { show('map'); startPlacing(b.dataset.place); });
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
  function baseMap(elId) {
    const m = L.map(elId).setView([39.5, -98.35], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    return m;
  }

  function renderMap() {
    $('#body').innerHTML = `
      <div class="row" style="margin-bottom:.6em">
        <button id="drawBtn">✏️ Draw play area</button>
        <button id="clearBtn" class="btn-bad">Clear play area</button>
        <span class="grow"></span>
        <span class="muted" style="font-size:.85em">Pins: <span class="pill diff-1">Easy</span> <span class="pill diff-2">Medium</span> <span class="pill diff-3">Hard</span></span>
      </div>
      <div id="mapMsg"></div>
      <div id="adminMap"></div>`;
    const m = A.maps.admin = baseMap('adminMap');
    A.layer = L.layerGroup().addTo(m);
    drawMapLayers(true);
    m.on('click', onMapClick);
    $('#drawBtn').onclick = () => {
      if (A.drawing) return finishDrawing();
      A.drawing = []; A.placing = null;
      $('#drawBtn').textContent = '✓ Done drawing';
      msg('Click each corner of the play area on the map, then click "Done drawing".');
      drawMapLayers();
    };
    $('#clearBtn').onclick = async () => { if (!confirm('Clear the play area?')) return; await api('/game', 'PATCH', { boundary: null }); await refresh(); drawMapLayers(); };
  }

  function msg(t) { const el = $('#mapMsg'); if (el) el.innerHTML = t ? `<div class="banner">${t}</div>` : ''; }

  async function finishDrawing() {
    const pts = A.drawing; A.drawing = null;
    $('#drawBtn').textContent = '✏️ Draw play area';
    msg('');
    if (pts.length >= 3) { await api('/game', 'PATCH', { boundary: pts }); await refresh(); }
    drawMapLayers();
  }

  function startPlacing(pid) {
    A.placing = pid;
    const p = A.d.photos.find((x) => x.id === pid);
    msg(`<div class="row"><img src="/img/${esc(p.thumb_key)}" style="width:80px;border-radius:8px"><span class="grow"><b>Click the map where this photo was taken.</b></span><button class="btn-small" id="cancelPlace">Cancel</button></div>`);
    $('#cancelPlace').onclick = () => { A.placing = null; msg(''); };
  }

  async function onMapClick(e) {
    const ll = [Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))];
    if (A.drawing) { A.drawing.push(ll); drawMapLayers(); return; }
    if (A.placing) {
      const pid = A.placing; A.placing = null; msg('');
      await api('/photos/' + pid, 'PATCH', { lat: ll[0], lng: ll[1] });
      await refresh(); drawMapLayers();
    }
  }

  function drawMapLayers(fit) {
    const m = A.maps.admin; if (!m) return;
    A.layer.clearLayers();
    const bounds = [];
    if (A.d.game.boundary && !A.drawing) { const poly = L.polygon(A.d.game.boundary, { color: '#b4471f', weight: 3, dashArray: '8 6', fillOpacity: 0.05 }).addTo(A.layer); bounds.push(...A.d.game.boundary); }
    if (A.drawing?.length) { L.polyline(A.drawing, { color: '#b4471f', weight: 3 }).addTo(A.layer); A.drawing.forEach((p) => L.circleMarker(p, { radius: 6, color: '#b4471f' }).addTo(A.layer)); }
    A.d.photos.forEach((p, i) => {
      if (p.lat == null) return;
      bounds.push([p.lat, p.lng]);
      L.circle([p.lat, p.lng], { radius: p.radius_m, color: DIFF_COLOR[p.difficulty], weight: 1, fillOpacity: 0.08, interactive: false }).addTo(A.layer);
      const icon = L.divIcon({ className: 'pin-label', html: `<span style="color:${DIFF_COLOR[p.difficulty]}">${i + 1}</span>`, iconSize: [26, 26] });
      const mk = L.marker([p.lat, p.lng], { icon, draggable: true }).addTo(A.layer);
      mk.getElement && setTimeout(() => { const el = mk.getElement(); if (el) el.style.borderColor = DIFF_COLOR[p.difficulty]; });
      mk.bindPopup(`<img src="/img/${esc(p.thumb_key)}" style="width:200px;border-radius:6px"><b>#${i + 1} ${esc(p.title || '')}</b><br>${DIFF[p.difficulty]} · ${p.points} pts · ${p.radius_m} m<br><span class="muted">Drag the pin to move it.</span>`);
      mk.on('dragend', async () => { const ll = mk.getLatLng(); await api('/photos/' + p.id, 'PATCH', { lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) }); await refresh(); drawMapLayers(); });
    });
    if (fit && bounds.length) m.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
    else if (fit && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => m.setView([p.coords.latitude, p.coords.longitude], 16), () => {});
  }

  // ---------- live ----------
  const teamOf = (id) => A.d.teams.find((t) => t.id === id) || { name: '?', color: '#999' };
  const photoOf = (id) => A.d.photos.find((p) => p.id === id);
  const playerOf = (id) => A.d.players.find((p) => p.id === id);
  const ago = (t) => { if (!t) return 'never'; const s = Math.round((A.d.now - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

  function qrSvg(text, cell = 8) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: cell, margin: 2, scalable: true }); }

  function renderLive(full) {
    if (full || !$('#liveRoot')) {
      $('#body').innerHTML = `<div id="liveRoot">
        <div class="cols">
          <div class="card stack">
            <h2>Game controls</h2>
            <div id="controls"></div>
          </div>
          <div class="card stack">
            <h2>Lobby</h2>
            <div class="row"><div class="qr" style="width:160px">${qrSvg(playerUrl)}</div><div class="grow stack"><p><b>${esc(playerUrl)}</b></p><button id="tvBtn">📺 Show QR big (for the TV)</button></div></div>
          </div>
        </div>
        <div class="cols" style="margin-top:1em">
          <div class="card"><h2>Judge queue <span id="jCount"></span></h2><div id="judge"></div></div>
          <div class="card"><h2>Players on the map</h2><div id="liveMap"></div></div>
        </div>
        <div class="cols" style="margin-top:1em">
          <div class="card"><h2>Who's playing</h2><div id="players"></div></div>
          <div class="card"><h2>Activity</h2><div id="manual"></div><div id="feed"></div></div>
        </div></div>`;
      $('#tvBtn').onclick = tv;
      const m = A.maps.live = baseMap('liveMap');
      A.liveLayer = L.layerGroup().addTo(m);
      A.liveFitted = false;
    }
    const { game, players, finds, teams, photos } = A.d;
    const busy = document.activeElement && ['SELECT', 'INPUT'].includes(document.activeElement.tagName);

    // Controls
    if (!busy || full) {
      $('#controls').innerHTML = game.status === 'setup' ? `
        <p>${photos.length} photos · ${players.length} players joined.</p>
        <label for="mins">Game length in minutes (optional)</label><input id="mins" type="number" min="5" placeholder="Leave blank for no timer">
        <button class="btn-ok btn-big" id="startBtn">▶ Start the game</button>`
        : game.status === 'live' ? `
        <p><b>The game is live.</b> ${game.ends_at ? `Ends at ${new Date(game.ends_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'No timer.'}</p>
        <button class="btn-bad btn-big" id="endBtn">■ End the game</button>`
        : `<p><b>The game is over.</b></p><button id="reopenBtn">Reopen the game</button> <button id="setupBtn">Back to not started</button>`;
      const sb = $('#startBtn'); if (sb) sb.onclick = async () => { if (!confirm('Start the game now?')) return; await api('/game', 'PATCH', { action: 'start', minutes: Number($('#mins').value) || null }); await refresh(); render(); };
      const eb = $('#endBtn'); if (eb) eb.onclick = async () => { if (!confirm('End the game for everyone?')) return; await api('/game', 'PATCH', { action: 'end' }); await refresh(); show('results'); };
      const rb = $('#reopenBtn'); if (rb) rb.onclick = async () => { await api('/game', 'PATCH', { action: 'reopen' }); await refresh(); render(); };
      const ub = $('#setupBtn'); if (ub) ub.onclick = async () => { await api('/game', 'PATCH', { action: 'setup' }); await refresh(); render(); };
    }

    // Judge queue
    const pending = finds.filter((f) => f.status === 'pending');
    $('#jCount').textContent = pending.length ? `(${pending.length})` : '';
    $('#judge').innerHTML = pending.length ? pending.map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      return `<div style="padding:.6em 0;border-bottom:1px solid var(--line)">
        <div class="judge"><div><img src="/img/${esc(p?.thumb_key)}"><small class="muted">Dad's photo</small></div><div>${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}"></a>` : '<div class="card center muted">No picture</div>'}<small class="muted">Their picture</small></div></div>
        <p><span class="swatch" style="background:${esc(t.color)}"></span> <b>${esc(pl?.name || '?')}</b> (${esc(t.name)}) · ${Math.round(f.distance_m)} m away · GPS ±${Math.round(f.accuracy_m || 0)} m</p>
        <div class="row"><button class="btn-ok grow" data-judge="${f.id}" data-s="approved">✓ Approve</button><button class="btn-bad grow" data-judge="${f.id}" data-s="rejected">✗ Reject</button></div></div>`;
    }).join('') : '<p class="muted">Nothing to judge right now.</p>';
    document.querySelectorAll('[data-judge]').forEach((b) => b.onclick = async () => { b.disabled = true; await api('/finds/' + b.dataset.judge, 'PATCH', { status: b.dataset.s }); await refresh(); render(); });

    // Players
    if (!busy) {
      $('#players').innerHTML = players.length ? teams.map((t) => {
        const ps = players.filter((p) => p.team_id === t.id);
        return `<h3><span class="swatch" style="background:${esc(t.color)}"></span> ${esc(t.name)} (${ps.length})</h3>` + ps.map((p) => `
          <div class="row" style="margin-bottom:.3em"><span class="grow" style="flex:1">${esc(p.name)} <small class="muted">· seen ${ago(p.last_seen_at)}</small></span>
          <select data-move="${p.id}" style="width:auto;min-height:36px">${teams.map((tt) => `<option value="${tt.id}" ${tt.id === t.id ? 'selected' : ''}>${esc(tt.name)}</option>`).join('')}</select></div>`).join('');
      }).join('') : '<p class="muted">Nobody yet. Share the QR code.</p>';
      document.querySelectorAll('[data-move]').forEach((s) => s.onchange = async () => { await api('/players/' + s.dataset.move, 'PATCH', { team_id: s.value }); await refresh(); render(); });

      $('#manual').innerHTML = `<details><summary class="muted">Give a team a find by hand</summary><div class="row" style="margin:.5em 0">
        <select id="mTeam" style="width:auto">${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
        <select id="mPhoto" style="width:auto">${photos.map((p, i) => `<option value="${p.id}">#${i + 1} ${esc(p.title || '')}</option>`).join('')}</select>
        <button class="btn-small" id="mAdd">Add</button></div></details>`;
      $('#mAdd').onclick = async () => { await api('/finds', 'POST', { team_id: $('#mTeam').value, photo_id: $('#mPhoto').value }); await refresh(); render(); };
    }

    // Feed
    $('#feed').innerHTML = finds.length ? finds.slice(0, 40).map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      const label = { auto: '✓ Found', approved: '✓ Approved', pending: '⏳ Waiting', rejected: '✗ Rejected' }[f.status];
      return `<div class="feed-item"><img src="/img/${esc(f.proof_key || p?.thumb_key)}" alt=""><div style="flex:1"><b>${esc(pl?.name || 'Judge')}</b> <span class="swatch" style="background:${esc(t.color)}"></span> ${esc(t.name)}<br>
        <small>${label} #${A.d.photos.indexOf(p) + 1} ${esc(p?.title || '')} · ${f.distance_m != null ? Math.round(f.distance_m) + ' m · ' : ''}${ago(f.created_at)}</small></div>
        <button class="btn-small btn-bad" data-fdel="${f.id}" title="Remove this find">Remove</button></div>`;
    }).join('') : '<p class="muted">No check-ins yet.</p>';
    document.querySelectorAll('[data-fdel]').forEach((b) => b.onclick = async () => { if (!confirm('Remove this find?')) return; await api('/finds/' + b.dataset.fdel, 'DELETE'); await refresh(); render(); });

    // Live map
    A.liveLayer.clearLayers();
    const pts = [];
    if (game.boundary) { L.polygon(game.boundary, { color: '#b4471f', weight: 3, dashArray: '8 6', fillOpacity: 0.04 }).addTo(A.liveLayer); pts.push(...game.boundary); }
    players.filter((p) => p.last_lat != null).forEach((p) => {
      const t = teamOf(p.team_id);
      pts.push([p.last_lat, p.last_lng]);
      L.circleMarker([p.last_lat, p.last_lng], { radius: 10, color: '#fff', weight: 3, fillColor: t.color, fillOpacity: 1 })
        .bindTooltip(`${esc(p.name)} · ${ago(p.last_seen_at)}`, { permanent: false }).addTo(A.liveLayer);
    });
    if (!A.liveFitted && pts.length) { A.maps.live.fitBounds(pts, { padding: [30, 30], maxZoom: 17 }); A.liveFitted = true; }
  }

  function tv() {
    const o = document.createElement('div'); o.className = 'tv';
    o.innerHTML = `<h1>🦃 ${esc(A.d.game.name)}</h1><div class="qr" style="width:min(60vh,90vw)">${qrSvg(playerUrl, 12)}</div><h2 style="margin-top:1em">Scan with your phone camera to join</h2><p style="font-size:1.5em">${esc(playerUrl)}</p><button id="tvClose">Close</button>`;
    document.body.appendChild(o);
    $('#tvClose').onclick = () => o.remove();
  }

  // ---------- results ----------
  function renderResults() {
    const { scores, finds } = A.d;
    const winner = scores[0];
    const proofs = finds.filter((f) => f.proof_key && f.status !== 'rejected');
    $('#body').innerHTML = `
      <div class="row" style="margin-bottom:1em"><button class="btn-primary" id="winBtn">🏆 Show winner full screen</button><a class="btn" id="csvBtn" href="#">⬇ Download results (CSV)</a></div>
      <div class="cols">
        <div class="card"><h2>Scoreboard</h2>${scores.map((t, i) => `<div class="score-row"><span class="rank">${i + 1}</span><span class="swatch" style="background:${esc(t.color)}"></span><span style="flex:1"><b>${esc(t.name)}</b><br><small class="muted">${t.found} found · ${t.players} players</small></span><span class="pts">${t.score}</span></div>`).join('')}</div>
        <div class="card"><h2>Proof photos (${proofs.length})</h2><div class="gallery">${proofs.map((f) => { const t = teamOf(f.team_id); return `<figure><a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}" loading="lazy"></a><figcaption>${esc(playerOf(f.player_id)?.name || '')} · ${esc(t.name)}</figcaption></figure>`; }).join('')}</div></div>
      </div>`;
    $('#winBtn').onclick = () => {
      if (!winner) return;
      const o = document.createElement('div'); o.className = 'tv';
      o.innerHTML = `<div style="font-size:8em">🏆</div><h1 style="color:${esc(winner.color)};font-size:4em">${esc(winner.name)} team wins!</h1><h2 style="font-size:2em">${winner.score} points · ${winner.found} photos found</h2>
        <div style="margin-top:1em;font-size:1.4em">${scores.slice(1).map((t, i) => `${i + 2}. ${esc(t.name)}: ${t.score}`).join(' &nbsp; ')}</div><button id="tvClose" style="margin-top:2em">Close</button>`;
      document.body.appendChild(o); $('#tvClose').onclick = () => o.remove();
    };
    $('#csvBtn').onclick = async (e) => {
      e.preventDefault();
      const res = await fetch('/api/admin/export', { headers: { 'x-admin': A.pw } });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'photo-hunt-results.csv'; a.click();
    };
  }

  if (A.pw) boot().catch(() => {}); else login();
})();
