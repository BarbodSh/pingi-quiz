// Pure in-memory game logic. No I/O: every time-dependent call takes `now` (ms).
const crypto = require('node:crypto');

const COUNTDOWN_MS = 3000;
const REVEAL_MS = 4000;
const HOST_GRACE_MS = 5000;
const IDLE_ROOM_MS = 30 * 60_000;
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class RoomManager {
  constructor(questions, { rng = Math.random } = {}) {
    this.bank = questions;
    this.rng = rng;
    this.rooms = new Map();
  }

  categories() {
    const map = new Map();
    for (const q of this.bank) {
      if (!map.has(q.category)) map.set(q.category, { easy: 0, medium: 0, hard: 0 });
      map.get(q.category)[q.difficulty]++;
    }
    return [...map].map(([name, counts]) => ({ name, counts }));
  }

  createRoom({ nickname, category, difficulty, count, seconds }, now) {
    const name = cleanName(nickname);
    if (category !== 'mixed' && !this.bank.some(q => q.category === category)) throw new GameError('Unknown category');
    if (difficulty !== 'mixed' && !DIFFICULTIES.includes(difficulty)) throw new GameError('Unknown difficulty');
    count = clampInt(count, 1, 50, 10);
    seconds = clampInt(seconds, 5, 120, 20);
    const settings = { category, difficulty, count, seconds };
    const room = {
      code: this._newCode(),
      settings,
      hostId: null,
      players: new Map(),
      questions: this._pickQuestions(settings),
      index: -1,
      phase: 'lobby',
      phaseEndsAt: null,
      questionStartedAt: null,
      answers: new Map(),
      lastActivity: now,
    };
    const player = this._addPlayer(room, name, now);
    room.hostId = player.id;
    this.rooms.set(room.code, room);
    return { code: room.code, playerId: player.id };
  }

  joinRoom(code, nickname, now) {
    const room = this._getRoom(code);
    const name = cleanName(nickname);
    if (room.phase !== 'lobby') throw new GameError('This race has already started', 409);
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) throw new GameError('That nickname is taken in this room', 409);
    }
    return { playerId: this._addPlayer(room, name, now).id };
  }

  start(code, playerId, now) {
    const room = this._getRoom(code);
    this._requireHost(room, playerId);
    if (room.phase !== 'lobby') throw new GameError('The race has already started', 409);
    this._beginCountdown(room, now);
  }

  restart(code, playerId, now) {
    const room = this._getRoom(code);
    this._requireHost(room, playerId);
    if (room.phase !== 'final') throw new GameError('The race has not finished yet', 409);
    room.questions = this._pickQuestions(room.settings);
    for (const p of room.players.values()) Object.assign(p, { score: 0, correctMs: 0, correctCount: 0, last: null });
    this._beginCountdown(room, now);
  }

  answer(code, playerId, option, now) {
    const room = this._getRoom(code);
    const player = this._requirePlayer(room, playerId);
    if (room.phase !== 'question') throw new GameError('Answers are not being accepted right now', 409);
    if (now > room.phaseEndsAt) throw new GameError('Time is up', 409);
    if (room.answers.has(playerId)) throw new GameError('You already answered', 409);
    const q = room.questions[room.index];
    if (!Number.isInteger(option) || option < 0 || option >= q.options.length) throw new GameError('Invalid option');

    const correct = option === q.answer;
    const limit = room.settings.seconds * 1000;
    const remaining = Math.max(0, room.phaseEndsAt - now);
    const points = correct ? 500 + Math.round((500 * remaining) / limit) : 0;
    room.answers.set(playerId, { option, at: now });
    const ms = correct ? now - room.questionStartedAt : 0;
    player.last = { correct, points, ms };
    player.score += points;
    player.correctMs += ms;
    if (correct) player.correctCount++;
    room.lastActivity = now;

    const waiting = [...room.players.values()].some(p => p.connected && !room.answers.has(p.id));
    if (!waiting) this._setPhase(room, 'reveal', now + REVEAL_MS);
  }

  setConnected(code, playerId, connected, now) {
    const room = this.rooms.get(code);
    const player = room && room.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    player.disconnectedAt = connected ? null : now;
    room.lastActivity = now;
  }

  // Advances phases whose deadlines passed, hands over host, deletes idle rooms.
  tick(now) {
    const changed = [];
    const removed = [];
    for (const room of this.rooms.values()) {
      const anyConnected = [...room.players.values()].some(p => p.connected);
      if (!anyConnected && now - room.lastActivity > IDLE_ROOM_MS) {
        this.rooms.delete(room.code);
        removed.push(room.code);
        continue;
      }
      let dirty = false;
      if (room.phaseEndsAt !== null && now >= room.phaseEndsAt) {
        if (room.phase === 'countdown') this._nextQuestion(room, now);
        else if (room.phase === 'question') this._setPhase(room, 'reveal', now + REVEAL_MS);
        else if (room.phase === 'reveal') {
          if (room.index + 1 < room.questions.length) this._nextQuestion(room, now);
          else this._setPhase(room, 'final', null);
        }
        dirty = true;
      }
      const host = room.players.get(room.hostId);
      if (host && !host.connected && now - host.disconnectedAt >= HOST_GRACE_MS) {
        const next = [...room.players.values()].find(p => p.connected);
        if (next) {
          room.hostId = next.id;
          dirty = true;
        }
      }
      if (dirty) changed.push(room.code);
    }
    return { changed, removed };
  }

  hasPlayer(code, playerId) {
    const room = this.rooms.get(code);
    return Boolean(room && room.players.has(playerId));
  }

  publicState(code, playerId, now) {
    const room = this._getRoom(code);
    const { phase } = room;
    const showQuestion = phase === 'question' || phase === 'reveal';
    const q = showQuestion ? room.questions[room.index] : null;
    const mine = room.answers.get(playerId);
    return {
      code: room.code,
      phase,
      phaseEndsAt: room.phaseEndsAt,
      serverNow: now,
      settings: room.settings,
      total: room.questions.length,
      you: playerId,
      hostId: room.hostId,
      players: ranked(room).map(p => ({
        id: p.id,
        name: p.name,
        score: p.visible.score,
        correctCount: p.visible.correctCount,
        connected: p.connected,
        answered: room.answers.has(p.id),
        lastCorrect: phase === 'reveal' && p.last ? p.last.correct : null,
        lastPoints: phase === 'reveal' && p.last ? p.last.points : null,
      })),
      question: q && {
        index: room.index,
        category: q.category,
        difficulty: q.difficulty,
        question: q.question,
        code: q.code || null,
        options: q.options,
      },
      myAnswer: showQuestion && mine ? mine.option : null,
      reveal: phase === 'reveal' ? { answer: q.answer, explanation: q.explanation || null } : null,
    };
  }

  // For tests.
  _room(code) {
    return this._getRoom(code);
  }

  _beginCountdown(room, now) {
    room.index = -1;
    room.answers = new Map();
    this._setPhase(room, 'countdown', now + COUNTDOWN_MS);
  }

  _nextQuestion(room, now) {
    room.index++;
    room.answers = new Map();
    room.questionStartedAt = now;
    for (const p of room.players.values()) p.last = null;
    this._setPhase(room, 'question', now + room.settings.seconds * 1000);
  }

  _setPhase(room, phase, endsAt) {
    room.phase = phase;
    room.phaseEndsAt = endsAt;
  }

  _addPlayer(room, name, now) {
    const player = {
      id: crypto.randomUUID(), name, score: 0, correctMs: 0, correctCount: 0,
      connected: false, disconnectedAt: now, last: null,
    };
    room.players.set(player.id, player);
    room.lastActivity = now;
    return player;
  }

  _pickQuestions({ category, difficulty, count }) {
    const pool = this.bank.filter(q =>
      (category === 'mixed' || q.category === category) && (difficulty === 'mixed' || q.difficulty === difficulty));
    if (pool.length === 0) throw new GameError('No questions for that category and difficulty');
    // Take from each category in turn so a big category doesn't dominate a mixed race.
    const byCategory = new Map();
    for (const q of this._shuffle(pool)) {
      if (!byCategory.has(q.category)) byCategory.set(q.category, []);
      byCategory.get(q.category).push(q);
    }
    const queues = this._shuffle([...byCategory.values()]);
    const picked = [];
    while (picked.length < count && queues.some(qs => qs.length)) {
      for (const qs of queues) if (qs.length && picked.length < count) picked.push(qs.shift());
    }
    return this._shuffle(picked).map(q => {
      const order = this._shuffle(q.options.map((_, i) => i));
      return { ...q, options: order.map(i => q.options[i]), answer: order.indexOf(q.answer) };
    });
  }

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  _newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  _getRoom(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('Room not found', 404);
    return room;
  }

  _requirePlayer(room, playerId) {
    const p = room.players.get(playerId);
    if (!p) throw new GameError('You are not in this room', 403);
    return p;
  }

  _requireHost(room, playerId) {
    this._requirePlayer(room, playerId);
    if (room.hostId !== playerId) throw new GameError('Only the host can do that', 403);
  }
}

// While a question is open, scores exclude it so nobody can tell who was right.
function ranked(room) {
  const hide = room.phase === 'question';
  return [...room.players.values()]
    .map(p => {
      const l = hide && p.last ? p.last : { points: 0, ms: 0, correct: false };
      const visible = { score: p.score - l.points, correctMs: p.correctMs - l.ms, correctCount: p.correctCount - (l.correct ? 1 : 0) };
      return { ...p, visible };
    })
    .sort((a, b) =>
      b.visible.score - a.visible.score || a.visible.correctMs - b.visible.correctMs || a.name.localeCompare(b.name));
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) throw new GameError('Please enter a nickname');
  return n;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = { RoomManager, GameError, COUNTDOWN_MS, REVEAL_MS, HOST_GRACE_MS };
