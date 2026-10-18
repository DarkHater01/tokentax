#!/usr/bin/env node
// Offline self-test for the opencode-headless harness. No Docker, no key, no
// network: it locks the two things that would silently corrupt a published
// number -- the token accounting read out of the CLI's own database, and the
// hardening of the container the CLI runs in.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const h = require("./harnesses/opencode-headless");

const FAKE_KEY = "gsk_do_not_put_this_in_a_config_or_an_argv_000000";
process.env.GROQ_API_KEY = FAKE_KEY;

// ---- the accounting: a database with the schema the CLI actually writes -------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentax-oc-"));
const mkDb = (name) => {
  const p = path.join(tmp, name);
  const db = new DatabaseSync(p);
  db.exec(`
    create table session (id text primary key, tokens_input integer, tokens_output integer,
      tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer, cost real);
    create table message (id text primary key, session_id text, data text);
    create table part (id text primary key, message_id text, session_id text, data text);
  `);
  return { p, db };
};

const { p: dbPath, db } = mkDb("opencode.db");
db.prepare("insert into session values ('s1', 1000, 200, 50, 300, 10, 0.42)").run();
db.prepare("insert into session values ('s2', 0, 0, 0, 0, 0, 0)").run(); // title/summary call
let i = 0;
const msg = (role) => db.prepare("insert into message values (?, 's1', ?)").run(`m${i++}`, JSON.stringify({ role }));
const part = (data) => db.prepare("insert into part values (?, 'm0', 's1', ?)").run(`p${i++}`, JSON.stringify(data));
msg("user");
msg("assistant");
msg("assistant");
part({ type: "tool", tool: "write", state: { input: { filePath: "/job/a.py" } } });
part({ type: "tool", tool: "edit", state: { input: { filePath: "/job/a.py" } } }); // the churn
part({ type: "tool", tool: "bash", state: { input: { command: "pytest" } } });
part({ type: "text", text: "done" });
db.close();

const u = h.parseSessions(dbPath);
assert.strictEqual(u.sessions, 2, "every session in the throwaway database is summed");
assert.strictEqual(u.tokens_in, 1000 + 300 + 10, "input side = uncached + cache read + cache write");
assert.strictEqual(u.tokens_out, 200 + 50, "output side = output + reasoning (disjoint in opencode's own step records)");
assert.strictEqual(u.tokens_cache_read, 300, "the cache component stays visible for audit");
assert.strictEqual(u.turns, 2, "turns are assistant messages");
assert.strictEqual(u.tool_calls, 3, "tool calls are tool parts");
assert.strictEqual(u.thrash, 1, "a second write to the same file is the same churn mini-loop counts");

const empty = mkDb("empty.db");
empty.db.close();
assert.strictEqual(h.parseSessions(empty.p), null, "an empty database must not read as a zero-token run");

// ---- the container: hardening, and no secret in the argv ----------------------
const args = h.opencodeArgs({
  runDir: "/tmp/run1",
  jobDir: "/tmp/job1",
  provider: "groq",
  modelId: "openai/gpt-oss-120b",
  keyEnv: "GROQ_API_KEY",
  message: "solve it",
});
const argv = args.join(" ");
for (const needed of [
  "--network bridge", // the one flag a real harness needs and the grader does not
  "/tmp/job1:/job",
  "/tmp/run1:/oc",
  "--read-only",
  "--cap-drop ALL",
  "--security-opt no-new-privileges",
  "--pids-limit 128",
  "-w /job",
  "-e GROQ_API_KEY",
  "-e OPENCODE_DB=/oc/data/opencode.db",
  "--model groq/openai-gpt-oss-120b",
]) {
  assert(argv.includes(needed), `docker argv must contain: ${needed}`);
}
assert(!argv.includes(FAKE_KEY), "the provider key must not travel in argv (docker reads it from its own env)");
assert(args.indexOf(h.IMAGE) > 0 && args.indexOf(h.IMAGE) < args.indexOf("opencode"), "the command must come after the image");

// ---- the provider config: credentials by reference, never by value ------------
const cfg = h.buildConfig({ provider: "groq", base: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", modelId: "openai/gpt-oss-120b" });
const groq = cfg.providers.groq;
assert.strictEqual(groq.package, "@opencode/ai/providers/openai-compatible", "a custom provider must name its runtime package");
assert.strictEqual(groq.settings.baseURL, "https://api.groq.com/openai/v1");
assert.deepStrictEqual(groq.env, ["GROQ_API_KEY"], "the credential is named by env var");
assert.strictEqual(groq.models["openai-gpt-oss-120b"].modelID, "openai/gpt-oss-120b", "the slash in the model id moves to modelID");
assert(!JSON.stringify(cfg).includes(FAKE_KEY), "the config file must never hold the secret");

// ---- the image, when it is built: the pinned version must be the real one -----
const has = spawnSync("docker", ["image", "inspect", h.IMAGE], { encoding: "utf8" });
if (has.status !== 0) {
  console.log("test_opencode_harness: PASS (offline: accounting, hardening, config; image not built, version check skipped)");
} else {
  const v = spawnSync("docker", ["run", "--rm", h.IMAGE, "cat", "/opt/opencode.version"], { encoding: "utf8" });
  assert.strictEqual(
    (v.stdout || "").trim(),
    h.OPENCODE_VERSION,
    `the built image must report ${h.OPENCODE_VERSION}; the harness stamp names that version`
  );
  console.log(`test_opencode_harness: PASS (offline + image reports opencode ${h.OPENCODE_VERSION})`);
}
fs.rmSync(tmp, { recursive: true, force: true });
