# TODO — what stands between TokenTax and "a benchmark people cite"

State: 5 tasks, 2 harnesses (`mini-loop`, `opencode-headless`), 2 live models,
60/60 runs passing, and the first table was withdrawn after a grading bug and is
being republished from a measured denominator. **1 star.** Sibling repo
`slopbench`: 14 stars.

Rule for this file: **nothing gets launched, posted or announced until P0 is closed.**
P0 items are not bugs in a corner; they are reasons a skeptical reader would be
right to say the published number is not proven.

What is already solid (do not redo): hardened container (`--network none`,
`--read-only`, `--cap-drop ALL`, `--no-new-privileges`, non-root, memory/cpu/pids
limits), no shell/`eval` anywhere and `spawnSync` with argv arrays, hidden tests
kept out of the job and mounted `:ro` only at grading time, one self-test per
module wired into CI, `score.js` refusing malformed raw, live table auto-rendered
from `data/results.json`, weekly job.

---

## P0 — the published numbers must be provably real  ✅ CLOSED

All seven items below are fixed, each with a self-test that fails if the invariant
comes back. The published table was **withdrawn** rather than left standing: the
run behind it predates the grading fix, so the numbers were not proven. The next
full run republishes it with the measured denominator.

- [x] **Grading reads a file the agent can write.** `pytest --junitxml=out.xml`
      with `-w /job` (`runner/sandbox.js:91`) then reads `jobDir/out.xml`
      (`:95`) and sets `passed` without ever checking pytest's exit status
      (`:101`); `timed_out` is computed (`:99`) and never used. The agent's own
      `run_tests` writes that same path mid-run (`runner/harnesses/mini-loop.js:87`),
      so a stale or forged report is graded as a pass.
      *Fix:* `--junitxml=/tmp/out.xml`, `passed = r.status === 0 && !timed_out &&
      junit.tests === expected`, and clear any `out.xml` left in the job.
      *Test:* forge `/job/out.xml`, then kill the interpreter (`/job/sitecustomize.py`
      is auto-imported because of `PYTHONPATH=/job`) — grading must fail.
      *Also:* `cwd=/job` makes `python -m pytest` execute `/job/pytest.py`
      (verified: a planted file hijacks the run). Run pytest from outside the job
      and put the workspace on `sys.path` some way that cannot shadow pytest itself.

- [x] **A symlink defeats the host-side path guard.** The agent's `read_file` /
      `write_file` run in the host Node process and `safeResolve` is purely
      lexical (`runner/harnesses/mini-loop.js:44-48, 78, 81-83`). The container has
      the job dir mounted rw, so model code can drop a symlink there; the host then
      follows it. Reproduced: a write through `job/evil -> /tmp/.../victim`
      overwrote the victim. In CI the reachable targets include `~/.git-credentials`,
      `.git/hooks/*` (executed by the `git commit` that follows the run, with the
      job environment and network) and `/proc/self/environ` (`GROQ_API_KEY`).
      *Fix:* `fs.realpathSync` the parent and re-check the prefix under the job
      before every read/write, or move the tools into the container.

- [x] **Provider errors are scored as model failures.** Records carrying `error`
      are kept in the group (`runner/score.js`, `runner/run.js:81,140-157`), so an
      infrastructure failure silently deflates `pass@1` and can null a task's tax.
      The weekly job should publish *"incomplete"*, not *"the model failed"*.
      *Fix:* exclude `error` records from scoring, mark the entry `incomplete`,
      and put the error count in `results.json` so the table can say it.

- [x] **`tokens = 0` is accepted.** The guard is `>= 0` (`runner/score.js:56-58`),
      so a missing `usage` block (`runner/chat.js:135`) is published as `tax 0.00×`
      — the perfect model, for free. *Fix:* require `tokens_in > 0 && tokens_out > 0`
      on a passing run, at both transport and scorer level.

- [x] **Resume can mix incompatible records.** Resume keys are
      `harness|model|task|variant|rep` (`runner/run.js:86-99`) with no hash of the
      config, the prompt, the task or the harness, and `data/raw.json` is committed
      and reused weekly. A prompt edit mid-series silently merges two experiments.
      *Fix:* store `harness_commit` + a hash of (config, task.md, workspace, prompt)
      on each record and refuse to reuse a mismatch.

