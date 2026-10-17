import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"
import fs from "fs"

export default defineConfig({
  plugins: [
    solidPlugin(),
    providerIconsPlugin(),
    iconsSpritesheet([
      {
        withTypes: true,
        inputDir: "src/assets/icons/file-types",
        outputDir: "src/components/file-icons",
        formatter: "prettier",
      },
      {
        withTypes: true,
        inputDir: "src/assets/icons/provider",
        outputDir: "src/components/provider-icons",
        formatter: "prettier",
        iconNameTransformer: (iconName) => iconName,
      },
    ]),
  ],
  server: { port: 3001 },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
})

function providerIconsPlugin() {
  return {
    name: "provider-icons-plugin",
    configureServer() {
      void fetchProviderIcons()
    },
    buildStart() {
      void fetchProviderIcons()
    },
  }
}

// opencode's own brand icons are intentionally never vendored: Elitza is not opencode,
// so the `opencode`/`opencode-go` providers fall back to the generic `synthetic` icon.
const excludedProviders = new Set(["opencode", "opencode-go"])

async function fetchProviderIcons() {
  const url = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai"

  const providers = await fetch(`${url}/api.json`)
    .then((res) => res.json())
    .then((json) => Object.keys(json).filter((provider) => !excludedProviders.has(provider)))

  await Promise.all(
    providers.map((provider) =>
      fetch(`${url}/logos/${provider}.svg`)
        .then((res) => res.text())
        .then((svg) => fs.writeFileSync(`./src/assets/icons/provider/${provider}.svg`, svg)),
    ),
  )
}
