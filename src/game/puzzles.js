// Stock puzzle library + selection (custom pack first, then unused stock, by seeded RNG).
import data from "../../puzzles/puzzles.json" with { type: "json" };
import { randInt } from "./wheel.js";

export const STOCK = data;

export const puzzleKey = (answer) => String(answer).toUpperCase().replace(/[^A-Z]/g, "");

/**
 * Pick a puzzle for `round` (1..4 or "bonus"). Mutates holder.rng.
 * custom: custom pack puzzles; used: array of puzzleKeys already played in this room.
 */
export function pickPuzzle(holder, round, { custom = [], used = [], stock = STOCK } = {}) {
  const usedSet = new Set(used);
  const unused = (list) => list.filter((p) => !usedSet.has(puzzleKey(p.answer)));
  let pool = unused(custom);
  if (!pool.length) pool = unused(stock);
  if (!pool.length) pool = stock.slice(); // library exhausted: allow repeats
  let preferred;
  if (round === "bonus") preferred = pool.filter((p) => p.answer.split(" ").length <= 3);
  else if (round <= 2) preferred = pool.filter((p) => p.difficulty !== "hard");
  if (preferred?.length) pool = preferred;
  const p = pool[randInt(holder, pool.length)];
  return { category: p.category, answer: p.answer, custom: !!p.custom };
}
