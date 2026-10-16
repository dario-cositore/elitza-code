# Elitza Experimental

**This is NOT the shipped Elitza.** This is a private, separate build for
Dario and Elitza to develop experimental features that must never reach the
public release.

## The separation — do not break it

| | Shipped Elitza | This build |
|---|---|---|
| Location | `../.elitza/agent` | this directory |
| Branch | `opencode-fork` (= `main`, pushed to GitHub) | `experimental` (local only) |
| Release | v1.0.0 = commit `37b0da9`, tagged, on `github.com/dario-cositore/elitza-code` | never released |
| Remote push | allowed | **DISABLED** at the git level |
| Brain / home | `~/.elitza` (production) | `./home` (isolated sandbox, gitignored) |

### Guards in place
- **Push disabled.** `git remote get-url --push origin` returns
  `DISABLED-EXPERIMENTAL-DO-NOT-PUSH`. `origin` still works for *fetching*
  shipped updates (`git fetch origin`), but nothing can ever push from here.
- **Isolated brain.** Run everything with `ELITZA_HOME=$PWD/home`. The
  `home/` dir holds a *copy* of the real brain so tests are realistic, and it
  is gitignored so brain data never enters the repo. Without this override,
  binaries would default to production `~/.elitza` — do not let that happen.

### To run the experimental build
```bash
cd .elitzaexperimental
export ELITZA_HOME="$PWD/home"
export PATH="$HOME/.bun/bin:$PATH"
# build/run/test as usual — the heartbeat is ON by default here
bun run packages/plugins/elitza-brain/script/heartbeat-test.ts
```

### To disable the heartbeat in this build
`ELITZA_HEARTBEAT=0` turns the loop off. `ELITZA_HEARTBEAT_MINUTES` sets the
cadence (default 30, min 5).

## What's experimental so far

**The heartbeat** (commit `deb8e08`) — a loop that runs between conversations:
tends memory (consolidation + pruning, which previously only ran if the model
voluntarily called a tool, so production sat at 0 links forever) and forms a
reflection during silence (waking the previously-dead `onSilence` and
`getFeelingStatement`), surfaced in the next session's prompt. Tests: unit,
interval integration, and a real-brain sandbox (0 memories deleted, links 0→54,
reflection formed). Smoke + `bun run check` green.

## Rule

Nothing from this directory gets cherry-picked, merged, or pushed into the
shipped tree or the public repo without Dario explicitly deciding a feature has
earned its way out of experimental. Ship from `../.elitza/agent`, not here.
