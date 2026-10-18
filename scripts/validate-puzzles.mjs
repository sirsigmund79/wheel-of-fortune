#!/usr/bin/env node
// Validates puzzles/puzzles.json (or files passed as args). Exits 1 on any failure.
// Usage: node scripts/validate-puzzles.mjs [file.json ...]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { layout, normaliseAnswer, VALID_ANSWER } from "../src/game/board.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2);
if (!files.length) files.push(join(root, "puzzles/puzzles.json"));

export const CATEGORIES = [
  "Phrase", "Thing", "Things", "Place", "Person", "People", "Food & Drink", "Before & After",
  "Rhyme Time", "Same Name", "Title", "Fun & Games", "Event", "Around the House",
  "On the Map", "What Are You Doing?", "Occupation", "Living Thing", "Landmark",
  "Character", "Show Biz", "Proper Name", "Quotation",
];
// Categories where a one-word answer makes no sense.
const MULTI_WORD = new Set([
  "Phrase", "Before & After", "Rhyme Time", "Same Name", "What Are You Doing?", "Quotation",
]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

let failures = 0;
let total = 0;
const seen = new Map();
const perCategory = {};

function fail(file, i, p, why) {
  failures++;
  console.error(`✗ ${file}#${i} ${JSON.stringify(p?.answer)} (${p?.category}): ${why}`);
}

for (const file of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`✗ ${file}: cannot parse JSON: ${e.message}`);
    failures++;
    continue;
  }
  if (!Array.isArray(data)) { console.error(`✗ ${file}: top level must be an array`); failures++; continue; }
  data.forEach((p, i) => {
    total++;
    if (!p || typeof p.answer !== "string" || typeof p.category !== "string") return fail(file, i, p, "missing answer/category");
    if (p.answer !== p.answer.toUpperCase()) return fail(file, i, p, "answer must be uppercase");
    const a = normaliseAnswer(p.answer);
    if (a !== p.answer) return fail(file, i, p, "answer has extra/irregular whitespace");
    if (!VALID_ANSWER.test(a)) return fail(file, i, p, `illegal characters: ${[...new Set(a.replace(/[A-Z&'\-?! ]/g, ""))].join("")}`);
    if (!/[A-Z]/.test(a)) return fail(file, i, p, "no letters");
    // Show puzzles keep the show's own category names; originals use the fixed list.
    if (p.source === "show") {
      if (!p.category.trim() || p.category.length > 30) return fail(file, i, p, "bad category");
    } else if (!CATEGORIES.includes(p.category)) return fail(file, i, p, `unknown category`);
    if (p.difficulty !== undefined && !DIFFICULTIES.has(p.difficulty)) return fail(file, i, p, "difficulty must be easy|medium|hard");
    if (MULTI_WORD.has(p.category) && a.split(" ").length < 2) return fail(file, i, p, "needs 2+ words for this category");
    if (!layout(a)) return fail(file, i, p, "does not fit the 12/14/14/12 board");
    const key = a.replace(/[^A-Z]/g, "");
    if (seen.has(key)) return fail(file, i, p, `duplicate of ${seen.get(key)}`);
    seen.set(key, `${file.split("/").pop()}#${i}`);
    perCategory[p.category] = (perCategory[p.category] || 0) + 1;
  });
}

console.log(`Checked ${total} puzzles in ${files.length} file(s).`);
console.log(Object.entries(perCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `  ${c}: ${n}`).join("\n"));
if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("All puzzles valid ✓");
