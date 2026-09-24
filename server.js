const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const http    = require('http');
const { WebSocketServer } = require('ws');

// DATA_DIR lets a host mount persistent storage wherever it likes (e.g. a Render disk at
// /data) without the app needing to know that host's checkout-directory convention; defaults
// to the local dev layout (a `data/` folder next to server.js) when unset.
const dataDir    = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const statePath  = path.join(dataDir, 'battlemap-data.json');

fs.mkdirSync(uploadsDir, { recursive: true });

const defaultState = {
  activeMapId: null,
  maps: {}, // id -> { id, name, file, scale, pins }
  // A player character's identity/stats, independent of any one map — see the migration
  // loop below and resolvedPins() for how a map's player-type pins reference this.
  characters: {}, // id -> { id, name, color, size, speed, hpMax, hpCurrent, conditions, icon, attackRange, attackLongRange }
};

function loadState() {
  try { return { ...defaultState, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return { ...defaultState, maps: {}, characters: {} }; }
}

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Single in-memory authoritative copy — both REST handlers and websocket actions
// mutate this directly (never re-read from disk mid-request), then persist + broadcast.
let state = loadState();

function defaultInitiative() {
  // order: [{ id, pinIds: [pinId,...] }] — more than one pinId means a DM-grouped entry
  // (e.g. "3 goblins") that acts as one turn. traveled tracks each active pin's cumulative
  // movement distance (px) so far this turn, so a player can move, act (e.g. cast a spell),
  // then move again and still be held to one total speed's worth of movement — movePin clamps
  // each new drag against the remaining budget rather than giving it a fresh one.
  return { order: [], active: false, currentIndex: 0, round: 1, traveled: {} };
}
// Existing maps saved before this feature existed won't have `initiative` on disk; maps saved
// by an earlier build of this feature have `initiative` but not yet `traveled`.
for (const map of Object.values(state.maps)) {
  if (!map.initiative) map.initiative = defaultInitiative();
  else if (!map.initiative.traveled) map.initiative.traveled = {};
  if (!map.templates) map.templates = [];
  if (!map.doors) map.doors = [];
  // "Solid areas" (rectangles) generalized into zones (arbitrary polygons tagged with a
  // kind — see ZONE_KINDS below). A rectangle is just a 4-point polygon, so existing
  // obstacles migrate losslessly into zones tagged kind:'solid' the first time a map saved
  // before this existed loads.
  if (!map.zones) {
    map.zones = (map.obstacles || []).map(o => ({
      id: o.id,
      kind: 'solid',
      points: [
        { x: o.x, y: o.y }, { x: o.x + o.w, y: o.y },
        { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h },
      ],
    }));
    delete map.obstacles;
  }
  // A player pin used to carry its own name/hp/conditions/icon/etc, scoped to this one map —
  // switching maps meant recreating that player from scratch, losing all of it. Split into a
  // campaign-level character record (this map's-worth-of-migration below writes it into
  // state.characters, done once per pin) plus a lightweight per-map token that just marks
  // where that character is on THIS map: { id, type:'player', characterId, wx, wy }.
  //
  // Both the character AND the token keep the pin's ORIGINAL id (deliberately the same value
  // in both places, even though they're otherwise unrelated ids in two different collections)
  // rather than minting a fresh one for either: an already-shared /play/<id> link resolves via
  // the character id, while this map's initiative.order[].pinIds / initiative.traveled — which
  // reference the TOKEN id — were saved before this migration ever ran and can't be rewritten
  // retroactively, so the token has to keep answering to that same id or every in-progress
  // turn order on this map silently orphans itself (found by testing this exact migration on a
  // disposable copy of the real campaign data before ever running it for real).
  //
  // Idempotent: a pin with `characterId` already set has already been migrated (or was created
  // fresh under this system to begin with), so it's left alone.
  map.pins = map.pins.map(p => {
    if (p.type !== 'player' || p.characterId) return p;
    const characterId = p.id;
    if (!state.characters[characterId]) {
      state.characters[characterId] = {
        id: characterId, name: p.name, color: p.color, size: p.size, speed: p.speed,
        hpMax: p.hpMax, hpCurrent: p.hpCurrent, conditions: p.conditions || [],
        icon: p.icon || '', attackRange: p.attackRange, attackLongRange: p.attackLongRange,
      };
    }
    return { id: p.id, type: 'player', characterId, wx: p.wx, wy: p.wy };
  });
}

// Overlays a player token's character record on top of the token itself — token fields (id,
// type, characterId, wx, wy) win over any same-named character field, so the result reads
// exactly like the old self-contained pin (name, hpCurrent, icon, ... plus wx/wy) with one
// addition (characterId). Monster pins pass through unchanged; they were never split out.
function resolvePin(p) {
  if (p.type !== 'player') return p;
  const character = state.characters[p.characterId];
  return character ? { ...character, ...p } : p;
}
function resolvedPins(map) {
  return map.pins.map(resolvePin);
}

function activeEntry(map) {
  const init = map.initiative;
  if (!init || !init.active) return null;
  return init.order[init.currentIndex] || null;
}

function resetTraveled(map, entry) {
  if (!entry) return;
  for (const pinId of entry.pinIds) map.initiative.traveled[pinId] = 0;
}

// ── basic auth ───────────────────────────────────────────────────────
// Opt-in: unset APP_PASSWORD (the default for local dev) disables auth entirely, so nothing
// changes for local testing. Set it (and optionally APP_USERNAME) once this is deployed
// somewhere public, so a stranger who finds the URL can't rack up hosting costs — the
// expensive operation is the map upload (up to 100MB), so that's the one that most needs
// gating, along with the DM page itself and the raw state dump.
//
// Player links (/play/:characterId) stay open on purpose — sharing the link *is* the access
// control there, same as it's always been; requiring the DM's password too would break the
// whole point of a just-send-a-link flow.
const APP_USERNAME = process.env.APP_USERNAME || 'dm';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
function checkBasicAuth(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  let decoded;
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return false; }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  return decoded.slice(0, sep) === APP_USERNAME && decoded.slice(sep + 1) === APP_PASSWORD;
}
function requireBasicAuth(req, res, next) {
  if (checkBasicAuth(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="DnD Battlemap DM"');
  res.status(401).send('Authentication required.');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, _file, cb) => {
      const id = crypto.randomUUID();
      req.mapId = id;
      cb(null, `${id}.pdf`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are supported.'));
    cb(null, true);
  },
  limits: { fileSize: 100 * 1024 * 1024 },
});

const app = express();
// No global express.json() — the only JSON-body route (map import, below) needs a much
// higher size limit than the sane-default one Express would otherwise apply, and every other
// route either takes no body or is multer's multipart form (which parses its own req.body).
app.get('/', requireBasicAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/play/:characterId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// No express.static(public) here on purpose — the only file in public/ is index.html, and
// it's served explicitly above (with auth on the DM route, without on the player route);
// a blanket static mount would let /index.html bypass that split entirely.
app.use('/uploads', express.static(uploadsDir));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));

