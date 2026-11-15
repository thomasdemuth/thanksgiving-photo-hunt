-- What each phone reports about its location (ok / off / searching) and when a real location last arrived.
ALTER TABLE players ADD COLUMN loc_state TEXT;
ALTER TABLE players ADD COLUMN loc_at INTEGER;
