# DnD Battlemap

A real-time interactive battle map for running D&D sessions. The DM imports a PDF map, drops pins for players/monsters, and shares live-updating links with players — all synced over WebSocket. No build step: a Node/Express server and a single vanilla HTML/CSS/JS frontend.

Deliberately does **not** roll dice for you — that stays on the table. This is a shared map and tracker, not a virtual tabletop that takes over the game.

## Features

- **PDF map import**, calibrated to real-world scale by clicking two points a known distance apart
- **Pins** for players/monsters (custom name, color, D&D 5e size, speed, HP, status conditions)
- **Live multiplayer sync** over WebSocket — the DM and any number of players see updates instantly
- **Player links** (`/play/<pinId>`) — send a player a link to their own pin; no account needed, and they can only move/edit that one pin
- **Turn-based combat** with initiative order, per-turn movement budgets, and round tracking
- **Line of sight** — monsters are only revealed to players who (or whose party) can actually see them
- **Solid areas** (walls, terrain) that block movement, sight, and attack range
- **AoE spell templates** — cone/circle/line, using actual 5e geometry
- **Attack range** circles (melee or normal/long ranged), blocked by solid areas
- **Touch support** — pinch-to-zoom and pan for tablet players

## Running locally

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:3000` — that's the DM view. Data is saved to `data/battlemap-data.json` (created automatically).

## Sharing with players

From a pin's info panel, click the 🔗 link button to copy a player link (`/play/<pinId>`). Send that to the player — opening it gives them a reduced view where they can only move and edit their own pin.

## Protecting a public deployment

If you're hosting this somewhere public (not just `localhost`), set an `APP_PASSWORD` (and optionally `APP_USERNAME`, default `dm`) environment variable to require HTTP Basic Auth on the DM page and API:

```bash
APP_USERNAME=dm APP_PASSWORD=yourpassword npm start
```

Leaving `APP_PASSWORD` unset disables auth entirely (the default for local dev). Player links (`/play/<pinId>`) are never gated behind this — the link itself is the access control there.

## Deploying

A [render.yaml](render.yaml) blueprint is included for [Render](https://render.com): a web service with a persistent disk (so uploaded maps and save data survive restarts) and `APP_USERNAME`/`APP_PASSWORD` set as secrets in Render's dashboard.

## Tech stack

Node.js, Express, `ws` (WebSocket), `pdfjs-dist` for PDF rendering, and a single-page vanilla JS frontend — no build tooling required.
