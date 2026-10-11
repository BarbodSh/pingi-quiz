// Zero-dependency HTTP server: static page, JSON API, Server-Sent Events.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomManager, GameError } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const questions = loadQuestions(path.join(__dirname, 'questions'));
const indexHtml = path.join(__dirname, 'public', 'index.html');
const game = new RoomManager(questions);

// room code -> Set<{ playerId, res }>
const streams = new Map();

// Every *.json file in questions/ is an array of questions; fail fast on bad entries.
function loadQuestions(dir) {
  const all = [];
  const ids = new Set();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    for (const q of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      const where = `${file}: ${q.id}`;
      if (!q.id || ids.has(q.id)) throw new Error(`${where}: missing or duplicate id`);
      if (!q.category || !q.question) throw new Error(`${where}: missing category or question`);
      if (!['easy', 'medium', 'hard'].includes(q.difficulty)) throw new Error(`${where}: bad difficulty`);
      if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error(`${where}: needs exactly 4 options`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) throw new Error(`${where}: bad answer index`);
      ids.add(q.id);
      all.push(q);
    }
  }
  return all;
}

function lanUrls() {
  // Skip virtual interfaces (Docker, VMs) that other devices can't reach.
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr|vboxnet|vmnet)/.test(name))
    .flatMap(([, addrs]) => addrs)
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);
}

function broadcast(code) {
  const set = streams.get(code);
  if (!set) return;
  const now = Date.now();
  for (const s of set) {
    s.res.write(`data: ${JSON.stringify(game.publicState(code, s.playerId, now))}\n\n`);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10_000) reject(new GameError('Request too large', 413));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new GameError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function openStream(req, res, code, playerId) {
  if (!game.hasPlayer(code, playerId)) return sendJson(res, 404, { error: 'Room or player not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');
  const entry = { playerId, res };
  if (!streams.has(code)) streams.set(code, new Set());
  streams.get(code).add(entry);
  game.setConnected(code, playerId, true, Date.now());
  broadcast(code);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = streams.get(code);
    if (!set) return;
    set.delete(entry);
    const stillOpen = [...set].some(s => s.playerId === playerId);
    if (!stillOpen) {
      game.setConnected(code, playerId, false, Date.now());
      broadcast(code);
    }
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','rooms','ABCD','join']
  const now = Date.now();

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(indexHtml).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/info') {
    return sendJson(res, 200, { categories: game.categories(), lanUrls: lanUrls() });
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await readBody(req);
    return sendJson(res, 201, game.createRoom(body, now));
  }
  if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 4) {
    const code = parts[2].toUpperCase();
    const action = parts[3];
    if (req.method === 'GET' && action === 'events') {
      return openStream(req, res, code, url.searchParams.get('playerId'));
    }
    if (req.method === 'GET' && action === 'status') {
      const exists = game.hasPlayer(code, url.searchParams.get('playerId'));
      return sendJson(res, exists ? 200 : 404, { exists });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (action === 'join') return sendJson(res, 200, { code, ...game.joinRoom(code, body.nickname, now) });
      if (action === 'start') game.start(code, body.playerId, now);
      else if (action === 'answer') game.answer(code, body.playerId, body.option, now);
      else if (action === 'restart') game.restart(code, body.playerId, now);
      else return sendJson(res, 404, { error: 'Not found' });
      broadcast(code);
      return sendJson(res, 200, { ok: true });
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (err instanceof GameError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  });
});

setInterval(() => {
  const { changed, removed } = game.tick(Date.now());
  changed.forEach(broadcast);
  for (const code of removed) {
    for (const s of streams.get(code) || []) s.res.end();
    streams.delete(code);
  }
}, 200);

server.listen(PORT, HOST, () => {
  console.log(`Quiz Race running — ${questions.length} questions loaded`);
  console.log(`  This machine: http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On your LAN:  ${u}`);
});
