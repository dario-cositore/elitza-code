#!/usr/bin/env bash
# Record docs/assets/demo.gif: one AI enablement pass in the real TUI.
#
# Model responses are simulated by opencode-drive and the Places/Resend
# endpoints point at local mocks (mocks.ts). The TUI, the brain plugin and
# every tool run for real against a scratch ELITZA_HOME.
#
# Requirements: bun, ffmpeg, and script/demo dependencies installed
# (cd script/demo && bun install). Run from anywhere.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
DEMO_REPO_LINK=/tmp/elitza-repo
SCRATCH=/tmp/elitza-demo-home
MOCK_PORT="${MOCK_PORT:-8791}"

# Drive composes BUN_OPTIONS from the dev path; the space in this repository's
# real path ("2. Elitza Ecosystem") would be split into stray bun arguments.
ln -sfn "$ROOT" "$DEMO_REPO_LINK"

rm -rf "$SCRATCH" /tmp/elitza-demo-handover
mkdir -p "$SCRATCH"

bun "$DIR/mocks.ts" > /tmp/elitza-demo-mocks.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$MOCK_PORT/emails" -X POST -d '{}' >/dev/null 2>&1 && break
  sleep 0.25
done

cd "$ROOT"
env DEMO_REPO="$DEMO_REPO_LINK" \
    ELITZA_HOME="$SCRATCH" \
    XIAOMI_API_KEY=demo-key-not-real \
    MOCK_PORT="$MOCK_PORT" \
    GOOGLE_PLACES_URL="http://127.0.0.1:$MOCK_PORT/v1/places:searchText" \
    GOOGLE_MAPS_API_KEY=demo-key-not-real \
    RESEND_URL="http://127.0.0.1:$MOCK_PORT/emails" \
    RESEND_API_KEY=re_demo_not_real \
    RESEND_FROM="Dario Cositore <hello@elitza.life>" \
    OUTREACH_SIGNATURE="Dario Cositore · AI enablement for local businesses" \
    script/demo/node_modules/.bin/opencode-drive run script/demo/client-run.ts

VID="$(find /tmp/opencode-drive/output -name '*.mp4' -newermt '-15 minutes' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$VID" ]; then
  echo "No recording found under /tmp/opencode-drive/output" >&2
  exit 1
fi
echo "recording: $VID"

OUT="$ROOT/docs/assets/demo.gif"
ffmpeg -y -loglevel error -i "$VID" \
  -vf "fps=6,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=100:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$OUT"

ls -lh "$OUT"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames -of csv=p=0 "$OUT"
echo "wrote $OUT"
