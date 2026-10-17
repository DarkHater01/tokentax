#!/usr/bin/env node
// Self-test for the chat transport against a local stub server. No network.
// Covers the three branches that decide whether a run lives or dies:
// a rejected tool name (nudge + retry), a hard 4xx (no retry), a 429 (retry).
const http = require("http");
const assert = require("assert");
const chatApi = require("./chat.js");

process.env.GROQ_API_KEY = "test-key";

const TOOLS = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
const MSGS = [{ role: "user", content: "task" }];

function withStub(handler, fn) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push(JSON.parse(raw));
        handler(seen.length, res);
      });
    });
    srv.listen(0, "127.0.0.1", async () => {
      const provider = chatApi.PROVIDERS.groq;
      const [base, pace] = [provider.base, provider.paceMs];
      provider.base = `http://127.0.0.1:${srv.address().port}`;
      provider.paceMs = 0;
      try {
        resolve(await fn(seen));
      } catch (e) {
        reject(e);
      } finally {
        provider.base = base;
        provider.paceMs = pace;
        srv.close();
      }
    });
  });
}

const reply = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};
const completion = { choices: [{ message: { role: "assistant", content: "done" } }], usage: {} };

async function main() {
  // A tool name the harness never defined: provider rejects it, so we retry with
  // the real tool list spelled out. This is what kept task 02 at 0%.
  await withStub(
    (n, res) =>
      n === 1
        ? reply(res, 400, { error: { message: "attempted to call tool 'repo_browser.search' which was not in request.tools", code: "tool_use_failed" } })
        : reply(res, 200, completion),
    async (seen) => {
      const r = await chatApi.chat({ provider: "groq", model: "m", messages: MSGS, tools: TOOLS });
      assert.ok(r.message, "should return the completion after the retry");
      assert.strictEqual(seen.length, 2, "should retry exactly once");
      assert.strictEqual(seen[1].messages.length, 2, "the retry carries one extra message");
      assert.match(seen[1].messages[1].content, /read_file/, "the nudge names the real tools");
      assert.deepStrictEqual(seen[1].messages[0], MSGS[0], "the original turn is untouched");
    }
  );

  // A hard 4xx is not the network's fault and must not be retried.
  await withStub(
    (n, res) => reply(res, 401, { error: { message: "invalid key" } }),
    async (seen) => {
      await assert.rejects(
        () => chatApi.chat({ provider: "groq", model: "m", messages: MSGS, tools: TOOLS }),
        /401/
      );
      assert.strictEqual(seen.length, 1, "must not retry a 401");
    }
  );

  // Rate limits are transient: retry, and keep the transcript clean.
  await withStub(
    (n, res) =>
      n === 1
        ? reply(res, 429, { error: { message: "rate limited", code: "rate_limit_exceeded" } }, { "retry-after": "0" })
        : reply(res, 200, completion),
    async (seen) => {
      const r = await chatApi.chat({ provider: "groq", model: "m", messages: MSGS });
      assert.ok(r.message, "should return the completion after the 429");
      assert.strictEqual(seen.length, 2, "should retry the 429");
      assert.strictEqual(seen[1].messages.length, 1, "no nudge on a rate limit");
    }
  );

  console.log("test_chat: PASS (tool-nudge, no-retry-4xx, retry-429)");
}

main().catch((e) => {
  console.error(`test_chat: FAIL ${e.message}`);
  process.exit(1);
});
