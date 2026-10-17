import { Agent } from "@elitza/core/agent"
import { AISDK } from "@elitza/core/aisdk"
import { Command } from "@elitza/core/command"
import { Config } from "@elitza/core/config"
import { Credential } from "@elitza/core/credential"
import { Database } from "@elitza/core/database/database"
import { FileAccess } from "@elitza/core/file-access"
import { LayerNodePlatform } from "@elitza/util/effect/app-node-platform"
import { AppProcess } from "@elitza/util/process"
import { LayerNode } from "@elitza/util/effect/layer-node"
import { Bus } from "@elitza/core/bus"
import { FileSystem } from "@elitza/core/filesystem"
import { FSUtil } from "@elitza/util/fs-util"
import { Form } from "@elitza/core/form"
import { Generate } from "@elitza/core/generate"
import { Integration } from "@elitza/core/integration"
import { KV } from "@elitza/core/kv"
import { Location } from "@elitza/core/location"
import { ManagedPolicy } from "@elitza/core/managed-policy"
import { Mcp } from "@elitza/core/mcp/index"
import { Model } from "@elitza/core/model"
import { Npm } from "@elitza/util/npm"
import { Plugin } from "@elitza/core/plugin"
import { PluginHooks } from "@elitza/core/plugin/hooks"
import { Provider } from "@elitza/core/provider"
import { Session } from "@elitza/core/session"
import { PersistentPty } from "@elitza/core/persistent-pty"
import { LocationServiceMap } from "@elitza/core/location-service-map"
import { AppNodeBuilder } from "@elitza/core/effect/app-node-builder"
import { Permission } from "@elitza/core/permission"
import { Reference } from "@elitza/core/reference"
import { Rpc } from "@elitza/core/rpc"
import { Skill } from "@elitza/core/skill"
import { SkillDiscovery } from "@elitza/core/skill/discovery"
import { Watcher } from "@elitza/core/filesystem/watcher"
import { Tool } from "@elitza/core/tool"
import { Vcs } from "@elitza/core/vcs"
import { WebSearch } from "@elitza/core/websearch"
import { Worktree } from "@elitza/core/worktree"
import { WorktreeStrategies } from "@elitza/core/worktree/strategies"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const configLayer = Config.testLayer()

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

export const makePluginTestLayer = (permission = permissionLayer) =>
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      FileSystem.node,
      FSUtil.node,
      Location.node,
      Npm.node,
      Credential.node,
      Config.node,
      Database.node,
      FileAccess.node,
      Bus.node,
      Form.node,
      Generate.node,
      LayerNodePlatform.httpClient,
      Plugin.node,
      Agent.node,
      AISDK.node,
      Provider.node,
      Model.node,
      Command.node,
      Integration.node,
      KV.node,
      ManagedPolicy.node,
      Mcp.node,
      Session.node,
      PersistentPty.node,
      LocationServiceMap.node,
      Permission.node,
      PluginHooks.node,
      Reference.node,
      Rpc.node,
      Skill.node,
      SkillDiscovery.node,
      Tool.node,
      Vcs.node,
      Watcher.node,
      WebSearch.node,
      Worktree.node,
      WorktreeStrategies.node,
    ]),
    [
      Location.node.replace(tempLocationLayer),
      Npm.node.replace(npmLayer),
      Config.node.replace(configLayer),
      Mcp.node.replace(emptyMcpLayer),
      Generate.node.replace(generateLayer),
      Permission.node.replace(permission),
    ],
  ).pipe(Layer.provideMerge(configLayer))

export const PluginTestLayer = makePluginTestLayer()
