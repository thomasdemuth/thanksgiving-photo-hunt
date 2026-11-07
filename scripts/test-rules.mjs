// End-to-end rules test (hidden results, judge, replace, races, late photos, reveal, fresh game). Run against LOCAL only:
//   npm run dev   then   node scripts/seed.mjs http://localhost:8787 <pw> && node scripts/test-rules.mjs http://localhost:8787 <pw>

const [base, pw] = process.argv.slice(2);
const H = { 'x-admin': pw };
const admin = (path, method = 'GET', body) => fetch(base + '/api/admin' + path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-player': token } : {}) }, body: body instanceof FormData ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const send = (tok, photo, dLat = 0, extra = {}) => { const fd = new FormData(); fd.append('photo_id', photo.id); fd.append('lat', photo.lat + dLat); fd.append('lng', photo.lng); fd.append('acc', 10); for (const [k, v] of Object.entries(extra)) fd.append(k, v); return post('/api/checkin', fd, tok); };
let ok = 0, bad = 0; const t = (name, cond, info = '') => { cond ? ok++ : bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 400))); };
const scoreOf = (st, tid) => st.scores.find((s) => s.id === tid).score;
const active = (st, tid, pid) => st.finds.filter((f) => f.team_id === tid && f.photo_id === pid);

let st = await admin('/state');
if (st.game.status !== 'live') await admin('/game', 'PATCH', { action: 'reopen' });
const team = st.teams[0], team2 = st.teams[1];
const a = await post('/api/join', { name: 'RaceA', team_id: team.id });
const b = await post('/api/join', { name: 'RaceB', team_id: team.id });
const c = await post('/api/join', { name: 'Other', team_id: team2.id });
st = await admin('/state');
const used = new Set(st.finds.filter((f) => f.team_id === team.id || f.team_id === team2.id).map((f) => f.photo_id));
const [p1, p2, p3, p4, p5, p6, p7] = st.photos.filter((p) => p.lat != null && !used.has(p.id));

// Submitting
const [r1, r2] = await Promise.all([send(a.token, p1), send(b.token, p1)]);
t('race: one submitted, one already', [r1.result, r2.result].sort().join() === 'already,submitted', [r1, r2]);
t('reply says only "submitted" (no distance, no yes/no)', Object.keys(r1.result === 'submitted' ? r1 : r2).sort().join() === 'result,status', [r1, r2]);
const r3 = await send(c.token, p1);
t('another team can send the same photo', r3.result === 'submitted', r3);
const far = await send(a.token, p2, 0.003);
t('a far-away photo is still accepted as submitted', far.result === 'submitted', far);
st = await admin('/state');
t('far photo is marked no (far) on the server', active(st, team.id, p2.id)[0]?.status === 'far', active(st, team.id, p2.id));
t('right spot is marked yes (auto)', active(st, team.id, p1.id)[0]?.status === 'auto');

// What players can see before the reveal
await post('/api/poll', { lat: p1.lat, lng: p1.lng, acc: 8 }, b.token);
await new Promise((r) => setTimeout(r, 5200)); // shared state is cached for 5 s
let pv = await post('/api/poll', {}, a.token);
const myTeam = pv.teams.find((x) => x.id === team.id);
t('players see no points before the reveal', pv.teams.every((x) => x.score === undefined && x.found === undefined && x.by_diff === undefined), pv.teams[0]);
t('players see photos sent per team and per person', myTeam.submitted >= 2 && myTeam.roster.find((r) => r.name === 'RaceA')?.submitted >= 1, myTeam);
t('players see only their own team\'s finds', pv.finds.every((f) => f.team_id === team.id), pv.finds.map((f) => f.team_id));
t('finds carry no yes/no before the reveal', pv.finds.every((f) => f.status === undefined && f.counted === undefined));
t('other teams show up only as anonymous events', pv.events.some((e) => e.team_id === team2.id) && pv.events.every((e) => Object.keys(e).sort().join() === 'at,id,team_id'));
t('teammate location is shared', pv.mates.some((m) => m.name === 'RaceB'), pv.mates);
t('other teams\' locations are not shared', !(await post('/api/poll', {}, c.token)).mates.some((m) => m.name === 'RaceB'));
t('no player locations leak in the poll', pv.players === undefined);
t('roster carries no player ids', pv.teams.every((x) => x.roster.every((r) => r.id === undefined)));

