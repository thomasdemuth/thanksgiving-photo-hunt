// Host messages to everyone and to one team. Local only (it resets the current game):
//   node scripts/test-messages.mjs http://localhost:8787 <pw>
const [base, pw] = process.argv.slice(2);
const login = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })).json();
const admin = (path, method = 'GET', body) => fetch(base + '/api/admin' + path, { method, headers: { 'x-admin': login.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-player': token } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
let ok = 0, bad = 0; const t = (name, cond, info = '') => { cond ? ok++ : bad++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(info).slice(0, 300))); };

let st = await admin('/state');
if (st.game.status !== 'setup') await admin('/game', 'PATCH', { action: 'end' });
await admin('/game', 'PATCH', { action: 'reset' });
if (st.game.random_teams) await admin('/game', 'PATCH', { random_teams: false });
st = await admin('/state');
const [t1, t2] = st.teams;
const a = await post('/api/join', { name: 'MsgA', team_id: t1.id });
const b = await post('/api/join', { name: 'MsgB', team_id: t2.id });
const poll = (p) => post('/api/poll', {}, p.token);

let r = await admin('/messages', 'POST', { team_id: t1.id, text: '  Go north!  ' });
t('send to one team', r.ok, r);
r = await admin('/messages', 'POST', { team_id: t1.id, text: '   ' });
t('empty message refused', r.status === 400, r);
r = await admin('/messages', 'POST', { team_id: 'nope', text: 'hi' });
t('unknown team refused', r.status === 404, r);
let pa = await poll(a), pb = await poll(b);
t('that team gets it', pa.messages?.length === 1 && pa.messages[0].text === 'Go north!', pa.messages);
t('other team does not', Array.isArray(pb.messages) && pb.messages.length === 0, pb.messages);
const tv = await (await fetch(base + '/api/tv')).json();
t('TV never gets team messages', !JSON.stringify(tv).includes('Go north'), '');
await admin('/game', 'PATCH', { announce: 'Dinner!' });
pa = await poll(a); pb = await poll(b);
t('everyone message still reaches both teams', pa.game.announce?.text === 'Dinner!' && pb.game.announce?.text === 'Dinner!');
st = await admin('/state');
t('admin sees team messages', st.messages?.length === 1 && st.messages[0].team_id === t1.id, st.messages);
r = await admin('/messages/' + st.messages[0].id, 'DELETE');
pa = await poll(a);
t('take down removes it from the phone', r.ok && pa.messages.length === 0, pa.messages);
await admin('/messages', 'POST', { team_id: t2.id, text: 'Bye' });
await admin('/game', 'PATCH', { action: 'reset' });
st = await admin('/state');
t('reset clears team messages', st.messages.length === 0, st.messages);
await admin('/game', 'PATCH', { announce: null });
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
