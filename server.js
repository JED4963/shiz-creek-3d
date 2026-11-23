// Shiz Creek 3D - multiplayer server.
// Serves the game (index.html in this folder) and runs the Friends rooms and online eight-ball.
// No installs needed: it only uses what comes with Node.js.   Start it with:   node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = Number(process.env.PORT) || 8080;
const GAME_FILE = path.join(__dirname, 'index.html');
const MAX_PLAYERS = 32, STALE_MS = 9000, MAX_BODY = 48 * 1024;
const TOWN = 'TOWN';   // the always-open public room everyone can share; private rooms get random 4-letter codes
// How often each player should check in, in milliseconds: busier rooms check in a little less often to keep a small server happy.
const syncEvery = count => (count <= 6 ? 140 : count <= 12 ? 200 : count <= 20 ? 260 : 320);

// ---------- the game page (and the pool rules that live inside it) ----------
let page = '', pageZip = null, poolRules = null;
function loadGame() {
  page = fs.readFileSync(GAME_FILE, 'utf8');
  const rules = page.match(/<script id="pool-rules">([\s\S]*?)<\/script>/);
  if (!rules) throw new Error('index.html does not contain the pool rules');
  poolRules = new Function(rules[1] + '\nreturn createPoolRules();')();
  pageZip = zlib.gzipSync(page);   // a smaller download for slow school wifi
}
loadGame();
fs.watchFile(GAME_FILE, { interval: 4000 }, () => { try { loadGame(); console.log('game page reloaded'); } catch (e) { console.error(e.message); } });

