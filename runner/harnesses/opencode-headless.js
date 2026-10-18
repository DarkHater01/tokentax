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
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const sandbox = require("../sandbox");

const OPENCODE_VERSION = "2.0.28"; // must match ARG in sandbox/Dockerfile.opencode
const IMAGE = "tokentax-opencode";
const OC = "/oc"; // the container's writable state dir, bind-mounted from the host
const DEFAULT_TIMEOUT_S = 1500;

const fail = (msg) => {
  throw new Error(`opencode-headless: ${msg}`);
};

// Heuristic, and deliberately narrow: a bare "429" shows up in ordinary output,
// so only a provider's own words count. False positives are the cheap direction
// (a run is dropped and re-run) and false negatives publish a throttled run as a
// model failure, which is the expensive one.
const THROTTLED = /rate.?limit|too many requests|quota exceeded/i;
const throttled = (text) => THROTTLED.test(text);

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
    // Pin the database instead of guessing where the CLI puts it: without this it
    // lands under $XDG_DATA_HOME/opencode/, and reading the wrong path would look
    // like a zero-token run.
    "-e", `OPENCODE_DB=${OC}/data/opencode.db`,
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
// What the harness's own tools said: a tool call that ended in an error is the
// difference between the model writing the wrong thing and the environment
// refusing to let it write anything.
const toolState = (el) => ({
  tool: el.name,
  file: el.state?.input?.filePath,
  status: el.state?.status,
  error: el.state?.status === "error" ? String(el.state?.output || "").split("\n")[0].slice(0, 160) : null,
});

// Content hash per file, so a run can say whether anything it did reached the
// directory it was told to work in. A bind mount that quietly drops writes would
// otherwise look exactly like a model that never edited. Size and mtime are not
// enough: two writes of the same length in the same millisecond are invisible.
function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16));
    }
  };
  walk(dir);
  return out;
}

function parseSessions(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    fail("needs Node >= 22.13 for node:sqlite to read the CLI's token usage");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
    const has = (n) => tables.includes(n);
    // A database this CLI created fresh keeps sessions in session_v2; one migrated
    // from V1 (a developer's) has both, with the legacy one populated. Read the V2
    // table first and report which one was used, so the number is never taken from
    // a guess about the layout.
    const sess = has("session_v2") ? "session_v2" : has("session") ? "session" : null;
    if (!sess) fail(`no session table in the CLI's database (tables: ${tables.join(", ")})`);
    const s = db
      .prepare(
        `select count(*) n, coalesce(sum(tokens_input),0) ti, coalesce(sum(tokens_output),0) t_out, ` +
          `coalesce(sum(tokens_reasoning),0) tr, coalesce(sum(tokens_cache_read),0) cr, ` +
          `coalesce(sum(tokens_cache_write),0) cw, coalesce(sum(cost),0) cost from ${sess}`
      )
      .get();
    if (!s.n) return null;

    // Messages too: V2 keeps them in session_message, a V1-migrated database in
    // message/part. Same turning over either way.
    let schema = "none";
    let turns = 0;
    const calls = [];
    if (has("message") && has("part")) {
      schema = "message/part";
      turns = db.prepare("select count(*) c from message where json_extract(data,'$.role')='assistant'").get().c;
      for (const r of db.prepare("select data from part where json_extract(data,'$.type')='tool'").all()) {
        let o;
        try {
          o = JSON.parse(r.data);
        } catch {
          continue;
        }
        calls.push(toolState({ name: o.tool, state: o.state }));
      }
    } else if (has("session_message")) {
      schema = "session_message";
      // In V2 the kind is the table's own column ('assistant', 'user', 'idle',
      // 'system', ...) and an assistant row carries its parts in data.content:
      // elements of type reasoning/text/tool, a tool element having name and
      // state.input. Reading data.type or data.role instead counts nothing, which
      // is how the first live run reported 13k tokens and zero turns.
      turns = db.prepare("select count(*) c from session_message where type='assistant'").get().c;
      for (const r of db.prepare("select data from session_message where type='assistant'").all()) {
        let o;
        try {
          o = JSON.parse(r.data);
        } catch {
          continue;
        }
        for (const el of Array.isArray(o.content) ? o.content : []) {
          if (el?.type === "tool") calls.push(toolState(el));
        }
      }
    }

    // thrash is the same churn mini-loop counts: a write to a file already written.
    const written = new Set();
    let thrash = 0;
    for (const c of calls) {
      if (!["write", "edit", "patch"].includes(c.tool) || !c.file) continue;
      if (written.has(c.file)) thrash++;
      written.add(c.file);
    }
    return {
      schema,
      sessions: s.n,
      tokens_in: s.ti + s.cr + s.cw,
      tokens_out: s.t_out + s.tr,
      tokens_cache_read: s.cr,
      tokens_reasoning: s.tr,
      cost: s.cost,
      turns,
      tool_calls: calls.length,
      // Which tools, in order: a failed grade reads very differently if the harness
      // never called a write tool than if it did and wrote the wrong thing.
      tools_called: [...new Set(calls.map((c) => c.tool).filter(Boolean))],
      tool_errors: calls.filter((c) => c.error).map((c) => `${c.tool}: ${c.error}`),
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
  const before = snapshot(job);
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", [provider.keyEnv]: key },
    timeout: (timeoutS + 120) * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const db = path.join(runDir, "data", "opencode.db");
  const usage = fs.existsSync(db) ? parseSessions(db) : null;
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(">"))
    .slice(-12);
  // A run the provider throttled is the provider's fault, not the model's: run.js
  // already drops provider errors for that reason, and a free tier that meters
  // 8000 tokens/minute cannot serve a harness that does not pace itself. The
  // signature is looked for in the CLI's own output, never in the workspace.
  if (throttled(out)) {
    fail(`dropped: the provider rate-limited the harness (last output: ${lines.join(" | ").slice(0, 300)})`);
  }
  if (!usage || !usage.tokens_in) {
    fail(
      `refusing to score an uncounted run (exit ${r.status}; database ${fs.existsSync(db) ? "read, no tokens" : "missing"}); ` +
        `run dir holds ${fs.existsSync(runDir) ? fs.readdirSync(runDir).join(",") : "nothing"}; last output: ${lines.join(" | ")}`
    );
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  // Say where the number came from, on every run: the schema is an internal
  // interface, and a silent zero would look like a cheap model. The tail is what
  // makes a failed grade arguable instead of a guess -- a throttled provider and a
  // wrong edit look identical in a token count.
  const changed = [...snapshot(job)].filter(([f, v]) => before.get(f) !== v).map(([f]) => f);
  console.log(
    `   oc: schema ${usage.schema}, ${usage.sessions} session(s), in=${usage.tokens_in} out=${usage.tokens_out} turns=${usage.turns} tools=${usage.tool_calls}` +
      `${usage.tools_called.length ? ` [${usage.tools_called.join(",")}]` : ""}`
  );
  console.log(`   oc workspace: ${changed.length ? `changed ${changed.join(",")}` : "unchanged"}`);
  if (usage.tool_errors.length) console.log(`   oc tool errors: ${usage.tool_errors.join(" | ").slice(0, 400)}`);
  if (lines.length) console.log(`   oc tail: ${lines.join(" | ").slice(0, 900)}`);
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

module.exports = { run, OPENCODE_VERSION, IMAGE, alias, buildConfig, opencodeArgs, parseSessions, throttled, snapshot };
