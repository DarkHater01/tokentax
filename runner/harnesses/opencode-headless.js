// opencode-headless: the real OpenCode CLI, driven headless inside the sandbox.
//
// Tokens come from the CLI's own session database, not from a re-implementation
// of its loop: the point of a named harness in the table is that the number is
// the tool's, not ours.
//
// Two things this harness does not hide:
//  - the provider key lives inside the container and the container has a network,
//    because an agent CLI cannot reach a provider without both. Use a scoped,
//    rotatable key.
//  - the session schema is OpenCode's internal one. runner/test_opencode_harness.js
//    builds a database with that schema, so an upstream rename fails a test
//    instead of quietly reporting zero tokens.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const sandbox = require("../sandbox");

const OPENCODE_VERSION = "2.0.28"; // must match ARG in sandbox/Dockerfile.opencode
const IMAGE = "tokentax-opencode";
const OC = "/oc"; // the container's writable state dir, bind-mounted from the host
const DEFAULT_TIMEOUT_S = 1500;

const fail = (msg) => {
  throw new Error(`opencode-headless: ${msg}`);
};

// opencode's model id may contain "/" (openai/gpt-oss-120b); the config key is
// what --model takes after the provider prefix, so it has to be one segment.
const alias = (modelId) => modelId.replace(/[^A-Za-z0-9._-]/g, "-");

// The credential is handed to opencode through `env`, so the config file never
// holds a secret and the docker argv never holds one either.
function buildConfig({ provider, base, keyEnv, modelId }) {
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      [provider]: {
        name: provider,
        env: [keyEnv],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: base },
        models: { [alias(modelId)]: { modelID: modelId } },
      },
    },
  };
}

// Split out from run() so the self-test can assert the hardening and the
// credential handling without a Docker daemon.
function opencodeArgs({ runDir, jobDir, provider, modelId, keyEnv, message, timeoutS = DEFAULT_TIMEOUT_S }) {
  const env = [
    "-e", `XDG_CONFIG_HOME=${OC}/config`,
    "-e", `XDG_DATA_HOME=${OC}/data`,
    "-e", `XDG_CACHE_HOME=${OC}/cache`,
    "-e", `XDG_STATE_HOME=${OC}/state`,
    // Bare name: docker takes the value from its own environment, so the secret
    // stays out of the process list.
    "-e", keyEnv,
  ];
  return [
    ...sandbox.hardened({
      network: "bridge",
      mounts: ["-v", `${jobDir}:/job`, "-v", `${runDir}:${OC}`],
      workdir: "/job",
      home: `${OC}/home`,
      env,
    }),
    IMAGE,
    "timeout", String(timeoutS),
    "opencode", "run", "--standalone", "--auto", "--model", `${provider}/${alias(modelId)}`, message,
  ];
}

// Sums every session in the container's database. It is created fresh per run, so
// there is nothing else in it.
//
// Accounting: OpenCode's own step records carry `tokens` as
// `{total, input, output, reasoning, cache:{read,write}}` and total is exactly
// input + output + reasoning + cache.read + cache.write, so the four are disjoint.
// An OpenAI-compatible provider instead folds cached reads into `prompt_tokens`
// and reasoning into `completion_tokens`, which is what mini-loop counts, so the
// two harnesses are made comparable by summing the same parts here.
function parseSessions(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    fail("needs Node >= 22.13 for node:sqlite to read the CLI's token usage");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const s = db
      .prepare(
        "select count(*) n, coalesce(sum(tokens_input),0) ti, coalesce(sum(tokens_output),0) t_out, " +
          "coalesce(sum(tokens_reasoning),0) tr, coalesce(sum(tokens_cache_read),0) cr, " +
          "coalesce(sum(tokens_cache_write),0) cw, coalesce(sum(cost),0) cost from session"
      )
      .get();
    if (!s.n) return null;
    const turns = db.prepare("select count(*) c from message where json_extract(data,'$.role')='assistant'").get().c;
    const calls = db
      .prepare(
        "select json_extract(data,'$.tool') tool, json_extract(data,'$.state.input.filePath') file " +
          "from part where json_extract(data,'$.type')='tool'"
      )
      .all();
    // thrash is the same churn mini-loop counts: a write to a file already written.
    const written = new Set();
    let thrash = 0;
    for (const c of calls) {
      if (!["write", "edit", "patch"].includes(c.tool) || !c.file) continue;
      if (written.has(c.file)) thrash++;
      written.add(c.file);
    }
    return {
      sessions: s.n,
      tokens_in: s.ti + s.cr + s.cw,
      tokens_out: s.t_out + s.tr,
      tokens_cache_read: s.cr,
      tokens_reasoning: s.tr,
      cost: s.cost,
      turns,
      tool_calls: calls.length,
      thrash,
    };
  } finally {
    db.close();
  }
}

async function run({ job, taskMd, system, provider, modelId, timeoutS = DEFAULT_TIMEOUT_S }) {
  if (!provider || !provider.base || !provider.keyEnv) fail("needs the provider entry from runner/providers.json");
  const key = String(process.env[provider.keyEnv] ?? "").trim();
  if (!key) fail(`${provider.keyEnv} not set`);

  sandbox.ensureImage(IMAGE, "Dockerfile.opencode");
  const runDir = path.join(sandbox.TMP, `${path.basename(job)}_oc`);
  for (const d of ["config/opencode", "data", "cache", "state", "home"]) {
    fs.mkdirSync(path.join(runDir, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(runDir, "config", "opencode", "opencode.json"),
    JSON.stringify(buildConfig({ provider: provider.name, base: provider.base, keyEnv: provider.keyEnv, modelId }), null, 2)
  );

  // A real harness owns its system prompt, so the variant instruction is
  // prepended to the request instead of replacing the agent's own prompt.
  const message = [system, taskMd].filter(Boolean).join("\n\n");
  const args = opencodeArgs({ runDir, jobDir: job, provider: provider.name, modelId, keyEnv: provider.keyEnv, message, timeoutS });
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", [provider.keyEnv]: key },
    timeout: (timeoutS + 120) * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const db = path.join(runDir, "data", "opencode.db");
  const usage = fs.existsSync(db) ? parseSessions(db) : null;
  const tail = `${r.stdout || ""}${r.stderr || ""}`.slice(-500);
  if (!usage || !usage.tokens_in) {
    fail(`refusing to score an uncounted run (exit ${r.status}); last output: ${tail}`);
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  return {
    tokens_in: usage.tokens_in,
    tokens_out: usage.tokens_out,
    tokens_cache_read: usage.tokens_cache_read,
    tokens_reasoning: usage.tokens_reasoning,
    turns: usage.turns,
    tool_calls: usage.tool_calls,
    thrash: usage.thrash,
    retries: 0, // opencode retries inside its own accounting; TokenTax cannot see them
  };
}

module.exports = { run, OPENCODE_VERSION, IMAGE, alias, buildConfig, opencodeArgs, parseSessions };
