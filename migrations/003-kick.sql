-- Players the host removed. Kept (not deleted) so the photos they sent keep their name.
ALTER TABLE players ADD COLUMN kicked_at INTEGER;
