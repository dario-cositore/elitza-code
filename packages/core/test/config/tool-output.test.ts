import { describe, expect } from "bun:test"
import { Bus } from "@elitza/core/bus"
import { Config } from "@elitza/core/config"
import { ConfigToolOutputPlugin } from "@elitza/core/config/plugin/tool-output"
import { AppNodeBuilder } from "@elitza/core/effect/app-node-builder"
import { Plugin } from "@elitza/core/plugin"
import { PluginHost } from "@elitza/core/plugin/host"
import { ToolOutput } from "@elitza/core/tool-output"
import { Document, Event, Info } from "@elitza/schema/config"
import { ConfigToolOutput } from "@elitza/schema/config/tool-output"
import { Global } from "@elitza/util/global"
import { Effect } from "effect"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

describe("ConfigToolOutputPlugin.Plugin", () => {
  it.live("applies limits and reloads changed config", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const output = yield* ToolOutput.Service
          const bus = yield* Bus.Service
          const config = yield* Config.Test
          const plugins = yield* Plugin.Service
          yield* config.setEntries([
            new Document({
              type: "document",
              info: new Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 1 }) }),
            }),
          ])
          yield* ConfigToolOutputPlugin.Plugin.effect(yield* PluginHost.make(plugins))

          expect((yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] })).metadata?.truncated).toBe(
            true,
          )

          yield* config.setEntries([
            new Document({
              type: "document",
              info: new Info({
                tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }),
              }),
            }),
          ])
          yield* bus.publish(Event.Updated, {})
          for (let attempt = 0; attempt < 200; attempt++) {
            const result = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] })
            if (result.metadata?.truncated === false) return
            yield* Effect.sleep("10 millis")
          }
          yield* Effect.die(new Error("Timed out waiting for tool output config reload"))
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(ToolOutput.node, [Global.node.replace(Global.layerWith({ data: tmp.path }))]),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(PluginTestLayer)),
  )
})
