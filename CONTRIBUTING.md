# Contributing to Elitza

Thanks for wanting to make Elitza better. The changes most likely to be accepted are:

- Bug fixes
- Free-model and BYOK provider improvements
- Memory, persona, and skill (brain) improvements
- LSP and formatter fixes
- Documentation improvements

## Development

```bash
bun install
bun run dev        # run the TUI from source
bun run check      # lint + typecheck (run from the repo root)
```

Run tests from a package directory (never from the repo root), for example:

```bash
cd packages/tui && bun test
```

## Ground rules

- The default branch is `main`. Open PRs against `main`.
- Use conventional commit messages: `type(scope): summary` (for example `fix(tui): keep composer focus`).
- Elitza ships **only** free models and BYOK endpoints. Do not add bundled API keys, paid inference resellers, or
  telemetry that phones home.
- Brand color is orange. Keep the `brand` theme token for identity elements.

## Issues

Use the issue templates. Include what you ran, what happened, and what you expected.
