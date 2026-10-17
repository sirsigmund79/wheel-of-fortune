// Spin & Solve — phone controller.
import { connect } from "/shared/net.js";
import { speechSupported, createSpeech } from "/play/speech.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

const VOWELS = ["A", "E", "I", "O", "U"];
const QWERTY = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
const CONSONANT_ROWS = QWERTY.map((r) => r.split("").filter((c) => !VOWELS.includes(c)));
const BONUS_GIVEN = ["R", "S", "T", "L", "N", "E"];
const DEADLINE_TOTALS = { turn: 20000, pick: 20000, solve: 30000, bonusSolve: 15000, spin: 8000 };
const ROOM_ALPHABET = /[^ABCDEFGHJKLMNPQRSTUVWXYZ]/g;

const params = new URLSearchParams(location.search);
const mockParam = params.get("mock");
let room = (params.get("room") || "").toUpperCase().replace(ROOM_ALPHABET, "").slice(0, 4);

// ---------------------------------------------------------------- state
let s = null;            // latest snapshot
let me = null;           // my playerId
let status = "connecting";
let net = null;
let pendingJoin = null;  // {name, color} sent, awaiting playerId
const ui = {
  vowelPicker: false,
  bonusConsonants: [],
  bonusVowel: null,
  bonusKey: "",
  lobbyName: null,
  submitted: false,
  solveKey: "",
};

const app = $("#app");
let screen = null; // {key, el, update()}

// ---------------------------------------------------------------- helpers
function player(id) { return s?.players?.find((p) => p.id === id) || null; }
function mine() { return player(me); }
function isHost() { return !!me && s?.hostId === me; }
function storedName() { try { return localStorage.getItem("sns:name") || ""; } catch { return ""; } }
function saveName(n) { try { localStorage.setItem("sns:name", n); } catch {} }
function vibrate(p) { try { navigator.vibrate?.(p); } catch {} }
function send(msg) { net?.send(msg); }
function now() { return net ? net.now() : Date.now(); }

function throttle(fn, ms) {
  let last = 0, timer = 0, pendingArgs = null;
  const run = () => { last = Date.now(); timer = 0; const a = pendingArgs; pendingArgs = null; fn(...a); };
  const t = (...args) => {
    pendingArgs = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { clearTimeout(timer); run(); }
    else if (!timer) timer = setTimeout(run, wait);
  };
  t.cancel = () => { clearTimeout(timer); timer = 0; pendingArgs = null; };
  return t;
}

function toast(msg, kind = "") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 3000);
}

function shake() {
  document.body.classList.remove("shake");
  void document.body.offsetWidth;
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 700);
}

function celebrate() {
  const fx = $("#fx");
  const colors = s?.colors?.length ? s.colors : ["#ffd23f", "#ef476f", "#06d6a0", "#4cc9f0", "#9b5de5"];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement("i");
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = Math.random() * 0.6 + "s";
    c.style.animationDuration = 1.6 + Math.random() * 1.4 + "s";
    c.style.setProperty("--rot", Math.round(Math.random() * 720 - 360) + "deg");
    c.style.setProperty("--dx", Math.round(Math.random() * 80 - 40) + "px");
    fx.appendChild(c);
    setTimeout(() => c.remove(), 3600);
  }
}

// only touch the DOM when the markup actually changed (keeps animations from replaying on every snapshot)
function setHTML(el, html) {
  if (el && el._html !== html) { el._html = html; el.innerHTML = html; }
}

