#!/usr/bin/env node
// End-to-end smoke test against a running dev server.
//
//   npx wrangler dev --port 8787 --var DEBUG_ANSWERS:1     (or put DEBUG_ANSWERS=1 in .dev.vars)
//   node scripts/smoke.mjs [http://127.0.0.1:8787]
//
// DEBUG_ANSWERS=1 makes the TV snapshot include `debugAnswer` so this script can play a round.
// Never set it in wrangler.jsonc / production.

const BASE = process.argv[2] || process.env.BASE || "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
const VOWELS = new Set(["A", "E", "I", "O", "U"]);

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);
function assert(cond, msg) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}

class Client {
  constructor(name, room) {
    this.name = name;
    this.room = room;
    this.msgs = [];
    this.waiters = [];
    this.state = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}/ws/${this.room}`);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = (e) => reject(new Error(`${this.name}: socket error ${e.message || ""}`));
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.t === "state") this.state = msg.s;
        this.msgs.push(msg);
        for (const w of [...this.waiters]) if (w.test(msg)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
      };
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  // Wait for a future (or already-received, if `since` given) message matching pred.
  waitFor(pred, what, timeout = 8000, since = this.msgs.length) {
    const hit = this.msgs.slice(since).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test: pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`${this.name}: timed out waiting for ${what}`)); }
      }, timeout);
    });
  }
  // Without `since`: resolve on the current state if it matches. With `since` (a msgs index):
  // only states received after that point count (avoids racing a stale snapshot).
  waitState(pred, what, timeout, since) {
    if (since === undefined && this.state && pred(this.state)) return Promise.resolve(this.state);
    return this.waitFor((m) => m.t === "state" && pred(m.s), what, timeout, since ?? this.msgs.length).then((m) => m.s);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  console.log(`Smoke test against ${BASE}`);

  const res = await fetch(`${BASE}/api/rooms`, { method: "POST" });
  assert(res.ok, `POST /api/rooms -> ${res.status}`);
  const { code } = await res.json();
  assert(/^[A-HJ-NP-Z]{4}$/.test(code), `room code ${code}`);
  ok(`created room ${code}`);

  for (const page of ["/tv", "/play"]) {
    const r = await fetch(`${BASE}${page}?room=${code}`, { redirect: "manual" });
    console.log(`    ${page} -> HTTP ${r.status}${r.status === 404 ? " (page not built yet?)" : ""}`);
  }
  const bad = await fetch(`${BASE}/ws/AB1`);
  assert(bad.status === 400, `bad room code rejected (${bad.status})`);
  ok("routes respond");

  const tv = await new Client("tv", code.toLowerCase()).open();
  tv.send({ t: "hello", role: "tv" });
  await tv.waitFor((m) => m.t === "welcome" && m.role === "tv", "tv welcome");
  const s0 = await tv.waitState((s) => s.phase === "lobby", "lobby state");
  assert(s0.room === code && Array.isArray(s0.colors) && s0.colors.length === 8, "lobby snapshot");
  ok("TV connected (lower-case code accepted)");

  const names = ["Maya", "Omar", "Lin"];
  const players = [];
  for (let i = 0; i < 3; i++) {
    const c = await new Client(names[i], code).open();
    c.send({ t: "hello", role: "player" });
    const w = await c.waitFor((m) => m.t === "welcome", "player welcome");
    assert(!w.playerId, "new player has no id yet");
    c.send({ t: "join", name: names[i], color: s0.colors[i] });
    const j = await c.waitFor((m) => m.t === "welcome" && m.playerId, "join welcome");
    c.id = j.playerId;
    players.push(c);
  }
  await tv.waitState((s) => s.players.length === 3 && s.players.every((p) => p.connected), "3 players");
  ok("3 players joined");

  const dup = players[0];
  const pick = await new Client("dup", code).open();
  pick.send({ t: "hello", role: "player" });
  await pick.waitFor((m) => m.t === "welcome", "welcome");
  pick.send({ t: "join", name: "Copycat", color: s0.colors[0] });
  const e = await pick.waitFor((m) => m.t === "error", "colour error");
  assert(e.code === "color_taken", `colour taken error, got ${e.code}`);
  pick.close();
  ok("duplicate colour rejected");

  // Reconnect player 2 with the same playerId.
  const omar = players[1];
  omar.close();
  await tv.waitState((s) => s.players.find((p) => p.id === omar.id)?.connected === false, "omar disconnected");
  const omar2 = await new Client("Omar#2", code).open();
  omar2.id = omar.id;
  omar2.send({ t: "hello", role: "player", playerId: omar.id });
  const rw = await omar2.waitFor((m) => m.t === "welcome", "reconnect welcome");
  assert(rw.playerId === omar.id, "reconnect keeps playerId");
  players[1] = omar2;
  await tv.waitState((s) => s.players.find((p) => p.id === omar.id)?.connected === true, "omar reconnected");
  ok("player reconnected with same playerId");

  const ghost = await new Client("ghost", code).open();
  ghost.send({ t: "hello", role: "player", playerId: "pnotarealid" });
  const gw = await ghost.waitFor((m) => m.t === "welcome", "unknown id welcome");
  assert(!gw.playerId, "unknown id gets welcome without playerId");
  ok("unknown playerId -> join form");

  // Non-host can't start; host can.
  players[1].send({ t: "start" });
  assert((await players[1].waitFor((m) => m.t === "error", "start error")).code === "not_allowed", "non-host start rejected");
  players[0].send({ t: "start" });
  let s = await tv.waitState((s) => s.phase === "roundIntro", "roundIntro");
  assert(s.answer === undefined && s.debugAnswer, "answer hidden, debugAnswer on TV");
  const phoneState = players[2].state;
  assert(phoneState.debugAnswer === undefined, "phones never get debugAnswer");
  ghost.send({ t: "join", name: "Late", color: s0.colors[5] });
  assert((await ghost.waitFor((m) => m.t === "error", "late join")).code === "in_progress", "late join -> in_progress");
  ghost.close();
  ok(`game started: round 1, category "${s.category}" (answer ${s.debugAnswer})`);

  s = await tv.waitState((s) => s.phase === "turn", "first turn", 8000);
  const answer = s.debugAnswer;
  const letters = new Set(answer.replace(/[^A-Z]/g, ""));
  const byId = (id) => players.find((p) => p.id === id);
  ok(`turn: ${s.players.find((p) => p.id === s.currentId).name}`);

  // Spin until someone lands on cash and calls a correct consonant.
  let guessed = false;
  for (let tries = 0; tries < 12 && !guessed; tries++) {
    s = await tv.waitState((s) => s.phase === "turn", "turn");
    const cur = byId(s.currentId);
    const before = tv.msgs.length;
    cur.send({ t: "spin" });
    const spin = await tv.waitFor((m) => m.t === "ev" && m.e === "spin", "spin event", 5000, before);
    assert(spin.index >= 0 && spin.index < 24 && spin.turns >= 3 && spin.duration > 0, "spin event shape");
    const wedge = s.wheel.wedges[spin.index];
    await tv.waitState((s) => s.phase === "spinning", "spinning", 5000, before);
    const sp = tv.msgs.length;
    s = await tv.waitState((s) => s.phase !== "spinning", "spin to finish", 9000, sp);
    console.log(`    ${cur.name} spun ${wedge.k === "cash" ? "$" + wedge.v : wedge.k.toUpperCase()}`);
    if (s.phase !== "pickConsonant") continue;
    const consonant = [...letters].find((c) => !VOWELS.has(c) && !s.used.includes(c));
    const b2 = tv.msgs.length;
    cur.send({ t: "guess", letter: consonant });
    const rev = await tv.waitFor((m) => m.t === "ev" && (m.e === "reveal" || m.e === "miss"), "reveal", 5000, b2);
    assert(rev.e === "reveal" && rev.letter === consonant && rev.count > 0, "consonant revealed");
    assert(rev.earned === wedge.v * rev.count, "earned = value x count");
    await tv.waitState((s) => s.phase === "revealing", "revealing", 5000, b2);
    s = await tv.waitState((s) => s.phase !== "revealing", "reveal to finish", 8000, tv.msgs.length);
    guessed = true;
    ok(`${cur.name} called ${consonant}: ${rev.count} on the board, +$${rev.earned}`);
  }
  assert(guessed, "landed on cash within 12 spins");

  if (s.phase === "turn") {
    const cur = byId(s.currentId);
    const me = s.players.find((p) => p.id === cur.id);
    const vowel = [...letters].find((c) => VOWELS.has(c) && !s.used.includes(c));
    if (me.roundMoney >= 250 && vowel) {
      const b = tv.msgs.length;
      cur.send({ t: "buyVowel", letter: vowel });
      const rev = await tv.waitFor((m) => m.t === "ev" && m.e === "reveal", "vowel reveal", 5000, b);
      await tv.waitState((s) => s.phase === "revealing", "revealing", 5000, b);
      s = await tv.waitState((s) => s.phase !== "revealing", "vowel reveal to finish", 8000, tv.msgs.length);
      const after = s.players.find((p) => p.id === cur.id).roundMoney;
      assert(after === me.roundMoney - 250 || s.phase === "roundEnd", "vowel cost 250");
      ok(`${cur.name} bought ${vowel} (${rev.count})`);
    } else {
      console.log("    (skipped vowel purchase: not enough money or no vowels)");
    }
  }

  if (s.phase === "turn") {
    const cur = byId(s.currentId);
    cur.send({ t: "solveStart" });
    await tv.waitState((s) => s.phase === "solving", "solving");
    cur.send({ t: "solveDraft", text: answer.slice(0, 5).toLowerCase(), source: "voice" });
    await tv.waitState((s) => s.solve?.text === answer.slice(0, 5).toLowerCase(), "draft visible on TV");
    const b = tv.msgs.length;
    cur.send({ t: "solveSubmit", text: answer.toLowerCase().replace(/'/g, "") });
    const right = await tv.waitFor((m) => m.t === "ev" && m.e === "solveRight", "solveRight", 5000, b);
    assert(right.banked >= 1000, "banked at least $1000");
    ok(`${cur.name} solved and banked $${right.banked}`);
  }
  s = await tv.waitState((s) => s.phase === "roundEnd", "roundEnd");
  assert(s.answer === answer, "answer revealed at round end");
  assert(players[0].state.answer === answer, "phones get answer at round end");
  ok("round over, answer revealed");

  tv.send({ t: "next" });
  s = await tv.waitState((s) => s.phase === "roundIntro" && s.round === 2, "round 2 intro");
  assert(s.debugAnswer !== answer, "new puzzle for round 2");
  ok("TV skipped to round 2");

  for (const c of [tv, ...players]) c.close();
  console.log("\nSMOKE TEST PASSED");
}

main().then(() => process.exit(0), (err) => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});
