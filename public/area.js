// Map of the game area (and home base) to print or send to players before the day. No photo spots.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
  const ATTR = 'Map © Esri, HERE, Garmin, USGS, OpenStreetMap';
  const JOIN = location.origin + '/';
  const NOTES_KEY = 'area-notes';
  let G, map;

  const qr = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q; };

  async function boot() {
    let d;
    try { d = await (await fetch('/api/game')).json(); } catch { d = null; }
    if (!d?.game) { $('#app').innerHTML = '<p>No game yet.</p>'; return; }
    G = d.game;
    const h = G.home;
    let notes = ''; try { notes = localStorage.getItem(NOTES_KEY) || ''; } catch { /* private mode */ }
    $('#app').innerHTML = `
      <div class="area-head">
        <h1>🦃 ${esc(G.name)}</h1>
        <div class="area-tools no-print">
          <button id="dlBtn">⬇ Download picture</button>
          <button id="printBtn">🖨 Print or PDF</button>
          <button id="copyBtn">🔗 Copy link</button>
        </div>
      </div>
      <p class="muted small no-print" style="margin:-.2em 0 .6em">Move and zoom the map to frame it the way you want. The picture and the printout use this view.</p>
      <div class="area-grid">
        <div id="areaMap"></div>
        <div class="area-side">
          <div class="box"><b>The game area</b><ul>
            <li><span class="line-swatch"></span>Stay inside the orange line. Every photo is in there.</li>
            ${h ? `<li>🏠 <b>${esc(h.label)}</b> is home base. Start and finish there.</li>` : ''}
            <li>Find the spot in each photo and take a picture from there. Easy 1 pt, Medium 2, Hard 3.</li>
          </ul></div>
          <div class="box"><b>Notes</b><div id="notes" contenteditable="true" data-placeholder="Tap to add a note: start time, what to bring, phone tips…">${esc(notes)}</div></div>
          <div class="box center"><b>Scan to join</b><div class="qr">${qr(JOIN).createSvgTag({ cellSize: 6, margin: 1, scalable: true })}</div><div class="small">${esc(location.host)}</div></div>
        </div>
      </div>`;
    $('#notes').oninput = () => { try { localStorage.setItem(NOTES_KEY, $('#notes').innerText.trim()); } catch { /* ignore */ } };
    $('#printBtn').onclick = () => window.print();
    $('#copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(location.href); $('#copyBtn').textContent = '✓ Copied'; } catch { prompt('Copy this link:', location.href); } };
    $('#dlBtn').onclick = download;

    map = L.map('areaMap', { zoomSnap: 0.25 }).setView([40.728, -74.005], 15);
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILES, { maxZoom: 20, maxNativeZoom: 19, attribution: ATTR }).addTo(map);
    const b = G.boundary;
    if (b) {
      L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], b], { stroke: false, fillColor: '#000', fillOpacity: 0.3, interactive: false }).addTo(map);
      L.polygon(b, { color: '#e8590c', weight: 4, fill: false, interactive: false }).addTo(map);
    }
    if (h) {
      L.marker([h.lat, h.lng], { icon: L.divIcon({ className: '', html: '<div class="home-pin">🏠</div>', iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false })
        .bindTooltip(esc(h.label), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'home-label' }).addTo(map);
    }
    const fit = [...(b || []), ...(h ? [[h.lat, h.lng]] : [])];
    if (fit.length) map.fitBounds(fit, { padding: [24, 24] });
    window.addEventListener('beforeprint', () => map.invalidateSize());
  }

  // Draw the current map view (tiles, area, home base) plus a legend and QR code into one picture.
  async function download() {
    const btn = $('#dlBtn'); btn.disabled = true; btn.textContent = 'Making picture…';
    try {
      const blob = await render();
      const file = new File([blob], 'photo-hunt-area.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ files: [file], title: G.name }).catch(() => {});
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    } catch (e) {
      console.error(e); alert('Couldn\'t make the picture. Try Print → Save as PDF instead.');
    } finally { btn.disabled = false; btn.textContent = '⬇ Download picture'; }
  }

  async function render() {
    const z = Math.min(19, Math.round(map.getZoom()) + 1); // one zoom level sharper than the screen
    const bounds = map.getBounds();
    const o = map.project(bounds.getNorthWest(), z).round(), se = map.project(bounds.getSouthEast(), z).round();
    let W = se.x - o.x, H = se.y - o.y;
    const k = Math.min(1, 2400 / W); // cap the picture size
    W = Math.round(W * k); H = Math.round(H * k);
    const FOOT = Math.round(Math.max(260, W * 0.17));
    const c = document.createElement('canvas'); c.width = W; c.height = H + FOOT;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8e4dc'; ctx.fillRect(0, 0, W, H);
    // Tiles
    const jobs = [];
    for (let tx = Math.floor(o.x / 256); tx <= Math.floor(se.x / 256); tx++) {
      for (let ty = Math.floor(o.y / 256); ty <= Math.floor(se.y / 256); ty++) {
        const url = TILES.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        jobs.push(new Promise((res) => {
          const im = new Image(); im.crossOrigin = 'anonymous';
          im.onload = () => { ctx.drawImage(im, (tx * 256 - o.x) * k, (ty * 256 - o.y) * k, 256 * k + 0.5, 256 * k + 0.5); res(); };
          im.onerror = () => res();
          im.src = url;
        }));
      }
    }
    await Promise.all(jobs);
    const P = (ll) => { const p = map.project(L.latLng(ll), z); return [(p.x - o.x) * k, (p.y - o.y) * k]; };
    const s = W / 1200; // scale for lines and text
    const b = G.boundary;
    if (b) {
      ctx.beginPath(); ctx.rect(0, 0, W, H);
      b.forEach((ll, i) => { const [x, y] = P(ll); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill('evenodd');
      ctx.beginPath(); b.forEach((ll, i) => { const [x, y] = P(ll); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
      ctx.strokeStyle = '#e8590c'; ctx.lineWidth = 5 * s; ctx.lineJoin = 'round'; ctx.stroke();
    }
    const h = G.home;
    if (h) {
      const [x, y] = P([h.lat, h.lng]), r = 22 * s;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 4 * s; ctx.strokeStyle = '#1f1a17'; ctx.stroke();
      ctx.font = `${Math.round(r * 1.1)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🏠', x, y + 1 * s);
      ctx.font = `700 ${Math.round(17 * s)}px Helvetica, Arial, sans-serif`;
      const tw = ctx.measureText(h.label).width, py = y + r + 6 * s;
      ctx.fillStyle = '#fff'; roundRect(ctx, x - tw / 2 - 8 * s, py, tw + 16 * s, 26 * s, 5 * s); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1 * s; ctx.stroke();
      ctx.fillStyle = '#111'; ctx.fillText(h.label, x, py + 13 * s);
    }
    // Credit line on the map
    ctx.font = `${Math.round(11 * s)}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    const aw = ctx.measureText(ATTR).width; ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(W - aw - 10 * s, H - 17 * s, aw + 10 * s, 17 * s);
    ctx.fillStyle = '#333'; ctx.fillText(ATTR, W - 5 * s, H - 3 * s);
    // Footer: title, legend, notes, QR code
    ctx.fillStyle = '#f7f5f0'; ctx.fillRect(0, H, W, FOOT);
    ctx.fillStyle = '#e8590c'; ctx.fillRect(0, H, W, 6 * s);
    const pad = 28 * s, qs = FOOT - 2 * pad, qx = W - pad - qs, qy = H + pad;
    const q = qr(JOIN), n = q.getModuleCount(), cell = qs / (n + 2);
    ctx.fillStyle = '#fff'; ctx.fillRect(qx, qy, qs, qs); ctx.fillStyle = '#111';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) ctx.fillRect(qx + (col + 1) * cell, qy + (r + 1) * cell, cell + 0.5, cell + 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#111';
    const maxW = qx - 2 * pad;
    let ty = H + pad;
    ctx.font = `700 ${Math.round(34 * s)}px Helvetica, Arial, sans-serif`; ctx.fillText('🦃 ' + G.name, pad, ty, maxW); ty += 48 * s;
    ctx.font = `${Math.round(20 * s)}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = '#e8590c'; ctx.fillRect(pad, ty + 9 * s, 30 * s, 5 * s); ctx.fillStyle = '#111';
    ctx.fillText('Stay inside the orange line. Every photo is in there.', pad + 40 * s, ty, maxW - 40 * s); ty += 32 * s;
    if (h) { ctx.fillText(`🏠 ${h.label} is home base. Start and finish there.`, pad, ty, maxW); ty += 32 * s; }
    ctx.fillText(`Scan the code to join: ${location.host}`, pad, ty, maxW); ty += 36 * s;
    const notes = $('#notes').innerText.trim();
    if (notes) {
      ctx.font = `italic ${Math.round(19 * s)}px Helvetica, Arial, sans-serif`; ctx.fillStyle = '#444';
      wrap(ctx, notes, maxW).slice(0, Math.max(1, Math.floor((H + FOOT - pad - ty) / (26 * s)))).forEach((line) => { ctx.fillText(line, pad, ty, maxW); ty += 26 * s; });
    }
    return new Promise((res, rej) => c.toBlob((bl) => bl ? res(bl) : rej(new Error('toBlob failed')), 'image/png'));
  }

  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function wrap(ctx, text, maxW) {
    const out = [];
    text.split('\n').forEach((para) => {
      let line = '';
      para.split(/\s+/).forEach((w) => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; });
      out.push(line);
    });
    return out;
  }

  boot();
})();
