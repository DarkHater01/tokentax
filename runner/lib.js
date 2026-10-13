// Shared helpers. Zero dependencies.
const fs = require("fs");
const path = require("path");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// Non-blank, non-comment lines. Same rule slopbench uses, so numbers are comparable.
const loc = (code) =>
  code
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("#");
    }).length;

// LOC of every .py file under a job dir, ignoring the hidden tests and conftest.
function dirLoc(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "_grade" || e.name === "conftest.py" || e.name === "out.xml") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".py")) n += loc(fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return n;
}

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

module.exports = { readJson, loc, dirLoc, median, necessaryFor, costOf, round };
