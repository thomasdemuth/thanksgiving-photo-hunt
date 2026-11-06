# Thanksgiving Photo Hunt

Phone website for a neighborhood photo scavenger hunt. Players find the spot in each photo and check in on location; the server scores it.

- Player: https://photo-hunt.twmdemuth.workers.dev
- Admin: https://photo-hunt.twmdemuth.workers.dev/admin (password in `admin-password.txt`, not committed)

## Stack
Cloudflare Worker (`src/worker.js`) serving static files from `public/` plus a JSON API. D1 for data (`schema.sql`), Workers KV for photos (swap to R2 later: change `putImage`/`serveImage` and the binding).

## Commands
```
npm run dev        # local server on :8787 (password in .dev.vars)
npm run deploy     # deploy to workers.dev
npm run db:remote  # apply schema.sql to the live database
```
