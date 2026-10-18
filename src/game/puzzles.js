// Stock puzzle library + selection (custom pack first, then unused stock, by seeded RNG).
import data from "../../puzzles/puzzles.json" with { type: "json" };
import { randInt } from "./wheel.js";

export const STOCK = data;

export const PUZZLE_SOURCES = ["show", "original", "mix"];

export const puzzleKey = (answer) => String(answer).toUpperCase().replace(/[^A-Z]/g, "");

/**
 * Pick a puzzle for `round` (1..4 or "bonus"). Mutates holder.rng.
 * custom: custom pack puzzles; used: array of puzzleKeys already played in this room.
 * source: "show" (puzzles from the TV show), "original" (written for this game) or "mix".
 */
export function pickPuzzle(holder, round, { custom = [], used = [], stock = STOCK, source = "mix" } = {}) {
  const usedSet = new Set(used);
  const unused = (list) => list.filter((p) => !usedSet.has(puzzleKey(p.answer)));
  const fromSource = source === "show" ? stock.filter((p) => p.source === "show")
    : source === "original" ? stock.filter((p) => p.source !== "show")
    : stock;
  const library = fromSource.length ? fromSource : stock;
  let pool = unused(custom);
  if (!pool.length) pool = unused(library);
  if (!pool.length) pool = library.slice(); // library exhausted: allow repeats
  // Narrow by round, but only when something is left after narrowing.
  const narrow = (...tests) => {
    for (const t of tests) {
      const hit = pool.filter(t);
      if (hit.length) { pool = hit; return; }
    }
  };
  if (round === "bonus") narrow((p) => p.bonus, (p) => p.answer.split(" ").length <= 3);
  else {
    narrow((p) => !p.bonus); // the show's bonus puzzles are saved for the bonus round
    if (round <= 2) narrow((p) => p.difficulty !== "hard");
  }
  const p = pool[randInt(holder, pool.length)];
  return { category: p.category, answer: p.answer, custom: !!p.custom };
}
