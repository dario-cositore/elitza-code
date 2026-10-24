# Demo recorder

Generates [`docs/assets/demo.gif`](../../docs/assets/demo.gif) — one AI
enablement pass in the real terminal: scout → CRM → outreach draft → batch
approval → Resend send → playbook → handover.

```bash
cd script/demo && bun install     # once
bash script/demo/record.sh        # from the repository root or anywhere
```

Needs `bun` and `ffmpeg` on `PATH`. Output: `docs/assets/demo.gif`
(960px wide, ~25 seconds).

## What is real, and what is scripted

The recording is honest about its split, the way every drive demo is:

| Layer | Source |
| --- | --- |
| TUI, layout, themes, keypress overlay | real — the dev checkout under `DEMO_REPO` |
| Brain plugin, `client_scout`, `crm`, `outreach`, `playbook`, `handover` | real — executed against a scratch `ELITZA_HOME` (fresh `crm.db`, real pipeline files, real git evidence) |
| Google Places and Resend HTTP calls | local mocks (`mocks.ts`) pointed at by `GOOGLE_PLACES_URL` / `RESEND_URL` — no account, no key, no live send |
| Model responses | scripted by [opencode-drive](https://www.npmjs.com/package/opencode-drive) (`client-run.ts` queues them) |
| Model identity in the UI | the real `elitza` provider block, `elitza/xiaomi/mimo-v2.6-flash` |

Each run wipes `/tmp/elitza-demo-home` (the scratch brain) and
`/tmp/elitza-demo-handover`, so every recording starts from the same state:
client id 1, six playbooks freshly seeded.

## Why `DEMO_REPO=/tmp/elitza-repo`

Drive composes `BUN_OPTIONS` from the dev path as a plain space-joined
string, and this repository lives under `2. Elitza Ecosystem` — the spaces
would be split into stray bun arguments (`error: Script not found "Elitza"`).
`record.sh` therefore points the dev target at a space-free symlink. Pass
`DEMO_REPO` yourself whenever you run the scripts by hand.

## Files

- `client-run.ts` — the program: project fixture, config (MiMo provider,
  brain plugin, ask-gates), the nine queued responses, the narrative marks.
- `mocks.ts` — Places and Resend answers on port `MOCK_PORT` (default 8791).
- `record.sh` — scratch home, symlink, mocks, run, MP4 → GIF via ffmpeg.
- `harness.ts` — the three-line proof used while wiring this up: dev target
  boots, plugin loads, a simulated call reaches a real plugin tool.

`recording.mark()` labels are recorded in the timeline; the exported video
paints them only when the target TUI supports the overlay — ours does not
yet, so the transcript narration carries the story instead.
