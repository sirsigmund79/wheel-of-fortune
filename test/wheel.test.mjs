import test from "node:test";
import assert from "node:assert/strict";
import { WEDGES, mulberry32, rand, spinWheel, shuffle } from "../src/game/wheel.js";

test("24 wedges with the right mix", () => {
  assert.equal(WEDGES.length, 24);
  const cash = WEDGES.filter((w) => w.k === "cash");
  assert.equal(cash.filter((w) => w.v >= 300 && w.v <= 900).length, 20);
  assert.equal(cash.filter((w) => w.v === 2500).length, 1);
  assert.equal(WEDGES.filter((w) => w.k === "bankrupt").length, 2);
  assert.equal(WEDGES.filter((w) => w.k === "lose").length, 1);
});

test("specials are not adjacent (wrapping)", () => {
  for (let i = 0; i < 24; i++) {
    const a = WEDGES[i], b = WEDGES[(i + 1) % 24];
    const special = (w) => w.k !== "cash" || w.v === 2500;
    assert.ok(!(special(a) && special(b)), `wedges ${i} and ${(i + 1) % 24} are both special`);
  }
});

test("rng is deterministic and roughly uniform", () => {
  assert.deepEqual(mulberry32(123), mulberry32(123));
  const h = { rng: 99 };
  const counts = new Array(24).fill(0);
  const N = 48000;
  for (let i = 0; i < N; i++) {
    const s = spinWheel(h);
    counts[s.index]++;
    assert.ok(s.turns >= 3 && s.turns <= 5);
    assert.ok(s.duration >= 3000 && s.duration <= 6000);
  }
  for (const c of counts) assert.ok(Math.abs(c - N / 24) < N / 24 * 0.15, `count ${c}`);
  const x = rand({ rng: 1 });
  assert.ok(x >= 0 && x < 1);
  assert.deepEqual(shuffle({ rng: 5 }, [1, 2, 3, 4]).sort(), [1, 2, 3, 4]);
});
