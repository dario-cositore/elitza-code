import { getSharedHighlighter } from "@pierre/diffs"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { createMarkdownParser } from "./marked-parser"
import { registerElitzaTheme } from "./marked-theme-register"

export { ElitzaTheme } from "./marked-theme"

registerElitzaTheme()

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () =>
    createMarkdownParser(async (code, language) => {
      const highlighter = await getSharedHighlighter({
        themes: ["Elitza"],
        langs: [],
        preferredHighlighter: "shiki-wasm",
      })

      const name = language in bundledLanguages ? language : "text"

      if (!highlighter.getLoadedLanguages().includes(name)) await highlighter.loadLanguage(name as BundledLanguage)

      return highlighter.codeToHtml(code, {
        lang: name,
        theme: "Elitza",
        tabindex: false,
      })
    }),
})