app.get('/api/state', requireBasicAuth, (_req, res) => {
  res.json(state);
});

app.post('/api/maps', requireBasicAuth, (req, res) => {
  // Auth runs before multer touches the request body, so an unauthenticated request never
  // gets far enough to have a large file written to disk in the first place.
  upload.single('map')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'PDF is too large (max 100MB).' : (err.message || 'Import failed.');
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    const id = req.mapId;
    const name = (req.body.name || req.file.originalname || 'Map').toString().trim().slice(0, 80) || 'Map';
    state.maps[id] = {
      id,
      name,
      file: `${id}.pdf`,
      scale: null, // pixels-per-foot, set by clicking two points a known distance apart
      pins: [], // { id, type: 'player'|'monster', name, color, icon, speed, attackRange, attackLongRange, hpMax, hpCurrent, conditions, hidden, wx, wy }
      zones: [], // { id, kind: 'solid'|'difficult'|'water', points: [{x,y},...] } — see ZONE_KINDS; geometry visible to everyone, whether the DM's marker/authoring box is player-visible depends on kind (see stateForConnection and ZONE_KINDS.visibleToPlayers client-side)
      templates: [], // { id, shape: 'cone'|'circle'|'line', x, y, angle, length, radius, width } — visible to everyone
      doors: [], // { id, x1, y1, x2, y2, open } — blocks LOS/movement like an obstacle edge while closed; DM-only to place/remove/toggle, geometry and open/closed state visible to everyone (same reasoning as obstacles — a door is not secret, only the authoring controls are)
      initiative: defaultInitiative(),
    };
    state.activeMapId = id;
    saveState();
    broadcastState();
    res.json(state);
  });
});

// A single self-contained JSON file: the map's own data (pins/zones/doors/templates/
// initiative), every character referenced by one of its player pins (so re-importing it
// doesn't leave player tokens pointing at characters that don't exist), and the background
// PDF itself as base64 — so importing this file recreates the map in full even on a server
// that's never seen it before, no separate PDF upload required.
app.get('/api/maps/:id/export', requireBasicAuth, (req, res) => {
  const map = state.maps[req.params.id];
  if (!map) return res.status(404).json({ error: 'Map not found.' });
  let pdfBase64;
  try {
    pdfBase64 = fs.readFileSync(path.join(uploadsDir, map.file)).toString('base64');
  } catch {
    return res.status(500).json({ error: "This map's PDF file is missing on disk — can't export it." });
  }
  const characterIds = new Set(map.pins.filter(p => p.type === 'player').map(p => p.characterId));
  const characters = {};
  for (const id of characterIds) if (state.characters[id]) characters[id] = state.characters[id];
  const exportBody = {
    kind: 'dndbattlemap-map-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    map: {
      name: map.name, scale: map.scale, fogEdgeFt: map.fogEdgeFt, fogFeatherFt: map.fogFeatherFt, pins: map.pins, zones: map.zones,
      doors: map.doors, templates: map.templates, initiative: map.initiative,
    },
    characters,
    pdf: { dataBase64: pdfBase64 },
  };
  const filename = (map.name || 'map').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || 'map';
  res.set('Content-Disposition', `attachment; filename="${filename}.dndbattlemap.json"`);
  res.json(exportBody);
});