// ---------- small helpers ----------
const hex = n => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const cleanName = (v, fallback = 'Angler') => String(v ?? '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 18) || fallback;
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

// ---------- rooms ----------
const rooms = new Map();          // code -> {code, players: Map(id -> player), queue: [], matches: Map}
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (let i = 0; i < 200; i++) {
    let code = '';
    for (let k = 0; k < 4; k++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
  throw fail(503, 'No room codes left. Try again in a minute.');
}
function member(body) {
  const room = rooms.get(String(body.code || '').toUpperCase());
  const player = room?.players.get(String(body.id || ''));
  if (!room || !player || player.token !== body.token) throw fail(410, 'That room has closed. Create or join another.');
  player.seen = now();
  return { room, player };
}
function dropPlayer(room, id) {
  room.players.delete(id);
  room.queue = room.queue.filter(q => q !== id);
  for (const [mid, match] of room.matches) if (match.seats.some(s => s.id === id)) room.matches.delete(mid);
  if (!room.players.size) rooms.delete(room.code);
}
function sweep() {
  const cutoff = now() - STALE_MS;
  for (const room of rooms.values()) for (const p of [...room.players.values()]) if (p.seen < cutoff) dropPlayer(room, p.id);
}
setInterval(sweep, 3000).unref();

// Only pass along the bits of a pose the game understands, so one player cannot send junk to the others.
function cleanPose(p) {
  if (!p || typeof p !== 'object') return null;
  const vec = (v, n) => (Array.isArray(v) && v.length === n && v.every(Number.isFinite) ? v.map(x => num(x, -5000, 5000)) : null);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const pose = {
    x: num(p.x, -5000, 5000), y: num(p.y, -200, 500), z: num(p.z, -5000, 5000), yaw: num(p.yaw, -1000, 1000),
    gait: num(p.gait, 0, 60), phase: num(p.phase, -1e7, 1e7), mode: text(p.mode, 12) || 'foot',
    smoking: p.smoking === true, queasy: num(p.queasy, 0, 1), ride: Math.floor(num(p.ride, 0, 9)),
    fishing: p.fishing === true, bob: vec(p.bob, 3), catchName: text(p.catchName, 40),
    fit: Array.isArray(p.fit) && p.fit.length >= 11 && p.fit.length <= 13 && p.fit.every(v => Number.isInteger(v) && v >= 0 && v < 64) ? p.fit.slice() : null, loan: null, drive: null, held: null, fall: null, boat: null, deck: null
  };
  if (p.loan && typeof p.loan === 'object') pose.loan = { type: text(p.loan.type, 12), paint: text(p.loan.paint, 12), source: text(p.loan.source, 16) };
  if (p.drive && typeof p.drive === 'object') pose.drive = { distance: num(p.drive.distance, -1e7, 1e7), steer: num(p.drive.steer, -2, 2), lean: num(p.drive.lean, -2, 2) };
  if (p.held && typeof p.held === 'object') pose.held = { id: text(p.held.id, 24), len: num(p.held.len, 0, 2000), w: num(p.held.w, 0, 2000) };
  if (p.fall && typeof p.fall === 'object') pose.fall = { pitch: num(p.fall.pitch, -7, 7), roll: num(p.fall.roll, -7, 7), active: p.fall.active === true };
  if (p.boat && typeof p.boat === 'object' && p.boat.config && typeof p.boat.config === 'object') {
    const c = p.boat.config;
    pose.boat = {
      x: num(p.boat.x, -5000, 5000), z: num(p.boat.z, -5000, 5000), yaw: num(p.boat.yaw, -1000, 1000), speed: num(p.boat.speed, -60, 60),
      jetSki: p.boat.jetSki === true, source: text(p.boat.source, 16), hop: num(p.boat.hop, 0, 5), trimPitch: num(p.boat.trimPitch, -2, 2), jumpAt: num(p.boat.jumpAt, -1e9, 1e9, undefined),
      config: { hull: Math.floor(num(c.hull, 1, 5, 1)), motor: Math.floor(num(c.motor, 0, 4)), finder: Math.floor(num(c.finder, 0, 2)), tank: c.tank === true, rods: c.rods === true,
        paint: Math.floor(num(c.paint, 0, 15)), trim: Math.floor(num(c.trim, 0, 15)), decal: Math.floor(num(c.decal, 0, 10)) }
    };
  }
  if (p.deck && typeof p.deck === 'object') pose.deck = { owner: text(p.deck.owner, 24), u: num(p.deck.u, -30, 30), v: num(p.deck.v, -30, 30) };
  return pose;
}

// Positions do not need fifteen decimal places: rounding them makes every message to every player much smaller.
function trim(value) {
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = trim(value[k]); return value; }
  return value;
}

// ---------- online eight-ball ----------
function poolView(room, player) {
  for (const match of room.matches.values()) {
    if (!match.seats.some(s => s.id === player.id)) continue;
    const delay = match.last ? Math.max(0, Math.round(match.last.seconds * 1000 - (now() - match.last.at))) : 0;
    return { id: match.id, rev: match.rev, seats: match.seats, game: match.game, delay,
      last: match.last && { before: match.last.before, angle: match.last.angle, power: match.last.power, seconds: match.last.seconds } };
  }
  return null;
}
function poolAction(room, player, body) {
  const action = String(body.action || '');
  const match = [...room.matches.values()].find(m => m.seats.some(s => s.id === player.id));
  let notice = '';
  if (action === 'queue') {
    if (!match && !room.queue.includes(player.id)) room.queue.push(player.id);
    room.queue = room.queue.filter(id => room.players.has(id));
    if (!match && room.queue.length >= 2) {
      const [a, b] = room.queue.splice(0, 2).map(id => room.players.get(id));
      const id = hex(6);
      room.matches.set(id, { id, rev: 1, seats: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], game: poolRules.rack(), last: null });
    }
  } else if (action === 'cancel') {
    room.queue = room.queue.filter(id => id !== player.id);
  } else if (action === 'leave') {
    if (match) room.matches.delete(match.id);
    room.queue = room.queue.filter(id => id !== player.id);
  } else if (match) {
    const seat = match.seats.findIndex(s => s.id === player.id);
    const settling = match.last && now() - match.last.at < match.last.seconds * 1000 - 150;
    if (match.game.winner !== null) notice = 'That game is over.';
    else if (match.game.turn !== seat) notice = 'Wait for your turn.';
    else if (settling) notice = 'The balls are still rolling.';
    else if (action === 'shot') {
      const out = poolRules.shoot(match.game, Number(body.angle), Number(body.power), false);
      if (!out) notice = 'That shot is not allowed.';
      else { match.last = { before: match.game, angle: Number(body.angle), power: Number(body.power), seconds: out.duration, at: now() }; match.game = out.game; match.rev++; }
    } else if (action === 'place') {
      const game = poolRules.place(match.game, Number(body.x), Number(body.y));
      if (!game) notice = 'Place the cue ball away from the other balls and rails.'; else { match.game = game; match.rev++; }
    } else if (action === 'call') {
      const game = poolRules.call(match.game, Number(body.index));
      if (game) { match.game = game; match.rev++; }
    }
  } else notice = 'No game at the table.';
  return { pool: poolView(room, player), queued: room.queue.includes(player.id), notice };
}