// Speed: quick "nothing new" replies, and changes show up on the very next poll
const full = await post('/api/poll', {}, a.token);
const quiet = await post('/api/poll', { v: full.v }, a.token);
t('poll with the latest version gets a tiny "nothing new" reply', quiet.same === true && quiet.teams === undefined && Array.isArray(quiet.mates), Object.keys(quiet));
const pNew = st.photos.filter((p) => p.lat != null && !st.finds.some((f) => f.team_id === team.id && f.photo_id === p.id)).at(-1);
await send(b.token, pNew);
const after = await post('/api/poll', { v: full.v }, a.token);
t('a teammate\'s photo shows up on the next poll (no cache delay)', !after.same && after.finds.some((f) => f.photo_id === pNew.id), after.same);
await admin('/finds', 'POST', { team_id: team2.id, photo_id: pNew.id });
const qv1 = await admin('/tv?since=' + Date.now());
const qv2 = await admin('/tv?since=' + Date.now() + '&v=' + encodeURIComponent(qv1.v));
t('TV gets "nothing new" too, but still gets players', qv2.same === true && qv2.players.length > 0 && qv2.finds === undefined);
await admin('/finds/' + (await admin('/state')).finds.find((f) => f.team_id === team2.id && f.photo_id === pNew.id).id, 'PATCH', { status: 'rejected' });
const qv3 = await admin('/tv?since=' + Date.now() + '&v=' + encodeURIComponent(qv1.v));
t('a judge call shows on the TV right away', !qv3.same && qv3.finds.some((f) => f.photo_id === pNew.id && f.status === 'rejected'));
await admin('/finds/' + qv3.finds.find((f) => f.team_id === team2.id && f.photo_id === pNew.id).id, 'DELETE');
st = await admin('/state');

// Judge
const close = await send(a.token, p3, 0.0006);
st = await admin('/state');
const pend = active(st, team.id, p3.id)[0];
t('close call goes to the judge', close.result === 'submitted' && pend?.status === 'pending', pend);
const before = scoreOf(st, team.id);
await admin('/finds/' + pend.id, 'PATCH', { status: 'approved' });
st = await admin('/state');
t('approving adds the points and stamps the time', scoreOf(st, team.id) === before + p3.points && active(st, team.id, p3.id)[0].judged_at > 0);
const autoRow = active(st, team.id, p1.id)[0];
await admin('/finds/' + autoRow.id, 'PATCH', { status: 'rejected' });
st = await admin('/state');
t('judge can overturn a yes', scoreOf(st, team.id) === before + p3.points - p1.points);
await admin('/finds/' + autoRow.id, 'PATCH', { status: 'approved' });
await admin('/finds', 'POST', { team_id: team.id, photo_id: p2.id });
st = await admin('/state');
t('hand-add approves the far answer without a duplicate', active(st, team.id, p2.id).map((f) => f.status).join() === 'approved', active(st, team.id, p2.id));
await admin('/finds', 'POST', { team_id: team.id, photo_id: p2.id });
st = await admin('/state');
t('hand-add twice still one row', active(st, team.id, p2.id).length === 1);
const [hp] = st.photos.filter((p) => p.lat != null && !st.finds.some((f) => f.team_id === team.id && f.photo_id === p.id));
const sentBefore = (await post('/api/poll', {}, a.token)).teams.find((x) => x.id === team.id).submitted;
await admin('/finds', 'POST', { team_id: team.id, photo_id: hp.id });
await new Promise((r) => setTimeout(r, 5200));
pv = await post('/api/poll', {}, a.token);
t('a hand-added find stays hidden from players before the reveal', !pv.finds.some((f) => f.photo_id === hp.id) && pv.teams.find((x) => x.id === team.id).submitted === sentBefore, pv.teams.find((x) => x.id === team.id));

// Submit again
await send(b.token, p4, 0.003);
const again = await send(b.token, p4, 0, { replace: '1' });
st = await admin('/state');
t('submit again replaces the old answer', again.result === 'submitted' && active(st, team.id, p4.id).map((f) => f.status).join() === 'auto', active(st, team.id, p4.id));
await Promise.all([send(a.token, p4, 0.003, { replace: '1' }), send(b.token, p4, 0.003, { replace: '1' })]);
st = await admin('/state');
t('two "submit again" taps at once leave one answer', active(st, team.id, p4.id).length === 1, active(st, team.id, p4.id));
// A "submit again" photo taken earlier (offline) must not overwrite a teammate's newer answer.
await send(b.token, p4, 0, { replace: '1' });
const stale = await send(a.token, p4, 0.003, { replace: '1', at: Date.now() - 120000 });
st = await admin('/state');
t('a late resubmit does not overwrite a newer answer', stale.result === 'submitted' && active(st, team.id, p4.id).map((f) => f.status).join() === 'auto', active(st, team.id, p4.id));
pv = await post('/api/poll', {}, a.token);
t('replacing doesn\'t inflate the sent count', pv.finds.filter((f) => f.photo_id === p4.id).length === 1);