// Always creates a brand-new map (never overwrites an existing one, same as uploading a fresh
// PDF does) with fresh ids throughout — pins, zones, doors, templates, and every referenced
// character all get new ids, remapped consistently so cross-references (a pin's characterId,
// an initiative entry's pinIds, traveled's keys) stay correct. Never reuses the ids from the
// export file itself: importing the same file twice, or into a campaign that already has a
// character with a colliding id, must never silently merge with or overwrite something that
// already exists — every import is a fully independent copy the DM can then manage normally
// (rename, delete, edit) like any other map/character.
app.post('/api/maps/import', requireBasicAuth, express.json({ limit: '150mb' }), (req, res) => {
  const body = req.body;
  if (!body || body.kind !== 'dndbattlemap-map-export' || !body.map || !body.pdf?.dataBase64) {
    return res.status(400).json({ error: "That doesn't look like an exported map file." });
  }
  let pdfBuffer;
  try { pdfBuffer = Buffer.from(body.pdf.dataBase64, 'base64'); }
  catch { return res.status(400).json({ error: 'Could not read the embedded PDF data.' }); }
  if (!pdfBuffer.length) return res.status(400).json({ error: 'Could not read the embedded PDF data.' });

  const characterIdMap = new Map(); // old id -> new id
  const characters = {};
  for (const [oldId, character] of Object.entries(body.characters || {})) {
    const newId = crypto.randomUUID();
    characterIdMap.set(oldId, newId);
    characters[newId] = { ...character, id: newId };
  }
  const pinIdMap = new Map(); // old token id -> new token id
  const pins = (body.map.pins || [])
    .map(p => {
      const newId = crypto.randomUUID();
      if (p.type === 'player') {
        const newCharacterId = characterIdMap.get(p.characterId);
        if (!newCharacterId) return null; // export referenced a character it didn't actually include — drop the pin rather than create a broken one
        pinIdMap.set(p.id, newId);
        return { id: newId, type: 'player', characterId: newCharacterId, wx: p.wx, wy: p.wy };
      }
      pinIdMap.set(p.id, newId);
      return { ...p, id: newId };
    })
    .filter(Boolean);
  const zones = (body.map.zones || []).map(z => ({ ...z, id: crypto.randomUUID() }));
  const doors = (body.map.doors || []).map(d => ({ ...d, id: crypto.randomUUID() }));
  const templates = (body.map.templates || []).map(t => ({ ...t, id: crypto.randomUUID() }));

  const oldInit = body.map.initiative;
  let initiative = defaultInitiative();
  if (oldInit) {
    const order = (oldInit.order || [])
      .map(entry => ({ id: crypto.randomUUID(), pinIds: (entry.pinIds || []).map(id => pinIdMap.get(id)).filter(Boolean) }))
      .filter(entry => entry.pinIds.length > 0);
    const traveled = {};
    for (const [oldPinId, v] of Object.entries(oldInit.traveled || {})) {
      const newPinId = pinIdMap.get(oldPinId);
      if (newPinId) traveled[newPinId] = v;
    }
    initiative = order.length
      ? { order, active: !!oldInit.active, currentIndex: Math.min(oldInit.currentIndex || 0, order.length - 1), round: oldInit.round || 1, traveled }
      : defaultInitiative();
  }

  const mapId = crypto.randomUUID();
  fs.writeFileSync(path.join(uploadsDir, `${mapId}.pdf`), pdfBuffer);
  const name = (body.map.name ? `${body.map.name} (imported)` : 'Imported map').toString().trim().slice(0, 80) || 'Imported map';
  Object.assign(state.characters, characters);
  state.maps[mapId] = {
    id: mapId, name, file: `${mapId}.pdf`, scale: body.map.scale ?? null, fogEdgeFt: body.map.fogEdgeFt, fogFeatherFt: body.map.fogFeatherFt,
    pins, zones, doors, templates, initiative,
  };
  state.activeMapId = mapId;
  saveState();
  broadcastState();
  res.json(state);
});

app.delete('/api/maps/:id', requireBasicAuth, (req, res) => {
  const map = state.maps[req.params.id];
  if (!map) return res.status(404).json({ error: 'Map not found.' });

  try { fs.unlinkSync(path.join(uploadsDir, map.file)); } catch {}
  delete state.maps[req.params.id];

  if (state.activeMapId === req.params.id) {
    const remaining = Object.keys(state.maps);
    state.activeMapId = remaining[0] || null;
  }
  saveState();
  broadcastState();
  res.json(state);
});

