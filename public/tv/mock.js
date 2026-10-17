// Mock server for developing the TV screen without the Worker.
//   /tv/?mock=1                 full scripted demo (click START in the lobby, or add &auto=1)
//   /tv/?mock=1&scene=spin      fast-forward silently to a scene, then play from there
// scenes: lobby, intro, game, spin, reveal, vowel, bankrupt, miss, lose, solving, solveWrong, roundEnd,
//         bonus, bonusPick, bonusReveal, bonusSolve, bonusEnd, gameOver
// Also exposes window.__mock = { state, scene(name) } for poking from the console.

const ROW_WIDTHS = [12, 14, 14, 12];
const PLACEMENTS = { 1: [[1], [2]], 2: [[1, 2]], 3: [[0, 1, 2], [1, 2, 3]], 4: [[0, 1, 2, 3]] };
const PUNCT = new Set(["&", "'", "-", "?", "!"]);

function wrap(words, widths) {
  const lines = [];
  let i = 0;
  for (const w of widths) {
    if (i >= words.length) break;
    if (words[i].length > w) return null;
    let line = words[i++];
    while (i < words.length && line.length + 1 + words[i].length <= w) line += " " + words[i++];
    lines.push(line);
  }
  return i >= words.length ? lines : null;
}
function layoutRows(answer) {
  const words = answer.split(" ");
  for (let n = 1; n <= 4; n++) for (const used of PLACEMENTS[n]) {
    const lines = wrap(words, used.map((r) => ROW_WIDTHS[r]));
    if (!lines || lines.length !== n) continue;
    const rows = ROW_WIDTHS.map((w) => " ".repeat(w));
    used.forEach((r, k) => { const w = ROW_WIDTHS[r]; const pad = Math.floor((w - lines[k].length) / 2); rows[r] = (" ".repeat(pad) + lines[k]).padEnd(w, " "); });
    return rows;
  }
  throw new Error("doesn't fit: " + answer);
}

const WEDGES = [
  { k: "cash", v: 2500 }, { k: "cash", v: 600 }, { k: "cash", v: 700 }, { k: "cash", v: 600 }, { k: "cash", v: 650 },
  { k: "cash", v: 500 }, { k: "cash", v: 700 }, { k: "bankrupt" }, { k: "cash", v: 600 }, { k: "cash", v: 550 },
  { k: "cash", v: 500 }, { k: "cash", v: 600 }, { k: "lose" }, { k: "cash", v: 650 }, { k: "cash", v: 800 },
  { k: "cash", v: 700 }, { k: "cash", v: 900 }, { k: "cash", v: 300 }, { k: "bankrupt" }, { k: "cash", v: 500 },
  { k: "cash", v: 850 }, { k: "cash", v: 400 }, { k: "cash", v: 750 }, { k: "cash", v: 350 },
];
const COLORS = ["#ff6b5e", "#ffc847", "#2fd6c3", "#9b7bff", "#ff8fc7", "#56b7ff", "#9be15d", "#ff9f43"];
const SCENES = ["lobby", "intro", "game", "spin", "reveal", "vowel", "bankrupt", "miss", "lose", "solving", "solveWrong", "roundEnd",
  "bonus", "bonusPick", "bonusReveal", "bonusSolve", "bonusEnd", "gameOver"];

