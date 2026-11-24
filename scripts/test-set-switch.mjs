// Switching between photo sets: Start a new set, Load, and the automatic save of the set in use.
// Local only (it changes the current game's photos):
//   node scripts/test-set-switch.mjs http://localhost:8787 <pw>
const [base, pw] = process.argv.slice(2);
const login = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })).json();
const H = { 'x-admin': login.token };
const admin = (path, method = 'GET', body) => fetch(base + '/api/admin' + path, { method, headers: { ...H, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
let ok = 0, bad = 0; const t = (name, cond, info = '') => { cond ? ok++ : bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 300))); };
const svg = (n) => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><text y="20">${n}</text></svg>`], { type: 'image/svg+xml' });
const addPhoto = (n) => { const fd = new FormData(); fd.append('title', 'New ' + n); fd.append('difficulty', '1'); fd.append('image', svg(n), 'i.svg'); fd.append('thumb', svg(n), 't.svg'); fd.append('lat', 40.727); fd.append('lng', -74.005); return admin('/photos', 'POST', fd); };
const sets = async () => admin('/sets');
const byName = (d, n) => d.sets.find((s) => s.name === n);

let st = await admin('/state');
if (st.game.status !== 'setup') { await admin('/game', 'PATCH', { action: 'end' }); await admin('/game', 'PATCH', { action: 'reset' }); st = await admin('/state'); }
for (const s of (await sets()).sets.filter((s) => s.name.startsWith('Switch '))) await admin('/sets/' + s.id, 'DELETE');
// Start with photos that aren't in any set.
let d0 = await sets();
if (d0.current) { await admin('/sets/' + d0.current, 'PATCH', { name: 'Switch tmp' }); await admin('/sets/' + d0.current, 'DELETE'); }
const n = (await admin('/state')).photos.length;
t('game starts with photos', n > 0, n);

let r = await admin('/sets/fresh', 'POST', { name: 'Switch B' });
t('photos not in a set: asks for a name for them first', r.status === 400 && r.need_old_name, r);
t('nothing changed when it asks', (await admin('/state')).photos.length === n);
r = await admin('/sets/fresh', 'POST', { name: 'Switch B', old_name: 'Switch B' });
t('old and new names must differ', r.status === 400, r);
r = await admin('/sets/fresh', 'POST', { name: 'Switch B', old_name: 'Switch A' });
t('start a new set saves the old photos', r.ok && r.saved === n && r.saved_to === 'Switch A', r);
st = await admin('/state');
let d = await sets();
t('game is empty after starting the new set', st.photos.length === 0);
t('the new set is the one in use', d.current === byName(d, 'Switch B')?.id, d.current);
t('old set has the old photos, new set is empty', byName(d, 'Switch A')?.photos === n && byName(d, 'Switch B')?.photos === 0, d.sets);
t('play area kept', JSON.stringify(st.game.boundary) !== 'null');

await addPhoto(1); await addPhoto(2);
r = await admin('/sets/' + byName(d, 'Switch A').id + '/load', 'POST');
t('loading A saves B first', r.ok && r.saved_to === 'Switch B' && r.photos === n, r);
d = await sets();
t('B kept its 2 new photos', byName(d, 'Switch B')?.photos === 2, d.sets);
t('A is now in use', d.current === byName(d, 'Switch A').id);
t('game has A\'s photos', (await admin('/state')).photos.length === n);

r = await admin('/sets/fresh', 'POST', { name: 'Switch C' });
t('start another set: saves A (in use) without asking', r.ok && r.saved_to === 'Switch A' && r.saved === n, r);
r = await admin('/sets/fresh', 'POST', { name: 'switch c' });
t('a taken name is refused', r.status === 400, r);
r = await admin('/sets/' + byName(d, 'Switch B').id + '/load', 'POST');
t('load B from an empty C: nothing to save, B loads', r.ok && r.photos === 2 && !r.saved_to, r);
d = await sets();
t('C stays as an empty set', byName(d, 'Switch C')?.photos === 0, d.sets);

await addPhoto(3);
r = await admin('/sets/' + byName(d, 'Switch B').id, 'PUT');
t('Save writes the set in use', r.ok && r.photos === 3, r);
await admin('/sets/' + byName(d, 'Switch B').id, 'DELETE');
d = await sets();
t('deleting the set in use leaves the game unsaved', !d.current && (await admin('/state')).photos.length === 3, d.current);

await admin('/game', 'PATCH', { action: 'start' });
t('switching is refused once the game starts', (await admin('/sets/fresh', 'POST', { name: 'Switch D', old_name: 'Switch E' })).status === 400 && (await admin('/sets/' + byName(d, 'Switch A').id + '/load', 'POST')).status === 400);
await admin('/game', 'PATCH', { action: 'end' }); await admin('/game', 'PATCH', { action: 'reset' });
// Put the original photos back and tidy up.
await admin('/sets/' + byName(d, 'Switch A').id + '/load', 'POST');
for (const s of (await sets()).sets.filter((s) => s.name.startsWith('Switch '))) await admin('/sets/' + s.id, 'DELETE');
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
