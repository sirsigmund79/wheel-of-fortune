import test from "node:test";
import assert from "node:assert/strict";
import { applyIntent, createGame, onDeadline, snapshot, setConnected, COLORS, T } from "../src/game/engine.js";
import { WEDGES } from "../src/game/wheel.js";

const STOCK = [
  { category: "Thing", answer: "BAKED POTATO", difficulty: "easy" },
  { category: "Place", answer: "CANDY SHOP", difficulty: "easy" },
  { category: "Phrase", answer: "HOLD THE DOOR", difficulty: "medium" },
  { category: "Thing", answer: "MILK JUG", difficulty: "easy" },
  { category: "Thing", answer: "WIND CHIMES", difficulty: "easy" },
];

const tv = { role: "tv" };
const CASH = WEDGES.findIndex((w) => w.k === "cash" && w.v === 500);
const BANKRUPT = WEDGES.findIndex((w) => w.k === "bankrupt");
const LOSE = WEDGES.findIndex((w) => w.k === "lose");

function setup(n = 3, stock = STOCK) {
  const s = createGame("ABCD", 42, { stock });
  const ids = [];
  let now = 1000;
  for (let i = 0; i < n; i++) {
    const r = applyIntent(s, { role: "player" }, { t: "join", name: ` Player ${i}  `, color: COLORS[i] }, now);
    assert.equal(r.error, undefined);
    ids.push(r.reply[0].playerId);
  }
  return { s, ids, now };
}

const P = (id) => ({ role: "player", playerId: id });

// Start and skip intro; force a known puzzle.
function started(answer = "BAKED POTATO", n = 3) {
  const ctx = setup(n);
  const { s } = ctx;
  assert.equal(applyIntent(s, tv, { t: "start" }, 2000).error, undefined);
  assert.equal(s.phase, "roundIntro");
  s.puzzle = { category: "Thing", answer };
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "turn");
  ctx.now = s.deadline - T.turn;
  return ctx;
}

function spinTo(s, id, index, now) {
  const r = applyIntent(s, P(id), { t: "spin" }, now);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.events[0].e, "spin");
  assert.ok(r.events[0].turns >= 3 && r.events[0].turns <= 5);
  assert.equal(s.phase, "spinning");
  s.pendingSpin.index = index;
  return onDeadline(s, s.deadline);
}

test("lobby: join validation, names trimmed, colours, host", () => {
  const { s, ids } = setup(2);
  assert.equal(s.players[0].name, "Player 0");
  assert.equal(s.hostId, ids[0]);
  let r = applyIntent(s, { role: "player" }, { t: "join", name: "Ann", color: COLORS[0] }, 1);
  assert.equal(r.error.code, "color_taken");
  r = applyIntent(s, { role: "player" }, { t: "join", name: "   ", color: COLORS[5] }, 1);
  assert.equal(r.error.code, "name");
  r = applyIntent(s, { role: "player" }, { t: "join", name: "A very long name indeed", color: COLORS[5] }, 1);
  assert.equal(s.players.at(-1).name.length <= 12, true);
  // host leaves -> reassigned
  applyIntent(s, P(ids[0]), { t: "leave" }, 2);
  assert.equal(s.hostId, ids[1]);
  // full
  for (let i = 0; i < 6; i++) applyIntent(s, { role: "player" }, { t: "join", name: "X" + i }, 3);
  assert.equal(s.players.length, 6);
  r = applyIntent(s, { role: "player" }, { t: "join", name: "Late" }, 4);
  assert.equal(r.error.code, "full");
  const snap = snapshot(s, 5);
  assert.deepEqual(snap.colors, COLORS);
  assert.equal(new Set(COLORS).size, 8);
});

