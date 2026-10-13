# TokenTax

**Every agent benchmark ranks how smart a model is. None ranks how much of the bill is waste.**

TokenTax reports the number nobody publishes — **how much of what you paid for was thrown away** — and it reports it per `model × harness`, because the invoice is set by the harness, not the model.

| metric | what it answers |
|---|---|
| `pass@1` | can the agent solve the task at all? |
| `tax` | tokens spent ÷ tokens a minimal trajectory needs |
| `thrash` | rewrites of the same target (wasted work, proxy) |
| `$/task` | median cost per solved task, frozen price table |
| `Δ minimality` | tokens shaved by a minimalism prompt |

> The denominator is a **minimal trajectory, in-repo, contestable via PR**. A ratio
> on purpose: it cancels tokenizer differences between providers.

---

## Status: M1 (offline scorer)

Right now the repo is the **scorer + fixtures**. No API key, no Docker, no money:

```bash
node runner/test_score.js
```

That generates fake runs into `runner/tmp/`, scores them, checks the guards and
deletes the temp files. If it prints `test_score: PASS`, the metric engine works.

Manual run, same thing without the assertions:

```bash
TOKENTAX_CONFIG=runner/config.mock.json TOKENTAX_RAW=data/raw.mock.json node runner/run.js
TOKENTAX_CONFIG=runner/config.mock.json TOKENTAX_RAW=data/raw.mock.json TOKENTAX_OUT=data/results.mock.json node runner/score.js
```

## The metric

```
tax = (tokens_in + tokens_out) / necessary_tokens(model)
```

- `necessary_tokens` is the token count of the minimal hand-written trajectory
  for that task (`tasks/<id>/reference/trajectory.json`), per model, so the ratio
  is tokenizer-agnostic.
- A task only counts if `pass@1 >= 0.6`. A 0-line solution that fails does not
  qualify, and neither does a lucky single pass.
- `tax` is the median over passing reps (5 by default).

## Layout

```
runner/run.js          model x task x harness x rep -> data/raw.json
runner/score.js        raw -> results.json; validates everything ("this file is the check")
runner/test_score.js   offline self-test of the scorer (no API key)
runner/config.json     LIVE config (real models, M2)
runner/config.mock.json offline fixtures (M1)
runner/prices.json     frozen price snapshot, dated
runner/fixtures/       canned token counts for the mock models
tasks/<id>/            task.md + task.json + reference/trajectory.json (hidden tests land in M2)
docs/adr/ADR-001-metric.md
```

**Mock and live data are separate files on purpose** (`data/raw.mock.json` vs
`data/raw.json`). The live run can never clobber the fixtures the self-test needs.

## Roadmap

- **M1** — fixtures + scorer + self-test offline. *(done)*
- **M2** — real agent harnesses (minimal loop, opencode-headless, claude-code-headless), Docker sandbox, hidden tests.
- **M3** — weekly CI + static leaderboard + badge endpoint.
- **M4** — ADR polish, `demo.gif`, launch.

## License

MIT. Reference trajectories are contestable via PR.