function fixColor(c) { return /^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#888"; }
function chip(p, big = false) {
  if (!p) return "";
  return `<span class="chip ${big ? "big" : ""}" style="--pc:${fixColor(p.color)}"></span>`;
}

// ---------------------------------------------------------------- deciding the screen
function solverId() {
  if (!s) return null;
  if (s.phase === "bonusSolve") return s.bonus?.playerId ?? s.solve?.playerId ?? null;
  if (s.phase === "solving") return s.solve?.playerId ?? s.currentId ?? null;
  return null;
}
function deadlineIsMine() {
  if (!s?.deadline || !me) return false;
  switch (s.deadlineKind) {
    case "turn": case "pick": return s.currentId === me;
    case "solve": case "bonusSolve": return solverId() === me;
    default: return false;
  }
}

function screenKey() {
  if (!room) return "code";
  if (!s) return "connecting";
  const p = mine();
  if (!p) return s.phase === "lobby" ? "join" : "spectate";
  switch (s.phase) {
    case "lobby": return "lobby";
    case "solving": case "bonusSolve": return solverId() === me ? "solve" : "game";
    case "roundEnd": case "bonusEnd": case "gameOver": return "results";
    default: return "game";
  }
}

function render() {
  const key = screenKey();
  if (!screen || screen.key !== key) {
    if (screen?.destroy) screen.destroy();
    app.innerHTML = "";
    const el = document.createElement("section");
    el.className = "screen screen-" + key;
    app.appendChild(el);
    screen = { key, el, ...(SCREENS[key] || SCREENS.connecting)(el) };
  }
  screen.update?.();
  renderTop();
}

function renderTop() {
  const top = $("#top");
  top.hidden = !room;
  $("#conn").className = "conn " + status;
  $("#roomLabel").textContent = room ? "Room " + room : "";
  let r = "";
  if (s && s.phase !== "lobby") {
    if (s.round === "bonus" || String(s.phase).startsWith("bonus")) r = "Bonus round";
    else if (s.phase === "gameOver") r = "Game over";
    else if (s.round) r = `Round ${s.round} of ${s.totalRounds || 4}`;
  }
  $("#roundLabel").textContent = r;
  $("#banner").hidden = status !== "closed";
}

// ---------------------------------------------------------------- shared fragments
function hudHTML() {
  const p = mine();
  if (!p) return "";
  return `<div class="hud" style="--pc:${fixColor(p.color)}">
    <div class="hud-me">${chip(p)}<span class="hud-name">${esc(p.name)}</span></div>
    <div class="hud-money">
      <div><small>Round</small><b>${money(p.roundMoney)}</b></div>
      <div><small>Total</small><b>${money(p.total)}</b></div>
    </div>
  </div>`;
}

function turnHTML() {
  if (!s) return "";
  let pid = s.currentId;
  if (s.phase === "solving") pid = solverId();
  if (String(s.phase).startsWith("bonus")) pid = s.bonus?.playerId ?? pid;
  const p = player(pid);
  if (!p) return "";
  const label = String(s.phase).startsWith("bonus") ? "Bonus player" : "Turn";
  const name = p.id === me ? "You" : esc(p.name);
  return `<div class="turnline ${p.id === me ? "me" : ""}" style="--pc:${fixColor(p.color)}">
    <span class="tl-label">${label}</span>${chip(p)}<b>${name}</b>${p.connected === false ? '<span class="off">offline</span>' : ""}
  </div>`;
}

function categoryHTML() {
  return s?.category ? `<div class="category">${esc(s.category)}</div>` : "";
}

function boardHTML() {
  if (!Array.isArray(s?.board)) return "";
  const rows = s.board.map((row) => {
    const cells = (row || []).map((c) => {
      if (!c) return `<i class="c n"></i>`;
      if (c.k === "blank") return `<i class="c b"></i>`;
      return `<i class="c l">${esc(c.ch)}</i>`;
    }).join("");
    return `<div class="br" style="--n:${(row || []).length}">${cells}</div>`;
  }).join("");
  return `<div class="miniboard">${rows}</div>`;
}

function usedHTML() {
  if (!s?.used?.length) return "";
  return `<div class="used"><small>Used</small>${s.used.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`;
}

// countdown bar: an element with class .cd; updated by the RAF loop
function countdownHTML() {
  return `<div class="cd" hidden><div class="cd-fill"></div><span class="cd-num"></span></div>`;
}
function tickCountdowns() {
  const bars = document.querySelectorAll(".cd");
  const mineDl = deadlineIsMine();
  const remaining = s?.deadline ? Math.max(0, s.deadline - now()) : 0;
  const total = Math.max(DEADLINE_TOTALS[s?.deadlineKind] || 20000, remaining);
  bars.forEach((bar) => {
    bar.hidden = !mineDl;
    if (!mineDl) return;
    const frac = total ? remaining / total : 0;
    bar.querySelector(".cd-fill").style.transform = `scaleX(${frac})`;
    bar.querySelector(".cd-num").textContent = Math.ceil(remaining / 1000) + "s";
    bar.classList.toggle("urgent", remaining < 5500);
  });
  requestAnimationFrame(tickCountdowns);
}

function keyboardHTML(rows, { act, disabled = () => false, selected = () => false }) {
  return `<div class="kbd">${rows.map((r) => `<div class="kr">${r.map((l) =>
    `<button class="key ${selected(l) ? "sel" : ""}" data-act="${act}" data-l="${l}" ${disabled(l) ? "disabled" : ""}>${l}</button>`
  ).join("")}</div>`).join("")}</div>`;
}

function standingsHTML() {
  const list = [...(s?.players || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
  return `<ol class="standings">${list.map((p, i) =>
    `<li class="${p.id === me ? "me" : ""}"><span class="rank">${i + 1}</span>${chip(p)}<span class="nm">${esc(p.name)}${p.id === me ? " (you)" : ""}</span><b>${money(p.total)}</b></li>`
  ).join("")}</ol>`;
}

// ---------------------------------------------------------------- screens
const SCREENS = {
  code(el) {
    el.innerHTML = `
      <div class="brand"><div class="logo">Spin <span>&amp;</span> Solve</div><p>Enter the room code on the TV</p></div>
      <form class="code-form" autocomplete="off">
        <input id="codeIn" class="code-in" maxlength="4" inputmode="text" autocapitalize="characters"
          autocomplete="off" autocorrect="off" spellcheck="false" placeholder="ABCD" aria-label="Room code">
        <button class="btn primary xl" type="submit" disabled>Join room</button>
      </form>`;
    const input = $("#codeIn", el), btn = $("button", el);
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(ROOM_ALPHABET, "").slice(0, 4);
      btn.disabled = input.value.length !== 4;
    });
    $("form", el).addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.length !== 4) return;
      const q = new URLSearchParams(location.search);
      q.set("room", input.value);
      location.search = q.toString();
    });
    setTimeout(() => input.focus(), 50);
    return {};
  },

  connecting(el) {
    el.innerHTML = `<div class="center"><div class="spinner"></div><p class="muted">Connecting to room ${esc(room)}…</p></div>`;
    return {};
  },

  spectate(el) {
    return {
      update() {
        setHTML(el, `<div class="center card">
          <div class="big-emoji">📺</div>
          <h2>Game in progress</h2>
          <p class="muted">Room ${esc(room)} has already started. Watch the TV — you can join when the next game starts.</p>
          ${s.log ? `<p class="log">${esc(s.log)}</p>` : ""}
        </div>`);
      },
    };
  },

  join(el) {
    const taken = () => new Set((s.players || []).map((p) => p.color));
    let color = null;
    el.innerHTML = `
      <div class="brand small"><div class="logo">Spin <span>&amp;</span> Solve</div></div>
      <form class="join-form" autocomplete="off">
        <label class="lbl" for="nameIn">Your name</label>
        <input id="nameIn" class="text-in" maxlength="12" autocomplete="off" autocorrect="off" spellcheck="false"
          enterkeyhint="done" placeholder="Name" value="${esc(storedName().slice(0, 12))}">
        <label class="lbl">Pick a colour</label>
        <div class="swatches"></div>
        <button class="btn primary xl" type="submit">Join game</button>
      </form>
      <div class="lobby-list"></div>`;
    const nameIn = $("#nameIn", el), sw = $(".swatches", el), btn = $("button[type=submit]", el);
    sw.addEventListener("click", (e) => {
      const b = e.target.closest(".sw");
      if (!b || b.disabled) return;
      color = b.dataset.c;
      update();
    });
    $("form", el).addEventListener("submit", (e) => {
      e.preventDefault();
      const name = nameIn.value.trim().slice(0, 12);
      if (!name) { toast("Type your name first", "warn"); nameIn.focus(); return; }
      if (!color) { toast("Pick a colour", "warn"); return; }
      saveName(name);
      pendingJoin = { name, color };
      send({ t: "join", name, color });
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 2500);
    });
    nameIn.addEventListener("input", () => update());
    function update() {
      const t = taken();
      if (!color || t.has(color)) color = (s.colors || []).find((c) => !t.has(c)) || null;
      sw.innerHTML = (s.colors || []).map((c) =>
        `<button type="button" class="sw ${c === color ? "sel" : ""}" data-c="${esc(c)}" style="--pc:${fixColor(c)}" ${t.has(c) ? "disabled" : ""} aria-label="colour ${esc(c)}"></button>`
      ).join("");
      const full = (s.players || []).length >= 6;
      btn.textContent = full ? "Room is full" : "Join game";
      if (full) btn.disabled = true;
      $(".lobby-list", el).innerHTML = (s.players || []).length
        ? `<h3>In the room</h3>${playersListHTML()}` : `<p class="muted center-text">Nobody here yet — be first!</p>`;
    }
    return { update };
  },

  lobby(el) {
    el.innerHTML = `
      <div class="lobby-me card"></div>
      <div class="lobby-list"></div>
      <div class="lobby-actions"></div>`;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === "color") send({ t: "update", color: b.dataset.c });
      if (act === "saveName") {
        const n = $("#lobbyName", el).value.trim().slice(0, 12);
        if (!n) return toast("Name can't be empty", "warn");
        saveName(n);
        send({ t: "update", name: n });
        ui.lobbyName = null;
        $("#lobbyName", el).blur();
        update();
      }
      if (act === "start") send({ t: "start" });
      if (act === "leave") {
        if (!confirm("Leave this game?")) return;
        send({ t: "leave" });
        net?.forget?.();
        me = null;
        render();
      }
    });
    function update() {
      const p = mine();
      if (!p) return;
      const meBox = $(".lobby-me", el);
      if (!meBox.firstChild) {
        meBox.innerHTML = `
          <label class="lbl" for="lobbyName">You</label>
          <div class="name-row"><input id="lobbyName" class="text-in" maxlength="12" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
          <button class="btn small" data-act="saveName" hidden>Save</button></div>
          <div class="swatches"></div>`;
        const inp = $("#lobbyName", el);
        inp.addEventListener("input", () => { ui.lobbyName = inp.value; $("[data-act=saveName]", el).hidden = inp.value.trim() === p.name; });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") $("[data-act=saveName]", el).click(); });
      }
      const inp = $("#lobbyName", el);
      if (document.activeElement !== inp && ui.lobbyName == null) inp.value = p.name;
      $("[data-act=saveName]", el).hidden = inp.value.trim() === p.name;
      const taken = new Set(s.players.filter((x) => x.id !== me).map((x) => x.color));
      $(".swatches", el).innerHTML = (s.colors || []).map((c) =>
        `<button type="button" class="sw ${c === p.color ? "sel" : ""}" data-act="color" data-c="${esc(c)}" style="--pc:${fixColor(c)}" ${taken.has(c) ? "disabled" : ""} aria-label="colour ${esc(c)}"></button>`
      ).join("");
      $(".lobby-list", el).innerHTML = `<h3>Players (${s.players.length}/6)</h3>${playersListHTML()}`;
      const n = s.players.length;
      const custom = s.customCount ? `<p class="muted center-text">${s.customCount} custom puzzle${s.customCount === 1 ? "" : "s"} loaded</p>` : "";
      $(".lobby-actions", el).innerHTML = (isHost()
        ? `<button class="btn primary xl" data-act="start" ${n >= 2 && n <= 6 ? "" : "disabled"}>Start game</button>
           <p class="muted center-text">${n < 2 ? "Need at least 2 players to start" : "You're the host — start when everyone's in"}</p>`
        : `<div class="waiting"><div class="dots"><i></i><i></i><i></i></div>Waiting for host${player(s.hostId) ? " (" + esc(player(s.hostId).name) + ")" : ""}…</div>`)
        + custom + `<button class="btn ghost" data-act="leave">Leave</button>`;
    }
    return { update };
  },

  game(el) {
    el.innerHTML = `<div class="g-hud"></div><div class="g-turn"></div>${countdownHTML()}<div class="g-main"></div>`;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act, l = b.dataset.l;
      switch (act) {
        case "spin": ui.vowelPicker = false; send({ t: "spin" }); break;
        case "vowels": ui.vowelPicker = !ui.vowelPicker; update(); break;
        case "buy": ui.vowelPicker = false; send({ t: "buyVowel", letter: l }); break;
        case "solve": ui.vowelPicker = false; send({ t: "solveStart" }); break;
        case "guess": send({ t: "guess", letter: l }); b.classList.add("sel"); break;
        case "bc": {
          const arr = ui.bonusConsonants;
          const i = arr.indexOf(l);
          if (i >= 0) arr.splice(i, 1);
          else if (arr.length < 3) arr.push(l);
          else { toast("3 consonants max — tap one to remove it"); return; }
          update(); break;
        }
        case "bv": ui.bonusVowel = ui.bonusVowel === l ? null : l; update(); break;
        case "bonusConfirm":
          send({ t: "bonusPick", consonants: [...ui.bonusConsonants], vowel: ui.bonusVowel });
          b.disabled = true; break;
      }
    });
    function update() {
      setHTML($(".g-hud", el), hudHTML());
      setHTML($(".g-turn", el), turnHTML());
      setHTML($(".g-main", el), mainHTML());
    }
    return { update };
  },

  solve(el) {
    const bonus = s.phase === "bonusSolve";
    el.innerHTML = `
      <div class="g-hud"></div>
      ${countdownHTML()}
      <h2 class="solve-title">${bonus ? "Solve the bonus puzzle!" : "Solve the puzzle"}</h2>
      <div class="s-cat"></div>
      <div class="s-board"></div>
      <form class="solve-form" autocomplete="off">
        <textarea id="solveIn" class="solve-in" rows="2" autocapitalize="characters" autocomplete="off" autocorrect="off"
          spellcheck="false" enterkeyhint="send" placeholder="Type your answer…" aria-label="Your answer"></textarea>
        <div class="solve-btns">
          ${speechSupported ? `<button type="button" class="btn mic" id="micBtn" aria-label="Hold to talk"><span class="mic-ico"></span><span class="mic-lbl">Hold to talk</span></button>` : ""}
          <button type="submit" class="btn primary xl" id="submitBtn">Submit</button>
        </div>
        ${bonus ? "" : `<button type="button" class="btn ghost" id="cancelBtn">Cancel</button>`}
      </form>`;
    const input = $("#solveIn", el), submitBtn = $("#submitBtn", el), micBtn = $("#micBtn", el);
    ui.submitted = false;
    if (s.solve?.playerId === me && s.solve?.text) input.value = s.solve.text;

    const draft = throttle((text, source, final) => {
      const m = { t: "solveDraft", text, source };
      if (source === "voice") m.final = !!final;
      send(m);
    }, 250);

    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase();
      draft(input.value, "typed");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    $("form", el).addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    $("#cancelBtn", el)?.addEventListener("click", () => { speech?.abort(); draft.cancel(); send({ t: "solveCancel" }); });

    function submit() {
      const text = input.value.trim();
      if (!text) { toast("Type or say your answer first", "warn"); input.focus(); return; }
      if (ui.submitted) return;
      speech?.abort();
      draft.cancel();
      ui.submitted = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Sent!";
      input.blur();
      send({ t: "solveSubmit", text });
      setTimeout(() => { ui.submitted = false; submitBtn.disabled = false; submitBtn.textContent = "Submit"; }, 4000);
    }

    // hold-to-talk
    let speech = null;
    if (micBtn) {
      speech = createSpeech({
        onInterim(text) {
          input.value = text.toUpperCase();
          draft(input.value, "voice", false);
        },
        onFinal(text) {
          input.value = text.toUpperCase();
          draft.cancel();
          send({ t: "solveDraft", text: input.value, source: "voice", final: true });
        },
        onError(code, msg) { toast(msg, "warn"); },
        onState(active) {
          micBtn.classList.toggle("live", active);
          $(".mic-lbl", micBtn).textContent = active ? "Listening… release to stop" : "Hold to talk";
          if (active) vibrate(30);
        },
      });
      const down = (e) => {
        e.preventDefault();
        if (ui.submitted) return;
        try { micBtn.setPointerCapture?.(e.pointerId); } catch {}
        input.blur();
        speech.start();
      };
      const up = (e) => { e?.preventDefault?.(); speech.stop(); };
      micBtn.addEventListener("pointerdown", down);
      micBtn.addEventListener("pointerup", up);
      micBtn.addEventListener("pointercancel", up);
      micBtn.addEventListener("lostpointercapture", up);
      micBtn.addEventListener("contextmenu", (e) => e.preventDefault());
      micBtn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
      micBtn.addEventListener("touchend", (e) => { e.preventDefault(); up(); }, { passive: false });
    }

    return {
      update() {
        setHTML($(".g-hud", el), hudHTML());
        setHTML($(".s-cat", el), categoryHTML());
        setHTML($(".s-board", el), boardHTML());
      },
      destroy() { speech?.abort(); draft.cancel(); },
    };
  },

  results(el) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      if (b.dataset.act === "next") { send({ t: "next" }); b.disabled = true; setTimeout(() => (b.disabled = false), 2000); }
      if (b.dataset.act === "again") { send({ t: "playAgain" }); b.disabled = true; setTimeout(() => (b.disabled = false), 2000); }
    });
    return {
      update() {
        let head = "";
        const host = isHost();
        let btn = "";
        if (s.phase === "roundEnd") {
          head = `<h2>Round ${esc(s.round)} complete</h2>`;
          btn = host ? `<button class="btn primary xl" data-act="next">Next round</button>` : `<p class="muted center-text">Next round starts soon…</p>`;
        } else if (s.phase === "bonusEnd") {
          const bp = player(s.bonus?.playerId);
          head = `<h2>Bonus round</h2>${bp ? `<p class="center-text">${chip(bp)} <b>${bp.id === me ? "You" : esc(bp.name)}</b> played for ${money(s.bonus?.prize || 25000)}</p>` : ""}`;
          btn = host ? `<button class="btn primary xl" data-act="next">See final results</button>` : "";
        } else {
          const w = player(s.winners?.[0]?.id) || [...s.players].sort((a, b) => b.total - a.total)[0];
          head = `<div class="trophy">🏆</div><h2>${w ? (w.id === me ? "You win!" : esc(w.name) + " wins!") : "Game over"}</h2>`;
          btn = host ? `<button class="btn primary xl" data-act="again">Play again</button>` : `<p class="muted center-text">Waiting for the host to start a new game…</p>`;
        }
        setHTML(el, `
          ${hudHTML()}
          <div class="card result">${head}
            ${s.answer ? `<div class="answer"><small>${esc(s.category || "Answer")}</small><b>${esc(s.answer)}</b></div>` : ""}
            ${s.log ? `<p class="log">${esc(s.log)}</p>` : ""}
          </div>
          <h3>Standings</h3>
          ${standingsHTML()}
          <div class="res-actions">${btn}</div>`);
      },
    };
  },
};

