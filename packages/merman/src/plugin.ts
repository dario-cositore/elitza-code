import { Plugin } from "@elitza/plugin/tui"
import { createMermaidCodeBlockRenderer } from "./markdown.js"
import { resolveElitzaDiagramPalette } from "./palette.js"

export default Plugin.define({
  id: "opencode.merman",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "mermaid",
      createMermaidCodeBlockRenderer(context.renderer, () => ({
        colors: resolveElitzaDiagramPalette(context.theme, context.themeMode),
      })),
    )
  },
})