export function createMock(h) {
  const params = new URLSearchParams(location.search);
  const target = params.get("scene");
  const auto = params.has("auto") || (!!target && target !== "lobby");
  let fast = !!target && target !== "lobby";
  let answer = "";
  let resolveWait = null;
  let runId = 0;

  const st = {};
  function reset() {
    Object.assign(st, {
      room: "MOCK", phase: "lobby", hostId: "p1", colors: COLORS, customCount: 0,
      players: [], round: 1, totalRounds: 4, category: "", board: ROW_WIDTHS.map((w) => Array(w).fill(null)),
      used: [], vowelsLeft: true, consonantsLeft: true, vowelsOnly: false,
      currentId: null, deadline: null, deadlineKind: null,
      wheel: { wedges: WEDGES, index: 0 }, wedgeValue: null, solve: null, bonus: null, answer: undefined,
      log: "", winners: undefined,
    });
  }
  reset();

  const clone = () => JSON.parse(JSON.stringify({ ...st, serverNow: Date.now() }));
  const push = () => { if (!fast) h.onState(clone()); };
  const emit = (e, d = {}) => { if (!fast) h.onEvent({ t: "ev", e, ...d }); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = (ms) => (fast ? Promise.resolve() : sleep(ms));
  const P = (id) => st.players.find((p) => p.id === id);
  function mark(name) {
    if (fast && name === target) { fast = false; push(); }
  }
  const deadline = (kind, ms) => { st.deadlineKind = kind; st.deadline = kind ? Date.now() + ms : null; };

  function setPuzzle(category, ans) {
    answer = ans;
    st.category = category;
    st.board = layoutRows(ans).map((row) => [...row].map((ch) => (ch === " " ? null : PUNCT.has(ch) ? { k: "punct", ch } : { k: "blank" })));
    st.used = [];
  }
  function reveal(letter) {
    const rows = layoutRows(answer);
    const cells = [];
    rows.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === letter) { cells.push([r, c]); st.board[r][c] = { k: "letter", ch }; } }));
    st.used.push(letter);
    return cells;
  }
  function revealAll() {
    layoutRows(answer).forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== " " && !PUNCT.has(ch)) st.board[r][c] = { k: "letter", ch }; }));
  }
  const nextPlayer = () => { const i = st.players.findIndex((p) => p.id === st.currentId); st.currentId = st.players[(i + 1) % st.players.length].id; };

  async function turn(id) {
    st.currentId = id; st.phase = "turn"; st.solve = null; st.wedgeValue = null;
    deadline("turn", 20000);
    push(); emit("turn", { playerId: id });
    await wait(2400);
  }
  async function spin(index) {
    st.phase = "spinning"; deadline("spin", 5600); st.wheel.index = index;
    st.log = `${P(st.currentId).name} spins…`;
    push(); emit("spin", { index, turns: 3, duration: 5200, spinId: Math.random() });
    await wait(5400);
  }
  async function guess(letter, value) {
    const cells = reveal(letter);
    const p = P(st.currentId);
    const earned = value * cells.length;
    if (!cells.length) {
      st.log = `${p.name} called ${letter} — not there.`;
      st.phase = "turn"; push(); emit("miss", { letter, reason: "absent" });
      await wait(1800);
      return false;
    }
    p.roundMoney += earned;
    st.phase = "revealing"; deadline("reveal", cells.length * 700 + 600);
    st.log = `${p.name} called ${letter} — ${cells.length} of them! +$${earned}`;
    push(); emit("reveal", { letter, count: cells.length, cells, value, earned });
    await wait(cells.length * 700 + 900);
    return true;
  }
  async function buyVowel(letter) {
    const p = P(st.currentId);
    p.roundMoney -= 250;
    const cells = reveal(letter);
    st.phase = "revealing"; deadline("reveal", cells.length * 700 + 600);
    st.log = `${p.name} bought an ${letter} — ${cells.length} of them!`;
    push(); emit("reveal", { letter, count: cells.length, cells, value: 0, earned: 0 });
    await wait(cells.length * 700 + 900);
  }
  async function streamSolve(text, kind = "solving") {
    const words = text.split(" ");
    for (let i = 1; i <= words.length; i++) {
      st.solve = { playerId: st.currentId, text: words.slice(0, i).join(" ").toLowerCase(), source: "voice", final: false };
      push();
      await wait(450);
    }
    st.solve = { playerId: st.currentId, text, source: "voice", final: true };
    push();
    await wait(1600);
  }
  const waitForSignal = (ms) => new Promise((r) => {
    if (fast) return r();
    resolveWait = r;
    if (ms) setTimeout(r, ms);
  });

  async function run() {
    const my = ++runId;
    const alive = () => my === runId;
    reset();
    mark("lobby");
    push();
    const people = [["p1", "Maya", COLORS[0]], ["p2", "Leo", COLORS[2]], ["p3", "Ana", COLORS[3]], ["p4", "Sam", COLORS[5]]];
    for (const [id, name, color] of people) {
      await wait(700);
      st.players.push({ id, name, color, connected: id !== "p4", roundMoney: 0, total: 0 });
      push();
    }
    await waitForSignal(auto ? 1500 : 0);
    if (!alive()) return;

    // ---- round 1 ----
    setPuzzle("Phrase", "A PENNY FOR YOUR THOUGHTS");
    st.phase = "roundIntro"; st.round = 1; deadline("intro", 3000); st.log = "Round 1 — Phrase";
    mark("intro");
    push(); emit("roundStart", { round: 1 });
    await wait(3000);
    await turn("p1"); mark("game"); push();
    if (!alive()) return;
    mark("spin");
    await spin(2);                       // $700
    st.phase = "pickConsonant"; st.wedgeValue = 700; deadline("pick", 20000);
    st.log = "Maya landed on $700 — pick a consonant"; push();
    await wait(1500);
    mark("reveal");
    await guess("T", 700);
    st.phase = "turn"; deadline("turn", 20000); push();
    await wait(1200);
    mark("vowel");
    await buyVowel("O");
    st.phase = "turn"; deadline("turn", 20000); push();
    await wait(1200);
    if (!alive()) return;
    mark("bankrupt");
    await spin(7);                       // BANKRUPT
    const lost = P("p1").roundMoney;
    P("p1").roundMoney = 0; st.log = "Maya hit BANKRUPT!";
    push(); emit("bankrupt", { playerId: "p1", lost });
    await wait(2800);
    await turn("p2");
    mark("miss");
    await spin(16);                      // $900
    st.phase = "pickConsonant"; st.wedgeValue = 900; deadline("pick", 20000); push();
    await wait(1200);
    await guess("Z", 900);
    await turn("p3");
    if (!alive()) return;
    await spin(14);
    st.phase = "pickConsonant"; st.wedgeValue = 800; deadline("pick", 20000); push();
    await wait(1000);
    await guess("H", 800);
    await guess("N", 800);
    await guess("R", 800);
    st.phase = "turn"; deadline("turn", 20000); push();
    await wait(800);
    mark("lose");
    await spin(12);                      // LOSE A TURN
    st.log = "Ana loses a turn"; push(); emit("loseTurn", { playerId: "p3" });
    await wait(2300);
    await turn("p4");
    if (!alive()) return;
    mark("solveWrong");
    st.phase = "solving"; deadline("solve", 30000); st.solve = { playerId: "p4", text: "", source: "voice", final: false }; push();
    await wait(800);
    await streamSolve("A PENNY FOR YOUR THINKING");
    st.log = "Sam: not quite!"; st.solve = null; push();
    emit("solveWrong", { playerId: "p4", text: "A PENNY FOR YOUR THINKING" });
    await wait(2800);
    await turn("p1");
    if (!alive()) return;
    mark("solving");
    st.phase = "solving"; deadline("solve", 30000); st.solve = { playerId: "p1", text: "", source: "voice", final: false }; push();
    await wait(1200);
    await streamSolve("A PENNY FOR YOUR THOUGHTS");
    mark("roundEnd");
    revealAll();
    const p1 = P("p1");
    const banked = Math.max(p1.roundMoney, 1000);
    p1.total += banked;
    st.players.forEach((p) => { p.roundMoney = 0; });
    P("p3").total += 4300; P("p2").total += 1800;
    st.solve = null; st.phase = "roundEnd"; st.answer = answer; deadline("roundEnd", 8000);
    st.log = `Maya solved it and banks $${banked}!`;
    push(); emit("solveRight", { playerId: "p1", banked });
    await waitForSignal(8000);
    if (!alive()) return;

    // ---- (rounds 2–4 skipped in mock) bonus ----
    st.answer = undefined; st.round = "bonus";
    setPuzzle("Thing", "HOT AIR BALLOON");
    st.currentId = "p3";
    st.bonus = { playerId: "p3", given: ["R", "S", "T", "L", "N", "E"], picks: [], prize: 25000 };
    st.phase = "bonusIntro"; deadline("intro", 3000); st.log = "Bonus round for Ana!";
    mark("bonus");
    push(); emit("roundStart", { round: "bonus" });
    await wait(3000);
    mark("bonusPick");
    st.phase = "bonusPick"; deadline("pick", 20000); st.log = "Ana is choosing letters"; push();
    await wait(2500);
    mark("bonusReveal");
    st.phase = "bonusReveal"; deadline(null);
    for (const ch of ["R", "S", "T", "L", "N", "E"]) reveal(ch);
    push();
    await wait(2200);
    st.bonus.picks = ["B", "D", "M", "O"];
    for (const ch of st.bonus.picks) reveal(ch);
    push();
    await wait(3000);
    mark("bonusSolve");
    st.phase = "bonusSolve"; deadline("bonusSolve", 15000); st.solve = { playerId: "p3", text: "", source: "voice", final: false }; push();
    await wait(3500);
    await streamSolve("HOT AIR BALLOON", "bonus");
    mark("bonusEnd");
    revealAll();
    st.phase = "bonusEnd"; st.answer = answer; deadline("roundEnd", 8000);
    P("p3").total += 25000; st.bonus.won = true;
    push(); emit("bonusResult", { won: true, prize: 25000 });
    await waitForSignal(8000);
    if (!alive()) return;
    mark("gameOver");
    st.phase = "gameOver"; deadline(null); st.solve = null;
    st.winners = [...st.players].sort((a, b) => b.total - a.total).map((p) => ({ id: p.id, total: p.total }));
    push();
  }

  h.onStatus?.("open");
  h.onWelcome?.({ role: "tv", room: "MOCK" });
  setTimeout(run, 50);

  const api = {
    send(msg) {
      console.log("[mock] →", msg);
      switch (msg.t) {
        case "start": case "next": resolveWait?.(); resolveWait = null; break;
        case "kick": st.players = st.players.filter((p) => p.id !== msg.playerId); push(); break;
        case "playAgain": fast = false; run(); break;
        case "customPack": {
          const lines = String(msg.text || "").split("\n");
          const errors = [];
          let added = 0;
          lines.forEach((l, i) => {
            if (!l.trim()) return;
            const m = l.split("|");
            if (m.length !== 2 || !m[0].trim() || !m[1].trim()) errors.push({ line: i + 1, msg: "expected Category | ANSWER" });
            else if (!/^[A-Za-z&'\-?! ]+$/.test(m[1].trim())) errors.push({ line: i + 1, msg: "only letters, spaces and & ' - ? !" });
            else added++;
          });
          st.customCount = added; push();
          h.onMessage?.({ t: "packResult", added, errors });
          break;
        }
      }
    },
    now: () => Date.now(),
    close() {},
    forget() {},
  };
  window.__mock = { get state() { return st; }, scenes: SCENES, scene(name) { location.search = `?mock=1&scene=${name}`; } };
  return api;
}
