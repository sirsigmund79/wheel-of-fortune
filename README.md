# Spin & Solve

An original local-multiplayer word-puzzle party game for 1–6 players (solo play included). A laptop runs the **TV screen** (mirror it to your TV); everyone plays on their **phone**.

Built on Cloudflare Workers + one Durable Object per room (WebSocket hibernation). Plain HTML/CSS/JS, no build step.

## Run locally

```bash
npm install
npm run puzzles      # merge + validate puzzles/src/*.json -> puzzles/puzzles.json
npm run dev          # wrangler dev on 0.0.0.0:8787
```

- Laptop: open `http://localhost:8787/tv` and click once to enable sound.
- Phones (same Wi-Fi): scan the QR code, or open `http://<laptop-LAN-IP>:8787/play` and enter the room code.
  Find your IP with `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).
- Desktop testing: one `/tv` tab + several `/play?room=CODE` tabs. Each tab needs its own player identity, so use separate browser profiles or private windows (the player id lives in `localStorage`).

> **Voice solving** uses the Web Speech API. Browsers only allow the microphone on secure origins (`https://` or `localhost`), so on phones over plain LAN HTTP the mic button hides itself and typing still works. For voice on phones, deploy (below) or use a tunnel (`npx wrangler dev --remote` or `cloudflared tunnel --url http://localhost:8787`). Chrome on Android and Safari on iOS support it.

## Deploy

```bash
npx wrangler login
npm run deploy       # validates puzzles, then wrangler deploy
```

Open `https://wheel-of-fortune.<your-subdomain>.workers.dev/tv`. Durable Objects with SQLite storage work on the Workers free plan.

## Tests

```bash
npm test             # engine, judge, wheel, board, custom pack
npm run validate     # puzzle validator
# end-to-end (needs wrangler dev running with DEBUG_ANSWERS=1):
npx wrangler dev --port 8787 --var DEBUG_ANSWERS:1 &
node scripts/smoke.mjs
```

## How to play

- 4 rounds, then a Bonus Round for the leader.
- On your turn: **SPIN** (then tap a consonant; you earn the wedge value for each time it appears), **BUY A VOWEL** for $250, or **SOLVE** (type it, or hold the mic and say it).
- BANKRUPT wipes your round money, and LOSE A TURN passes play to the next player. A wrong letter, a repeated letter or a wrong solve also ends your turn.
- Solving banks your round money, with a minimum of $1,000.
- **Solo (1 player):** you get 7 spins per puzzle. Misses, BANKRUPT and LOSE A TURN just use up a spin, and a wrong solve costs a spin. With no spins left you can still buy vowels and solve, but a wrong answer (or running out the clock) loses the puzzle.
- Timers: 20 s to act and 30 s to solve.
- Bonus Round: R S T L N E are revealed, you choose 3 consonants and 1 vowel, then you have 15 s to solve.

### Custom puzzle pack

In the lobby, open **Custom puzzle pack** on the TV and paste one puzzle per line:

```
Person | AUNT LINDA'S FAMOUS CHILI
Event | THE GREAT CAMPING DISASTER
```

Custom puzzles are played first, then the stock puzzles.

### Puzzle sets

The TV lobby has a **Puzzles** switch: **From the show** (default), **Originals**, or **Mix**. Show puzzles that were bonus-round puzzles on the show are saved for the Bonus Round.

To refresh the show puzzles from a tab-separated list (`PUZZLE  CATEGORY  DATE  EP#  ROUND`):

```bash
node scripts/import-show.mjs path/to/wheel-puzzles.txt   # writes puzzles/src/50-show.json
npm run puzzles
```

The importer drops crossword rounds, puzzles with digits or symbols the board can't show, ones too long for the board, and repeats. Periods, commas and colons are removed.

## Puzzles

`puzzles/src/*.json` holds original puzzles (`{category, answer, difficulty}`). The validator rejects:
- characters other than A–Z, space and `& ' - ? !`
- answers that don't fit the 12/14/14/12 board with word wrapping
- duplicates
- single-word answers in phrase-type categories

See `PLAN.md` for the architecture and the full WebSocket protocol.
