#!/usr/bin/env node
// Merges puzzles/src/*.json into puzzles/puzzles.json (dedupes by letters, keeps first).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normaliseAnswer } from "../src/game/board.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "puzzles/src");
const out = [];
const seen = new Set();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  for (const p of JSON.parse(readFileSync(join(dir, f), "utf8"))) {
    const answer = normaliseAnswer(p.answer);
    const key = answer.replace(/[^A-Z]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const q = { category: p.category, answer, difficulty: p.difficulty || "medium" };
    if (p.source === "show") q.source = "show"; // absent = original
    if (p.bonus) q.bonus = true; // was a bonus-round puzzle on the show
    out.push(q);
  }
}
writeFileSync(join(root, "puzzles/puzzles.json"), JSON.stringify(out, null, 0).replace(/},{/g, "},\n{") + "\n");
console.log(`Merged ${out.length} puzzles into puzzles/puzzles.json`);
