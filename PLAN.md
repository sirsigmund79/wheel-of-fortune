# Spin & Solve — plan & protocol

## File layout

```
wrangler.jsonc            Worker + assets + Room Durable Object (SQLite-backed, hibernation)
package.json              scripts: dev, deploy, test, puzzles, validate
src/
  worker.js               routes: /tv, /play -> static pages; POST /api/rooms -> new code; /ws/:room -> DO
  room.js                 class Room (DO): hibernating WebSockets, storage, alarm-driven deadlines
  game/
    engine.js             PURE game state machine (no I/O): createGame, applyIntent, onDeadline, snapshot
    wheel.js              24 wedges + mulberry32 seeded RNG
    board.js              4-row 12/14/14/12 word-wrap layout (shared with validator)
    judge.js              fuzzy solve matcher (normalise, per-word edit distance, number words)
    custom.js             parse "Category | ANSWER" custom pack lines
    puzzles.js            loads puzzles/puzzles.json, picks unused puzzles by seed + difficulty
public/
  tv/index.html tv.js tv.css         host screen (lobby/QR/custom pack, board, wheel, scores)
  play/index.html play.js play.css   phone controller
  shared/net.js           reconnecting WebSocket client + server clock offset
  shared/sound.js         WebAudio synth sfx (tick, ding, buzz, bankrupt, solve fanfare)
  shared/theme.css        colour tokens / fonts (swapped to match the chosen mockup)
  vendor/qrcode.js        qrcode-generator (MIT), vendored
puzzles/
  src/*.json              hand-written original puzzles, split by author batch
  puzzles.json            merged output (npm run puzzles)
scripts/
  merge-puzzles.mjs       src/*.json -> puzzles.json
  validate-puzzles.mjs    chars, fits board, dupes, multi-word categories
test/*.test.mjs           node:test — engine, judge, board, wheel
mockups/index.html        visual directions to choose from
```

## Room lifecycle
- TV loads `/tv` → `POST /api/rooms` → `{code}` (4 letters, no I/O/0-like confusion: `ABCDEFGHJKLMNPQRSTUVWXYZ`).
- TV connects `wss://host/ws/CODE`, sends `hello{role:"tv"}`. Phones load `/play?room=CODE`, connect, send `hello{role:"player", playerId?}`.
- DO = `idFromName(CODE)`. State persisted to `ctx.storage` (`"game"` key) after every change. Socket attachment = `{role, playerId}`.
- All timers are absolute `state.deadline` (epoch ms) + `state.deadlineKind`; the DO sets one alarm to the deadline and calls `engine.onDeadline`.

## WebSocket protocol (JSON, every message has `t`)

### Client → DO (intents)
| t | from | payload | valid when |
|---|---|---|---|
| `hello` | any | `{role:"tv"\|"player", playerId?}` | on connect; known playerId = reconnect |
| `join` | player | `{name, color}` name ≤12 chars, unused colour | phase `lobby` |
| `update` | player | `{name?, color?}` | phase `lobby` |
| `leave` | player | `{}` | phase `lobby` |
| `kick` | tv | `{playerId}` | phase `lobby` |
| `customPack` | tv | `{text}` lines `Category \| ANSWER` | phase `lobby` (replaces previous pack) |
| `start` | tv or host | `{}` | lobby, 1–6 players (1 = solo: 7 spins per puzzle) |
| `spin` | current | `{}` | phase `turn`, consonants remain |
| `guess` | current | `{letter}` consonant | phase `pickConsonant` |
| `buyVowel` | current | `{letter}` vowel | phase `turn`, roundMoney ≥ 250, vowels remain |
| `solveStart` | current | `{}` | phase `turn` |
| `solveDraft` | solver | `{text, source:"voice"\|"typed", final?:bool}` | phase `solving`/`bonusSolve` (throttled ~8/s) |
| `solveSubmit` | solver | `{text}` | phase `solving`/`bonusSolve` |
| `solveCancel` | solver | `{}` | phase `solving` (back to `turn`) |
| `bonusPick` | bonus player | `{consonants:[c,c,c], vowel}` | phase `bonusPick` |
| `next` | tv or host | `{}` | `roundEnd`, `bonusEnd` (skip auto-advance) |
| `playAgain` | tv or host | `{}` | `gameOver` → `lobby` keeping players, totals reset |

