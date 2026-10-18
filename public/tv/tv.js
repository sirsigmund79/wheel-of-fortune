// Spin & Solve — TV host screen.
// Renders the latest snapshot from the Room DO and plays transient events (spin, reveal, bankrupt…).
// Dev without a server: /tv/?mock=1  (see /tv/mock.js)

import { connect } from "/shared/net.js";
import * as sfx from "/shared/sound.js";
import qrcode from "/vendor/qrcode.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.has("mock");
const ROW_WIDTHS = [12, 14, 14, 12];
const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const DEADLINE_TOTALS = { turn: 20000, pick: 20000, solve: 30000, bonusSolve: 15000, roundEnd: 8000, intro: 3000 };
const SHOW_TIMER_KINDS = new Set(["turn", "pick"]);
const BONUS_PHASES = new Set(["bonusIntro", "bonusPick", "bonusReveal", "bonusSolve", "bonusEnd"]);

let net = null;
let S = null;           // latest snapshot
let roomCode = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const player = (id) => S?.players?.find((p) => p.id === id);
const pname = (id) => player(id)?.name ?? "Someone";
const whoSpan = (id) => { const p = player(id); return `<span class="who" style="--pc:${esc(p?.color || "var(--gold)")}">${esc(p?.name ?? "Someone")}</span>`; };

