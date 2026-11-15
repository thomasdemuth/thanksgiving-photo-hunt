-- Extra admins (e.g. Dad) who sign in with their own password, set through a one-time invite link.
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- Only hashes of invite and sign-in tokens are stored, so a copy of the database can't be used to sign in.
CREATE TABLE IF NOT EXISTS admin_invites (
  token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY, admin_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admins_name ON admins(name_key);
