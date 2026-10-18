#!/usr/bin/env node
// Measures `necessary_tokens` (the denominator of `tax` in runner/score.js) from
// each task's own files, replacing the hand-typed number.
//
// ESTIMATOR: est(s) = ceil(String(s).length / 4). Four chars per token is an
// approximation, so `tax` is NOT tokenizer-agnostic: the numerator uses a real
// provider tokenizer, only this denominator is reproducible (ADR-001's "same unit
// cancels" does not hold here).
//
// LOWER BOUND. The harness re-sends the whole transcript every turn and the tool
// schemas ride along with every request, so each turn's input grows; both are
// modeled. Excluded to keep a strict floor: run_tests, whose output size is
// unknowable offline (including it would only enlarge the number -- do NOT "fix" it).
// The BASELINE (vanilla) prompt is used, so `minimal` costs less than this.
//
// MODEL: one step = one turn; call JSON = {"name":"<tool>","arguments":{"path":"<path>"}}.
//   read : completion est(call); tool result appended = workspace file bytes.
//   write: completion est(call + reference bytes); those bytes are also appended to
//          the transcript (the harness pushes that assistant message); result "ok".
//   done : final message, no tool call, completion est("done"). Missing files throw.
//
//   node runner/reference_cost.js          # regenerate all tasks
//   node runner/reference_cost.js --check  # print drift, exit 1, write nothing
const fs = require("fs");
const path = require("path");
const { TOOLS, TOOL_HELP } = require("./harnesses/mini-loop");
const ROOT = process.env.TOKENTAX_ROOT || path.resolve(__dirname, "..");
const CONFIG = process.env.TOKENTAX_CONFIG
  ? path.resolve(process.cwd(), process.env.TOKENTAX_CONFIG)
  : path.join(ROOT, "runner", "config.json");
const est = (s) => Math.ceil(String(s).length / 4);

// The request carries the tool schemas every turn, so they are part of the floor.
const TOOL_SCHEMA = JSON.stringify(TOOLS);

// If mini-loop renames a tool, the modeled call JSON stops matching it.
if (!TOOLS.some((t) => t.function.name === "read_file") || !TOOLS.some((t) => t.function.name === "write_file"))
  throw new Error("mini-loop tools changed; reference_cost.js models read_file/write_file");

// Same listing the prompt uses (runner/run.js:listJobFiles), over the workspace.
function listJobFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !["_grade", "conftest.py", "out.xml"].includes(e.name))
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? listJobFiles(p, base) : [path.relative(base, p)];
    })
    .sort();
}
const readOrFail = (file, what) => {
  if (!fs.existsSync(file)) throw new Error(`missing ${what}: ${file}`);
  return fs.readFileSync(file, "utf8");
};
const callJson = (tool, p) => JSON.stringify({ name: tool, arguments: { path: p } });

// Sum every turn's input (the re-sent transcript) plus every turn's completion.
function compute(taskDir, steps) {
  const name = path.basename(taskDir);
  if (!Array.isArray(steps) || !steps.length) throw new Error(`${name}: no steps`);
  const system = JSON.parse(fs.readFileSync(CONFIG, "utf8")).variants.vanilla;
  const listing = listJobFiles(path.join(taskDir, "workspace")).map((f) => `- ${f}`).join("\n");
  const prompt = `${readOrFail(path.join(taskDir, "task.md"), "task.md")}\n\nWorkspace files:\n${listing}`;
  let transcript = `${system}${TOOL_HELP}${prompt}`;
  let total = 0;
  for (let i = 0; i < steps.length; i++) {
    total += est(transcript) + est(TOOL_SCHEMA); // this turn's input: the whole transcript plus the tools
    const step = steps[i];
    if (step.action === "done") {
      if (i !== steps.length - 1) throw new Error(`${name}: "done" must be last`);
      return total + est("done");
    }
    if (step.action === "read") {
      const call = callJson("read_file", step.path);
      const body = readOrFail(path.join(taskDir, "workspace", step.path), `workspace file ${step.path}`);
      total += est(call);
      transcript += call + body.slice(0, 8000); // harness slices tool output to 8000
    } else if (step.action === "write") {
      const call = callJson("write_file", step.path);
      const body = readOrFail(path.join(taskDir, "reference", step.path), `reference file ${step.path}`);
      total += est(call + body);
      transcript += call + body + "ok";
    } else {
      throw new Error(`${name}: unknown action "${step.action}" (allowed: read, write, done)`);
    }
  }
  throw new Error(`${name}: trajectory must end with a "done" step`);
}

const trajectoryPath = (dir) => path.join(dir, "reference", "trajectory.json");
function taskDirs() {
  const dir = path.join(ROOT, "tasks");
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "task.json")))
    .sort()
    .map((d) => path.join(dir, d));
}
function main() {
  const check = process.argv.includes("--check");
  let drift = 0;
  for (const dir of taskDirs()) {
    const ref = JSON.parse(fs.readFileSync(trajectoryPath(dir), "utf8"));
    const old = typeof ref.necessary_tokens === "number" ? ref.necessary_tokens : ref.necessary_tokens?.default;
    const total = Math.round(compute(dir, ref.steps));
    if (!check) {
      ref.necessary_tokens = total;
      fs.writeFileSync(trajectoryPath(dir), JSON.stringify(ref, null, 2) + "\n");
      console.log(`${path.basename(dir)}: necessary_tokens ${old} -> ${total}`);
    } else if (old !== total) {
      console.log(`drift ${path.basename(dir)}: ${old} -> ${total}`);
      drift++;
    }
  }
  if (!check) return;
  if (drift) {
    console.error(`reference_cost: ${drift} task(s) drifted; run: node runner/reference_cost.js`);
    process.exit(1);
  }
  console.log(`reference_cost: no drift (${taskDirs().length} tasks)`);
}

if (require.main === module) main();
module.exports = { est, compute, taskDirs, TOOL_HELP };
