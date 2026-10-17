// Fuzzy solve matcher: forgiving of voice-transcription noise, strict about wrong/missing words.

const ONES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN",
  "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), "HUNDRED", "THOUSAND"]);
const FILLERS = new Set(["UM", "UMM", "UH", "UHH", "UHM", "ER", "ERM", "HMM"]);
const ARTICLES = new Set(["A", "AN", "THE"]);

function under100(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}

// Standard English words for 0–9999 (no "AND"; "AND" is canonicalised away anyway).
export function numberToWords(n) {
  if (n < 100) return under100(n);
  const parts = [];
  if (n >= 1000) parts.push(ONES[Math.floor(n / 1000)] + " THOUSAND");
  const h = Math.floor((n % 1000) / 100);
  if (h) parts.push(ONES[h] + " HUNDRED");
  if (n % 100) parts.push(under100(n % 100));
  return parts.join(" ");
}

// All acceptable spellings of a digit string (years like 1999 also as NINETEEN NINETY NINE).
function numberVariants(digits) {
  const n = Number(digits);
  if (!Number.isInteger(n) || n > 9999) return [digits];
  const out = [numberToWords(n)];
  if (n >= 1100 && n % 1000 !== 0) {
    const hi = Math.floor(n / 100), lo = n % 100;
    const tail = lo === 0 ? "HUNDRED" : lo < 10 ? "OH " + ONES[lo] : under100(lo);
    out.push(under100(hi) + " " + tail);
  }
  if (n >= 100 && n < 1000 && n % 100) {
    // e.g. 101 -> "ONE OH ONE"
    const lo = n % 100;
    out.push(ONES[Math.floor(n / 100)] + " " + (lo < 10 ? "OH " + ONES[lo] : under100(lo)));
  }
  return [...new Set(out)];
}

// Normalise a string into a list of candidate word arrays (several only when it contains numbers).
export function normalise(text) {
  let s = String(text ?? "").toUpperCase();
  s = s.replace(/&/g, " AND ").replace(/['’‘`]/g, "");
  s = s.replace(/[^A-Z0-9]+/g, " ").trim();
  // Split digits from letters ("101DALMATIANS").
  s = s.replace(/([A-Z])(\d)/g, "$1 $2").replace(/(\d)([A-Z])/g, "$1 $2");
  let variants = [""];
  for (const tok of s.split(" ").filter(Boolean)) {
    const opts = /^\d+$/.test(tok) ? numberVariants(tok) : [tok];
    const next = [];
    for (const v of variants) for (const o of opts) next.push(v ? v + " " + o : o);
    variants = next.slice(0, 16);
  }
  return variants.map((v) => canonical(v.split(" ").filter(Boolean)));
}

function canonical(words) {
  // Drop leading filler words.
  let i = 0;
  while (i < words.length - 1 && FILLERS.has(words[i])) i++;
  words = words.slice(i);
  // "HUNDRED AND ONE" -> "HUNDRED ONE".
  const out = [];
  for (let k = 0; k < words.length; k++) {
    if (words[k] === "AND" && (out.at(-1) === "HUNDRED" || out.at(-1) === "THOUSAND") && NUMBER_WORDS.has(words[k + 1])) continue;
    out.push(words[k]);
  }
  return out;
}

export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  // Optimal string alignment distance (Levenshtein + adjacent transpositions).
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

// Allowed edits for an answer word (or joined group of words) of this length.
export function wordTolerance(len) {
  return len <= 3 ? 0 : len <= 6 ? 1 : 2;
}

// Align answer words with guess words, allowing a group of up to 3 words on one side to match
// up to 3 joined words on the other (BASE BALL ~ BASEBALL). Returns minimal total edits or Infinity.
function alignEdits(ans, guess) {
  const A = ans.length, G = guess.length;
  const best = Array.from({ length: A + 1 }, () => new Array(G + 1).fill(Infinity));
  best[0][0] = 0;
  for (let i = 0; i <= A; i++) {
    for (let j = 0; j <= G; j++) {
      const base = best[i][j];
      if (base === Infinity) continue;
      for (let da = 1; da <= 3 && i + da <= A; da++) {
        for (let dg = 1; dg <= 3 && j + dg <= G; dg++) {
          if (da > 1 && dg > 1) continue; // only 1:n or n:1 groupings
          const a = ans.slice(i, i + da).join("");
          const g = guess.slice(j, j + dg).join("");
          const d = editDistance(a, g);
          // Joined/split groups get one less edit so a dropped short word ("A", "OF") can't hide in them.
          const tol = da === 1 && dg === 1 ? wordTolerance(a.length) : Math.max(0, wordTolerance(a.length) - 1);
          if (d > tol) continue;
          // A short word with a different first letter is a different word (NIGHT vs FIGHT).
          if (d > 0 && a.length <= 5 && a[0] !== g[0]) continue;
          if (base + d < best[i + da][j + dg]) best[i + da][j + dg] = base + d;
        }
      }
    }
  }
  return best[A][G];
}

function stripArticle(words) {
  return words.length > 1 && ARTICLES.has(words[0]) ? words.slice(1) : words;
}

/**
 * judge(guess, answer) -> { ok, score }  (score in [0,1], 1 = exact)
 */
export function judge(guess, answer) {
  const answers = normalise(answer);
  const guesses = normalise(guess);
  let bestScore = 0;
  let ok = false;
  for (const a0 of answers) {
    for (const g0 of guesses) {
      if (!g0.length) continue;
      const pairs = [[a0, g0], [stripArticle(a0), g0], [a0, stripArticle(g0)], [stripArticle(a0), stripArticle(g0)]];
      for (const [a, g] of pairs) {
        const letters = a.join("").length;
        if (!letters) continue;
        const joinedA = a.join(""), joinedG = g.join("");
        const whole = editDistance(joinedA, joinedG);
        bestScore = Math.max(bestScore, Math.max(0, 1 - whole / letters));
        if (whole === 0) return { ok: true, score: 1 };
        const edits = alignEdits(a, g);
        if (edits !== Infinity && edits <= Math.max(1, Math.floor(letters / 6))) ok = true;
      }
    }
  }
  return { ok, score: ok ? Math.max(bestScore, 0.5) : Math.min(bestScore, 0.99) };
}
