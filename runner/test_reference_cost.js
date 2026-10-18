#!/usr/bin/env node
// Offline self-test for runner/reference_cost.js. No Docker, no API key.
// Run: node runner/test_reference_cost.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const { est, compute, taskDirs, TOOL_HELP } = require("./reference_cost");
const { TOOLS } = require("./harnesses/mini-loop");

const traj = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "reference", "trajectory.json"), "utf8"));

// (a) the committed numbers match a fresh computation (drift guard).
const check = spawnSync("node", [path.join(__dirname, "reference_cost.js"), "--check"], { encoding: "utf8" });
assert.strictEqual(check.status, 0, `--check must find no drift:\n${check.stderr || check.stdout}`);
assert(/no drift/.test(check.stdout), "--check must report no drift");

const dirs = taskDirs();
assert(dirs.length === 5, `expected 5 tasks, got ${dirs.length}`);

// (b) every declared path exists on the side the model reads/writes it.
for (const dir of dirs) {
  for (const step of traj(dir).steps) {
    if (step.action === "read")
      assert(fs.existsSync(path.join(dir, "workspace", step.path)), `${path.basename(dir)}: no workspace/${step.path}`);
    if (step.action === "write")
      assert(fs.existsSync(path.join(dir, "reference", step.path)), `${path.basename(dir)}: no reference/${step.path}`);
  }
}

// (c) a nonexistent path must fail loudly, not be silently skipped.
const task01 = path.join(REPO, "tasks", "01-fix-failing-test");
assert.throws(
  () => compute(task01, [{ action: "read", path: "does-not-exist.py" }, { action: "done" }]),
  /missing/,
  "a read of a missing file must throw",
);

// (e) run_tests is deliberately outside the model and must be rejected.
assert.throws(
  () => compute(task01, [{ action: "run_tests" }, { action: "done" }]),
  /unknown action/,
  "run_tests must be rejected",
);

// (d) recompute task 01 by hand from the estimator. This is the guard that the
// formula itself does not quietly change.
const sys = JSON.parse(fs.readFileSync(path.join(REPO, "runner", "config.json"), "utf8")).variants.vanilla;
const taskMd = fs.readFileSync(path.join(task01, "task.md"), "utf8");
const base = `${sys}${TOOL_HELP}${taskMd}\n\nWorkspace files:\n- calc.py`;
const readCall = JSON.stringify({ name: "read_file", arguments: { path: "calc.py" } });
const writeCall = JSON.stringify({ name: "write_file", arguments: { path: "calc.py" } });
const broken = fs.readFileSync(path.join(task01, "workspace", "calc.py"), "utf8");
const fixed = fs.readFileSync(path.join(task01, "reference", "calc.py"), "utf8");
const afterRead = base + readCall + broken;
// The tool schemas are sent with every request, so they are part of every turn.
const schema = est(JSON.stringify(TOOLS));
const hand =
  est(base) + schema + est(readCall) + // turn 1: input, then the read completion
  est(afterRead) + schema + est(writeCall + fixed) + // turn 2: input, then the write completion
  est(afterRead + writeCall + fixed + "ok") + schema + est("done"); // turn 3: input, then done
assert.strictEqual(hand, traj(task01).necessary_tokens, "stored necessary_tokens must equal the hand recomputation");

console.log("test_reference_cost: PASS (check, paths, missing-path, run-tests, hand-total)");
