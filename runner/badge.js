#!/usr/bin/env node
// Writes docs/badge.json in the shields.io endpoint schema, from the same
// results.json the README table is rendered from, so the badge cannot drift from
// the table. Embed it as:
//   https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/DarkHater01/tokentax/main/docs/badge.json
const fs = require("fs");
const path = require("path");

const ROOT = process.env.TOKENTAX_ROOT || path.resolve(__dirname, "..");
const IN = process.env.TOKENTAX_OUT
  ? path.resolve(process.cwd(), process.env.TOKENTAX_OUT)
  : path.join(ROOT, "data", "results.json");
const OUT = process.env.TOKENTAX_BADGE
  ? path.resolve(process.cwd(), process.env.TOKENTAX_BADGE)
  : path.join(ROOT, "docs", "badge.json");

// A badge holds one number, so it holds a summary: the median tax over the scored
// model x harness rows, which resists a single absurd run. Null when nothing was
// scored, so a withdrawn leaderboard never leaves a stale badge behind.
function badgeFor(results) {
  const taxes = (results.entries || [])
    .filter((e) => e.status === "complete" && e.vanilla && e.vanilla.tax != null)
    .map((e) => e.vanilla.tax)
    .sort((a, b) => a - b);
  if (!taxes.length) return null;
  const mid = Math.floor(taxes.length / 2);
  const median = taxes.length % 2 ? taxes[mid] : (taxes[mid - 1] + taxes[mid]) / 2;
  return {
    schemaVersion: 1,
    label: "median token tax",
    message: `${Math.round(median * 10) / 10}×`,
    color: median < 1.5 ? "green" : median < 3 ? "yellow" : median < 5 ? "orange" : "red",
  };
}

if (require.main === module) {
  const results = JSON.parse(fs.readFileSync(IN, "utf8"));
  const badge = badgeFor(results);
  if (!badge) {
    console.error(`badge: ${IN} has no scored row; nothing to publish`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(badge, null, 2) + "\n");
  console.log(`badge: ${badge.message} -> ${OUT}`);
}

module.exports = { badgeFor };
