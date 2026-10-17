// PURE game state machine for Spin & Solve. No I/O, no clocks: `now` (epoch ms) is passed in.
// State is a plain JSON object (persisted by the Durable Object); functions mutate it in place.
import { layout, PUNCTUATION, VOWELS } from "./board.js";
import { WEDGES, randInt, spinWheel } from "./wheel.js";
import { judge } from "./judge.js";
import { pickPuzzle, puzzleKey } from "./puzzles.js";
import { parseCustomPack } from "./custom.js";

export const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ec4899"];
export const TOTAL_ROUNDS = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const MAX_NAME = 12;
export const VOWEL_COST = 250;
export const MIN_SOLVE = 1000;
export const BONUS_PRIZE = 25000;
export const BONUS_GIVEN = ["R", "S", "T", "L", "N", "E"];

export const T = {
  turn: 20000,
  pick: 20000,
  solve: 30000,
  intro: 3000,
  roundEnd: 9000,
  revealPer: 700,
  revealPad: 600,
  bonusIntro: 3500,
  bonusPick: 30000,
  bonusReveal: 3000,
  bonusSolve: 15000,
  bonusEnd: 10000,
};

const CONSONANTS = "BCDFGHJKLMNPQRSTVWXYZ".split("");
const fmt = (n) => "$" + n.toLocaleString("en-US");

// ---------------------------------------------------------------------------------------------
// Creation

export function createGame(room, seed = 1, opts = {}) {
  return {
    v: 1,
    room,
    rng: seed | 0,
    stock: opts.stock || null, // optional injected puzzle list (tests); null = bundled library
    phase: "lobby",
    players: [],
    hostId: null,
    round: 0,
    puzzle: null, // {category, answer}
    used: [],
    currentId: null,
    deadline: null,
    deadlineKind: null,
    wheelIndex: 0,
    spinId: 0,
    pendingSpin: null,
    wedgeValue: null,
    solve: null,
    bonus: null,
    winners: null,
    custom: [],
    usedPuzzles: [],
    log: `Room ${room} is open — join on your phone!`,
    lastActive: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

const player = (s, id) => s.players.find((p) => p.id === id);
const nameOf = (s, id) => player(s, id)?.name ?? "Someone";

function setDeadline(s, now, ms, kind) {
  s.deadline = ms == null ? null : now + ms;
  s.deadlineKind = ms == null ? null : kind;
}

function puzzleLetters(s) {
  return new Set((s.puzzle?.answer || "").replace(/[^A-Z]/g, ""));
}

function remaining(s) {
  const used = new Set(s.used);
  let vowels = 0, consonants = 0;
  for (const ch of puzzleLetters(s)) {
    if (used.has(ch)) continue;
    if (VOWELS.has(ch)) vowels++;
    else consonants++;
  }
  return { vowels, consonants };
}

function cellsFor(s, letter) {
  const { rows } = layout(s.puzzle.answer);
  const cells = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => ch === letter && cells.push([r, c])));
  return cells;
}

function newPlayerId(s) {
  let id;
  do {
    id = "p";
    for (let i = 0; i < 10; i++) id += "abcdefghijkmnpqrstuvwxyz23456789"[randInt(s, 32)];
  } while (player(s, id));
  return id;
}

