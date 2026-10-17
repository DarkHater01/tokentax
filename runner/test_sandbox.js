#!/usr/bin/env node
// Offline sandbox self-test. No Docker: prepareJob is pure filesystem.
// Guards the invariant that makes the benchmark a benchmark -- the hidden tests
// must never exist inside the job the agent can read.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sandbox = require("./sandbox");

const tasksDir = path.join(sandbox.ROOT, "tasks");
const task = fs
  .readdirSync(tasksDir)
  .filter((d) => fs.existsSync(path.join(tasksDir, d, "task.json")))
  .sort()[0];
assert(task, "no tasks found");
const dir = path.join(tasksDir, task);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(d, p));
  }
  return out;
}

let job = sandbox.prepareJob(dir);
const files = walk(job);
assert(files.length > 0, "job should contain the workspace");
assert(!files.some((f) => f.includes("_grade")), `hidden tests reached the job: ${files.join(", ")}`);
assert(
  !files.some((f) => path.basename(f).startsWith("test_")),
  `a test file reached the job: ${files.join(", ")}`
);

job = sandbox.prepareJob(dir, path.join(dir, "reference"));
const refPy = walk(path.join(dir, "reference")).filter((f) => f.endsWith(".py"));
assert(refPy.length > 0, "reference overlay has no python files");
assert(
  refPy.every((f) => fs.existsSync(path.join(job, f))),
  `reference overlay did not land in the job: ${refPy.join(", ")}`
);
sandbox.cleanup(job);

console.log(`test_sandbox: PASS (${task}: no hidden tests in the job, overlay lands)`);