// ── zones ──────────────────────────────────────────────────────────────
// A zone's kind determines its behavior — table-driven so a new kind later is one row here,
// not scattered special-casing through LOS/movement/rendering code. costMultiplier isn't
// enforced yet (difficult terrain is a visible marker for now, not auto-applied movement
// math — a deliberate first-pass scoping, see the story this was built from) but is recorded
// for when that gets picked up, so the data model doesn't need to change again for it.
const ZONE_KINDS = {
  solid:     { blocksLOS: true,  blocksMovement: true,  costMultiplier: 1 },
  difficult: { blocksLOS: false, blocksMovement: false, costMultiplier: 2 },
  // Water doesn't block sight or movement either (swimming without a swim speed costs extra
  // like difficult terrain, per 5e, but that's the same not-yet-enforced costMultiplier story).
  water:     { blocksLOS: false, blocksMovement: false, costMultiplier: 2 },
};

// ── line of sight ─────────────────────────────────────────────────────
// A zone whose kind blocks LOS blocks sight along all of its polygon edges (a rectangle is
// just the 4-edge case); two points have LOS if the segment between them crosses none of
// those edges, for any blocking zone.
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
// A closed door blocks like a solid zone edge; an open one blocks nothing — same segment-
// intersection test, just a single fixed segment per door instead of a polygon's worth.
function hasLOS(a, b, zones, doors) {
  const pa = { x: a.wx, y: a.wy }, pb = { x: b.wx, y: b.wy };
  for (const z of zones) {
    if (!ZONE_KINDS[z.kind]?.blocksLOS) continue;
    const pts = z.points;
    for (let i = 0; i < pts.length; i++) {
      if (segmentsIntersect(pa, pb, pts[i], pts[(i + 1) % pts.length])) return false;
    }
  }
  for (const d of doors || []) {
    if (d.open) continue;
    if (segmentsIntersect(pa, pb, { x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 })) return false;
  }
  return true;
}
// Same shape as hasLOS but reads blocksMovement instead of blocksLOS — kept as its own
// function rather than reusing hasLOS, since every kind so far happens to set both flags the
// same way but a future one (e.g. cover that blocks sight without blocking movement, or the
// reverse) shouldn't require re-coupling this.
function movementBlockedBy(fromWx, fromWy, toWx, toWy, zones, doors) {
  const pa = { x: fromWx, y: fromWy }, pb = { x: toWx, y: toWy };
  for (const z of zones) {
    if (!ZONE_KINDS[z.kind]?.blocksMovement) continue;
    const pts = z.points;
    for (let i = 0; i < pts.length; i++) {
      if (segmentsIntersect(pa, pb, pts[i], pts[(i + 1) % pts.length])) return true;
    }
  }
  for (const d of doors || []) {
    if (d.open) continue;
    if (segmentsIntersect(pa, pb, { x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 })) return true;
  }
  return false;
}
// Standard ray-casting / even-odd point-in-polygon test.
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// 5e rule: difficult terrain doesn't stack (two overlapping patches still just cost double,
// not quadruple) — so this is the MAX multiplier among every non-blocking zone containing the
// point, not a sum or product. blocksMovement zones are excluded entirely: they're handled as
// an outright block (movementBlockedBy above), not a cost, and a pin should never legally be
// standing inside one to query a multiplier for in the first place.
function costMultiplierAt(x, y, zones) {
  let mult = 1;
  for (const z of zones) {
    const info = ZONE_KINDS[z.kind];
    if (!info || info.blocksMovement || info.costMultiplier <= mult) continue;
    if (pointInPolygon(x, y, z.points)) mult = info.costMultiplier;
  }
  return mult;
}
// Parametric segment-vs-segment intersection bounded to both segments (t, s both in [0,1]),
// unlike segmentsIntersect (a plain boolean) or rayIntersectsSegment-style helpers (an
// unbounded ray) — this one needs the actual crossing point along a finite drag path, not just
// whether it crosses.
function segmentIntersectionT(x1, y1, x2, y2, p3, p4) {
  const d1x = x2 - x1, d1y = y2 - y1;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null; // parallel
  const t = ((p3.x - x1) * d2y - (p3.y - y1) * d2x) / denom;
  const s = ((p3.x - x1) * d1y - (p3.y - y1) * d1x) / denom;
  if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return t;
  return null;
}
// Walks a straight drag path from (fromX,fromY) to (toX,toY), charging costMultiplier-weighted
// distance against `budget` instead of plain euclidean distance, and returns where the pin
// actually ends up once the budget runs out (which may be short of the requested destination).
// Only ever called on a path already confirmed clear of blocksMovement zones — movePin checks
// that separately and rejects the whole move outright rather than sliding to a wall, so this
// only ever has to reason about *cost*, not blocking.
//
// Splits the path at every point it crosses a costly zone's boundary, then walks those
// sub-segments in order — each one has a single, well-defined multiplier throughout (sampled
// at its midpoint), so the running cost total is exact, not an approximation. If the budget
// runs out partway through a sub-segment, that sub-segment's own multiplier gives the exact
// stopping point by simple division, rather than an angular/stepped approximation.
function traceCostAlongPath(fromX, fromY, toX, toY, zones, budget) {
  const totalDist = Math.hypot(toX - fromX, toY - fromY);
  if (totalDist === 0) return { x: fromX, y: fromY, costUsed: 0 };
  const breakpoints = new Set([0, 1]);
  for (const z of zones) {
    const info = ZONE_KINDS[z.kind];
    if (!info || info.blocksMovement || info.costMultiplier === 1) continue;
    const pts = z.points;
    for (let i = 0; i < pts.length; i++) {
      const t = segmentIntersectionT(fromX, fromY, toX, toY, pts[i], pts[(i + 1) % pts.length]);
      if (t !== null) breakpoints.add(t);
    }
  }
  const sorted = [...breakpoints].sort((a, b) => a - b);
  let costSoFar = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i], t1 = sorted[i + 1];
    const midT = (t0 + t1) / 2;
    const mult = costMultiplierAt(fromX + (toX - fromX) * midT, fromY + (toY - fromY) * midT, zones);
    const segDist = totalDist * (t1 - t0);
    const segCost = segDist * mult;
    if (costSoFar + segCost > budget) {
      const partialDist = (budget - costSoFar) / mult;
      const stopT = t0 + (partialDist / totalDist);
      return { x: fromX + (toX - fromX) * stopT, y: fromY + (toY - fromY) * stopT, costUsed: budget };
    }
    costSoFar += segCost;
  }
  return { x: toX, y: toY, costUsed: costSoFar };
}