// ---------- the API ----------
function handle(method, url, body) {
  const route = url.pathname.replace(/\/+$/, '');
  if (method === 'POST' && route === '/room/join') {
    sweep();
    const name = cleanName(body.name);
    let code = String(body.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
    let room = code ? rooms.get(code) : null;
    if (code && !room && code !== TOWN) throw fail(404, 'No room with that code. Check it with your friend.');
    if (!room) { code = code === TOWN ? TOWN : newCode(); room = { code, players: new Map(), queue: [], matches: new Map() }; rooms.set(code, room); }
    if (room.players.size >= MAX_PLAYERS) throw fail(409, 'That room is full (' + MAX_PLAYERS + ' players). Try again in a minute or make a private room.');
    const player = { id: hex(8), token: hex(12), name, seen: now(), pose: null, inbox: [] };
    room.players.set(player.id, player);
    return { code, id: player.id, token: player.token, name };
  }
  if (method === 'POST' && route === '/room/sync') {
    const { room, player } = member(body);
    player.pose = trim(cleanPose(body.pose));
    const cutoff = now() - STALE_MS, players = [];
    for (const other of room.players.values()) {
      if (other === player || !other.pose || other.seen < cutoff) continue;
      players.push({ id: other.id, name: other.name, ...other.pose });
    }
    let deckAccepted;
    const deck = player.pose?.deck;
    if (deck && deck.owner && deck.owner !== player.id) deckAccepted = !!room.players.get(deck.owner)?.pose?.boat;
    // little things players do to each other (a fish slap, for one) are passed straight on to whoever they were aimed at
    if (Array.isArray(body.events)) for (const e of body.events.slice(0, 6)) {
      const target = e && room.players.get(String(e.to || ''));
      if (!target || target === player || e.type !== 'slap' || target.inbox.length >= 8) continue;
      const a = player.pose, b = target.pose;
      if (!a || !b || Math.hypot(a.x - b.x, a.z - b.z) > 4 || now() - (player.slapAt || 0) < 1000) continue;
      player.slapAt = now();
      target.inbox.push({ from: player.id, name: player.name, type: 'slap', fish: String(e.fish || 'fish').replace(/[^\p{L}\p{N} '-]/gu, '').slice(0, 30) });
    }
    return { players, deckAccepted, pool: poolView(room, player), queued: room.queue.includes(player.id), events: player.inbox.splice(0), every: syncEvery(room.players.size) };
  }
  if (method === 'POST' && route === '/room/pool') { const { room, player } = member(body); return poolAction(room, player, body); }
  if (method === 'POST' && route === '/room/leave') {
    const room = rooms.get(String(body.code || '').toUpperCase()), player = room?.players.get(String(body.id || ''));
    if (room && player && player.token === body.token) dropPlayer(room, player.id);
    return { ok: true };
  }
  if (method === 'GET' && route === '/status') return { ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) };
  throw fail(404, 'Not found');
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400, CORS); return res.end(); }   // "//" and friends
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }); res.end(JSON.stringify(data)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(zipped ? { 'Content-Encoding': 'gzip' } : {}) });
    return res.end(zipped ? pageZip : page);
  }
  if (req.method === 'GET') { try { return send(200, handle('GET', url, {})); } catch (e) { return send(e.status || 500, { error: e.status ? e.message : 'Server error' }); } }
  if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { send(413, { error: 'Too much data' }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (res.writableEnded) return;
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (!body || typeof body !== 'object') throw fail(400, 'Bad request');
      send(200, handle('POST', url, body));
    } catch (e) {
      if (!e.status) console.error(e);
      send(e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.status ? e.message : e instanceof SyntaxError ? 'Bad request' : 'Server error' });
    }
  });
});
server.listen(PORT, () => console.log('Shiz Creek 3D is running on port ' + PORT + '  ->  open http://localhost:' + PORT));
