#!/usr/bin/env node
// Aggregates a raw run file into results.json (the leaderboard payload).
// Zero dependencies. This file is the check: it throws on anything inconsistent.
const fs = require("fs");
const path = require("path");
const { readJson, median, necessaryFor, costOf, round } = require("./lib");

const ROOT = process.env.TOKENTAX_ROOT || path.resolve(__dirname, "..");
const resolve = (v, def) => (v ? path.resolve(process.cwd(), v) : def);
const CFG_PATH = resolve(process.env.TOKENTAX_CONFIG, path.join(ROOT, "runner", "config.json"));
const RAW = resolve(process.env.TOKENTAX_RAW, path.join(ROOT, "data", "raw.json"));
const OUT = resolve(process.env.TOKENTAX_OUT, path.join(ROOT, "data", "results.json"));
const PRICES_PATH = resolve(process.env.TOKENTAX_PRICES, path.join(ROOT, "runner", "prices.json"));

const cfg = readJson(CFG_PATH);
const prices = readJson(PRICES_PATH);

function fail(msg) {
  console.error(`score.js: ${msg}`);
  process.exit(1);
}

let raw;
try {
  raw = readJson(RAW);
} catch (e) {
  fail(`cannot read ${RAW}: ${e.message}`);
}
if (!Array.isArray(raw) || raw.length === 0) fail(`no runs in ${RAW}`);

const tasksDir = path.join(ROOT, "tasks");
const onlyTasks = (process.env.TOKENTAX_TASKS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const taskIds = fs
  .readdirSync(tasksDir)
  .filter((d) => fs.existsSync(path.join(tasksDir, d, "task.json")))
  .filter((d) => !onlyTasks.length || onlyTasks.includes(d))
  .sort();
const refs = {};
for (const id of taskIds) refs[id] = readJson(path.join(tasksDir, id, "reference", "trajectory.json"));

const modelIds = new Set(cfg.models.map((m) => m.id));
const harnessIds = new Set(cfg.harnesses.map((h) => h.id));
const variantIds = Object.keys(cfg.variants);
const QUALIFY = cfg.qualify_threshold;

// ---- guards on every record (the reason this file exists) ----
for (const r of raw) {
  if (!harnessIds.has(r.harness)) fail(`unknown harness ${r.harness}`);
  if (!modelIds.has(r.model)) fail(`unknown model ${r.model}`);
  if (!refs[r.task]) fail(`unknown task ${r.task}`);
  if (!variantIds.includes(r.variant)) fail(`unknown variant ${r.variant}`);
  if (typeof r.passed !== "boolean") fail(`passed must be boolean: ${JSON.stringify(r)}`);
  for (const k of ["tokens_in", "tokens_out"]) {
    if (!(r[k] >= 0 && r[k] <= 50_000_000)) fail(`bad ${k}=${r[k]} for ${r.harness}/${r.model}/${r.task}`);
  }
  if (!prices.models[r.model]) fail(`no frozen price for model ${r.model}`);
}

// ---- groups: harness|model|task|variant must have exactly cfg.reps distinct reps ----
const gkey = (r) => `${r.harness}|${r.model}|${r.task}|${r.variant}`;
const groups = new Map();
for (const r of raw) {
  const k = gkey(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, runs] of groups) {
  if (runs.length !== cfg.reps) fail(`group ${k} has ${runs.length} runs, expected ${cfg.reps}`);
  if (new Set(runs.map((r) => r.rep)).size !== cfg.reps) fail(`duplicate reps in group ${k}`);
}

const PARTIAL = !!process.env.TOKENTAX_PARTIAL;
const perEntryGroups = taskIds.length * variantIds.length;
const exact = cfg.models.length * cfg.harnesses.length * perEntryGroups;
if (groups.size !== exact) {
  if (!PARTIAL) fail(`expected ${exact} groups, got ${groups.size}`);
  if (groups.size > exact) fail(`more groups than expected (${groups.size} > ${exact})`);
}

// ---- per (harness,model,task,variant) stats ----
function statsForKey(harness, model, task, variant) {
  const runs = groups.get(`${harness}|${model}|${task}|${variant}`);
  if (!runs) return null;
  const passedRuns = runs.filter((r) => r.passed);
  const passRate = passedRuns.length / runs.length;
  const e = { pass_at_1: round(passRate), consistent: passedRuns.length === runs.length };
  if (passRate >= QUALIFY && passedRuns.length) {
    const nec = necessaryFor(refs[task], model);
    if (!(nec > 0)) fail(`bad necessary_tokens for ${task}`);
    e.tax = round(median(passedRuns.map((r) => (r.tokens_in + r.tokens_out) / nec)));
    e.cost_per_task = round(median(passedRuns.map((r) => costOf(r, prices.models[model]))), 4);
    e.thrash = median(passedRuns.map((r) => r.thrash || 0));
    if (!(e.tax >= 0 && e.tax <= 1000)) fail(`tax out of range (${e.tax}) for ${harness}/${model}/${task}/${variant}`);
  } else {
    e.tax = null;
    e.cost_per_task = null;
    e.thrash = null;
  }
  return e;
}

function variantBlock(harness, model, variant) {
  const perTask = {};
  for (const task of taskIds) perTask[task] = statsForKey(harness, model, task, variant);
  const qualified = Object.values(perTask).filter((e) => e && e.tax != null);
  const meanOf = (get, decimals) =>
    qualified.length ? round(qualified.reduce((s, e) => s + get(e), 0) / qualified.length, decimals) : null;
  return {
    per_task: perTask,
    pass_at_1: taskIds.length
      ? round(Object.values(perTask).reduce((s, e) => s + (e ? e.pass_at_1 : 0), 0) / taskIds.length)
      : null,
    tax: meanOf((e) => e.tax),
    cost_per_task: meanOf((e) => e.cost_per_task, 4),
    thrash: meanOf((e) => e.thrash),
  };
}

const entries = [];
for (const harness of cfg.harnesses) {
  for (const model of cfg.models) {
    const prefix = `${harness.id}|${model.id}|`;
    const known = [...groups.keys()].filter((k) => k.startsWith(prefix)).length;
    if (PARTIAL && known < perEntryGroups) {
      entries.push({ harness: harness.id, model: model.id, status: known ? "in_progress" : "pending" });
      continue;
    }
    const vanilla = variantBlock(harness.id, model.id, "vanilla");
    const minimal = variantBlock(harness.id, model.id, "minimal");
    const perTask = {};
    const deltas = [];
    for (const task of taskIds) {
      const a = vanilla.per_task[task];
      const b = minimal.per_task[task];
      if (a && b && a.tax != null && b.tax != null) {
        perTask[task] = round(a.tax - b.tax);
        deltas.push(a.tax - b.tax);
      }
    }
    entries.push({
      harness: harness.id,
      model: model.id,
      status: "complete",
      vanilla,
      minimal,
      minimality_delta: {
        per_task: perTask,
        overall: deltas.length ? round(deltas.reduce((s, d) => s + d, 0) / deltas.length) : null,
      },
    });
  }
}

const results = {
  generated_at: new Date().toISOString(),
  reps: cfg.reps,
  qualify_threshold: QUALIFY,
  prices_asof: prices.asof,
  tasks: Object.fromEntries(taskIds.map((id) => [id, refs[id].necessary_tokens])),
  entries,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`scored ${raw.length} runs -> ${OUT}`);
