import test from "node:test";
import assert from "node:assert/strict";
import { judge, numberToWords, editDistance } from "../src/game/judge.js";

const yes = (g, a) => assert.equal(judge(g, a).ok, true, `expected "${g}" ≈ "${a}"`);
const no = (g, a) => assert.equal(judge(g, a).ok, false, `expected "${g}" ≠ "${a}"`);

test("exact and case/punctuation insensitive", () => {
  yes("baked potato", "BAKED POTATO");
  yes("  Baked   Potato!! ", "BAKED POTATO");
  yes("dont stop", "DON'T STOP");
  yes("don't stop", "DON'T STOP");
  yes("don’t stop", "DON'T STOP");
  yes("whats for dinner", "WHAT'S FOR DINNER?");
  yes("hide and seek", "HIDE-AND-SEEK");
  yes("rock and roll", "ROCK & ROLL");
  yes("rock & roll", "ROCK AND ROLL");
  assert.equal(judge("baked potato", "BAKED POTATO").score, 1);
});

test("small typos within per-word tolerance", () => {
  yes("baked potatoe", "BAKED POTATO");
  yes("grandfather clok", "GRANDFATHER CLOCK");
  yes("hummingbrid", "HUMMINGBIRD");
  yes("bluebery pancakes", "BLUEBERRY PANCAKES");
  no("cat", "CAR");
  no("the bat", "THE CAT");
  no("bakd potat", "BAKED POTATO" + " SALAD");
});

test("split / joined words", () => {
  yes("base ball", "BASEBALL");
  yes("baseball cap", "BASE BALL CAP");
  yes("hot dogs", "HOTDOGS");
  yes("zoo keeper", "ZOOKEEPER");
  yes("icecream sundae", "ICE CREAM SUNDAE");
});

test("optional leading article and filler words", () => {
  yes("public library", "THE PUBLIC LIBRARY");
  yes("the eiffel tower", "EIFFEL TOWER");
  yes("a penny for your thoughts", "A PENNY FOR YOUR THOUGHTS");
  yes("penny for your thoughts", "A PENNY FOR YOUR THOUGHTS");
  yes("um the public library", "THE PUBLIC LIBRARY");
  yes("uh uh walking the dog", "WALKING THE DOG");
});

test("numbers as digits", () => {
  assert.equal(numberToWords(0), "ZERO");
  assert.equal(numberToWords(42), "FORTY TWO");
  assert.equal(numberToWords(101), "ONE HUNDRED ONE");
  assert.equal(numberToWords(9999), "NINE THOUSAND NINE HUNDRED NINETY NINE");
  yes("101 dalmatians", "ONE HUNDRED ONE DALMATIANS");
  yes("101 dalmatians", "ONE HUNDRED AND ONE DALMATIANS");
  yes("one hundred and one dalmatians", "ONE HUNDRED ONE DALMATIANS");
  yes("7 dwarfs", "SEVEN DWARFS");
  yes("twenty-one candles", "TWENTY ONE CANDLES");
  yes("21 candles", "TWENTY-ONE CANDLES");
  yes("summer of 1999", "SUMMER OF NINETEEN NINETY-NINE");
  yes("2500 dollars", "TWO THOUSAND FIVE HUNDRED DOLLARS");
  no("8 dwarfs", "SEVEN DWARFS");
});

test("rejects wrong or missing words", () => {
  no("", "BAKED POTATO");
  no("um", "BAKED POTATO");
  no("baked", "BAKED POTATO");
  no("potato", "BAKED POTATO");
  no("mashed potato", "BAKED POTATO");
  no("make wish", "MAKE A WISH");
  no("better safe than sorry", "BETTER LATE THAN NEVER");
  no("better late never", "BETTER LATE THAN NEVER");
  no("slow and steady wins", "SLOW AND STEADY WINS THE RACE");
  no("birthday", "BIRTHDAY CAKE");
  no("night fight", "NIGHT LIGHT");
  no("funny money", "FUNNY BUNNY");
  no("completely different", "GRILLED CHEESE SANDWICH");
  no("baked potato extra", "BAKED POTATO");
});

test("edit distance", () => {
  assert.equal(editDistance("KITTEN", "SITTING"), 3);
  assert.equal(editDistance("", "ABC"), 3);
  assert.equal(editDistance("SAME", "SAME"), 0);
  assert.equal(editDistance("BIRD", "BRID"), 1); // transposition
});
