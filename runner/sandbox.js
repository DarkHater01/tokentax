// Hardened Docker sandbox: builds the image, materializes jobs, grades with pytest.
// Zero dependencies. Mirrors slopbench's container hardening.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, "runner", "tmp");
const IMAGE = "tokentax-sandbox";

const safeEnv = () => ({ PATH: process.env.PATH || "", HOME: process.env.HOME || "" });

function fail(msg) {
  console.error(`sandbox: ${msg}`);
  process.exit(1);
}

function ensureImage() {
  const check = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8", env: safeEnv() });
  if (check.status === 0) return;
  console.log("building sandbox image...");
  const b = spawnSync("docker", ["build", "-t", IMAGE, path.join(ROOT, "sandbox")], {
    encoding: "utf8",
    stdio: "inherit",
    env: safeEnv(),
  });
  if (b.status !== 0) fail("docker build failed");
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Lets the agent's own pytest runs import the workspace modules. It lives inside
// the job on purpose: /job must never be on the interpreter's import path while
// grading, or a planted /job/pytest.py or /job/sitecustomize.py would run instead
// of the grader.
const CONFTEST = "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n";

// Grading puts the workspace on sys.path from a conftest WE write, next to a copy
// of the hidden tests, in a directory the agent never sees.
const GRADE_CONFTEST = 'import sys\nsys.path.insert(0, "/job")\n';


// Materialize a runnable job: workspace (+ optional overlay). The hidden tests
// deliberately stay OUT of the job and are mounted read-only at grading time --
// a benchmark whose hidden tests are readable by the agent is not a benchmark.
function prepareJob(taskDir, overlay) {
  const job = path.join(TMP, `${path.basename(taskDir)}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(job, { recursive: true });
  copyDir(path.join(taskDir, "workspace"), job);
  if (overlay) copyDir(overlay, job);
  fs.writeFileSync(path.join(job, "conftest.py"), CONFTEST);
  return job;
}

const cleanup = (job) => {
  fs.rmSync(job, { recursive: true, force: true });
  fs.rmSync(`${job}.grade`, { recursive: true, force: true });
};

function parseJunit(xml) {
  const su = xml.match(/<testsuite\b([^>]*)>/);
  if (!su) return null;
  const attrs = su[1];
  const num = (n) => {
    const m = attrs.match(new RegExp(`\\b${n}="(\\d+)"`));
    return m ? +m[1] : null;
  };
  return { tests: num("tests"), failures: num("failures"), errors: num("errors") };
}

// The grade is decided here and nowhere else: a report can claim anything, so it
// only counts if pytest itself exited 0 and the report says a suite actually ran.
// A stale or forged junit left in the workspace fails on the first two clauses.
function verdict(exit, junit) {
  return exit === 0 && !!junit && junit.tests > 0 && junit.failures === 0 && junit.errors === 0;
}

// Build the docker argv (and materialize the grading dir). Split out from pytest
// so the self-test can assert the invariants without a Docker daemon.
//
// Pass testsDir to grade. Nothing the agent can write may decide its own grade:
//  - the hidden tests are copied next to a conftest we write, outside the job;
//  - the job is mounted read-only -- the agent is finished, nothing should move;
//  - the junit report is written outside the job and read from the host;
//  - /job is kept off the interpreter's import path, so a file the model named
//    pytest.py or sitecustomize.py cannot stand in for the grader.
function buildArgs(jobDir, timeoutS, { testsDir = null } = {}) {
  const grading = !!testsDir;
  let mounts = ["-v", `${jobDir}:/job`];
  let workdir = "/job";
  let targets = [];
  let report = path.join(jobDir, "out.xml");
  if (grading) {
    // Sibling directory, not a child: the agent's own files can never reach it,
    // so the report read back on the host cannot be a file the agent wrote.
    const gradeDir = `${jobDir}.grade`;
    fs.rmSync(gradeDir, { recursive: true, force: true });
    fs.mkdirSync(gradeDir, { recursive: true });
    copyDir(testsDir, path.join(gradeDir, "grade"));
    fs.writeFileSync(path.join(gradeDir, "conftest.py"), GRADE_CONFTEST);
    mounts = ["-v", `${jobDir}:/job:ro`, "-v", `${gradeDir}:/report`];
    workdir = "/report";
    targets = ["/report/grade"];
    report = path.join(gradeDir, "out.xml");
  }
  fs.rmSync(report, { force: true });

  return {
    report,
    args: [
      "run", "--rm",
      "--network", "none",
      "--memory", "512m", "--memory-swap", "512m",
      "--cpus", "1",
      "--pids-limit", "128",
      "--ulimit", "fsize=1048576",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=64m,mode=1777",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--user", `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`,
      "-e", "HOME=/tmp",
      "-e", "PYTHONDONTWRITEBYTECODE=1",
      ...mounts,
      "-w", workdir,
      IMAGE,
      // -P keeps the working directory off sys.path.
      "timeout", String(timeoutS), "python", "-P", "-m", "pytest", "-q", "-p", "no:cacheprovider",
      grading ? "--junitxml=/report/out.xml" : "--junitxml=out.xml",
      ...targets,
    ],
  };
}

function pytest(jobDir, timeoutS, opts = {}) {
  const { args, report } = buildArgs(jobDir, timeoutS, opts);
  const r = spawnSync("docker", args, { encoding: "utf8", env: safeEnv(), timeout: (timeoutS + 25) * 1000 });
  if (r.error) fail(`docker: ${r.error.message}`);
  const junit = fs.existsSync(report) ? parseJunit(fs.readFileSync(report, "utf8")) : null;
  if (opts.testsDir) fs.rmSync(`${jobDir}.grade`, { recursive: true, force: true });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return {
    exit: r.status,
    timed_out: r.status === 124,
    junit,
    passed: verdict(r.status, junit),
    tail: out.slice(-400),
  };
}

module.exports = { ensureImage, prepareJob, cleanup, pytest, buildArgs, verdict, parseJunit, TMP, IMAGE, ROOT };
