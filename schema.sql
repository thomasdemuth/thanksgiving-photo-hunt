CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'setup',
  boundary_geojson TEXT, join_code TEXT, started_at INTEGER, ends_at INTEGER,
  revealed_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, team_id TEXT NOT NULL, name TEXT NOT NULL,
  name_key TEXT NOT NULL, token TEXT NOT NULL UNIQUE, last_lat REAL, last_lng REAL,
  last_accuracy REAL, last_seen_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, title TEXT, difficulty INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 1, lat REAL, lng REAL, radius_m INTEGER NOT NULL DEFAULT 40,
  hint TEXT, image_key TEXT NOT NULL, thumb_key TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS finds (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, photo_id TEXT NOT NULL, team_id TEXT NOT NULL,
  player_id TEXT, lat REAL, lng REAL, accuracy_m REAL, distance_m REAL, proof_key TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, judged_at INTEGER
);
CREATE TABLE IF NOT EXISTS pings (
  player_id TEXT NOT NULL, game_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_game ON teams(game_id);
CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id, name_key);
CREATE INDEX IF NOT EXISTS idx_photos_game ON photos(game_id);
CREATE INDEX IF NOT EXISTS idx_finds_game ON finds(game_id);
CREATE INDEX IF NOT EXISTS idx_finds_team_photo ON finds(team_id, photo_id);
CREATE INDEX IF NOT EXISTS idx_pings_player ON pings(player_id, at);
CREATE INDEX IF NOT EXISTS idx_pings_game ON pings(game_id, at);
CREATE INDEX IF NOT EXISTS idx_games_created ON games(created_at);
