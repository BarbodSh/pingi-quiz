# Quiz Race

A multiplayer quiz race for your local network, with timed questions. It needs no npm packages and no database.

```bash
node server.js        # or: npm start   (PORT=4000 node server.js to change port)
npm test              # game-logic tests
```

1. Open http://localhost:3000, enter a nickname and choose a category, difficulty, number of questions and seconds per question.
2. Share the 4-letter room code or the LAN link shown in the lobby. Players on the same Wi-Fi join from their own browsers.
3. The host presses **Start**. Every player gets the same questions. A correct answer scores 500–1000 points, more the faster it comes. Keys 1–4 also answer.

## Questions
Categories: برنامه‌نویسی (60), شبکه (30), لینوکس (30). All questions are Persian, scenario-based and have 4 options.
Choose «همه دسته‌ها (mixed)» to race across every category; questions are taken from each category in turn.

To add questions, edit a file in `questions/` or add a new `questions/<n>-<name>.json` (files load in name order, which sets the category order):
```json
{ "id": "unique-id", "category": "شبکه", "difficulty": "easy|medium|hard",
  "question": "…", "code": "optional snippet", "options": ["a", "b", "c", "d"],
  "answer": 0, "explanation": "optional" }
```
The server checks every question when it starts and refuses to start if a question is invalid, naming the file and question id. Restart the server after editing.
`questions.en.json` holds the old English bank. The server doesn't load it.

## Files
- `server.js`: HTTP server, JSON API, live updates (Server-Sent Events), question loading and checks
- `game.js`: room and scoring logic, kept in memory
- `public/index.html`: the whole web page (Persian text shown right-to-left)
- `questions/`: question bank, one file per category
