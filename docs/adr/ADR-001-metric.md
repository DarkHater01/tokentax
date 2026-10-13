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
  counts are not comparable across models. A ratio measured with each model's own
  tokenizer (numerator and denominator in the same unit) cancels that difference.
- **`necessary_tokens` lives in-repo and is contestable.** The denominator is the
  credibility of the benchmark; if it is wrong, open a PR. Same idea as slopbench's
  in-repo reference solutions.
- **Qualify gate at `pass@1 >= 0.6`.** Tokens spent on a task the agent cannot
  solve are not comparable to tokens spent solving it. Unpassed tasks report
  `tax: null`.
- **Median over reps.** Agents are non-deterministic; the mean would be a lie.
- **Frozen, dated price table.** Prices drift, so `$/task` is computed against a
  committed snapshot (`runner/prices.json`, `asof`). Updating it is an explicit,
  reviewable commit — the leaderboard cannot silently rot.
- **Hidden tests (M2).** The agent must not read the test suite; otherwise the
  metric measures test-gaming, not work.
- **Separate mock and live raw files.** A self-test that depends on data the live
  run overwrites is a self-test that breaks in CI. Learned the hard way.

## Alternatives rejected
- Absolute cost (dollars): flatters cheap models and rots with prices.
- Single `tokens` number: hides the waste, which is the whole point.
- `pass@k` alone: already every other benchmark.
