#!/usr/bin/env node
// TokenTax runner. Fixture models run offline; live models drive a real agent
// harness inside the Docker sandbox. Zero dependencies.
const fs = require("fs");
const path = require("path");
const { dirLoc } = require("./lib");
const sandbox = require("./sandbox");
const openrouter = require("./openrouter");

const ROOT = process.env.TOKENTAX_ROOT || path.resolve(__dirname, "..");
const CFG_PATH = process.env.TOKENTAX_CONFIG
  ? path.resolve(process.cwd(), process.env.TOKENTAX_CONFIG)
  : path.join(ROOT, "runner", "config.json");
const RAW = process.env.TOKENTAX_RAW
  ? path.resolve(process.cwd(), process.env.TOKENTAX_RAW)
  : path.join(ROOT, "data", "raw.json");

const cfg = require(CFG_PATH);
const HARNESSES = { "mini-loop": require("./harnesses/mini-loop") };

function fail(msg) {
  console.error(`run.js: ${msg}`);
  process.exit(1);
}

if (!cfg.models.length) fail("no models in config. Use runner/config.mock.json for the offline smoke test.");

const liveModels = cfg.models.filter((m) => !m.fixture);
if (liveModels.length && !process.env.OPENROUTER_API_KEY) {
  fail("OPENROUTER_API_KEY not set (needed for non-fixture models)");
}
for (const h of cfg.harnesses) {
  if (liveModels.length && !HARNESSES[h.id]) fail(`harness not implemented: ${h.id}`);
}

function listTasks() {
  const dir = path.join(ROOT, "tasks");
  return fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "task.json")))
    .sort();
}

async function main() {
  if (liveModels.length) sandbox.ensureImage();
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.rmSync(sandbox.TMP, { recursive: true, force: true });
  fs.mkdirSync(sandbox.TMP, { recursive: true });

  const tasks = listTasks();
  let raw = [];
  if (fs.existsSync(RAW)) {
    try {
      const before = JSON.parse(fs.readFileSync(RAW, "utf8"));
      if (Array.isArray(before)) raw = before;
    } catch {
      /* corrupt partial file — start over */
    }
  }
  const done = new Set(raw.map((r) => `${r.harness}|${r.model}|${r.task}|${r.variant}|${r.rep}`));

  for (const harness of cfg.harnesses) {
    for (const model of cfg.models) {
      const fixture = model.fixture
        ? require(path.join(__dirname, "fixtures", model.fixture, "trajectories.json"))
        : null;
      for (const taskDir of tasks) {
        const task = require(path.join(taskDir, "task.json"));
        const taskMd = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
        for (const [variant, system] of Object.entries(cfg.variants)) {
          for (let rep = 1; rep <= cfg.reps; rep++) {
            const key = `${harness.id}|${model.id}|${task.id}|${variant}|${rep}`;
            if (done.has(key)) continue;
            console.log(`run: ${key}`);
            try {
              let rec;
              if (fixture) {
                const base = fixture.tasks[task.id]?.[variant];
                if (!base) fail(`fixture ${model.fixture} missing ${task.id}/${variant}`);
                const passed = base.pass && !(base.fail_reps || []).includes(rep);
                const oh = harness.overhead ?? 1;
                rec = {
                  passed,
                  tokens_in: Math.round(base.in * oh),
                  tokens_out: Math.round(base.out * oh),
                  turns: base.turns,
                  tool_calls: base.tool_calls,
                  thrash: base.thrash,
                  loc: base.pass ? base.loc : 0,
                };
              } else {
                const job = sandbox.prepareJob(taskDir);
                const chat = (messages, tools) =>
                  openrouter.chat({
                    base: cfg.openrouter_base,
                    key: process.env.OPENROUTER_API_KEY,
                    model: model.id,
                    messages,
                    tools,
                  });
                const r = await HARNESSES[harness.id].run({ job, taskMd, system, cfg, chat, sandbox });
                const grade = sandbox.pytest(job, cfg.pass_timeout_seconds, ["_grade"]);
                const locVal = dirLoc(job);
                sandbox.cleanup(job);
                rec = {
                  passed: grade.passed,
                  tokens_in: r.tokens_in,
                  tokens_out: r.tokens_out,
                  turns: r.turns,
                  tool_calls: r.tool_calls,
                  thrash: r.thrash,
                  loc: locVal,
                  tail: grade.passed ? "" : grade.tail,
                };
              }
              raw.push({ harness: harness.id, model: model.id, task: task.id, variant, rep, error: null, ...rec });
            } catch (e) {
              raw.push({
                harness: harness.id,
                model: model.id,
                task: task.id,
                variant,
                rep,
                passed: false,
                tokens_in: 0,
                tokens_out: 0,
                turns: 0,
                tool_calls: 0,
                thrash: 0,
                loc: 0,
                error: e.message,
              });
              console.error(`   error: ${e.message}`);
            }
            fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
          }
        }
      }
    }
  }

  console.log(`done: ${raw.length} runs -> ${RAW}`);
}

main().catch((e) => fail(e.stack || e));