// Start/reveal guards
t('starting a live game again is refused', (await admin('/game', 'PATCH', { action: 'start' })).status === 400);
t('reveal before the end is refused', (await admin('/game', 'PATCH', { action: 'reveal' })).status === 400);

// End, late photos
const beforeEnd = Date.now() - 300;
await admin('/game', 'PATCH', { action: 'end' });
const late = await send(a.token, p5, 0, { at: beforeEnd });
t('photo taken before the end still counts if it arrives late', late.result === 'submitted', late);
const tooLate = await send(c.token, p6, 0, { at: Date.now() + 1000 });
t('photo taken after the end is refused', tooLate.result === 'ended', tooLate);
pv = await post('/api/poll', {}, a.token);
t('still hidden after the end, until the reveal', pv.game.status === 'ended' && !pv.game.revealed && pv.teams.every((x) => x.score === undefined));

// Reveal
await admin('/game', 'PATCH', { action: 'reveal' });
pv = await post('/api/poll', {}, a.token);
st = await admin('/state');
t('after the reveal players see real scores', pv.game.revealed && pv.teams.find((x) => x.id === team.id).score === scoreOf(st, team.id));
t('photos arriving after the reveal are refused', (await send(a.token, p6, 0, { at: beforeEnd })).result === 'ended');
t('after the reveal each find says if it counted', pv.finds.filter((f) => f.team_id === team.id).every((f) => typeof f.counted === 'boolean'));
t('other teams\' spots stay hidden after the reveal', pv.finds.filter((f) => f.team_id !== team.id).every((f) => f.lat === null));
await admin('/game', 'PATCH', { action: 'hide' });
t('results can be hidden again', (await post('/api/poll', {}, a.token)).teams.every((x) => x.score === undefined));
await admin('/game', 'PATCH', { action: 'reveal' });
await admin('/game', 'PATCH', { action: 'reopen' });
st = await admin('/state');
t('reopening hides the results', st.game.status === 'live' && !st.game.revealed_at);

// TV feed
const tv = await admin('/tv?since=0');
t('TV gets scores, finds with proof info, players and trails', tv.teams[0].score !== undefined && tv.finds.length > 0 && 'proof_key' in tv.finds[0] && Array.isArray(tv.pings) && tv.players.length > 0);
const tv2 = await admin('/tv?since=' + Date.now());
t('TV trail updates are incremental', tv2.pings.length === 0, tv2.pings.length);

// Bookkeeping
await post('/api/poll', {}, c.token);
st = await admin('/state');
t('poll without GPS updates last seen', !!st.players.find((p) => p.name === 'Other').last_seen_at);
t('replaced answers are hidden from the admin list', st.finds.every((f) => f.status !== 'replaced'));
const recount = st.scores.map((tm) => { const seen = new Set(); return st.finds.filter((f) => f.team_id === tm.id && ['auto', 'approved'].includes(f.status) && !seen.has(f.photo_id) && seen.add(f.photo_id)).reduce((s, f) => s + st.photos.find((p) => p.id === f.photo_id).points, 0); });
t('scores match an independent recount', JSON.stringify(st.scores.map((x) => x.score)) === JSON.stringify(recount), [st.scores.map((x) => x.score), recount]);
await post('/api/join', { name: '=HYPERLINK("x")', team_id: team.id });
const csv = await fetch(base + '/api/admin/export', { headers: H }).then((r) => r.text());
t('csv export works', csv.startsWith('time,team'));
const v1 = await admin('/photos/' + p7.id, 'PATCH', { radius_m: 0 });
t('radius 0 rejected', v1.status === 400, v1);
const v2 = await admin('/photos/' + p7.id, 'PATCH', { points: '' });
t('empty points rejected', v2.status === 400, v2);

