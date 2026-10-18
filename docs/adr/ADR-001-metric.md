# ADR-001: the metric is `tax`, a ratio, not a dollar amount

## Status
Accepted (M1).

## Context
"Cost per task" is already published: `aws-samples/sample-agent-cost-bench`,
artificialanalysis.ai/agents, GitTaskBench. Publishing the invoice again buys us
nothing. What is missing is **how much of the invoice was waste**, and **whether
the harness or the model sets it**.

## Decision
The headline metric is `tax = tokens_total / necessary_tokens(model)`.
Secondary: `thrash`, `$/task` (frozen prices), `Δ minimality`.

## Consequences

- **A ratio, not dollars.** Tokenizers differ across providers, so absolute token
  counts are not comparable across models, and a ratio removes most of that
  difference: every model is quoted against the same denominator. It does not
  cancel it exactly. The numerator is each provider's real count; the denominator
  is estimated at four characters per token, because measuring with every
  provider's tokenizer would mean a dependency per provider and a key to run the
  tests. `tax` therefore compares models closely, not exactly, and a model with a
  more verbose tokenizer is penalised slightly. Stating this is cheaper than
  being caught out by it.
- **`necessary_tokens` is measured, and the measurement is contestable.**
  `runner/reference_cost.js` rebuilds the denominator from the task's own bytes:
  the prompt floor, the tool schema sent with every request, the files that must
  be read, and the patch that must be written, with the transcript re-sent each
  turn. `runner/test_reference_cost.js` fails when the committed value drifts from
  the files. What remains declared — and is therefore the thing to argue with — is
  the minimal step list in `tasks/<id>/reference/trajectory.json`. Solve the task
  in fewer turns and the denominator moves.
- **Qualify gate at `pass@1 >= 0.6`.** Tokens spent on a task the agent cannot
  solve are not comparable to tokens spent solving it. Unpassed tasks report
  `tax: null`.
- **Median over reps.** Agents are non-deterministic; the mean would be a lie.
- **Frozen, dated price table.** Prices drift, so `$/task` is computed against a
  committed snapshot (`runner/prices.json`, `asof`). Updating it is an explicit,
  reviewable commit — the leaderboard cannot silently rot.
- **Hidden tests (M2).** The agent must not read the test suite; otherwise the
  metric measures test-gaming, not work.
- **The grade is decided outside the workspace (M2 fix).** Grading copies the
  hidden tests next to a conftest we write, outside the job, mounts the job
  read-only, keeps the workspace off the interpreter's import path, and writes the
  junit report outside the job. It then requires pytest to have exited `0` with a
  report that says a suite ran. Before this, the grade was read from a file the
  agent's own `run_tests` tool wrote into its workspace, which meant a forged
  report could decide a pass. Any run published before this fix is withdrawn, and
  `runner/test_sandbox.js` pins the invariant down.
- **`tax` is a lower bound.** `run_tests` output is not knowable offline, so it
  is excluded from the denominator; including it only enlarges the minimum. The
  published number is therefore a floor on waste, not a point estimate.
- **The fixture writes to `runner/tmp/`, never to `data/`.** A self-test that
  depends on data a live run overwrites is a self-test that breaks in CI. Learned
  the hard way, in the sibling repository.

## Alternatives rejected
- Absolute cost (dollars): flatters cheap models and rots with prices.
- Single `tokens` number: hides the waste, which is the whole point.
- `pass@k` alone: already every other benchmark.