test("start rules: need 1 player, tv or host only; join afterwards is in_progress", () => {
  const { s: empty } = setup(0);
  assert.equal(applyIntent(empty, tv, { t: "start" }, 1).error.code, "players");
  const { s, ids } = setup(1);
  applyIntent(s, { role: "player" }, { t: "join", name: "B" }, 1);
  const other = s.players[1].id;
  assert.equal(applyIntent(s, P(other), { t: "start" }, 1).error.code, "not_allowed");
  assert.equal(applyIntent(s, P(ids[0]), { t: "start" }, 1).error, undefined);
  assert.equal(applyIntent(s, { role: "player" }, { t: "join", name: "C" }, 2).error.code, "in_progress");
});

test("snapshot never leaks the answer before round end", () => {
  const { s } = started();
  const snap = snapshot(s, 1);
  assert.equal(snap.answer, undefined);
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("POTATO"));
  assert.ok(!/"ch":"[A-Z]"/.test(json));
  assert.equal(snap.board.length, 4);
  assert.deepEqual(snap.board.map((r) => r.length), [12, 14, 14, 12]);
});

test("punctuation is visible from the start", () => {
  const { s } = started("DON'T PANIC!");
  const cells = snapshot(s, 1).board.flat().filter(Boolean);
  assert.deepEqual(cells.filter((c) => c.k === "punct").map((c) => c.ch), ["'", "!"]);
  assert.equal(cells.filter((c) => c.k === "letter").length, 0);
});

test("spin cash -> consonant reveal -> same player's turn", () => {
  const { s, ids, now } = started();
  spinTo(s, ids[0], CASH, now);
  assert.equal(s.phase, "pickConsonant");
  assert.equal(s.wedgeValue, 500);
  const r = applyIntent(s, P(ids[0]), { t: "guess", letter: "t" }, now + 5000);
  assert.equal(r.events[0].e, "reveal");
  assert.equal(r.events[0].count, 2);
  assert.equal(r.events[0].earned, 1000);
  assert.equal(s.players[0].roundMoney, 1000);
  assert.equal(s.phase, "revealing");
  assert.equal(s.deadline, now + 5000 + 700 * 2 + 600);
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "turn");
  assert.equal(s.currentId, ids[0]);
  const snap = snapshot(s, 1);
  assert.equal(snap.board.flat().filter((c) => c?.k === "letter").length, 2);
});

test("absent and already-used consonants pass the turn", () => {
  const { s, ids, now } = started();
  spinTo(s, ids[0], CASH, now);
  let r = applyIntent(s, P(ids[0]), { t: "guess", letter: "Z" }, now);
  assert.equal(r.events[0].e, "miss");
  assert.equal(r.events[0].reason, "absent");
  assert.equal(s.currentId, ids[1]);
  spinTo(s, ids[1], CASH, now);
  r = applyIntent(s, P(ids[1]), { t: "guess", letter: "Z" }, now);
  assert.equal(r.events[0].reason, "used");
  assert.equal(s.currentId, ids[2]);
  // vowel as a consonant guess is rejected without passing
  spinTo(s, ids[2], CASH, now);
  assert.equal(applyIntent(s, P(ids[2]), { t: "guess", letter: "A" }, now).error.code, "invalid");
  assert.equal(applyIntent(s, P(ids[0]), { t: "guess", letter: "B" }, now).error.code, "not_your_turn");
});

test("bankrupt wipes round money; lose a turn passes", () => {
  const { s, ids, now } = started();
  s.players[0].roundMoney = 1800;
  let r = spinTo(s, ids[0], BANKRUPT, now);
  assert.deepEqual(r.events[0], { e: "bankrupt", playerId: ids[0], lost: 1800 });
  assert.equal(s.players[0].roundMoney, 0);
  assert.equal(s.currentId, ids[1]);
  r = spinTo(s, ids[1], LOSE, now);
  assert.equal(r.events[0].e, "loseTurn");
  assert.equal(s.currentId, ids[2]);
  assert.equal(r.events.at(-1).e, "turn");
  assert.equal(snapshot(s, 1).wheel.index, LOSE);
});

