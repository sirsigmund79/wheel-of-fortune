// Parse a host-supplied custom pack: one "Category | ANSWER" per line. Blank lines and #comments skipped.
import { layout, normaliseAnswer, VALID_ANSWER } from "./board.js";

export const MAX_CUSTOM = 100;

export function parseCustomPack(text) {
  const puzzles = [];
  const errors = [];
  const seen = new Set();
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const bar = trimmed.indexOf("|");
    if (bar < 0) return errors.push({ line, msg: 'Use "Category | ANSWER"' });
    const category = trimmed.slice(0, bar).trim().replace(/\s+/g, " ");
    const answer = normaliseAnswer(trimmed.slice(bar + 1).replace(/[’‘`]/g, "'").replace(/[–—]/g, "-"));
    if (!category) return errors.push({ line, msg: "Missing category" });
    if (category.length > 24) return errors.push({ line, msg: "Category too long (max 24 characters)" });
    if (!answer) return errors.push({ line, msg: "Missing answer" });
    if (!VALID_ANSWER.test(answer)) {
      const bad = [...new Set(answer.replace(/[A-Z&'\-?! ]/g, ""))].join(" ");
      return errors.push({ line, msg: `Letters, spaces and & ' - ? ! only (found: ${bad})` });
    }
    if (!/[A-Z]/.test(answer)) return errors.push({ line, msg: "Answer needs at least one letter" });
    if (!layout(answer)) return errors.push({ line, msg: "Too long to fit on the board" });
    const key = answer.replace(/[^A-Z]/g, "");
    if (seen.has(key)) return errors.push({ line, msg: "Duplicate puzzle" });
    if (puzzles.length >= MAX_CUSTOM) return errors.push({ line, msg: `Pack limit is ${MAX_CUSTOM} puzzles` });
    seen.add(key);
    puzzles.push({ category, answer, difficulty: "medium", custom: true });
  });
  return { puzzles, errors };
}
