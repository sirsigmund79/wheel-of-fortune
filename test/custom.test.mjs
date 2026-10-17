import test from "node:test";
import assert from "node:assert/strict";
import { parseCustomPack } from "../src/game/custom.js";

test("parses valid lines, skips blanks and comments", () => {
  const { puzzles, errors } = parseCustomPack("# family pack\n\nOur Dog | barky mcbarkface\r\nPlace|  grandma’s   kitchen  \n");
  assert.deepEqual(errors, []);
  assert.deepEqual(puzzles.map((p) => [p.category, p.answer]), [
    ["Our Dog", "BARKY MCBARKFACE"],
    ["Place", "GRANDMA'S KITCHEN"],
  ]);
});

test("reports errors with line numbers", () => {
  const text = [
    "no bar here",
    " | MISSING CATEGORY",
    "Thing | ",
    "Thing | R2D2",
    "Thing | SUPERCALIFRAGILISTIC",
    "Thing | ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE",
    "Thing | !!!",
    "Thing | GOOD ONE",
    "Thing | good one",
  ].join("\n");
  const { puzzles, errors } = parseCustomPack(text);
  assert.equal(puzzles.length, 1);
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 3, 4, 5, 6, 7, 9]);
  assert.match(errors[3].msg, /found: 2/);
  assert.match(errors[4].msg, /fit/);
});

test("empty input", () => {
  assert.deepEqual(parseCustomPack(""), { puzzles: [], errors: [] });
  assert.deepEqual(parseCustomPack(undefined), { puzzles: [], errors: [] });
});
