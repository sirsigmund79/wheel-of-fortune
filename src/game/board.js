// Board layout: 4 rows, widths 12/14/14/12. Shared by the Durable Object and the puzzle validator.

export const ROW_WIDTHS = [12, 14, 14, 12];
export const PUNCTUATION = new Set(["&", "'", "-", "?", "!"]);
export const VOWELS = new Set(["A", "E", "I", "O", "U"]);
export const VALID_ANSWER = /^[A-Z&'\-?! ]+$/;

// Which rows to use for an n-line puzzle (keeps short puzzles centred on the wide middle rows).
const PLACEMENTS = {
  1: [[1], [2]],
  2: [[1, 2]],
  3: [[0, 1, 2], [1, 2, 3]],
  4: [[0, 1, 2, 3]],
};

export function normaliseAnswer(answer) {
  return String(answer).toUpperCase().replace(/\s+/g, " ").trim();
}

// Greedy word wrap into the given row widths. Returns array of lines or null if it doesn't fit.
function wrap(words, widths) {
  const lines = [];
  let i = 0;
  for (const w of widths) {
    if (i >= words.length) break;
    if (words[i].length > w) return null;
    let line = words[i++];
    while (i < words.length && line.length + 1 + words[i].length <= w) line += " " + words[i++];
    lines.push(line);
  }
  return i >= words.length ? lines : null;
}

/**
 * Lay out an answer on the board.
 * Returns { rows: string[4] (each padded to its row width, ' ' = empty/space), lines } or null if it doesn't fit.
 * Inside `rows`, a space character means "no tile" (blank board cell or word gap).
 */
export function layout(answer) {
  const text = normaliseAnswer(answer);
  if (!text || !VALID_ANSWER.test(text)) return null;
  const words = text.split(" ");
  for (let n = 1; n <= 4; n++) {
    for (const rowsUsed of PLACEMENTS[n]) {
      const lines = wrap(words, rowsUsed.map((r) => ROW_WIDTHS[r]));
      if (!lines || lines.length !== n) continue;
      const rows = ROW_WIDTHS.map((w) => " ".repeat(w));
      rowsUsed.forEach((r, k) => {
        const w = ROW_WIDTHS[r];
        const pad = Math.floor((w - lines[k].length) / 2);
        rows[r] = (" ".repeat(pad) + lines[k]).padEnd(w, " ");
      });
      return { rows, lines };
    }
  }
  return null;
}

export function fits(answer) {
  return layout(answer) !== null;
}