test("buy vowel: costs 250, charged even if absent, needs money", () => {
  const { s, ids, now } = started();
  assert.equal(applyIntent(s, P(ids[0]), { t: "buyVowel", letter: "A" }, now).error.code, "no_money");
  s.players[0].roundMoney = 600;
  let r = applyIntent(s, P(ids[0]), { t: "buyVowel", letter: "O" }, now);
  assert.equal(r.events[0].e, "reveal");
  assert.equal(r.events[0].count, 2);
  assert.equal(r.events[0].cost, 250);
  assert.equal(s.players[0].roundMoney, 350);
  onDeadline(s, s.deadline);
  assert.equal(s.currentId, ids[0]);
  r = applyIntent(s, P(ids[0]), { t: "buyVowel", letter: "I" }, now);
  assert.equal(r.events[0].reason, "absent");
  assert.equal(s.players[0].roundMoney, 100);
  assert.equal(s.currentId, ids[1]);
});

test("vowels-only disables spin; completing the board auto-solves for the revealer", () => {
  const { s, ids, now } = started("MILK JUG");
  s.used = ["M", "L", "K", "J", "G"];
  const snap = snapshot(s, 1);
  assert.equal(snap.vowelsOnly, true);
  assert.equal(snap.consonantsLeft, false);
  assert.equal(applyIntent(s, P(ids[0]), { t: "spin" }, now).error.code, "vowels_only");
  s.players[0].roundMoney = 300;
  applyIntent(s, P(ids[0]), { t: "buyVowel", letter: "I" }, now);
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "turn");
  s.players[0].roundMoney = 300;
  applyIntent(s, P(ids[0]), { t: "buyVowel", letter: "U" }, now);
  const r = onDeadline(s, s.deadline);
  assert.equal(s.phase, "roundEnd");
  assert.equal(r.events[0].e, "solveRight");
  assert.equal(r.events[0].banked, 1000); // min $1000
  assert.equal(s.players[0].total, 1000);
  assert.equal(snapshot(s, 1).answer, "MILK JUG");
});

test("solve: correct banks max(roundMoney, 1000), others lose round money", () => {
  const { s, ids, now } = started();
  s.players[0].roundMoney = 400;
  s.players[1].roundMoney = 5000;
  applyIntent(s, P(ids[0]), { t: "solveStart" }, now);
  assert.equal(s.phase, "solving");
  assert.equal(s.deadline, now + 30000);
  applyIntent(s, P(ids[0]), { t: "solveDraft", text: "baked pot", source: "voice" }, now);
  assert.equal(snapshot(s, 1).solve.text, "baked pot");
  assert.equal(applyIntent(s, P(ids[1]), { t: "solveDraft", text: "x" }, now).error.code, "not_your_turn");
  const r = applyIntent(s, P(ids[0]), { t: "solveSubmit", text: "baked potatoe" }, now);
  assert.deepEqual(r.events[0], { e: "solveRight", playerId: ids[0], banked: 1000 });
  assert.equal(s.players[0].total, 1000);
  assert.equal(s.players[1].roundMoney, 0);
  assert.equal(s.players[1].total, 0);
});

test("solve: wrong passes turn; cancel returns to turn", () => {
  const { s, ids, now } = started();
  applyIntent(s, P(ids[0]), { t: "solveStart" }, now);
  applyIntent(s, P(ids[0]), { t: "solveCancel" }, now);
  assert.equal(s.phase, "turn");
  assert.equal(s.currentId, ids[0]);
  applyIntent(s, P(ids[0]), { t: "solveStart" }, now);
  const r = applyIntent(s, P(ids[0]), { t: "solveSubmit", text: "BAKED BEANS" }, now);
  assert.equal(r.events[0].e, "solveWrong");
  assert.equal(s.currentId, ids[1]);
  assert.equal(s.phase, "turn");
});

