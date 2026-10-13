# TokenTax

[![ci](https://github.com/DarkHater01/tokentax/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkHater01/tokentax/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-informational)](https://nodejs.org)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](runner)

**Every agent benchmark ranks how smart a model is. None ranks how much of the bill was waste.**

TokenTax asks the question nobody publishes: of everything an agent spent to finish the task, **how much was thrown away** — and **was it the model or the harness that set the price?**

The headline number is a ratio, not a dollar amount:

```
tax = (tokens_in + tokens_out) / necessary_tokens(model)
```

`tax = 4.0×` means the agent spent four times what the task actually needed.

---

## The hook: same model, different bill

The leaderboard is not `model`, it is **`model × harness`**. Run the same model through a lean loop and through a heavy harness and the invoice moves — while the outcome does not.

Here is the offline fixture (mechanism demo, **not** a live leaderboard — see [Status](#status)):

| harness | model | pass@1 | `tax` | `$/task` | `thrash` | `Δ minimality` |
|---|---|---|---|---|---|---|
| `mini-loop` | `mock-lean` | 1.00 | **2.57×** | $0.0021 | 0.4 | −0.49 |
| `mini-loop` | `mock-bloated` | 0.80 | 7.03× | $0.0055 | 4.0 | −2.62 |
| `fat-harness` | `mock-lean` | 1.00 | **6.17×** | $0.0049 | 0.4 | −1.18 |
| `fat-harness` | `mock-bloated` | 0.80 | 16.88× | $0.0133 | 4.0 | −6.27 |

Read the `mock-lean` rows: **the same model, the same solvable task, 2.4× the tax** — only the harness changed. And the `Δ minimality` column shows a system prompt alone shaves tokens off every row, on every harness.

## Why this is not just "cost per task"

`$`/task is already published ([AWS `sample-agent-cost-bench`](https://github.com/aws-samples/sample-agent-cost-bench), [artificialanalysis.ai](https://artificialanalysis.ai/agents/coding-agents), GitTaskBench). Publishing the invoice again buys nothing. Three things here are not published elsewhere:

1. **Waste, not price.** `tax` normalizes the spend against what the task *needed*, so a cheap model that thrashes and an expensive model that is precise are finally comparable.
2. **The harness axis.** Everyone ranks models. The bill is set by the harness — and nobody measures that.
3. **A contestable denominator.** The `necessary_tokens` for every task is in the repo (`tasks/<id>/reference/trajectory.json`). If it is wrong, open a PR. That is the benchmark's credibility.

## The metric, precisely

| metric | definition |
|---|---|
| `pass@1` | fraction of reps whose final files pass the hidden suite |
| `tax` | `(tokens_in + tokens_out) / necessary_tokens(model)` |
| `thrash` | rewrites of a file the agent already wrote (waste proxy) |
| `$/task` | median cost per solved task, against a frozen, dated price table |
| `Δ minimality` | `tax(vanilla) − tax(minimal prompt)`, per model × harness |

**Why a ratio.** Tokenizers differ across providers, so raw token counts are not comparable between models. A ratio measured with each model's own tokenizer — numerator and denominator in the same unit — cancels that difference. It is the reason the leaderboard can mix providers at all.

**Why `tax` is only counted for solved tasks.** `tax` is only reported for `model × harness × task` groups where `pass@1 ≥ 0.6`. Tokens spent failing a task are not comparable to tokens spent solving it; unpassed groups report `tax: null`.

## Rigor: the scorer is the check

`runner/score.js` refuses to publish numbers that do not add up. It aborts if:

- any group is missing a rep, or has a duplicate rep;
- `passed` is not a boolean, or token counts are out of range;
- `tax` lands outside `[0, 1000]`;
- a harness / model / task / variant is unknown;
- a model has no frozen price (the leaderboard cannot silently rot).

Agents are non-deterministic, so every figure is a **median over 5 reps**. Generated code runs inside a hardened container: `--network none`, root filesystem `--read-only`, `--cap-drop ALL`, `--no-new-privileges`, memory/pid/cpu limits, non-root.

## Tasks are verified, not assumed

Every task ships a **broken workspace**, a **hidden test suite** (the agent never sees it — it is mounted only at grading time, under `_grade/`), and a **reference solution**. CI proves all three still agree:

```
$ node runner/test_tasks.js
  01-fix-failing-test: workspace fails, reference passes
  02-add-cli-flag: workspace fails, reference passes
  03-rename-symbol: workspace fails, reference passes
  04-fix-bug-2-files: workspace fails, reference passes
  05-dedupe-keep-green: workspace fails, reference passes
test_tasks: PASS (5 tasks, workspace-fails + reference-passes)
```

That last check already paid for itself: it caught a task whose "broken" version passed, which would have let an agent do nothing and claim a near-zero tax.

## Run it

**Offline — no API key, no cost** (proves the loop and the scorer):

```bash
node runner/test_harness.js   # agent loop: token accounting, tool dispatch, path-escape safety, thrash, max-turns
node runner/test_score.js     # scorer guards: missing rep, duplicate rep, qualify gate, harness axis
```

**Against the real sandbox — needs Docker** (proves every task):

```bash
node runner/test_tasks.js
```

**A real run — needs an OpenRouter key:**

```bash
# 1. put your models in runner/config.json and their prices in runner/prices.json
export OPENROUTER_API_KEY=sk-or-...
node runner/run.js      # model × task × harness × rep -> data/raw.json
node runner/score.js    # data/raw.json -> data/results.json
```

Only the `mini-loop` harness is implemented today. `opencode-headless` and `claude-code-headless` are on the roadmap (M3) — that is where the harness axis gets interesting.

## Layout

```
runner/run.js            fixtures or a real agent harness
runner/score.js          raw -> results.json; validates everything ("this file is the check")
runner/sandbox.js        hardened Docker sandbox: build image, materialize jobs, grade
runner/openrouter.js     chat transport with retries
runner/harnesses/        mini-loop.js (DI'd loop: read_file / write_file / run_tests)
runner/test_harness.js   offline loop self-test (fake chat + fake sandbox)
runner/test_score.js     offline scorer self-test
runner/test_tasks.js     tasks vs the real sandbox (needs Docker)
runner/prices.json       frozen, dated price snapshot
tasks/<id>/              task.md + workspace/ + tests/ (hidden) + reference/
docs/adr/ADR-001-metric.md
```

Mock and live data are separate files (`data/raw.mock.json` vs `data/raw.json`) so a live run can never clobber the fixtures the self-test needs.

## Status

- **M1 — metric engine.** fixtures + scorer + offline self-test. ✅
- **M2 — real engine.** sandbox, agent loop, hidden tests, verified tasks, CI. ✅
- **M3 — breadth.** opencode-headless and claude-code-headless harnesses, static leaderboard, badge endpoint.
- **M4 — launch.** `demo.gif`, HN/Reddit.

There is **no live leaderboard yet** — that needs a funded `OPENROUTER_API_KEY`, and the weekly job (`bench.yml`) writes `data/` when the secret is present. The table at the top is the offline fixture and is labelled as such on purpose: a benchmark that ships fake numbers is the thing it was built to measure.

## Contributing

Attack the denominator. If `necessary_tokens` for a task is wrong, or a task is unfair, open a PR against `tasks/<id>/reference/trajectory.json`. Same energy as slopbench's in-repo reference solutions — the metric is only as good as its baseline.

## License

MIT. Sibling project: [slopbench](https://github.com/DarkHater01/slopbench) measures wasted *lines*. TokenTax measures wasted *tokens*.
