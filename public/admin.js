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
  const TABS = { setup: 'Setup', map: 'Map', live: 'Live', results: 'Results' };
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
        <h1>Photo Hunt admin</h1>
        <form id="lf" class="stack"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required autofocus>
        <button class="btn-primary btn-big">Sign in</button></form>
        <p class="error">${esc(err || '')}</p>
      </div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { login(data.error || 'Wrong password.'); return; }
        A.pw = data.token; localStorage.setItem('adminPw', data.token); boot();
      } catch { login("Can't reach the game. Check your connection."); }
    };
  }

  // ---------- invite link: set your own admin password ----------
  async function acceptInvite(token) {
    let info = {};
    try { info = await fetch('/api/auth/invite?t=' + encodeURIComponent(token)).then((r) => r.json()); } catch { /* shown below */ }
    const done = () => { history.replaceState(null, '', location.pathname); }; // drop the token from the address bar
    if (!info.ok) {
      $('#app').innerHTML = `<div class="login card stack"><h1>Photo Hunt admin</h1>
        <p class="note">This link has expired or was already used. Ask for a new one.</p>
        <button class="btn-big" id="toLogin">I already have a password</button></div>`;
      $('#toLogin').onclick = () => { done(); A.pw ? boot().catch(() => {}) : login(); };
      return;
    }
    $('#app').innerHTML = `
      <div class="login card stack">
        <h1>Welcome, ${esc(info.name)}!</h1>
        <p class="muted" style="margin:0">Create a password to help run the Photo Hunt. It works on any phone or computer.</p>
        <form id="af" class="stack">
          <input type="text" name="username" autocomplete="username" value="${esc(info.name)}" hidden>
          <div><label for="np">New password</label><input id="np" type="password" autocomplete="new-password" minlength="8" required autofocus></div>
          <div><label for="np2">Type it again</label><input id="np2" type="password" autocomplete="new-password" minlength="8" required></div>
          <label class="check-row"><input type="checkbox" id="showPw"> Show password</label>
          <button class="btn-primary btn-big">Create password and sign in</button>
          <p class="error" id="afErr"></p>
        </form>
      </div>`;
    $('#showPw').onchange = (e) => { $('#np').type = $('#np2').type = e.target.checked ? 'text' : 'password'; };
    $('#af').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('#np').value;
      if (pw.length < 8) { $('#afErr').textContent = 'Use at least 8 characters.'; return; }
      if (pw !== $('#np2').value) { $('#afErr').textContent = "The two passwords don't match."; return; }
      const btn = e.target.querySelector('button.btn-primary'); btn.disabled = true;
      try {
        const res = await fetch('/api/auth/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: pw }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { $('#afErr').textContent = data.error || 'Something went wrong.'; btn.disabled = false; return; }
        A.pw = data.token; localStorage.setItem('adminPw', data.token); done(); boot();
      } catch { $('#afErr').textContent = "Can't reach the game. Check your connection."; btn.disabled = false; }
    };
  }

  // ---------- other admins ----------
  async function renderAdmins() {
    const box = $('#adminsCard'); if (!box) return;
    let d;
    try { d = await api('/admins'); } catch { return; }
    const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const sum = $('#adminsSum'); if (sum) sum.textContent = `Signed in as ${d.me.name}${d.admins.length ? ` · ${d.admins.length} admin${d.admins.length === 1 ? '' : 's'}` : ''}${d.invites.length ? ` · ${d.invites.length} invite${d.invites.length === 1 ? '' : 's'} open` : ''}`;
    box.innerHTML = `
      ${d.admins.map((a) => `<div class="line-row"><span class="grow"><b>${esc(a.name)}</b> <span class="small muted">added ${day(a.created_at)}</span></span><button class="btn-small btn-ghost btn-danger" data-adel="${esc(a.id)}">Remove</button></div>`).join('')}
      ${d.invites.map((i) => `<div class="line-row"><span class="grow">${esc(i.name)} <span class="small muted">invite open until ${day(i.expires_at)}</span></span><button class="btn-small" data-idel="${esc(i.id)}">Cancel link</button></div>`).join('')}
      <form id="invForm"><label for="invName">Invite a helper with their own password</label><div class="field-row"><input id="invName" class="grow" placeholder="Their name, e.g. Dad" maxlength="30"><button class="btn-primary">Create invite link</button></div></form>
      <div id="invOut"></div>
      <button class="btn-small btn-ghost" id="signOut">Sign out of this browser</button>`;
    box.querySelectorAll('[data-adel]').forEach((b) => b.onclick = async () => {
      const a = d.admins.find((x) => x.id === b.dataset.adel);
      if (!confirm(`Remove ${a.name} as an admin? They'll be signed out everywhere.`)) return;
      await api('/admins/' + encodeURIComponent(a.id), 'DELETE'); renderAdmins();
    });
    box.querySelectorAll('[data-idel]').forEach((b) => b.onclick = async () => { await api('/admins/invites/' + encodeURIComponent(b.dataset.idel), 'DELETE'); renderAdmins(); });
    $('#invForm').onsubmit = async (e) => {
      e.preventDefault();
      const name = $('#invName').value.trim(); if (!name) { $('#invName').focus(); return; }
      const r = await api('/admins/invite', 'POST', { name });
      const link = `${location.origin}/admin#invite=${r.token}`;
      await renderAdmins();
      $('#invOut').innerHTML = `<div class="note good stack">
        <div><b>Send this link to ${esc(r.name)}.</b> It works once and expires in 7 days.</div>
        <input id="invLink" readonly value="${esc(link)}">
        <div class="row"><button class="btn-small btn-primary" id="copyInv">Copy link</button>${navigator.share ? '<button class="btn-small" id="shareInv">Share…</button>' : ''}</div></div>`;
      $('#invLink').onclick = (ev) => ev.target.select();
      $('#copyInv').onclick = async () => {
        try { await navigator.clipboard.writeText(link); } catch { $('#invLink').select(); document.execCommand('copy'); }
        $('#copyInv').textContent = 'Copied!';
      };
      const sh = $('#shareInv'); if (sh) sh.onclick = () => navigator.share({ title: 'Photo Hunt admin', text: `Set your Photo Hunt admin password:`, url: link }).catch(() => {});
    };
    $('#signOut').onclick = async () => {
      if (!confirm('Sign out of the admin page on this browser?')) return;
      try { await api('/logout', 'POST'); } catch { /* signing out anyway */ }
      localStorage.removeItem('adminPw'); A.pw = null; login();
    };
  }


  // ---------- shell ----------
  // The top bar: game name, status as plain text, and the one main action for this phase.
  // The tabs sit under it on a computer and along the bottom of the screen on a phone.
  async function boot() {
    $('#app').innerHTML = `
      <header class="a-top" id="aTop">
        <div class="a-id"><div class="a-name" id="aName"></div><div class="a-state" id="status"></div></div>
        <div class="a-act" id="aAct"></div>
        <nav class="a-tabs" id="aTabs">${Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}"><span>${v}</span><span class="badge hidden" id="badge-${k}"></span></button>`).join('')}</nav>
      </header>
      <main class="wrap" id="body"></main>`;
    document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
    A.sig = {}; A.topSig = null;
    // Keep the page's top offset in step with the header height (it changes with long game names).
    if (window.ResizeObserver) new ResizeObserver(() => document.body.style.setProperty('--top-h', $('#aTop').offsetHeight + 'px')).observe($('#aTop'));
    await refresh();
    show(['live', 'starting', 'ended'].includes(A.d?.game?.status) ? 'live' : 'setup');
    // One refresh loop for the whole page; it pauses while signed out.
    // Live and Results redraw every 3 seconds (the judge sees photos as they arrive). The other tabs only
    // update the top bar and tab badges, less often, and never redraw what's being edited.
    if (!A.timer) A.timer = setInterval(() => {
      if (!A.pw || !A.d?.game || document.hidden) return;
      A.ticks = (A.ticks || 0) + 1;
      if (A.tab === 'live' || A.tab === 'results') refresh().then(() => render()).catch(() => {});
      else if (A.ticks % 4 === 0) refresh().catch(() => {});
    }, 3000);
    if (!A.clock) A.clock = setInterval(tickClock, 1000);
  }

  async function refresh() { A.d = await api('/state'); A.skew = (A.d.now || Date.now()) - Date.now(); renderStatus(); }

  const PHASE_TEXT = { setup: 'Setting up', starting: 'Starting…', live: 'Live', ended: 'Ended' };
  function timeLeft() {
    const g = A.d?.game; if (!g || g.status !== 'live' || !g.ends_at) return '';
    const ms = g.ends_at - (Date.now() + (A.skew || 0));
    if (ms <= 0) return "time's up";
    const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
    return m >= 10 ? `${m} min left` : `${m}:${String(sec).padStart(2, '0')} left`;
  }
  function tickClock() {
    const el = $('#aTime'); if (el) el.textContent = timeLeft();
  }

  function renderStatus() {
    const g = A.d?.game;
    if (!$('#aName')) return;
    const waiting = (A.d?.finds || []).filter((f) => f.status === 'pending').length;
    const noPin = (A.d?.photos || []).filter((p) => p.lat == null).length;
    $('#aName').textContent = g ? g.name : 'Photo Hunt';
    const state = !g ? '' : g.status === 'ended' && g.revealed_at ? 'Results shown'
      : g.status === 'live' ? `Live · <span id="aTime">${g.ends_at ? timeLeft() : 'no timer'}</span>` : PHASE_TEXT[g.status];
    if ($('#status').innerHTML !== state) $('#status').innerHTML = state;
    // Tab badges: photos waiting for the judge, photos without a pin.
    const badge = (k, n, title) => { const b = $('#badge-' + k); if (!b) return; b.textContent = n || ''; b.title = title || ''; b.classList.toggle('hidden', !n); };
    badge('live', waiting, `${waiting} waiting for the judge`);
    badge('map', noPin, `${noPin} photo${noPin === 1 ? '' : 's'} need a pin`);
    // The one main action. Only redrawn when it changes, so it never jumps under a finger.
    const act = !g ? null : g.status === 'setup' ? ['start', 'btn-ok', '▶ Start']
      : g.status === 'starting' ? ['end', 'btn-bad', '■ Stop']
      : g.status === 'live' ? ['end', 'btn-bad', '■ End game']
      : !g.revealed_at ? ['reveal', 'btn-ok', 'Reveal results']
      : A.tab !== 'results' ? ['results', 'btn-primary', 'See results'] : null;
    const sig = JSON.stringify(act);
    if (sig === A.topSig) return;
    A.topSig = sig;
    $('#aAct').innerHTML = act ? `<button class="${act[1]}" id="topAct">${act[2]}</button>` : '';
    if (act) $('#topAct').onclick = (e) => topAction(act[0], e.currentTarget);
  }

  // The top-bar button does exactly what the same button on the Live tab does, with the same questions.
  async function topAction(kind, btn) {
    const g = A.d.game;
    const waiting = A.d.finds.filter((f) => f.status === 'pending').length;
    if (kind === 'results') return show('results');
    if (kind === 'start') { // Starting needs the game length, so go to the Start card on the Live tab.
      if (A.tab !== 'live') show('live');
      const card = $('#controls')?.closest('.sec');
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
      return;
    }
    const body = kind === 'end' ? { action: 'end' } : { action: 'reveal' };
    const ask = kind === 'end' ? 'End the game for everyone? Results stay hidden until you press Reveal.'
      : waiting ? `${waiting} answer${waiting > 1 ? 's are' : ' is'} still waiting for the judge and won't count. Reveal anyway?` : 'Reveal the results to everyone now?';
    if (!confirm(ask)) return;
    btn.disabled = true;
    try { await api('/game', 'PATCH', body); await refresh(); } finally { btn.disabled = false; }
    render();
  }

  // The big viewer. A photo on its own just shows large. A team's answer shows the photo next to their
  // picture, and (when the phone sent its location) a Map view of the spot and where they took it.
  // The judge can flip between Photos and Map as often as they like, then say yes or no from either.
  const whereBtn = (f) => f.lat != null ? `<button class="btn-small" data-where="${f.id}">📍 View locations</button>` : '';
  const ftOf = (m) => Math.round(m * 3.28).toLocaleString();
  function closeViewer() {
    if (A.viewMap) { A.viewMap.remove(); A.viewMap = null; }
    document.querySelectorAll('.lightbox').forEach((x) => x.remove());
  }
  function openPhoto(src, cap) {
    closeViewer();
    const o = document.createElement('div');
    o.className = 'lightbox';
    o.innerHTML = `<div class="lb-pics"><figure><img src="${esc(src)}" alt=""><figcaption>${esc(cap || '')}</figcaption></figure></div>
      <div class="lb-btns"><button data-lbclose>Close</button></div>`;
    o.onclick = (ev) => { if (ev.target.closest('[data-lbclose]') || ev.target.tagName === 'IMG' || ev.target === o) closeViewer(); };
    document.body.appendChild(o);
  }
  function openFind(fid, mode) {
    const f = A.d.finds.find((x) => x.id === fid);
    if (!f) return;
    closeViewer();
    const p = A.d.photos.find((x) => x.id === f.photo_id), t = A.d.teams.find((x) => x.id === f.team_id), pl = A.d.players.find((x) => x.id === f.player_id);
    const hasMap = f.lat != null;
    const yes = f.status === 'auto' || f.status === 'approved', no = f.status === 'far' || f.status === 'rejected';
    const state = { auto: 'Counts (right spot)', approved: 'Counts (judge)', pending: 'Waiting for the judge', far: "Doesn't count (too far)", rejected: "Doesn't count (judge)" }[f.status] || '';
    const o = document.createElement('div');
    o.className = 'lightbox viewer';
    o.innerHTML = `<div class="lb-info"><b>${esc(pl?.name || 'Judge')}</b> (${esc(t?.name || '')}) · #${A.d.photos.indexOf(p) + 1} · ${state}<br>
        <span class="small">${f.distance_m != null ? `${ftOf(f.distance_m)} ft from the spot` : 'Added by the judge'}${f.accuracy_m ? ` · phone GPS ±${ftOf(f.accuracy_m)} ft` : ''}</span></div>
      ${hasMap ? '<div class="seg lb-seg"><button data-mode="photos">Photos</button><button data-mode="map">Map</button></div>' : ''}
      <div class="lb-pics"><figure><img src="/img/${esc(p?.image_key)}" alt=""><figcaption>The photo</figcaption></figure>
        <figure>${f.proof_key ? `<img src="/img/${esc(f.proof_key)}" alt="">` : '<div class="nopic">No picture</div>'}<figcaption>Their picture</figcaption></figure></div>
      ${hasMap ? `<div class="lb-mapwrap"><div class="loc-map"></div>
        <div class="loc-key small"><span><i class="k-spot"></i>The spot (check-in circle)</span><span><i class="k-them" style="background:${esc(t?.color || '#333')}"></i>Where they took it</span></div></div>` : ''}
      <div class="lb-btns">
        <button class="btn-ok" data-v="approved" ${yes ? 'disabled' : ''}>✓ ${yes ? 'Counts' : f.status === 'far' ? 'Approve anyway' : 'Approve'}</button>
        <button class="btn-bad" data-v="rejected" ${no ? 'disabled' : ''}>✕ ${no ? "Doesn't count" : 'Reject'}</button>
        <button data-lbclose>Close</button></div>`;
    document.body.appendChild(o);
    const setMode = (m) => {
      A.viewMode = m;
      o.dataset.show = m;
      o.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      if (m === 'map') drawViewMap(o, f, p, t); // drawn the first time it's shown, so it gets the right size
    };
    setMode(hasMap && mode === 'map' ? 'map' : 'photos');
    o.onclick = async (ev) => {
      const mb = ev.target.closest('[data-mode]');
      if (mb) { setMode(mb.dataset.mode); return; }
      const v = ev.target.closest('[data-v]');
      if (v) {
        o.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try { await api('/finds/' + f.id, 'PATCH', { status: v.dataset.v }); } finally { closeViewer(); await refresh(); render(); }
        return;
      }
      if (ev.target.closest('[data-lbclose]')) closeViewer();
    };
  }
  function drawViewMap(o, f, p, t) {
    if (A.viewMap) { A.viewMap.invalidateSize(); return; }
    const m = A.viewMap = L.map(o.querySelector('.loc-map'), { zoomControl: true });
    addBaseMap(m);
    const them = [f.lat, f.lng], pts = [them], color = t?.color || '#333';
    if (f.accuracy_m) L.circle(them, { radius: f.accuracy_m, color, weight: 1, dashArray: '4 4', fillOpacity: 0.08 }).addTo(m);
    L.circleMarker(them, { radius: 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }).addTo(m).bindTooltip('Where they took it', { permanent: true, direction: 'top', offset: [0, -8] });
    if (p?.lat != null) {
      const spot = [p.lat, p.lng]; pts.push(spot);
      L.circle(spot, { radius: p.radius_m || 40, color: '#1a73e8', weight: 2, fillOpacity: 0.12 }).addTo(m);
      L.circleMarker(spot, { radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(m).bindTooltip('The spot', { permanent: true, direction: 'bottom', offset: [0, 8] });
      L.polyline([spot, them], { color: '#333', weight: 2, dashArray: '6 6' }).addTo(m);
    }
    if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 19 }); else m.setView(them, 18);
  }
  // Any picture opens big: a team's answer opens the judge viewer, any other photo opens on its own.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.lightbox')) return;
    const w = e.target.closest('[data-where]');
    if (w) { e.preventDefault(); openFind(w.dataset.where, 'map'); return; }
    const big = e.target.closest('img[data-big]');
    if (big) { e.preventDefault(); e.stopPropagation(); openPhoto(big.dataset.big, big.dataset.cap); return; }
    const a = e.target.closest('a[href^="/img/"]');
    if (!a) return;
    e.preventDefault();
    const fid = a.closest('[data-fid]')?.dataset.fid;
    if (fid) openFind(fid, A.viewMode); else openPhoto(a.getAttribute('href'));
  }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });

  function show(tab) {
    closeViewer();
    A.tab = tab; A.placing = null; A.drawing = null;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    document.body.dataset.tab = tab;
    Object.values(A.maps).forEach((m) => m.remove()); A.maps = {};
    $('#body').innerHTML = '';
    scrollTo(0, 0);
    renderStatus(); // "See results" hides on the Results tab
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
    $('#body').innerHTML = `<div class="card stack narrow">
      <h1>Create your game</h1><div><label for="gn">Game name</label><input id="gn" value="Thanksgiving Photo Hunt"></div>
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
          <section class="card stack sec">
            <h2>Game</h2>
            <div><label for="gname">Name</label><input id="gname" value="${esc(game.name)}"></div>
            <p class="small muted">Players join at <a href="${esc(playerUrl)}" target="_blank"><b>${esc(playerUrl)}</b></a></p>
            <details class="mini"><summary>Start over with a fresh game</summary>
              <p class="small">Same photos and play area. Players, finds and scores are cleared.</p>
              <button class="btn-small btn-bad" id="fresh">Create fresh game</button></details>
          </section>
          <section class="card sec">
            <h2>Teams <span class="count">${teams.length}</span></h2>
            ${teams.map((t) => {
              const ms = players.filter((p) => p.team_id === t.id);
              return `<div class="team-row"><input type="color" value="${esc(t.color)}" data-tcolor="${t.id}" aria-label="Team color"><input class="grow" value="${esc(t.name)}" data-tname="${t.id}" aria-label="Team name"><button class="btn-small btn-ghost x-btn" data-tdel="${t.id}" title="Remove team" aria-label="Remove team">✕</button></div>
                ${ms.length ? `<p class="small muted team-ms">${ms.map((p) => esc(p.name)).join(', ')}</p>` : ''}`;
            }).join('')}
            <button class="btn-small" id="addTeam">+ Add team</button>
          </section>
          <details class="card sec fold" id="setsSec"><summary><h2>Photo sets</h2><span class="sum" id="setsSum"></span></summary><div id="setsCard"><p class="small muted">Loading…</p></div></details>
          <details class="card sec fold" id="adminsSec"><summary><h2>Admins</h2><span class="sum" id="adminsSum"></span></summary><div id="adminsCard"><p class="small muted">Loading…</p></div></details>
        </div>
        <section class="card stack sec">
          <h2>Photos <span class="count">${photos.length}</span></h2>
          <p class="small muted">${counts[0]} easy · ${counts[1]} medium · ${counts[2]} hard</p>
          <div class="drop" id="drop">
            <label class="btn btn-primary btn-big">Add photos<input type="file" id="files" accept="image/*,.heic,.heif,.HEIC,.HEIF" multiple class="hidden"></label>
            <p class="small muted">Or drag them here. Photos with a saved location are pinned automatically.</p>
            <details class="mini"><summary>How to keep the locations</summary>
              <ul class="small">
                <li><b>Mac Photos app:</b> select the photos and drag them onto this box. Or File → Export → Export Unmodified Originals, then drag those files here.</li>
                <li><b>iPhone:</b> the photo picker can remove locations. In Photos, select the photos → Share → <b>Options</b> → turn on <b>Location</b> → Save to Files. Then tap Choose photos → Browse and pick them from Files.</li>
                <li><b>Missing a location?</b> The photo still uploads; place its pin on the Map tab.</li>
              </ul></details>
            <p id="upProg" class="small"></p>
          </div>
          ${photos.length ? radiusBar(photos) : ''}
          ${noPin ? `<div class="note"><b>${noPin} photo${noPin > 1 ? 's need' : ' needs'} a pin.</b> Tap "Place pin".</div>` : ''}
          ${photos.length ? `<div class="plist">
            ${photos.map(photoRow).join('')}</div>` : '<p class="muted">No photos yet.</p>'}
        </section>
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
    renderSets();
    renderAdmins();
  }

  // ---------- photo sets: saved photos + play area + home base, loaded one per round ----------
  // The game remembers which set it's using; switching sets saves that one first, so nothing is lost.
  async function renderSets() {
    const box = $('#setsCard'); if (!box) return;
    let d;
    try { d = await api('/sets'); } catch { return; }
    const { game, photos } = A.d;
    const canSwitch = game.status === 'setup';
    const day = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const cur = d.sets.find((s) => s.id === d.current) || null;
    const nextName = () => { for (let i = d.sets.length + 1; ; i++) if (!d.sets.some((s) => s.name.toLowerCase() === `round ${i}`)) return `Round ${i}`; };
    const sum = $('#setsSum'); if (sum) sum.textContent = cur ? `Using ${cur.name}` : photos.length ? 'Not saved as a set' : plural(d.sets.length, 'set');
    box.innerHTML = `
      <p class="small muted">One set of photos, play area and home base per round. Switching saves the one you're on first.</p>
      <div class="note">${cur ? `This game is using <b>${esc(cur.name)}</b> · ${plural(photos.length, 'photo')} here now.` : photos.length ? `The ${plural(photos.length, 'photo')} here aren't saved as a set yet.` : 'No photos here yet.'}</div>
      <div class="row">
        ${cur ? `<button class="btn-small" id="setSave" ${photos.length ? '' : 'disabled'}>Save to "${esc(cur.name)}"</button>` : `<button class="btn-small" id="setNew" ${photos.length ? '' : 'disabled'}>Save as a set…</button>`}
        <button class="btn-small btn-primary" id="setFresh" ${canSwitch ? '' : 'disabled'}>Start a new set…</button>
      </div>
      ${d.sets.map((s) => `<div class="set-row">
        <div><b>${esc(s.name)}</b>${s.id === d.current ? ' <b class="in-use">· in use</b>' : ''} <span class="small muted">${s.id === d.current ? `${plural(photos.length, 'photo')} here` : plural(s.photos, 'photo')}${s.has_home ? ' · home base' : ''} · saved ${day(s.updated_at)}</span></div>
        <div class="row">
          ${s.id === d.current ? '' : `<button class="btn-small btn-primary" data-sload="${esc(s.id)}" ${canSwitch ? '' : 'disabled'}>Load</button>`}
          <button class="btn-small" data-sname="${esc(s.id)}">Rename</button>
          <button class="btn-small btn-ghost btn-danger" data-sdel="${esc(s.id)}">Delete</button>
        </div></div>`).join('')}
      ${canSwitch ? '' : '<p class="small muted">Load and Start a new set work only before the game starts. Reset the game on the Live tab first.</p>'}
      <p class="small" id="setMsg">${A.setMsg || ''}</p>`;
    A.setMsg = '';
    const byId = (sid) => d.sets.find((s) => s.id === sid);
    const msg = (html) => { A.setMsg = html; }; // shows after the card redraws
    const taken = (name) => d.sets.some((s) => s.name.toLowerCase() === name.toLowerCase());
    const ask = (q, def) => { const v = prompt(q, def); return v?.trim() || null; };
    const redraw = async () => { await refresh(); renderSetup(); };

    if ($('#setSave')) $('#setSave').onclick = async () => {
      const r = await api('/sets/' + encodeURIComponent(cur.id), 'PUT');
      msg(`<b>Saved "${esc(cur.name)}"</b> with ${plural(r.photos, 'photo')}.`); renderSets();
    };
    if ($('#setNew')) $('#setNew').onclick = async () => {
      const name = ask(`Name this set (it saves the ${plural(photos.length, 'photo')}, play area and home base here):`, d.sets.length ? nextName() : 'Round 1');
      if (!name) return;
      if (taken(name)) return alert(`There's already a set called "${name}".`);
      const r = await api('/sets', 'POST', { name });
      msg(`<b>Saved "${esc(name)}"</b> with ${plural(r.photos, 'photo')}.`); renderSets();
    };
    $('#setFresh').onclick = async () => {
      const name = ask('Name the new set (it starts with no photos):', nextName());
      if (!name) return;
      if (taken(name)) return alert(`There's already a set called "${name}". Pick another name, or Load that set.`);
      let oldName = null;
      if (photos.length && !cur) {
        oldName = ask(`First, name the ${plural(photos.length, 'photo')} here so they're saved and you can load them again later:`, d.sets.length ? 'Earlier photos' : 'Round 1');
        if (!oldName) return;
        if (taken(oldName) || oldName.toLowerCase() === name.toLowerCase()) return alert(`Pick a different name than "${oldName}".`);
      }
      const savedTo = cur ? cur.name : oldName;
      if (!confirm(`Start the new set "${name}"?\n\n${photos.length ? `1. The ${plural(photos.length, 'photo')} here are saved to "${savedTo}".\n2. ` : ''}This game is cleared${A.d.finds.length ? ' (photos already sent too)' : ''} so you can add "${name}"'s photos.\n\nThe play area and home base stay.${savedTo ? ` Load "${savedTo}" any time to get its photos back.` : ''}`)) return;
      const r = await api('/sets/fresh', 'POST', { name, old_name: oldName });
      msg(`<b>Now on "${esc(name)}"</b> with no photos.${r.saved_to ? ` The ${plural(r.saved, 'photo')} from before are saved in "${esc(r.saved_to)}".` : ''} Add photos below; switching sets saves them.`);
      await redraw();
    };
    box.querySelectorAll('[data-sload]').forEach((b) => b.onclick = async () => {
      const s = byId(b.dataset.sload);
      const first = photos.length ? (cur ? `The ${plural(photos.length, 'photo')} here are saved to "${cur.name}" first.` : `The ${plural(photos.length, 'photo')} here aren't saved as a set and will be replaced. Press Cancel and "Save as a set" first if you want to keep them.`) : '';
      if (!confirm(`Load "${s.name}"?\n\n${first ? first + '\n\n' : ''}This game gets "${s.name}"'s ${plural(s.photos, 'photo')}, play area and home base.${A.d.finds.length ? ' Photos already sent in this game are deleted.' : ''}`)) return;
      b.disabled = true;
      const r = await api('/sets/' + encodeURIComponent(s.id) + '/load', 'POST').finally(() => { b.disabled = false; });
      msg(`<b>Loaded "${esc(s.name)}"</b>: ${plural(r.photos, 'photo')}.${r.saved_to ? ` Saved "${esc(r.saved_to)}" first.` : ''}`);
      await redraw();
    });
    box.querySelectorAll('[data-sname]').forEach((b) => b.onclick = async () => {
      const s = byId(b.dataset.sname);
      const name = ask('New name for this set:', s.name);
      if (!name || name === s.name) return;
      await api('/sets/' + encodeURIComponent(s.id), 'PATCH', { name });
      renderSets();
    });
    box.querySelectorAll('[data-sdel]').forEach((b) => b.onclick = async () => {
      const s = byId(b.dataset.sdel);
      if (!confirm(`Delete the set "${s.name}"?\n\nThe photos in this game stay as they are.${s.id === d.current ? ' This game just won\'t be saved to a set anymore.' : ''}`)) return;
      await api('/sets/' + encodeURIComponent(s.id), 'DELETE');
      renderSets();
    });
  }

  function photoRow(p, i) {
    return `<div class="prow" data-row="${p.id}">
      <span class="n">${i + 1}</span>
      <img src="/img/${esc(p.thumb_key)}" alt="" loading="lazy" data-big="/img/${esc(p.image_key)}" data-cap="#${i + 1} ${esc(p.title || '')}">
      <div class="pf">
        <input class="f-title" data-f="title" value="${esc(p.title)}" placeholder="Title (optional)">
        <span class="dseg f-diff">${[1, 2, 3].map((d) => `<button data-d="${d}" class="${p.difficulty === d ? 'on' : ''}">${DIFF[d]}</button>`).join('')}</span>
        <span class="unit f-pts"><input data-f="points" type="number" min="0" value="${p.points}"><i>pts</i></span>
        <span class="unit f-rad" title="Check-in radius: how close a player must be (${p.radius_m} m ≈ ${ft(p.radius_m)} ft)"><input data-f="radius_m" type="number" min="5" max="500" value="${p.radius_m}"><i>m</i></span>
        <input class="f-hint" data-f="hint" value="${esc(p.hint)}" placeholder="Hint (optional)">
      </div>
      <div class="pact">
        <button class="btn-small pin-btn ${p.lat == null ? 'btn-primary' : ''}" data-place="${p.id}">${p.lat == null ? 'Place pin' : '✓ On map'}</button>
        <button class="btn-small btn-ghost x-btn" data-pdel="${p.id}" title="Delete photo" aria-label="Delete photo">✕</button>
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
    return `<details class="radius-bar fold"><summary><b>Check-in radius</b><span class="sum">${now}</span></summary>
      <p class="small muted">How close a player has to be for a "yes".</p>
      <div class="row">
        <select id="radWho" aria-label="Which photos"><option value="">All ${photos.length} photos</option>${[1, 2, 3].map((d) => `<option value="${d}">${DIFF[d]} photos (${photos.filter((p) => p.difficulty === d).length})</option>`).join('')}</select>
        <span class="unit"><input id="radVal" type="number" min="5" max="500" value="${common[0][0]}" aria-label="Radius in meters"><i>m</i></span>
        <span class="small muted" id="radFt">≈ ${ft(common[0][0])} ft</span>
      </div>
      <div class="row">${[25, 40, 60, 100].map((r) => `<button class="btn-small rad-pre" data-rad="${r}">${r} m</button>`).join('')}
        <button class="btn-small btn-primary" id="radApply">Apply</button></div>
    </details>`;
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
          <div class="side-head stack">
            <div class="row">
              <button class="btn-small" id="drawBtn">Redraw play area</button>
              <button class="btn-small" id="defaultBtn" title="Canal, Greenwich, Christopher, 6th Ave">Reset area</button>
            </div>
            <div class="home-row" id="homeRow"></div>
            <h2>Pins <span class="count" id="pinCount"></span></h2>
            <div class="filters" id="chips"></div>
          </div>
          <div class="side-list" id="sideList"></div>
        </div>
      </div>`;
    const m = A.maps.admin = baseMap('adminMap');
    A.areaLayer = L.layerGroup().addTo(m);
    A.pinLayer = L.layerGroup().addTo(m);
    A.ringLayer = L.layerGroup().addTo(m);
    A.homeLayer = L.layerGroup().addTo(m);
    A.markers = {};
    m.on('click', onMapClick);
    m.on('zoomend', drawRings);
    $('#drawBtn').onclick = () => {
      if (A.drawing) return finishDrawing();
      A.drawing = []; A.placing = null;
      $('#drawBtn').textContent = '✓ Done drawing';
      hint('Tap each corner of the play area, then "Done drawing".', true);
      drawArea2();
    };
    $('#defaultBtn').onclick = async () => { if (!confirm('Reset the play area to Canal, Greenwich, Christopher and 6th Ave?')) return; await api('/game', 'PATCH', { boundary: 'default' }); await refresh(); drawArea2(true); };
    drawArea2(true);
    drawPins();
    drawHome();
    renderSide();
    const fit = A.d.game.boundary || A.d.photos.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
    if (fit.length) m.fitBounds(fit, { padding: [20, 20] });
    if (A.sel) setTimeout(() => select(A.sel, true), 300);
  }

  function hint(text, cancel) {
    const el = $('#mapHint'); if (!el) return;
    el.innerHTML = text ? `<div class="map-hint">${text}${cancel ? '<button class="btn-small" id="cancelHint">Cancel</button>' : ''}</div>` : '';
    const c = $('#cancelHint');
    if (c) c.onclick = () => { A.placing = null; A.placingHome = false; if (A.drawing) { A.drawing = null; $('#drawBtn').textContent = 'Redraw play area'; drawArea2(); } hint(''); };
  }

  function drawArea2() {
    A.areaLayer.clearLayers();
    if (A.drawing) {
      if (A.drawing.length) { L.polyline(A.drawing, { color: '#e8590c', weight: 3, dashArray: '6 6' }).addTo(A.areaLayer); A.drawing.forEach((p) => L.circleMarker(p, { radius: 6, color: '#e8590c', fillColor: '#fff', fillOpacity: 1 }).addTo(A.areaLayer)); }
    } else drawArea(A.areaLayer, A.d.game.boundary);
  }

  async function finishDrawing() {
    const pts = A.drawing; A.drawing = null;
    $('#drawBtn').textContent = 'Redraw play area';
    hint('');
    if (pts.length >= 3) { await api('/game', 'PATCH', { boundary: pts }); await refresh(); }
    drawArea2();
  }

  // Home base: a pin every player sees on their map (where the TV and dinner are).
  const homeIcon = () => L.divIcon({ className: '', html: '<div class="home-pin">🏠</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
  function drawHome() {
    const h = A.d.game.home;
    A.homeLayer.clearLayers();
    if (h) {
      const mk = L.marker([h.lat, h.lng], { icon: homeIcon(), draggable: true, zIndexOffset: 900 }).addTo(A.homeLayer)
        .bindTooltip(esc(h.label), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'home-label' });
      mk.on('dragend', async () => { const ll = mk.getLatLng(); await saveHome({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), label: h.label }); });
    }
    $('#homeRow').innerHTML = h
      ? `<div>Home base: <b>${esc(h.label)}</b> <span class="small muted">drag its pin to move it</span></div><div class="row"><button class="btn-small" id="homeName">Rename</button><button class="btn-small" id="homeDel">Remove</button><a class="btn btn-small" href="/area" target="_blank">Map for players</a></div>`
      : `<div class="row"><button class="btn-small" id="homeSet">Set home base</button><a class="btn btn-small" href="/area" target="_blank">Map for players</a></div>`;
    if ($('#homeSet')) $('#homeSet').onclick = () => { A.placing = null; A.drawing = null; A.placingHome = true; hint('Tap where home base is (where the TV and dinner are).', true); };
    if ($('#homeName')) $('#homeName').onclick = async () => { const label = prompt('What should players see on the map?', h.label); if (label?.trim()) await saveHome({ ...h, label: label.trim() }); };
    if ($('#homeDel')) $('#homeDel').onclick = async () => { if (confirm('Remove the home base pin from everyone\'s map?')) await saveHome(null); };
  }
  async function saveHome(home) { await api('/game', 'PATCH', { home }); await refresh(); drawHome(); }

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
        <img src="/img/${esc(p.thumb_key)}" loading="lazy" alt="" data-big="/img/${esc(p.image_key)}" data-cap="#${i + 1} ${esc(p.title || '')}">
        <span class="t"><b>#${i + 1}</b> ${esc(p.title || '')}<br><span class="small">${diffTag(p.difficulty)} · ${p.points} pt</span></span>
        ${p.lat == null ? `<button class="btn-small btn-primary pin-btn" data-place2="${p.id}">Place</button>` : ''}
      </div>` : '').join('') || '<p class="muted pad">No photos here.</p>';
    document.querySelectorAll('[data-item]').forEach((el) => el.onclick = (e) => { if (!e.target.closest('[data-place2], [data-big]')) select(el.dataset.item, true); });
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
      hint(`<b>#${i + 1}</b> ${esc(p.title || '')} <span class="hint-rad">Radius <input type="range" id="selRad" min="5" max="200" step="5" value="${Math.min(200, p.radius_m)}"> <b id="selRadTxt">${p.radius_m} m · ${ft(p.radius_m)} ft</b></span> <span class="hint-sub">drag the pin to move it</span>`);
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
    hint(`<b>Tap the map where photo #${i + 1} was taken.</b>`, true);
  }

  async function onMapClick(e) {
    const ll = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
    if (A.drawing) { A.drawing.push(ll); drawArea2(); return; }
    if (A.placingHome) {
      A.placingHome = false; hint('');
      const label = prompt('What should players see on the map? (e.g. "Grandma\'s · 12 Bank St")', A.d.game.home?.label || 'Home base');
      if (label === null) return;
      await saveHome({ lat: ll[0], lng: ll[1], label: label.trim() || 'Home base' });
      return;
    }
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
        <div class="st-name"><b>${i + 1}. ${esc(t.name)}</b> <span class="small muted">${t.players} players</span></div>
        <div class="v">${t.score} <span class="small muted">pts</span></div>
        <div class="counts">${[1, 2, 3].map((d) => `<span><span class="bullet d${d}">${'EMH'[d - 1]}</span>${t.by_diff[d - 1]}</span>`).join('')}<span class="muted">${t.found} found</span></div>
      </div>`).join('')}</div>`;
  }

  // The Live tab is a set of sections that are put in order for the phase of the game: what needs the host
  // right now comes first. A phone gets one column; a computer gets two. Sections are moved, never rebuilt,
  // so the map, what's typed and what's open all stay put. Rarely used sections fold to a one-line summary.
  const LIVE_ORDER = {
    setup: { phone: ['ctl', 'teams', 'players', 'msg', 'tv', 'map', 'scores', 'judge', 'feed'], wide: [['ctl', 'teams', 'players'], ['msg', 'tv', 'map', 'scores', 'judge', 'feed']] },
    live: { phone: ['judge', 'msg', 'scores', 'map', 'players', 'feed', 'tv', 'ctl', 'teams'], wide: [['judge', 'feed'], ['scores', 'msg', 'map', 'players', 'tv', 'ctl', 'teams']] },
    ended: { phone: ['ctl', 'judge', 'feed', 'scores', 'msg', 'tv', 'map', 'players', 'teams'], wide: [['ctl', 'judge', 'feed'], ['scores', 'tv', 'msg', 'map', 'players', 'teams']] },
    revealed: { phone: ['ctl', 'tv', 'scores', 'feed', 'msg', 'map', 'players', 'judge', 'teams'], wide: [['ctl', 'tv', 'scores', 'feed'], ['msg', 'map', 'players', 'judge', 'teams']] },
  };
  const OPEN_AT = { setup: ['players'], live: [], ended: [], revealed: ['tv'] }; // folded sections that start open
  const wideMQ = matchMedia('(min-width: 1000px)');
  const onWide = () => { if (A.tab === 'live' && $('#liveRoot')) arrangeLive(false); };
  if (wideMQ.addEventListener) wideMQ.addEventListener('change', onWide); else wideMQ.addListener(onWide);
  const phaseOf = (g) => g.status === 'setup' ? 'setup' : g.status === 'ended' ? (g.revealed_at ? 'revealed' : 'ended') : 'live';
  function arrangeLive(full) {
    const phase = phaseOf(A.d.game), wide = wideMQ.matches;
    if (!full && A.livePhase === phase && A.liveWide === wide) return;
    if (!full) { // never move a field someone is typing in; try again on the next redraw
      const ae = document.activeElement;
      if (ae && $('#liveRoot').contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    }
    if (A.livePhase !== phase || !A.liveOpen) A.liveOpen = Object.fromEntries(['players', 'feed', 'tv'].map((k) => [k, OPEN_AT[phase].includes(k)]));
    A.livePhase = phase; A.liveWide = wide;
    const o = LIVE_ORDER[phase];
    (wide ? o.wide : [o.phone, []]).forEach((list, i) => {
      const col = $(i ? '#lcolB' : '#lcolA');
      list.forEach((k) => { const el = document.querySelector(`#liveRoot [data-sec="${k}"]`); if (el) col.appendChild(el); });
    });
    $('#liveRoot').classList.toggle('wide', wide);
    document.querySelectorAll('#liveRoot details[data-sec]').forEach((d) => { d.open = !!A.liveOpen[d.dataset.sec]; });
    if (A.maps.live) A.maps.live.invalidateSize();
  }
  const setText = (sel, t) => { const el = $(sel); if (el && el.textContent !== t) el.textContent = t; };

  function renderLive(full) {
    if (full || !$('#liveRoot')) {
      $('#body').innerHTML = `<div id="liveRoot" class="live">
        <div class="lcol stack" id="lcolA"></div><div class="lcol stack" id="lcolB"></div>
        <div class="hidden">
          <section class="card sec" data-sec="ctl"><div class="stack" id="controls"></div>
            <div class="join-box"><div class="qr">${qrSvg(playerUrl)}</div><div class="stack"><button class="btn-small" id="tvBtn">Big join code</button><a class="btn btn-small" href="/tv" target="_blank">Open TV view</a></div></div></section>
          <section class="card sec" data-sec="judge"><h2>Judge queue <span class="count" id="jCount">0</span></h2><div id="judge"></div><div id="farList"></div></section>
          <section class="card sec stack" data-sec="msg"><h2>Send a message</h2>
            <div class="field-row"><label for="annTo">To</label><select id="annTo" class="grow"></select></div>
            <div class="row">${["Head back to home base now 🏠", "15 minutes left!", "Dinner's ready! Come back 🦃"].map((t) => `<button class="btn-small" data-ann="${esc(t)}">${esc(t)}</button>`).join('')}</div>
            <div class="field-row"><input id="annText" maxlength="200" placeholder="Type a message…" class="grow" aria-label="Message"><button class="btn-primary" id="annSend">Send</button></div>
            <div id="annLast"></div></section>
          <section class="sec" data-sec="scores"><div id="tiles"></div></section>
          <section class="card sec" data-sec="map"><h2>Where everyone is</h2><div id="liveMap"></div></section>
          <section class="card sec stack" data-sec="teams" id="teamCard"></section>
          <details class="card sec fold" data-sec="players"><summary><h2>Players <span class="count" id="pCount">0</span></h2><span class="sum" id="pSum"></span></summary><div id="players"></div></details>
          <details class="card sec fold" data-sec="feed"><summary><h2>Every photo sent <span class="count" id="fCount"></span></h2><span class="sum" id="fSum"></span></summary>
            <div class="filters" id="fFilters"></div><div id="manual"></div><div class="feed" id="feed"></div></details>
          <details class="card sec fold" data-sec="tv"><summary><h2>TV</h2><span class="sum" id="tvSum"></span></summary><div id="tvCard"></div></details>
        </div></div>`;
      document.querySelectorAll('#liveRoot details[data-sec]').forEach((d) => d.addEventListener('toggle', () => { if (A.liveOpen) A.liveOpen[d.dataset.sec] = d.open; }));
      arrangeLive(true); // place the sections before the map is made, so it gets its real size
      $('#tvBtn').onclick = tv;
      document.querySelectorAll('[data-ann]').forEach((b) => b.onclick = () => { $('#annText').value = b.dataset.ann; $('#annText').focus(); });
      const sendAnn = async () => {
        const t = $('#annText').value.trim(); if (!t) return $('#annText').focus();
        $('#annSend').disabled = true;
        const to = $('#annTo').value;
        try {
          if (to) await api('/messages', 'POST', { team_id: to, text: t }); else await api('/game', 'PATCH', { announce: t });
          $('#annText').value = ''; await refresh();
        } finally { $('#annSend').disabled = false; }
        render();
      };
      $('#annSend').onclick = sendAnn;
      $('#annText').onkeydown = (e) => { if (e.key === 'Enter') sendAnn(); };
      const m = A.maps.live = baseMap('liveMap');
      // On touch screens one finger scrolls the page instead of getting stuck moving the map; pinch still zooms.
      if (L.Browser.touch && innerWidth < 900) m.dragging.disable();
      A.liveLayer = L.layerGroup().addTo(m);
      drawArea(L.layerGroup().addTo(m), A.d.game.boundary);
      if (A.d.game.boundary) m.fitBounds(A.d.game.boundary, { padding: [10, 10] });
      const h = A.d.game.home;
      if (h) L.marker([h.lat, h.lng], { icon: homeIcon(), interactive: false, zIndexOffset: -50 }).addTo(m);
    }
    arrangeLive(false); // the phase changed (or the window got wider): reorder the sections
    const { game, players, finds, teams, photos } = A.d;
    const busy = document.activeElement && ['SELECT', 'INPUT'].includes(document.activeElement.tagName);
    // Only redraw a section when its content changed, so buttons don't move under the mouse.
    const changed = (key, val) => { if (!full && A.sig?.[key] === val) return false; (A.sig ||= {})[key] = val; return true; };
    const ann = A.d.game.announce, msgs = A.d.messages || [];
    if (changed('annTo', JSON.stringify(teams.map((t) => [t.id, t.name])))) {
      const sel = $('#annTo'), was = sel.value;
      sel.innerHTML = `<option value="">Everyone (phones and TV)</option>` + teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} only</option>`).join('');
      if ([...sel.options].some((o) => o.value === was)) sel.value = was;
    }
    if (changed('ann', JSON.stringify([ann, msgs, teams.map((t) => [t.id, t.name, t.color])]))) {
      const hm = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const tName = (id) => { const t = teams.find((x) => x.id === id); return t ? `<b style="color:${esc(t.color)}">${esc(t.name)}</b>` : 'a removed team'; };
      const rows = [
        ...(ann ? [{ at: ann.at, html: `<b>Everyone</b>`, text: ann.text, del: 'all' }] : []),
        ...msgs.slice(0, 8).map((m) => ({ at: m.at, html: tName(m.team_id), text: m.text, del: m.id })),
      ].sort((a, b) => b.at - a.at);
      $('#annLast').innerHTML = rows.map((r) => `<div class="line-row"><span class="grow"><span class="small muted">${hm(r.at)} to</span> ${r.html}: “${esc(r.text)}”</span><button class="btn-small" data-anndel="${esc(r.del)}">Take down</button></div>`).join('');
      document.querySelectorAll('[data-anndel]').forEach((b) => b.onclick = async () => {
        b.disabled = true;
        if (b.dataset.anndel === 'all') await api('/game', 'PATCH', { announce: null }); else await api('/messages/' + b.dataset.anndel, 'DELETE');
        await refresh(); render();
      });
    }
    $('#tiles').innerHTML = scoreTiles();

    // TV settings and remote controls. The TV page itself has no password and no buttons.
    const tvs = game.tv || {};
    if (changed('tv', JSON.stringify([tvs, game.revealed_at]))) {
      const TV_OPTS = [
        ['noSpoilers', 'No spoilers', 'Hides points and right/wrong until you reveal the results.'],
        ['players', 'Players on the map', ''],
        ['names', 'Names next to players', ''],
        ['trails', 'Walking trails', ''],
        ['spots', 'Photo spots on the map', 'Careful: anyone looking at the TV could peek.'],
        ['popups', 'Pop up new photos', ''],
        ['joinCode', 'Join code in the corner', ''],
        ['sound', 'Sound', ''],
      ];
      $('#tvCard').innerHTML = `
        <p class="small muted">On the TV, open <b>${esc(location.host)}/tv</b> and click the screen once for sound and full screen.</p>
        <div class="toggles">${TV_OPTS.map(([k, label, help]) => `<label class="rt-toggle"><input type="checkbox" data-tv="${k}" ${tvs[k] ? 'checked' : ''}><span><b>${label}</b>${help ? `<br><span class="small muted">${help}</span>` : ''}</span></label>`).join('')}</div>
        <div class="field-row"><span>Results speed</span>${[1, 2, 4].map((x) => `<button class="btn-small ${(tvs.speed || 1) === x ? 'btn-primary' : ''}" data-tvspeed="${x}">${x}×</button>`).join('')}</div>
        <div class="row">${game.revealed_at ? '<button class="btn-small" data-tvcmd="replay">Show the results again</button><button class="btn-small" data-tvcmd="skip">Skip to the winner</button>' : ''}<button class="btn-small" data-tvcmd="close">Back to the map</button></div>`;
      const saveTv = async (patch) => { try { await api('/game', 'PATCH', { tv: patch }); } finally { await refresh(); A.sig.tv = null; render(); } };
      document.querySelectorAll('[data-tv]').forEach((c) => c.onchange = () => {
        c.blur();
        if (c.dataset.tv === 'spots' && c.checked && !confirm('Show every photo spot on the TV? Anyone who sees the TV will know where the photos are.')) { c.checked = false; return; }
        saveTv({ [c.dataset.tv]: c.checked });
      });
      document.querySelectorAll('[data-tvspeed]').forEach((b) => b.onclick = () => saveTv({ speed: Number(b.dataset.tvspeed) }));
      document.querySelectorAll('[data-tvcmd]').forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try { await api('/game', 'PATCH', { tv_cmd: b.dataset.tvcmd }); } finally { b.disabled = false; }
      });
    }

    setText('#tvSum', [tvs.noSpoilers ? 'No spoilers' : 'Spoilers shown', tvs.players ? 'players on map' : 'players hidden', ...(tvs.spots ? ['photo spots shown'] : []), tvs.sound ? 'sound on' : 'sound off'].join(' · '));

    const waiting = finds.filter((f) => f.status === 'pending').length;
    const tutOn = game.tutorial_at && A.d.now - game.tutorial_at < 125000; // the demo runs about two minutes
    if (changed('controls', game.status + '|' + game.ends_at + '|' + game.revealed_at + '|' + waiting + '|' + tutOn + '|' + game.random_teams + game.teams_ready)) {
      $('#controls').innerHTML = game.status === 'setup' ? `
        <h2>Ready to start?</h2>
        <p class="muted" id="joinedLine"></p>
        ${game.random_teams && !game.teams_ready ? '<p>Shuffle and reveal the teams before you start.</p>' : ''}
        <div><label for="mins">Game length in minutes (optional)</label><input id="mins" type="number" min="5" placeholder="No timer"></div>
        <button class="btn-ok btn-big" id="startBtn">▶ Start the game</button>`
        : game.status === 'starting' ? `
        <h2>Starting…</h2>
        <p class="muted">Phones and the TV are counting down. The hunt opens at ${new Date(game.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.</p>
        <button class="btn-big btn-bad" id="endBtn">■ Stop</button>`
        : game.status === 'live' ? `
        <h2>Game</h2>
        <p class="muted">${game.ends_at ? `Ends at ${new Date(game.ends_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'No timer. End it when everyone is back.'}</p>
        <button class="btn-big btn-bad" id="endBtn">■ End the game</button>`
        : !game.revealed_at ? `
        <h2>The game is over</h2>
        <p class="muted">${waiting ? `<b class="error">${waiting} still waiting for the judge.</b> They won't count unless approved. ` : ''}Take your time: judge whenever you're ready. Nobody sees scores until you reveal them. Photos taken before the end can still arrive for 30 minutes.</p>
        <button class="btn-ok btn-big" id="revealBtn">Reveal the results</button>
        <div class="row"><button class="btn-small" id="reopenBtn">Reopen the game</button><button class="btn-small btn-bad" id="resetBtn">↺ Reset the game</button></div>`
        : `<h2>Game</h2>
        <button class="btn-big btn-bad" id="resetBtn">↺ Reset and play again</button>
        <div class="row"><button class="btn-small" id="hideBtn">Hide the results again</button><button class="btn-small" id="reopenBtn">Reopen the game</button></div>`;
      $('#controls').innerHTML += `<div class="row tut-row"><button class="btn-small" id="tutBtn">${tutOn ? 'Play How to play again' : 'Play How to play on the TV'}</button>${tutOn ? '<button class="btn-small" id="tutStop">■ Stop it</button>' : ''}</div>`;
      const act = (btn, body, ask, after) => btn && (btn.onclick = async () => {
        if (ask && !confirm(ask)) return;
        btn.disabled = true;
        try { await api('/game', 'PATCH', body()); await refresh(); } finally { btn.disabled = false; }
        after ? after() : render();
      });
      act($('#startBtn'), () => ({ action: 'start', minutes: Number($('#mins').value) || null }), 'Start the game? Everyone gets a 10-second countdown, then the hunt opens and teams are locked.');
      act($('#endBtn'), () => ({ action: 'end' }), 'End the game for everyone? Results stay hidden until you press Reveal.');
      act($('#reopenBtn'), () => ({ action: 'reopen' }), 'Reopen the game? Results will be hidden again.');
      act($('#revealBtn'), () => ({ action: 'reveal' }), waiting ? `${waiting} answer${waiting > 1 ? 's are' : ' is'} still waiting for the judge and won't count. Reveal anyway?` : 'Reveal the results to everyone now?');
      act($('#hideBtn'), () => ({ action: 'hide' }));
      act($('#tutBtn'), () => ({ action: 'tutorial' }));
      act($('#tutStop'), () => ({ action: 'tutorial_stop' }));
      act($('#resetBtn'), () => ({ action: 'reset' }), 'Reset the game?\n\nThis deletes every photo sent, all scores and all trails, and removes every player: everyone goes back to the join screen and scans in again. Teams and the hunt photos stay. This can\'t be undone.\n\n(Tip: download the results CSV first if you want to keep them.)');
    }
    const jl = $('#joinedLine'); if (jl) jl.textContent = `${photos.length} photos · ${players.length} players joined.`;

    // Judge queue
    const pending = finds.filter((f) => f.status === 'pending');
    $('#jCount').textContent = pending.length; $('#jCount').classList.toggle('hot', pending.length > 0);
    // A long queue shows the first few, so the rest of the page stays close; "Show all" opens the rest.
    const JMAX = 3, jShown = A.judgeAll ? pending : pending.slice(0, JMAX);
    if (changed('judge', pending.map((f) => f.id).join() + '|' + !!A.judgeAll)) $('#judge').innerHTML = pending.length ? jShown.map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      return `<div class="judge-item" data-fid="${f.id}">
        <div class="judge-pics"><figure><a href="/img/${esc(p?.image_key)}" target="_blank"><img src="/img/${esc(p?.thumb_key)}"></a><figcaption>#${numOf(f.photo_id)} · the photo</figcaption></figure>
          <figure>${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}"></a>` : '<div class="nopic">No picture</div>'}<figcaption>their picture</figcaption></figure></div>
        <p class="small" style="margin:.2em 0 .5em"><span class="swatch" style="background:${esc(t?.color)}"></span> <b>${esc(pl?.name || '?')}</b> (${esc(t?.name)}) · ${Math.round(f.distance_m)} m from the spot · GPS ±${Math.round(f.accuracy_m || 0)} m</p>
        ${whereBtn(f)}
        <div class="row"><button class="btn-big btn-ok grow" data-judge="${f.id}" data-s="approved">✓ Approve</button><button class="btn-big btn-bad grow" data-judge="${f.id}" data-s="rejected">✕ Reject</button></div></div>`;
    }).join('') + (pending.length > JMAX ? `<button class="btn-small" id="judgeMore">${A.judgeAll ? 'Show fewer' : `Show all ${pending.length}`}</button>` : '') : '<p class="muted">Nothing to judge right now.</p>';
    const jm = $('#judgeMore'); if (jm) jm.onclick = () => { A.judgeAll = !A.judgeAll; render(); };
    // Answers taken far from the spot are marked "no" automatically. The judge can still approve one.
    const far = finds.filter((f) => f.status === 'far');
    const farOpen = !!$('#farList details')?.open; // keep it open when a new one arrives
    if (changed('far', far.map((f) => f.id).join())) $('#farList').innerHTML = far.length ? `<details class="mini" ${farOpen ? 'open' : ''}><summary><b>Marked no, too far away (${far.length})</b> <span class="small muted">check these if GPS was bad</span></summary>${far.map((f) => {
      const p = photoOf(f.photo_id), t = teamOf(f.team_id), pl = playerOf(f.player_id);
      return `<div class="judge-item" data-fid="${f.id}"><div class="judge-pics"><figure><a href="/img/${esc(p?.image_key)}" target="_blank"><img src="/img/${esc(p?.thumb_key)}" loading="lazy"></a><figcaption>#${numOf(f.photo_id)} · the photo</figcaption></figure>
        <figure>${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}" loading="lazy"></a>` : '<div class="nopic">No picture</div>'}<figcaption>their picture</figcaption></figure></div>
        <p class="small"><span class="swatch" style="background:${esc(t?.color)}"></span> <b>${esc(pl?.name || '?')}</b> (${esc(t?.name)}) · ${Math.round(f.distance_m)} m from the spot · GPS ±${Math.round(f.accuracy_m || 0)} m</p>
        <div class="row">${whereBtn(f)}<button class="btn-ok btn-small" data-judge="${f.id}" data-s="approved">✓ Approve anyway</button></div></div>`;
    }).join('')}</details>` : '';
    document.querySelectorAll('[data-judge]').forEach((b) => b.onclick = async () => {
      b.closest('.judge-item').querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try { await api('/finds/' + b.dataset.judge, 'PATCH', { status: b.dataset.s }); } finally { await refresh(); render(); }
    });

    // Random teams: settings, shuffle and reveal (before the start only).
    const adults = players.filter((p) => p.adult).length;
    A.teamCount ||= Math.max(2, teams.length);
    const hiddenTeams = game.random_teams && !game.teams_ready;
    if (changed('teamcard', JSON.stringify([game.status, game.random_teams, game.teams_at, game.teams_ready, adults, players.length, A.teamCount]))) {
      const card = $('#teamCard');
      card.classList.toggle('hidden', game.status !== 'setup');
      const n = A.teamCount;
      const warn = !adults ? 'No adults marked yet: tick "Adult" next to their names below.'
        : adults < n ? `<b class="error">Only ${adults} adult${adults > 1 ? 's' : ''} for ${n} teams</b>, so ${n - adults} team${n - adults > 1 ? 's' : ''} won't have one. Mark more adults or use fewer teams.`
        : `${adults} adults marked: every team gets at least one.`;
      card.innerHTML = `<h2>Random teams</h2>
        <label class="rt-toggle"><input type="checkbox" id="rtOn" ${game.random_teams ? 'checked' : ''}><span><b>Pick the teams at random</b><br><span class="small muted">Players can't choose a team. You shuffle, then reveal.</span></span></label>
        ${game.random_teams ? `
        <div class="field-row"><span>Teams</span><button class="btn-small" id="tcMinus" ${n <= 2 ? 'disabled' : ''} aria-label="Fewer teams">−</button><b class="num">${n}</b><button class="btn-small" id="tcPlus" ${n >= 8 ? 'disabled' : ''} aria-label="More teams">+</button>
          <span class="small muted">${players.length ? `about ${Math.floor(players.length / n)}${players.length % n ? `–${Math.ceil(players.length / n)}` : ''} per team` : ''}</span></div>
        <p class="small">${warn}</p>
        <div class="row"><button class="btn-primary btn-small" id="shuffleBtn" ${players.length < 2 ? 'disabled' : ''}>${game.teams_at ? 'Shuffle again' : 'Shuffle teams'}</button>
          ${game.teams_at && !game.teams_ready ? '<button class="btn-ok btn-small" id="showTeamsBtn">Reveal the teams</button>' : ''}</div>
        <p class="small muted">${!game.teams_at ? 'Everyone waits in the lobby until you shuffle and reveal. Late joiners go to the smallest team.'
          : !game.teams_ready ? 'Only you can see the teams (under Players). Shuffle again, move people, or reveal them.'
          : 'Everyone can see their team. Shuffling again hides the teams until you reveal again.'}</p>` : ''}`;
      $('#rtOn').onchange = async (e) => {
        const on = e.target.checked; e.target.blur();
        if (on && players.length && !confirm('Pick teams at random? The teams players chose are cleared, and they wait in the lobby until you shuffle and reveal.')) { e.target.checked = false; return; }
        try { await api('/game', 'PATCH', { random_teams: on }); } finally { await refresh(); render(); }
      };
      if ($('#tcMinus')) $('#tcMinus').onclick = () => { A.teamCount = Math.max(2, n - 1); render(); };
      if ($('#tcPlus')) $('#tcPlus').onclick = () => { A.teamCount = Math.min(8, n + 1); render(); };
      if ($('#shuffleBtn')) $('#shuffleBtn').onclick = async (e) => {
        if (n !== teams.length && !confirm(`Make ${n} teams? ${n < teams.length ? `${teams.slice(n).map((t) => t.name).join(', ')} will be removed.` : 'New teams are added with default names and colors (rename them on the Setup tab).'}`)) return;
        if (game.teams_ready && !confirm('Shuffle again? Everyone gets a new team, hidden until you reveal again.')) return;
        e.target.disabled = true;
        try { await api('/game', 'PATCH', { action: 'shuffle', count: n }); } finally { await refresh(); A.sig.players = null; render(); }
      };
      if ($('#showTeamsBtn')) $('#showTeamsBtn').onclick = async (e) => {
        e.target.disabled = true;
        try { await api('/game', 'PATCH', { action: 'show_teams' }); } finally { await refresh(); render(); }
      };
    }

    // Players + manual fixes
    $('#pCount').textContent = players.length;
    const offline = (p) => !p.last_seen_at || A.d.now - p.last_seen_at > 2 * 60000;
    const isOut = (p) => game.status === 'live' && p.last_lat != null && !insideArea(p.last_lat, p.last_lng, game.boundary);
    // Location status per phone, so problems show up in the lobby before the start.
    const locTag = (p) => offline(p) ? `<span class="small muted">app closed ${p.last_seen_at ? ago(p.last_seen_at) : ''}</span>`
      : p.loc_state === 'off' ? '<span class="loc-tag bad">location off</span>'
      : !p.loc_at ? '<span class="loc-tag warn">no location yet</span>'
      : A.d.now - p.loc_at > 3 * 60000 ? `<span class="loc-tag warn">location ${ago(p.loc_at)}</span>`
      : isOut(p) ? '<span class="loc-tag bad">outside the area</span>'
      : '<span class="small muted">location ok</span>';
    const locBad = players.filter((p) => !offline(p) && (p.loc_state === 'off' || !p.loc_at)).length;
    const outN = players.filter((p) => !offline(p) && p.loc_state !== 'off' && p.loc_at && isOut(p)).length;
    const offN = players.filter(offline).length;
    setText('#pSum', [`${players.length} joined`, ...(locBad ? [`${locBad} no location`] : []), ...(outN ? [`${outN} outside`] : []), ...(offN ? [`${offN} app closed`] : [])].join(' · '));
    if (!busy && changed('players', JSON.stringify(players.map((p) => [p.id, p.team_id, p.name, locTag(p), p.adult])) + teams.map((t) => t.id + t.name).join() + game.random_teams + game.status)) {
      const groups = [...teams, ...(players.some((p) => !teams.some((t) => t.id === p.team_id)) ? [{ id: '', name: game.random_teams ? 'Waiting for the shuffle' : 'No team', color: '#bbb' }] : [])];
      const adultBox = (p) => game.random_teams && game.status === 'setup' ? `<label class="adult-box ${p.adult ? 'on' : ''}"><input type="checkbox" data-adult="${p.id}" ${p.adult ? 'checked' : ''}>Adult</label>` : (p.adult ? '<span class="small muted">adult</span>' : '');
      $('#players').innerHTML = players.length ? groups.map((t) => {
        const ps = players.filter((p) => t.id ? p.team_id === t.id : !teams.some((x) => x.id === p.team_id));
        if (!t.id && !ps.length) return '';
        return `<div class="pgroup"><div class="pgroup-h"><span class="swatch" style="background:${esc(t.color)}"></span>${esc(t.name)} <span class="small muted">${ps.length}${game.random_teams && t.id ? ` · ${ps.filter((p) => p.adult).length} adult${ps.filter((p) => p.adult).length === 1 ? '' : 's'}` : ''}</span></div>` + ps.map((p) => `
          <div class="prow-p"><div class="pname"><b>${esc(p.name)}</b> ${locTag(p)}</div><div class="pctl">${adultBox(p)}
          <select data-move="${p.id}" aria-label="Team for ${esc(p.name)}">${t.id ? '' : '<option value="" selected>No team</option>'}${teams.map((tt) => `<option value="${tt.id}" ${tt.id === t.id ? 'selected' : ''}>${esc(tt.name)}</option>`).join('')}</select>
          <button class="btn-small btn-ghost btn-danger" data-kick="${p.id}" title="Remove ${esc(p.name)} from the game">Remove</button></div></div>`).join('') + '</div>';
      }).join('') + (locBad ? `<p class="note small">${locBad} phone${locBad > 1 ? 's have' : ' has'} no location. Their screen shows a "Fix it" button with steps.</p>` : '')
        : '<p class="muted">Nobody yet. Show the QR code.</p>';
      document.querySelectorAll('[data-kick]').forEach((b) => b.onclick = async () => {
        const pl = playerOf(b.dataset.kick), tm = teamOf(pl?.team_id);
        const sent = finds.filter((f) => f.player_id === b.dataset.kick).length;
        if (!confirm(`Remove ${pl?.name || 'this player'} from the game?\n\nTheir phone goes back to the join screen.${sent ? ` The ${sent} photo${sent > 1 ? 's' : ''} they sent stay${sent > 1 ? '' : 's'} with ${tm.name}.` : ''}`)) return;
        b.disabled = true;
        try { await api('/players/' + b.dataset.kick, 'DELETE'); } finally { await refresh(); A.sig.players = null; render(); }
      });
      document.querySelectorAll('[data-adult]').forEach((c) => c.onchange = async () => { c.disabled = true; c.blur(); try { await api('/players/' + c.dataset.adult, 'PATCH', { adult: c.checked }); } finally { await refresh(); render(); } });
      document.querySelectorAll('[data-move]').forEach((s) => s.onchange = async () => { await api('/players/' + s.dataset.move, 'PATCH', { team_id: s.value }); await refresh(); render(); });
    }
    // The hand-add panel is only rebuilt when teams or photos change, so it keeps what you picked.
    if (changed('manual', teams.map((t) => t.id + t.name).join() + photos.map((p) => p.id + p.title).join())) {
      $('#manual').innerHTML = `<details class="mini"><summary>Give a team a find by hand</summary><div class="row">
        <select id="mTeam" aria-label="Team">${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
        <select id="mPhoto" aria-label="Photo">${photos.map((p, i) => `<option value="${p.id}">#${i + 1} ${esc(p.title || '')}</option>`).join('')}</select>
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
    { const nWait = finds.filter((f) => match('wait', f)).length, nYes = finds.filter((f) => match('yes', f)).length, nNo = finds.filter((f) => match('no', f)).length;
      setText('#fSum', finds.length ? [`${nYes} counted`, ...(nWait ? [`${nWait} waiting`] : []), `${nNo} didn't count`].join(' · ') : 'None yet'); }
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
        return `<div class="feed-item judge-row" data-fid="${f.id}">
          <a href="/img/${esc(p?.image_key)}" target="_blank" title="The photo"><img src="/img/${esc(p?.thumb_key)}" alt="" loading="lazy"></a>
          ${f.proof_key ? `<a href="/img/${esc(f.proof_key)}" target="_blank" title="Their picture"><img src="/img/${esc(f.proof_key)}" alt="" loading="lazy"></a>` : '<span class="nopic-sm">No pic</span>'}
          <div class="grow"><b>${esc(pl?.name || 'Judge')}</b> <span class="swatch" style="background:${esc(t?.color)}"></span> ${esc(t?.name)} · #${numOf(f.photo_id)} <span class="small muted">(${DIFF[p?.difficulty] || ''})</span><br>
            <span class="tag ${f.status}">${label}</span> <span class="small muted">${f.distance_m != null ? Math.round(f.distance_m * 3.28) + ' ft away · ' : ''}${ago(f.created_at)}</span></div>
          <div class="jbtns">
            <button class="btn-small ${yes ? 'on-yes' : ''}" data-flip="${f.id}" data-s="approved" ${yes ? 'disabled' : ''}>✓ Yes</button>
            <button class="btn-small ${no ? 'on-no' : ''}" data-flip="${f.id}" data-s="rejected" ${no ? 'disabled' : ''}>✕ No</button>
            ${canReset ? `<button class="btn-small" data-flip="${f.id}" data-s="reset" title="Back to what the GPS said">↺ Reset</button>` : ''}
            ${whereBtn(f)}
          </div>
          <button class="btn-small btn-ghost x-btn" data-fdel="${f.id}" title="Delete this photo" aria-label="Delete this photo">🗑</button></div>`;
      }).join('') : `<p class="muted">${finds.length ? 'None here.' : 'No photos sent yet.'}</p>`;
      document.querySelectorAll('[data-flip]').forEach((b) => b.onclick = async () => {
        b.closest('.feed-item').querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try { await api('/finds/' + b.dataset.flip, 'PATCH', { status: b.dataset.s }); } finally { await refresh(); render(); }
      });
      document.querySelectorAll('[data-fdel]').forEach((b) => b.onclick = async () => { if (!confirm('Delete this photo? The team can send it again.')) return; await api('/finds/' + b.dataset.fdel, 'DELETE'); await refresh(); render(); });
    }

    // Live map
    A.liveLayer.clearLayers();
    players.filter((p) => p.last_lat != null).forEach((p) => {
      const t = teamOf(p.team_id), stale = A.d.now - (p.loc_at || p.last_seen_at) > 5 * 60000;
      const out = !stale && isOut(p);
      L.marker([p.last_lat, p.last_lng], { icon: L.divIcon({ className: '', html: `<div class="player-pin ${stale ? 'stale' : ''} ${out ? 'out' : ''}" style="background:${esc(t.color)}"></div>`, iconSize: [18, 18] }) })
        .bindTooltip(`<b>${esc(p.name)}</b> · ${esc(t.name)}${out ? ' · <b style="color:#c0261c">outside the area</b>' : ''}<br>${ago(p.loc_at || p.last_seen_at)}`, { direction: 'top', offset: [0, -8] }).addTo(A.liveLayer);
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
      <div class="stack res">
      ${!g.revealed_at ? `<div class="note"><b>Players can't see these results yet.</b> ${g.status === 'ended' ? 'Clear the judge queue, then press Reveal results.' : 'End the game first, then reveal them.'}</div>` : ''}
      ${winner ? `<div class="winner" style="background:${esc(winner.color)}"><h1>${esc(winner.name)} ${g.revealed_at ? 'wins!' : 'is in the lead'}</h1><p>${winner.score} points · ${winner.found} photos found</p></div>` : ''}
      <div class="row"><button class="btn-small" id="winBtn">Show winner full screen</button><button class="btn-small" id="csvBtn">Download results (CSV)</button></div>
      ${scoreTiles()}
      <section class="card sec"><h2>Proof photos <span class="count">${proofs.length}</span></h2><div class="gallery">${proofs.map((f) => { const t = teamOf(f.team_id); return `<figure data-fid="${f.id}"><a href="/img/${esc(f.proof_key)}" target="_blank"><img src="/img/${esc(f.proof_key)}" loading="lazy"></a><figcaption><span class="swatch" style="background:${esc(t.color)}"></span> ${esc(playerOf(f.player_id)?.name || '')} · #${numOf(f.photo_id)}</figcaption></figure>`; }).join('') || '<p class="muted">None yet.</p>'}</div></section>
      </div>`;
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

  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (invite) acceptInvite(invite);
  else if (A.pw) boot().catch(() => {}); else login();
})();