function playersListHTML() {
  return `<ul class="players">${s.players.map((p) => `<li class="${p.id === me ? "me" : ""}" style="--pc:${fixColor(p.color)}">
      ${chip(p)}<span class="nm">${esc(p.name)}</span>
      ${p.id === s.hostId ? `<span class="tag">host</span>` : ""}${p.id === me ? `<span class="tag you">you</span>` : ""}
      ${p.connected === false ? `<span class="off">offline</span>` : ""}</li>`).join("")}</ul>`;
}

// main area of the game screen, by phase
function mainHTML() {
  const myTurn = s.currentId === me;
  const cur = player(s.currentId);
  const curName = cur ? esc(cur.name) : "Someone";
  const p = mine();
  const waitCard = (title, sub, extra = "") => `
    <div class="wait-card" style="--pc:${fixColor(cur?.color)}">
      <div class="wc-title">${title}</div>
      ${sub ? `<div class="wc-sub">${sub}</div>` : ""}
      ${extra}
    </div>
    ${categoryHTML()}${boardHTML()}
    ${s.log ? `<p class="log">${esc(s.log)}</p>` : ""}`;

  switch (s.phase) {
    case "roundIntro":
      return waitCard(`Round ${esc(s.round)}`, "Get ready — look at the TV!");
    case "bonusIntro":
      return waitCard("Bonus round!", s.bonus?.playerId === me ? "You're playing for the big prize!" : `${esc(player(s.bonus?.playerId)?.name || "The leader")} plays for the big prize`);
    case "turn": {
      if (!myTurn) return waitCard(`${curName}'s turn`, "Deciding what to do…");
      const canSpin = s.consonantsLeft && !s.vowelsOnly;
      const canBuy = (p?.roundMoney || 0) >= 250 && s.vowelsLeft;
      const used = new Set(s.used || []);
      const vp = ui.vowelPicker && canBuy;
      return `
        <div class="your-turn">Your turn!</div>
        ${categoryHTML()}${boardHTML()}
        <div class="actions">
          ${canSpin
            ? `<button class="btn spin xl" data-act="spin">Spin the wheel</button>`
            : `<button class="btn spin xl" disabled>Vowels only</button>`}
          ${canBuy ? `<button class="btn vowel xl ${vp ? "open" : ""}" data-act="vowels">Buy a vowel <small>$250</small></button>` : ""}
          ${vp ? `<div class="vowel-pick">${VOWELS.map((v) => `<button class="key big" data-act="buy" data-l="${v}" ${used.has(v) ? "disabled" : ""}>${v}</button>`).join("")}</div>` : ""}
          <button class="btn solve xl" data-act="solve">Solve</button>
        </div>
        ${!canBuy && s.vowelsLeft ? `<p class="muted center-text small">Vowels cost $250 of round money</p>` : ""}
        ${usedHTML()}`;
    }
    case "spinning":
      if (myTurn) return `<div class="spinning"><div class="wheel-ico"></div><div class="wc-title">Spinning…</div><div class="wc-sub">Watch the TV!</div></div>${categoryHTML()}${boardHTML()}`;
      return waitCard(`${curName} is spinning…`, "Watch the TV!");
    case "pickConsonant": {
      const v = s.wedgeValue ?? s.wheel?.wedges?.[s.wheel?.index]?.v;
      if (!myTurn) return waitCard(`${curName}'s turn`, v ? `Picking a consonant for ${money(v)}` : "Picking a consonant…");
      const used = new Set(s.used || []);
      return `
        <div class="wedge-val"><b>${v ? money(v) : ""}</b> per letter</div>
        <p class="center-text muted">Pick a consonant</p>
        ${boardHTML()}
        ${keyboardHTML(CONSONANT_ROWS, { act: "guess", disabled: (l) => used.has(l) })}`;
    }
    case "revealing":
      return waitCard(myTurn ? "Revealing your letter…" : `${curName}'s turn`, "Watch the board!");
    case "solving": {
      const sp = player(solverId());
      const live = s.solve?.text ? `<div class="live-solve">“${esc(s.solve.text)}”</div>` : "";
      return waitCard(`${esc(sp?.name || curName)} is solving…`, "Fingers crossed!", live);
    }
    case "bonusPick": {
      if (s.bonus?.playerId !== me) {
        return waitCard("Watch the TV!", `${esc(player(s.bonus?.playerId)?.name || "The bonus player")} is choosing letters`);
      }
      const key = `${s.round}:${s.bonus?.playerId}`;
      if (ui.bonusKey !== key) { ui.bonusKey = key; ui.bonusConsonants = []; ui.bonusVowel = null; }
      const given = new Set(s.bonus?.given || BONUS_GIVEN);
      const cRows = CONSONANT_ROWS.map((r) => r.filter((l) => !given.has(l)));
      const slots = [0, 1, 2].map((i) => `<span class="slot ${ui.bonusConsonants[i] ? "f" : ""}">${ui.bonusConsonants[i] || ""}</span>`).join("")
        + `<span class="plus">+</span><span class="slot v ${ui.bonusVowel ? "f" : ""}">${ui.bonusVowel || ""}</span>`;
      const ready = ui.bonusConsonants.length === 3 && ui.bonusVowel;
      return `
        <div class="your-turn">Pick your letters</div>
        <p class="center-text muted small">R S T L N E are free. Choose 3 consonants + 1 vowel.</p>
        <div class="slots">${slots}</div>
        ${keyboardHTML(cRows, { act: "bc", selected: (l) => ui.bonusConsonants.includes(l) })}
        <div class="vowel-pick">${VOWELS.filter((v) => !given.has(v)).map((v) => `<button class="key big ${ui.bonusVowel === v ? "sel" : ""}" data-act="bv" data-l="${v}">${v}</button>`).join("")}</div>
        <button class="btn primary xl" data-act="bonusConfirm" ${ready ? "" : "disabled"}>${ready ? "Confirm letters" : "Confirm"}</button>`;
    }
    case "bonusReveal":
      return waitCard("Watch the TV!", "Revealing the bonus letters…");
    case "bonusSolve": {
      const live = s.solve?.text ? `<div class="live-solve">“${esc(s.solve.text)}”</div>` : "";
      return waitCard("Watch the TV!", `${esc(player(s.bonus?.playerId)?.name || "The bonus player")} is solving the bonus puzzle`, live);
    }
    default:
      return waitCard("Watch the TV!", "");
  }
}

