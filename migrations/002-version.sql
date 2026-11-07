-- Change counter: goes up on every write, so phones can ask "anything new?" cheaply.
ALTER TABLE games ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
