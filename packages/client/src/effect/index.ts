// TODO: Keep additional network capabilities inside Schema and Protocol as the client grows; /effect must never import
// Core or Server. Preserve these datatype exports so internal model reorganizations do not require caller migrations.
import type { Effect } from "effect"
import type { Elitza } from "./client.js"

export * from "./generated/index"
export { Elitza } from "./client.js"
export type {
  AgentApi,
  AppApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcClient,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export { Agent } from "@elitza/schema/agent"
export { Command } from "@elitza/schema/command"
export { Config } from "@elitza/schema/config"
export { Credential } from "@elitza/schema/credential"
export { Event } from "@elitza/schema/event"
export { EventLog } from "@elitza/schema/event-log"
export { FileSystem } from "@elitza/schema/filesystem"
export { Form } from "@elitza/schema/form"
export { Integration } from "@elitza/schema/integration"
export { Location } from "@elitza/schema/location"
export { Model } from "@elitza/schema/model"
export { Permission } from "@elitza/schema/permission"
export { PermissionSaved } from "@elitza/schema/permission-saved"
export { Project } from "@elitza/schema/project"
export { Worktree } from "@elitza/schema/worktree"
export { Vcs } from "@elitza/schema/vcs"
export { Provider } from "@elitza/schema/provider"
export { Pty } from "@elitza/schema/pty"
export { Question } from "@elitza/schema/question"
export { Reference } from "@elitza/schema/reference"
export { WebSearch } from "@elitza/schema/websearch"
export { AbsolutePath, RelativePath } from "@elitza/schema/schema"
export { Session } from "@elitza/schema/session"
export { SessionInbox } from "@elitza/schema/session-inbox"
export { SessionMessage } from "@elitza/schema/session-message"
export { Skill } from "@elitza/schema/skill"
export { Prompt } from "@elitza/schema/prompt"
export { PromptInput } from "@elitza/schema/prompt-input"
export type { ElitzaEvent } from "@elitza/protocol/groups/event"
export type ElitzaClient = Effect.Success<ReturnType<typeof Elitza.make>>
