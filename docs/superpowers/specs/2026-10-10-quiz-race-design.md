# Quiz Race — Design

## Goal
A LAN multiplayer quiz race. A host creates a room (category + difficulty), friends on the
same network join with a room code and nickname, the host starts the race, everyone answers
the same timed questions, and a live leaderboard picks a winner. First category: Programming.

## Constraints
- Runs on this machine with `node server.js` (Node 20). **Zero npm dependencies, no database.**
- Questions live in a local `questions.json` file. All game state is in memory.
- UI is a single HTML page (inline CSS/JS) served by the Node server.
- No accounts: nickname only.

## Files
| File | Purpose |
|---|---|
| `server.js` | Built-in `http` server: serves `public/`, JSON API, Server-Sent Events (SSE). Thin — delegates to `game.js`. |
| `game.js` | Pure room/game logic (create, join, start, answer, advance, scoring). No I/O, takes `now` as a parameter so it is testable. |
| `questions.json` | Question bank. |
| `public/index.html` | Whole client: home, lobby, question, reveal, final screens. |
| `test/game.test.js` | `node:test` unit tests for `game.js`. |

## Question format
```json
{ "id": "prog-e-001", "category": "Programming", "difficulty": "easy",
  "question": "What does this print?", "code": "console.log(typeof null)",
  "options": ["null", "object", "undefined", "number"], "answer": 1,
  "explanation": "typeof null is 'object' — a historic JS quirk." }
```
`code` and `explanation` are optional. Initial bank: ~20 easy, ~20 medium, ~20 hard Programming
questions (JS, Python, general CS, algorithms, Git/SQL/HTTP). Adding a category = adding
entries with a new `category` value; the UI lists categories found in the file.

## Game flow
1. **Home** — "Create race" (nickname, category, difficulty: easy/medium/hard/mixed, number of
   questions 5/10/15, seconds per question 10/20/30) or "Join race" (nickname + 4-letter code).
2. **Lobby** — shows room code, LAN URL, joined players. Only the host sees "Start".
   Joining is allowed only while in the lobby. Nicknames are unique per room.
3. **Countdown** — 3 seconds, then questions begin.
4. **Question** — every player sees the same question and a timer. One answer per player,
   locked once sent. The phase ends when time runs out or everyone has answered.
5. **Reveal** (4 s) — correct option, explanation, who got it right, updated leaderboard.
6. Repeat 4–5, then **Final** — podium + full ranking. Host can "Play again" (same room,
   same players, new random questions).

Questions are picked randomly from the filtered pool without repeats; if the pool is smaller
than requested, the race uses all of them.

## Scoring
Correct: `500 + round(500 × timeRemaining / timeLimit)` (500–1000). Wrong or no answer: 0.
Ties ranked by total correct-answer time (lower wins).

## Server ↔ client
- `GET /api/categories` → categories with counts per difficulty.
- `POST /api/rooms` → create (host becomes player); returns `{code, playerId}`.
- `POST /api/rooms/:code/join` → `{playerId}`.
- `POST /api/rooms/:code/start`, `/answer`, `/restart` — require `playerId`; start/restart host-only.
- `GET /api/rooms/:code/events?playerId=…` → SSE stream. Server pushes the full public room
  state on every change (small payload, simple client: "render(state)").
- The server is authoritative: it owns timers, sends deadline timestamps, and **never sends
  the correct answer before the reveal phase**.
- Server prints LAN URLs on startup.

## Edge cases
- Refresh: `playerId` kept in `sessionStorage`; reconnecting SSE restores the player.
- Disconnect: player marked offline; skipped when checking "everyone answered".
- Host leaves the lobby/game: host role passes to the next connected player.
- Rooms with no connected players for 30 min are deleted.
- Invalid code / name taken / race already started → clear error message on the home screen.

## Testing
- `node --test` unit tests for `game.js`: join rules, start permission, scoring, one answer
  per question, phase advancing on timeout and on all-answered, no answer leak in public state,
  host handover.
- Manual smoke test: run the server, play a race with two browser tabs.

## Out of scope (for now)
Accounts, persistence, internet play, other categories' content, question editor.
