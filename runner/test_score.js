#!/usr/bin/env node
// Self-test for runner/score.js. Fully offline: no API key, no Docker.
// Fixtures are generated into runner/tmp/ so the committed data/ is never touched.
// Run: node runner/test_score.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const TMP = path.join(REPO, "runner", "tmp");
const CFG = path.join(REPO, "runner", "config.mock.json");
const RAW = path.join(TMP, "raw.json");

const runRunner = () =>
  spawnSync("node", [path.join(REPO, "runner", "run.js")], {
    encoding: "utf8",
    env: { ...process.env, TOKENTAX_CONFIG: CFG, TOKENTAX_RAW: RAW },
  });

const score = (rawPath, outPath, extra = {}) =>
  spawnSync("node", [path.join(REPO, "runner", "score.js")], {
    encoding: "utf8",
    env: { ...process.env, TOKENTAX_CONFIG: CFG, TOKENTAX_RAW: rawPath, TOKENTAX_OUT: outPath, ...extra },
  });

const writeRaw = (name, obj) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
};

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  let r = runRunner();
  assert.strictEqual(r.status, 0, `run.js (fixture) should succeed:\n${r.stderr || r.stdout}`);
  const base = JSON.parse(fs.readFileSync(RAW, "utf8"));
  assert(base.length > 0, "fixture produced no runs");

  const OUT = path.join(TMP, "results.json");
  r = score(RAW, OUT);
  assert.strictEqual(r.status, 0, `valid raw should score:\n${r.stderr || r.stdout}`);
  const res = JSON.parse(fs.readFileSync(OUT, "utf8"));

  const find = (h, m) => res.entries.find((e) => e.harness === h && e.model === m);
  const mini = find("mini-loop", "mock-lean");
  const fat = find("fat-harness", "mock-lean");
  assert(mini && fat, "both harnesses must be present");
  assert.strictEqual(res.entries.length, 4, "entries = harnesses x models = 4");

  // The whole point: same model, fatter harness -> higher tax.
  assert(fat.vanilla.tax > mini.vanilla.tax, "harness overhead must raise tax");

  // A task the model fails must not qualify (tax null).
  const bloated = find("fat-harness", "mock-bloated");
  assert(bloated, "mock-bloated must be present");
  assert.strictEqual(
    bloated.vanilla.per_task["03-rename-symbol"].tax,
    null,
    "failing task must not qualify (tax null)",
  );

  // The minimal prompt must shave tokens off, on both harnesses.
  assert(mini.minimality_delta.overall > 0, "minimality delta must be > 0");
  assert(fat.minimality_delta.overall > 0, "minimality delta must be > 0 on the fat harness too");

  // Guard: a group with a missing run is rejected.
  const missing = writeRaw("missing.json", base.slice(0, -1));
  r = score(missing, path.join(TMP, "out-missing.json"));
  assert.strictEqual(r.status, 1, "missing run in a group must be rejected");

  // Guard: duplicate rep inside a group is rejected.
  const dupObj = base.map((x, i) => (i === 1 ? { ...x, rep: base[0].rep } : x));
  r = score(writeRaw("dup.json", dupObj), path.join(TMP, "out-dup.json"));
  assert.strictEqual(r.status, 1, "duplicate reps must be rejected");

  // Guard: absurd token count is rejected.
  const badObj = base.map((x, i) => (i === 0 ? { ...x, tokens_in: 90_000_000 } : x));
  r = score(writeRaw("bad.json", badObj), path.join(TMP, "out-bad.json"));
  assert.strictEqual(r.status, 1, "out-of-range tokens must be rejected");

  console.log("test_score: PASS (valid-ok, harness-axis, qualify-gate, delta, missing, dup-rep, bad-tokens)");
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
