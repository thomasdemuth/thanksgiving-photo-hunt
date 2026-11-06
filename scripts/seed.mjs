// Fills a game with fake data for testing: 60 photos inside the play area, players, and finds.
// Usage: node scripts/seed.mjs http://localhost:8787 <admin-password>
// WARNING: creates a fresh game (clears players/finds). Don't run against the live site on game day.
const [base = 'http://localhost:8787', pw] = process.argv.slice(2);
if (!pw) { console.error('Usage: node scripts/seed.mjs <base-url> <admin-password>'); process.exit(1); }
const H = { 'x-admin': pw };
const j = (r) => r.json();
const admin = (path, method = 'GET', body) => fetch(base + '/api/admin' + path, { method, headers: { ...H, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body && JSON.stringify(body) }).then(j);
const pub = (path, body, token) => fetch(base + path, { method: 'POST', headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-player': token } : {}) }, body: body instanceof FormData ? body : JSON.stringify(body) }).then(j);

function inside([y, x], poly) {
  let c = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const [yi, xi] = poly[i], [yk, xk] = poly[k];
    if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) c = !c;
  }
  return c;
}
const svg = (n, hue, w, h) => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},45%,38%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="55%" font-family="Georgia" font-size="${w / 5}" fill="#fff" text-anchor="middle" opacity=".9">Spot ${n}</text></svg>`], { type: 'image/svg+xml' });

const state0 = await admin('/state');
await admin('/game', 'POST', { name: state0.game?.name || 'Thanksgiving Photo Hunt' });
let st = await admin('/state');
for (const p of st.photos) await admin('/photos/' + p.id, 'DELETE');
await admin('/game', 'PATCH', { boundary: 'default' });
st = await admin('/state');
const poly = st.game.boundary;
const lats = poly.map((p) => p[0]), lngs = poly.map((p) => p[1]);
const box = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
const spots = [];
while (spots.length < 60) {
  const pt = [box[0] + Math.random() * (box[1] - box[0]), box[2] + Math.random() * (box[3] - box[2])];
  if (inside(pt, poly)) spots.push(pt.map((v) => +v.toFixed(6)));
}
for (let i = 0; i < 60; i++) {
  const fd = new FormData();
  const hue = (i * 37) % 360;
  fd.append('image', svg(i + 1, hue, 1200, 900), 'i.svg'); fd.append('thumb', svg(i + 1, hue, 400, 400), 't.svg');
  if (i !== 59) { fd.append('lat', spots[i][0]); fd.append('lng', spots[i][1]); } // leave one without a pin
  await admin('/photos', 'POST', fd);
}
st = await admin('/state');
for (const [i, p] of st.photos.entries()) {
  const d = i < 25 ? 1 : i < 47 ? 2 : 3;
  await admin('/photos/' + p.id, 'PATCH', { difficulty: d, title: i % 4 === 0 ? ['Red door', 'Corner deli', 'Fire escape', 'Old sign', 'Brick arch'][i % 5] : '' });
}
// Three teams.
const teams = st.teams;
await admin('/teams/' + teams[3].id, 'DELETE');
const names = ['Mike', 'Ann', 'Grandma', 'Tom', 'Lucy', 'Sam', 'Dana', 'Rob', 'Kate', 'Leo', 'Jess'];
const players = [];
for (const [i, n] of names.entries()) {
  const r = await pub('/api/join', { name: n, team_id: teams[i % 3].id });
  players.push({ ...r, team: i % 3 });
}
await admin('/game', 'PATCH', { action: 'start', minutes: 150 });
st = await admin('/state');
// Each team finds a random set; some overlap on purpose.
for (const pl of players) {
  const picks = st.photos.filter((p) => p.lat != null).sort(() => Math.random() - 0.5).slice(0, 4);
  for (const p of picks) {
    const fd = new FormData();
    fd.append('photo_id', p.id);
    const far = Math.random() < 0.2;
    fd.append('lat', p.lat + (far ? 0.0005 : 0.0001)); fd.append('lng', p.lng); fd.append('acc', 12);
    await pub('/api/checkin', fd, pl.token);
  }
  const s = spots[(Math.random() * 59) | 0];
  await pub('/api/poll', { lat: s[0], lng: s[1], acc: 10 }, pl.token);
}
const fin = await admin('/state');
console.log('Seeded:', fin.photos.length, 'photos,', fin.players.length, 'players,', fin.finds.length, 'finds');
console.log(fin.scores.map((t) => `${t.name}: ${t.score}`).join(' | '));