// ── realtime layer ────────────────────────────────────────────────────
// Every connection is either the DM (full control), a player linked to one pin id (can only
// move/adjust-HP on that pin), or — new since basic auth — unauthenticated (role stays null:
// they asked for 'dm' over the websocket without a valid Authorization header, see the
// 'hello' handler below). This split is what lets stateForConnection() below filter what's
// broadcast to whom without any further data-model changes: pins already carry a `hidden`
// flag (unused today, always false) for a future fog-of-war feature to use the same way.
const clients = new Set(); // { ws, role: 'dm'|'player'|null, characterId: string|null, authenticatedDm: boolean }

function stateForConnection(conn) {
  // Both branches send fully-resolved pins (character fields overlaid onto player tokens) —
  // the client reads pin.name/hpCurrent/icon/etc exactly like before the character/token
  // split, and only needs to know about pin.characterId for the handful of places that
  // specifically care (the player link, and offering "place an existing character").
  if (conn.role === 'dm') {
    const maps = {};
    for (const [id, map] of Object.entries(state.maps)) maps[id] = { ...map, pins: resolvedPins(map) };
    return { ...state, maps };
  }
  // Explicit allow-list for the one privileged case above, rather than a deny-list on
  // 'player' — an unauthenticated connection (role null) must fall through to this filtered
  // branch exactly like a player does, not get the unfiltered state by default.
  const maps = {};
  for (const [id, map] of Object.entries(state.maps)) {
    // Zone geometry itself isn't secret — a wall (or a patch of mud) is right there on the
    // map — so the raw polygons are sent to everyone regardless of kind. Whether the DM's
    // authoring marker itself is player-visible is a per-kind, client-side rendering decision
    // (see ZONE_KINDS.visibleToPlayers and renderZones() in index.html), not something this
    // state filtering does. Sending the real geometry to players is also what lets their own
    // client predict movement-blocking and compute their own attack-range shape locally,
    // instead of only finding out from a server rejection after the fact.
    //
    // A monster pin is only sent to a player at all if SOME player pin has line of sight to
    // it (shared party vision: once the party can see a monster, everyone in the party knows
    // it's there). Separately, each monster pin sent carries `losFromMe`: whether THIS
    // player's own pin specifically has a clear line to it — shared vision can reveal a
    // monster's existence without this player being able to target it themselves (e.g. a
    // teammate down the hall spots it around a corner this player can't see past), and that
    // distinction has to be visible in the UI for targeting decisions.
    const resolved = resolvedPins(map);
    const playerPins = resolved.filter(p => p.type === 'player');
    // Matched by characterId, not token id — a player's identity now follows their character
    // across maps, so "my pin on this map" is whichever token here (if any) is theirs.
    const myPin = resolved.find(p => p.type === 'player' && p.characterId === conn.characterId);
    const pins = resolved
      .filter(p => p.type !== 'monster' || playerPins.some(pp => hasLOS(pp, p, map.zones, map.doors)))
      .map(p => p.type !== 'monster' ? p : { ...p, losFromMe: !!myPin && hasLOS(myPin, p, map.zones, map.doors) });
    maps[id] = { ...map, pins };
  }
  return { ...state, maps };
}

function send(conn, msg) {
  if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
}

function broadcastState() {
  // Every connection gets every update, including the sender of the action that caused it.
  // A websocket-originated change already applies itself locally/optimistically on the
  // sender's own client for responsiveness, but the sender still needs this confirmation:
  // without it, a sender's own pending edit that happens to diverge from what the server
  // actually applied (e.g. a differently-timed broadcast from another client landing in
  // between) can never self-correct, since the sender would otherwise never hear back at
  // all. index.html guards the one place this used to cause a problem — two concurrent
  // loadActiveMap()/renderPdf() calls racing on a map switch — with a generation counter
  // instead of relying on the sender never seeing its own confirmation.
  for (const conn of clients) {
    send(conn, { type: 'state', state: stateForConnection(conn) });
  }
}

