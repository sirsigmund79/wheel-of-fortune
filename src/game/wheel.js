// The 24-wedge wheel and a tiny seeded RNG (mulberry32) whose state lives in the game state.

const cash = (v) => ({ k: "cash", v });
const BANKRUPT = { k: "bankrupt" };
const LOSE = { k: "lose" };

// 20 cash wedges ($300–$900), one $2500, two BANKRUPT, one LOSE A TURN — specials spread around.
export const WEDGES = Object.freeze([
  cash(2500), cash(350), cash(600), cash(500), cash(300), BANKRUPT,
  cash(650), cash(400), cash(900), cash(300), cash(550), LOSE,
  cash(800), cash(450), cash(700), cash(300), cash(600), BANKRUPT,
  cash(500), cash(350), cash(850), cash(400), cash(750), cash(500),
].map((w) => Object.freeze(w)));

export const SPIN_DURATION = 4500;

// mulberry32 step: takes a 32-bit state, returns [float in [0,1), nextState].
export function mulberry32(a) {
  a = (a + 0x6d2b79f5) | 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

// Draw a float from an object holding `rng` (the game state), advancing it.
export function rand(holder) {
  const [x, next] = mulberry32(holder.rng | 0);
  holder.rng = next;
  return x;
}

export function randInt(holder, n) {
  return Math.floor(rand(holder) * n);
}

export function shuffle(holder, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(holder, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Decide a spin: landing wedge index, full rotations (3–5) and animation duration.
export function spinWheel(holder) {
  const index = randInt(holder, WEDGES.length);
  const turns = 3 + randInt(holder, 3);
  return { index, turns, duration: SPIN_DURATION, wedge: WEDGES[index] };
}
