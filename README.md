# Twitter Stock Ticker Extractor - Firefox Extension

Extracts stock ticker symbols (`$TSLA`) and their post URLs from X as you scroll, and uploads them to a Turso (libSQL) database.

## Features
- Monitors x.com for cashtag links and records ticker + post URL + timestamp (reposts and replies are skipped)
- Auto-scroll with stuck-page detection: if no new posts load for 6 seconds, it scrolls back up ~15 posts and continues
- Uploads new pairs to Turso automatically (duplicates are ignored via a `(ticker, url)` primary key)
- Popup shows local pair count and the database's pair/ticker counts
- Top-mentions analysis with time filter

## Installation
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" and select `manifest.json`

## Turso setup
1. Click **Turso Credentials** in the popup
2. Paste `{"url": "libsql://your-db.turso.io", "auth_token": "..."}`, drop a `turso.json` file, or pick one
3. Credentials are validated, the `ticker_posts` table is created if needed, and they are stored in the extension's local storage

Use **Sync All to Turso** to push everything stored in the extension to the database.

## Playwright scraper (optional)
`scraper/` contains a Playwright version that scrapes the Following timeline and writes to the same Turso table. It reads `scraper/turso.json` and `scraper/cookies.json` (X `auth_token` and `ct0` cookies). Both files are gitignored.

## Permissions
- `https://x.com/*` - read posts
- `https://*.turso.io/*` - upload to the database
- `storage`, `tabs`, `activeTab` - local data and auto-scroll control

## Privacy
Data goes only to your own Turso database. The auth token is stored in the browser's extension storage.
