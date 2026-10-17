import type { Elitza } from "./client.js"

export * from "./generated/index.js"
export { Elitza } from "./client.js"
export type {
  AgentApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcCallOptions,
  RpcClient,
  RpcEventPayload,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export type { EventSubscribeOutput as ElitzaEvent } from "./generated/types.js"
export type ElitzaClient = ReturnType<typeof Elitza.make>