/* ================= stage scaling ================= */
const stage = $("stage");
function fit() {
  const k = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${k})`;
}
addEventListener("resize", fit);
fit();

/* ================= sound gate / mute ================= */
const gate = $("soundGate");
function openGate() {
  sfx.unlock().then((ok) => { if (ok) gate.classList.remove("on"); });
  gate.classList.remove("on");
}
gate.classList.add("on");
gate.addEventListener("click", openGate);
addEventListener("keydown", (e) => {
  if (gate.classList.contains("on")) openGate();
  if (e.key === "m" || e.key === "M") { if (e.target.tagName !== "TEXTAREA") toggleMute(); }
});
function toggleMute() { sfx.setMuted(!sfx.isMuted()); $("muteBtn").classList.toggle("muted", sfx.isMuted()); }
$("muteBtn").addEventListener("click", toggleMute);

/* ================= boot / network ================= */
async function boot() {
  const handlers = { role: "tv", onState, onEvent, onMessage, onStatus, onError: (m) => {
    // A stale ?room= (expired/wiped) — start a fresh room instead of sitting on a dead code.
    if (m.code === "no_room") { net?.close(); location.replace(location.pathname); return; }
    console.warn("server error", m);
  } };
  if (MOCK) {
    const { createMock } = await import("/tv/mock.js");
    net = createMock(handlers);
    return;
  }
  let code = (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "");
  while (!code) {
    try {
      const r = await fetch("/api/rooms", { method: "POST" });
      code = (await r.json()).code;
    } catch (e) {
      console.warn("could not create room, retrying", e);
      $("roomCode").textContent = "…";
      await sleep(2000);
    }
  }
  history.replaceState(null, "", `${location.pathname}?room=${code}`);
  setRoom(code);
  net = connect(code, handlers);
}

function setRoom(code) {
  if (code === roomCode) return;
  roomCode = code;
  $("roomCode").textContent = code;
  const url = `${location.origin}/play?room=${code}`;
  $("joinUrl").textContent = url.replace(/^https?:\/\//, "");
  try {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  } catch (e) { console.warn("qr failed", e); }
}

function onStatus(st) { $("conn").className = "conn " + st; }

function onMessage(msg) {
  if (msg.t === "packResult") renderPackResult(msg);
}

/* ================= snapshot handling ================= */
let lastPhase = null;
function onState(s) {
  const prev = S;
  S = s;
  if (s.room) setRoom(s.room);

  const scr = s.phase === "lobby" ? "lobby" : s.phase === "gameOver" ? "gameover" : "game";
  for (const id of ["lobby", "game", "gameover"]) $(id).classList.toggle("on", id === scr);

  if (scr === "lobby") { renderLobby(s, prev); boardKey = ""; lastSolve = null; bonusResult = null; goKey = ""; }
  else if (scr === "gameover") renderGameOver(s, prev);
  if (scr !== "lobby") renderGame(s, prev);

  lastPhase = s.phase;
}

/* ================= LOBBY ================= */
let lastChipKey = "";
function renderLobby(s, prev) {
  const ps = s.players || [];
  $("playerCount").textContent = `${ps.length} / 6`;
  const key = JSON.stringify(ps.map((p) => [p.id, p.name, p.color, p.connected])) + s.hostId;
  if (key !== lastChipKey) {
    const prevIds = new Set((prev?.players || []).map((p) => p.id));
    if (ps.some((p) => !prevIds.has(p.id)) && prev) sfx.pop();
    lastChipKey = key;
    const box = $("playerChips");
    box.innerHTML = ps.length ? "" : `<div class="empty-chips">Scan the code to join!</div>`;
    for (const p of ps) {
      const el = document.createElement("div");
      el.className = "chip" + (p.connected ? "" : " off");
      el.style.setProperty("--pc", p.color);
      el.innerHTML = `<div class="dot">${esc((p.name || "?")[0].toUpperCase())}</div>
        <div class="nm">${esc(p.name)}</div>
        ${p.id === s.hostId ? `<div class="crown" title="Host">♛</div>` : ""}
        <button class="kick" title="Remove ${esc(p.name)}">✕</button>`;
      el.querySelector(".kick").addEventListener("click", () => net.send({ t: "kick", playerId: p.id }));
      box.appendChild(el);
    }
  }
  const ok = ps.length >= 1 && ps.length <= 6;
  $("startBtn").disabled = !ok;
  $("startHint").textContent = ok ? (ps.length === 1 ? "Solo game: 7 spins per puzzle." : "Everyone in? Press start — or the host can start from their phone.") : ps.length > 6 ? "Too many players (max 6)" : `Waiting for players…`;
  $("customCount").textContent = s.customCount ? `${s.customCount} loaded` : "";
  for (const b of $("sourcePick").children) b.setAttribute("aria-checked", String(b.dataset.src === (s.puzzleSource || "show")));
}
$("sourcePick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-src]");
  if (b) net?.send({ t: "puzzleSource", source: b.dataset.src });
});
$("startBtn").addEventListener("click", () => { sfx.unlock(); net?.send({ t: "start" }); });
$("packBtn").addEventListener("click", () => {
  $("packResult").innerHTML = "Loading…";
  net?.send({ t: "customPack", text: $("packText").value });
});
function renderPackResult(m) {
  const errs = m.errors || [];
  $("packResult").innerHTML =
    `<div class="${m.added ? "ok" : "err"}">${m.added} puzzle${m.added === 1 ? "" : "s"} added</div>` +
    errs.map((e) => `<div class="err">Line ${esc(e.line)}: ${esc(e.msg)}</div>`).join("");
  if (m.added && !errs.length) setTimeout(() => { $("packBox").open = false; }, 1500);
}

/* ================= GAME ================= */
function renderGame(s, prev) {
  const bonus = s.round === "bonus" || BONUS_PHASES.has(s.phase);
  const ri = $("roundInd");
  ri.classList.toggle("bonus", bonus);
  ri.innerHTML = bonus ? "Bonus Round" : `Round ${esc(s.round)} <span>of ${esc(s.totalRounds ?? 4)}</span>`;

  if (s.log !== prev?.log) {
    const ll = $("logLine");
    ll.textContent = s.log || "";
    ll.classList.remove("fresh"); void ll.offsetWidth; ll.classList.add("fresh");
  }

  $("category").textContent = s.category || "";
  const spinsEl = $("spinsLeft");
  const showSpins = !!s.solo && !bonus && ["turn", "pickConsonant", "revealing", "spinning", "solving"].includes(s.phase);
  spinsEl.classList.toggle("on", showSpins);
  spinsEl.classList.toggle("low", showSpins && s.spinsLeft <= 2);
  if (showSpins) spinsEl.textContent = s.spinsLeft > 0 ? `${s.spinsLeft} spin${s.spinsLeft === 1 ? "" : "s"} left` : "Last chance — solve it!";
  $("vowelsOnly").classList.toggle("on", !!s.vowelsOnly && !bonus && ["turn", "pickConsonant", "revealing", "spinning"].includes(s.phase));
  renderUsed(s, prev);
  renderBoard(s, prev);
  renderScores(s, prev);
  renderWheel(s);

  // left column mode
  const lc = $("leftCol");
  const mode = bonus ? "mode-bonus" : s.solve || s.phase === "solving" ? "mode-solve" : "mode-wheel";
  lc.className = "left-col " + mode;
  if (mode === "mode-solve") renderSolve(s);
  if (mode === "mode-bonus") renderBonus(s);

  // phase overlays
  $("roundIntro").classList.toggle("on", s.phase === "roundIntro");
  if (s.phase === "roundIntro") {
    $("introRound").textContent = s.round === "bonus" ? "Bonus Round" : `Round ${s.round}`;
    $("introCat").textContent = s.category || "";
    if (lastPhase !== "roundIntro") sfx.startJingle();
  }
  // round/bonus end: let the board finish revealing (and the confetti fly) before the modal covers it
  const modalDelay = lastPhase == null ? 0 : 2400;
  if (s.phase === "roundEnd" && lastPhase !== "roundEnd") {
    clearTimeout(modalTimer);
    modalTimer = setTimeout(() => { if (S.phase === "roundEnd") showRoundEnd(S); }, modalDelay);
  }
  if (s.phase === "bonusEnd" && lastPhase !== "bonusEnd") {
    clearTimeout(modalTimer);
    modalTimer = setTimeout(() => { if (S.phase === "bonusEnd") showBonusEnd(S); }, modalDelay);
  }
  if (s.phase !== "roundEnd") { $("roundEnd").classList.remove("on"); roundEndShown = false; }
  if (s.phase !== "bonusEnd") { $("bonusEnd").classList.remove("on"); bonusEndShown = false; }
  if (s.phase === "roundEnd") renderStandings(s);
  if (s.phase === "bonusIntro" && lastPhase !== "bonusIntro") sfx.startJingle();
}

/* ----- used letters ----- */
function renderUsed(s, prev) {
  const used = new Set(s.used || []);
  const prevUsed = new Set(prev?.used || []);
  const strip = $("usedStrip");
  if (!strip.children.length) {
    for (let c = 65; c <= 90; c++) {
      const ch = String.fromCharCode(c);
      const d = document.createElement("div");
      d.className = "ul" + (VOWELS.has(ch) ? " v" : "");
      d.textContent = ch;
      d.dataset.ch = ch;
      strip.appendChild(d);
    }
  }
  for (const d of strip.children) {
    const u = used.has(d.dataset.ch);
    d.classList.toggle("used", u);
    if (u && !prevUsed.has(d.dataset.ch) && prev) { d.classList.remove("just"); void d.offsetWidth; d.classList.add("just"); }
  }
}

/* ----- board ----- */
const tiles = [];          // tiles[r][c] = element
let boardKey = "";
const visible = new Set(); // "r,c" keys currently showing their letter
const pending = new Set(); // letters known but not yet flipped
const lit = new Set();
const letterOf = new Map(); // "r,c" -> letter from reveal events (in case the snapshot lags)
let flipEpoch = 0;
let flipChain = Promise.resolve();
let pendingFallback = null;

(function buildBoard() {
  const b = $("board");
  let i = 0;
  ROW_WIDTHS.forEach((w, r) => {
    const row = document.createElement("div");
    row.className = "row";
    tiles[r] = [];
    for (let c = 0; c < w; c++) {
      const t = document.createElement("div");
      t.className = "tile empty";
      t.style.setProperty("--i", String(i++));
      t.innerHTML = `<div class="face"></div>`;
      row.appendChild(t);
      tiles[r][c] = t;
    }
    b.appendChild(row);
  });
})();

const cellAt = (r, c) => S?.board?.[r]?.[c] ?? null;
function paintTile(r, c) {
  const t = tiles[r]?.[c];
  if (!t) return;
  const cell = cellAt(r, c);
  const key = r + "," + c;
  let cls = "empty", txt = "";
  if (cell) {
    if (cell.k === "punct") { cls = "shown"; txt = cell.ch; }
    else if (lit.has(key)) cls = "blank lit";
    else if (visible.has(key)) { cls = "shown"; txt = cell.ch || letterOf.get(key) || ""; }
    else cls = "blank";
  }
  const keep = t.classList.contains("flip") ? " flip" : "";
  t.className = "tile " + cls + keep;
  const f = t.firstChild;
  if (f.textContent !== txt) f.textContent = txt;
}
function paintBoard() {
  ROW_WIDTHS.forEach((w, r) => { for (let c = 0; c < w; c++) paintTile(r, c); });
}

function renderBoard(s, prev) {
  const board = s.board || [];
  const key = String(s.round) + "|" + (s.category || "") + "|" + board.map((row) => (row || []).map((c) => (c ? "1" : "0")).join("")).join("/");
  const b = $("board");
  if (key !== boardKey) {
    const fresh = !!boardKey;
    boardKey = key;
    flipEpoch++;
    flipChain = Promise.resolve();
    visible.clear(); pending.clear(); lit.clear(); letterOf.clear();
    board.forEach((row, r) => (row || []).forEach((c, ci) => { if (c && c.k === "letter") visible.add(r + "," + ci); }));
    b.classList.remove("solved");
    paintBoard();
    if (fresh || s.phase === "roundIntro") { b.classList.remove("intro"); void b.offsetWidth; b.classList.add("intro"); setTimeout(() => b.classList.remove("intro"), 1600); }
    return;
  }
  // newly revealed letters that we haven't animated yet
  const fresh = [];
  board.forEach((row, r) => (row || []).forEach((c, ci) => {
    const k = r + "," + ci;
    if (c && c.k === "letter" && !visible.has(k) && !pending.has(k)) fresh.push(k);
  }));
  if (fresh.length) {
    fresh.forEach((k) => pending.add(k));
    if (s.phase === "revealing") {
      // a `reveal` event should arrive with these; if it doesn't, flip them ourselves
      clearTimeout(pendingFallback);
      pendingFallback = setTimeout(() => queueFlips(fresh, 700), 450);
    } else if (s.phase === "bonusReveal") {
      queueFlips(fresh, 420);
    } else {
      // solved / round over: quick cascade of everything left
      queueFlips(fresh, 55, true);
      if (s.phase === "roundEnd" || s.phase === "bonusEnd") b.classList.add("solved");
    }
  }
  paintBoard();
}

function queueFlips(keys, gap, quick = false) {
  const epoch = flipEpoch;
  const sorted = [...keys].sort((a, b) => { const [ar, ac] = a.split(",").map(Number); const [br, bc] = b.split(",").map(Number); return ar - br || ac - bc; });
  flipChain = flipChain.then(async () => {
    let n = 0;
    for (const k of sorted) {
      if (epoch !== flipEpoch) return;
      if (visible.has(k)) { pending.delete(k); continue; }
      const [r, c] = k.split(",").map(Number);
      if (!quick) {
        lit.add(k); paintTile(r, c);
        await sleep(Math.min(380, gap * 0.55));
        if (epoch !== flipEpoch) return;
        lit.delete(k);
      }
      visible.add(k); pending.delete(k);
      const t = tiles[r][c];
      t.classList.remove("flip"); void t.offsetWidth; t.classList.add("flip");
      setTimeout(() => t.classList.remove("flip"), 500);
      paintTile(r, c);
      if (!quick || n % 4 === 0) sfx.ding();
      n++;
      await sleep(quick ? gap : gap - Math.min(380, gap * 0.55));
    }
  });
  return flipChain;
}

/* ----- scoreboard (with rolling money) ----- */
let scoreKey = "";
const scoreEls = new Map();
function renderScores(s, prev) {
  const ps = s.players || [];
  const key = ps.map((p) => p.id + p.name + p.color).join("|") + s.hostId;
  const box = $("scores");
  if (key !== scoreKey) {
    scoreKey = key;
    box.innerHTML = "";
    scoreEls.clear();
    for (const p of ps) {
      const el = document.createElement("div");
      el.className = "score";
      el.style.setProperty("--pc", p.color);
      el.innerHTML = `<div class="nm"><span class="t">${esc(p.name)}</span>${p.id === s.hostId ? `<span class="crown">♛</span>` : ""}</div>
        <div class="rm">$0</div><div class="tot">Total <b>$0</b></div><div class="bar"></div>`;
      box.appendChild(el);
      const rec = { el, rm: el.querySelector(".rm"), tot: el.querySelector(".tot b"), bar: el.querySelector(".bar") };
      rec.rm._v = p.roundMoney || 0; rec.rm.textContent = money(rec.rm._v);
      rec.tot._v = p.total || 0; rec.tot.textContent = money(rec.tot._v);
      scoreEls.set(p.id, rec);
    }
  }
  for (const p of ps) {
    const rec = scoreEls.get(p.id);
    if (!rec) continue;
    rec.el.classList.toggle("cur", p.id === s.currentId && !["roundEnd", "gameOver"].includes(s.phase));
    rec.el.classList.toggle("off", !p.connected);
    const oldRm = rec.rm._target ?? rec.rm._v;
    if ((p.roundMoney || 0) > oldRm) flashClass(rec.el, "flash-good");
    roll(rec.rm, p.roundMoney || 0);
    roll(rec.tot, p.total || 0);
  }
}
function flashClass(el, cls, ms = 1000) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); }
function roll(el, target) {
  if (el._target === target) return;
  el._target = target;
  const from = el._v ?? 0;
  const t0 = performance.now();
  const dur = Math.min(1600, 500 + Math.abs(target - from) / 6);
  cancelAnimationFrame(el._raf);
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el._v = from + (target - from) * e;
    el.textContent = money(el._v);
    if (p < 1) el._raf = requestAnimationFrame(step);
    else el._v = target;
  };
  el._raf = requestAnimationFrame(step);
}

/* ----- wheel ----- */
let wheelKey = "";
let angle = 0;          // current wheel rotation in degrees (clockwise)
let spinning = false;
let wheelG = null;
let wedgeCount = 24;

function wedgeLabel(w) {
  if (w.k === "bankrupt") return "BANKRUPT";
  if (w.k === "lose") return "LOSE A TURN";
  return "$" + w.v;
}
function renderWheel(s) {
  const wedges = s.wheel?.wedges;
  if (!wedges?.length) return;
  const key = JSON.stringify(wedges);
  if (key !== wheelKey) {
    wheelKey = key;
    buildWheel(wedges);
    angle = -(s.wheel.index ?? 0) * (360 / wedges.length);
    setAngle(angle);
  } else if (!spinning && s.phase !== "spinning" && typeof s.wheel.index === "number") {
    // keep in sync if we missed a spin event (e.g. reconnect)
    const want = -s.wheel.index * (360 / wedgeCount);
    if (Math.abs((((angle - want) % 360) + 540) % 360 - 180) > 0.5) { angle = want; setAngle(angle); }
  }
}

function buildWheel(wedges) {
  const svg = $("wheel");
  const n = wedges.length;
  wedgeCount = n;
  const step = 360 / n;
  const R = 318, RIN = 70;
  const pt = (deg, r) => { const a = (deg * Math.PI) / 180; return [r * Math.sin(a), -r * Math.cos(a)]; };
  const cash = ["--wedge-1", "--wedge-2", "--wedge-3", "--wedge-4", "--wedge-5", "--wedge-6", "--wedge-7", "--wedge-8"];
  let ci = 0;
  let out = `<defs>
    <radialGradient id="jp" cx="50%" cy="20%" r="80%"><stop offset="0" style="stop-color:var(--jackpot-a)"/><stop offset="1" style="stop-color:var(--jackpot-b)"/></radialGradient>
    <radialGradient id="hub" cx="40%" cy="35%" r="70%"><stop offset="0" style="stop-color:var(--surface-2)"/><stop offset="1" style="stop-color:var(--wheel-hub)"/></radialGradient>
    <radialGradient id="shade" cx="50%" cy="50%" r="50%"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient>
  </defs>`;
  out += `<circle r="336" style="fill:var(--wheel-rim)"/><circle r="326" style="fill:var(--bg-0)"/>`;
  out += `<g id="wheelRot">`;
  wedges.forEach((w, i) => {
    const a0 = i * step - step / 2, a1 = i * step + step / 2;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
    let fill, ink;
    if (w.k === "bankrupt") { fill = "var(--bankrupt-bg)"; ink = "var(--bankrupt-ink)"; }
    else if (w.k === "lose") { fill = "var(--lose-bg)"; ink = "var(--lose-ink)"; }
    else if (w.v >= 1000) { fill = "url(#jp)"; ink = "var(--jackpot-ink)"; }
    else { fill = `var(${cash[ci++ % cash.length]})`; ink = "var(--wedge-ink)"; }
    out += `<path class="wedge" data-i="${i}" d="M0 0 L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" style="fill:${fill};stroke:var(--wedge-line);stroke-width:2.5"/>`;
    out += `<g transform="rotate(${i * step})">`;
    if (w.k === "cash") {
      // stacked, upright characters reading from the rim inwards
      const chars = ("$" + w.v).split("");
      const big = w.v >= 1000;
      const fs = big ? 40 : 42;
      chars.forEach((ch, k) => {
        const y = -R + 40 + k * (fs * 0.92);
        out += `<text x="0" y="${y}" text-anchor="middle" dominant-baseline="central" class="wheel-hub-text" style="fill:${ink};font-size:${ch === "$" ? fs * 0.8 : fs}px">${ch}</text>`;
      });
      if (big) out += `<text x="0" y="${-R + 40 + chars.length * fs * 0.92 + 6}" text-anchor="middle" dominant-baseline="central" style="fill:${ink};font-size:26px">★</text>`;
    } else {
      const label = w.k === "bankrupt" ? "BANKRUPT" : "LOSE A TURN";
      const fs = w.k === "bankrupt" ? 27 : 22;
      out += `<text transform="translate(0 ${-R + 22}) rotate(90)" x="0" y="0" text-anchor="start" dominant-baseline="central" class="wheel-hub-text" style="fill:${ink};font-size:${fs}px;letter-spacing:1px">${label}</text>`;
    }
    out += `</g>`;
  });
  // pegs on boundaries
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i * step + step / 2, R - 6);
    out += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="6" style="fill:var(--peg);stroke:var(--bg-0);stroke-width:2"/>`;
  }
  out += `<circle r="${R}" fill="url(#shade)" pointer-events="none"/>`;
  out += `</g>`;
  out += `<circle r="${RIN}" fill="url(#hub)" style="stroke:var(--wheel-rim);stroke-width:8"/>`;
  out += `<text y="-10" text-anchor="middle" dominant-baseline="central" class="wheel-hub-text" style="fill:var(--gold);font-size:30px">SPIN</text>`;
  out += `<text y="22" text-anchor="middle" dominant-baseline="central" class="wheel-hub-text" style="fill:var(--ink);font-size:22px">&amp; SOLVE</text>`;
  svg.innerHTML = out;
  wheelG = svg.querySelector("#wheelRot");
}
function setAngle(a) { wheelG?.setAttribute("transform", `rotate(${a.toFixed(3)})`); }

