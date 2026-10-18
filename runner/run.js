#!/usr/bin/env node
// TokenTax runner. Fixture models run offline; live models drive a real agent
// harness inside the Docker sandbox. Zero dependencies.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dirLoc } = require("./lib");
const sandbox = require("./sandbox");
const chatApi = require("./chat");

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
const provider = cfg.provider || "openrouter";
const providerCfg = chatApi.PROVIDERS[provider];
if (liveModels.length) {
  if (!providerCfg) fail(`unknown provider: ${provider} (see runner/providers.json)`);
  if (!process.env[providerCfg.keyEnv]) fail(`${providerCfg.keyEnv} not set (needed for provider ${provider})`);
}
for (const h of cfg.harnesses) {
  if (liveModels.length && !HARNESSES[h.id]) fail(`harness not implemented: ${h.id}`);
}

function listTasks() {
  const dir = path.join(ROOT, "tasks");
  const only = (process.env.TOKENTAX_TASKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "task.json")))
    .filter((p) => !only.length || only.includes(path.basename(p)))
    .sort();
}

// The agent has no way to look around, and task.md deliberately does not name
// the files. Without this it guesses a filename and burns its whole turn budget,
// which measures the harness's blindness instead of the model.
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

// A record is only reusable if the harness, the prompt, the task and the tests it
// was produced against are byte-identical: data/raw.json is committed and reused
// weekly, so a prompt edit would otherwise silently merge two experiments and the
// leaderboard would average them.
function envHash(taskDir, harnessId, cfg) {
  const h = crypto.createHash("sha256");
  const add = (v) => h.update(String(v)).update("\0");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        add(path.relative(taskDir, p));
        add(fs.readFileSync(p, "utf8"));
      }
    }
  };
  add(JSON.stringify(cfg));
  add(harnessId);
  try {
    add(fs.readFileSync(require.resolve(`./harnesses/${harnessId}`), "utf8"));
  } catch {
    // fixture-only harness id (see runner/config.mock.json)
  }
  for (const sub of ["task.md", "workspace", "tests"]) {
    const p = path.join(taskDir, sub);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p);
    else {
      add(sub);
      add(fs.readFileSync(p, "utf8"));
    }
  }
  return h.digest("hex").slice(0, 12);
}

async function main() {
  if (liveModels.length) sandbox.ensureImage();
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.rmSync(sandbox.TMP, { recursive: true, force: true });
  fs.mkdirSync(sandbox.TMP, { recursive: true });

  const tasks = listTasks();
  const envHashes = new Map();
  for (const harness of cfg.harnesses) {
    for (const taskDir of tasks) {
      const id = require(path.join(taskDir, "task.json")).id;
      envHashes.set(`${harness.id}|${id}`, envHash(taskDir, harness.id, cfg));
    }
  }
  let raw = [];
  if (fs.existsSync(RAW)) {
    try {
      const before = JSON.parse(fs.readFileSync(RAW, "utf8"));
      // Drop records that ended in an error: an error is the network or the
      // provider, not the model, and freezing it into the file would keep a
      // transient failure in the leaderboard forever. Drop records from a
      // different environment for the same reason.
      if (Array.isArray(before)) {
        raw = before.filter((r) => !r.error && r.env_hash && r.env_hash === envHashes.get(`${r.harness}|${r.task}`));
      }
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
        const env = envHashes.get(`${harness.id}|${task.id}`);
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
                  retries: 0,
                  loc: base.pass ? base.loc : 0,
                };
              } else {
                const job = sandbox.prepareJob(taskDir);
                const prompt = `${taskMd}\n\nWorkspace files:\n${listJobFiles(job).map((f) => `- ${f}`).join("\n")}`;
                const chat = (messages, tools) => chatApi.chat({ provider, model: model.id, messages, tools });
                const r = await HARNESSES[harness.id].run({ job, taskMd: prompt, system, cfg, chat, sandbox });
                const grade = sandbox.pytest(job, cfg.pass_timeout_seconds, { testsDir: path.join(taskDir, "tests") });
                const locVal = dirLoc(job);
                sandbox.cleanup(job);
                rec = {
                  passed: grade.passed,
                  tokens_in: r.tokens_in,
                  tokens_out: r.tokens_out,
                  turns: r.turns,
                  tool_calls: r.tool_calls,
                  thrash: r.thrash,
                  retries: r.retries ?? 0,
                  loc: locVal,
                  tail: grade.passed ? "" : grade.tail,
                };
              }
              console.log(
                `   -> ${rec.passed ? "PASS" : "FAIL"} in=${rec.tokens_in} out=${rec.tokens_out} turns=${rec.turns} tools=${rec.tool_calls} thrash=${rec.thrash} retries=${rec.retries}`
              );
              raw.push({ harness: harness.id, model: model.id, task: task.id, variant, rep, error: null, env_hash: env, ...rec });
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
                retries: 0,
                loc: 0,
                env_hash: env,
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
