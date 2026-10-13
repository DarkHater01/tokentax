#!/usr/bin/env node
// TokenTax runner (M1): fixture models only -> data/raw.json
// Real agent harnesses (opencode-headless, claude-code-headless) land in M2.
// Zero dependencies. No API key, no Docker in M1.
const fs = require("fs");
const path = require("path");

const ROOT = process.env.TOKENTAX_ROOT || path.resolve(__dirname, "..");
const CFG_PATH = process.env.TOKENTAX_CONFIG
  ? path.resolve(process.cwd(), process.env.TOKENTAX_CONFIG)
  : path.join(ROOT, "runner", "config.json");
const RAW = process.env.TOKENTAX_RAW
  ? path.resolve(process.cwd(), process.env.TOKENTAX_RAW)
  : path.join(ROOT, "data", "raw.json");

const cfg = require(CFG_PATH);

function fail(msg) {
  console.error(`run.js: ${msg}`);
  process.exit(1);
}

if (!cfg.models.length) {
  fail("no models in config. Use runner/config.mock.json for the offline smoke test.");
}

const liveModels = cfg.models.filter((m) => !m.fixture);
if (liveModels.length) {
  fail(
    `live models are not implemented in M1 (${liveModels.map((m) => m.id).join(", ")}). ` +
      `Use runner/config.mock.json for the offline smoke test.`,
  );
}

const tasks = fs
  .readdirSync(path.join(ROOT, "tasks"))
  .filter((d) => fs.existsSync(path.join(ROOT, "tasks", d, "task.json")))
  .sort();

const raw = [];
for (const harness of cfg.harnesses) {
  for (const model of cfg.models) {
    const fx = require(path.join(__dirname, "fixtures", model.fixture, "trajectories.json"));
    for (const task of tasks) {
      const byVariant = fx.tasks[task];
      if (!byVariant) fail(`fixture ${model.fixture} missing task ${task}`);
      for (const variant of Object.keys(cfg.variants)) {
        const base = byVariant[variant];
        if (!base) fail(`fixture ${model.fixture} missing ${task}/${variant}`);
        for (let rep = 1; rep <= cfg.reps; rep++) {
          const passed = base.pass && !(base.fail_reps || []).includes(rep);
          raw.push({
            harness: harness.id,
            model: model.id,
            task,
            variant,
            rep,
            passed,
            tokens_in: Math.round(base.in * (harness.overhead ?? 1)),
            tokens_out: Math.round(base.out * (harness.overhead ?? 1)),
            turns: base.turns,
            tool_calls: base.tool_calls,
            thrash: base.thrash,
            loc: base.pass ? base.loc : 0,
            error: null,
          });
        }
      }
    }
  }
}

fs.mkdirSync(path.dirname(RAW), { recursive: true });
fs.writeFileSync(RAW, JSON.stringify(raw, null, 2));
console.log(`run(M1 fixture): ${raw.length} runs -> ${RAW}`);