- [x] **A partial run cannot recover and breaks its own fallback.**
      The `reps` completeness check runs before the `TOKENTAX_PARTIAL` branch
      (`runner/score.js:70-73` vs `:75-81`), and the renderer dereferences
      `e.vanilla.tax` (`runner/leaderboard.js:17`) on entries that partial mode emits
      without a `vanilla` key (`score.js:128`). So the documented fallback fails the
      job and commits nothing. *Fix:* gate the reps check behind `!PARTIAL`, keep
      incomplete groups out of the table, and skip entries with no `vanilla` in the
      renderer (with a `status: in_progress` row instead).

- [x] **Retried attempts are not counted.** 429 backoff and the tool-nudge retry
      send the prompt again but only the final attempt's `usage` is recorded
      (`runner/chat.js:116-126, 135`; `runner/harnesses/mini-loop.js:63-65`). A model
      that thrashes at the transport layer looks cheaper than one that does not —
      and unevenly, per provider. *Fix:* record `attempts` and add the re-sent
      prompt cost to `tokens_in`.

---

## P1 — credibility: the denominator is the whole product

- [x] **`necessary_tokens` is hand-typed, so the ratio is not tokenizer-agnostic.**
      Every model shares `{"default": N}` (`runner/lib.js:38-42`,
      `tasks/*/reference/trajectory.json:3`), while the README and ADR-001 claim the
      ratio cancels per-model tokenizer differences. It does not: a model with a
      verbose tokenizer gets a bigger numerator over the same denominator and is
      punished for it. Per-task spread today is 3.15× to 10.00×.
      *Fix (pick one):* derive the denominator with each model's tokenizer, or drop
      the cross-provider claim and say plainly that the number is a per-task constant
      measured on one reference model. This is the item a HN commenter will open the
      thread with.

- [x] **Make `trajectory.json` real.** It documents `steps` and asserts a round
      number (520, 560, 640, 700, 780) with no measurement behind it. *Fix:* a
      scripted, non-LLM reference trajectory that recomputes the denominator from the
      task's own files and fails CI when it drifts — the file's name already promises
      this, and it turns the weakest claim into the strongest one.

- [x] **Publish the per-turn floor.** The numerator pays the system prompt and tool
      schema on every turn while the denominator is one-shot, so an ideal run already
      scores ≈2× (task 01: 640 necessary vs ~205 tokens/turn of fixed prompt). This
      is not a bug — it is the first thing to explain, loudly, next to the number.

- [ ] **`Δ minimality` has the wrong sign in the README fixture table** (−0.49
      printed, +0.49 computed by `score.js:139` and asserted by
      `runner/test_score.js:66`), contradicting the caption right below it and the
      live table's "waste it removes" column. *Fix:* print the sign `score.js`
      computes, define it once in the metric table, and regenerate the whole fixture
      table with `runner/leaderboard.js` so no table in the README is hand-typed.

- [ ] **Record how to reproduce the run.** `results.json` has no
      `harness_commit`, no config hash and no provider/endpoint, only
      `generated_at`. *Fix:* add commit, config hash, provider and model ids; that is
      what makes "run it yourself" a real invitation instead of a claim.

- [ ] **Task 05 contradicts itself.** The hidden test only counts a literal
      (`tasks/05-dedupe-keep-green/tests/test_shapes.py:15-18`) and the reference
      keeps both functions while `task.md` asks for one shared helper. *Fix:* assert
      the shared helper exists and make the reference actually dedupe.

- [ ] **The variants differ in more than verbosity.** The minimal prompt says
      *"Output only the code."* (`runner/config.json:11`), which fights the tool loop;
      the delta then measures instruction compliance, not minimality, and models that
      obey end up `tax: null`. *Fix:* differ only in verbosity guidance.

- [ ] **Delete dead knobs.** `thrash` is blind by construction (path-string
      identity, byte-identical rewrites) and near-zero in live data; `max_tokens`
      (`runner/config.json:4`) is never read. Enforce them or remove them.

---

## P2 — the hook is `model × harness`, and there is currently one harness

- [x] **`opencode-headless` harness.** A second harness exists and it is a real
      tool: the OpenCode CLI (pinned 2.0.28) running headless in its own hardened
      image, on the same tasks, models and key as `mini-loop`, with tokens read out
      of the CLI's own database and an offline test pinning the accounting and the
      container. See `docs/adr/ADR-002-harness-axis.md`. Its live path is verified
      by `mode=smoke` before any full run, because the container now needs a network
      and the key inside it -- stated in the ADR, not hidden.
