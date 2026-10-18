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

// Grading must not trust anything the agent can write. A perfect-looking report
// only counts when pytest itself exited 0 -- a forged or stale out.xml left in the
// workspace is exactly the bug this guards.
const perfect = { tests: 1, failures: 0, errors: 0 };
assert.strictEqual(sandbox.verdict(0, perfect), true, "a clean exit with a clean report passes");
assert.strictEqual(sandbox.verdict(1, perfect), false, "a forged report cannot pass when pytest did not exit 0");
assert.strictEqual(sandbox.verdict(124, perfect), false, "a timeout cannot pass");
assert.strictEqual(sandbox.verdict(0, null), false, "no report cannot pass");
assert.strictEqual(sandbox.verdict(0, { tests: 0, failures: 0, errors: 0 }), false, "an empty suite cannot pass");

job = sandbox.prepareJob(dir);
const grading = sandbox.buildArgs(job, 50, { testsDir: path.join(dir, "tests") });
const argv = grading.args.join(" ");
assert(argv.includes(`${job}:/job:ro`), "grading must mount the job read-only");
assert(!argv.includes("PYTHONPATH"), "grading must keep /job off the interpreter's import path");
assert(argv.includes("--junitxml=/report/out.xml"), "the report must be written outside the job");
assert(!grading.report.startsWith(path.join(job, path.sep)), `the report must live outside the job: ${grading.report}`);
assert.strictEqual(
  fs.readFileSync(path.join(`${job}.grade`, "conftest.py"), "utf8"),
  'import sys\nsys.path.insert(0, "/job")\n',
  "the grading conftest is the only thing that puts the job on sys.path"
);
assert(fs.existsSync(path.join(`${job}.grade`, "grade")), "the hidden tests are copied into the grading dir");

const own = sandbox.buildArgs(job, 50).args.join(" ");
assert(own.includes(`${job}:/job`), "the agent's own test run keeps the job writable");
assert(!own.includes("/job:ro"), "the agent's own test run is not the grade");
sandbox.cleanup(job);
assert(!fs.existsSync(`${job}.grade`), "cleanup removes the grading dir too");

console.log(`test_sandbox: PASS (${task}: no hidden tests in the job, overlay lands, grade is report-outside + exit-status)`);
