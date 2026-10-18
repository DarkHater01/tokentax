#!/usr/bin/env node
// Proves every task is well-formed against the real sandbox: the broken workspace
// must FAIL grading, and the reference solution must PASS. Needs Docker.
// Run: node runner/test_tasks.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sandbox = require("./sandbox");

const REPO = sandbox.ROOT;
const tasksDir = path.join(REPO, "tasks");

sandbox.ensureImage();

const tasks = fs
  .readdirSync(tasksDir)
  .filter(
    (d) =>
      fs.existsSync(path.join(tasksDir, d, "task.json")) &&
      fs.existsSync(path.join(tasksDir, d, "workspace")) &&
      fs.existsSync(path.join(tasksDir, d, "reference")),
  )
  .sort();

assert(tasks.length > 0, "no tasks found");

for (const t of tasks) {
  const dir = path.join(tasksDir, t);

  let job = sandbox.prepareJob(dir);
  let g = sandbox.pytest(job, 50, { testsDir: path.join(dir, "tests") });
  sandbox.cleanup(job);
  assert(!g.passed, `${t}: broken workspace must FAIL grading (junit=${JSON.stringify(g.junit)})`);

  job = sandbox.prepareJob(dir, path.join(dir, "reference"));
  g = sandbox.pytest(job, 50, { testsDir: path.join(dir, "tests") });
  sandbox.cleanup(job);
  assert(g.passed, `${t}: reference solution must PASS grading (exit=${g.exit} tail: ${g.tail})`);

  console.log(`  ${t}: workspace fails, reference passes`);
}

console.log(`test_tasks: PASS (${tasks.length} tasks, workspace-fails + reference-passes)`);