test("timers: turn, pick and solve timeouts", () => {
  const { s, ids, now } = started();
  // Not yet due -> no-op
  assert.deepEqual(onDeadline(s, s.deadline - 1).events, []);
  let r = onDeadline(s, s.deadline);
  assert.deepEqual(r.events[0], { e: "timeout", playerId: ids[0], kind: "turn" });
  assert.equal(s.currentId, ids[1]);
  spinTo(s, ids[1], CASH, now);
  assert.equal(s.deadlineKind, "pick");
  r = onDeadline(s, s.deadline);
  assert.equal(r.events[0].kind, "pick");
  assert.equal(s.currentId, ids[2]);
  // solve timeout judges the latest draft
  applyIntent(s, P(ids[2]), { t: "solveStart" }, now);
  applyIntent(s, P(ids[2]), { t: "solveDraft", text: "baked potato", source: "voice", final: true }, now);
  r = onDeadline(s, s.deadline);
  assert.equal(r.events.find((e) => e.e === "solveRight").playerId, ids[2]);
  // round end auto-advances to round 2 with the next starting player
  assert.equal(s.deadlineKind, "roundEnd");
  r = onDeadline(s, s.deadline);
  assert.equal(s.round, 2);
  assert.equal(s.phase, "roundIntro");
  assert.equal(s.currentId, ids[1]);
  assert.equal(r.events[0].e, "roundStart");
});

test("disconnected players keep their turn; host moves to a connected player", () => {
  const { s, ids } = started();
  setConnected(s, new Set([ids[1], ids[2]]));
  assert.equal(s.players[0].connected, false);
  assert.equal(s.hostId, ids[1]);
  assert.equal(s.currentId, ids[0]);
});

test("full game: 4 rounds, bonus for the leader, gameOver, playAgain", () => {
  const { s, ids, now } = started();
  let t = now;
  for (let round = 1; round <= 4; round++) {
    if (round > 1) { onDeadline(s, s.deadline); t = s.deadline - T.turn; }
    assert.equal(s.phase, "turn");
    const solver = round === 3 ? ids[2] : s.currentId; // round 3: give ids[2] the turn by passing
    while (s.currentId !== solver) onDeadline(s, s.deadline);
    s.players.find((p) => p.id === solver).roundMoney = round * 1000;
    applyIntent(s, P(solver), { t: "solveStart" }, t);
    applyIntent(s, P(solver), { t: "solveSubmit", text: s.puzzle.answer }, t);
    assert.equal(s.phase, "roundEnd");
    if (round < 4) applyIntent(s, tv, { t: "next" }, t);
  }
  // totals: ids[0] 1000 (r1), ids[1] 2000 (r2), ids[2] 3000 (r3), r4 starts with ids[0] -> 4000+1000
  assert.equal(s.players[0].total, 5000);
  assert.equal(new Set(s.usedPuzzles).size, 4);
  applyIntent(s, tv, { t: "next" }, t);
  assert.equal(s.phase, "bonusIntro");
  assert.equal(s.round, "bonus");
  assert.equal(s.bonus.playerId, ids[0]);
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "bonusPick");
  assert.deepEqual(s.used, ["R", "S", "T", "L", "N", "E"]);
  s.puzzle = { category: "Thing", answer: "WIND CHIMES" };
  s.used = ["R", "S", "T", "L", "N", "E"];
  const bad = [
    { consonants: ["B", "C"], vowel: "A" },
    { consonants: ["B", "B", "C"], vowel: "A" },
    { consonants: ["B", "C", "T"], vowel: "A" },
    { consonants: ["B", "C", "D"], vowel: "E" },
    { consonants: ["B", "C", "A"], vowel: "O" },
  ];
  for (const b of bad) assert.equal(applyIntent(s, P(ids[0]), { t: "bonusPick", ...b }, t).error.code, "invalid");
  assert.equal(applyIntent(s, P(ids[1]), { t: "bonusPick", consonants: ["C", "D", "M"], vowel: "I" }, t).error.code, "not_your_turn");
  const r = applyIntent(s, P(ids[0]), { t: "bonusPick", consonants: ["c", "d", "m"], vowel: "i" }, t);
  assert.equal(s.phase, "bonusReveal");
  assert.ok(r.events.some((e) => e.e === "reveal" && e.letter === "I" && e.count === 2));
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "bonusSolve");
  assert.equal(s.deadline - s.deadlineKind.length >= 0, true);
  assert.equal(s.deadlineKind, "bonusSolve");
  assert.equal(snapshot(s, 1).answer, undefined);
  let res = applyIntent(s, P(ids[0]), { t: "solveSubmit", text: "wind chains" }, t);
  assert.equal(res.events[0].e, "solveWrong");
  assert.equal(s.phase, "bonusSolve");
  applyIntent(s, P(ids[0]), { t: "solveDraft", text: "wind chimes", source: "voice" }, t);
  res = onDeadline(s, s.deadline);
  assert.deepEqual(res.events.at(-1), { e: "bonusResult", won: true, prize: 25000 });
  assert.equal(s.phase, "bonusEnd");
  assert.equal(snapshot(s, 1).answer, "WIND CHIMES");
  assert.equal(s.players[0].total, 30000);
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "gameOver");
  const snap = snapshot(s, 1);
  assert.deepEqual(snap.winners.map((w) => w.id), [ids[0], ids[2], ids[1]]);
  assert.equal(applyIntent(s, P(ids[1]), { t: "playAgain" }, t).error.code, "not_allowed");
  applyIntent(s, tv, { t: "playAgain" }, t);
  assert.equal(s.phase, "lobby");
  assert.equal(s.players.length, 3);
  assert.ok(s.players.every((p) => p.total === 0));
});

