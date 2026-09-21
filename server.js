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
};

function loadState() {
  try { return { ...defaultState, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return { ...defaultState, maps: {} }; }
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
  if (!map.obstacles) map.obstacles = [];
  if (!map.templates) map.templates = [];
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
// Player links (/play/:pinId) stay open on purpose — sharing the link *is* the access
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
app.use(express.json());
app.get('/', requireBasicAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/play/:pinId', (_req, res) => {
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
      pins: [], // { id, type: 'player'|'monster', name, color, speed, attackRange, attackLongRange, hpMax, hpCurrent, conditions, hidden, wx, wy }
      obstacles: [], // { id, x, y, w, h } — DM-marked solid rectangles; geometry visible to everyone, only the DM's marker box in the UI is hidden (see stateForConnection)
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

// ── line of sight ─────────────────────────────────────────────────────
// Each obstacle rectangle blocks sight along its 4 edges; two points have LOS
// if the segment between them crosses none of those edges, for any obstacle.
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
// A closed door blocks like an obstacle edge; an open one blocks nothing — same segment-
// intersection test, just a single segment per door instead of 4 per rectangle.
function hasLOS(a, b, obstacles, doors) {
  const pa = { x: a.wx, y: a.wy }, pb = { x: b.wx, y: b.wy };
  for (const o of obstacles) {
    const c = [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }];
    for (let i = 0; i < 4; i++) {
      if (segmentsIntersect(pa, pb, c[i], c[(i + 1) % 4])) return false;
    }
  }
  for (const d of doors || []) {
    if (d.open) continue;
    if (segmentsIntersect(pa, pb, { x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 })) return false;
  }
  return true;
}

// ── realtime layer ────────────────────────────────────────────────────
// Every connection is either the DM (full control), a player linked to one pin id (can only
// move/adjust-HP on that pin), or — new since basic auth — unauthenticated (role stays null:
// they asked for 'dm' over the websocket without a valid Authorization header, see the
// 'hello' handler below). This split is what lets stateForConnection() below filter what's
// broadcast to whom without any further data-model changes: pins already carry a `hidden`
// flag (unused today, always false) for a future fog-of-war feature to use the same way.
const clients = new Set(); // { ws, role: 'dm'|'player'|null, pinId: string|null, authenticatedDm: boolean }

function stateForConnection(conn) {
  // Explicit allow-list for the one privileged case, rather than a deny-list on 'player' —
  // an unauthenticated connection (role null) must fall through to the filtered branch below
  // exactly like a player does, not get the unfiltered state by default.
  if (conn.role === 'dm') return state;
  const maps = {};
  for (const [id, map] of Object.entries(state.maps)) {
    // Obstacle geometry itself isn't secret — a tree is a tree, players can see it's an
    // obstacle right there on the map image — so the raw rectangles are sent to everyone.
    // What stays DM-only is purely the authoring marker (the hatched box + remove control):
    // renderObstacles() in index.html gates that rendering on role, not this. Sending the
    // real geometry to players is also what lets their own client predict movement-blocking
    // and compute their own attack-range shape locally, instead of only finding out from a
    // server rejection after the fact.
    //
    // A monster pin is only sent to a player at all if SOME player pin has line of sight to
    // it (shared party vision: once the party can see a monster, everyone in the party knows
    // it's there). Separately, each monster pin sent carries `losFromMe`: whether THIS
    // player's own pin specifically has a clear line to it — shared vision can reveal a
    // monster's existence without this player being able to target it themselves (e.g. a
    // teammate down the hall spots it around a corner this player can't see past), and that
    // distinction has to be visible in the UI for targeting decisions.
    const playerPins = map.pins.filter(p => p.type === 'player');
    const myPin = map.pins.find(p => p.id === conn.pinId);
    const pins = map.pins
      .filter(p => p.type !== 'monster' || playerPins.some(pp => hasLOS(pp, p, map.obstacles, map.doors)))
      .map(p => p.type !== 'monster' ? p : { ...p, losFromMe: !!myPin && hasLOS(myPin, p, map.obstacles, map.doors) });
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
        conn.pinId = msg.pinId;
      } else {
        conn.role = conn.authenticatedDm ? 'dm' : null;
        conn.pinId = null;
      }
      send(conn, { type: 'state', state: stateForConnection(conn) });
      return;
    }
    case 'addPin': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map || !msg.pin) return;
      map.pins.push(msg.pin);
      break;
    }
    case 'removePin': {
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
        if (conn.pinId !== msg.pinId) return; // only ever your own pin
        if (map.initiative?.active && !isActiveTurn) return; // and only on your own turn once combat has started
      }

      // Solid areas block movement outright, regardless of turn state — a wall doesn't care
      // whose turn it is. First pass: reject the whole move if its straight line crosses one,
      // rather than sliding the pin to the point of contact (see the story this was built
      // from). Reuses the same hasLOS check LOS filtering uses — "does a straight line cross
      // any obstacle edge" is exactly what both need. The DM is exempt — walls constrain
      // players, not the DM repositioning a pin for story/staging reasons.
      if (conn.role !== 'dm' && !hasLOS(pin, { wx: msg.wx, wy: msg.wy }, map.obstacles, map.doors)) return;

      let wx = msg.wx, wy = msg.wy;
      if (conn.role === 'player' && isActiveTurn && pin.speed && map.scale) {
        // Clamp against the REMAINING budget (total speed minus what's already been moved
        // this turn), anchored to the pin's current position — not a fresh speed's worth
        // measured from wherever the turn began — so a move → action → move again sequence
        // is held to one total speed, however many separate drags it's split across.
        const maxTotal = pin.speed * map.scale;
        const traveled = map.initiative.traveled[pin.id] || 0;
        const remaining = Math.max(0, maxTotal - traveled);
        const dx = wx - pin.wx, dy = wy - pin.wy;
        const dist = Math.hypot(dx, dy);
        if (dist > remaining && dist > 0) {
          const ratio = remaining / dist;
          wx = pin.wx + dx * ratio;
          wy = pin.wy + dy * ratio;
        }
        map.initiative.traveled[pin.id] = traveled + Math.hypot(wx - pin.wx, wy - pin.wy);
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
        // players may only touch their own pin, and only its current HP or conditions —
        // name/type/colour/size/speed stay DM-only
        if (conn.pinId !== msg.pinId) return;
        if (!keys.every(k => k === 'hpCurrent' || k === 'conditions')) return;
      }
      Object.assign(pin, msg.patch);
      break;
    }
    case 'setScale': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map) return;
      map.scale = msg.scale;
      break;
    }
    case 'addObstacle': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      const o = msg.obstacle;
      if (!map || !o || !(o.w > 0) || !(o.h > 0)) return;
      map.obstacles.push({ id: o.id || crypto.randomUUID(), x: o.x, y: o.y, w: o.w, h: o.h });
      break;
    }
    case 'removeObstacle': {
      if (conn.role !== 'dm') return;
      const map = state.maps[msg.mapId];
      if (!map) return;
      const idx = map.obstacles.findIndex(o => o.id === msg.obstacleId);
      if (idx === -1) return;
      map.obstacles.splice(idx, 1);
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
      const isMyTurn = entry && conn.role === 'player' && entry.pinIds.includes(conn.pinId);
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
  // unprotected /play/:pinId route, never has credentials cached and so never sends this
  // header; that's fine, since claiming 'player' in 'hello' never required it anyway.
  const authenticatedDm = checkBasicAuth(req);
  const conn = { ws, role: null, pinId: null, authenticatedDm };
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
