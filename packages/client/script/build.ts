import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitEffectShape, emitPromise, write } from "@elitza/httpapi-codegen"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "@elitza/protocol/client"
import { Agent } from "@elitza/schema/agent"
import { Command } from "@elitza/schema/command"
import { Config } from "@elitza/schema/config"
import { Credential } from "@elitza/schema/credential"
import { Event } from "@elitza/schema/event"
import { EventLog } from "@elitza/schema/event-log"
import { FileDiff } from "@elitza/schema/file-diff"
import { FileSystem } from "@elitza/schema/filesystem"
import { Form } from "@elitza/schema/form"
import { Instruction } from "@elitza/schema/instruction"
import { InstructionEntry } from "@elitza/schema/instruction-entry"
import { Integration } from "@elitza/schema/integration"
import { Location } from "@elitza/schema/location"
import { Mcp } from "@elitza/schema/mcp"
import { Model } from "@elitza/schema/model"
import { Money } from "@elitza/schema/money"
import { Permission } from "@elitza/schema/permission"
import { PermissionSaved } from "@elitza/schema/permission-saved"
import { Plugin } from "@elitza/schema/plugin"
import { Project } from "@elitza/schema/project"
import { Worktree } from "@elitza/schema/worktree"
import { AgentAttachment, FileAttachment, Prompt, PromptMention } from "@elitza/schema/prompt"
import { PromptInput } from "@elitza/schema/prompt-input"
import { Provider } from "@elitza/schema/provider"
import { Pty } from "@elitza/schema/pty"
import { PtyTicket } from "@elitza/schema/pty-ticket"
import { Question } from "@elitza/schema/question"
import { Reference } from "@elitza/schema/reference"
import { AbsolutePath, RelativePath } from "@elitza/schema/schema"
import { Session } from "@elitza/schema/session"
import { SessionMessage } from "@elitza/schema/session-message"
import { SessionInbox } from "@elitza/schema/session-inbox"
import { Shell } from "@elitza/schema/shell"
import { Skill } from "@elitza/schema/skill"
import { Snapshot } from "@elitza/schema/snapshot"
import { Vcs } from "@elitza/schema/vcs"
import { WebSearch } from "@elitza/schema/websearch"
import { Workspace } from "@elitza/schema/workspace"
import { SessionsCursor } from "@elitza/protocol/groups/session"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"

const promiseContract = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })
const effectContract = compile(ClientApi, { groupNames, omitEndpoints: effectOmitEndpoints })
const effectTypeReferences = [
  ...namespaceTypes("Agent", "@elitza/schema/agent", Agent),
  ...namespaceTypes("Command", "@elitza/schema/command", Command),
  ...namespaceTypes("Config", "@elitza/schema/config", Config),
  ...namespaceTypes("Credential", "@elitza/schema/credential", Credential),
  ...namespaceTypes("Event", "@elitza/schema/event", Event),
  ...namespaceTypes("EventLog", "@elitza/schema/event-log", EventLog),
  ...namespaceTypes("FileDiff", "@elitza/schema/file-diff", FileDiff),
  ...namespaceTypes("FileSystem", "@elitza/schema/filesystem", FileSystem),
  ...namespaceTypes("Form", "@elitza/schema/form", Form),
  ...namespaceTypes("Instruction", "@elitza/schema/instruction", Instruction),
  ...namespaceTypes("InstructionEntry", "@elitza/schema/instruction-entry", InstructionEntry),
  ...namespaceTypes("Integration", "@elitza/schema/integration", Integration),
  typeReference("Location.PublicRef", "@elitza/schema/location", Location.PublicRef),
  typeReference("Location.PublicInfo", "@elitza/schema/location", Location.PublicInfo),
  ...namespaceTypes("Mcp", "@elitza/schema/mcp", Mcp),
  ...namespaceTypes("Model", "@elitza/schema/model", Model),
  ...namespaceTypes("Money", "@elitza/schema/money", Money),
  ...namespaceTypes("Permission", "@elitza/schema/permission", Permission),
  ...namespaceTypes("PermissionSaved", "@elitza/schema/permission-saved", PermissionSaved),
  ...namespaceTypes("Plugin", "@elitza/schema/plugin", Plugin),
  ...namespaceTypes("Project", "@elitza/schema/project", Project),
  ...namespaceTypes("Worktree", "@elitza/schema/worktree", Worktree),
  ...namespaceTypes("PromptInput", "@elitza/schema/prompt-input", PromptInput),
  ...namespaceTypes("Provider", "@elitza/schema/provider", Provider),
  ...namespaceTypes("Pty", "@elitza/schema/pty", Pty),
  ...namespaceTypes("PtyTicket", "@elitza/schema/pty-ticket", PtyTicket),
  ...namespaceTypes("Question", "@elitza/schema/question", Question),
  ...namespaceTypes("Reference", "@elitza/schema/reference", Reference),
  ...namespaceTypes("Session", "@elitza/schema/session", Session),
  ...namespaceTypes("SessionMessage", "@elitza/schema/session-message", SessionMessage),
  ...namespaceTypes("SessionInbox", "@elitza/schema/session-inbox", SessionInbox),
  ...namespaceTypes("Shell", "@elitza/schema/shell", Shell),
  ...namespaceTypes("Skill", "@elitza/schema/skill", Skill),
  ...namespaceTypes("Snapshot", "@elitza/schema/snapshot", Snapshot),
  ...namespaceTypes("Vcs", "@elitza/schema/vcs", Vcs),
  ...namespaceTypes("WebSearch", "@elitza/schema/websearch", WebSearch),
  ...namespaceTypes("Workspace", "@elitza/schema/workspace", Workspace),
  typeReference("Prompt", "@elitza/schema/prompt", Prompt),
  typeReference("PromptMention", "@elitza/schema/prompt", PromptMention),
  typeReference("FileAttachment", "@elitza/schema/prompt", FileAttachment),
  typeReference("AgentAttachment", "@elitza/schema/prompt", AgentAttachment),
  typeReference("AbsolutePath", "@elitza/schema/schema", AbsolutePath),
  typeReference("RelativePath", "@elitza/schema/schema", RelativePath),
  typeReference("SessionsCursor", "@elitza/protocol/groups/session", SessionsCursor),
]

await Effect.runPromise(
  Effect.all(
    [
      write(
        emitPromise(promiseContract, {
          mutableOutputs: true,
        }),
        fileURLToPath(new URL("../src/promise/generated", import.meta.url)),
      ),
      write(
        emitEffectImported(effectContract, {
          module: "../../contract",
          api: "ClientApi",
          shapeModule: "../api/api.js",
        }),
        fileURLToPath(new URL("../src/effect/generated", import.meta.url)),
      ),
      write(
        emitEffectShape(effectContract, {
          typeReferences: effectTypeReferences,
          outputTypes: {
            "event.subscribe": {
              name: "ElitzaEvent",
              import: 'import type { ElitzaEvent } from "@elitza/protocol/groups/event"',
            },
          },
        }),
        fileURLToPath(new URL("../src/effect/api", import.meta.url)),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)

function namespaceTypes(namespace: string, module: string, values: object) {
  return Object.entries(values).flatMap(([name, schema]) =>
    Schema.isSchema(schema) ? [typeReference(`${namespace}.${name}`, module, schema)] : [],
  )
}

function typeReference(name: string, module: string, schema: Schema.Top) {
  return {
    schema,
    name,
    import: `import type { ${name.split(".")[0]} } from ${JSON.stringify(module)}`,
  }
}
