# `@elitza/plugin`

Authoring interfaces and runtime loader support for Elitza V2 plugins:

- `@elitza/plugin` — [Promise plugin API](./src/README.md)
- `@elitza/plugin/effect` — [Effect plugin API](./src/effect/README.md)
- `@elitza/plugin/rpc` — portable RPC contract definitions
- `@elitza/plugin/tui` — terminal UI plugin API

## Packaging And Runtime `effect`

When the Elitza CLI loads server or TUI plugins, it resolves imports of `effect`, exported `effect/*` subpaths, and `@elitza/plugin` entrypoints (including imports from dependencies inside a plugin's `node_modules`) to the host's runtime module instances so fibers, loggers, and `Schema` parsers share one copy.

- Declare `"effect": "^4.0.0"` as a `peerDependency` (and `devDependency` for local type-checking and testing) rather than a bundled runtime dependency.
- Do not bundle `effect` into published plugin files; if you build with a bundler, keep `effect` and `effect/*` external. Two copies of `effect` do not share fiber, logger, or `Schema` internals.
- Plugins and their `node_modules` dependencies always receive Elitza's host `effect` instance. Use `effect` APIs and module paths compatible with the Elitza release you target; dependencies built on another `effect` major (such as Effect 3) are not supported.
- Only public `effect` subpaths are provided. A plugin that imports one of Effect's private `internal` modules fails to load with an error naming the path.
- The compiled Elitza binary does not include the Scalar and Swagger UI assets used by Effect's HTTP API docs pages; serving those pages from a plugin shows a notice instead.
