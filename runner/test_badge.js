#!/usr/bin/env node
// Offline self-test for the badge, which is the one artifact that leaves this
// repo and gets embedded somewhere else: an un-scored or withdrawn run must never
// leave a number behind.
const assert = require("assert");
const { badgeFor } = require("./badge");

const row = (tax, status = "complete") => ({ status, vanilla: tax == null ? null : { tax } });
const results = (...taxes) => ({ entries: taxes.map((t) => row(t)) });

assert.strictEqual(badgeFor(results()), null, "no entries means no badge");
assert.strictEqual(badgeFor({ entries: [row(null), row(1.2, "partial")] }), null, "an unscored or partial row is not a number");
assert.strictEqual(badgeFor({ entries: [row(null)] }), null, "a null tax is not a number");

assert.strictEqual(badgeFor(results(2.4)).message, "2.4×", "a single score is the median");
assert.strictEqual(badgeFor(results(1, 2, 6)).message, "2×", "an odd count takes the middle value");
assert.strictEqual(badgeFor(results(1, 2, 3, 6)).message, "2.5×", "an even count averages the middle two");
assert.strictEqual(badgeFor(results(9, 1)).message, "5×", "the order of the rows does not matter");

// The colour bands are the badge's only judgement, so they are pinned.
for (const [t, color] of [[1.4, "green"], [1.5, "yellow"], [2.9, "yellow"], [3, "orange"], [4.9, "orange"], [5, "red"]]) {
  assert.strictEqual(badgeFor(results(t)).color, color, `tax ${t} must be ${color}`);
}
assert.strictEqual(badgeFor(results(0.0021)).schemaVersion, 1, "the shields endpoint schema version is fixed");

console.log("test_badge: PASS (median over scored rows, colour bands pinned, no badge without a number)");
