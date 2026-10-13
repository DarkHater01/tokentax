#!/usr/bin/env node
// Offline self-test for the agent loop. No API key, no Docker: chat and sandbox
// are fakes. Run: node runner/test_harness.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const harness = require("./harnesses/mini-loop");

const REPO = path.resolve(__dirname, "..");
const TMP = path.join(REPO, "runner", "tmp", "harness-test");

function fakeChat(script) {
  let i = 0;
  return async (messages, tools) => {
    assert(Array.isArray(tools) && tools.length, "tools must be passed to chat");
    const step = script[i++];
    assert(step, "chat called more times than scripted");
    return { message: step.message, usage: step.usage || {} };
  };
}

const fakeSandbox = { pytest: () => ({ passed: true, tail: "1 passed", junit: { tests: 1, failures: 0, errors: 0 } }) };

const toolCall = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const finish = { role: "assistant", content: "done", tool_calls: [] };

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const cfg = { max_turns: 6, pass_timeout_seconds: 10 };
  const base = { job: TMP, taskMd: "do it", system: "sys", cfg, sandbox: fakeSandbox };

  // 1) write a file, then finish: tokens sum, one tool call, two turns
  let r = await harness.run({
    ...base,
    chat: fakeChat([
      { message: { role: "assistant", content: null, tool_calls: [toolCall("c1", "write_file", { path: "a.py", content: "x = 1\n" })] }, usage: { prompt_tokens: 100, completion_tokens: 20 } },
      { message: finish, usage: { prompt_tokens: 150, completion_tokens: 10 } },
    ]),
  });
  assert.strictEqual(r.tokens_in, 250, "tokens_in must sum usage");
  assert.strictEqual(r.tokens_out, 30, "tokens_out must sum usage");
  assert.strictEqual(r.tool_calls, 1, "one tool call");
  assert.strictEqual(r.turns, 2, "two turns");
  assert.strictEqual(r.thrash, 0, "no thrash on first write");
  assert.strictEqual(fs.readFileSync(path.join(TMP, "a.py"), "utf8"), "x = 1\n", "file written");

  // 2) path escape is reported as a tool error, not a crash
  r = await harness.run({
    ...base,
    chat: fakeChat([
      { message: { role: "assistant", content: null, tool_calls: [toolCall("c1", "read_file", { path: "../secret" })] } },
      { message: finish },
    ]),
  });
  assert.strictEqual(r.tool_calls, 1, "escape attempt still counted, run survived");

  // 3) thrash counts rewriting the same path
  r = await harness.run({
    ...base,
    chat: fakeChat([
      { message: { role: "assistant", content: null, tool_calls: [toolCall("c1", "write_file", { path: "b.py", content: "1" })] } },
      { message: { role: "assistant", content: null, tool_calls: [toolCall("c2", "write_file", { path: "b.py", content: "2" })] } },
      { message: finish },
    ]),
  });
  assert.strictEqual(r.thrash, 1, "second write to same path is thrash");
  assert.strictEqual(r.tool_calls, 2, "both writes counted");

  // 4) max_turns is respected when the model never stops
  r = await harness.run({
    ...base,
    chat: fakeChat(
      Array.from({ length: 6 }, (_, k) => ({
        message: { role: "assistant", content: null, tool_calls: [toolCall(`t${k}`, "read_file", { path: "a.py" })] },
      })),
    ),
  });
  assert.strictEqual(r.turns, 6, "loop stops at max_turns");
  assert.strictEqual(r.tool_calls, 6, "every turn made one call");

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("test_harness: PASS (tokens, tools, escape-safe, thrash, max-turns)");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