// Radius changes re-check answers already sent (judge calls stay)
await admin('/game', 'PATCH', { action: 'reopen' });
st = await admin('/state');
const rq = st.photos.filter((p) => p.lat != null && !st.finds.some((f) => f.team_id === team2.id && f.photo_id === p.id));
await send(c.token, rq[0], 0.0009); // ~100 m away
await send(c.token, rq[1], 0.0009);
st = await admin('/state');
const judged = active(st, team2.id, rq[1].id)[0];
await admin('/finds/' + judged.id, 'PATCH', { status: 'rejected' });
const one = await admin('/photos/' + rq[0].id, 'PATCH', { radius_m: 150 });
st = await admin('/state');
t('a bigger radius on one photo turns a "no" into a "yes"', active(st, team2.id, rq[0].id)[0].status === 'auto' && one.rechecked >= 1, [active(st, team2.id, rq[0].id), one]);
const all = await admin('/photos', 'PATCH', { radius_m: 150 });
st = await admin('/state');
t('set-all changes every photo', all.photos === st.photos.length && st.photos.every((p) => p.radius_m === 150), all);
t('set-all leaves the judge\'s calls alone', active(st, team2.id, rq[1].id)[0].status === 'rejected');
await admin('/photos', 'PATCH', { radius_m: 20, difficulty: 3 });
st = await admin('/state');
t('set-all can target one difficulty', st.photos.every((p) => p.radius_m === (p.difficulty === 3 ? 20 : 150)));
t('set-all rejects a silly radius', (await admin('/photos', 'PATCH', { radius_m: 2 })).status === 400);
const moved = await admin('/photos/' + rq[0].id, 'PATCH', { lat: rq[0].lat + 0.01 });
st = await admin('/state');
t('moving a pin re-checks answers too', active(st, team2.id, rq[0].id)[0].status === 'far' && moved.rechecked >= 1, active(st, team2.id, rq[0].id));
await admin('/photos', 'PATCH', { radius_m: 40 });

// Reset one judge call, then reset the whole game
await admin('/game', 'PATCH', { action: 'reopen' });
const rp = st.photos.filter((p) => p.lat != null && !st.finds.some((f) => f.team_id === team2.id && f.photo_id === p.id))[0];
await send(c.token, rp, 0.003);
st = await admin('/state');
const rf = active(st, team2.id, rp.id)[0];
await admin('/finds/' + rf.id, 'PATCH', { status: 'approved' });
await admin('/finds/' + rf.id, 'PATCH', { status: 'reset' });
st = await admin('/state');
t('reset puts a judged photo back to what GPS said', active(st, team2.id, rp.id)[0].status === 'far' && !active(st, team2.id, rp.id)[0].judged_at, active(st, team2.id, rp.id));
const playersBefore = st.players.length;
await admin('/game', 'PATCH', { action: 'end' });
await admin('/game', 'PATCH', { action: 'reveal' });
await admin('/game', 'PATCH', { action: 'reset' });
st = await admin('/state');
const tvr = await admin('/tv?since=0');
t('game reset clears photos sent, scores and trails', st.finds.length === 0 && st.scores.every((x) => x.score === 0) && tvr.pings.length === 0, [st.finds.length, tvr.pings.length]);
t('game reset keeps players and goes back to not started', st.players.length === playersBefore && st.game.status === 'setup' && !st.game.revealed_at && st.players.every((p) => p.last_lat == null));
t('players stay signed in after a reset', (await post('/api/poll', {}, c.token)).status === 200);
// Lobby and countdown
const sw = await post('/api/team', { team_id: team.id }, c.token);
st = await admin('/state');
t('players can switch teams in the lobby', sw.ok && st.players.find((p) => p.name === 'Other').team_id === team.id, sw);
await post('/api/team', { team_id: team2.id }, c.token);
await admin('/game', 'PATCH', { action: 'start' });
const pvS = await post('/api/poll', {}, c.token);
t('start gives a 10 second countdown first', pvS.game.status === 'starting' && pvS.game.started_at - pvS.now > 8000 && pvS.game.started_at - pvS.now <= 10000, [pvS.game.status, pvS.game.started_at - pvS.now]);
t('no photos during the countdown', (await send(c.token, rp)).result === 'not_started');
t('teams are locked once the game starts', (await post('/api/team', { team_id: team.id }, c.token)).status === 400);
t('starting again during the countdown is refused', (await admin('/game', 'PATCH', { action: 'start' })).status === 400);
await new Promise((r) => setTimeout(r, 10300));
const pvL = await post('/api/poll', { v: pvS.v }, c.token);
t('after the countdown the game is live (phones get the change)', !pvL.same && pvL.game.status === 'live', pvL.game?.status);
t('a reset game can start again and take photos', (await send(c.token, rp)).result === 'submitted');

// Fresh game
await admin('/teams/' + team.id, 'PATCH', { name: 'Turkeys' });
await admin('/game', 'POST', { name: 'Test Hunt' });
st = await admin('/state');
t('fresh game keeps custom team names', st.teams.some((x) => x.name === 'Turkeys'), st.teams.map((x) => x.name));
t('fresh game keeps photos + area, starts hidden', st.photos.length === 60 && st.game.boundary?.length > 3 && !st.game.revealed_at);
t('old token rejected after fresh game', (await post('/api/poll', {}, a.token)).status === 401);
console.log(`\n${ok} passed, ${bad} failed`);