### DO → client
| t | payload |
|---|---|
| `welcome` | `{role, playerId?, room}` — phone stores `playerId` in `localStorage["sns:"+room]` |
| `state` | `{s: Snapshot}` — full snapshot after every change |
| `ev` | `{e, ...}` — transient animation/sound cue (see below) |
| `error` | `{code, msg}` — rejected intent (shown as toast on phone) |
| `packResult` | `{added, errors:[{line, msg}]}` (tv only) |

### Snapshot
```js
{
  room: "ABCD", serverNow: 1700000000000,
  phase: "lobby"|"roundIntro"|"turn"|"spinning"|"pickConsonant"|"revealing"|"solving"
       |"roundEnd"|"bonusIntro"|"bonusPick"|"bonusReveal"|"bonusSolve"|"bonusEnd"|"gameOver",
  hostId, colors: ["#..",...] /* palette */, customCount,
  players: [{id, name, color, connected, roundMoney, total}],  // in turn order
  round: 1..4 | "bonus", totalRounds: 4,
  category, board: [[cell x12], [x14], [x14], [x12]],
  // cell = null (no tile) | {k:"blank"} (unrevealed letter) | {k:"letter", ch:"A"} | {k:"punct", ch:"'"} ; word gaps are null
  used: ["R","S",...], vowelsLeft: bool, consonantsLeft: bool, vowelsOnly: bool,
  currentId, deadline, deadlineKind: "turn"|"pick"|"solve"|"spin"|"reveal"|"intro"|"roundEnd"|"bonusSolve"|null,
  wheel: { wedges: [{k:"cash",v:300}|{k:"bankrupt"}|{k:"lose"}], index },  // index = last landed wedge
  wedgeValue,               // cash value in play during pickConsonant
  solve: {playerId, text, source, final} | null,   // live transcript for TV
  bonus: {playerId, given:["R","S","T","L","N","E"], picks:[], prize} | null,
  answer,                   // ONLY present once the round is over (roundEnd/bonusEnd/gameOver)
  solo: bool, spinsLeft: number|null, soloSpins: 7,   // solo mode spin budget (null in multiplayer)
  log: "Maya bought an E — 3 of them!",   // latest human-readable line
  winners: [{id, total}]    // gameOver, sorted
}
```

### Events (`ev.e`)
- `spin {index, turns, duration, spinId}` — TV animates eased spin landing on wedge `index` after `turns` full rotations in `duration` ms. Result decided by the DO before broadcast.
- `reveal {letter, count, cells:[[row,col],...], value, earned}` — TV flips cells one by one (~700ms each).
- `miss {letter, reason:"absent"|"used"}`, `bankrupt {playerId, lost}`, `loseTurn {playerId}`
- `turn {playerId}` — phone vibrates if it's them. `timeout {playerId, kind}`
- `outOfSpins {playerId}` (solo: puzzle lost), `solveRight {playerId, banked}`, `solveWrong {playerId, text}`, `roundStart {round}`, `bonusResult {won, prize}`

### Game rules encoded in the engine
- Wedges (24): cash 300–900 ×20, one 2500, two BANKRUPT, one LOSE A TURN. Seeded RNG in state.
- Consonant: value × count to roundMoney. Absent / already used → turn passes. Vowel costs 250 (charged even if absent).
- Solve: correct → banks `max(roundMoney, 1000)` into total; other players' roundMoney discarded. Wrong → turn passes.
- Vowels-only (no consonants left) → SPIN disabled. Board fully revealed by letters → current player solves automatically.
- Timers: 20 s to act in `turn`/`pickConsonant` (timeout = pass), 30 s in `solving` (timeout judges latest draft).
- 4 rounds, round-starting player rotates. Then bonus for top total: RSTLNE revealed, pick 3 consonants + 1 vowel, 15 s solve, prize $25,000.
