#!/usr/bin/env node
// One command, no key, no network: runs the offline fixture end to end and prints
// what the metric says. The fixture drives a mock model on purpose -- this shows
// the measurement, it is not a leaderboard. The README carries the last real run,
// and only ever a run that happened.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "runner", "tmp", "demo.raw.json");
const OUT = path.join(ROOT, "runner", "tmp", "demo.results.json");
const env = { ...process.env, TOKENTAX_CONFIG: "runner/config.mock.json", TOKENTAX_RAW: RAW, TOKENTAX_OUT: OUT };

for (const step of ["run.js", "score.js"]) {
  const r = spawnSync(process.execPath, [path.join("runner", step)], { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`demo: runner/${step} failed\n${r.stdout || ""}${r.stderr || ""}`);
    process.exit(1);
  }
}

const results = JSON.parse(fs.readFileSync(OUT, "utf8"));
const rows = results.entries.filter((e) => e.status === "complete" && e.vanilla && e.vanilla.tax != null);
if (!rows.length) {
  console.error("demo: the fixture produced no scored entry");
  process.exit(1);
}

rows.sort((a, b) => a.vanilla.tax - b.vanilla.tax);
const max = Math.max(...rows.map((e) => e.vanilla.tax));
const bar = (n) => "█".repeat(Math.max(1, Math.round((n / max) * 28)));
const w = Math.max(...rows.map((e) => Math.max(e.harness.length, e.model.length)));

console.log("");
console.log("  tokentax  ·  tax = (tokens_in + tokens_out) / necessary_tokens(model)");
console.log("  offline fixture: a mock model, no key, no network, no Docker");
console.log("");
for (const e of rows) {
  console.log(`  ${e.harness.padEnd(w)}  ${e.model.padEnd(w)}  ${`${e.vanilla.tax.toFixed(2)}×`.padStart(7)}  ${bar(e.vanilla.tax)}`);
}
console.log("");

// The two things the ratio is for, both visible in the fixture: the harness a
// model runs in, and the prompt it runs with.
const group = [...new Set(rows.map((e) => e.model))]
  .map((m) => rows.filter((e) => e.model === m))
  .find((g) => g.length > 1);
if (group) {
  const lo = group[0];
  const hi = group[group.length - 1];
  console.log(`  Same model, same tasks: \`${hi.harness}\` burns ${(hi.vanilla.tax / lo.vanilla.tax).toFixed(1)}× what \`${lo.harness}\` burns.`);
}
const withMin = rows.filter((e) => e.minimal && e.minimal.tax != null);
if (withMin.length) {
  const avg = withMin.reduce((s, e) => s + (1 - e.minimal.tax / e.vanilla.tax), 0) / withMin.length;
  console.log(`  A minimal prompt removes ${Math.round(avg * 100)}% of the tax, averaged over these rows.`);
}
console.log("");
console.log("  Real numbers need a real model, a key and a full run:");
console.log("    GROQ_API_KEY=... node runner/run.js && node runner/score.js && node runner/leaderboard.js");
console.log("  or dispatch .github/workflows/bench.yml (weekly; needs the GROQ_API_KEY secret).");
console.log("");
