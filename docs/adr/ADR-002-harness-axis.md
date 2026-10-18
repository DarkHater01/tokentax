# ADR-002: the harness axis runs a real tool, and its tokens come from that tool

## Status
Accepted (M3). Supersedes nothing; extends ADR-001.

## Context
ADR-001 claims the interesting variable is **whether the harness or the model sets
the waste**. With one harness in the table (`mini-loop`, our own loop) that claim
is untestable: the table varies the model and holds the harness fixed at "the
thing we wrote". A reader is right to say the repo publishes a model ranking with
a harness axis printed on it.

To measure the axis, the harness has to be a tool someone actually uses. Once it
is, two questions stop being theoretical: where do the tokens come from, and how
much of the machine does the tool get?

## Decision
`opencode-headless` runs the OpenCode CLI (pinned `2.0.28`) headless inside the
container, on the same tasks, the same models and the same provider and key as
`mini-loop`. Tokens are read from the CLI's own session database, created fresh
per run. The harness refuses to score a run whose database has no tokens.

**Token accounting.** OpenCode's own step records carry
`{total, input, output, reasoning, cache:{read, write}}` and `total` is exactly
their sum, so the fields are disjoint. An OpenAI-compatible provider — what
`mini-loop` counts — instead folds cached reads into `prompt_tokens` and reasoning
into `completion_tokens`. The two sides are therefore summed to the same shape:

    tokens_in  = tokens_input + tokens_cache_read + tokens_cache_write
    tokens_out = tokens_output + tokens_reasoning

The self-test builds a database with the CLI's schema and locks this.

**The system prompt belongs to the harness.** A real harness owns its own prompt,
and replacing it would break the tool loop it ships with, so the `vanilla`/`minimal`
variant instruction is prepended to the request instead of replacing the agent's
prompt. Both harnesses receive the same instruction text; the difference recorded
is its content, not which role carries it.

## Consequences

- **The container needs a network and the key inside it.** An agent CLI cannot
  reach a provider without both. Every other run in this repo is graded with
  `--network none`; this one is not, so the key lives where the model can, in
  principle, read it. Use a scoped, rotatable key, and treat any key used here as
  exposed. The rest of the hardening is unchanged and shared: `--read-only`,
  `--cap-drop ALL`, `no-new-privileges`, memory/cpu/pids limits, non-root, and the
  only writable mounts are the job and the CLI's own state directory.
- **The session schema is an internal interface.** It is the CLI's private
  database, not a published API. It is locked by a test that builds the same
  schema, so an upstream rename fails a test instead of quietly publishing zero
  tokens, and the version is pinned and checked against the built image.
- **Turns and thrash are counted from outside.** `turns` is the CLI's assistant
  messages, `tool_calls` its tool parts, and `thrash` its second write to a file it
  already wrote — the same churn `mini-loop` counts, read from the transcript
  rather than instrumented.
- **Retries are invisible.** The CLI retries inside its own accounting; the record
  says `retries: 0` because TokenTax cannot see them. This is stated rather than
  guessed at.
- **The image carries the harness, not the task.** `sandbox/Dockerfile.opencode`
  installs the CLI plus `ripgrep`, which its own search tools need. A harness that
  finds its tools broken measures the image, not the harness; the first live run
  said exactly that (`Glob "*" failed: ripgrep execution failed`) and the fix was
  to give it the tools.

## Alternatives rejected

- **Re-implement the CLI's loop.** Cheaper to test, and pointless: the number would
  be ours again, which is the problem this ADR exists to fix.
- **Run the CLI on the host.** Its `bash` tool would then execute model-written
  commands on the user's machine. A benchmark that asks a stranger to run it cannot
  do that.
- **Give the CLI no sandbox at all in CI (a throwaway runner).** It would work, and
  it would make the local path and the CI path different machines, which is how a
  benchmark stops being reproducible.
