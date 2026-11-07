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
    show(['live', 'ended'].includes(A.d?.game?.status) ? 'live' : 'setup');
    // One refresh loop for the whole page; it pauses while signed out.
    if (!A.timer) A.timer = setInterval(() => {
      if (A.pw && A.d?.game && (A.tab === 'live' || A.tab === 'results') && !document.hidden) refresh().then(() => render()).catch(() => {});
    }, 3000); // every 3 seconds, so the judge sees photos as they arrive
  }

  async function refresh() { A.d = await api('/state'); renderStatus(); }

  function renderStatus() {
    const g = A.d?.game;
    $('#status').innerHTML = g ? `<a class="btn btn-small tv-link" href="/tv" target="_blank">📺 TV view</a> <span class="status ${g.status}">${{ setup: 'Not started', live: 'Live', ended: g.revealed_at ? 'Ended · results revealed' : 'Ended · results hidden' }[g.status]}</span>` : '';
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
            <b>Drag photos here</b> or <label class="btn btn-primary btn-small" style="display:inline-flex;margin:0 .3em">Choose photos<input type="file" id="files" accept="image/*,.heic,.heif,.HEIC,.HEIF" multiple class="hidden"></label>
            <p class="small muted" style="margin:.5em 0 0">iPhone photos (HEIC) and JPEGs both work. Photos with a saved location get pinned on the map automatically.</p>
            <details class="small muted" style="margin:.4em 0 0;text-align:left"><summary style="cursor:pointer;text-align:center">How to keep the locations</summary>
              <ul style="margin:.4em 0 0;padding-left:1.2em">
                <li><b>Mac Photos app:</b> select the photos and drag them onto this box. Or File → Export → Export Unmodified Originals, then drag those files here.</li>
                <li><b>iPhone:</b> the photo picker can remove locations. In Photos, select the photos → Share → <b>Options</b> → turn on <b>Location</b> → Save to Files. Then tap Choose photos → Browse and pick them from Files.</li>
                <li><b>Missing a location?</b> The photo still uploads; place its pin on the Map tab.</li>
              </ul></details>
            <p id="upProg" class="small" style="margin:.4em 0 0"></p>
          </div>
          ${photos.length ? radiusBar(photos) : ''}
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
        <span class="unit f-rad" title="Check-in radius: how close a player must be (${p.radius_m} m ≈ ${ft(p.radius_m)} ft)"><input data-f="radius_m" type="number" min="5" max="500" value="${p.radius_m}"><i>m</i></span>
        <input class="f-hint" data-f="hint" value="${esc(p.hint)}" placeholder="Hint (optional)">
      </div>
      <div class="pact">
        <button class="btn pin-btn ${p.lat == null ? 'need' : ''}" data-place="${p.id}">${p.lat == null ? '📍 Place pin' : '✓ On map'}</button>
        <button class="x-btn" data-pdel="${p.id}" title="Delete photo">✕</button>
      </div>
    </div>`;
  }

  const ft = (m) => Math.round((m * 3.28084) / 5) * 5;

  // One control to set the check-in radius for every photo (or one difficulty) at once.
  function radiusBar(photos) {
    const tally = {};
    photos.forEach((p) => { tally[p.radius_m] = (tally[p.radius_m] || 0) + 1; });
    const common = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const now = common.map(([r, n]) => `${r} m on ${n === photos.length ? 'all' : n}`).join(', ');
    return `<div class="radius-bar">
      <div><b>Check-in radius</b> <span class="small muted">· how close a player has to be for a "yes". Now: ${now}.</span></div>
      <div class="row" style="gap:.4em;margin-top:.4em">
        <span class="small">Set</span>
        <select id="radWho" style="width:auto"><option value="">all ${photos.length} photos</option>${[1, 2, 3].map((d) => `<option value="${d}">${DIFF[d]} photos (${photos.filter((p) => p.difficulty === d).length})</option>`).join('')}</select>
        <span class="small">to</span>
        <span class="unit" style="width:84px"><input id="radVal" type="number" min="5" max="500" value="${common[0][0]}"><i>m</i></span>
        <span class="small muted" id="radFt">≈ ${ft(common[0][0])} ft</span>
        ${[25, 40, 60, 100].map((r) => `<button class="btn-small rad-pre" data-rad="${r}">${r} m</button>`).join('')}
        <button class="btn-small btn-primary" id="radApply">Apply</button>
      </div>
      <p class="small muted" style="margin:.3em 0 0">Photos already sent get re-checked with the new radius. The judge's own yes/no calls stay. Change one photo in its row below, or on the Map tab.</p>
    </div>`;
  }
  function bindRadiusBar() {
    const val = $('#radVal'); if (!val) return;
    val.oninput = () => { $('#radFt').textContent = `≈ ${ft(Number(val.value) || 0)} ft`; };
    document.querySelectorAll('[data-rad]').forEach((b) => b.onclick = () => { val.value = b.dataset.rad; val.oninput(); });
    $('#radApply').onclick = async () => {
      const r = Math.round(Number(val.value)), d = $('#radWho').value;
      if (!(r >= 5 && r <= 500)) { alert('Pick a radius between 5 and 500 meters.'); return; }
      const which = d ? `all ${DIFF[d]} photos` : 'every photo';
      if (!confirm(`Set the check-in radius of ${which} to ${r} m (about ${ft(r)} ft)?\n\nPhotos already sent will be re-checked. The judge's own calls stay.`)) return;
      $('#radApply').disabled = true;
      try {
        const res = await api('/photos', 'PATCH', { radius_m: r, difficulty: d ? Number(d) : null });
        await refresh(); renderSetup();
        $('#upProg').innerHTML = `<b>Radius set to ${r} m on ${res.photos} photo${res.photos === 1 ? '' : 's'}.</b>${res.rechecked ? ` Re-checked ${res.rechecked} answer${res.rechecked === 1 ? '' : 's'} already sent.` : ''}`;
      } finally { const b = $('#radApply'); if (b) b.disabled = false; }
    };
  }

  function bindRows() {
    bindRadiusBar();
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

  // ---------- photo upload: JPEG, PNG and iPhone HEIC, with the location read from the photo ----------
  const isHeicName = (f) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type);
  const isImage = (f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name);

  // Chrome and Firefox can't open HEIC, so load a decoder (about 3 MB) the first time one shows up.
  let heicLoading;
  function loadHeic() {
    if (window.HeicTo) return Promise.resolve();
    heicLoading ||= new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = '/vendor/heic-to.js';
      sc.onload = res; sc.onerror = () => { heicLoading = null; rej(new Error('Could not load the HEIC converter. Check your connection.')); };
      document.head.appendChild(sc);
    });
    return heicLoading;
  }

  // Open a photo as something we can draw: the browser's own decoder first (all browsers for JPEG/PNG,
  // Safari for HEIC too), then the HEIC decoder for Chrome and Firefox.
  async function decodePhoto(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* try the other ways */ }
    if (isHeicName(file) || await sniffHeic(file)) {
      await loadHeic();
      return HeicTo({ blob: file, type: 'bitmap' });
    }
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("this browser can't open it")); i.src = URL.createObjectURL(file); });
  }
  // HEIC files say "ftypheic" (or similar) near the start, even if the name or type is wrong.
  async function sniffHeic(file) {
    try { const b = new TextDecoder().decode(await file.slice(4, 12).arrayBuffer()); return /^ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(b); } catch { return false; }
  }

  function toJpeg(src, max, quality) {
    const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // PNGs with see-through parts
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not shrink the photo.'))), 'image/jpeg', quality));
  }

  // The photo's saved location, if any. Works for JPEG and HEIC.
  async function readGps(file) {
    try {
      const g = await exifr.gps(file);
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) && !(g.latitude === 0 && g.longitude === 0)) return g;
    } catch { /* no location saved */ }
    return null;
  }

  function insideArea(lat, lng, poly) {
    if (!poly || poly.length < 3) return true;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  async function upload(all) {
    if (A.uploading) return;
    const files = all.filter(isImage);
    const skipped = all.length - files.length; // videos (Live Photo .mov files), documents
    if (!files.length) { $('#upProg').innerHTML = `<span class="error">No photos found${skipped ? ` (skipped ${skipped} file${skipped > 1 ? 's' : ''} that aren't photos)` : ''}.</span>`; return; }
    A.uploading = true;
    const prog = () => $('#upProg');
    const r = { ok: 0, pinned: 0, outside: 0, noLoc: [], failed: [] };
    try {
      for (const [i, file] of files.entries()) {
        const label = `${i + 1} of ${files.length}`;
        prog().textContent = `${isHeicName(file) ? 'Converting iPhone photo' : 'Preparing photo'} ${label}…`;
        let src;
        try {
          const gps = await readGps(file);
          src = await decodePhoto(file);
          const image = await toJpeg(src, 1600, 0.82);
          const thumb = await toJpeg(src, 420, 0.6);
          prog().textContent = `Uploading photo ${label}…`;
          const fd = new FormData();
          fd.append('image', image, 'image.jpg'); fd.append('thumb', thumb, 'thumb.jpg');
          // Name the photo after the file only if it has a real name (not IMG_1234).
          const base = file.name.replace(/\.[^.]+$/, '');
          if (base && !/^(img|dsc|pxl|photo|image)[-_ ]?\d+/i.test(base) && !/^[0-9a-f-]{20,}$/i.test(base)) fd.append('title', base.slice(0, 80));
          if (gps) {
            fd.append('lat', gps.latitude); fd.append('lng', gps.longitude); r.pinned++;
            if (!insideArea(gps.latitude, gps.longitude, A.d.game.boundary)) r.outside++;
          } else r.noLoc.push(file.name);
          await api('/photos', 'POST', fd);
          r.ok++;
        } catch (e) {
          console.error(file.name, e);
          r.failed.push(`${file.name}${e?.message && e.message !== 'auth' ? ` (${e.message})` : ''}`);
        } finally {
          if (src && src.close) src.close(); // free memory between big photos
        }
      }
    } finally { A.uploading = false; }
    await refresh();
    renderSetup();
    const list = (a) => esc(a.slice(0, 5).join(', ') + (a.length > 5 ? ` and ${a.length - 5} more` : ''));
    prog().innerHTML = `<b>Uploaded ${r.ok} photo${r.ok === 1 ? '' : 's'}.</b> ${r.pinned} pinned automatically from the location saved in the photo.`
      + (r.noLoc.length ? `<br><span class="error">${r.noLoc.length} had no location</span> (${list(r.noLoc)}). Place ${r.noLoc.length > 1 ? 'their pins' : 'its pin'} on the Map tab, or see "How to keep the locations".` : '')
      + (r.outside ? `<br>${r.outside} ${r.outside > 1 ? 'are' : 'is'} outside the play area. Check ${r.outside > 1 ? 'them' : 'it'} on the Map tab.` : '')
      + (r.failed.length ? `<br><span class="error">${r.failed.length} failed:</span> ${list(r.failed)}. Try again, or export ${r.failed.length > 1 ? 'them' : 'it'} as JPEG.` : '')
      + (skipped ? `<br><span class="muted">Skipped ${skipped} file${skipped > 1 ? 's' : ''} that ${skipped > 1 ? "aren't photos" : "isn't a photo"} (like Live Photo videos).</span>` : '');
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
    // The selected photo's circle always shows, so you can see the radius you're setting.
    const sel = A.d.photos.find((p) => p.id === A.sel && p.lat != null);
    if (sel) A.selRing = L.circle([sel.lat, sel.lng], { radius: sel.radius_m, color: '#e8590c', weight: 3, fillOpacity: 0.15, interactive: false }).addTo(A.ringLayer);
    if (m.getZoom() < 17) return;
    A.d.photos.forEach((p) => { if (p.lat != null && visible(p) && p !== sel) L.circle([p.lat, p.lng], { radius: p.radius_m, color: DIFF_COLOR[p.difficulty], weight: 1, fillOpacity: 0.1, interactive: false }).addTo(A.ringLayer); });
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
    if (p && p.lat != null) {
      hint(`<b>#${i + 1}</b> ${esc(p.title || '')} <span class="hint-rad">Radius <input type="range" id="selRad" min="5" max="200" step="5" value="${Math.min(200, p.radius_m)}"> <b id="selRadTxt">${p.radius_m} m · ${ft(p.radius_m)} ft</b></span> <span style="opacity:.7">drag the pin to move it</span>`);
      const sl = $('#selRad');
      sl.oninput = () => { const r = Number(sl.value); $('#selRadTxt').textContent = `${r} m · ${ft(r)} ft`; A.selRing?.setRadius(r); };
      sl.onchange = async () => {
        const res = await api('/photos/' + pid, 'PATCH', { radius_m: Number(sl.value) });
        await refresh(); drawRings();
        if (res.rechecked) $('#selRadTxt').textContent += ` · re-checked ${res.rechecked} answer${res.rechecked === 1 ? '' : 's'}`;
      };
    }
    drawRings();
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
              <div style="width:130px;text-align:center"><div class="qr">${qrSvg(playerUrl)}</div><button class="btn-small" id="tvBtn" style="margin-top:.4em;width:100%">Big join code</button><a class="btn btn-small" href="/tv" target="_blank" style="margin-top:.3em;width:100%">📺 Live TV view</a></div>
            </div></div>
            <div class="card"><h2>Judge queue <span class="count" id="jCount">0</span></h2><p class="small muted" style="margin:-.2em 0 .6em">Players never see yes or no until you reveal the results.</p><div id="judge"></div><div id="farList"></div></div>
            <div class="card"><h2>Every photo sent <span class="count" id="fCount"></span></h2><p class="small muted" style="margin:-.2em 0 .5em">Change any call at any time with Yes, No, or Reset (back to what the GPS said).</p>
              <div class="filters" id="fFilters" style="margin:0 0 .5em"></div><div id="manual"></div><div class="feed" id="feed"></div></div>
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

    const waiting = finds.filter((f) => f.status === 'pending').length;
    if (changed('controls', game.status + '|' + game.ends_at + '|' + game.revealed_at + '|' + waiting)) {
      $('#controls').innerHTML = game.status === 'setup' ? `
        <h2>Ready to start?</h2>
        <p class="small muted" style="margin:0"><span id="joinedLine"></span> Scan the code to join.</p>
        <div><label for="mins" class="small">Game length in minutes (optional)</label><input id="mins" type="number" min="5" placeholder="No timer"></div>
        <button class="btn-ok btn-big" id="startBtn">▶ Start the game</button>`
        : game.status === 'live' ? `
        <h2>The game is live</h2>
        <p class="small muted" style="margin:0">${game.ends_at ? `Ends at ${new Date(game.ends_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'No timer. End it when everyone is back.'}</p>
        <button class="btn-big btn-bad" id="endBtn">■ End the game</button>`
        : !game.revealed_at ? `
        <h2>The game is over</h2>
        <p class="small muted" style="margin:0">Players can't see the results yet.${waiting ? ` <b class="error">${waiting} still waiting for the judge</b>, and they won't count unless approved.` : ''} Photos taken before the end can still arrive for 30 minutes.</p>
        <button class="btn-ok btn-big" id="revealBtn">🎉 Reveal the results</button>
        <div class="row"><button class="btn-small" id="reopenBtn">Reopen the game</button><button class="btn-small btn-bad" id="resetBtn">↺ Reset the game</button></div>`
        : `<h2>Results revealed</h2>
        <p class="small muted" style="margin:0">Everyone can see the scores and what counted, on their phones and the TV.</p>
        <button class="btn-big btn-bad" id="resetBtn">↺ Reset and play again</button>
        <div class="row"><button class="btn-small" id="hideBtn">Hide the results again</button><button class="btn-small" id="reopenBtn">Reopen the game</button></div>`;
      const act = (btn, body, ask, after) => btn && (btn.onclick = async () => {
        if (ask && !confirm(ask)) return;
        btn.disabled = true;
        try { await api('/game', 'PATCH', body()); await refresh(); } finally { btn.disabled = false; }
        after ? after() : render();
      });
      act($('#startBtn'), () => ({ action: 'start', minutes: Number($('#mins').value) || null }), 'Start the game now?');
      act($('#endBtn'), () => ({ action: 'end' }), 'End the game for everyone? Results stay hidden until you press Reveal.');
      act($('#reopenBtn'), () => ({ action: 'reopen' }), 'Reopen the game? Results will be hidden again.');
      act($('#revealBtn'), () => ({ action: 'reveal' }), waiting ? `${waiting} answer${waiting > 1 ? 's are' : ' is'} still waiting for the judge and won't count. Reveal anyway?` : 'Reveal the results to everyone now?');
      act($('#hideBtn'), () => ({ action: 'hide' }));
      act($('#resetBtn'), () => ({ action: 'reset' }), 'Reset the game?\n\nThis deletes every photo sent, all scores and all trails. Players, teams and the hunt photos stay, so everyone can play again without rejoining. This can\'t be undone.\n\n(Tip: download the results CSV first if you want to keep them.)');
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
        <p class="small" style="margin:.2em 0 .5em"><span class="swatch" style="background:${esc(t?.color)}"></span> <b>${esc(pl?.name || '?')}</b> (${esc(t?.name)}) · ${Math.round(f.distance_m)} m from the spot · GPS ±${Math.round(f.accuracy_m || 0)} m</p>
        <div class="row"><button class="btn-ok grow" data-judge="${f.id}" data-s="approved">✓ Approve</button><button class="btn-bad grow" data-judge="${f.id}" data-s="rejected">✕ Reject</button></div></div>`;
    }).join('') : '<p class="muted small" style="margin:0">Nothing to judge right now.</p>';
    // Answers taken far from the spot are marked "no" automatically. The judge can still approve one.
    const far = finds.filter((f) => f.status === 'far');
    const farOpen = !!$('#farList details')?.open; // keep it open when a new one arrives
    if (changed('far', far.map((f) => f.id).join())) $('#farList').innerHTML = far.length ? `<details style="margin-top:.8em" ${farOpen ? 'open' : ''}><summary class="small" style="cursor:pointer"><b>Marked no, too far away (${far.length})</b> <span class="muted">· check these if GPS was bad</span></summary>${far.map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      return `<div class="judge-item"><div class="judge-pics"><figure><img src="/img/${esc(p?.thumb_key)}" loading="lazy"><figcaption>#${numOf(f.photo_id)} · the photo</figcaption></figure>
        <figure>${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}" loading="lazy"></a>` : '<div class="nopic">No picture</div>'}<figcaption>their picture</figcaption></figure></div>
        <p class="small" style="margin:.2em 0 .5em"><span class="swatch" style="background:${esc(t?.color)}"></span> <b>${esc(pl?.name || '?')}</b> (${esc(t?.name)}) · ${Math.round(f.distance_m)} m from the spot · GPS ±${Math.round(f.accuracy_m || 0)} m</p>
        <button class="btn-ok btn-small" data-judge="${f.id}" data-s="approved">✓ Approve anyway</button></div>`;
    }).join('')}</details>` : '';
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

    // Every photo sent, newest first. The judge can say yes/no or reset any of them at any time.
    const FILTERS = { all: 'All', wait: 'Waiting for judge', yes: 'Counted', no: "Didn't count" };
    const match = (k, f) => k === 'wait' ? f.status === 'pending' : k === 'yes' ? ['auto', 'approved'].includes(f.status) : k === 'no' ? ['far', 'rejected'].includes(f.status) : true;
    const inF = (f) => match(A.ff, f);
    A.ff ||= 'all';
    $('#fCount').textContent = finds.length;
    if (changed('ffilters', A.ff + finds.map((f) => f.status).join())) {
      $('#fFilters').innerHTML = Object.entries(FILTERS).map(([k, v]) => `<button data-ff="${k}" class="${A.ff === k ? 'on' : ''}">${v} · ${finds.filter((f) => match(k, f)).length}</button>`).join('');
      document.querySelectorAll('[data-ff]').forEach((b) => b.onclick = () => { A.ff = b.dataset.ff; A.sig.feed = null; A.sig.ffilters = null; render(); });
    }
    if (changed('feed', A.ff + finds.map((f) => f.id + f.status).join() + Math.floor(A.d.now / 60000))) {
      const list = finds.filter(inF);
      $('#feed').innerHTML = list.length ? list.slice(0, 80).map((f) => {
        const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
        const label = { auto: 'Yes · right spot', approved: 'Yes · judge', pending: 'Waiting for judge', far: 'No · too far', rejected: 'No · judge' }[f.status] || f.status;
        const yes = f.status === 'auto' || f.status === 'approved', no = f.status === 'far' || f.status === 'rejected';
        const canReset = f.distance_m != null && (f.status === 'approved' || f.status === 'rejected');
        return `<div class="feed-item judge-row">
          <a href="/img/${esc(p?.image_key)}" target="_blank" title="The photo"><img src="/img/${esc(p?.thumb_key)}" alt="" loading="lazy"></a>
          ${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank" title="Their picture"><img src="/img/${esc(f.proof_key)}" alt="" loading="lazy"></a>` : '<span class="nopic-sm">No pic</span>'}
          <div class="grow small"><b>${esc(pl?.name || 'Judge')}</b> <span class="swatch" style="background:${esc(t?.color)}"></span> ${esc(t?.name)} · #${numOf(f.photo_id)} <span class="muted">(${DIFF[p?.difficulty] || ''})</span><br>
            <span class="tag ${f.status}">${label}</span> <span class="muted">${f.distance_m != null ? Math.round(f.distance_m * 3.28) + ' ft away · ' : ''}${ago(f.created_at)}</span></div>
          <div class="jbtns">
            <button class="btn-small ${yes ? 'on-yes' : ''}" data-flip="${f.id}" data-s="approved" ${yes ? 'disabled' : ''}>✓ Yes</button>
            <button class="btn-small ${no ? 'on-no' : ''}" data-flip="${f.id}" data-s="rejected" ${no ? 'disabled' : ''}>✕ No</button>
            ${canReset ? `<button class="btn-small" data-flip="${f.id}" data-s="reset" title="Back to what the GPS said">↺ Reset</button>` : ''}
          </div>
          <button class="x-btn" data-fdel="${f.id}" title="Delete this photo">🗑</button></div>`;
      }).join('') : `<p class="muted small" style="margin:0">${finds.length ? 'None here.' : 'No photos sent yet.'}</p>`;
      document.querySelectorAll('[data-flip]').forEach((b) => b.onclick = async () => {
        b.closest('.feed-item').querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try { await api('/finds/' + b.dataset.flip, 'PATCH', { status: b.dataset.s }); } finally { await refresh(); render(); }
      });
      document.querySelectorAll('[data-fdel]').forEach((b) => b.onclick = async () => { if (!confirm('Delete this photo? The team can send it again.')) return; await api('/finds/' + b.dataset.fdel, 'DELETE'); await refresh(); render(); });
    }

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
    const proofs = finds.filter((f) => f.proof_key && (f.status === 'auto' || f.status === 'approved'));
    const g = A.d.game;
    $('#body').innerHTML = `
      ${!g.revealed_at ? `<div class="note" style="margin-bottom:1em">🤫 <b>Players can't see these results yet.</b> ${g.status === 'ended' ? 'When the judge queue is clear, go to Live game and press <b>Reveal the results</b>.' : 'End the game first, then reveal them from the Live game tab.'}</div>` : ''}
      ${winner ? `<div class="winner" style="background:${esc(winner.color)}"><h1>🏆 ${esc(winner.name)} ${g.revealed_at ? 'wins!' : 'is in the lead'}</h1><p style="margin:0">${winner.score} points · ${winner.found} photos found</p></div>` : ''}
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
