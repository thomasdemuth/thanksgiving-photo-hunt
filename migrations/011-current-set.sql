-- Which photo set the game is using, so switching sets can save it first.
ALTER TABLE games ADD COLUMN set_id TEXT;
