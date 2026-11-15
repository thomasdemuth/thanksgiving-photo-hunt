// Thanksgiving Photo Hunt: one Worker serving the JSON API and photos.
// Static files in /public are served by Cloudflare before this runs.

const DEFAULT_TEAMS = [
  ['Red', '#ee352e'], ['Blue', '#0039a6'], ['Green', '#00933c'], ['Orange', '#e8590c'],
];
// Extra teams for "Random teams" when the host asks for more than four.
const MORE_TEAMS = [['Purple', '#6f42c1'], ['Yellow', '#d4a106'], ['Teal', '#0f8b8d'], ['Pink', '#d63384']];
const POINTS = { 1: 1, 2: 2, 3: 3 };
// Random teams: players join without a team and only see theirs once the host reveals the shuffle.
const teamsHidden = (game) => !!game.random_teams && !game.teams_ready;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// The team with the fewest players (ties broken at random), for late joiners once teams are picked.
async function smallestTeam(env, gameId) {
  const rows = (await env.DB.prepare(`SELECT t.id, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id AND p.kicked_at IS NULL) AS n
    FROM teams t WHERE t.game_id = ?`).bind(gameId).all()).results;
  if (!rows.length) return '';
  const min = Math.min(...rows.map((r) => r.n));
  return shuffle(rows.filter((r) => r.n === min))[0].id;
}
// Default play area: Canal St (6th Ave to Greenwich), Greenwich St (Canal to Christopher),
// Christopher St (Greenwich to 6th Ave), 6th Ave (Christopher to Canal). Traced from OpenStreetMap.
const DEFAULT_BOUNDARY = [[40.721882,-74.005355],[40.723845,-74.008033],[40.724026,-74.008445],[40.724495,-74.008916],[40.724597,-74.00921],[40.724722,-74.009309],[40.726,-74.0091],[40.7296,-74.0084],[40.732877,-74.007514],[40.734146,-73.999182],[40.729621,-74.002232],[40.72212,-74.005379]];
const STATE_TTL_MS = 60000; // safety net only: the cache is keyed on the game's version
const PING_EVERY_MS = 12000;
const COUNTDOWN_MS = 10000; // "Get ready… 10, 9, 8…" on every phone and the TV before the hunt opens // how often a phone's location is saved (teammates and the TV see it)

