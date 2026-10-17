export * as Provider from "./provider.js"

import { Context, Effect, Layer, Option, Schema, Stream, Struct } from "effect"
import { Provider } from "@elitza/schema/provider"
import { Model } from "@elitza/schema/model"
import { makeLocationNode } from "@elitza/util/effect/app-node"
import { HttpTimeout, type ProviderPackageDefinition } from "@elitza/ai"
import { isRecord } from "@elitza/ai/utils/record"
import { Npm } from "@elitza/util/npm"
import type { DeepMutable } from "./schema.js"
import { importModule, resolveModule } from "@elitza/util/runtime-import"
import { Bus } from "./bus.js"
import { Integration } from "./integration.js"
import { State } from "./state.js"
import { IntegrationConnection } from "./integration/connection.js"
import { Credential } from "@elitza/schema/credential"
import { Location } from "./location.js"
import { freeze } from "immer"
import { AISDKNative } from "./aisdk-native.js"

export const ID = Provider.ID
export type ID = typeof ID.Type

export const AISDK_PREFIX = "aisdk:"
export const isAISDK = (value: string | undefined): value is string => value?.startsWith(AISDK_PREFIX) ?? false
export const aisdk = (value: string) => (isAISDK(value) ? value : `${AISDK_PREFIX}${value}`)
export function packageName(value: string): string
export function packageName(value: undefined): undefined
export function packageName(value: string | undefined): string | undefined
export function packageName(value: string | undefined) {
  if (value === undefined || !isAISDK(value)) return value
  return value.slice(AISDK_PREFIX.length)
}

type Json = Schema.Schema.Type<typeof Schema.Json>
const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord)

export class LoadError extends Schema.TaggedError<LoadError>()("Provider.LoadError", {
  package: Schema.String,
  cause: Schema.Defect(),
}) {}
export type ProviderPackage = ProviderPackageDefinition