// Returns the RAW token (not resolvePin'd) — callers that write to a pin need to know whether
// it's a character-backed player token or a self-contained monster pin; callers that only need
// to read full stats (e.g. movePin's speed check below) resolve explicitly via state.characters.
function findPin(mapId, pinId) {
  const map = state.maps[mapId];
  const pin = map?.pins.find(p => p.id === pinId);
  return { map, pin };
}

function handleMessage(conn, msg) {
  switch (msg.type) {
    case 'hello': {
      // A client claiming 'dm' only actually becomes one if this connection's upgrade
      // request carried valid basic-auth credentials (conn.authenticatedDm, set once at
      // connection time — see wss.on('connection') below); otherwise role stays null,
      // which every other handler already treats as unprivileged (see stateForConnection,
      // movePin, and editPin for the three spots that needed an explicit check rather than
      // assuming "not player" meant "must be dm").
      if (msg.role === 'player') {
        conn.role = 'player';
        conn.characterId = msg.characterId;
      } else {
        conn.role = conn.authenticatedDm ? 'dm' : null;
        conn.characterId = null;
      }
      send(conn, { type: 'state', state: stateForConnection(conn) });
      return;
    }
    case 'addPin': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map || !msg.pin) return;
      if (msg.pin.type === 'player') {
        // A brand-new character: split the client's single pin object into a roster entry
        // (everything but position) plus a token on this map (just position, pointing at it)
        // — see the migration loop up top for the same split applied to old data.
        const characterId = crypto.randomUUID();
        const { id, type, wx, wy, ...stats } = msg.pin;
        state.characters[characterId] = { id: characterId, ...stats };
        map.pins.push({ id: crypto.randomUUID(), type: 'player', characterId, wx, wy });
      } else {
        map.pins.push(msg.pin);
      }
      break;
    }
    // Places an EXISTING roster character onto a map as a new token — the payoff of the
    // character/token split: reusing a character elsewhere is just a new lightweight token
    // pointing at the same characterId, not a full recreation, so HP/conditions/icon carry
    // over automatically (they live on the character, not the token).
    case 'placeCharacter': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const character = state.characters[msg.characterId];
      if (!map || !character) return;
      map.pins.push({ id: crypto.randomUUID(), type: 'player', characterId: msg.characterId, wx: msg.wx, wy: msg.wy });
      break;
    }
    case 'removePin': {
      // Removes this map's TOKEN (placement) only — a player character's roster record in
      // state.characters is untouched, so it's still there to re-place on this or another map
      // later. There's deliberately no "delete a character from the roster entirely" action
      // yet; an unplaced character just sits unused, which is harmless.
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map) return;
      const idx = map.pins.findIndex(p => p.id === msg.pinId);
      if (idx === -1) return;
      map.pins.splice(idx, 1);

      if (map.initiative) {
        const init = map.initiative;
        init.order.forEach(entry => { entry.pinIds = entry.pinIds.filter(id => id !== msg.pinId); });
        init.order = init.order.filter(entry => entry.pinIds.length > 0);
        delete init.traveled[msg.pinId];
        if (init.active) {
          if (!init.order.length) {
            init.active = false;
            init.currentIndex = 0;
            init.round = 1;
            init.traveled = {};
          } else {
            if (init.currentIndex >= init.order.length) { init.currentIndex = 0; init.round += 1; }
            resetTraveled(map, init.order[init.currentIndex]);
          }
        }
      }
      break;
    }
    case 'movePin': {
      // Explicit: an unauthenticated connection (role null — see 'hello') is neither dm nor
      // player and gets no move privileges at all, rather than silently falling through to
      // full dm-level access because it isn't 'player'.
      if (conn.role !== 'dm' && conn.role !== 'player') return;
      const map = state.maps[msg.mapId];
      const { pin } = findPin(msg.mapId, msg.pinId);
      if (!map || !pin) return;

      const entry = activeEntry(map);
      const isActiveTurn = !!entry && entry.pinIds.includes(msg.pinId);

      if (conn.role === 'player') {
        // Matched by characterId, not token id, so "your own pin" follows you across maps —
        // same identity check as stateForConnection's myPin lookup.
        if (pin.type !== 'player' || pin.characterId !== conn.characterId) return;
        if (map.initiative?.active && !isActiveTurn) return; // and only on your own turn once combat has started
      }

      // A blocksMovement zone (solid) blocks movement outright, regardless of turn state — a
      // wall doesn't care whose turn it is. First pass: reject the whole move if its straight
      // line crosses one, rather than sliding the pin to the point of contact (see the story
      // this was built from). The DM is exempt — walls constrain players, not the DM
      // repositioning a pin for story/staging reasons.
      if (conn.role !== 'dm' && movementBlockedBy(pin.wx, pin.wy, msg.wx, msg.wy, map.zones, map.doors)) return;

      // pin is the raw token, which no longer carries `speed` itself for a player (that's on
      // the character record now) — resolve it here rather than switching this whole function
      // to the merged view, since everything else below only ever needs wx/wy/id.
      const speed = pin.type === 'player' ? state.characters[pin.characterId]?.speed : pin.speed;
      let wx = msg.wx, wy = msg.wy;
      if (conn.role === 'player' && isActiveTurn && speed && map.scale) {
        // Clamp against the REMAINING budget (total speed minus what's already been spent
        // this turn), anchored to the pin's current position — not a fresh speed's worth
        // measured from wherever the turn began — so a move → action → move again sequence
        // is held to one total speed, however many separate drags it's split across. "Spent"
        // is cost-weighted distance, not raw distance: crossing difficult terrain or water
        // charges costMultiplier feet of budget per foot actually moved (5e's real rule),
        // computed exactly by traceCostAlongPath rather than a flat ratio — a drag that starts
        // in normal terrain and crosses into a costly zone partway through correctly spends
        // less total distance than an equally-long drag entirely in the open.
        const maxTotal = speed * map.scale;
        const traveled = map.initiative.traveled[pin.id] || 0;
        const remaining = Math.max(0, maxTotal - traveled);
        const result = traceCostAlongPath(pin.wx, pin.wy, wx, wy, map.zones, remaining);
        wx = result.x; wy = result.y;
        map.initiative.traveled[pin.id] = traveled + result.costUsed;
      }
      pin.wx = wx;
      pin.wy = wy;
      break;
    }
    case 'editPin': {
      // Same explicit check as movePin — an unauthenticated connection is neither dm nor
      // player and must not fall through to unrestricted edit access.
      if (conn.role !== 'dm' && conn.role !== 'player') return;
      const { pin } = findPin(msg.mapId, msg.pinId);
      if (!pin || !msg.patch) return;
      const keys = Object.keys(msg.patch);
      if (conn.role === 'player') {
        // players may only touch their own pin, and only its current HP, conditions, or class
        // icon — name/type/colour/size/speed stay DM-only
        if (pin.type !== 'player' || pin.characterId !== conn.characterId) return;
        if (!keys.every(k => k === 'hpCurrent' || k === 'conditions' || k === 'icon')) return;
      }
      // `type` is set once at creation (it decides whether a pin even has a characterId) and
      // never editable afterward — converting a token between character-backed and
      // self-contained monster shape mid-flight isn't supported, so silently drop any attempt
      // rather than risk a player-type pin with no character record (or vice versa).
      const { type, ...patch } = msg.patch;
      if (pin.type === 'player') {
        const character = state.characters[pin.characterId];
        if (!character) return;
        Object.assign(character, patch);
      } else {
        Object.assign(pin, patch);
      }
      break;
    }
    // How thick the lit border along a visible solid's edge is in a player's fog of war, in feet
    // (DM-tunable per map; players read it from state to render their own fog).
    case 'setFogEdge': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const ft = Number(msg.feet);
      if (!map || !Number.isFinite(ft)) return;
      map.fogEdgeFt = Math.min(10, Math.max(0.25, ft));
      break;
    }
    // How soft the fade from lit to fogged is at the edge of a player's vision, in feet
    // (0 = hard cutout). DM-tunable per map, like fogEdgeFt above.
    case 'setFogFeather': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const ft = Number(msg.feet);
      if (!map || !Number.isFinite(ft)) return;
      map.fogFeatherFt = Math.min(6, Math.max(0, ft));
      break;
    }
    case 'setScale': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map) return;
      map.scale = msg.scale;
      break;
    }
    case 'addZone': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const z = msg.zone;
      if (!map || !z || !ZONE_KINDS[z.kind] || !Array.isArray(z.points)) return;
      const points = z.points
        .map(p => ({ x: p.x, y: p.y }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (points.length < 3) return; // not a valid polygon
      if (!map.zones) map.zones = [];
      map.zones.push({ id: z.id || crypto.randomUUID(), kind: z.kind, points });
      break;
    }
    case 'removeZone': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map?.zones) return;
      const idx = map.zones.findIndex(z => z.id === msg.zoneId);
      if (idx === -1) return;
      map.zones.splice(idx, 1);
      break;
    }
    case 'addDoor': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const d = msg.door;
      if (!map || !d) return;
      if (!map.doors) map.doors = [];
      map.doors.push({ id: d.id || crypto.randomUUID(), x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, open: false });
      break;
    }
    case 'removeDoor': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map?.doors) return;
      const idx = map.doors.findIndex(d => d.id === msg.doorId);
      if (idx === -1) return;
      map.doors.splice(idx, 1);
      break;
    }
    case 'toggleDoor': {
      // DM-only for now, matching every other authoring/control action — see the "Doors"
      // story for the open question about letting a player toggle a door near their own pin.
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const door = map?.doors?.find(d => d.id === msg.doorId);
      if (!door) return;
      door.open = !door.open;
      break;
    }
    case 'addTemplate': {
      // DM-only to place (first pass — see the story), but visible to everyone once placed:
      // unlike obstacles this is inherently something the whole table should see, matching
      // how a spell's area of effect actually plays at a table.
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const t = msg.template;
      if (!map || !t) return;
      if (t.shape === 'circle') {
        if (!(t.radius > 0)) return;
        map.templates.push({ id: t.id || crypto.randomUUID(), shape: 'circle', x: t.x, y: t.y, radius: t.radius });
      } else if (t.shape === 'cone') {
        if (!(t.length > 0)) return;
        map.templates.push({ id: t.id || crypto.randomUUID(), shape: 'cone', x: t.x, y: t.y, angle: t.angle, length: t.length });
      } else if (t.shape === 'line') {
        if (!(t.length > 0) || !(t.width > 0)) return;
        map.templates.push({ id: t.id || crypto.randomUUID(), shape: 'line', x: t.x, y: t.y, angle: t.angle, length: t.length, width: t.width });
      } else {
        return;
      }
      break;
    }
    case 'removeTemplate': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map) return;
      const idx = map.templates.findIndex(t => t.id === msg.templateId);
      if (idx === -1) return;
      map.templates.splice(idx, 1);
      break;
    }
    case 'setInitiativeOrder': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map || !Array.isArray(msg.order)) return;
      const validIds = new Set(map.pins.map(p => p.id));
      const order = msg.order
        .map(entry => ({ id: entry.id || crypto.randomUUID(), pinIds: (entry.pinIds || []).filter(id => validIds.has(id)) }))
        .filter(entry => entry.pinIds.length > 0);

      if (!map.initiative) map.initiative = defaultInitiative();
      const init = map.initiative;
      if (init.active) {
        // Allowed mid-fight too (a latecomer joining, or reordering) — re-anchor whose
        // turn it is by the entry's id, which is stable across a reorder, rather than
        // its index, which isn't.
        const activeId = init.order[init.currentIndex]?.id;
        const newIndex = order.findIndex(e => e.id === activeId);
        if (newIndex !== -1) {
          init.currentIndex = newIndex;
        } else if (order.length) {
          // the active entry itself was removed from the order — carry on with whichever
          // entry now sits at that position, same wrap/round-advance rule as endTurn
          if (init.currentIndex >= order.length) { init.currentIndex = 0; init.round += 1; }
          resetTraveled(map, order[init.currentIndex]);
        } else {
          init.active = false;
          init.currentIndex = 0;
          init.round = 1;
          init.traveled = {};
        }
      }
      init.order = order;
      break;
    }
    case 'startCombat': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map || !map.initiative?.order?.length) return;
      map.initiative.active = true;
      map.initiative.currentIndex = 0;
      map.initiative.round = 1;
      map.initiative.traveled = {};
      resetTraveled(map, map.initiative.order[0]);
      break;
    }
    case 'endTurn': {
      const map = state.maps[msg.mapId];
      if (!map || !map.initiative?.active) return;
      const entry = map.initiative.order[map.initiative.currentIndex];
      // entry.pinIds holds TOKEN ids (this map's placements), but a player's identity is now
      // their characterId — resolve to this map's token for that character, if they have one,
      // same as movePin/stateForConnection's myPin lookup.
      const myToken = map.pins.find(p => p.type === 'player' && p.characterId === conn.characterId);
      const isMyTurn = entry && conn.role === 'player' && !!myToken && entry.pinIds.includes(myToken.id);
      if (conn.role !== 'dm' && !isMyTurn) return;

      const order = map.initiative.order;
      let next = map.initiative.currentIndex + 1;
      if (next >= order.length) { next = 0; map.initiative.round += 1; }
      map.initiative.currentIndex = next;
      resetTraveled(map, order[next]);
      break;
    }
    case 'stopCombat': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map || !map.initiative) return;
      map.initiative.active = false;
      map.initiative.currentIndex = 0;
      map.initiative.round = 1;
      map.initiative.traveled = {};
      break;
    }
    case 'switchMap': {
      if (conn.role !== 'dm') return;
      if (msg.activeMapId !== null && !state.maps[msg.activeMapId]) return;
      state.activeMapId = msg.activeMapId;
      break;
    }
    default:
      return;
  }
  saveState();
  broadcastState();
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // The websocket handshake is still a plain HTTP request under the hood, so a browser that
  // already has basic-auth credentials cached for this origin (from loading the DM page at
  // '/', which requires them) automatically resends the same Authorization header here too —
  // no separate password prompt needed. A player's browser, having only ever loaded the
  // unprotected /play/:characterId route, never has credentials cached and so never sends
  // this header; that's fine, since claiming 'player' in 'hello' never required it anyway.
  const authenticatedDm = checkBasicAuth(req);
  const conn = { ws, role: null, characterId: null, authenticatedDm };
  clients.add(conn);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(conn, msg);
  });
  ws.on('close', () => clients.delete(conn));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DnD Battlemap running at http://localhost:${PORT}`));
