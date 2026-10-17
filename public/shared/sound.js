// Spin & Solve — synthesized sound effects (WebAudio only, no audio files).
// usage: import * as sfx from "/shared/sound.js"; sfx.unlock() inside a click handler, then sfx.tick() etc.

let ctx = null;
let master = null;
let muted = false;
let lastTick = 0;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
  }
  return ctx;
}

/** Call from a user gesture (click/tap). Resolves once audio can play. */
export function unlock() {
  const c = ac();
  if (!c) return Promise.resolve(false);
  // a silent blip primes iOS Safari
  const o = c.createOscillator();
  const g = c.createGain();
  g.gain.value = 0;
  o.connect(g).connect(master);
  o.start();
  o.stop(c.currentTime + 0.01);
  return c.resume().then(() => true, () => false);
}

export const isUnlocked = () => !!ctx && ctx.state === "running";
export function setMuted(m) { muted = !!m; if (master) master.gain.value = muted ? 0 : 0.55; }
export const isMuted = () => muted;

function ready() {
  const c = ac();
  return c && c.state === "running" && !muted ? c : null;
}

// One enveloped oscillator note.
function note(c, { freq, type = "sine", start = 0, dur = 0.2, vol = 0.3, attack = 0.005, slideTo, slideTime, detune = 0, dest = master }) {
  const t0 = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  o.detune.value = detune;
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + (slideTime ?? dur));
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(dest);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
  return o;
}

function noise(c, { start = 0, dur = 0.05, vol = 0.2, freq = 3000, q = 1, type = "bandpass" }) {
  const t0 = c.currentTime + start;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(t0);
}

/** Wheel peg click. Self-throttled so fast spins don't turn into a buzz. */
export function tick() {
  const c = ready(); if (!c) return;
  const now = performance.now();
  if (now - lastTick < 28) return;
  lastTick = now;
  noise(c, { dur: 0.025, vol: 0.5, freq: 2400, q: 3 });
  note(c, { freq: 1800, type: "square", dur: 0.02, vol: 0.05 });
}

/** Tile reveal ding (bright bell). */
export function ding() {
  const c = ready(); if (!c) return;
  note(c, { freq: 1568, type: "sine", dur: 0.9, vol: 0.28 });
  note(c, { freq: 3136, type: "sine", dur: 0.5, vol: 0.08 });
  note(c, { freq: 2350, type: "triangle", dur: 0.35, vol: 0.05 });
}

/** Wrong answer / absent letter. */
export function buzz() {
  const c = ready(); if (!c) return;
  note(c, { freq: 140, type: "sawtooth", dur: 0.55, vol: 0.22, attack: 0.01 });
  note(c, { freq: 147, type: "square", dur: 0.55, vol: 0.12, attack: 0.01 });
}

/** Descending "wah-wah" for BANKRUPT. */
export function bankrupt() {
  const c = ready(); if (!c) return;
  const steps = [392, 370, 349, 262];
  steps.forEach((f, i) => {
    const last = i === steps.length - 1;
    note(c, {
      freq: f, type: "sawtooth", start: i * 0.42, dur: last ? 1.1 : 0.4, vol: 0.18, attack: 0.03,
      slideTo: last ? f * 0.82 : f * 0.97, slideTime: last ? 1.0 : 0.38,
    });
    note(c, { freq: f / 2, type: "triangle", start: i * 0.42, dur: last ? 1.1 : 0.4, vol: 0.12, attack: 0.03 });
  });
}

/** Correct solve — bright rising fanfare. */
export function fanfare() {
  const c = ready(); if (!c) return;
  const seq = [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.36]];
  seq.forEach(([f, t]) => {
    note(c, { freq: f, type: "square", start: t, dur: 0.22, vol: 0.09 });
    note(c, { freq: f, type: "triangle", start: t, dur: 0.3, vol: 0.18 });
  });
  [523, 659, 784, 1047].forEach((f) => {
    note(c, { freq: f, type: "triangle", start: 0.55, dur: 1.3, vol: 0.12, attack: 0.02 });
    note(c, { freq: f * 2, type: "sine", start: 0.55, dur: 1.0, vol: 0.04, attack: 0.02 });
  });
  noise(c, { start: 0.55, dur: 0.6, vol: 0.15, freq: 7000, q: 0.6, type: "highpass" });
}

/** Turn change — two soft notes. */
export function turnChime() {
  const c = ready(); if (!c) return;
  note(c, { freq: 880, type: "sine", dur: 0.35, vol: 0.18 });
  note(c, { freq: 1175, type: "sine", start: 0.12, dur: 0.5, vol: 0.18 });
}

/** Countdown beep; final=true for the last second. */
export function countdownBeep(final = false) {
  const c = ready(); if (!c) return;
  note(c, { freq: final ? 1320 : 990, type: "square", dur: final ? 0.4 : 0.1, vol: 0.08 });
}

/** Game / round start jingle. */
export function startJingle() {
  const c = ready(); if (!c) return;
  const seq = [392, 523, 659, 784, 659, 784, 1047];
  seq.forEach((f, i) => {
    note(c, { freq: f, type: "triangle", start: i * 0.1, dur: i === seq.length - 1 ? 0.8 : 0.16, vol: 0.18 });
    note(c, { freq: f / 2, type: "sine", start: i * 0.1, dur: 0.18, vol: 0.08 });
  });
}

/** Little whoosh for the wheel launch / banners. */
export function whoosh() {
  const c = ready(); if (!c) return;
  noise(c, { dur: 0.45, vol: 0.25, freq: 900, q: 0.7 });
}

/** Soft pop for players joining. */
export function pop() {
  const c = ready(); if (!c) return;
  note(c, { freq: 600, type: "sine", dur: 0.15, vol: 0.2, slideTo: 1200, slideTime: 0.08 });
}
