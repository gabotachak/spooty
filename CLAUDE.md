# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

From repo root (npm workspaces):

```bash
# Install dependencies
npm install          # requires Node v20.20.0 (use nvm)

# Dev servers
npm run start:be     # backend watch mode (NestJS)
npm run start:fe     # frontend dev server with proxy to :3000

# Build
npm run build        # build both (output: dist/)
npm run build:be
npm run build:fe

# Production
npm run start        # runs dist/backend/main.js

# Backend only (from src/backend)
npm run lint         # ESLint + auto-fix
npm test             # Jest unit tests
npm run test:e2e     # e2e tests
npm run test:cov     # coverage
```

To run a single test file:
```bash
cd src/backend && npx jest path/to/file.spec.ts
```

## Architecture

Monorepo with two workspaces: `src/backend` (NestJS) and `src/frontend` (Angular 19). Built output goes to `dist/`. Backend serves the frontend statically in production via `ServeStaticModule`.

### Backend (NestJS + TypeORM + BullMQ)

**Modules:**
- `AppModule` — root: wires SQLite (TypeORM), Redis (BullMQ), static serving, scheduler
- `TrackModule` — track CRUD + two BullMQ queues: `track-search-processor` → `track-download-processor`
- `PlaylistModule` — playlist CRUD + hourly subscription polling via `@Interval`
- `SharedModule` — `SpotifyService`, `SpotifyApiService`, `YoutubeService`, `UtilsService`

**Download pipeline:**
1. User submits Spotify URL → `PlaylistService.create()` detects track vs. playlist via `SpotifyApiService.isTrackUrl()`
2. Spotify metadata fetched via `SpotifyApiService` (Client Credentials flow — no OAuth callback needed), fallback to `spotify-url-info`
3. Per-track metadata (cover art, album, year, track number, duration) stored on `TrackEntity`
4. `TrackService.create()` enqueues to `track-search-processor`
5. `TrackSearchProcessor` calls `YoutubeService.findOnYoutubeOne()` → enqueues to `track-download-processor`
6. `TrackDownloadProcessor` rate-limits via `YT_DOWNLOADS_PER_MINUTE`, calls `YoutubeService.downloadAndFormat()` (yt-dlp) + `addMetadata()` (node-id3 ID3 tags)

**YouTube search strategy** (`findOnYoutubeOne`):
- Searches `ytsearch5:<artist> - <name>` via yt-dlp flat playlist
- Scores results: prefers "- Topic" channels (official audio) within 30s of Spotify duration
- Falls back to closest-duration result, then first result
- Avoids music videos by matching against Spotify's `duration_ms` (converted to seconds)

**Metadata written to each file** (ID3 tags via node-id3):
- `title`, `artist`, `album`, `year`, `trackNumber` — sourced from Spotify per-track
- `APIC` cover art — sourced from Spotify per-track cover URL (never from playlist cover)
- Cover fallback order: `track.coverUrl` → YouTube thumbnail → playlist cover (last resort)

**Spotify API notes:**
- `/v1/playlists/{id}/tracks` returns 403 with Client Credentials — Spooty falls back to `spotify-url-info` for track list + `/v1/search` per track for metadata
- Redirect URI in Spotify Developer Dashboard is not needed (Client Credentials flow has no OAuth callback)

**Track status flow:** `New → Searching → Queued → Downloading → Completed | Error`

**Real-time updates:** Both `TrackService` and `PlaylistService` are `@WebSocketGateway()` — they emit `trackNew/trackUpdate/trackDelete` and `playlistNew/playlistUpdate/playlistDelete` via Socket.IO.

**Data model:**
- `PlaylistEntity` — has `isTrack: boolean` flag; individual tracks (not actual playlists) use `isTrack=true` and `active=false`
- `TrackEntity` — belongs to a `PlaylistEntity`; has `coverUrl`, `album`, `year`, `trackNumber`, `duration` for per-track Spotify metadata
- File naming: `<track-name> - <artist>.<format>` (sanitized: NFD normalize → lowercase → a-z0-9 only)
- File location: playlist tracks → `<DOWNLOADS_PATH>/<playlist-name>/<name> - <artist>.mp3`; individual tracks → `<DOWNLOADS_PATH>/<name> - <artist>.mp3`

### Frontend (Angular 19 + @ngneat/elf)

State management via `@ngneat/elf` stores. Components: `PlaylistBoxComponent`, `TrackListComponent`. Services proxy to backend `/api/**` and WebSocket via `proxy.conf.json` during dev (port 4200 → 3000).

### Infrastructure

Requires Redis for BullMQ queues. `RUN_REDIS=true` starts Redis in-process (Docker). SQLite database at `DB_PATH`.

**Local dev**: set `DB_PATH` to an absolute path outside the repo (e.g. `~/.config/spooty/db.sqlite`) to avoid SQLite read-only errors caused by leftover Docker-owned files in `dist/`.

`YT_COOKIES` (browser name, non-Docker) or `YT_COOKIES_FILE` (Netscape cookies.txt, Docker) for YouTube auth. If both are set, `YT_COOKIES` takes priority.

**Stale queue jobs**: BullMQ job IDs are keyed by track DB id. If you reset the DB but keep Redis, old jobs won't re-run and new ones may conflict. Run `redis-cli FLUSHALL` after any DB reset.