const packages = new Map<string, Promise<unknown>>()
const builtins = new Map<string, () => Promise<unknown>>([
  ["@elitza/ai/providers/alibaba", () => import("@elitza/ai/providers/alibaba")],
  ["@elitza/ai/providers/alibaba/chat", () => import("@elitza/ai/providers/alibaba/chat")],
  ["@elitza/ai/providers/alibaba/messages", () => import("@elitza/ai/providers/alibaba/messages")],
  ["@elitza/ai/providers/alibaba/responses", () => import("@elitza/ai/providers/alibaba/responses")],
  ["@elitza/ai/providers/amazon-bedrock", () => import("@elitza/ai/providers/amazon-bedrock")],
  ["@elitza/ai/providers/amazon-bedrock/mantle", () => import("@elitza/ai/providers/amazon-bedrock/mantle")],
  [
    "@elitza/ai/providers/amazon-bedrock/mantle/chat",
    () => import("@elitza/ai/providers/amazon-bedrock/mantle/chat"),
  ],
  [
    "@elitza/ai/providers/amazon-bedrock/mantle/messages",
    () => import("@elitza/ai/providers/amazon-bedrock/mantle/messages"),
  ],
  [
    "@elitza/ai/providers/amazon-bedrock/mantle/responses",
    () => import("@elitza/ai/providers/amazon-bedrock/mantle/responses"),
  ],
  ["@elitza/ai/providers/amazon-bedrock-mantle", () => import("@elitza/ai/providers/amazon-bedrock-mantle")],
  ["@elitza/ai/providers/anthropic", () => import("@elitza/ai/providers/anthropic")],
  ["@elitza/ai/providers/anthropic-compatible", () => import("@elitza/ai/providers/anthropic-compatible")],
  ["@elitza/ai/providers/azure", () => import("@elitza/ai/providers/azure")],
  ["@elitza/ai/providers/azure/chat", () => import("@elitza/ai/providers/azure/chat")],
  ["@elitza/ai/providers/azure/responses", () => import("@elitza/ai/providers/azure/responses")],
  ["@elitza/ai/providers/baseten", () => import("@elitza/ai/providers/baseten")],
  ["@elitza/ai/providers/cerebras", () => import("@elitza/ai/providers/cerebras")],
  ["@elitza/ai/providers/cloudflare-ai-gateway", () => import("@elitza/ai/providers/cloudflare-ai-gateway")],
  ["@elitza/ai/providers/cloudflare-workers-ai", () => import("@elitza/ai/providers/cloudflare-workers-ai")],
  ["@elitza/ai/providers/cohere", () => import("@elitza/ai/providers/cohere")],
  ["@elitza/ai/providers/cohere/chat", () => import("@elitza/ai/providers/cohere/chat")],
  ["@elitza/ai/providers/deepinfra", () => import("@elitza/ai/providers/deepinfra")],
  ["@elitza/ai/providers/deepseek", () => import("@elitza/ai/providers/deepseek")],
  ["@elitza/ai/providers/digitalocean", () => import("@elitza/ai/providers/digitalocean")],
  ["@elitza/ai/providers/fireworks", () => import("@elitza/ai/providers/fireworks")],
  ["@elitza/ai/providers/google", () => import("@elitza/ai/providers/google")],
  ["@elitza/ai/providers/google/interactions", () => import("@elitza/ai/providers/google/interactions")],
  ["@elitza/ai/providers/google-vertex", () => import("@elitza/ai/providers/google-vertex")],
  ["@elitza/ai/providers/google-vertex/chat", () => import("@elitza/ai/providers/google-vertex/chat")],
  ["@elitza/ai/providers/google-vertex/gemini", () => import("@elitza/ai/providers/google-vertex/gemini")],
  [
    "@elitza/ai/providers/google-vertex/interactions",
    () => import("@elitza/ai/providers/google-vertex/interactions"),
  ],
  ["@elitza/ai/providers/google-vertex/messages", () => import("@elitza/ai/providers/google-vertex/messages")],
  ["@elitza/ai/providers/google-vertex/mistral", () => import("@elitza/ai/providers/google-vertex/mistral")],
  ["@elitza/ai/providers/google-vertex/responses", () => import("@elitza/ai/providers/google-vertex/responses")],
  ["@elitza/ai/providers/google-vertex-chat", () => import("@elitza/ai/providers/google-vertex-chat")],
  [
    "@elitza/ai/providers/google-vertex-interactions",
    () => import("@elitza/ai/providers/google-vertex-interactions"),
  ],
  ["@elitza/ai/providers/google-vertex-messages", () => import("@elitza/ai/providers/google-vertex-messages")],
  ["@elitza/ai/providers/google-vertex-mistral", () => import("@elitza/ai/providers/google-vertex-mistral")],
  ["@elitza/ai/providers/google-vertex-responses", () => import("@elitza/ai/providers/google-vertex-responses")],
  ["@elitza/ai/providers/groq", () => import("@elitza/ai/providers/groq")],
  ["@elitza/ai/providers/meta", () => import("@elitza/ai/providers/meta")],
  ["@elitza/ai/providers/meta/chat", () => import("@elitza/ai/providers/meta/chat")],
  ["@elitza/ai/providers/meta/messages", () => import("@elitza/ai/providers/meta/messages")],
  ["@elitza/ai/providers/meta/responses", () => import("@elitza/ai/providers/meta/responses")],
  ["@elitza/ai/providers/minimax", () => import("@elitza/ai/providers/minimax")],
  ["@elitza/ai/providers/minimax/chat", () => import("@elitza/ai/providers/minimax/chat")],
  ["@elitza/ai/providers/minimax/messages", () => import("@elitza/ai/providers/minimax/messages")],
  ["@elitza/ai/providers/minimax/responses", () => import("@elitza/ai/providers/minimax/responses")],
  ["@elitza/ai/providers/mistral", () => import("@elitza/ai/providers/mistral")],
  ["@elitza/ai/providers/moonshot", () => import("@elitza/ai/providers/moonshot")],
  ["@elitza/ai/providers/moonshot/chat", () => import("@elitza/ai/providers/moonshot/chat")],
  ["@elitza/ai/providers/moonshot/messages", () => import("@elitza/ai/providers/moonshot/messages")],
  ["@elitza/ai/providers/moonshot/responses", () => import("@elitza/ai/providers/moonshot/responses")],
  ["@elitza/ai/providers/openai", () => import("@elitza/ai/providers/openai")],
  ["@elitza/ai/providers/openai/chat", () => import("@elitza/ai/providers/openai/chat")],
  ["@elitza/ai/providers/openai/responses", () => import("@elitza/ai/providers/openai/responses")],
  ["@elitza/ai/providers/openai-compatible", () => import("@elitza/ai/providers/openai-compatible")],
  [
    "@elitza/ai/providers/openai-compatible/responses",
    () => import("@elitza/ai/providers/openai-compatible/responses"),
  ],
  [
    "@elitza/ai/providers/openai-compatible-responses",
    () => import("@elitza/ai/providers/openai-compatible-responses"),
  ],
  ["@elitza/ai/providers/openrouter", () => import("@elitza/ai/providers/openrouter")],
  ["@elitza/ai/providers/togetherai", () => import("@elitza/ai/providers/togetherai")],
  ["@elitza/ai/providers/venice", () => import("@elitza/ai/providers/venice")],
  ["@elitza/ai/providers/vercel-ai-gateway", () => import("@elitza/ai/providers/vercel-ai-gateway")],
  ["@elitza/ai/providers/vercel-ai-gateway/chat", () => import("@elitza/ai/providers/vercel-ai-gateway/chat")],
  [
    "@elitza/ai/providers/vercel-ai-gateway/messages",
    () => import("@elitza/ai/providers/vercel-ai-gateway/messages"),
  ],
  [
    "@elitza/ai/providers/vercel-ai-gateway/responses",
    () => import("@elitza/ai/providers/vercel-ai-gateway/responses"),
  ],
  ["@elitza/ai/providers/xai", () => import("@elitza/ai/providers/xai")],
  ["@elitza/ai/providers/zai", () => import("@elitza/ai/providers/zai")],
  ["@elitza/ai/providers/zai/chat", () => import("@elitza/ai/providers/zai/chat")],
  ["@elitza/ai/providers/zai-coding-plan", () => import("@elitza/ai/providers/zai-coding-plan")],
  ["@elitza/ai/providers/zai-coding-plan/chat", () => import("@elitza/ai/providers/zai-coding-plan/chat")],
  ["@elitza/ai/providers/zai-coding-plan/messages", () => import("@elitza/ai/providers/zai-coding-plan/messages")],
  [
    "@elitza/ai/providers/zai-coding-plan/responses",
    () => import("@elitza/ai/providers/zai-coding-plan/responses"),
  ],
])

