# Thanksgiving Photo Hunt

Phone website for a neighborhood photo scavenger hunt. Players find the spot in each photo and send a picture from there. The server quietly marks each one right or wrong by GPS, and nobody sees the results until the organizer reveals them at the end.

- Player: https://photo-hunt.twmdemuth.workers.dev
- Admin: https://photo-hunt.twmdemuth.workers.dev/admin (password in `admin-password.txt`, not committed)
- TV at home base: https://photo-hunt.twmdemuth.workers.dev/tv (same password). Map of where everyone is, one column per team with every photo they sent (right/wrong and how far off), a big pop-up for each new photo, and a step-by-step final reveal with sound. ⚙ Settings: no spoilers, pop-ups, trails, names, sound. Click the page once so the browser allows sound. Keys: F full screen, H no spoilers, R replay the reveal.

## How a game runs
1. Players scan the QR code and wait in the lobby (their team's color), where they can see everyone and switch teams. Admin presses Start: a 10-second countdown on every phone and the TV, then the hunt opens and teams are locked.
2. Players send a picture + location for each spot. They see only "Sent", how many photos each team and person has sent, teammates on the map, and "Red team found something!" pop-ups.
3. Server marks each answer: within the photo's radius = yes; close call = judge queue; far = no (the judge can still approve it). "Submit again" replaces a team's answer; only the newest counts.
4. When the game ends, phones lock to "Game over! See the results on the main screen." Admin clears the judge queue, then presses Reveal results for the TV.
5. The admin can change any call at any time (Yes / No / Reset to what GPS said). After the game, "Reset and play again" clears every photo sent and all trails but keeps players, teams and photos.

## Stack
Cloudflare Worker (`src/worker.js`) serving static files from `public/` plus a JSON API. Photo uploads accept JPEG, PNG and iPhone HEIC; HEIC is decoded in the browser with `public/vendor/heic-to.js` (libheif, LGPL, loaded only when needed) and the location is read from the photo with exifr. D1 for data (`schema.sql`), Workers KV for photos (swap to R2 later: change `putImage`/`serveImage` and the binding).

## Commands
```
npm run dev        # local server on :8787 (password in .dev.vars)
npm run deploy     # deploy to workers.dev
npm run db:remote  # apply schema.sql to a new database
```
Updates: every write bumps `games.version`; phones poll every 4 s and the TV every 3 s with the last version they saw, and get a tiny "nothing new" reply until it changes. Locations are saved every 12 s.

Existing databases: apply each file in `migrations/` once, e.g.
`npx wrangler d1 execute photo-hunt-db --remote --file=migrations/001-hidden-results.sql`

Tests (local only, they wipe the current game): `node scripts/seed.mjs http://localhost:8787 <pw> && node scripts/test-rules.mjs http://localhost:8787 <pw>`
