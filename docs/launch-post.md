# TokenTax — launch post (draft)

## Title options

1. TokenTax: a benchmark for the tokens an agent wasted, not the tokens it used
2. Show HN: TokenTax — of everything your agent spent, how much was thrown away?
3. Same model, same task, different bill: measuring agent token waste

## The hook

Every agent benchmark ranks how smart a model is; TokenTax asks how much of the
bill was waste, and whether the model or the harness set the price.

## What it measures

The headline is a ratio, not a dollar amount:

```
tax = (tokens_in + tokens_out) / necessary_tokens
```

`tax = 4.0×` means the agent spent four times what the task actually needed. The
full metric set is `pass@1`, `tax`, `thrash`, `$/task`, and `Δ minimality`; the
definitions are in the metric table in the [README](../README.md#the-metric-precisely)
and in [ADR-001](adr/ADR-001-metric.md).

`necessary_tokens` is measured, not typed. `runner/reference_cost.js` rebuilds it
from the task's own bytes: the prompt floor, the tool schema sent with every
request, the files that must be read, and the patch that must be written, with the
transcript re-sent every turn. `runner/test_reference_cost.js` fails CI if the
committed value drifts from the task's files. What stays declared — and is
therefore the thing to argue with — is the minimal step list in
`tasks/<id>/reference/trajectory.json`.

Published numbers live only in the machine-generated blocks in the [README](../README.md):
the leaderboard between the `LEADERBOARD` markers, and the labelled offline
fixture. I am not retyping a number here. If you want one, read the README.

## What it found so far (2026-10-18)

Two models, five tasks, three repetitions, one lean harness, and a denominator
rebuilt from each task's own bytes:

- `openai/gpt-oss-120b` — `pass@1` 0.93, `tax` **2.43×**. In plain words: of
  everything it spent, **59% was above the floor** the task required.
- `openai/gpt-oss-20b` — `pass@1` 1.00, `tax` **3.43×**. That is **71%** above the
  floor — a model can pass every task and still be the wasteful one.
- Same models, told to write the least code that satisfies the spec: 2.17× and
  2.22×. **A third of the small model's waste was wording**, not capability: the
  harness's prompt made the difference.

The README block is regenerated every Monday and is the source of truth; the numbers
in this paragraph are dated, not canonical. If they have moved, the table wins.

## How to reproduce it

The whole offline demo — no API key, no network — is this one paste:

```bash
M=runner/config.mock.json
TOKENTAX_CONFIG=$M TOKENTAX_RAW=runner/tmp/m.json TOKENTAX_OUT=runner/tmp/r.json node runner/run.js
TOKENTAX_CONFIG=$M TOKENTAX_RAW=runner/tmp/m.json TOKENTAX_OUT=runner/tmp/r.json node runner/score.js
TOKENTAX_LB_MARKER=FIXTURE node runner/leaderboard.js runner/tmp/r.json
```

There is no `package.json` and no single npm script; that block is the entrypoint.
The self-tests prove the machinery: `node runner/test_chat.js`,
`node runner/test_sandbox.js`, `node runner/test_leaderboard.js`,
`node runner/test_reference_cost.js`, `node runner/test_harness.js`,
`node runner/test_score.js`. `node runner/test_tasks.js` needs Docker. A real run
needs a provider key and is `node runner/run.js` then `node runner/score.js`; see
[Run it](../README.md#run-it).

## What it does NOT claim

- **Not yet a demonstrated harness axis.** `mini-loop` is scored; the second harness
  (`opencode-headless`, the real OpenCode CLI headless inside its own image, usage read
  from the CLI's own database) is implemented, hardened and verified live, but **not
  scored**: it costs ~10.5k tokens per run against the lean loop's ~1.9k, so the
  five-task run is ~630k tokens and the free tier allows 200k per day shared with
  everything else. The numbers are missing for a boring reason — money — and the README
  block says so instead of shipping one harness and calling it an axis.
- **Not exact across providers.** The denominator is estimated at four characters
  per token while the numerator uses each provider's real count. `tax` compares
  models closely, not exactly, and a model with a more verbose tokenizer is
  penalised slightly.
- **Not a point estimate.** `necessary_tokens` is a lower bound: the agent's own
  `run_tests` output is excluded because its size is not knowable offline.
  Including it only makes the number larger. `tax` is a floor on waste.
- **Not a claim about the current live numbers.** `data/` is empty; the previous
  live table was withdrawn (below), and the live README block says so until the
  next full run republishes it.
- **Not a bill, today.** The runs on the free tier cost $0, so `$/task` is not the
  interesting column yet. The ratio is.

## The withdrawal, plainly

An earlier table was published, and a `6.6×` headline was drawn from it. That run
predated the grading fix below, so the numbers were **not proven**. The grade did
not require pytest to have exited `0`, and a junit report left in the agent's own
workspace could decide a pass. The fate of an unproven number in a benchmark is to
be withdrawn, and it was. The `6.6×` headline is retired; do not cite it. `data/`
was cleared. The fix — grading writes the report outside the job and requires
pytest to have exited `0` with a report that says a suite ran — is pinned down by
`runner/test_sandbox.js`. The block at the top of the README is the run that
republished it, with smaller and better numbers than the retired one.
Honesty is the product here. A faked or hand-typed number kills the repo.

## What I want from readers

1. **Publish your own harness numbers.** Point `runner/config.json` at your loop,
   run it, and post the `tax`. The axis is worthless with one point on it.
2. **Tell me the metric is wrong.** If `necessary_tokens` for a task is too high or
   too low, open a PR against `tasks/<id>/reference/trajectory.json`. The
   denominator is the whole product; a contestable denominator is the credibility.
3. **Spare API credit.** The harness axis needs ~630k tokens to score five tasks with
   a second harness, and this repo runs on a free tier of 200k/day. If you have credit
   burning a hole in an OpenRouter, Together or Groq account, that is the single
   fastest way to turn the thesis into a table. Or run it yourself:
   `runner/config.harness.json` and `mode=harness` exist for exactly this.

## FAQ

**Isn't this just cost?**
No. `$/task` is already published (AWS `sample-agent-cost-bench`, artificialanalysis,
GitTaskBench). Publishing the invoice again buys nothing. `tax` normalizes the spend
against what the task needed, so a cheap model that thrashes and an expensive model
that is precise are finally comparable.

**Why is `necessary_tokens` not hand-picked?**
It is recomputed from each task's own files by `runner/reference_cost.js`, and
`runner/test_reference_cost.js` fails CI if the committed value drifts. The only
hand-written part is the minimal step list, which is in the repo for exactly this
argument.

**Which harness wins?**
Not measured yet, and I am not going to invent the ranking. The second harness is
implemented and verified end to end — it drove the real CLI to read and edit the
workspace, and the counts come out of the CLI's own database — but scoring five tasks
with it is ~630k tokens against a free allowance of 200k/day. One live run already
told me the part that matters for the thesis: on the same task it spent **10.5k tokens
where the lean loop spent 1.9k**, and the free tier's daily cap ran out mid-measurement
— which is why the next sentence is not "and it failed": a throttled run is evidence of
nothing, and the harness now drops those runs instead of publishing them as a model
failure. That is one run, not a result.

## Comments I expect

- **"The denominator excludes the agent's own test runs, so `tax` is understated."**
  Correct, and stated: `necessary_tokens` is a floor; including `run_tests` only
  enlarges it.
- **"Four characters per token is wrong for my model."**
  Admitted in the README and ADR: the denominator is estimated, the numerator is
  the provider's real count, so the ratio is close, not exact.
- **"One harness means the headline thesis is unproven."**
  Correct. The harness axis is the roadmap item, not a claim.
- **"You withdrew the table, so the earlier numbers were wrong."**
  They were not shown wrong; they were unproven — the run predated the grading fix.
  That is why they were pulled and why the `6.6×` headline is retired.