function normaliseColor(c) {
  if (typeof c === "number" && COLORS[c]) return COLORS[c];
  if (typeof c === "string") {
    const hit = COLORS.find((x) => x.toLowerCase() === c.trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function cleanName(n) {
  return String(n ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
}

function fixHost(s) {
  if (s.hostId && player(s, s.hostId) && (player(s, s.hostId).connected || !s.players.some((p) => p.connected))) return;
  s.hostId = (s.players.find((p) => p.connected) || s.players[0])?.id ?? null;
}

const err = (code, msg) => ({ events: [], error: { code, msg } });
const isTvOrHost = (s, a) => a.role === "tv" || (a.role === "player" && a.playerId && a.playerId === s.hostId);
const isCurrent = (s, a) => a.role === "player" && a.playerId && a.playerId === s.currentId;

// ---------------------------------------------------------------------------------------------
// Flow

function beginTurn(s, id, now, events, announce = true) {
  s.phase = "turn";
  s.currentId = id;
  s.wedgeValue = null;
  s.solve = null;
  setDeadline(s, now, T.turn, "turn");
  if (announce) events.push({ e: "turn", playerId: id });
}

function passTurn(s, now, events) {
  const i = s.players.findIndex((p) => p.id === s.currentId);
  const next = s.players[(i + 1) % s.players.length];
  beginTurn(s, next.id, now, events);
}

function startRound(s, now, events) {
  s.round = (typeof s.round === "number" ? s.round : 0) + 1;
  const p = pickPuzzle(s, s.round, { custom: s.custom, used: s.usedPuzzles, stock: s.stock || undefined });
  s.puzzle = { category: p.category, answer: p.answer };
  s.usedPuzzles.push(puzzleKey(p.answer));
  s.used = [];
  s.solve = null;
  s.wedgeValue = null;
  s.bonus = null;
  for (const pl of s.players) pl.roundMoney = 0;
  s.currentId = s.players[(s.round - 1) % s.players.length].id;
  s.phase = "roundIntro";
  setDeadline(s, now, T.intro, "intro");
  s.log = `Round ${s.round} — ${s.puzzle.category}. ${nameOf(s, s.currentId)} starts.`;
  events.push({ e: "roundStart", round: s.round });
}

function endRoundWon(s, id, now, events, how) {
  const p = player(s, id);
  const banked = Math.max(p.roundMoney, MIN_SOLVE);
  p.total += banked;
  for (const pl of s.players) pl.roundMoney = 0;
  p.roundMoney = banked; // shown on the round-end screen; reset when the next round starts
  s.phase = "roundEnd";
  s.solve = null;
  s.wedgeValue = null;
  setDeadline(s, now, T.roundEnd, "roundEnd");
  s.log = `${p.name} ${how} and banks ${fmt(banked)}!`;
  events.push({ e: "solveRight", playerId: id, banked });
}

function advanceFromRoundEnd(s, now, events) {
  if (s.round < TOTAL_ROUNDS) startRound(s, now, events);
  else startBonus(s, now, events);
}

function startBonus(s, now, events) {
  // Leader by total; ties go to whoever is earliest in turn order.
  let leader = s.players[0];
  for (const p of s.players) if (p.total > leader.total) leader = p;
  for (const p of s.players) p.roundMoney = 0;
  const pz = pickPuzzle(s, "bonus", { custom: s.custom, used: s.usedPuzzles, stock: s.stock || undefined });
  s.puzzle = { category: pz.category, answer: pz.answer };
  s.usedPuzzles.push(puzzleKey(pz.answer));
  s.round = "bonus";
  s.used = [];
  s.solve = null;
  s.currentId = leader.id;
  s.bonus = { playerId: leader.id, given: [...BONUS_GIVEN], picks: [], prize: BONUS_PRIZE };
  s.phase = "bonusIntro";
  setDeadline(s, now, T.bonusIntro, "intro");
  s.log = `Bonus round! ${leader.name} plays for ${fmt(BONUS_PRIZE)}.`;
  events.push({ e: "roundStart", round: "bonus" });
}

function revealLetters(s, letters, events) {
  let cells = 0;
  for (const letter of letters) {
    if (!s.used.includes(letter)) s.used.push(letter);
    const c = cellsFor(s, letter);
    if (c.length) {
      cells += c.length;
      events.push({ e: "reveal", letter, count: c.length, cells: c, value: 0, earned: 0 });
    }
  }
  return cells;
}

function startBonusPick(s, now, events) {
  s.phase = "bonusPick";
  revealLetters(s, BONUS_GIVEN, events);
  setDeadline(s, now, T.bonusPick, "pick");
  s.log = `R S T L N E are on the board. ${nameOf(s, s.bonus.playerId)}, pick 3 consonants and a vowel.`;
}

function applyBonusPick(s, consonants, vowel, now, events) {
  s.bonus.picks = [...consonants, vowel];
  const cells = revealLetters(s, s.bonus.picks, events);
  s.phase = "bonusReveal";
  setDeadline(s, now, Math.max(T.bonusReveal, cells * 350 + T.revealPad), "reveal");
  s.log = `${nameOf(s, s.bonus.playerId)} picked ${s.bonus.picks.join(" ")}.`;
}

function endBonus(s, won, now, events) {
  const p = player(s, s.bonus.playerId);
  if (won && p) p.total += s.bonus.prize;
  s.bonus.won = won;
  s.phase = "bonusEnd";
  s.solve = null;
  setDeadline(s, now, T.bonusEnd, "roundEnd");
  s.log = won ? `${p?.name} solved the bonus puzzle and wins ${fmt(s.bonus.prize)}!` : `So close! The bonus puzzle got away.`;
  events.push({ e: "bonusResult", won, prize: s.bonus.prize });
}

function gameOver(s) {
  s.phase = "gameOver";
  s.currentId = null;
  setDeadline(s, 0, null);
  s.winners = s.players.map((p) => ({ id: p.id, total: p.total })).sort((a, b) => b.total - a.total);
  const top = s.winners[0];
  s.log = top ? `${nameOf(s, top.id)} wins with ${fmt(top.total)}!` : "Game over.";
}

function boardComplete(s) {
  const r = remaining(s);
  return r.vowels + r.consonants === 0;
}

function judgeMainSolve(s, text, now, events) {
  const id = s.currentId;
  if (judge(text, s.puzzle.answer).ok) {
    endRoundWon(s, id, now, events, "solved it");
  } else {
    s.log = `${nameOf(s, id)} guessed "${String(text || "…").slice(0, 60)}" — not quite.`;
    events.push({ e: "solveWrong", playerId: id, text: String(text || "") });
    passTurn(s, now, events);
  }
}

// ---------------------------------------------------------------------------------------------
// Intents

/**
 * applyIntent(state, actor {role, playerId}, intent {t, ...}, now) -> {events, error?, reply?}
 */
export function applyIntent(s, actor, intent, now) {
  const handler = HANDLERS[intent?.t];
  if (!handler) return err("unknown", `Unknown message ${intent?.t}`);
  const events = [];
  const reply = [];
  const res = handler(s, actor || {}, intent, now, events, reply);
  if (res?.error) return { events: [], error: res.error };
  s.lastActive = now;
  return reply.length ? { events, reply } : { events };
}

const needPhase = (s, ...phases) => (phases.includes(s.phase) ? null : err("bad_phase", "Not now."));

const HANDLERS = {
  join(s, a, m, now, events, reply) {
    if (a.role !== "player") return err("not_allowed", "Only phones can join.");
    if (a.playerId && player(s, a.playerId)) return HANDLERS.update(s, a, m, now, events, reply);
    if (s.phase !== "lobby") return err("in_progress", "A game is already in progress.");
    if (s.players.length >= MAX_PLAYERS) return err("full", `Room is full (${MAX_PLAYERS} players).`);
    const name = cleanName(m.name);
    if (!name) return err("name", "Please enter a name.");
    let color = m.color == null || m.color === "" ? COLORS.find((c) => !s.players.some((p) => p.color === c)) : normaliseColor(m.color);
    if (!color) return err("invalid", "Pick one of the colours.");
    if (s.players.some((p) => p.color === color)) return err("color_taken", "That colour is taken.");
    const id = newPlayerId(s);
    s.players.push({ id, name, color, connected: true, roundMoney: 0, total: 0 });
    fixHost(s);
    s.log = `${name} joined.`;
    reply.push({ t: "welcome", role: "player", playerId: id, room: s.room });
  },

  update(s, a, m) {
    const p = a.role === "player" && player(s, a.playerId);
    if (!p) return err("not_joined", "Join first.");
    if (s.phase !== "lobby") return err("bad_phase", "Can't change that during a game.");
    if (m.name != null) {
      const name = cleanName(m.name);
      if (!name) return err("name", "Please enter a name.");
      p.name = name;
    }
    if (m.color != null) {
      const color = normaliseColor(m.color);
      if (!color) return err("invalid", "Pick one of the colours.");
      if (s.players.some((o) => o !== p && o.color === color)) return err("color_taken", "That colour is taken.");
      p.color = color;
    }
    s.log = `${p.name} is ready.`;
  },

  leave(s, a, m, now, events, reply) {
    const p = a.role === "player" && player(s, a.playerId);
    if (!p) return err("not_joined", "You're not in this game.");
    if (s.phase !== "lobby") return err("bad_phase", "You can't leave mid-game.");
    s.players = s.players.filter((x) => x !== p);
    fixHost(s);
    s.log = `${p.name} left.`;
    reply.push({ t: "welcome", role: "player", room: s.room });
  },

  kick(s, a, m) {
    if (a.role !== "tv") return err("not_allowed", "Only the TV can remove players.");
    if (s.phase !== "lobby") return err("bad_phase", "Only in the lobby.");
    const p = player(s, m.playerId);
    if (!p) return err("invalid", "No such player.");
    s.players = s.players.filter((x) => x !== p);
    fixHost(s);
    s.log = `${p.name} was removed.`;
  },

  customPack(s, a, m, now, events, reply) {
    if (a.role !== "tv") return err("not_allowed", "Only the TV can load a pack.");
    if (s.phase !== "lobby") return err("bad_phase", "Only in the lobby.");
    const { puzzles, errors } = parseCustomPack(m.text);
    s.custom = puzzles;
    s.log = puzzles.length ? `Custom pack loaded: ${puzzles.length} puzzle${puzzles.length === 1 ? "" : "s"}.` : "Custom pack cleared.";
    reply.push({ t: "packResult", added: puzzles.length, errors });
  },

  start(s, a, m, now, events) {
    if (!isTvOrHost(s, a)) return err("not_allowed", "Only the host can start.");
    if (s.phase !== "lobby") return err("bad_phase", "Already started.");
    if (s.players.length < MIN_PLAYERS) return err("players", `Need at least ${MIN_PLAYERS} players.`);
    for (const p of s.players) Object.assign(p, { roundMoney: 0, total: 0 });
    s.round = 0;
    s.winners = null;
    startRound(s, now, events);
  },

  spin(s, a, m, now, events) {
    if (!isCurrent(s, a)) return err("not_your_turn", "It's not your turn.");
    const bad = needPhase(s, "turn");
    if (bad) return bad;
    if (remaining(s).consonants === 0) return err("vowels_only", "Only vowels left — buy a vowel or solve.");
    const spin = spinWheel(s);
    s.spinId++;
    s.pendingSpin = { index: spin.index };
    s.phase = "spinning";
    setDeadline(s, now, spin.duration, "spin");
    s.log = `${nameOf(s, a.playerId)} spins the wheel…`;
    events.push({ e: "spin", index: spin.index, turns: spin.turns, duration: spin.duration, spinId: s.spinId });
  },

  guess(s, a, m, now, events) {
    if (!isCurrent(s, a)) return err("not_your_turn", "It's not your turn.");
    const bad = needPhase(s, "pickConsonant");
    if (bad) return bad;
    const letter = String(m.letter || "").toUpperCase();
    if (!/^[A-Z]$/.test(letter) || VOWELS.has(letter)) return err("invalid", "Pick a consonant.");
    const p = player(s, a.playerId);
    if (s.used.includes(letter)) {
      s.log = `${letter} was already called — turn passes.`;
      events.push({ e: "miss", letter, reason: "used" });
      return passTurn(s, now, events);
    }
    s.used.push(letter);
    const cells = cellsFor(s, letter);
    if (!cells.length) {
      s.log = `No ${letter}. Sorry, ${p.name}!`;
      events.push({ e: "miss", letter, reason: "absent" });
      return passTurn(s, now, events);
    }
    const earned = s.wedgeValue * cells.length;
    p.roundMoney += earned;
    s.log = cells.length === 1
      ? `There is one ${letter} — ${p.name} earns ${fmt(earned)}.`
      : `There are ${cells.length} ${letter}s — ${p.name} earns ${fmt(earned)}.`;
    events.push({ e: "reveal", letter, count: cells.length, cells, value: s.wedgeValue, earned });
    s.phase = "revealing";
    setDeadline(s, now, T.revealPer * cells.length + T.revealPad, "reveal");
  },

  buyVowel(s, a, m, now, events) {
    if (!isCurrent(s, a)) return err("not_your_turn", "It's not your turn.");
    const bad = needPhase(s, "turn");
    if (bad) return bad;
    const letter = String(m.letter || "").toUpperCase();
    if (!VOWELS.has(letter)) return err("invalid", "Pick a vowel.");
    const p = player(s, a.playerId);
    if (p.roundMoney < VOWEL_COST) return err("no_money", `A vowel costs ${fmt(VOWEL_COST)}.`);
    if (remaining(s).vowels === 0) return err("no_vowels", "No vowels left in this puzzle.");
    if (s.used.includes(letter)) {
      s.log = `${letter} was already bought — turn passes.`;
      events.push({ e: "miss", letter, reason: "used" });
      return passTurn(s, now, events);
    }
    p.roundMoney -= VOWEL_COST;
    s.used.push(letter);
    const cells = cellsFor(s, letter);
    if (!cells.length) {
      s.log = `${p.name} bought an ${letter} — but there isn't one.`;
      events.push({ e: "miss", letter, reason: "absent" });
      return passTurn(s, now, events);
    }
    s.log = `${p.name} bought an ${letter} — ${cells.length === 1 ? "there's one" : `${cells.length} of them`}!`;
    events.push({ e: "reveal", letter, count: cells.length, cells, value: 0, earned: 0, cost: VOWEL_COST });
    s.wedgeValue = null;
    s.phase = "revealing";
    setDeadline(s, now, T.revealPer * cells.length + T.revealPad, "reveal");
  },

  solveStart(s, a, m, now) {
    if (!isCurrent(s, a)) return err("not_your_turn", "It's not your turn.");
    const bad = needPhase(s, "turn");
    if (bad) return bad;
    s.phase = "solving";
    s.solve = { playerId: a.playerId, text: "", source: "typed", final: false };
    setDeadline(s, now, T.solve, "solve");
    s.log = `${nameOf(s, a.playerId)} is solving…`;
  },

  solveDraft(s, a, m) {
    if (!s.solve || a.role !== "player" || a.playerId !== s.solve.playerId) return err("not_your_turn", "You're not solving.");
    const bad = needPhase(s, "solving", "bonusSolve");
    if (bad) return bad;
    s.solve.text = String(m.text ?? "").slice(0, 120);
    s.solve.source = m.source === "voice" ? "voice" : "typed";
    s.solve.final = !!m.final;
  },

  solveSubmit(s, a, m, now, events) {
    if (!s.solve || a.role !== "player" || a.playerId !== s.solve.playerId) return err("not_your_turn", "You're not solving.");
    const bad = needPhase(s, "solving", "bonusSolve");
    if (bad) return bad;
    const text = String(m.text ?? s.solve.text ?? "").slice(0, 120);
    s.solve.text = text;
    s.solve.final = true;
    if (s.phase === "solving") return judgeMainSolve(s, text, now, events);
    // Bonus: a wrong guess doesn't end it — keep trying until the clock runs out.
    if (judge(text, s.puzzle.answer).ok) return endBonus(s, true, now, events);
    s.bonus.lastWrong = text;
    s.log = `"${text.slice(0, 60)}" — no! Keep trying!`;
    events.push({ e: "solveWrong", playerId: a.playerId, text });
  },

  solveCancel(s, a, m, now, events) {
    if (!s.solve || a.role !== "player" || a.playerId !== s.solve.playerId) return err("not_your_turn", "You're not solving.");
    const bad = needPhase(s, "solving");
    if (bad) return bad;
    beginTurn(s, a.playerId, now, events, false);
    s.log = `${nameOf(s, a.playerId)} isn't ready to solve yet.`;
  },

  bonusPick(s, a, m, now, events) {
    if (s.phase !== "bonusPick") return err("bad_phase", "Not now.");
    if (a.role !== "player" || a.playerId !== s.bonus?.playerId) return err("not_your_turn", "Not your bonus round.");
    const cons = Array.isArray(m.consonants) ? m.consonants.map((c) => String(c).toUpperCase()) : [];
    const vowel = String(m.vowel || "").toUpperCase();
    if (cons.length !== 3 || cons.some((c) => !CONSONANTS.includes(c))) return err("invalid", "Pick 3 consonants.");
    if (new Set(cons).size !== 3) return err("invalid", "Consonants must be different.");
    if (cons.some((c) => BONUS_GIVEN.includes(c))) return err("invalid", "R S T L N E are already given.");
    if (!VOWELS.has(vowel) || BONUS_GIVEN.includes(vowel)) return err("invalid", "Pick a vowel other than E.");
    applyBonusPick(s, cons, vowel, now, events);
  },

  next(s, a, m, now, events) {
    if (!isTvOrHost(s, a)) return err("not_allowed", "Only the host can skip ahead.");
    if (s.phase === "roundEnd") return advanceFromRoundEnd(s, now, events);
    if (s.phase === "bonusEnd") return gameOver(s);
    return err("bad_phase", "Not now.");
  },

  playAgain(s, a) {
    if (!isTvOrHost(s, a)) return err("not_allowed", "Only the host can restart.");
    if (s.phase !== "gameOver") return err("bad_phase", "The game isn't over.");
    for (const p of s.players) Object.assign(p, { roundMoney: 0, total: 0 });
    Object.assign(s, {
      phase: "lobby", round: 0, puzzle: null, used: [], currentId: null, wedgeValue: null,
      solve: null, bonus: null, winners: null, pendingSpin: null,
    });
    setDeadline(s, 0, null);
    s.log = "New game! Waiting for the host to start.";
  },
};

// ---------------------------------------------------------------------------------------------
// Deadlines

export function onDeadline(s, now) {
  const events = [];
  if (!s.deadline || now < s.deadline) return { events };
  const id = s.currentId;
  switch (s.phase) {
    case "roundIntro":
      beginTurn(s, id, now, events);
      s.log = `${nameOf(s, id)}, spin, buy a vowel or solve.`;
      break;
    case "turn":
    case "pickConsonant":
      events.push({ e: "timeout", playerId: id, kind: s.deadlineKind });
      s.log = `Time's up, ${nameOf(s, id)}!`;
      passTurn(s, now, events);
      break;
    case "spinning": {
      const index = s.pendingSpin?.index ?? 0;
      s.wheelIndex = index;
      s.pendingSpin = null;
      const w = WEDGES[index];
      const p = player(s, id);
      if (w.k === "cash") {
        s.phase = "pickConsonant";
        s.wedgeValue = w.v;
        setDeadline(s, now, T.pick, "pick");
        s.log = `${p.name} landed on ${fmt(w.v)} — pick a consonant.`;
      } else if (w.k === "bankrupt") {
        const lost = p.roundMoney;
        p.roundMoney = 0;
        s.log = `BANKRUPT! ${p.name} loses ${fmt(lost)}.`;
        events.push({ e: "bankrupt", playerId: id, lost });
        passTurn(s, now, events);
      } else {
        s.log = `Lose a turn, ${p.name}.`;
        events.push({ e: "loseTurn", playerId: id });
        passTurn(s, now, events);
      }
      break;
    }
    case "revealing":
      if (boardComplete(s)) endRoundWon(s, id, now, events, "completed the puzzle");
      else beginTurn(s, id, now, events, false);
      break;
    case "solving":
      events.push({ e: "timeout", playerId: id, kind: "solve" });
      judgeMainSolve(s, s.solve?.text || "", now, events);
      break;
    case "roundEnd":
      advanceFromRoundEnd(s, now, events);
      break;
    case "bonusIntro":
      startBonusPick(s, now, events);
      break;
    case "bonusPick": {
      // Auto-pick for an absent/slow player.
      events.push({ e: "timeout", playerId: id, kind: "pick" });
      const pool = CONSONANTS.filter((c) => !BONUS_GIVEN.includes(c));
      const cons = [];
      while (cons.length < 3) {
        const c = pool.splice(randInt(s, pool.length), 1)[0];
        cons.push(c);
      }
      const vs = ["A", "I", "O", "U"];
      applyBonusPick(s, cons, vs[randInt(s, vs.length)], now, events);
      break;
    }
    case "bonusReveal":
      s.phase = "bonusSolve";
      s.solve = { playerId: s.bonus.playerId, text: "", source: "typed", final: false };
      setDeadline(s, now, T.bonusSolve, "bonusSolve");
      s.log = `${nameOf(s, s.bonus.playerId)}, you have 15 seconds to solve!`;
      break;
    case "bonusSolve": {
      events.push({ e: "timeout", playerId: id, kind: "bonusSolve" });
      const text = s.solve?.text || "";
      endBonus(s, !!text && judge(text, s.puzzle.answer).ok, now, events);
      break;
    }
    case "bonusEnd":
      gameOver(s);
      break;
    default:
      setDeadline(s, now, null);
  }
  s.lastActive = now;
  return { events };
}

// ---------------------------------------------------------------------------------------------
// Connections (called by the Durable Object with the set of playerIds that have a live socket)

export function setConnected(s, liveIds) {
  let changed = false;
  for (const p of s.players) {
    const c = liveIds.has(p.id);
    if (p.connected !== c) { p.connected = c; changed = true; }
  }
  const before = s.hostId;
  fixHost(s);
  return changed || before !== s.hostId;
}

// ---------------------------------------------------------------------------------------------
// Snapshot (safe to broadcast: hides unrevealed letters until the round is over)

const OVER = new Set(["roundEnd", "bonusEnd", "gameOver"]);

export function snapshot(s, now, opts = {}) {
  const over = OVER.has(s.phase) && !!s.puzzle;
  const used = new Set(s.used);
  const rows = s.puzzle ? layout(s.puzzle.answer).rows : [12, 14, 14, 12].map((w) => " ".repeat(w));
  const board = rows.map((row) => [...row].map((ch) => {
    if (ch === " ") return null;
    if (PUNCTUATION.has(ch)) return { k: "punct", ch };
    if (over || used.has(ch)) return { k: "letter", ch };
    return { k: "blank" };
  }));
  const rem = s.puzzle ? remaining(s) : { vowels: 0, consonants: 0 };
  const snap = {
    room: s.room,
    serverNow: now,
    phase: s.phase,
    hostId: s.hostId,
    colors: COLORS,
    customCount: s.custom.length,
    players: s.players.map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, roundMoney: p.roundMoney, total: p.total })),
    round: s.round,
    totalRounds: TOTAL_ROUNDS,
    category: s.puzzle?.category ?? null,
    board,
    used: [...s.used],
    vowelsLeft: rem.vowels > 0,
    consonantsLeft: rem.consonants > 0,
    vowelsOnly: !!s.puzzle && rem.consonants === 0 && rem.vowels > 0,
    currentId: s.currentId,
    deadline: s.deadline,
    deadlineKind: s.deadlineKind,
    wheel: { wedges: WEDGES, index: s.wheelIndex },
    wedgeValue: s.wedgeValue,
    solve: s.solve ? { ...s.solve } : null,
    bonus: s.bonus ? { playerId: s.bonus.playerId, given: s.bonus.given, picks: s.bonus.picks, prize: s.bonus.prize, ...(s.phase === "bonusEnd" || s.phase === "gameOver" ? { won: !!s.bonus.won } : {}) } : null,
    log: s.log,
    winners: s.phase === "gameOver" ? s.winners : null,
  };
  if (over) snap.answer = s.puzzle.answer;
  if (opts.debugAnswer && s.puzzle) snap.debugAnswer = s.puzzle.answer;
  return snap;
}
