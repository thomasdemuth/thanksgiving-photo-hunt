// Thanksgiving Photo Hunt: one Worker serving the JSON API and photos.
// Static files in /public are served by Cloudflare before this runs.

const DEFAULT_TEAMS = [
  ['Red', '#ee352e'], ['Blue', '#0039a6'], ['Green', '#00933c'], ['Orange', '#e8590c'],
];
const POINTS = { 1: 1, 2: 2, 3: 3 };
// Default play area: Canal St (6th Ave to Greenwich), Greenwich St (Canal to Christopher),
// Christopher St (Greenwich to 6th Ave), 6th Ave (Christopher to Canal). Traced from OpenStreetMap.
const DEFAULT_BOUNDARY = [[40.721882,-74.005355],[40.723845,-74.008033],[40.724026,-74.008445],[40.724495,-74.008916],[40.724597,-74.00921],[40.724722,-74.009309],[40.726,-74.0091],[40.7296,-74.0084],[40.732877,-74.007514],[40.734146,-73.999182],[40.729621,-74.002232],[40.72212,-74.005379]];
const STATE_TTL_MS = 60000; // safety net only: the cache is keyed on the game's version
const PING_EVERY_MS = 12000; // how often a phone's location is saved (teammates and the TV see it)

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
      if (url.pathname.startsWith('/api/admin/')) {
        if (request.headers.get('x-admin') !== env.ADMIN_PASSWORD) return json({ error: 'Wrong password' }, 401);
        return await admin(request, env, url);
      }
      if (url.pathname.startsWith('/api/')) return await player(request, env, url);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong on our end. Please try again.' }, 500);
    }
  },
};

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
function effectiveStatus(game) {
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
    env.DB.prepare('SELECT id, team_id, name FROM players WHERE game_id = ? ORDER BY created_at').bind(game.id),
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
      started_at: game.started_at, ends_at: game.ends_at, revealed: !!game.revealed_at,
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
  return env.DB.prepare('SELECT * FROM players WHERE token = ?').bind(token).first();
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
      'SELECT p.id, p.name, t.name AS team, t.color FROM players p JOIN teams t ON t.id = p.team_id WHERE p.game_id = ? AND p.name_key = ?'
    ).bind(game.id, nameKey(name)).all();
    return json({ matches: rows.results });
  }

  if (path === '/api/join' && method === 'POST') {
    const { name, team_id, player_id } = await request.json();
    const game = await currentGame(env);
    if (!game) return json({ error: 'No game yet.' }, 404);
    if (player_id) {
      // Rejoin as an existing player (new phone, cleared browser).
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ? AND game_id = ?').bind(player_id, game.id).first();
      if (!p) return json({ error: 'Could not find that player.' }, 404);
      return json({ token: p.token, player: { id: p.id, name: p.name, team_id: p.team_id } });
    }
    const clean = String(name || '').trim().slice(0, 30);
    if (!clean) return json({ error: 'Please type your name.' }, 400);
    const team = await env.DB.prepare('SELECT id FROM teams WHERE id = ? AND game_id = ?').bind(team_id, game.id).first();
    if (!team) return json({ error: 'Please pick a team.' }, 400);
    const p = { id: id(), token: crypto.randomUUID(), name: clean, team_id };
    await env.DB.prepare(
      'INSERT INTO players (id, game_id, team_id, name, name_key, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(p.id, game.id, team_id, clean, nameKey(clean), p.token, now()).run();
    await bump(env, game.id);
    return json({ token: p.token, player: { id: p.id, name: p.name, team_id } });
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
    // Players from an older game get sent back to the join screen.
    if (!me || !game || game.id !== me.game_id) return json({ error: 'not_joined' }, 401);
    const body = await request.json().catch(() => ({}));
    const stmts = [];
    if (!me.last_seen_at || now() - me.last_seen_at > PING_EVERY_MS) {
      const hasLoc = Number.isFinite(body.lat) && Number.isFinite(body.lng);
      if (hasLoc) {
        stmts.push(env.DB.prepare('UPDATE players SET last_lat = ?, last_lng = ?, last_accuracy = ?, last_seen_at = ? WHERE id = ?')
          .bind(body.lat, body.lng, Number.isFinite(body.acc) ? body.acc : null, now(), me.id));
        stmts.push(env.DB.prepare('INSERT INTO pings (player_id, game_id, lat, lng, at) VALUES (?, ?, ?, ?, ?)')
          .bind(me.id, game.id, body.lat, body.lng, now()));
      } else stmts.push(env.DB.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').bind(now(), me.id));
    }
    // Teammates' latest spots, read fresh every time (they move without changing the game version).
    stmts.push(env.DB.prepare('SELECT id, name, last_lat AS lat, last_lng AS lng, last_seen_at AS seen_at FROM players WHERE game_id = ? AND team_id = ? AND id != ? AND last_lat IS NOT NULL')
      .bind(game.id, me.team_id, me.id));
    const res = await env.DB.batch(stmts);
    const mates = res[res.length - 1].results;
    const v = tag(game);
    if (body.v === v) return json({ same: true, v, mates, now: now() });
    const s = await gameState(env, game);
    return json({ ...playerView(s, me, mates), v, me: { id: me.id, name: me.name, team_id: me.team_id }, now: now() });
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
    if (status === 'setup') return json({ result: 'not_started' });
    // A check-in saved offline before the end still counts if it arrives within 30 minutes.
    // Clamp the phone's timestamp so it can't be backdated to win a tie-break.
    const takenAt = Math.min(now(), Math.max(now() - 30 * 60000, Number(form.get('at')) || now()));
    if (game.revealed_at) return json({ result: 'ended' }); // results are out: nothing can change them now
    const lateOk = game.ends_at && takenAt <= game.ends_at && takenAt >= (game.started_at || 0) && now() - game.ends_at < 30 * 60000;
    if (status === 'ended' && !lateOk) return json({ result: 'ended' });

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

async function admin(request, env, url) {
  const path = url.pathname.replace('/api/admin', '');
  const method = request.method;
  const parts = path.split('/').filter(Boolean); // e.g. ['photos', '<id>']

  if (path === '/login') return json({ ok: true });

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
      stmts.push(env.DB.prepare('UPDATE games SET boundary_geojson = ? WHERE id = ?').bind(prev.boundary_geojson || JSON.stringify(DEFAULT_BOUNDARY), g.id));
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
      env.DB.prepare('SELECT id, team_id, name, last_lat, last_lng, last_accuracy, last_seen_at FROM players WHERE game_id = ? ORDER BY created_at').bind(game.id),
      env.DB.prepare("SELECT * FROM finds WHERE game_id = ? AND status != 'replaced' ORDER BY created_at DESC").bind(game.id),
    ]);
    const s = await gameState(env, game);
    return json({
      game: { ...game, status: effectiveStatus(game), boundary: game.boundary_geojson ? JSON.parse(game.boundary_geojson) : null },
      teams: teams.results, photos: photos.results, players: players.results, finds: finds.results,
      scores: s.teams, now: now(),
    });
  }

  if (path === '/game' && method === 'PATCH') {
    const b = await request.json();
    const sets = [], vals = [];
    if (b.name !== undefined) { sets.push('name = ?'); vals.push(String(b.name).slice(0, 60)); }
    if (b.boundary !== undefined) { sets.push('boundary_geojson = ?'); vals.push(b.boundary ? JSON.stringify(b.boundary === 'default' ? DEFAULT_BOUNDARY : b.boundary) : null); }
    if (b.action === 'start') {
      // Starting twice would reset the clock, so only start a game that isn't live.
      if (effectiveStatus(game) === 'live') return json({ error: 'The game is already live.' }, 400);
      sets.push("status = 'live'", 'started_at = ?', 'ends_at = ?', 'revealed_at = NULL'); vals.push(now(), b.minutes ? now() + b.minutes * 60000 : null);
    }
    if (b.action === 'end') { sets.push("status = 'ended'", 'ends_at = ?'); vals.push(Math.min(now(), game.ends_at || Infinity)); }
    if (b.action === 'reopen') { sets.push("status = 'live'", 'ends_at = NULL', 'revealed_at = NULL'); }
    if (b.action === 'setup') { sets.push("status = 'setup'", 'started_at = NULL', 'ends_at = NULL', 'revealed_at = NULL'); }
    if (b.action === 'reveal') {
      if (effectiveStatus(game) !== 'ended') return json({ error: 'End the game before revealing the results.' }, 400);
      sets.push('revealed_at = ?'); vals.push(now());
    }
    if (b.action === 'hide') { sets.push('revealed_at = NULL'); }
    if (b.action === 'reset') {
      // Play again with the same players, teams and photos: clear every photo sent and all trails.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM finds WHERE game_id = ?').bind(game.id),
        env.DB.prepare('DELETE FROM pings WHERE game_id = ?').bind(game.id),
        env.DB.prepare('UPDATE players SET last_lat = NULL, last_lng = NULL, last_accuracy = NULL, last_seen_at = NULL WHERE game_id = ?').bind(game.id),
      ]);
      sets.push("status = 'setup'", 'started_at = NULL', 'ends_at = NULL', 'revealed_at = NULL');
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
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').bind(parts[1]).first();
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
      env.DB.prepare('SELECT id, team_id, name, last_lat, last_lng, last_seen_at FROM players WHERE game_id = ? ORDER BY created_at').bind(game.id),
    ]);
    const v = tag(game);
    // Nothing new since the TV's last look: just the moving dots.
    if (url.searchParams.get('v') === v) return json({ same: true, v, players: players.results, pings: pings.results, now: now() });
    const s = await gameState(env, game);
    return json({ ...s, players: players.results, v, pings: pings.results, now: now() });
  }

  if (parts[0] === 'players' && method === 'PATCH') {
    const { team_id } = await request.json();
    await env.DB.batch([
      env.DB.prepare('UPDATE players SET team_id = ? WHERE id = ? AND game_id = ?').bind(team_id, parts[1], game.id),
    ]);
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
