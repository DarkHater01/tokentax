# Contributing

Three things are one line, one file, or one argument. Pick the one you want.

## Dispute a denominator (the most valuable PR here)

`necessary_tokens` is the whole metric: `tax = (tokens_in + tokens_out) / necessary_tokens`.
If the number for a task is wrong, the published `tax` is wrong, and nobody can tell
from the table.

`necessary_tokens` is recomputed from the task's own bytes by `runner/reference_cost.js`
(prompt floor, tool schema per turn, files that must be read, the patch that must be
written). `runner/test_reference_cost.js` fails CI if the committed value drifts. The one
declared part is the minimal step list in `tasks/<id>/reference/trajectory.json`, and that
is the part to argue with: open a PR that changes the list — fewer steps, a different
reading, a cheaper patch — and say why the task still gets solved. The number follows the
argument automatically.

## Add a model (one line, plus a price if it is paid)

`runner/config.json` → `models: [{"id": "..."}]`. On the free tier `$/task` is `$0` and
that is honest: the invoice column only means something when the model costs money, so
add the provider's price per million tokens to `runner/prices.json` if there is one, in a
dated entry. Frozen prices are the point: a ratio that silently follows a price change is
not reproducible.

## Add a harness (one file, one test)

The thesis is `model × harness`. Today it has one entry on each side, and that is the
single biggest gap in the repo. A harness is a module in `runner/harnesses/<id>.js` that
exports `run({ job, taskMd, system, cfg, chat, sandbox, provider, modelId })` and returns:

```js
{ tokens_in, tokens_out, turns, tool_calls, thrash }
```

What it does inside is its own business. `mini-loop` uses the repo's transport (`chat`)
and the sandbox; `opencode-headless` ignores both and drives the real OpenCode CLI inside
its own image, reading usage from the CLI's own database. Both are ~200 lines. Then:

1. register it in `runner/run.js` (`HARNESSES`);
2. add `runner/test_<id>.js` and wire it into `.github/workflows/ci.yml` — offline, no key,
   no Docker required;
3. add `{"id": "<id>"}` to `runner/config.json` (weekly run) or
   `runner/config.harness.json` (the harness axis on one task). Adding a harness
   invalidates only that harness's records, by design.

Two house rules that are not negotiable, because they are what makes the number worth
reading:

- **A run that a provider throttled is dropped, not scored.** An error is the network, not
  the model, and a benchmark that freezes transient failures into its table is measuring
  its own tier. `run.js` and `opencode-headless` both enforce this. If your harness can
  see it, drop it too.
- **No hand-typed numbers.** The README table, the fixture block, `docs/badge.json` and
  the social card are all generated from `data/results.json`; CI fails if any of them
  drifts. If you need a number in prose, date it and point at the block.

## Add a task

`tasks/<id>/` needs `task.json`, `task.md`, `workspace/` (what the agent sees),
`tests/` (hidden — never mounted into the job) and `reference/trajectory.json`. Then:

```bash
node runner/test_tasks.js   # needs Docker: verifies the task against the real sandbox
```

A task is rejected on one ground: if the reference solution does not pass its own tests,
or the tests pass without the fix, the task is measuring nothing.

## Before you push

```bash
node runner/test_chat.js && node runner/test_sandbox.js && node runner/test_leaderboard.js \
  && node runner/test_reference_cost.js && node runner/test_harness.js \
  && node runner/test_opencode_harness.js && node runner/test_badge.js \
  && node runner/test_resume.js && node runner/test_score.js && node runner/demo.js
```

That is exactly what CI runs, plus the Docker job for the tasks. Every non-trivial script
in this repo has an offline self-test; a PR without one is not reviewable.
