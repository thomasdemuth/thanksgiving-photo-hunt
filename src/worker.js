// Thanksgiving Photo Hunt: one Worker serving the JSON API and photos.
// Static files in /public are served by Cloudflare before this runs.

const DEFAULT_TEAMS = [
  ['Red', '#ee352e'], ['Blue', '#0039a6'], ['Green', '#00933c'], ['Orange', '#e8590c'],
];
const POINTS = { 1: 1, 2: 2, 3: 3 };
// Default play area: Canal St (6th Ave to Greenwich), Greenwich St (Canal to Christopher),
// Christopher St (Greenwich to 6th Ave), 6th Ave (Christopher to Canal). Traced from OpenStreetMap.
const DEFAULT_BOUNDARY = [[40.721882,-74.005355],[40.723845,-74.008033],[40.724026,-74.008445],[40.724495,-74.008916],[40.724597,-74.00921],[40.724722,-74.009309],[40.726,-74.0091],[40.7296,-74.0084],[40.732877,-74.007514],[40.734146,-73.999182],[40.729621,-74.002232],[40.72212,-74.005379]];
const STATE_TTL_MS = 5000;
const PING_EVERY_MS = 25000;

// Per-isolate cache of the shared game state, so a burst of polls costs one set of reads.
const stateCache = new Map();
const bust = (gameId) => stateCache.delete(gameId);

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

