// Photo sets test: save, list, load (photos, play area, home base swap; finds cleared), the "only in setup" rule,
// update, rename, delete. Run against LOCAL only: it makes a fresh game.
//   node scripts/test-sets.mjs http://localhost:8788 <pw>

const [base, pw] = process.argv.slice(2);
if (!base || !pw) { console.error('Usage: node scripts/test-sets.mjs <base-url> <admin-password>'); process.exit(1); }
if (!/localhost|127\.0\.0\.1/.test(base)) { console.error('Local only: this test makes a fresh game.'); process.exit(1); }
const H = { 'x-admin': pw };
const admin = (path, method = 'GET', body) => fetch(base + '/api/admin' + path, {
  method, headers: { ...H, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
  body: body instanceof FormData ? body : body && JSON.stringify(body),
}).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-player': token } : {}) }, body: body instanceof FormData ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
let ok = 0, bad = 0; const t = (name, cond, info = '') => { cond ? ok++ : bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 400))); };

const img = (label) => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text y="20">${label}</text></svg>`], { type: 'image/svg+xml' });
async function addPhoto(title, lat, lng) {
  const fd = new FormData();
  fd.append('image', img(title), 'i.svg'); fd.append('thumb', img(title), 't.svg');
  fd.append('title', title); fd.append('lat', lat); fd.append('lng', lng);
  return admin('/photos', 'POST', fd);
}
async function clearPhotos() { for (const p of (await admin('/state')).photos) await admin('/photos/' + p.id, 'DELETE'); }
const tag = Date.now().toString(36);
const nameA = `Test A ${tag}`, nameB = `Test B ${tag}`;
const areaA = [[40.72, -74.01], [40.73, -74.01], [40.73, -74.0]];
const areaB = [[40.70, -74.02], [40.71, -74.02], [40.71, -74.01], [40.70, -74.01]];

// Game with content A
await admin('/game', 'POST', { name: 'Sets test' });
await clearPhotos();
for (const [i, title] of ['A1', 'A2', 'A3'].entries()) await addPhoto(title, 40.725 + i * 0.001, -74.005);
await admin('/game', 'PATCH', { boundary: areaA, home: { lat: 40.726, lng: -74.006, label: 'Grandma A' } });
let st = await admin('/state');
const keysA = st.photos.map((p) => p.image_key).sort();

// Save
const sA = await admin('/sets', 'POST', { name: nameA });
t('save as new set', sA.ok && sA.photos === 3, sA);
t('same name again is refused', (await admin('/sets', 'POST', { name: nameA.toLowerCase() })).status === 400);
t('empty name is refused', (await admin('/sets', 'POST', { name: '  ' })).status === 400);

// Game with content B (no home base)
await clearPhotos();
for (const title of ['B1', 'B2']) await addPhoto(title, 40.705, -74.015);
await admin('/game', 'PATCH', { boundary: areaB, home: null });
const sB = await admin('/sets', 'POST', { name: nameB });
t('save a second set', sB.ok && sB.photos === 2, sB);

// List
let list = await admin('/sets');
const rowA = list.sets.find((s) => s.id === sA.id), rowB = list.sets.find((s) => s.id === sB.id);
t('list shows both sets with photo counts', rowA?.photos === 3 && rowB?.photos === 2 && rowA.name === nameA, list.sets);
t('list shows which set has a home base', rowA?.has_home === 1 && rowB?.has_home === 0, [rowA, rowB]);

// Load only in setup
const p = await post('/api/join', { name: 'SetTester', team_id: st.teams[0].id });
await admin('/game', 'PATCH', { action: 'start', countdown: 0 });
st = await admin('/state');
const fd = new FormData(); fd.append('photo_id', st.photos[0].id); fd.append('lat', st.photos[0].lat); fd.append('lng', st.photos[0].lng); fd.append('acc', 5);
const sent = await post('/api/checkin', fd, p.token);
t('a find is sent while live', sent.result === 'submitted', sent);
let r = await admin(`/sets/${sA.id}/load`, 'POST');
t('load is refused while the game is live (400, plain message)', r.status === 400 && /before the game starts/.test(r.error), r);
await admin('/game', 'PATCH', { action: 'end' });
r = await admin(`/sets/${sA.id}/load`, 'POST');
t('load is refused after the game ends', r.status === 400, r);

// Load A in setup
await admin('/game', 'PATCH', { action: 'setup' });
st = await admin('/state');
t('the find is still there before loading', st.finds.length === 1, st.finds.length);
const v0 = st.game.version;
r = await admin(`/sets/${sA.id}/load`, 'POST');
st = await admin('/state');
t('load set A', r.ok && r.photos === 3, r);
t('photos swapped to A (same titles, same pictures)', st.photos.map((x) => x.title).join() === 'A1,A2,A3' && st.photos.map((x) => x.image_key).sort().join() === keysA.join(), st.photos.map((x) => x.title));
t('photo fields copied (pin, radius, points)', st.photos.every((x) => x.lat != null && x.radius_m === 40 && x.points === 1));
t('play area swapped to A', JSON.stringify(st.game.boundary) === JSON.stringify(areaA), st.game.boundary);
t('home base swapped to A', st.game.home?.label === 'Grandma A' && st.game.home.lat === 40.726, st.game.home);
t('finds cleared', st.finds.length === 0, st.finds.length);
t('game version bumped (phones and TV refresh)', st.game.version > v0, [v0, st.game.version]);
const img200 = (await fetch(base + '/img/' + st.photos[0].image_key)).status;
t('loaded pictures are served', img200 === 200, img200);

// Load B
await admin(`/sets/${sB.id}/load`, 'POST');
st = await admin('/state');
t('load set B swaps photos, area, and clears home', st.photos.map((x) => x.title).join() === 'B1,B2' && JSON.stringify(st.game.boundary) === JSON.stringify(areaB) && st.game.home === null, [st.photos.length, st.game.home]);

// Update A with what's here now (B's content)
r = await admin(`/sets/${sA.id}`, 'PUT');
list = await admin('/sets');
t('update overwrites a set with the game', r.ok && list.sets.find((s) => s.id === sA.id).photos === 2 && list.sets.find((s) => s.id === sA.id).has_home === 0, r);

// Rename
r = await admin(`/sets/${sA.id}`, 'PATCH', { name: nameA + ' renamed' });
list = await admin('/sets');
t('rename', r.ok && list.sets.find((s) => s.id === sA.id).name === nameA + ' renamed', r);
t('rename to a taken name is refused', (await admin(`/sets/${sA.id}`, 'PATCH', { name: nameB })).status === 400);

// Delete
const keyB = st.photos[0].image_key;
for (const s of [sA, sB]) await admin(`/sets/${s.id}`, 'DELETE');
list = await admin('/sets');
t('delete removes both sets', !list.sets.some((s) => s.id === sA.id || s.id === sB.id), list.sets);
t('deleting a set keeps the game photos', (await admin('/state')).photos.length === 2);
t('deleting a set keeps the pictures in storage', (await fetch(base + '/img/' + keyB)).status === 200);
t('a deleted set is 404', (await admin(`/sets/${sA.id}/load`, 'POST')).status === 404);

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
