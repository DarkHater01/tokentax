#!/usr/bin/env bash
# Records docs/demo.gif: the offline demo, then the published leaderboard block being
# rewritten into the README, as a ~60 second screencast.
#
#   docs/record-demo.sh            download the pinned recorders, record, render
#   docs/record-demo.sh --session  (internal) the scripted session asciinema records
#
# No key, no Docker, no sudo: asciinema and agg ship prebuilt binaries, so they land in
# a tmp dir instead of a package manager. The session is scripted for readability --
# nobody types at a readable pace -- but every command is executed for real and every
# line in the gif is that command's own output. The leaderboard write is idempotent (CI
# proves the block round-trips byte for byte), so recording it cannot change the README.
#
# Two traps this script exists to avoid, both found by looking at the first take:
#   - asciinema caps every silence at 5s by default, which silently ate 20s of the holds
#     that make the table readable; -i raises it.
#   - stty resizes the PTY the program writes into, but agg renders at the size in the
#     cast's header and re-wraps anything longer. 120 columns is the width the widest
#     line of the published block needs, and agg has to be told the same number.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${TOKENTAX_REC_BIN:-/tmp/opencode/bin}"
CAST="$BIN/demo.cast"
GIF="$ROOT/docs/demo.gif"
COLS="${TOKENTAX_REC_COLS:-120}"
ROWS="${TOKENTAX_REC_ROWS:-32}"
AGG_VERSION=v1.9.0
ASCII_VERSION=v3.2.1
AGG_URL="https://github.com/asciinema/agg/releases/download/$AGG_VERSION/agg-x86_64-unknown-linux-gnu"
ASCII_URL="https://github.com/asciinema/asciinema/releases/download/$ASCII_VERSION/asciinema-x86_64-unknown-linux-gnu"
FONT="${TOKENTAX_REC_FONT:-DejaVu Sans Mono}"
TYPE_DELAY="${TOKENTAX_REC_TYPE_DELAY:-0.12}"
TARGET_SECS="${TOKENTAX_REC_SECONDS:-60}"

type_cmd() { local s="$1" i; for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep "$TYPE_DELAY"; done; }

# The recorded session. The pacing lives here, so the timeline is reviewable in this
# file instead of being an artifact of how fast a machine happened to be.
session() {
  stty cols "$COLS" rows "$ROWS"
  printf '\n'
  beat() {
    printf '$ '
    type_cmd "$1"
    printf '\n'
    eval "$1"
    sleep "$2"
  }
  beat 'node runner/demo.js' 14
  beat 'node runner/leaderboard.js data/results.json' 4
  beat "sed -n '/LEADERBOARD:START/,/LEADERBOARD:END/p' README.md" 12
}

# A trailing silence produces no event, so a cast has no way to record "hold the last
# screen for N seconds" (the earlier take ended at 32.9s with an 18s sleep after the
# last byte). The tail is therefore padding, computed from the cast's own clock: the
# requested length is enforced by construction, not by hand-tuned sleeps.
cast_secs() {
  tail -n +2 "$1" | node -e "
    let s = '';
    process.stdin.on('data', (d) => (s += d)).on('end', () => {
      const t = s.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e[1] === 'o').map((e) => e[0]);
      process.stdout.write(String(t[t.length - 1] || 0));
    });
  "
}

if [ "${1:-}" = "--session" ]; then
  cd "$ROOT"
  session
  exit 0
fi

mkdir -p "$BIN"
if [ ! -x "$BIN/agg" ]; then curl -fsSL "$AGG_URL" -o "$BIN/agg"; chmod +x "$BIN/agg"; fi
if [ ! -x "$BIN/asciinema" ]; then curl -fsSL "$ASCII_URL" -o "$BIN/asciinema"; chmod +x "$BIN/asciinema"; fi
rm -f "$CAST"

# -i 999: keep the holds. Without it the recording drops to ~44s and the table blinks.
"$BIN/asciinema" rec --overwrite -i 999 -f asciicast-v2 -c "$0 --session" "$CAST" >/dev/null

ends="$(cast_secs "$CAST")"
last="$(awk -v e="$ends" -v want="$TARGET_SECS" 'BEGIN { v = want - e; if (v < 2) v = 2; printf "%.1f", v }')"

"$BIN/agg" \
  --font-family "$FONT" \
  --font-size 15 \
  --line-height 1.35 \
  --theme asciinema \
  --fps-cap 24 \
  --idle-time-limit 999 \
  --last-frame-duration "$last" \
  --cols "$COLS" --rows "$ROWS" \
  "$CAST" "$GIF"

# A recording that lost its holds, or rendered at the wrong width, is a lie about what
# the command does -- and it is one `identify` away from being caught.
frame="$(identify -format '%wx%h\n' "$GIF" | head -1)"
secs="$(identify -format '%T\n' "$GIF" | awk '{ s += $1 } END { printf "%.1f", s / 100 }')"
awk -v s="$secs" -v w="$TARGET_SECS" 'BEGIN { exit !(s >= w - 3 && s <= w + 3) }' || {
  echo "demo.gif is ${secs}s, not ${TARGET_SECS}s: the holds or the tail padding moved" >&2
  exit 1
}
awk -v x="${frame%x*}" -v c="$COLS" 'BEGIN { exit !(x >= c * 7) }' || {
  echo "demo.gif rendered ${frame} wide: agg wrapped it instead of using --cols $COLS" >&2
  exit 1
}
grep -qa "tokentax" "$CAST" || { echo "demo.gif has no demo output in it; the session did not run" >&2; exit 1; }

echo "demo.gif: ${secs}s (cast ${ends}s + ${last}s tail), $frame, $(du -h "$GIF" | cut -f1)"
