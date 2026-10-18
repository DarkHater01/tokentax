#!/usr/bin/env node
// Renders data/results.json into the README's live leaderboard block.
// Static, zero-dependency: the weekly bench job regenerates it, so the table a
// visitor reads is always the last real run and never a hand-typed number.
const fs = require("fs");
const path = require("path");

const ROOT = process.env.TOKENTAX_ROOT || path.resolve(__dirname, "..");
// The live table and the offline fixture table are both rendered by this script;
// they differ only in which results file and which markers they use, so no table
// in the README is ever hand-typed.
const MARKER = process.env.TOKENTAX_LB_MARKER || "LEADERBOARD";
const START = `<!-- ${MARKER}:START -->`;
const END = `<!-- ${MARKER}:END -->`;

const tax = (n) => (n == null ? "—" : `${n}×`);
const saved = (minimal, vanilla) =>
  minimal == null || vanilla == null || !vanilla ? "—" : `${Math.round(((vanilla - minimal) / vanilla) * 100)}%`;

function render(results) {
  const t = (e) => (e.vanilla && e.vanilla.tax != null ? e.vanilla.tax : Infinity);
  const entries = [...results.entries].sort((a, b) => t(a) - t(b));
  const harnesses = [...new Set(entries.map((e) => `\`${e.harness}\``))].join(", ");
  const lines = [
    // Only the live table carries a stamp. The fixture table is committed, so its
    // header must stay byte-stable or CI cannot prove it was generated.
    `${MARKER === "LEADERBOARD" ? `**Last scored ${String(results.generated_at).slice(0, 10)}** · ` : ""}harness ${harnesses} · ${
      Object.keys(results.tasks || {}).length
    } tasks × ${results.reps} reps · variants: vanilla, minimal${
      MARKER === "LEADERBOARD" && results.harness_env ? ` · env \`${results.harness_env}\`` : ""
    }${results.errors ? ` · ${results.errors} provider errors excluded` : ""}`,
    "",
    "| # | harness | model | `pass@1` | `tax` | `$/task` | `tax` with the minimal prompt | waste it removes |",
    "|---|---|---|---|---|---|---|---|",
  ];
  entries.forEach((e, i) => {
    // A partial run produces entries that were never scored: say so in the table
    // rather than printing a zero that reads like a result.
    if (e.status !== "complete" || !e.vanilla || !e.minimal) {
      lines.push(`| ${i + 1} | \`${e.harness}\` | \`${e.model}\` | — | — | — | — | not scored yet (${e.status}) |`);
      return;
    }
    const cost = e.vanilla.cost_per_task;
    lines.push(
      `| ${i + 1} | \`${e.harness}\` | \`${e.model}\` | ${e.vanilla.pass_at_1.toFixed(2)} | **${tax(e.vanilla.tax)}** | ${
        cost == null ? "—" : `$${cost}`
      } | ${tax(e.minimal.tax)} | ${saved(e.minimal.tax, e.vanilla.tax)} |`
    );
  });
  lines.push("");
  lines.push(
    "Ranked by waste. `tax = 3×` means the agent spent three times what the task actually needed. The table is generated: it is never edited by hand."
  );
  return lines.join("\n");
}

function splice(readme, block) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("README.md is missing the leaderboard markers");
  return `${readme.slice(0, a + START.length)}\n${block}\n${readme.slice(b)}`;
}

if (require.main === module) {
  const resultsPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(ROOT, "data", "results.json");
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const readmePath = path.join(ROOT, "README.md");
  fs.writeFileSync(readmePath, splice(fs.readFileSync(readmePath, "utf8"), render(results)));
  console.log(`leaderboard: README.md ${MARKER} block updated from ${path.relative(ROOT, resultsPath)}`);
}

module.exports = { render, splice, START, END };