function wigglePointer(strength = 1) {
  const p = $("pointer");
  p.getAnimations().forEach((a) => a.cancel());
  p.animate([{ transform: `rotate(${-24 * strength}deg)` }, { transform: "rotate(0deg)" }], { duration: 140, easing: "ease-out" });
}

function spinWheel({ index, turns = 3, duration = 5000 }) {
  if (!wheelG) return;
  const n = wedgeCount, step = 360 / n;
  const start = angle;
  const target = -index * step;
  const delta = (((target - start) % 360) + 360) % 360;
  const end = start + Math.max(0, Math.round(turns)) * 360 + delta;
  const t0 = performance.now();
  let lastSeg = Math.floor((start + step / 2) / step);
  spinning = true;
  $("wheelWrap").classList.add("spinning");
  sfx.whoosh();
  const ease = (p) => 1 - Math.pow(1 - p, 4);
  return new Promise((resolve) => {
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      angle = start + (end - start) * ease(p);
      setAngle(angle);
      const seg = Math.floor((angle + step / 2) / step);
      if (seg !== lastSeg) {
        lastSeg = seg;
        sfx.tick();
        wigglePointer(p < 0.5 ? 0.5 : 1);
      }
      if (p < 1) requestAnimationFrame(frame);
      else {
        angle = end % 360;
        setAngle(angle);
        spinning = false;
        $("wheelWrap").classList.remove("spinning");
        landed(index);
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}
function landed(index) {
  const w = S?.wheel?.wedges?.[index];
  const path = $("wheel").querySelector(`.wedge[data-i="${index}"]`);
  path?.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.6)" }, { filter: "brightness(1)" }], { duration: 500, iterations: 3 });
  if (w?.k === "cash") {
    const pop = $("wedgePop");
    pop.textContent = money(w.v);
    flashClass(pop, "on", 1900);
  }
}

/* ----- solve panel ----- */
function transcriptHTML(solve, emptyMsg) {
  if (!solve || !solve.text) return `<span class="placeholder">${emptyMsg}</span>`;
  const interim = solve.source === "voice" && !solve.final;
  return `<span class="${interim ? "interim" : "final"}">${esc(solve.text)}</span>`;
}
function renderSolve(s) {
  const id = s.solve?.playerId ?? s.currentId;
  $("solveWho").innerHTML = `${whoSpan(id)} is solving…`;
  $("solveText").innerHTML = transcriptHTML(s.solve, "Listening…");
  $("solveSource").textContent = s.solve?.text ? (s.solve.source === "voice" ? (s.solve.final ? "voice · final" : "voice · hearing…") : "typed") : "";
}

/* ----- bonus panel ----- */
function renderBonus(s) {
  const b = s.bonus || {};
  const id = b.playerId ?? s.currentId;
  $("bonusWho").innerHTML = `${whoSpan(id)} plays for`;
  $("bonusPrize").textContent = money(b.prize ?? 25000);
  const name = esc(pname(id));
  const status = {
    bonusIntro: `Here come the free letters!`,
    bonusPick: `${name} is choosing 3 consonants and a vowel…`,
    bonusReveal: `Revealing ${name}'s letters`,
    bonusSolve: `Solve it before time runs out!`,
    bonusEnd: bonusWon(s) ? "Solved it!" : "Time's up!",
  }[s.phase] || "";
  $("bonusStatus").textContent = status;
  const given = b.given || [];
  const picks = b.picks || [];
  let html = given.map((ch) => `<div class="bl given">${esc(ch)}</div>`).join("");
  html += `<div class="bl sep"></div>`;
  for (let i = 0; i < 4; i++) {
    const ch = picks[i];
    html += ch ? `<div class="bl pick">${esc(ch)}</div>` : `<div class="bl wait${i === 3 ? " vowel" : ""}" title="${i < 3 ? "consonant" : "vowel"}">?</div>`;
  }
  const bl = $("bonusLetters");
  if (bl.innerHTML !== html) bl.innerHTML = html;
  const solving = s.phase === "bonusSolve";
  $("bonusPanel").classList.toggle("solving", solving || (s.phase === "bonusEnd" && !!s.solve?.text));
  $("bonusText").innerHTML = transcriptHTML(s.solve, "Say or type your answer!");
  if (!solving) $("bonusCount").textContent = "";
}

/* ----- round end / bonus end ----- */
let lastSolve = null;   // {playerId, banked}
let roundEndShown = false;
let bonusEndShown = false;
let modalTimer = null;
let bonusResult = null;
function showRoundEnd(s) {
  roundEndShown = true;
  if (s.lastSolve) lastSolve = s.lastSolve; // survives a TV refresh during roundEnd
  const solvedThisRound = lastSolve && lastSolve.round === s.round;
  $("reTitle").textContent = s.round >= (s.totalRounds ?? 4) ? "Final round complete!" : `Round ${s.round} complete!`;
  $("reAnswer").textContent = s.answer || "";
  $("reWinner").innerHTML = solvedThisRound
    ? `${whoSpan(lastSolve.playerId)} banks <span class="amt">${money(lastSolve.banked)}</span>`
    : s.solo ? `Out of spins — better luck on the next one!` : `Nobody solved this one.`;
  $("roundEnd").classList.add("on");
}
function renderStandings(s) {
  const sorted = [...(s.players || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
  const html = sorted.map((p, i) => `<div class="st" style="--pc:${esc(p.color)}"><div class="rk">${i + 1}</div><div class="sw"></div><div class="n">${esc(p.name)}</div><div class="v">${money(p.total)}</div></div>`).join("");
  if ($("reStandings").innerHTML !== html) $("reStandings").innerHTML = html;
}
function bonusWon(s) {
  if (bonusResult) return bonusResult.won;
  return !!s.bonus?.won;   // optional snapshot field (fallback after a reconnect)
}
function showBonusEnd(s) {
  bonusEndShown = true;
  const won = bonusWon(s);
  const id = s.bonus?.playerId ?? s.currentId;
  $("beTitle").textContent = won ? "Bonus round won!" : "So close!";
  $("beAnswer").textContent = s.answer || "";
  $("beLine").innerHTML = won
    ? `${whoSpan(id)} wins <span class="amt">${money(bonusResult?.prize ?? s.bonus?.prize)}</span>!`
    : `${whoSpan(id)} didn't get it this time.`;
  $("bonusEnd").classList.add("on");
}
$("nextBtn").addEventListener("click", () => net?.send({ t: "next" }));
$("nextBtn2").addEventListener("click", () => net?.send({ t: "next" }));

/* ================= GAME OVER ================= */
let goKey = "";
function renderGameOver(s) {
  const winners = s.winners?.length ? s.winners : [...(s.players || [])].map((p) => ({ id: p.id, total: p.total })).sort((a, b) => b.total - a.total);
  const key = JSON.stringify(winners);
  if (key === goKey) return;
  goKey = key;
  const top = winners.slice(0, 3);
  const order = [1, 0, 2].filter((i) => top[i]);
  $("podium").innerHTML = order.map((i) => {
    const w = top[i], p = player(w.id);
    return `<div class="pod p${i + 1}" style="--pc:${esc(p?.color || "var(--gold)")}">
      <div class="nm">${i === 0 ? "♛ " : ""}${esc(p?.name ?? "?")}</div><div class="amt">${money(w.total)}</div><div class="block">${i + 1}</div></div>`;
  }).join("");
  $("restList").innerHTML = winners.slice(3).map((w, i) => `<span>${i + 4}. ${esc(pname(w.id))} — ${money(w.total)}</span>`).join("");
  $("bonusLine").innerHTML = !s.bonus ? ""
    : bonusWon(s) ? `Bonus round: ${whoSpan(s.bonus.playerId)} won ${money(bonusResult?.prize ?? s.bonus.prize)}!`
    : `Bonus round: not solved this time${s.answer ? ` — the answer was <b>${esc(s.answer)}</b>` : ""}`;
  sfx.fanfare();
  setTimeout(() => confetti(260), 700);
}
$("againBtn").addEventListener("click", () => { bonusResult = null; lastSolve = null; goKey = ""; net?.send({ t: "playAgain" }); });

/* ================= events ================= */
let busyUntil = 0;   // banners wait until big overlays are done
function onEvent(ev) {
  const e = ev.e;
  switch (e) {
    case "spin": spinWheel(ev); break;
    case "reveal": {
      clearTimeout(pendingFallback);
      const keys = (ev.cells || []).map(([r, c]) => r + "," + c);
      keys.forEach((k) => { pending.add(k); if (ev.letter) letterOf.set(k, ev.letter); });
      paintBoard();
      const n = ev.count ?? keys.length;
      callout(`${n} ${esc(ev.letter)}${n === 1 ? "" : "'s"}${ev.earned ? ` · +${money(ev.earned)}` : ""}`);
      queueFlips(keys, 700);
      break;
    }
    case "miss": {
      sfx.buzz();
      flashClass($("board"), "shake", 600);
      callout(ev.reason === "used" ? `${esc(ev.letter)} was already called` : `No ${esc(ev.letter)}`, true);
      break;
    }
    case "bankrupt": {
      sfx.bankrupt();
      const fx = $("bankruptFx");
      $("bankruptSub").innerHTML = ev.lost ? `${esc(pname(ev.playerId))} loses ${money(ev.lost)}` : `${esc(pname(ev.playerId))}`;
      flashClass(fx, "on", 2600);
      busyUntil = Date.now() + 2700;
      const rec = scoreEls.get(ev.playerId);
      if (rec) flashClass(rec.el, "flash-bad", 1000);
      break;
    }
    case "loseTurn":
      sfx.buzz();
      banner(`LOSE A TURN<span class="small">${esc(pname(ev.playerId))}</span>`, { cls: "lose" });
      break;
    case "turn": {
      const p = player(ev.playerId);
      banner(`${whoSpan(ev.playerId)}'s turn`, { pc: p?.color, sound: sfx.turnChime, delay: true });
      break;
    }
    case "outOfSpins":
      sfx.bankrupt();
      banner(`OUT OF SPINS<span class="small">${esc(pname(ev.playerId))}</span>`, { cls: "bad" });
      break;
    case "timeout":
      sfx.buzz();
      banner(`Time's up!<span class="small">${esc(pname(ev.playerId))}</span>`, { cls: "bad" });
      break;
    case "solveRight":
      lastSolve = { playerId: ev.playerId, banked: ev.banked, round: S?.round };
      sfx.fanfare();
      confetti();
      if (roundEndShown) showRoundEnd(S);
      busyUntil = Date.now() + 1500;
      break;
    case "solveWrong":
      sfx.buzz();
      banner(`<span class="struck">${esc(ev.text || "…")}</span>Not quite, ${esc(pname(ev.playerId))}!`, { cls: "bad", ms: 2600 });
      break;
    case "roundStart":
      if (S?.phase !== "roundIntro" && S?.phase !== "bonusIntro") sfx.startJingle();
      break;
    case "bonusResult":
      bonusResult = { won: !!ev.won, prize: ev.prize };
      if (ev.won) { sfx.fanfare(); confetti(320); } else sfx.bankrupt();
      if (bonusEndShown) showBonusEnd(S);
      break;
  }
}

/* ----- banners & callouts ----- */
let bannerTimer = null;
function banner(html, { cls = "", pc, sound, ms = 2200, delay = false } = {}) {
  const wait = delay ? Math.max(0, busyUntil - Date.now()) : 0;
  setTimeout(() => {
    const b = $("banner"), inner = $("bannerInner");
    inner.className = "banner-inner " + cls;
    if (pc) inner.style.setProperty("--pc", pc); else inner.style.removeProperty("--pc");
    inner.innerHTML = html;
    b.style.animationDuration = ms + "ms";
    flashClass(b, "on", ms);
    sound?.();
  }, wait);
}
let calloutTimer = null;
function callout(html, bad = false) {
  const c = $("callout");
  c.innerHTML = html;
  c.classList.toggle("bad", bad);
  c.classList.add("on");
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => c.classList.remove("on"), 2600);
}

/* ----- confetti ----- */
const cv = $("confetti");
const cx = cv.getContext("2d");
let parts = [];
let confettiRaf = 0;
function confetti(n = 220) {
  const cs = getComputedStyle(document.documentElement);
  const cols = [1, 2, 3, 4, 5].map((i) => cs.getPropertyValue(`--confetti-${i}`).trim() || "#fff");
  for (let i = 0; i < n; i++) {
    const left = i % 2 === 0;
    parts.push({
      x: left ? -20 : 1940, y: 700 + Math.random() * 300,
      vx: (left ? 1 : -1) * (8 + Math.random() * 14), vy: -(18 + Math.random() * 16),
      w: 10 + Math.random() * 12, h: 6 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: cols[i % cols.length], life: 0,
    });
  }
  if (!confettiRaf) confettiRaf = requestAnimationFrame(confettiStep);
}
function confettiStep() {
  cx.clearRect(0, 0, 1920, 1080);
  parts = parts.filter((p) => p.y < 1150 && p.life < 400);
  for (const p of parts) {
    p.life++;
    p.vy += 0.45; p.vx *= 0.985; p.vy *= 0.99;
    p.x += p.vx; p.y += p.vy; p.r += p.vr;
    cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r);
    cx.fillStyle = p.c;
    cx.fillRect(-p.w / 2, (-p.h / 2) * Math.abs(Math.cos(p.life / 6)), p.w, p.h * Math.abs(Math.cos(p.life / 6)) + 1);
    cx.restore();
  }
  confettiRaf = parts.length ? requestAnimationFrame(confettiStep) : 0;
  if (!parts.length) cx.clearRect(0, 0, 1920, 1080);
}

/* ================= per-frame: timers & countdowns ================= */
let lastDeadline = null, deadlineTotal = 20000, lastBeepSec = null;
function frame() {
  requestAnimationFrame(frame);
  if (!S || !net) return;
  const now = net.now();
  const dl = S.deadline;
  const remain = dl ? Math.max(0, dl - now) : 0;
  if (dl !== lastDeadline) {
    lastDeadline = dl;
    deadlineTotal = DEADLINE_TOTALS[S.deadlineKind] || Math.max(1000, remain);
    if (remain > deadlineTotal) deadlineTotal = remain;
    lastBeepSec = null;
  }
  const secs = Math.ceil(remain / 1000);

  // header ring for turn / pick timers
  const tm = $("timer");
  const showRing = dl && SHOW_TIMER_KINDS.has(S.deadlineKind);
  tm.classList.toggle("on", !!showRing);
  if (showRing) {
    $("timerArc").style.strokeDashoffset = String(276.46 * (1 - remain / deadlineTotal));
    const t = String(secs);
    if ($("timerNum").textContent !== t) $("timerNum").textContent = t;
    tm.classList.toggle("low", secs <= 5);
  }
  // big countdowns
  if (S.phase === "solving") setCount($("solveCount"), dl ? secs : "");
  if (S.phase === "bonusSolve") setCount($("bonusCount"), dl ? secs : "");
  // auto-advance hints
  if (S.phase === "roundEnd") $("reAuto").textContent = dl ? `Next round in ${secs}…` : "";
  if (S.phase === "bonusEnd") $("beAuto").textContent = dl ? `Final scores in ${secs}…` : "";

  // countdown beeps for solve timers and the last seconds of a turn
  const beepKinds = S.deadlineKind === "solve" || S.deadlineKind === "bonusSolve" ? 5 : S.deadlineKind === "turn" || S.deadlineKind === "pick" ? 3 : 0;
  if (dl && beepKinds && remain > 0 && secs <= beepKinds && secs !== lastBeepSec) {
    lastBeepSec = secs;
    sfx.countdownBeep(secs === 1);
  }
}
function setCount(el, v) {
  const t = String(v);
  if (el.textContent !== t) el.textContent = t;
  el.classList.toggle("low", typeof v === "number" && v <= 5);
}
requestAnimationFrame(frame);

boot();

// handy for debugging from the console
window.__tv = { get state() { return S; }, spinWheel, confetti, banner };
