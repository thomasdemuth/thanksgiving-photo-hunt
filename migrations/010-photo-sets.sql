-- Photo sets: saved hunt content (photos, play area, home base) the host can load into a game.
-- Items copy only the KV image keys, so sets and games share the same pictures.
CREATE TABLE IF NOT EXISTS photo_sets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  boundary_geojson TEXT, home_lat REAL, home_lng REAL, home_label TEXT
);
CREATE TABLE IF NOT EXISTS photo_set_items (
  id TEXT PRIMARY KEY, set_id TEXT NOT NULL, title TEXT, difficulty INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 1, lat REAL, lng REAL, radius_m INTEGER NOT NULL DEFAULT 40,
  hint TEXT, image_key TEXT NOT NULL, thumb_key TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_set_items_set ON photo_set_items(set_id);
