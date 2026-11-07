-- Hidden results + TV view. Safe to run once on a database made from the old schema.sql.
ALTER TABLE games ADD COLUMN revealed_at INTEGER;
ALTER TABLE finds ADD COLUMN judged_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_pings_game ON pings(game_id, at);
