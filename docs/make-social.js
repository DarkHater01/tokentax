#!/usr/bin/env node
// Turns the published leaderboard numbers into docs/social-preview.png.
//   node docs/make-social.js          refresh the PNG
//   node docs/make-social.js --check  render to a temp dir and assert exactly 1200x630
// Zero dependencies: string substitution into docs/social.html, then headless chromium.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;
const W = 1200;
const H = 630;
const CHECK = process.argv.includes("--check");
const MAX_ROWS = 4; // a fifth card cannot fit the card; the README table carries the rest

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Chromium ships under several names; the first one that answers wins.
function findChromium() {
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return bin;
  }
  console.error(
    "tokentax: no chromium on PATH (tried chromium, chromium-browser, google-chrome, chrome).\n" +
      "Install chromium, or screenshot docs/social.html yourself at 1200x630."
  );
  process.exit(2);
}

function rowsHtml(rows) {
  if (!rows.length) {
    // Nothing is invented: an unscored run stays unscored.
    return (
      '<div class="empty"><div class="t">The next full run fills this card.</div>' +
      '<div class="s">tax is scored per model &times; harness, and a number ships only once the run behind it is proven.</div></div>'
    );
  }
  const shown = rows.slice(0, MAX_ROWS);
  const cards = shown
    .map(
      (r) =>
        `<div class="row"><div class="v">${esc(r.tax)}</div>` +
        `<div class="k">${esc(r.model)} &middot; ${esc(r.harness)}</div></div>`
    )
    .join("");
  const more =
    rows.length > MAX_ROWS ? `<div class="more">+${rows.length - MAX_ROWS} more in the README table</div>` : "";
  return `<div class="grid" style="grid-template-columns:repeat(${shown.length},1fr)">${cards}${more}</div>`;
}

function render() {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, "social-data.json"), "utf8"));
  const tpl = fs.readFileSync(path.join(DIR, "social.html"), "utf8");
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return tpl
    .replace(/\{\{HEADLINE\}\}/g, esc(data.headline || "tokentax"))
    .replace(/\{\{ROWS\}\}/g, rowsHtml(rows));
}

// PNG size without ImageMagick when it is absent: the IHDR chunk sits at a fixed offset.
function pngSize(file) {
  const im = spawnSync("identify", ["-format", "%wx%h", file], { encoding: "utf8" });
  if (!im.error && im.status === 0 && /^\d+x\d+$/.test(im.stdout.trim())) {
    const [w, h] = im.stdout.trim().split("x").map(Number);
    return { w, h, via: "identify" };
  }
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString("ascii", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), via: "IHDR" };
}

const bin = findChromium();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentax-social-"));
let code = 0;
try {
  const page = path.join(tmp, "social.html");
  const png = CHECK ? path.join(tmp, "social-preview.png") : path.join(DIR, "social-preview.png");
  fs.writeFileSync(page, render());

  const r = spawnSync(
    bin,
    [
      "--headless",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${W},${H}`,
      `--screenshot=${png}`,
      "file://" + page,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0 || !fs.existsSync(png)) {
    console.error(`tokentax: ${bin} exited ${r.status} without a screenshot\n${r.stderr || ""}`);
    code = 3;
  } else if (CHECK) {
    const { w, h, via } = pngSize(png);
    if (w === W && h === H) {
      console.log(`ok: docs/social.html renders ${w}x${h} (${via})`);
    } else {
      console.error(`FAIL: social card is ${w}x${h}, expected ${W}x${H}`);
      code = 1;
    }
  } else {
    console.log(`wrote ${path.relative(process.cwd(), png)} (${W}x${H})`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
