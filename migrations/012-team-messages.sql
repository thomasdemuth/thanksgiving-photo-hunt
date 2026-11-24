-- Messages from the host to one team (messages to everyone stay on games.announce_text).
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, team_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_game ON messages(game_id, created_at);
-- Each phone's poll looks up its teammates by team.
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
