// Shared helpers. Zero dependencies.
const fs = require("fs");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// Non-blank, non-comment lines. Same rule slopbench uses, so numbers are comparable.
const loc = (code) =>
  code
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("#");
    }).length;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// necessary_tokens is a number (all models) or an object keyed by model.
function necessaryFor(ref, model) {
  const n = ref.necessary_tokens;
  if (typeof n === "number") return n;
  return n[model] != null ? n[model] : n.default;
}

// USD for one run, from the frozen price table.
function costOf(rec, price) {
  return (rec.tokens_in / 1e6) * price.in + (rec.tokens_out / 1e6) * price.out;
}

const round = (x, d = 2) => {
  const p = 10 ** d;
  return Math.round(x * p) / p;
};

module.exports = { readJson, loc, median, necessaryFor, costOf, round };