test("bonus: tie goes to the earliest player; pick timeout auto-picks; lost bonus", () => {
  const { s, ids } = started();
  s.round = 4;
  s.players[1].total = 3000;
  s.players[2].total = 3000;
  s.phase = "roundEnd";
  applyIntent(s, tv, { t: "next" }, 10);
  assert.equal(s.bonus.playerId, ids[1]);
  onDeadline(s, s.deadline); // -> bonusPick
  let r = onDeadline(s, s.deadline); // pick timeout
  assert.equal(r.events[0].e, "timeout");
  assert.equal(s.phase, "bonusReveal");
  assert.equal(s.bonus.picks.length, 4);
  onDeadline(s, s.deadline);
  r = onDeadline(s, s.deadline); // solve timeout with empty draft
  assert.deepEqual(r.events.at(-1), { e: "bonusResult", won: false, prize: 25000 });
  assert.equal(s.players[1].total, 3000);
});

test("custom pack used first; reply goes to tv only", () => {
  const { s, ids } = setup(2);
  assert.equal(applyIntent(s, P(ids[0]), { t: "customPack", text: "Thing | FOO" }, 1).error.code, "not_allowed");
  const r = applyIntent(s, tv, { t: "customPack", text: "Family | GRANDMA'S APPLE PIE\nbad line\nThing | ZEBRA CROSSING" }, 1);
  assert.equal(r.reply[0].t, "packResult");
  assert.equal(r.reply[0].added, 2);
  assert.equal(r.reply[0].errors[0].line, 2);
  assert.equal(snapshot(s, 1).customCount, 2);
  applyIntent(s, tv, { t: "start" }, 1);
  const first = s.puzzle.answer;
  assert.ok(["GRANDMA'S APPLE PIE", "ZEBRA CROSSING"].includes(first));
  s.phase = "roundEnd";
  applyIntent(s, tv, { t: "next" }, 2);
  assert.ok(["GRANDMA'S APPLE PIE", "ZEBRA CROSSING"].includes(s.puzzle.answer));
  assert.notEqual(s.puzzle.answer, first);
  s.phase = "roundEnd";
  applyIntent(s, tv, { t: "next" }, 3);
  assert.ok(STOCK.some((p) => p.answer === s.puzzle.answer));
});

