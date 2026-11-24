-- TV settings and remote controls, set from the admin page (the TV itself has no password or buttons).
ALTER TABLE games ADD COLUMN tv_settings TEXT;
ALTER TABLE games ADD COLUMN tv_cmd TEXT;
ALTER TABLE games ADD COLUMN tv_cmd_at INTEGER;
