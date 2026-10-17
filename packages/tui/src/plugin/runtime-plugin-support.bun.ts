import { ensurePluginRuntime, provides } from "@elitza/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@elitza/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensurePluginRuntime()
ensureRuntimePluginSupport({
  additional: {
    "@elitza/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
  preserve: provides,
})