- [ ] **Score the harness axis.** The harness is implemented and its live path works
      (it drove the real CLI to read and edit the workspace, and its tokens came out
      of its own database), but it is **not yet a published row**: one run of it
      spends ~10.5k tokens against mini-loop's ~1.9k, so a 5-task run costs 630k
      tokens and the free tier allows 200k per day, shared with every smoke run. The
      provider said so itself: `Limit 200000, Used 199220, Requested 5045`. The rows
      come from `runner/config.harness.json` via `mode=harness` (one task, full reps,
      its own README block), which fits a day's allowance. Cost is the wall, not the
      code.
- [ ] **A live self-test for the container path.** Its offline test locks the
      accounting, the hardening and the config, and it only checks the image's version
      when Docker is present. What is missing is an end-to-end run against a stub
      provider inside the sandbox job, so the plumbing is proven without a key and
      without a model's variance. Today that proof is a smoke run per change, at one
      round trip each.
- [ ] **`claude-code-headless` harness** (and any third-party loop, which is the
      point of the axis).
- [ ] **At least one paid model.** Every `$/task` is $0 on the free tier, so the
      "how much of the *bill* was waste" angle is dormant. One cheap paid model
      makes the invoice column real for cents.
- [ ] **More tasks and a second language.** 5 Python puzzles is a demo; 15+ with
      JS/TS is a benchmark. Say how a task is chosen, not just how it is written.
- [x] **Badge endpoint.** `runner/badge.js` writes `docs/badge.json` (shields
      endpoint schema) from the same `results.json` the table is rendered from, so
      the two cannot drift, and it writes nothing when no row scored: a withdrawn
      leaderboard must not leave a stale number in someone else's README. The README
      embeds it, and CI fails if the committed badge drifts from the results.
- [ ] **The daily quota is shared, and that is a design constraint.** The free tier
      allows 200k tokens/day for everything, and a smoke run of both harnesses spends
      ~25k of it (~21k of that is the real CLI). Four debugging smokes are enough to
      starve the weekly run's last records. Anything that adds a live smoke to a
      change has to say where its tokens come from, or the weekly table pays for it.

---

## P3 — adoption: make it one PR for an outsider

- [ ] `CONTRIBUTING.md`: add a model (config line), add a harness (interface +
      self-test), add a task (fixture protocol). Say which of the three is one line.
- [ ] Issue templates: "model request", "harness proposal", "task proposal",
      "metric dispute" — the last one is the differentiator of a contestable metric.
- [ ] `index.html` + GitHub Pages + social preview image. `slopbench` already has
      `index.html`, `PRODUCT-BRIEF.md`, `docs/demo.gif`, `docs/social-preview.png`,
      `runner/demo.js` and `runner/monitor.js` — reuse the pattern instead of
      inventing one.
- [x] `node runner/demo.js`: one command, no key, no network. Runs the fixture end
      to end and prints the ratio per model × harness with the two deltas it exists
      for (same model in a fatter harness; same model under a minimal prompt), and
      says out loud that the fixture is a mock.
- [ ] `docs/demo.gif` recorded from that output: `agg` and `asciinema` are not
      installed here, and the demo is a one-second command, so the honest substitute
      may be a still of its output rather than a video of it.
- [x] **The card and the badge are generated from `results.json`**, like the table.
      The card's rows used to be typed into `docs/social-data.json`: the most
      shareable artifact was the only place a number could be handwritten. Both are
      regenerated from the published run now, so they can be stale but never invented.
- [ ] Set the repo homepage to the Pages URL (topics are already set; homepage is not).

---

## P4 — launch (only after P0 and the denominator in P1)

- [x] One-command reproduce: `node runner/demo.js` runs the fixture config with no
      key and prints the metric, and `docs/social.html` + `docs/make-social.js`
      render a social card from published numbers instead of typed ones.
- [ ] A documented BYO-key path (`GROQ_API_KEY`, `OPENROUTER_API_KEY`) in the README
      itself, next to the number it produces.
- [ ] Show HN / r/LocalLLaMA post. Lead with the honest finding we already have:
      both models pass everything, and they differ by 5% on waste — the metric is not
      capability, and the minimal prompt saves 31% on the small model and 15% on the
      large one. Also state the free-tier limitation and the denominator convention
      in the post, before anyone asks.
- [ ] Rotate any key that has appeared in a transcript, then re-confirm the secret is
      only reachable by the job step that needs it (`persist-credentials: false` on
      checkout, one provider key exported at a time) — see P0's symlink item for why
      this matters more here than in a normal repo.

**One-line thesis:** replace the in-workspace grading channel with an out-of-job
report path plus status/exit-code/test-count checks, so `passed: true` provably means
the hidden suite actually ran.
