#!/usr/bin/env node
// Converts a tab-separated show puzzle list (PUZZLE, CATEGORY, DATE, EP#, ROUND) into
// puzzles/src/50-show.json, keeping only puzzles the board can display.
// Usage: node scripts/import-show.mjs path/to/wheel-puzzles.txt
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { layout, normaliseAnswer, VALID_ANSWER } from "../src/game/board.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/import-show.mjs <puzzles.txt>");
  process.exit(1);
}

const MULTI_WORD = new Set(["Phrase", "Before & After", "Rhyme Time", "Same Name", "What Are You Doing?", "Quotation"]);
const skipped = {};
const skip = (why) => (skipped[why] = (skipped[why] || 0) + 1);

// Round codes: T1-T3 / TT1-TT3 toss-ups, R1-R7 rounds (* prize puzzle, ^ crossword), BR bonus.
function difficultyFor(round) {
  if (round === "BR") return "hard";
  const n = Number(round.replace(/\D/g, ""));
  if (round.startsWith("T") || n <= 2) return "easy";
  return "medium";
}

const out = [];
const seen = new Set();
for (const raw of readFileSync(src, "utf8").split(/\r?\n/)) {
  const cols = raw.split("\t");
  if (cols.length < 5 || !cols[3].startsWith("#")) continue; // headers, season markers, blank lines
  const [puzzle, category, , , round] = cols.map((c) => c.trim());
  if (round.includes("^")) { skip("crossword round"); continue; }
  if (/[a-z()]/.test(puzzle)) { skip("not a board puzzle"); continue; }
  // The board has no tiles for periods, commas or colons; dropping them keeps the puzzle readable.
  const answer = normaliseAnswer(puzzle.replace(/[.,]/g, "").replace(/:/g, " "));
  if (!VALID_ANSWER.test(answer) || !/[A-Z]/.test(answer)) { skip("digits or symbols"); continue; }
  const cat = category.replace(/\s+/g, " ").trim();
  if (!cat || cat.includes("_") || cat.length > 30) { skip("odd category"); continue; }
  if (MULTI_WORD.has(cat) && !answer.includes(" ")) { skip("one word in phrase category"); continue; }
  if (!layout(answer)) { skip("too long for the board"); continue; }
  const key = answer.replace(/[^A-Z]/g, "");
  if (seen.has(key)) { skip("repeat"); continue; }
  seen.add(key);
  const p = { category: cat, answer, difficulty: difficultyFor(round), source: "show" };
  if (round === "BR") p.bonus = true;
  out.push(p);
}

writeFileSync(join(root, "puzzles/src/50-show.json"), "[\n" + out.map((p) => JSON.stringify(p)).join(",\n") + "\n]\n");
console.log(`Imported ${out.length} show puzzles (${out.filter((p) => p.bonus).length} bonus-round) into puzzles/src/50-show.json`);
console.log("Skipped:", skipped);