// Per-isolate cache of the shared game state, so a burst of polls costs one set of reads.
const stateCache = new Map();
// Every write bumps the game's version. Phones and the TV send the last version they saw and get a
// tiny "nothing new" reply until it changes, so they can check every few seconds cheaply.
async function bump(env, gameId) {
  stateCache.delete(gameId);
  await env.DB.prepare('UPDATE games SET version = version + 1 WHERE id = ?').bind(gameId).run();
}
const tag = (game) => `${game.id}:${game.version || 0}:${effectiveStatus(game)}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/img/')) return serveImage(env, url.pathname.slice(5));
      if (url.pathname.startsWith('/api/auth/')) return await auth(request, env, url);
      if (url.pathname.startsWith('/api/admin/')) {
        const who = await adminFromRequest(env, request);
        if (!who) return json({ error: 'Wrong password' }, 401);
        return await admin(request, env, url, who);
      }
      if (url.pathname.startsWith('/api/')) return await player(request, env, url);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong on our end. Please try again.' }, 500);
    }
  },
};

// ---------- admin sign-in ----------
// Two ways in: the main password (ADMIN_PASSWORD secret), or a personal password someone set through a
// one-time invite link. Signing in gives the browser a session token; only its hash is stored.
const INVITE_DAYS = 7, SESSION_DAYS = 60, PBKDF2_ROUNDS = 10000; // rounds kept modest for Workers' CPU limit
const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(24)));
const sha256 = async (s) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
async function pbkdf2(password, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS }, key, 256);
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)) };
}
// Compare without leaking how many characters matched.
async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(enc.encode(x), enc.encode(y));
}
const sessionCache = new Map(); // token hash -> { who, at }, so polling doesn't hit the database every time
async function adminFromRequest(env, request) {
  const token = request.headers.get('x-admin');
  if (!token) return null;
  if (await sameSecret(token, env.ADMIN_PASSWORD)) return { id: null, name: 'Host' }; // older browsers still hold the main password
  const th = await sha256(token);
  const hit = sessionCache.get(th);
  if (hit && now() - hit.at < 60000) return hit.who;
  const row = await env.DB.prepare(
    'SELECT s.admin_id, a.name FROM admin_sessions s LEFT JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?'
  ).bind(th, now()).first();
  // A personal session whose admin was removed doesn't count.
  const who = row && (row.admin_id === null || row.name) ? { id: row.admin_id, name: row.name || 'Host' } : null;
  if (who) sessionCache.set(th, { who, at: now() }); else sessionCache.delete(th);
  return who;
}
async function newSession(env, adminId) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), adminId, now(), now() + SESSION_DAYS * 86400000).run();
  return token;
}
// Slow down password guessing: 8 wrong tries from one address within 10 minutes locks it out for a while.
const failures = new Map();
function tooManyFailures(ip) { const f = failures.get(ip); return f && f.n >= 8 && now() - f.at < 600000; }
function noteFailure(ip) { const f = failures.get(ip); failures.set(ip, f && now() - f.at < 600000 ? { n: f.n + 1, at: f.at } : { n: 1, at: now() }); }

async function auth(request, env, url) {
  const path = url.pathname.replace('/api/auth', ''), method = request.method;
  const ip = request.headers.get('cf-connecting-ip') || 'local';

  // Sign in with the main password or a personal one.
  if (path === '/login' && method === 'POST') {
    if (tooManyFailures(ip)) return json({ error: 'Too many wrong tries. Wait a few minutes and try again.' }, 429);
    const { password } = await request.json().catch(() => ({}));
    const pw = String(password || '');
    if (await sameSecret(pw, env.ADMIN_PASSWORD)) return json({ token: await newSession(env, null), name: 'Host' });
    const admins = (await env.DB.prepare('SELECT * FROM admins ORDER BY created_at LIMIT 10').all()).results;
    for (const a of admins) {
      const { hash } = await pbkdf2(pw, a.salt);
      if (await sameSecret(hash, a.hash)) return json({ token: await newSession(env, a.id), name: a.name });
    }
    noteFailure(ip);
    return json({ error: 'Wrong password.' }, 401);
  }

  // Look at an invite link before setting a password.
  if (path === '/invite' && method === 'GET') {
    const t = url.searchParams.get('t') || '';
    const inv = t && await env.DB.prepare('SELECT name, expires_at, used_at FROM admin_invites WHERE token_hash = ?').bind(await sha256(t)).first();
    if (!inv || inv.used_at || inv.expires_at < now()) return json({ ok: false });
    return json({ ok: true, name: inv.name });
  }

  // Set a password through an invite link. Works once.
  if (path === '/accept' && method === 'POST') {
    const { token, password } = await request.json().catch(() => ({}));
    const pw = String(password || '');
    if (pw.length < 8) return json({ error: 'Use at least 8 characters.' }, 400);
    if (await sameSecret(pw, env.ADMIN_PASSWORD)) return json({ error: 'Pick a different password from the main one.' }, 400);
    const th = await sha256(String(token || ''));
    // Claim the invite first, so the same link can't be used twice at once.
    const claim = await env.DB.prepare('UPDATE admin_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(now(), th, now()).run();
    if (!claim.meta.changes) return json({ error: 'This link has expired or was already used. Ask for a new one.' }, 400);
    const inv = await env.DB.prepare('SELECT name FROM admin_invites WHERE token_hash = ?').bind(th).first();
    const { salt, hash } = await pbkdf2(pw);
    // Same name again (e.g. a new link after forgetting the password): replace the password and sign out old devices.
    const existing = await env.DB.prepare('SELECT id FROM admins WHERE name_key = ?').bind(nameKey(inv.name)).first();
    let adminId = existing?.id;
    if (adminId) {
      await env.DB.batch([
        env.DB.prepare('UPDATE admins SET salt = ?, hash = ? WHERE id = ?').bind(salt, hash, adminId),
        env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(adminId),
      ]);
      sessionCache.clear();
    } else {
      adminId = id();
      await env.DB.prepare('INSERT INTO admins (id, name, name_key, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(adminId, inv.name, nameKey(inv.name), salt, hash, now()).run();
    }
    return json({ token: await newSession(env, adminId), name: inv.name });
  }

  return json({ error: 'Not found' }, 404);
}

// ---------- helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const now = () => Date.now();
const nameKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function serveImage(env, key) {
  const obj = await env.PHOTOS.getWithMetadata(key, { type: 'stream', cacheTtl: 3600 });
  if (!obj.value) return new Response('Not found', { status: 404 });
  return new Response(obj.value, {
    headers: {
      'content-type': obj.metadata?.type || 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

async function putImage(env, file, prefix) {
  if (!file || typeof file === 'string') return null;
  const key = `${prefix}/${id()}.jpg`;
  await env.PHOTOS.put(key, await file.arrayBuffer(), { metadata: { type: file.type || 'image/jpeg' } });
  return key;
}

async function currentGame(env) {
  return env.DB.prepare('SELECT * FROM games ORDER BY created_at DESC LIMIT 1').first();
}

// A game counts as live only between Start and End (or the end time passing).
// setup → starting (10 s countdown) → live → ended
function effectiveStatus(game) {
  if (game.status === 'live' && game.started_at && now() < game.started_at) return 'starting';
  if (game.status === 'live' && game.ends_at && now() > game.ends_at) return 'ended';
  return game.status;
}

// Find statuses. Players never see these until the admin reveals results.
//   auto     = taken within the photo's radius (counts)
//   pending  = close call, waiting for the judge
//   far      = too far away (doesn't count unless the judge approves it)
//   approved / rejected = the judge's call
//   replaced = the team submitted this photo again; only the newest answer counts
const COUNTS = new Set(['auto', 'approved']);

// Yes / judge / no from the distance. A little extra room for poor GPS between tall buildings.
function gpsVerdict(distance, radius, acc) {
  const slack = Math.max(radius * 2, radius + Math.min(acc || 0, 60));
  return distance <= radius ? 'auto' : distance <= slack ? 'pending' : 'far';
}

// After a photo's radius or pin changes, re-mark the answers already sent for it.
// The judge's own calls (approved / rejected) are left alone. Returns how many changed.
async function recheck(env, gameId, photoIds) {
  if (photoIds && !photoIds.length) return 0;
  const rows = (await env.DB.prepare(
    `SELECT f.id, f.status, f.lat, f.lng, f.accuracy_m, p.lat AS plat, p.lng AS plng, p.radius_m, p.id AS pid
     FROM finds f JOIN photos p ON p.id = f.photo_id
     WHERE f.game_id = ? AND f.status IN ('auto','pending','far') AND f.lat IS NOT NULL AND p.lat IS NOT NULL`
  ).bind(gameId).all()).results.filter((r) => !photoIds || photoIds.includes(r.pid));
  const updates = [];
  for (const r of rows) {
    const distance = Math.round(haversine(r.lat, r.lng, r.plat, r.plng));
    const status = gpsVerdict(distance, r.radius_m, r.accuracy_m);
    updates.push(env.DB.prepare('UPDATE finds SET status = ?, distance_m = ? WHERE id = ? AND judged_at IS NULL').bind(status, distance, r.id));
  }
  for (let i = 0; i < updates.length; i += 50) await env.DB.batch(updates.slice(i, i + 50));
  return rows.length;
}

// Shared state for one game. Holds everything (locations, statuses); callers decide what each viewer may see.
async function gameState(env, game) {
  // The cache entry is tied to the game row, so a reveal/hide/end seen by any request skips stale data.
  const ver = [game.version || 0, effectiveStatus(game), game.ends_at, game.revealed_at, game.started_at].join('|');
  const hit = stateCache.get(game.id);
  if (hit && hit.ver === ver && now() - hit.at < STATE_TTL_MS) return hit.data;
  const [teams, photos, finds, players] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, color FROM teams WHERE game_id = ? ORDER BY rowid').bind(game.id),
    env.DB.prepare('SELECT id, title, difficulty, points, hint, image_key, thumb_key FROM photos WHERE game_id = ? ORDER BY sort, rowid').bind(game.id),
    env.DB.prepare(`SELECT f.id, f.photo_id, f.team_id, f.player_id, f.status, f.lat, f.lng, f.accuracy_m, f.distance_m, f.proof_key,
                           f.created_at, f.judged_at, f.rowid AS seq, p.name AS player_name
                    FROM finds f LEFT JOIN players p ON p.id = f.player_id
                    WHERE f.game_id = ? AND f.status != 'replaced' ORDER BY f.created_at, f.rowid`).bind(game.id),
    env.DB.prepare('SELECT id, team_id, name, adult FROM players WHERE game_id = ? AND kicked_at IS NULL ORDER BY created_at').bind(game.id),
  ]);
  const pts = Object.fromEntries(photos.results.map((p) => [p.id, p.points]));
  const diff = Object.fromEntries(photos.results.map((p) => [p.id, p.difficulty]));
  const scored = teams.results.map((t) => {
    const all = finds.results.filter((f) => f.team_id === t.id);
    // Each photo counts once per team, even if two rows slipped in.
    const seen = new Set();
    const mine = all.filter((f) => COUNTS.has(f.status) && !seen.has(f.photo_id) && seen.add(f.photo_id));
    const members = players.results.filter((p) => p.team_id === t.id);
    return {
      ...t,
      members: members.map((p) => p.name),
      players: members.length,
      // What players see during the game: how many photos each person and team has submitted.
      roster: members.map((p) => ({ name: p.name, submitted: all.filter((f) => f.player_id === p.id).length })),
      submitted: new Set(all.map((f) => f.photo_id)).size,
      // Same, but without finds the judge added by hand (those are always a yes, so players mustn't see them early).
      sent: new Set(all.filter((f) => f.player_id).map((f) => f.photo_id)).size,
      // Hidden until the reveal.
      score: mine.reduce((s, f) => s + (pts[f.photo_id] || 0), 0),
      found: mine.length,
      by_diff: [1, 2, 3].map((d) => mine.filter((f) => diff[f.photo_id] === d).length), // [easy, medium, hard]
      reached_at: mine.length ? Math.max(...mine.map((f) => f.created_at)) : 0, // tie-break: who got there first
    };
  });
  scored.sort((a, b) => b.score - a.score || a.reached_at - b.reached_at);
  const data = {
    game: {
      id: game.id, name: game.name, status: effectiveStatus(game), boundary: game.boundary_geojson ? JSON.parse(game.boundary_geojson) : null,
      started_at: game.started_at, ends_at: game.ends_at, revealed: !!game.revealed_at, tutorial_at: game.tutorial_at || null,
      // A spot everyone sees on the map (where the TV and dinner are).
      home: game.home_lat != null ? { lat: game.home_lat, lng: game.home_lng, label: game.home_label || 'Home base' } : null,
      // The host's latest message to every phone and the TV.
      announce: game.announce_at ? { text: game.announce_text, at: game.announce_at } : null,
      random_teams: !!game.random_teams, teams_at: game.teams_at || null, teams_ready: !!game.teams_ready,
    },
    teams: scored,
    photos: photos.results.map((p) => ({
      id: p.id, title: p.title, difficulty: p.difficulty, points: p.points, hint: p.hint,
      thumb: `/img/${p.thumb_key}`, image: `/img/${p.image_key}`,
    })),
    finds: finds.results,
    players: players.results,
  };
  stateCache.set(game.id, { at: now(), ver, data });
  return data;
}

// What one player is allowed to see. Before the reveal: no scores, no right/wrong, and other
// teams' finds only as anonymous "Team Red found something" events.
function playerView(s, me, mates) {
  const revealed = s.game.revealed;
  if (s.game.random_teams && !s.game.teams_ready) {
    // Teams are being picked at random: nobody sees a team yet, just who has joined.
    const teams = s.teams.map((t) => ({ id: t.id, name: t.name, color: t.color, members: [], players: 0, roster: [], submitted: 0 }));
    return { game: s.game, teams, photos: s.photos, finds: [], mates: [], events: [], everyone: s.players.map((p) => p.name) };
  }
  const teams = s.teams.map((t) => {
    const base = { id: t.id, name: t.name, color: t.color, members: t.members, players: t.players, roster: t.roster, submitted: revealed ? t.submitted : t.sent };
    return revealed ? { ...base, score: t.score, found: t.found, by_diff: t.by_diff } : base;
  });
  if (!revealed) teams.sort((a, b) => b.submitted - a.submitted);
  // Before the reveal, hand-added finds (no player) stay hidden: they'd give away a yes.
  const visible = revealed ? s.finds : s.finds.filter((f) => f.player_id);
  const finds = visible
    .filter((f) => revealed || f.team_id === me.team_id)
    .map((f) => {
      const mine = f.team_id === me.team_id;
      return {
        id: f.id, photo_id: f.photo_id, team_id: f.team_id, player_name: f.player_name, created_at: f.created_at,
        // Other teams' spots would give away photo locations.
        lat: mine ? f.lat : null, lng: mine ? f.lng : null, by_me: f.player_id === me.id,
        // Your own team's picture, so you can compare it with the photo you were hunting.
        proof: mine && f.proof_key ? `/img/${f.proof_key}` : null,
        ...(revealed ? { counted: COUNTS.has(f.status) } : {}),
      };
    });
  // Newest arrivals (by insert order, so late offline photos still pop up).
  const events = [...visible].sort((a, b) => a.seq - b.seq).slice(-40).map((f) => ({ id: f.id, team_id: f.team_id, at: f.created_at }));
  return { game: s.game, teams, photos: s.photos, finds, mates, events };
}

async function playerFromToken(env, request) {
  const token = request.headers.get('x-player');
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM players WHERE token = ? AND kicked_at IS NULL').bind(token).first();
}

// ---------- player API ----------

async function player(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/game' && method === 'GET') {
    const game = await currentGame(env);
    if (!game) return json({ game: null });
    const s = await gameState(env, game);
    return json({ game: s.game, teams: s.teams.map(({ id, name, color, players, members }) => ({ id, name, color, players, members })) });
  }

  // Look for players with this name, for "Is this you, Mike on Blue team?"
  if (path === '/api/lookup' && method === 'POST') {
    const { name } = await request.json();
    const game = await currentGame(env);
    if (!game) return json({ error: 'No game yet.' }, 404);
    const rows = await env.DB.prepare(
      'SELECT p.id, p.name, t.name AS team, t.color FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.game_id = ? AND p.name_key = ? AND p.kicked_at IS NULL'
    ).bind(game.id, nameKey(name)).all();
    const hidden = teamsHidden(game);
    return json({ matches: rows.results.map((m) => hidden || !m.team ? { ...m, team: null, color: '#555' } : m) });
  }

  // Switch teams in the lobby. Once the game starts, teams are locked (the host can still move people).
  if (path === '/api/team' && method === 'POST') {
    const me = await playerFromToken(env, request);
    if (!me) return json({ error: 'not_joined' }, 401);
    const game = await currentGame(env);
    if (!game || game.id !== me.game_id) return json({ error: 'not_joined' }, 401);
    if (effectiveStatus(game) !== 'setup') return json({ error: 'The game has started, so teams are locked.' }, 400);
    if (game.random_teams) return json({ error: 'The host is picking the teams.' }, 400);
    const { team_id } = await request.json().catch(() => ({}));
    const team = await env.DB.prepare('SELECT id FROM teams WHERE id = ? AND game_id = ?').bind(team_id, game.id).first();
    if (!team) return json({ error: 'Please pick a team.' }, 400);
    await env.DB.prepare('UPDATE players SET team_id = ? WHERE id = ?').bind(team.id, me.id).run();
    await bump(env, game.id);
    return json({ ok: true });
  }

  if (path === '/api/join' && method === 'POST') {
    const { name, team_id, player_id } = await request.json();
    const game = await currentGame(env);
    if (!game) return json({ error: 'No game yet.' }, 404);
    if (player_id) {
      // Rejoin as an existing player (new phone, cleared browser).
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ? AND game_id = ? AND kicked_at IS NULL').bind(player_id, game.id).first();
      if (!p) return json({ error: 'Could not find that player.' }, 404);
      return json({ token: p.token, player: { id: p.id, name: p.name, team_id: teamsHidden(game) ? null : p.team_id } });
    }
    const clean = String(name || '').trim().slice(0, 30);
    if (!clean) return json({ error: 'Please type your name.' }, 400);
    let tid;
    if (game.random_teams) {
      // No picking: wait for the shuffle, or (if teams are already picked) join the smallest team.
      tid = game.teams_at ? await smallestTeam(env, game.id) : '';
    } else {
      const team = await env.DB.prepare('SELECT id FROM teams WHERE id = ? AND game_id = ?').bind(team_id, game.id).first();
      if (!team) return json({ error: 'Please pick a team.' }, 400);
      tid = team.id;
    }
    const p = { id: id(), token: crypto.randomUUID(), name: clean };
    await env.DB.prepare(
      'INSERT INTO players (id, game_id, team_id, name, name_key, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(p.id, game.id, tid, clean, nameKey(clean), p.token, now()).run();
    await bump(env, game.id);
    return json({ token: p.token, player: { id: p.id, name: p.name, team_id: teamsHidden(game) ? null : tid } });
  }

  // The one combined poll: send my location, get the game back (or "nothing new").
  if (path === '/api/poll' && method === 'POST') {
    const token = request.headers.get('x-player');
    if (!token) return json({ error: 'not_joined' }, 401);
    // Me and the current game in one round trip.
    const [meR, gameR] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM players WHERE token = ?').bind(token),
      env.DB.prepare('SELECT * FROM games ORDER BY created_at DESC LIMIT 1'),
    ]);
    const me = meR.results[0], game = gameR.results[0];
    // Players from an older game, or removed by the host, go back to the join screen.
    if (me?.kicked_at && game?.id === me.game_id) return json({ error: 'not_joined', kicked: true }, 401);
    if (!me || !game || game.id !== me.game_id) return json({ error: 'not_joined' }, 401);
    const body = await request.json().catch(() => ({}));
    const stmts = [];
    const locState = ['ok', 'off', 'searching'].includes(body.loc) ? body.loc : null;
    if (!me.last_seen_at || now() - me.last_seen_at > PING_EVERY_MS || (locState && locState !== me.loc_state)) {
      const hasLoc = Number.isFinite(body.lat) && Number.isFinite(body.lng);
      if (hasLoc) {
        stmts.push(env.DB.prepare('UPDATE players SET last_lat = ?, last_lng = ?, last_accuracy = ?, last_seen_at = ?, loc_at = ?, loc_state = COALESCE(?, loc_state) WHERE id = ?')
          .bind(body.lat, body.lng, Number.isFinite(body.acc) ? body.acc : null, now(), now(), locState, me.id));
        stmts.push(env.DB.prepare('INSERT INTO pings (player_id, game_id, lat, lng, at) VALUES (?, ?, ?, ?, ?)')
          .bind(me.id, game.id, body.lat, body.lng, now()));
      } else stmts.push(env.DB.prepare('UPDATE players SET last_seen_at = ?, loc_state = COALESCE(?, loc_state) WHERE id = ?').bind(now(), locState, me.id));
    }
    // Teammates' latest spots, read fresh every time (they move without changing the game version).
    const hidden = teamsHidden(game);
    stmts.push(env.DB.prepare('SELECT id, name, last_lat AS lat, last_lng AS lng, last_seen_at AS seen_at FROM players WHERE game_id = ? AND team_id = ? AND id != ? AND last_lat IS NOT NULL AND kicked_at IS NULL')
      .bind(game.id, hidden || !me.team_id ? '-' : me.team_id, me.id));
    const res = await env.DB.batch(stmts);
    const mates = res[res.length - 1].results;
    const v = tag(game);
    if (body.v === v) return json({ same: true, v, mates, now: now() });
    const s = await gameState(env, game);
    return json({ ...playerView(s, me, mates), v, me: { id: me.id, name: me.name, team_id: hidden || !me.team_id ? null : me.team_id }, now: now() });
  }

  if (path === '/api/checkin' && method === 'POST') {
    const me = await playerFromToken(env, request);
    if (!me) return json({ error: 'not_joined' }, 401);
    const form = await request.formData();
    const photoId = form.get('photo_id');
    const lat = Number(form.get('lat')), lng = Number(form.get('lng'));
    const acc = Number(form.get('acc')) || null;
    const replace = form.get('replace') === '1';
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "We couldn't get your location. Please try again." }, 400);

    const game = await currentGame(env);
    if (!game || game.id !== me.game_id) return json({ error: 'not_joined' }, 401);
    const status = effectiveStatus(game);
    if (status === 'setup' || status === 'starting') return json({ result: 'not_started' });
    // A check-in saved offline before the end still counts if it arrives within 30 minutes.
    // Clamp the phone's timestamp so it can't be backdated to win a tie-break.
    const takenAt = Math.min(now(), Math.max(now() - 30 * 60000, Number(form.get('at')) || now()));
    if (game.revealed_at) return json({ result: 'ended' }); // results are out: nothing can change them now
    const lateOk = game.ends_at && takenAt <= game.ends_at && takenAt >= (game.started_at || 0) && now() - game.ends_at < 30 * 60000;
    if (status === 'ended' && !lateOk) return json({ result: 'ended' });

    if (!me.team_id) return json({ error: "You're not on a team yet. Ask the host." }, 400);
    const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND game_id = ?').bind(photoId, game.id).first();
    if (!photo) return json({ error: 'That photo is no longer in the game.' }, 404);
    if (photo.lat == null) return json({ error: 'This photo has no spot set yet. Tell the organizer.' }, 400);

    // One answer per team per photo. "Submit again" replaces it; only the newest answer counts.
    const prior = await env.DB.prepare("SELECT 1 FROM finds WHERE team_id = ? AND photo_id = ? AND status != 'replaced' LIMIT 1")
      .bind(me.team_id, photo.id).first();
    if (prior && !replace) return json({ result: 'already' });

    // Marked yes/no here, but the player only hears "submitted" until the reveal.
    const distance = Math.round(haversine(lat, lng, photo.lat, photo.lng));
    const verdict = gpsVerdict(distance, photo.radius_m, acc);

    const proofKey = await putImage(env, form.get('proof'), 'proof');
    const row = [id(), game.id, photo.id, me.team_id, me.id, lat, lng, acc, distance, proofKey, verdict, Math.min(takenAt, now())];
    const insert = `INSERT INTO finds (id, game_id, photo_id, team_id, player_id, lat, lng, accuracy_m, distance_m, proof_key, status, created_at)`;
    if (replace) {
      // One transaction, so two "submit again" taps still leave exactly one answer. The newest picture
      // (by when it was taken) wins: a late offline one doesn't overwrite a teammate's newer answer.
      const at = row[11];
      await env.DB.batch([
        env.DB.prepare(`${insert} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            CASE WHEN EXISTS (SELECT 1 FROM finds WHERE team_id = ? AND photo_id = ? AND status != 'replaced' AND created_at > ?) THEN 'replaced' ELSE ? END, ?`)
          .bind(...row.slice(0, 10), me.team_id, photo.id, at, verdict, at),
        env.DB.prepare("UPDATE finds SET status = 'replaced' WHERE team_id = ? AND photo_id = ? AND status != 'replaced' AND created_at <= ? AND id != ?")
          .bind(me.team_id, photo.id, at, row[0]),
      ]);
    } else {
      // Guards against two teammates tapping at once.
      const ins = await env.DB.prepare(`${insert} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM finds WHERE team_id = ? AND photo_id = ? AND status != 'replaced')`)
        .bind(...row, me.team_id, photo.id).run();
      if (!ins.meta.changes) return json({ result: 'already' });
    }
    await bump(env, game.id);
    return json({ result: 'submitted' });
  }

  return json({ error: 'Not found' }, 404);
}

// ---------- admin API ----------

async function admin(request, env, url, who) {
  const path = url.pathname.replace('/api/admin', '');
  const method = request.method;
  const parts = path.split('/').filter(Boolean); // e.g. ['photos', '<id>']

  if (path === '/login') return json({ ok: true, name: who.name });

  // Sign this browser out.
  if (path === '/logout' && method === 'POST') {
    const th = await sha256(request.headers.get('x-admin') || '');
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(th).run();
    sessionCache.delete(th);
    return json({ ok: true });
  }

  // Other admins and open invite links.
  if (parts[0] === 'admins') {
    if (method === 'GET' && !parts[1]) {
      const [admins, invites] = await env.DB.batch([
        env.DB.prepare('SELECT id, name, created_at FROM admins ORDER BY created_at'),
        env.DB.prepare('SELECT token_hash AS id, name, created_at, expires_at FROM admin_invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at').bind(now()),
      ]);
      return json({ admins: admins.results, invites: invites.results, me: who });
    }
    if (method === 'POST' && parts[1] === 'invite') {
      const { name } = await request.json().catch(() => ({}));
      const clean = String(name || '').trim().slice(0, 30);
      if (!clean) return json({ error: 'Type their name.' }, 400);
      const token = randomToken();
      await env.DB.prepare('INSERT INTO admin_invites (token_hash, name, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(await sha256(token), clean, now(), now() + INVITE_DAYS * 86400000).run();
      return json({ token, name: clean, expires_at: now() + INVITE_DAYS * 86400000 });
    }
    if (method === 'DELETE' && parts[1] === 'invites' && parts[2]) {
      await env.DB.prepare('DELETE FROM admin_invites WHERE token_hash = ?').bind(decodeURIComponent(parts[2])).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && parts[1]) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(parts[1]),
        env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(parts[1]),
      ]);
      sessionCache.clear();
      return json({ ok: true });
    }
  }

  if (path === '/game' && method === 'POST') {
    const { name } = await request.json();
    const g = { id: id(), name: String(name || 'Thanksgiving Photo Hunt').slice(0, 60) };
    const prev = await currentGame(env);
    const stmts = [env.DB.prepare('INSERT INTO games (id, name, status, created_at) VALUES (?, ?, ?, ?)').bind(g.id, g.name, 'setup', now())];
    // Keep the previous game's teams (names and colors); otherwise use the defaults.
    const prevTeams = prev ? (await env.DB.prepare('SELECT name, color FROM teams WHERE game_id = ? ORDER BY rowid').bind(prev.id).all()).results : [];
    (prevTeams.length ? prevTeams.map((t) => [t.name, t.color]) : DEFAULT_TEAMS)
      .forEach(([n, c]) => stmts.push(env.DB.prepare('INSERT INTO teams (id, game_id, name, color) VALUES (?, ?, ?, ?)').bind(id(), g.id, n, c)));
    // Carry photos and the boundary over so a fresh game doesn't mean re-uploading.
    if (prev) {
      stmts.push(env.DB.prepare(`INSERT INTO photos (id, game_id, title, difficulty, points, lat, lng, radius_m, hint, image_key, thumb_key, sort)
        SELECT lower(hex(randomblob(8))), ?, title, difficulty, points, lat, lng, radius_m, hint, image_key, thumb_key, sort FROM photos WHERE game_id = ?`).bind(g.id, prev.id));
      stmts.push(env.DB.prepare('UPDATE games SET boundary_geojson = ?, home_lat = ?, home_lng = ?, home_label = ?, random_teams = ? WHERE id = ?').bind(prev.boundary_geojson || JSON.stringify(DEFAULT_BOUNDARY), prev.home_lat ?? null, prev.home_lng ?? null, prev.home_label ?? null, prev.random_teams ? 1 : 0, g.id));
    } else {
      stmts.push(env.DB.prepare('UPDATE games SET boundary_geojson = ? WHERE id = ?').bind(JSON.stringify(DEFAULT_BOUNDARY), g.id));
    }
    await env.DB.batch(stmts);
    return json({ ok: true, id: g.id });
  }

  const game = await currentGame(env);
  if (!game) return json({ game: null });

  if (path === '/state' && method === 'GET') {
    const [teams, photos, players, finds] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM teams WHERE game_id = ? ORDER BY rowid').bind(game.id),
      env.DB.prepare('SELECT * FROM photos WHERE game_id = ? ORDER BY sort, rowid').bind(game.id),
      env.DB.prepare('SELECT id, team_id, name, last_lat, last_lng, last_accuracy, last_seen_at, loc_state, loc_at, adult FROM players WHERE game_id = ? AND kicked_at IS NULL ORDER BY created_at').bind(game.id),
      env.DB.prepare("SELECT * FROM finds WHERE game_id = ? AND status != 'replaced' ORDER BY created_at DESC").bind(game.id),
    ]);
    const s = await gameState(env, game);
    return json({
      game: { ...game, status: effectiveStatus(game), boundary: s.game.boundary, home: s.game.home, announce: s.game.announce },
      teams: teams.results, photos: photos.results, players: players.results, finds: finds.results,
      scores: s.teams, now: now(),
    });
  }

  if (path === '/game' && method === 'PATCH') {
    const b = await request.json();
    const sets = [], vals = [];
    if (b.name !== undefined) { sets.push('name = ?'); vals.push(String(b.name).slice(0, 60)); }
    if (b.boundary !== undefined) { sets.push('boundary_geojson = ?'); vals.push(b.boundary ? JSON.stringify(b.boundary === 'default' ? DEFAULT_BOUNDARY : b.boundary) : null); }
    if (b.home !== undefined) {
      const h = b.home, ok = h && Number.isFinite(+h.lat) && Number.isFinite(+h.lng);
      sets.push('home_lat = ?', 'home_lng = ?', 'home_label = ?');
      vals.push(ok ? +h.lat : null, ok ? +h.lng : null, ok ? String(h.label || 'Home base').slice(0, 40) : null);
    }
    if (b.announce !== undefined) {
      const t = String(b.announce || '').trim().slice(0, 200);
      sets.push('announce_text = ?', 'announce_at = ?'); vals.push(t || null, t ? now() : null);
    }
    if (b.random_teams !== undefined) {
      if (effectiveStatus(game) !== 'setup') return json({ error: 'Change this before the game starts.' }, 400);
      if (b.random_teams) {
        // Everyone waits for the shuffle: clear the teams they picked.
        await env.DB.prepare("UPDATE players SET team_id = '' WHERE game_id = ?").bind(game.id).run();
        sets.push('random_teams = 1', 'teams_at = NULL', 'teams_ready = 0');
      } else {
        // Back to picking: anyone still without a team goes to the smallest one.
        const loose = (await env.DB.prepare("SELECT id FROM players WHERE game_id = ? AND team_id = '' AND kicked_at IS NULL").bind(game.id).all()).results;
        for (const p of loose) await env.DB.prepare('UPDATE players SET team_id = ? WHERE id = ?').bind(await smallestTeam(env, game.id), p.id).run();
        sets.push('random_teams = 0', 'teams_at = NULL', 'teams_ready = 0');
      }
    }
    if (b.action === 'shuffle') {
      if (effectiveStatus(game) !== 'setup') return json({ error: 'Teams are locked once the game starts.' }, 400);
      const count = Math.max(2, Math.min(8, Math.round(Number(b.count) || 2)));
      // Make exactly `count` teams: keep the first ones (names and colors), add or remove the rest.
      let teams = (await env.DB.prepare('SELECT id, name, color FROM teams WHERE game_id = ? ORDER BY rowid').bind(game.id).all()).results;
      const stmts = [];
      if (teams.length < count) {
        const used = new Set(teams.map((t) => t.name));
        const spare = [...DEFAULT_TEAMS, ...MORE_TEAMS].filter(([n]) => !used.has(n));
        while (teams.length < count) {
          const [n, c] = spare.shift() || [`Team ${teams.length + 1}`, '#6b7280'];
          const t = { id: id(), name: n, color: c };
          stmts.push(env.DB.prepare('INSERT INTO teams (id, game_id, name, color) VALUES (?, ?, ?, ?)').bind(t.id, game.id, n, c));
          teams.push(t);
        }
      }
      for (const t of teams.slice(count)) {
        stmts.push(env.DB.prepare('DELETE FROM finds WHERE team_id = ?').bind(t.id), env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(t.id));
      }
      teams = shuffle(teams.slice(0, count));
      // Adults first, spread one per team in turn, so every team gets one if there are enough. Then kids to the smallest teams.
      const players = (await env.DB.prepare('SELECT id, adult FROM players WHERE game_id = ? AND kicked_at IS NULL').bind(game.id).all()).results;
      const size = Object.fromEntries(teams.map((t) => [t.id, 0]));
      const put = (p, tid) => { size[tid]++; stmts.push(env.DB.prepare('UPDATE players SET team_id = ? WHERE id = ?').bind(tid, p.id)); };
      shuffle(players.filter((p) => p.adult)).forEach((p, i) => put(p, teams[i % count].id));
      shuffle(players.filter((p) => !p.adult)).forEach((p) => {
        const min = Math.min(...teams.map((t) => size[t.id]));
        put(p, shuffle(teams.filter((t) => size[t.id] === min))[0].id);
      });
      await env.DB.batch(stmts);
      sets.push('teams_at = ?', 'teams_ready = 0'); vals.push(now());
    }
    if (b.action === 'show_teams') {
      if (!game.teams_at) return json({ error: 'Shuffle the teams first.' }, 400);
      sets.push('teams_ready = 1');
    }
    if (b.action === 'start') {
      if (teamsHidden(game)) return json({ error: game.teams_at ? 'Reveal the teams first, so everyone knows their team.' : 'Shuffle and reveal the teams first.' }, 400);
      // Starting twice would reset the clock, so only start a game that isn't live.
      if (['live', 'starting'].includes(effectiveStatus(game))) return json({ error: 'The game is already live.' }, 400);
      // The hunt opens after the countdown; the timer (if any) runs from then.
      const opens = now() + (b.countdown === 0 ? 0 : COUNTDOWN_MS); // countdown: 0 is for test scripts
      sets.push("status = 'live'", 'started_at = ?', 'ends_at = ?', 'revealed_at = NULL'); vals.push(opens, b.minutes ? opens + b.minutes * 60000 : null);
    }
    if (b.action === 'end') { sets.push("status = 'ended'", 'ends_at = ?'); vals.push(Math.min(now(), game.ends_at || Infinity)); }
    if (b.action === 'reopen') { sets.push("status = 'live'", 'ends_at = NULL', 'revealed_at = NULL'); }
    if (b.action === 'setup') { sets.push("status = 'setup'", 'started_at = NULL', 'ends_at = NULL', 'revealed_at = NULL'); }
    if (b.action === 'reveal') {
      if (effectiveStatus(game) !== 'ended') return json({ error: 'End the game before revealing the results.' }, 400);
      sets.push('revealed_at = ?'); vals.push(now());
    }
    if (b.action === 'hide') { sets.push('revealed_at = NULL'); }
    // The TV plays its "How to play" demo when this changes; stop clears it.
    if (b.action === 'tutorial') { sets.push('tutorial_at = ?'); vals.push(now()); }
    if (b.action === 'tutorial_stop') { sets.push('tutorial_at = NULL'); }
    if (b.action === 'reset') {
      // Play again with the same teams and photos: clear every photo sent and all trails, and remove
      // every player (their phones go back to the join screen).
      await env.DB.batch([
        env.DB.prepare('DELETE FROM finds WHERE game_id = ?').bind(game.id),
        env.DB.prepare('DELETE FROM pings WHERE game_id = ?').bind(game.id),
        env.DB.prepare('DELETE FROM players WHERE game_id = ?').bind(game.id),
      ]);
      sets.push("status = 'setup'", 'started_at = NULL', 'ends_at = NULL', 'revealed_at = NULL', 'announce_text = NULL', 'announce_at = NULL', 'teams_at = NULL', 'teams_ready = 0');
    }
    if (!sets.length) return json({ error: 'Nothing to change' }, 400);
    await env.DB.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, game.id).run();
    await bump(env, game.id);
    return json({ ok: true });
  }

  if (parts[0] === 'teams') {
    if (method === 'POST') {
      const { name, color } = await request.json();
      await env.DB.prepare('INSERT INTO teams (id, game_id, name, color) VALUES (?, ?, ?, ?)').bind(id(), game.id, String(name).slice(0, 30), color || '#6b7280').run();
    } else if (method === 'PATCH') {
      const { name, color } = await request.json();
      await env.DB.prepare('UPDATE teams SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ? AND game_id = ?').bind(name ?? null, color ?? null, parts[1], game.id).run();
    } else if (method === 'DELETE') {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND kicked_at IS NULL').bind(parts[1]).first();
      if (used.n) return json({ error: 'Move the players off this team first.' }, 400);
      await env.DB.prepare('DELETE FROM teams WHERE id = ? AND game_id = ?').bind(parts[1], game.id).run();
    }
    await bump(env, game.id);
    return json({ ok: true });
  }

  if (parts[0] === 'photos') {
    if (method === 'POST') {
      const form = await request.formData();
      const imageKey = await putImage(env, form.get('image'), 'photo');
      const thumbKey = await putImage(env, form.get('thumb'), 'thumb');
      if (!imageKey || !thumbKey) return json({ error: 'Missing image' }, 400);
      const lat = form.get('lat') ? Number(form.get('lat')) : null;
      const lng = form.get('lng') ? Number(form.get('lng')) : null;
      const sort = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM photos WHERE game_id = ?').bind(game.id).first();
      const pid = id();
      await env.DB.prepare(
        'INSERT INTO photos (id, game_id, title, difficulty, points, lat, lng, radius_m, image_key, thumb_key, sort) VALUES (?, ?, ?, 1, 1, ?, ?, 40, ?, ?, ?)'
      ).bind(pid, game.id, form.get('title') || null, lat, lng, imageKey, thumbKey, sort.n).run();
      await bump(env, game.id);
      return json({ ok: true, id: pid });
    }
    if (method === 'PATCH' && !parts[1]) {
      // Change the radius for every photo at once (or only one difficulty).
      const b = await request.json();
      const r = Math.round(Number(b.radius_m));
      if (!Number.isFinite(r) || r < 5 || r > 500) return json({ error: 'Pick a radius between 5 and 500 meters.' }, 400);
      const d = b.difficulty ? Number(b.difficulty) : null;
      if (d !== null && ![1, 2, 3].includes(d)) return json({ error: 'Bad difficulty' }, 400);
      const res = await env.DB.prepare(`UPDATE photos SET radius_m = ? WHERE game_id = ?${d ? ' AND difficulty = ?' : ''}`).bind(...[r, game.id, ...(d ? [d] : [])]).run();
      const ids = (await env.DB.prepare(`SELECT id FROM photos WHERE game_id = ?${d ? ' AND difficulty = ?' : ''}`).bind(...[game.id, ...(d ? [d] : [])]).all()).results.map((x) => x.id);
      const rechecked = await recheck(env, game.id, ids);
      await bump(env, game.id);
      return json({ ok: true, photos: res.meta.changes, rechecked });
    }
    if (method === 'PATCH') {
      const b = await request.json();
      const sets = [], vals = [];
      const int = (v, lo, hi) => { if (v === '' || v === null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
      const clean = {
        title: (v) => String(v ?? '').trim().slice(0, 80) || null,
        hint: (v) => String(v ?? '').trim().slice(0, 200) || null,
        difficulty: (v) => int(v, 1, 3),
        points: (v) => int(v, 0, 100),
        radius_m: (v) => int(v, 5, 500),
        lat: (v) => (v === null ? null : Number.isFinite(Number(v)) ? Number(v) : undefined),
        lng: (v) => (v === null ? null : Number.isFinite(Number(v)) ? Number(v) : undefined),
      };
      for (const f of Object.keys(clean)) {
        if (b[f] === undefined) continue;
        const v = clean[f](b[f]);
        if (v === undefined || (v === null && ['difficulty', 'points', 'radius_m'].includes(f))) return json({ error: `That ${f.replace('_m', '')} value doesn't look right.` }, 400);
        sets.push(`${f} = ?`); vals.push(v);
      }
      if (b.difficulty !== undefined && b.points === undefined) { sets.push('points = ?'); vals.push(POINTS[b.difficulty] || 1); }
      if (!sets.length) return json({ error: 'Nothing to change' }, 400);
      await env.DB.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ? AND game_id = ?`).bind(...vals, parts[1], game.id).run();
      // A new radius or a moved pin changes which answers are close enough.
      const rechecked = (b.radius_m !== undefined || b.lat !== undefined || b.lng !== undefined) ? await recheck(env, game.id, [parts[1]]) : 0;
      await bump(env, game.id);
      return json({ ok: true, rechecked });
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM finds WHERE photo_id = ? AND game_id = ?').bind(parts[1], game.id),
        env.DB.prepare('DELETE FROM photos WHERE id = ? AND game_id = ?').bind(parts[1], game.id),
      ]);
      await bump(env, game.id);
      return json({ ok: true });
    }
  }

  if (parts[0] === 'finds') {
    if (method === 'POST' && !parts[1]) {
      // Manual fix: give a team a find.
      const { photo_id, team_id } = await request.json();
      // If the team already answered this photo, approve that answer; otherwise add an approved one.
      const upd = await env.DB.prepare("UPDATE finds SET status = 'approved', judged_at = ? WHERE team_id = ? AND photo_id = ? AND game_id = ? AND status IN ('pending','far','rejected')")
        .bind(now(), team_id, photo_id, game.id).run();
      if (!upd.meta.changes) {
        await env.DB.prepare(
          `INSERT INTO finds (id, game_id, photo_id, team_id, status, created_at, judged_at) SELECT ?, ?, ?, ?, 'approved', ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM finds WHERE team_id = ? AND photo_id = ? AND status != 'replaced')`
        ).bind(id(), game.id, photo_id, team_id, now(), now(), team_id, photo_id).run();
      }
    } else if (method === 'PATCH') {
      const { status } = await request.json();
      if (status === 'reset') {
        // Undo the judge: back to what the GPS said when the photo was taken.
        const f = await env.DB.prepare('SELECT f.distance_m, f.accuracy_m, p.radius_m FROM finds f JOIN photos p ON p.id = f.photo_id WHERE f.id = ? AND f.game_id = ?').bind(parts[1], game.id).first();
        if (!f) return json({ error: 'That photo is gone.' }, 404);
        if (f.distance_m == null) return json({ error: 'The judge added this one by hand. Remove it instead.' }, 400);
        const auto = gpsVerdict(f.distance_m, f.radius_m, f.accuracy_m);
        await env.DB.prepare("UPDATE finds SET status = ?, judged_at = NULL WHERE id = ? AND game_id = ? AND status != 'replaced'").bind(auto, parts[1], game.id).run();
      } else {
        if (!['approved', 'rejected'].includes(status)) return json({ error: 'Bad status' }, 400);
        await env.DB.prepare("UPDATE finds SET status = ?, judged_at = ? WHERE id = ? AND game_id = ? AND status != 'replaced'").bind(status, now(), parts[1], game.id).run();
      }
    } else if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM finds WHERE id = ? AND game_id = ?').bind(parts[1], game.id).run();
    }
    await bump(env, game.id);
    return json({ ok: true });
  }

  // Everything the TV at home base shows: live map, every submission and judgment, real scores.
  if (path === '/tv' && method === 'GET') {
    const since = Number(url.searchParams.get('since')) || 0;
    const [pings, players] = await env.DB.batch([
      env.DB.prepare('SELECT player_id, lat, lng, at FROM pings WHERE game_id = ? AND at > ? ORDER BY at LIMIT 8000')
        .bind(game.id, Math.max(since, now() - 6 * 3600000)),
      env.DB.prepare('SELECT id, team_id, name, last_lat, last_lng, last_seen_at FROM players WHERE game_id = ? AND kicked_at IS NULL ORDER BY created_at').bind(game.id),
    ]);
    const v = tag(game);
    // Nothing new since the TV's last look: just the moving dots.
    if (url.searchParams.get('v') === v) return json({ same: true, v, players: players.results, pings: pings.results, now: now() });
    const [s, spots] = await Promise.all([
      gameState(env, game),
      // Where each hunt photo is, for the TV's optional "photo spots" layer (admin password only).
      env.DB.prepare('SELECT id, lat, lng, radius_m FROM photos WHERE game_id = ? AND lat IS NOT NULL').bind(game.id).all(),
    ]);
    return json({ ...s, spots: spots.results, players: players.results, v, pings: pings.results, now: now() });
  }

  // Remove a player. Their phone goes back to the join screen; photos they sent stay with their team.
  if (parts[0] === 'players' && method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('UPDATE players SET kicked_at = ? WHERE id = ? AND game_id = ?').bind(now(), parts[1], game.id),
      env.DB.prepare('DELETE FROM pings WHERE player_id = ?').bind(parts[1]),
    ]);
    await bump(env, game.id);
    return json({ ok: true });
  }

  if (parts[0] === 'players' && method === 'PATCH') {
    const { team_id, adult } = await request.json();
    if (team_id !== undefined) await env.DB.prepare('UPDATE players SET team_id = ? WHERE id = ? AND game_id = ?').bind(team_id, parts[1], game.id).run();
    if (adult !== undefined) await env.DB.prepare('UPDATE players SET adult = ? WHERE id = ? AND game_id = ?').bind(adult ? 1 : 0, parts[1], game.id).run();
    await bump(env, game.id);
    return json({ ok: true });
  }

  if (path === '/export' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT f.created_at, t.name AS team, p.name AS player, ph.title, ph.points, f.status, f.distance_m
      FROM finds f LEFT JOIN teams t ON t.id = f.team_id LEFT JOIN players p ON p.id = f.player_id JOIN photos ph ON ph.id = f.photo_id
      WHERE f.game_id = ? ORDER BY f.created_at`).bind(game.id).all();
    // Quote every cell; prefix formula-like values so spreadsheets don't run them.
    const esc = (v) => { let t = String(v ?? ''); if (/^[=+\-@]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const csv = ['time,team,player,photo,points,status,distance_m',
      ...rows.results.map((r) => [new Date(r.created_at).toISOString(), r.team, r.player, r.title, r.points, r.status, r.distance_m].map(esc).join(','))].join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="photo-hunt-results.csv"' } });
  }

  return json({ error: 'Not found' }, 404);
}