/** Native `@elitza/ai/providers/*` entrypoints bundled with Core and loadable by name from config. */
export const builtinPackages: ReadonlySet<string> = new Set(builtins.keys())

export const loadPackage = Effect.fn("Provider.loadPackage")(function* (input: string, npm?: Npm.Interface) {
  const specifier = packageName(input)
  const builtin = builtins.get(specifier)
  if (builtin) return yield* importPackage(specifier, specifier, builtin)
  const resolved = yield* Effect.sync(() => {
    if (specifier.startsWith("file://") || specifier.startsWith("@elitza/ai/")) return specifier
    try {
      return import.meta.resolve(specifier)
    } catch {
      return undefined
    }
  })
  if (resolved) return yield* importPackage(specifier, resolved)
  if (!npm) {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} is not installed`),
    })
  }
  const parts = specifier.split("/")
  const root = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
  const installed = yield* npm.add(root).pipe(Effect.mapError((cause) => new LoadError({ package: specifier, cause })))
  const entrypoint = yield* Effect.try({
    try: () => resolveModule(specifier, installed.directory),
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  return yield* importPackage(specifier, entrypoint)
})

/** opencode settings consumed in Core; native packages never receive them. */
const CORE_KEYS = ["chunkTimeout", "compaction", "encoding", "fetch", "headerTimeout", "timeout", "transport"] as const
const PROVIDER_ONLY_KEYS = ["chunkTimeout", "headerTimeout", "timeout", "transport"] as const

export function nativeSettings(settings: Settings): Settings {
  return Struct.omit(settings, CORE_KEYS)
}

export function modelSettings(settings: Settings | undefined) {
  return settings && Struct.omit(settings, PROVIDER_ONLY_KEYS)
}

const decodeTimeout = Schema.decodeUnknownOption(HttpTimeout)

/** Applied to `headerTimeout` when provider settings leave it unset or invalid. */
export const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Applied to `chunkTimeout` when provider settings leave it unset or invalid. Some providers, such as DeepSeek, have
 * specifically asked clients to allow at least 15 minutes, because their models can stream nothing for minutes while
 * they reason.
 */
export const DEFAULT_CHUNK_TIMEOUT_MS = 900_000

/** One timeout setting without a default; invalid values are dropped. */
export function timeout(value: unknown) {
  return Option.getOrUndefined(decodeTimeout(value))
}

/** Request timeouts from provider settings, resolved for every route. `timeout` has no default. */
export function timeouts(settings: Readonly<Record<string, unknown>>) {
  return {
    timeout: timeout(settings.timeout),
    headerTimeout: timeout(settings.headerTimeout) ?? DEFAULT_TIMEOUT_MS,
    chunkTimeout: timeout(settings.chunkTimeout) ?? DEFAULT_CHUNK_TIMEOUT_MS,
  }
}

const decodeEncoding = Schema.decodeUnknownOption(Provider.Encoding)

/** Request body encoding from provider or model settings; invalid values are dropped. */
export function encoding(settings: Readonly<Record<string, unknown>>) {
  return Option.getOrUndefined(decodeEncoding(settings.encoding))
}

export function mergeOverlay(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, Json> | undefined {
  if (base === undefined) return overlay && decodeJsonRecord({ ...overlay })
  if (overlay === undefined) return decodeJsonRecord({ ...base })
  return decodeJsonRecord(
    Object.fromEntries(
      new Set([...Object.keys(base), ...Object.keys(overlay)]).values().map((key): [string, unknown] => {
        const left = base[key]
        const right = overlay[key]
        if (right === undefined) return [key, left]
        if (isRecord(left) && isRecord(right)) return [key, mergeOverlay(left, right) ?? {}]
        return [key, right]
      }),
    ),
  )
}

export function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
) {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(overlay)]
      .reduce((result, entry) => {
        result.set(entry[0].toLowerCase(), entry)
        return result
      }, new Map<string, [string, string]>())
      .values(),
  )
}

export const Request = Provider.Request
export type Request = Provider.Request

export const Compaction = Provider.Compaction
export type Compaction = Provider.Compaction

export const Transport = Provider.Transport
export type Transport = Provider.Transport

export const Settings = Provider.Settings
export type Settings = Provider.Settings

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = DeepMutable<Info>

export { Event } from "@elitza/schema/provider"

/** Provider metadata owns its drafts; model definitions remain immutable inputs. */
export type Definition = {
  readonly provider: Info
  readonly models: ReadonlyMap<Model.ID, Model.Info>
  readonly sourceConnection?: IntegrationConnection.Info
}

export interface Editor {
  readonly list: () => readonly Definition[]
  readonly get: (providerID: ID) => Definition | undefined
  readonly add: (definition: {
    readonly info: Info
    readonly models: readonly Model.Info[]
    readonly sourceConnection?: IntegrationConnection.Info
  }) => void
  readonly update: (providerID: ID, update: (provider: MutableInfo) => void) => void
  readonly remove: (providerID: ID) => void
  readonly models: {
    readonly set: (providerID: ID, models: readonly Model.Info[]) => void
    readonly update: (providerID: ID, modelID: Model.ID, update: (model: DeepMutable<Model.Info>) => void) => void
    readonly remove: (providerID: ID, modelID: Model.ID) => void
  }
}

export interface Snapshot {
  readonly records: ReadonlyMap<ID, Definition>
  readonly available: readonly Definition[]
  readonly providers: readonly Info[]
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (providerID: ID) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<readonly Info[]>
  readonly available: () => Effect.Effect<readonly Info[]>
  /** Internal definition/access snapshot; raw model inventories never cross the HTTP API. */
  readonly snapshot: () => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@elitza/Provider") {}

// Every location references the same index for a shared immutable definition array.
const definitions = new WeakMap<readonly Model.Info[], Map<ID, ReadonlyMap<Model.ID, Model.Info>>>()
function index(providerID: ID, models: readonly Model.Info[]) {
  const indexes = definitions.get(models) ?? new Map<ID, ReadonlyMap<Model.ID, Model.Info>>()
  const cached = indexes.get(providerID)
  if (cached) return cached
  // Model shares these definitions without copying, so a foreign definition takes this provider's identity here.
  const result = freeze(
    new Map(models.map((model) => [model.id, model.providerID === providerID ? model : { ...model, providerID }])),
    true,
  )
  indexes.set(providerID, result)
  definitions.set(models, indexes)
  return result
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const integrations = yield* Integration.Service
    const location = yield* Location.Service
    const state = State.create<
      Map<
        ID,
        {
          provider: MutableInfo
          models: ReadonlyMap<Model.ID, Model.Info>
          sourceConnection?: IntegrationConnection.Info
        }
      >,
      Editor
    >({
      name: "provider",
      initial: () => new Map(),
      editor: (records) => {
        const maps = new WeakSet<ReadonlyMap<Model.ID, Model.Info>>()
        const models = new WeakSet<Model.Info>()
        const entry = (id: ID) => {
          const current = records.get(id)
          if (current) return current
          const added = { provider: Info.empty(id) as MutableInfo, models: new Map<Model.ID, Model.Info>() }
          records.set(id, added)
          maps.add(added.models)
          return added
        }
        const writable = (id: ID) => {
          const record = entry(id)
          if (maps.has(record.models)) return record.models as Map<Model.ID, Model.Info>
          const owned = new Map(record.models)
          record.models = owned
          maps.add(owned)
          return owned
        }
        return {
          list: () => Array.from(records.values()),
          get: (id) => records.get(id),
          add: (definition) => {
            records.set(definition.info.id, {
              provider: structuredClone(definition.info) as MutableInfo,
              models: index(definition.info.id, definition.models),
              sourceConnection: definition.sourceConnection,
            })
          },
          update: (id, update) => {
            const record = entry(id)
            update(record.provider)
            record.provider.id = id
            AISDKNative.rewrite(record.provider, {
              specifier: record.provider.package,
              providerID: id,
              canonical: record.provider.canonical,
            })
          },
          remove: (id) => {
            records.delete(id)
          },
          models: {
            set: (id, values) => {
              entry(id).models = index(id, values)
            },
            update: (providerID, modelID, update) => {
              const record = entry(providerID)
              const target = writable(providerID)
              const current = target.get(modelID)
              const model = // An earlier add/set can publish and freeze an owned model within this fold.
                (
                  current && models.has(current) && !Object.isFrozen(current)
                    ? current
                    : current
                      ? structuredClone(current)
                      : Model.Info.default(providerID, modelID)
                ) as DeepMutable<Model.Info>
              update(model)
              model.id = modelID
              model.providerID = providerID
              AISDKNative.rewrite(model, {
                specifier: model.package ?? record.provider.package,
                providerID,
                canonical: model.canonical ?? record.provider.canonical,
                modelID: model.modelID ?? modelID,
              })
              models.add(model)
              target.set(modelID, model)
            },
            remove: (providerID, modelID) => {
              if (!records.has(providerID)) return
              writable(providerID).delete(modelID)
            },
          },
        }
      },
      notify: () => notify,
    })
    // Registrations may outlive a borrowed service layer; their later disposal must
    // not query dependencies that have already closed.
    yield* Effect.addFinalizer(() => State.shutdown(state.reload()))
    let cached: { records: Snapshot["records"]; value: Snapshot } | undefined
    const snapshot = Effect.fn("Provider.snapshot")(function* () {
      while (true) {
        const revision = integrations.revision()
        const records = state.get()
        // Connection presence decides availability; resolving OAuth tokens belongs to execution.
        const connections = yield* integrations.list()
        // Either fold can disable a plugin that also contributed to the other domain.
        if (revision !== integrations.revision() || records !== state.get()) continue
        const byID = new Map(connections.map((integration) => [integration.id, integration]))
        const available = Array.from(records.values()).filter((record) => {
          if (record.provider.activation === "disabled") return false
          const integration = byID.get(record.provider.integrationID ?? Integration.ID.make(record.provider.id))
          // Never combine the previous account's discovered endpoints/models with a new connection.
          if (
            record.sourceConnection &&
            IntegrationConnection.key(record.sourceConnection) !==
              IntegrationConnection.key(integration?.connections[0])
          )
            return false
          if (record.provider.activation === "enabled") return true
          if (integration?.connections.length) return true
          return record.provider.integrationID === undefined && !integration
        })
        // A credential change that leaves the same definitions available is not a catalog change.
        if (
          cached?.records === records &&
          cached.value.available.length === available.length &&
          cached.value.available.every((record, index) => record === available[index])
        )
          return cached.value
        const value = freeze({ records, available, providers: available.map((record) => record.provider) }, true)
        cached = { records, value }
        return value
      }
    })
    let published: Snapshot | undefined
    const notify: Effect.Effect<void> = Effect.gen(function* () {
      const value = yield* snapshot()
      if (value === published) return
      published = value
      yield* bus.publish(
        Provider.Event.Updated,
        {},
        {
          location: { directory: location.directory, workspaceID: location.workspaceID },
        },
      )
    })
    yield* bus.subscribe([Integration.Event.Updated, Credential.Event.Updated, Credential.Event.Switched]).pipe(
      Stream.runForEach(() => notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Provider.get")((id) => Effect.sync(() => freeze(state.get().get(id)?.provider, true))),
      all: Effect.fn("Provider.all")(() =>
        Effect.sync(() => Array.from(state.get().values(), (record) => freeze(record.provider, true))),
      ),
      available: Effect.fn("Provider.available")(() => snapshot().pipe(Effect.map((value) => value.providers))),
      snapshot,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Integration.node, Location.node] })

const importPackage = Effect.fn("Provider.importPackage")(function* (
  specifier: string,
  entrypoint: string,
  load = () => importModule(entrypoint),
) {
  const module = yield* Effect.tryPromise({
    try: () => {
      const existing = packages.get(entrypoint)
      if (existing) return existing
      const loaded = load()
      packages.set(entrypoint, loaded)
      return loaded
    },
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  if (typeof module !== "object" || module === null || typeof (module as { model?: unknown }).model !== "function") {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} does not export model(modelID, settings)`),
    })
  }
  return module as ProviderPackageDefinition
})
