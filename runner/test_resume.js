#!/usr/bin/env node
// Offline self-test for the resume key. Getting this wrong is expensive in the
// direction that is hard to see: a key that changes for no reason throws away a
// finished run and silently re-runs it, and one that stays the same across two
// different experiments averages them into one published number.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { envHash, relevantCfg } = require("./lib");

const taskDir = path.join(__dirname, "..", "tasks", "01-fix-failing-test");
const base = {
  reps: 3,
  max_turns: 25,
  max_tokens: 200000,
  pass_timeout_seconds: 50,
  qualify_threshold: 0.6,
  provider: "groq",
  note: "live config",
  variants: { vanilla: "v", minimal: "m" },
  harnesses: [{ id: "mini-loop" }],
  models: [{ id: "openai/gpt-oss-120b" }],
};
const hash = (cfg, id = "mini-loop", dir = taskDir) => envHash(dir, id, cfg);

// The property that costs a whole run when it breaks.
const added = {
  ...base,
  note: "a different sentence",
  harnesses: [...base.harnesses, { id: "opencode-headless" }],
  models: [...base.models, { id: "openai/gpt-oss-20b" }],
};
assert.strictEqual(hash(base), hash(added), "adding an unrelated harness or model must not invalidate a finished record");
assert.deepStrictEqual(Object.keys(relevantCfg(base, "mini-loop")).includes("models"), false, "the model list is not part of the key");

// What must invalidate it: anything that changes the run itself.
assert.notStrictEqual(hash(base), hash({ ...base, max_turns: 26 }), "a run knob must invalidate");
assert.notStrictEqual(hash(base), hash({ ...base, provider: "openrouter" }), "the endpoint must invalidate");
assert.notStrictEqual(hash(base), hash({ ...base, variants: { vanilla: "v", minimal: "different" } }), "a prompt must invalidate");
assert.notStrictEqual(
  hash(base),
  hash({ ...base, harnesses: [{ id: "mini-loop", max_turns: 5 }] }),
  "the harness's own entry must invalidate"
);
assert.notStrictEqual(hash(base), hash(base, "opencode-headless"), "another harness is another experiment");
assert.notStrictEqual(hash(base), hash({ ...base, reps: 5 }), "the rep count must invalidate");

// The task's own bytes, not just its path.
const copy = fs.mkdtempSync(path.join(os.tmpdir(), "tokentax-task-"));
for (const f of ["task.md", "task.json"]) fs.copyFileSync(path.join(taskDir, f), path.join(copy, f));
for (const d of ["workspace", "tests"]) fs.cpSync(path.join(taskDir, d), path.join(copy, d), { recursive: true });
assert.strictEqual(hash(base, "mini-loop", copy), hash(base), "a byte-identical copy of the task is the same experiment");
fs.appendFileSync(path.join(copy, "task.md"), "\nand one more sentence\n");
assert.notStrictEqual(hash(base, "mini-loop", copy), hash(base), "an edited prompt must invalidate");
fs.rmSync(copy, { recursive: true, force: true });

console.log("test_resume: PASS (unrelated harness/model/note do not invalidate; knobs, prompts, harness and task bytes do)");