// ---------------------------------------------------------------- incoming
let lastTurnBuzz = 0;
function buzzMyTurn() {
  if (Date.now() - lastTurnBuzz < 1500) return;
  lastTurnBuzz = Date.now();
  vibrate([80, 40, 80]);
}

function onState(next) {
  const prev = s;
  s = next;
  // learn my id from the roster if the welcome after join didn't carry it
  if (!me && pendingJoin && s.players) {
    const p = s.players.find((x) => x.name === pendingJoin.name && x.color === pendingJoin.color);
    if (p) { me = p.id; try { localStorage.setItem("sns:" + room, me); } catch {} }
  }
  if (me && mine()) pendingJoin = null;
  if (prev && s.phase === "turn" && s.currentId === me && !(prev.phase === "turn" && prev.currentId === me)) buzzMyTurn();
  if (!(s.phase === "turn" && s.currentId === me)) ui.vowelPicker = false;
  render();
}

function onWelcome(msg) {
  if (msg.playerId) { me = msg.playerId; pendingJoin = null; }
  else if (!pendingJoin) me = null;
  render();
}

function onEvent(msg) {
  const e = msg.e;
  const who = player(msg.playerId);
  const isMe = msg.playerId && msg.playerId === me;
  switch (e) {
    case "turn": if (isMe) { buzzMyTurn(); toast("Your turn!", "good"); } break;
    case "miss": {
      vibrate(120);
      const cur = s?.currentId === me;
      toast(msg.reason === "used" ? `${msg.letter} was already called` : `No ${msg.letter}${cur ? "" : "s"} in the puzzle`, cur ? "bad" : "");
      break;
    }
    case "reveal":
      if (s?.currentId === me && msg.count) toast(`${msg.count} × ${msg.letter}${msg.earned ? " — +" + money(msg.earned) : ""}`, "good");
      break;
    case "bankrupt":
      if (isMe) { shake(); vibrate([200, 60, 200]); toast(`Bankrupt! You lost ${money(msg.lost)}`, "bad"); }
      else if (who) toast(`${who.name} went bankrupt`);
      break;
    case "loseTurn":
      if (isMe) { vibrate(150); toast("Lose a turn!", "bad"); } else if (who) toast(`${who.name} loses a turn`);
      break;
    case "timeout":
      if (isMe) { vibrate(150); toast("Time's up!", "bad"); }
      break;
    case "solveRight":
      if (isMe) { celebrate(); vibrate([60, 40, 60, 40, 200]); toast(`Solved! Banked ${money(msg.banked)}`, "good"); }
      else { if (who) toast(`${who.name} solved it!`); }
      break;
    case "solveWrong":
      if (isMe) { vibrate(150); toast("Not quite — turn passes", "bad"); } else if (who) toast(`${who.name} guessed wrong`);
      break;
    case "bonusResult":
      if (s?.bonus?.playerId === me && msg.won) celebrate();
      toast(msg.won ? `Bonus won: ${money(msg.prize)}!` : "Bonus not solved this time", msg.won ? "good" : "");
      break;
    case "roundStart":
      toast(`Round ${msg.round}`);
      break;
  }
}

