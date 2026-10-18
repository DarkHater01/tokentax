// Minimal ReAct agent loop: model + tools -> edits a job workspace.
// Dependency-injected (chat, sandbox) so it is testable offline with fakes.
// Zero dependencies.
const fs = require("fs");
const path = require("path");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace. Path is relative to the workspace root.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file in the workspace. Path is relative to the workspace root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run the tests currently present in the workspace and return the output. Use it to check your own work.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const TOOL_HELP =
  "\n\nYou work inside an isolated workspace using tools: read_file, write_file, run_tests. " +
  "The workspace starts with code but no tests; write your own with write_file if you want feedback. " +
  "When the task is complete, reply with a short message and NO tool calls: the run ends and a " +
  "hidden test suite is executed against your final files.";

// Real path of the nearest existing ancestor: a path we are about to create has
// no realpath of its own, but its parent tells us where it would land.
function realAncestor(p) {
  let d = p;
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return fs.realpathSync(d);
}

// The job directory is bind-mounted read-write into the container, so model code
// can plant a symlink in it and a purely lexical guard would let the host-side
// tools follow it out of the workspace (verified: a write through job/evil ->
// /tmp/victim overwrote victim). Resolve real paths and refuse anything that
// leaves the job, symlinked targets included. The container is not running while
// these tools execute, so there is no concurrent writer to race against.
function safeResolve(job, p) {
  const full = path.resolve(job, String(p ?? ""));
  if (full !== job && !full.startsWith(job + path.sep)) throw new Error(`path escapes workspace: ${p}`);
  if (full === job) return full;
  if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) {
    throw new Error(`refusing symlink in workspace: ${p}`);
  }
  const jobReal = fs.realpathSync(job);
  const parentReal = realAncestor(path.dirname(full));
  if (parentReal !== jobReal && !parentReal.startsWith(jobReal + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return full;
}

async function run({ job, taskMd, system, cfg, chat, sandbox }) {
  const messages = [
    { role: "system", content: `${system}${TOOL_HELP}` },
    { role: "user", content: taskMd },
  ];
  let tokens_in = 0;
  let tokens_out = 0;
  let tool_calls = 0;
  let turns = 0;
  let thrash = 0;
  let retries = 0;
  const written = new Set();

  for (turns = 1; turns <= cfg.max_turns; turns++) {
    const { message, usage, retries: r_tries = 0, retry_tokens_in = 0 } = await chat(messages, TOOLS);
    // Retried requests re-send the prompt; a run that thrashes against the
    // provider must not look cheaper than one that does not.
    tokens_in += (usage.prompt_tokens ?? usage.input_tokens ?? 0) + retry_tokens_in;
    tokens_out += usage.completion_tokens ?? usage.output_tokens ?? 0;
    retries += r_tries;
    messages.push(message);

    const calls = message.tool_calls || [];
    if (!calls.length) break;

    for (const c of calls) {
      tool_calls++;
      let result;
      try {
        const name = c.function?.name;
        const args = JSON.parse(c.function?.arguments || "{}");
        if (name === "read_file") {
          result = fs.readFileSync(safeResolve(job, args.path), "utf8");
        } else if (name === "write_file") {
          if (written.has(args.path)) thrash++;
          const full = safeResolve(job, args.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, args.content ?? "");
          written.add(args.path);
          result = "ok";
        } else if (name === "run_tests") {
          const r = sandbox.pytest(job, cfg.pass_timeout_seconds);
          result = r.tail || (r.passed ? "PASS" : "FAIL");
        } else {
          result = `unknown tool: ${name}`;
        }
      } catch (e) {
        result = `error: ${e.message}`;
      }
      messages.push({ role: "tool", tool_call_id: c.id || `call_${tool_calls}`, content: String(result).slice(0, 8000) });
    }
  }

  return { tokens_in, tokens_out, turns: Math.min(turns, cfg.max_turns), tool_calls, thrash, retries };
}

module.exports = { run, TOOLS, TOOL_HELP };