// Shared state for one game: teams with scores, photos (no locations), finds.
async function gameState(env, game) {
  const hit = stateCache.get(game.id);
  if (hit && now() - hit.at < STATE_TTL_MS) return hit.data;
  const [teams, photos, finds, players] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, color FROM teams WHERE game_id = ? ORDER BY rowid').bind(game.id),
    env.DB.prepare('SELECT id, title, difficulty, points, hint, image_key, thumb_key FROM photos WHERE game_id = ? ORDER BY sort, rowid').bind(game.id),
    env.DB.prepare(`SELECT f.id, f.photo_id, f.team_id, f.status, f.lat, f.lng, f.created_at, p.name AS player_name
                    FROM finds f LEFT JOIN players p ON p.id = f.player_id
                    WHERE f.game_id = ? AND f.status != 'rejected' ORDER BY f.created_at`).bind(game.id),
    env.DB.prepare('SELECT team_id, name FROM players WHERE game_id = ? ORDER BY created_at').bind(game.id),
  ]);
  const pts = Object.fromEntries(photos.results.map((p) => [p.id, p.points]));
  const diff = Object.fromEntries(photos.results.map((p) => [p.id, p.difficulty]));
  const scored = teams.results.map((t) => {
    // Each photo counts once per team, even if two rows slipped in (finds are sorted oldest first).
    const seen = new Set();
    const mine = finds.results.filter((f) => {
      if (f.team_id !== t.id || (f.status !== 'auto' && f.status !== 'approved') || seen.has(f.photo_id)) return false;
      seen.add(f.photo_id);
      return true;
    });
    return {
      ...t,
      members: players.results.filter((p) => p.team_id === t.id).map((p) => p.name),
      players: players.results.filter((p) => p.team_id === t.id).length,
      score: mine.reduce((s, f) => s + (pts[f.photo_id] || 0), 0),
      found: mine.length,
      // Found counts by difficulty: [easy, medium, hard].
      by_diff: [1, 2, 3].map((d) => mine.filter((f) => diff[f.photo_id] === d).length),
      // Tie-break: whoever reached their score first.
      reached_at: mine.length ? Math.max(...mine.map((f) => f.created_at)) : 0,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.reached_at - b.reached_at);
  const data = {
    game: {
      id: game.id, name: game.name, status: effectiveStatus(game), boundary: game.boundary_geojson ? JSON.parse(game.boundary_geojson) : null,
      started_at: game.started_at, ends_at: game.ends_at,
    },
    teams: scored,
    photos: photos.results.map((p) => ({
      id: p.id, title: p.title, difficulty: p.difficulty, points: p.points, hint: p.hint,
      thumb: `/img/${p.thumb_key}`, image: `/img/${p.image_key}`,
    })),
    finds: finds.results,
  };
  stateCache.set(game.id, { at: now(), data });
  return data;
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
    bust(game.id);
    return json({ token: p.token, player: { id: p.id, name: p.name, team_id } });
  }

  // The one combined poll: send my location, get the game back.
  if (path === '/api/poll' && method === 'POST') {
    const me = await playerFromToken(env, request);
    if (!me) return json({ error: 'not_joined' }, 401);
    // Players from an older game get sent back to the join screen.
    const game = await currentGame(env);
    if (!game || game.id !== me.game_id) return json({ error: 'not_joined' }, 401);
    const body = await request.json().catch(() => ({}));
    if (!me.last_seen_at || now() - me.last_seen_at > PING_EVERY_MS) {
      const hasLoc = Number.isFinite(body.lat) && Number.isFinite(body.lng);
      await env.DB.batch(hasLoc ? [
        env.DB.prepare('UPDATE players SET last_lat = ?, last_lng = ?, last_accuracy = ?, last_seen_at = ? WHERE id = ?')
          .bind(body.lat, body.lng, Number.isFinite(body.acc) ? body.acc : null, now(), me.id),
        env.DB.prepare('INSERT INTO pings (player_id, game_id, lat, lng, at) VALUES (?, ?, ?, ?, ?)')
          .bind(me.id, game.id, body.lat, body.lng, now()),
      ] : [env.DB.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').bind(now(), me.id)]);
    }
    const s = await gameState(env, game);
    // Other teams' check-in spots would give away photo locations, so strip them.
    const finds = s.finds.map((f) => (f.team_id === me.team_id ? f : { ...f, lat: null, lng: null }));
    return json({ ...s, finds, me: { id: me.id, name: me.name, team_id: me.team_id }, now: now() });
  }

  if (path === '/api/checkin' && method === 'POST') {
    const me = await playerFromToken(env, request);
    if (!me) return json({ error: 'not_joined' }, 401);
    const form = await request.formData();
    const photoId = form.get('photo_id');
    const lat = Number(form.get('lat')), lng = Number(form.get('lng'));
    const acc = Number(form.get('acc')) || null;
    const askJudge = form.get('ask_judge') === '1';
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "We couldn't get your location. Please try again." }, 400);

    const game = await currentGame(env);
    if (!game || game.id !== me.game_id) return json({ error: 'not_joined' }, 401);
    const status = effectiveStatus(game);
    if (status === 'setup') return json({ result: 'not_started' });
    // A check-in saved offline before the end still counts if it arrives within 30 minutes.
    const takenAt = Number(form.get('at')) || now();
    const lateOk = game.ends_at && takenAt <= game.ends_at && takenAt >= (game.started_at || 0) && now() - game.ends_at < 30 * 60000;
    if (status === 'ended' && !lateOk) return json({ result: 'ended' });

    const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ? AND game_id = ?').bind(photoId, game.id).first();
    if (!photo) return json({ error: 'That photo is no longer in the game.' }, 404);
    if (photo.lat == null) return json({ error: 'This photo has no spot set yet. Tell the organizer.' }, 400);

    const prior = await env.DB.prepare(
      "SELECT status FROM finds WHERE team_id = ? AND photo_id = ? AND status IN ('auto','approved','pending')"
    ).bind(me.team_id, photo.id).all();
    if (prior.results.some((f) => f.status !== 'pending')) return json({ result: 'already' });
    if (prior.results.length) return json({ result: 'pending_exists' });

    const distance = Math.round(haversine(lat, lng, photo.lat, photo.lng));
    let result;
    if (distance <= photo.radius_m) result = 'auto';
    else if (distance <= photo.radius_m * 2 || askJudge) result = 'pending';
    // Rounded so a far answer can't be used to triangulate the spot.
    else return json({ result: 'far', distance: Math.max(100, Math.round(distance / 50) * 50) });

    const proofKey = await putImage(env, form.get('proof'), 'proof');
    // Insert only if the team has no counted or pending find for this photo (guards against two teammates tapping at once).
    const ins = await env.DB.prepare(
      `INSERT INTO finds (id, game_id, photo_id, team_id, player_id, lat, lng, accuracy_m, distance_m, proof_key, status, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM finds WHERE team_id = ? AND photo_id = ? AND status IN ('auto','approved','pending'))`
    ).bind(id(), game.id, photo.id, me.team_id, me.id, lat, lng, acc, distance, proofKey, result, Math.min(takenAt, now()), me.team_id, photo.id).run();
    if (!ins.meta.changes) return json({ result: 'already' });
    bust(game.id);
    return json({ result, distance, points: photo.points });
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
      env.DB.prepare('SELECT * FROM finds WHERE game_id = ? ORDER BY created_at DESC').bind(game.id),
    ]);
    bust(game.id); // admin always sees fresh scores
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
    if (b.action === 'start') { sets.push("status = 'live'", 'started_at = ?', 'ends_at = ?'); vals.push(now(), b.minutes ? now() + b.minutes * 60000 : null); }
    if (b.action === 'end') { sets.push("status = 'ended'", 'ends_at = ?'); vals.push(now()); }
    if (b.action === 'reopen') { sets.push("status = 'live'", 'ends_at = NULL'); }
    if (b.action === 'setup') { sets.push("status = 'setup'", 'started_at = NULL', 'ends_at = NULL'); }
    if (!sets.length) return json({ error: 'Nothing to change' }, 400);
    await env.DB.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, game.id).run();
    bust(game.id);
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
    bust(game.id);
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
      bust(game.id);
      return json({ ok: true, id: pid });
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
      bust(game.id);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM finds WHERE photo_id = ? AND game_id = ?').bind(parts[1], game.id),
        env.DB.prepare('DELETE FROM photos WHERE id = ? AND game_id = ?').bind(parts[1], game.id),
      ]);
      bust(game.id);
      return json({ ok: true });
    }
  }

  if (parts[0] === 'finds') {
    if (method === 'POST' && !parts[1]) {
      // Manual fix: give a team a find.
      const { photo_id, team_id } = await request.json();
      // If the team has a pending find for this photo, approve it; skip if they already have it.
      const pend = await env.DB.prepare("UPDATE finds SET status = 'approved' WHERE team_id = ? AND photo_id = ? AND game_id = ? AND status = 'pending'").bind(team_id, photo_id, game.id).run();
      if (!pend.meta.changes) {
        await env.DB.prepare(
          `INSERT INTO finds (id, game_id, photo_id, team_id, status, created_at) SELECT ?, ?, ?, ?, 'approved', ?
           WHERE NOT EXISTS (SELECT 1 FROM finds WHERE team_id = ? AND photo_id = ? AND status IN ('auto','approved'))`
        ).bind(id(), game.id, photo_id, team_id, now(), team_id, photo_id).run();
      }
    } else if (method === 'PATCH') {
      const { status } = await request.json();
      if (!['approved', 'rejected'].includes(status)) return json({ error: 'Bad status' }, 400);
      await env.DB.prepare('UPDATE finds SET status = ? WHERE id = ? AND game_id = ?').bind(status, parts[1], game.id).run();
    } else if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM finds WHERE id = ? AND game_id = ?').bind(parts[1], game.id).run();
    }
    bust(game.id);
    return json({ ok: true });
  }

  if (parts[0] === 'players' && method === 'PATCH') {
    const { team_id } = await request.json();
    await env.DB.batch([
      env.DB.prepare('UPDATE players SET team_id = ? WHERE id = ? AND game_id = ?').bind(team_id, parts[1], game.id),
    ]);
    bust(game.id);
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