function onError(msg) {
  toast(msg.msg || msg.code || "Something went wrong", "bad");
  vibrate(100);
  // drop optimistic UI (pressed keys, "Sent!" buttons) by forcing a fresh render
  document.querySelectorAll(".g-main, .screen-results").forEach((e) => { e._html = null; });
  ui.submitted = false;
  if (s) render();
}

function onStatus(st) { status = st; renderTop(); }

// ---------------------------------------------------------------- boot
async function boot() {
  requestAnimationFrame(tickCountdowns);
  document.addEventListener("contextmenu", (e) => { if (e.target.closest(".key,.btn,.sw")) e.preventDefault(); });
  if (mockParam) {
    if (!room) room = "TEST";
    net = startMock(mockParam);
    return;
  }
  if (!room) { status = "idle"; render(); return; }
  try { me = localStorage.getItem("sns:" + room) || null; } catch {}
  render();
  net = connect(room, { role: "player", onState, onEvent, onWelcome, onError, onStatus });
}


// ---------------------------------------------------------------- mock mode (/play/?mock=turn etc.)
// Renders canned snapshots without a server. Intents are echoed as toasts and drive a tiny fake state machine.
const MOCK_SCREENS = {
  code: "Room code entry", join: "Join (name + colour)", lobby: "Lobby (host)", lobbyguest: "Lobby (guest)",
  turn: "My turn", turnpoor: "My turn, no money / vowels only", spinning: "Spinning (me)", pick: "Pick consonant",
  wait: "Someone else's turn", othersolve: "Someone else solving", solve: "Solve (me)",
  bonus: "Bonus pick (me)", bonuswait: "Bonus pick (other)", bonussolve: "Bonus solve (me)",
  roundend: "Round end (host)", bonusend: "Bonus end", gameover: "Game over (host)", spectate: "Spectator",
  reconnect: "Reconnecting banner",
};

