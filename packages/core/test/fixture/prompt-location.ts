import type { FileSystem } from "@elitza/core/filesystem"
import { Bus } from "@elitza/core/bus"
import { Image } from "@elitza/core/image"
import { LocationServiceMap } from "@elitza/core/location-service-map"
import type { LocationServices } from "@elitza/core/location-services"
import { Plugin } from "@elitza/core/plugin"
import { PluginHooks } from "@elitza/core/plugin/hooks"
import { Skill } from "@elitza/core/skill"
import type { Location } from "@elitza/schema/location"
import { makeGlobalNode } from "@elitza/util/effect/app-node"
import { LayerNode } from "@elitza/util/effect/layer-node"
import { Effect, Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories.
export const promptLocationNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node, Plugin.node]), {
            replacements: [
              Bus.node.replace(Layer.succeed(Bus.Service, bus)),
              Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            ],
          }) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [Bus.node],
})
