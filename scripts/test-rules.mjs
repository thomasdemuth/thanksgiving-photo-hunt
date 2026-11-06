// End-to-end rules test (scoring, judge, races, late check-ins, fresh game). Run against LOCAL only:
//   npm run dev   then   node scripts/seed.mjs http://localhost:8787 <pw> && node scripts/test-rules.mjs http://localhost:8787 <pw>

const [base, pw] = process.argv.slice(2);
const H = { 'x-admin': pw };
const admin = (path, method = 'GET', body) => fetch(base + '/api/admin' + path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-player': token } : {}) }, body: body instanceof FormData ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const checkin = (tok, photo, dLat = 0, extra = {}) => { const fd = new FormData(); fd.append('photo_id', photo.id); fd.append('lat', photo.lat + dLat); fd.append('lng', photo.lng); fd.append('acc', 10); for (const [k, v] of Object.entries(extra)) fd.append(k, v); return post('/api/checkin', fd, tok); };
let ok = 0, bad = 0; const t = (name, cond, info = '') => { cond ? ok++ : bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info))); };

let st = await admin('/state');
const team = st.teams[0], team2 = st.teams[1];
const a = await post('/api/join', { name: 'RaceA', team_id: team.id });
const b = await post('/api/join', { name: 'RaceB', team_id: team.id });
const c = await post('/api/join', { name: 'Other', team_id: team2.id });
const taken = (tid) => new Set(st.finds.filter((f) => f.team_id === tid).map((f) => f.photo_id));
const t1 = taken(team.id), t2 = taken(team2.id);
const free = st.photos.filter((p) => p.lat != null && !t1.has(p.id) && !t2.has(p.id));
const [p1, p2, p3, p4, p5] = free;

const [r1, r2] = await Promise.all([checkin(a.token, p1), checkin(b.token, p1)]);
t('race: one auto, one already', [r1.result, r2.result].sort().join() === 'already,auto', [r1, r2]);
const r3 = await checkin(c.token, p1);
t('other team can find the same photo', r3.result === 'auto', r3);
st = await admin('/state');
const before = st.scores.find((s) => s.id === team.id).score;
await admin('/finds', 'POST', { team_id: team.id, photo_id: p1.id });
st = await admin('/state');
t('manual add of already-found photo does not double score', st.scores.find((s) => s.id === team.id).score === before, before);
t('no duplicate counted rows', st.finds.filter((f) => f.team_id === team.id && f.photo_id === p1.id && f.status !== 'rejected').length === 1);

const r4 = await checkin(a.token, p2, 0.0006);
t('close call goes to judge', r4.result === 'pending', r4);
const r4b = await checkin(b.token, p2);
t('teammate blocked while judge checks', r4b.result === 'pending_exists', r4b);
await admin('/finds', 'POST', { team_id: team.id, photo_id: p2.id });
st = await admin('/state');
t('manual add approves the pending find', st.finds.filter((f) => f.team_id === team.id && f.photo_id === p2.id).map((f) => f.status).join() === 'approved');

const far = await checkin(a.token, p3, 0.0031);
t('far distance is rounded to 50 m', far.result === 'far' && far.distance % 50 === 0, far);
const near = await checkin(a.token, p3, 0, { ask_judge: '1' });
t('within radius counts even with ask_judge', near.result === 'auto', near);

const rejectMe = await checkin(b.token, p5, 0.0006);
const rid = (await admin('/state')).finds.find((f) => f.photo_id === p5.id && f.team_id === team.id).id;
await admin('/finds/' + rid, 'PATCH', { status: 'rejected' });
const retry = await checkin(b.token, p5);
t('rejected find can be retried', rejectMe.result === 'pending' && retry.result === 'auto', [rejectMe, retry]);

const v1 = await admin('/photos/' + p3.id, 'PATCH', { radius_m: 0 });
t('radius 0 rejected', v1.status === 400, v1);
const v2 = await admin('/photos/' + p3.id, 'PATCH', { points: '' });
t('empty points rejected', v2.status === 400, v2);
await admin('/photos/' + p3.id, 'PATCH', { difficulty: 3 });
st = await admin('/state');
t('difficulty 3 sets points 3', st.photos.find((p) => p.id === p3.id).points === 3);

const beforeEnd = Date.now() - 300;
await admin('/game', 'PATCH', { action: 'end' });
const late = await checkin(a.token, p4, 0, { at: beforeEnd });
t('late check-in taken before end still counts', late.result === 'auto', late);
const tooLate = await checkin(c.token, p4, 0, { at: Date.now() + 1000 });
t('check-in taken after end is refused', tooLate.result === 'ended', tooLate);
await admin('/game', 'PATCH', { action: 'reopen' });

await post('/api/poll', {}, c.token);
st = await admin('/state');
t('poll without GPS updates last seen', !!st.players.find((p) => p.name === 'Other').last_seen_at);

await post('/api/join', { name: '=HYPERLINK("x")', team_id: team.id });
const csv = await fetch(base + '/api/admin/export', { headers: H }).then((r) => r.text());
t('csv export works', csv.startsWith('time,team'));

const scoreSum = st.scores.reduce((s, x) => s + x.score, 0);
const recount = st.scores.map((tm) => { const seen = new Set(); return st.finds.filter((f) => f.team_id === tm.id && ['auto', 'approved'].includes(f.status) && !seen.has(f.photo_id) && seen.add(f.photo_id)).reduce((s, f) => s + st.photos.find((p) => p.id === f.photo_id).points, 0); }).reduce((s, x) => s + x, 0);
t('scores match an independent recount', scoreSum === recount, [scoreSum, recount]);

await admin('/teams/' + team.id, 'PATCH', { name: 'Turkeys' });
await admin('/game', 'POST', { name: 'Test Hunt' });
st = await admin('/state');
t('fresh game keeps custom team names', st.teams.some((x) => x.name === 'Turkeys'), st.teams.map((x) => x.name));
t('fresh game keeps photos + area', st.photos.length === 60 && st.game.boundary?.length > 3);
const old = await post('/api/poll', {}, a.token);
t('old token rejected after fresh game', old.status === 401);
console.log(`\n${ok} passed, ${bad} failed`);