function mockBoard(answer, revealed) {
  const widths = [12, 14, 14, 12];
  const words = answer.split(" ");
  const lines = [];
  let i = 0;
  for (const w of [14, 14]) {
    if (i >= words.length) break;
    let line = words[i++];
    while (i < words.length && line.length + 1 + words[i].length <= w) line += " " + words[i++];
    lines.push(line);
  }
  const rows = widths.map((w) => Array(w).fill(null));
  lines.forEach((line, k) => {
    const r = k + 1, w = widths[r], pad = Math.floor((w - line.length) / 2);
    [...line].forEach((ch, j) => {
      if (ch === " ") return;
      rows[r][pad + j] = /[A-Z]/.test(ch) ? (revealed.includes(ch) ? { k: "letter", ch } : { k: "blank" }) : { k: "punct", ch };
    });
  });
  return rows;
}

function startMock(kind) {
  const colors = ["#ef476f", "#ffd166", "#06d6a0", "#4cc9f0", "#9b5de5", "#f78c6b", "#f15bb5", "#c5e063"];
  const players = [
    { id: "p1", name: "Parker", color: colors[3], connected: true, roundMoney: 1450, total: 3200 },
    { id: "p2", name: "Maya", color: colors[0], connected: true, roundMoney: 650, total: 5100 },
    { id: "p3", name: "Jonas", color: colors[2], connected: false, roundMoney: 0, total: 1000 },
    { id: "p4", name: "Priya", color: colors[4], connected: true, roundMoney: 300, total: 0 },
  ];
  const ANSWER = "A PENNY FOR YOUR THOUGHTS";
  const wedges = [];
  for (let i = 0; i < 24; i++) wedges.push(i === 0 ? { k: "cash", v: 2500 } : i === 6 || i === 18 ? { k: "bankrupt" } : i === 12 ? { k: "lose" } : { k: "cash", v: 300 + (i % 7) * 100 });
  const used = ["T", "R", "E", "N"];
  const base = () => ({
    room: "TEST", serverNow: Date.now(), phase: "turn", hostId: "p1", colors, customCount: 0,
    players: JSON.parse(JSON.stringify(players)), round: 2, totalRounds: 4, category: "Phrase",
    board: mockBoard(ANSWER, used), used: [...used], vowelsLeft: true, consonantsLeft: true, vowelsOnly: false,
    currentId: "p1", deadline: Date.now() + 20000, deadlineKind: "turn",
    wheel: { wedges, index: 3 }, wedgeValue: null, solve: null, bonus: null, log: "Parker found 2 Ns for $1,300", winners: [],
  });
  let st = base();
  let myId = "p1";
  const k = kind === "1" ? "menu" : kind;
  const set = (patch) => Object.assign(st, patch);

  switch (k) {
    case "menu": {
      app.innerHTML = `<section class="screen"><div class="brand small"><div class="logo">Spin <span>&amp;</span> Solve</div><p>Mock screens</p></div>
        <ul class="mock-menu">${Object.entries(MOCK_SCREENS).map(([key, label]) => `<li><a class="btn" href="/play/?mock=${key}">${label}</a></li>`).join("")}</ul></section>`;
      $("#top").hidden = true;
      return { send() {}, now: () => Date.now(), forget() {} };
    }
    case "code": room = ""; render(); return { send() {}, now: () => Date.now(), forget() {} };
    case "join": myId = null; set({ phase: "lobby", players: st.players.slice(1, 3), hostId: "p2", round: 1, currentId: null, deadline: null, deadlineKind: null, board: [], category: "" }); break;
    case "lobby": set({ phase: "lobby", round: 1, currentId: null, deadline: null, deadlineKind: null, board: [], category: "", customCount: 3 }); break;
    case "lobbyguest": myId = "p3"; set({ phase: "lobby", round: 1, currentId: null, deadline: null, deadlineKind: null, board: [], category: "" }); break;
    case "turn": break;
    case "turnpoor": set({ vowelsOnly: true, consonantsLeft: false }); st.players[0].roundMoney = 200; break;
    case "spinning": set({ phase: "spinning", deadlineKind: "spin", deadline: Date.now() + 5000 }); break;
    case "pick": set({ phase: "pickConsonant", wedgeValue: 650, deadlineKind: "pick", deadline: Date.now() + 14000 }); break;
    case "wait": set({ currentId: "p2", log: "Maya bought an E — 3 of them!" }); break;
    case "othersolve": set({ phase: "solving", currentId: "p2", deadlineKind: "solve", deadline: Date.now() + 22000, solve: { playerId: "p2", text: "A PENNY FOR YOUR TH", source: "voice", final: false } }); break;
    case "solve": set({ phase: "solving", deadlineKind: "solve", deadline: Date.now() + 30000, solve: { playerId: "p1", text: "", source: "typed", final: false } }); break;
    case "bonus": case "bonuswait": case "bonussolve": {
      const given = ["R", "S", "T", "L", "N", "E"];
      set({ round: "bonus", phase: k === "bonussolve" ? "bonusSolve" : "bonusPick", category: "Thing", currentId: "p1",
        board: mockBoard("LUCKY HORSESHOE", given), used: given,
        bonus: { playerId: k === "bonuswait" ? "p2" : "p1", given, picks: [], prize: 25000 },
        deadlineKind: k === "bonussolve" ? "bonusSolve" : null, deadline: k === "bonussolve" ? Date.now() + 15000 : null, log: "" });
      break;
    }
    case "roundend": set({ phase: "roundEnd", answer: ANSWER, deadlineKind: "roundEnd", deadline: Date.now() + 8000, log: "Maya solved it and banked $1,000!" }); break;
    case "bonusend": set({ round: "bonus", phase: "bonusEnd", category: "Thing", answer: "LUCKY HORSESHOE", bonus: { playerId: "p1", given: [], picks: ["C", "K", "H", "O"], prize: 25000 }, log: "Parker solved the bonus puzzle and won $25,000!" }); break;
    case "gameover": set({ phase: "gameOver", answer: "LUCKY HORSESHOE", category: "Thing", winners: [{ id: "p2", total: 5100 }, { id: "p1", total: 3200 }], log: "Maya wins with $5,100!" }); break;
    case "spectate": myId = "zz"; break;
    case "reconnect": break;
  }

  const h = { onState, onEvent, onWelcome };
  const push = () => { st.serverNow = Date.now(); h.onState(JSON.parse(JSON.stringify(st))); };
  const later = (ms, fn) => setTimeout(() => { fn(); push(); }, ms);
  const pl = () => st.players.find((p) => p.id === myId);

  const fake = {
    now: () => Date.now(),
    forget() {},
    send(msg) {
      console.log("[mock] send", msg);
      if (msg.t !== "solveDraft") toast("→ " + msg.t + (msg.letter ? " " + msg.letter : ""), "mock");
      const v = (n) => Date.now() + n;
      switch (msg.t) {
        case "join": {
          myId = "p9";
          st.players.push({ id: "p9", name: msg.name, color: msg.color, connected: true, roundMoney: 0, total: 0 });
          h.onWelcome({ t: "welcome", role: "player", playerId: "p9", room: "TEST" }); break;
        }
        case "update": Object.assign(pl(), msg.name ? { name: msg.name } : {}, msg.color ? { color: msg.color } : {}); break;
        case "leave": st.players = st.players.filter((p) => p.id !== myId); myId = null; break;
        case "start": set({ ...base(), phase: "turn" }); break;
        case "spin":
          set({ phase: "spinning", deadline: v(4000), deadlineKind: "spin" });
          later(1500, () => set({ phase: "pickConsonant", wedgeValue: 650, deadline: v(20000), deadlineKind: "pick" }));
          break;
        case "guess": {
          st.used.push(msg.letter);
          const n = ANSWER.split(msg.letter).length - 1;
          if (n) pl().roundMoney += 650 * n; else h.onEvent({ t: "ev", e: "miss", letter: msg.letter, reason: "absent" });
          if (n) h.onEvent({ t: "ev", e: "reveal", letter: msg.letter, count: n, earned: 650 * n });
          set({ phase: "turn", board: mockBoard(ANSWER, st.used), deadline: v(20000), deadlineKind: "turn" });
          break;
        }
        case "buyVowel":
          st.used.push(msg.letter); pl().roundMoney -= 250;
          set({ board: mockBoard(ANSWER, st.used), vowelsLeft: ["A", "E", "I", "O", "U"].some((x) => !st.used.includes(x)), deadline: v(20000) });
          break;
        case "solveStart": set({ phase: "solving", solve: { playerId: myId, text: "", source: "typed", final: false }, deadline: v(30000), deadlineKind: "solve" }); break;
        case "solveDraft": st.solve = { playerId: myId, text: msg.text, source: msg.source, final: !!msg.final }; return;
        case "solveCancel": set({ phase: "turn", solve: null, deadline: v(20000), deadlineKind: "turn" }); break;
        case "solveSubmit":
          if (st.phase === "bonusSolve") { set({ phase: "bonusEnd", answer: "LUCKY HORSESHOE", log: "Bonus solved!" }); h.onEvent({ t: "ev", e: "bonusResult", won: true, prize: 25000 }); break; }
          pl().total += Math.max(1000, pl().roundMoney);
          h.onEvent({ t: "ev", e: "solveRight", playerId: myId, banked: Math.max(1000, pl().roundMoney) });
          set({ phase: "roundEnd", answer: ANSWER, board: mockBoard(ANSWER, [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]), solve: null, deadline: v(8000), deadlineKind: "roundEnd", log: "You solved it!" });
          break;
        case "bonusPick":
          st.used.push(...msg.consonants, msg.vowel);
          set({ phase: "bonusReveal", board: mockBoard("LUCKY HORSESHOE", st.used), deadline: null, deadlineKind: null });
          later(1500, () => set({ phase: "bonusSolve", deadline: v(15000), deadlineKind: "bonusSolve" }));
          break;
        case "next": set(st.phase === "roundEnd" ? { ...base(), round: 3 } : { phase: "gameOver", winners: [] }); break;
        case "playAgain": set({ ...base(), phase: "lobby", currentId: null, deadline: null, deadlineKind: null, board: [], category: "" }); break;
      }
      push();
    },
  };
  net = fake;
  h.onWelcome({ t: "welcome", role: "player", playerId: myId, room: "TEST" });
  me = myId;
  status = k === "reconnect" ? "closed" : "open";
  push();
  if (k === "turn") setTimeout(() => h.onEvent({ t: "ev", e: "turn", playerId: "p1" }), 300);
  return fake;
}

boot();