test("deterministic: same seed, same intents -> same state", () => {
  const run = () => {
    const { s, ids } = setup(3);
    applyIntent(s, tv, { t: "start" }, 2000);
    onDeadline(s, s.deadline);
    applyIntent(s, P(ids[0]), { t: "spin" }, 6000);
    onDeadline(s, s.deadline);
    return JSON.stringify(s);
  };
  assert.equal(run(), run());
});

test("uses the bundled puzzle library by default", () => {
  const s = createGame("WXYZ", 7);
  applyIntent(s, { role: "player" }, { t: "join", name: "A" }, 1);
  applyIntent(s, { role: "player" }, { t: "join", name: "B" }, 1);
  applyIntent(s, tv, { t: "start" }, 1);
  assert.ok(s.puzzle.answer.length > 0);
  assert.ok(snapshot(s, 1).category);
});

test("solo: one player can start and gets 7 spins per puzzle", () => {
  const { s, ids } = started("BAKED POTATO", 1);
  const me = ids[0];
  let snap = snapshot(s, 0);
  assert.equal(snap.solo, true);
  assert.equal(snap.spinsLeft, 7);
  // A miss keeps the turn with the solo player.
  spinTo(s, me, CASH, 0);
  applyIntent(s, P(me), { t: "guess", letter: "Z" }, 0);
  assert.equal(s.phase, "turn");
  assert.equal(s.currentId, me);
  assert.equal(s.spinsLeft, 6);
  // BANKRUPT and LOSE A TURN also just burn a spin.
  spinTo(s, me, BANKRUPT, 0);
  spinTo(s, me, LOSE, 0);
  assert.equal(s.phase, "turn");
  assert.equal(s.spinsLeft, 4);
  for (let i = 0; i < 4; i++) { spinTo(s, me, LOSE, 0); }
  assert.equal(s.spinsLeft, 0);
  assert.equal(applyIntent(s, P(me), { t: "spin" }, 0).error.code, "no_spins");
  // Out of spins: can still solve; a wrong solve now ends the puzzle.
  applyIntent(s, P(me), { t: "solveStart" }, 0);
  const r = applyIntent(s, P(me), { t: "solveSubmit", text: "WRONG ANSWER" }, 0);
  assert.equal(s.phase, "roundEnd");
  assert.ok(r.events.some((e) => e.e === "outOfSpins"));
  assert.equal(s.players[0].total, 0);
  assert.equal(snapshot(s, 0).answer, "BAKED POTATO");
});

test("solo: wrong solve with spins left costs a spin; right solve banks", () => {
  const { s, ids } = started("BAKED POTATO", 1);
  const me = ids[0];
  applyIntent(s, P(me), { t: "solveStart" }, 0);
  applyIntent(s, P(me), { t: "solveSubmit", text: "NOPE" }, 0);
  assert.equal(s.phase, "turn");
  assert.equal(s.spinsLeft, 6);
  applyIntent(s, P(me), { t: "solveStart" }, 0);
  applyIntent(s, P(me), { t: "solveSubmit", text: "baked potato" }, 0);
  assert.equal(s.phase, "roundEnd");
  assert.equal(s.players[0].total, 1000);
  // Next round resets spins.
  onDeadline(s, s.deadline);
  assert.equal(s.spinsLeft, 7);
});

test("solo: turn timeout with no spins left ends the puzzle", () => {
  const { s, ids } = started("BAKED POTATO", 1);
  s.spinsLeft = 0;
  onDeadline(s, s.deadline);
  assert.equal(s.phase, "roundEnd");
});

test("multiplayer snapshot has no spin limit", () => {
  const { s } = started("BAKED POTATO", 2);
  const snap = snapshot(s, 0);
  assert.equal(snap.solo, false);
  assert.equal(snap.spinsLeft, null);
});
