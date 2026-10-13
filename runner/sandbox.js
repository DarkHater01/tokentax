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

// Hidden tests live under _grade/ so the agent's own tests never mix with grading.
const CONFTEST = "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n";

// Materialize a runnable job: workspace (+ optional overlay) + hidden tests in _grade/.
function prepareJob(taskDir, overlay) {
  const job = path.join(TMP, `${path.basename(taskDir)}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(job, { recursive: true });
  copyDir(path.join(taskDir, "workspace"), job);
  if (overlay) copyDir(overlay, job);
  copyDir(path.join(taskDir, "tests"), path.join(job, "_grade"));
  fs.writeFileSync(path.join(job, "conftest.py"), CONFTEST);
  return job;
}

const cleanup = (job) => fs.rmSync(job, { recursive: true, force: true });

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

// Run pytest in the sandbox. args: ["_grade"] to grade, ["--ignore=_grade"] for the agent.
function pytest(jobDir, timeoutS, args = []) {
  const dockerArgs = [
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
    "-e", "PYTHONPATH=/job",
    "-e", "PYTHONDONTWRITEBYTECODE=1",
    "-v", `${jobDir}:/job`,
    "-w", "/job",
    IMAGE,
    "timeout", String(timeoutS), "python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml=out.xml", ...args,
  ];
  const r = spawnSync("docker", dockerArgs, { encoding: "utf8", env: safeEnv(), timeout: (timeoutS + 25) * 1000 });
  if (r.error) fail(`docker: ${r.error.message}`);
  const xmlPath = path.join(jobDir, "out.xml");
  const junit = fs.existsSync(xmlPath) ? parseJunit(fs.readFileSync(xmlPath, "utf8")) : null;
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return {
    timed_out: r.status === 124,
    junit,
    passed: !!junit && junit.tests > 0 && junit.failures === 0 && junit.errors === 0,
    tail: out.slice(-400),
  };
}

module.exports = { ensureImage, prepareJob, cleanup, pytest, TMP, IMAGE, ROOT };
