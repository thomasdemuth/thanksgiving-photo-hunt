-- What each phone reported when it had no location (browser, permission, error), shown to the host.
ALTER TABLE players ADD COLUMN loc_why TEXT;
