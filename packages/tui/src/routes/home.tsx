import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { Logo } from "../component/logo"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { FormPrompt } from "./session/form"
import { Slot } from "../plugin/render"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useUpdateNotification } from "../context/update-notification"
import { useExit } from "../context/exit"
import { FadeInText } from "../component/fade-in-text"
import { tint } from "../theme/color"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

const tips = [
  "Add your MiMo key with /setup, or /connect another provider",
  "Elitza learns as you work — memories build up in ~/.elitza",
  "Switch brains anytime with /models — your MiMo key, or BYOK",
  "Make her yours — edit ~/.elitza/SOUL.md and personas",
  "Type / for commands and @ for files — ctrl+p opens the palette",
]

const hints: [key: string, label: string][] = [
  ["tab", "complete"],
  ["@", "files"],
  ["/", "commands"],
  ["ctrl+p", "palette"],
  ["ctrl+o", "sessions"],
]

// Deterministic starfield so every terminal renders the same sky and frame tests stay stable.
const hash = (seed: number) => {
  const a = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b)
  const b = Math.imul(a ^ (a >>> 16), 0x45d9f3b)
  return ((b ^ (b >>> 16)) >>> 0) / 4294967296
}

const starField = Array.from({ length: 44 }, (_, index) => ({
  x: hash(index + 1),
  y: hash(index + 101),
  char: (["·", "✦", "°", "."] as const)[index % 4],
  accent: index % 5 === 0,
}))

export function Home() {
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const [logoWidth, setLogoWidth] = createSignal(0)
  const [tipIndex, setTipIndex] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setTipIndex((index) => (index + 1) % tips.length), 20000)
    onCleanup(() => clearInterval(timer))
  })
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const currentLocation = () => route.location ?? data.location.default()
  const forms = createMemo(() => data.session.form.list("global", currentLocation()) ?? [])
  let sent = false

  // Track only the route location and (when absent) the default location; location.set
  // reads other signals internally and tracking them would re-assert the route location
  // after the user overrides it with /cd.
  createEffect(() => {
    const target = currentLocation()
    untrack(() => location.set(target))
  })

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r || route.prompt || !args.prompt) return
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  createEffect(() => {
    const composer = ref()
    const prompt = route.prompt
    if (!composer || prompt?.text === undefined) return
    untrack(() => composer.set(prompt))
  })

  // Wait for everything submit needs before auto-submitting --prompt; it runs once.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box
        flexGrow={1}
        alignItems="center"
        paddingLeft={dimensions().width < 44 ? 1 : 2}
        paddingRight={dimensions().width < 44 ? 1 : 2}
      >
        <box position="absolute" left={0} top={0} right={0} bottom={0} zIndex={0}>
          <For each={starField}>
            {(star) => (
              <text
                position="absolute"
                left={Math.round(star.x * (dimensions().width - 1))}
                top={Math.round(star.y * (dimensions().height - 1))}
                fg={
                  star.accent
                    ? tint(theme.background.base, theme.brand.base, 0.45)
                    : tint(theme.background.base, theme.text.muted, 0.35)
                }
              >
                {star.char}
              </text>
            )}
          </For>
        </box>
        <box flexGrow={1} minHeight={0} />
        <Show when={dimensions().height >= 12}>
          <box height={1} flexShrink={0}>
            <text fg={theme.text.muted}>Dario Cositore</text>
          </box>
        </Show>
        <box height={2} minHeight={0} flexShrink={1} />
        <box
          flexShrink={0}
          onSizeChange={function () {
            setLogoWidth(this.width)
          }}
        >
          <Logo />
        </box>
        <box height={1} flexShrink={0} />
        <UpdateNotification width={logoWidth()} />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0} position="relative">
          <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} />
        </box>
        <Show when={dimensions().height >= 20}>
          <Show when={dimensions().width >= 76}>
            <box
              width="100%"
              maxWidth={75}
              flexShrink={0}
              paddingTop={1}
              flexDirection="row"
              justifyContent="center"
              gap={3}
            >
              <For each={hints}>
                {([key, label]) => (
                  <text>
                    <span style={{ fg: theme.text.base }}>{key}</span>
                    <span style={{ fg: theme.text.muted }}> {label}</span>
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={dimensions().width >= 68}>
            <box
              width="100%"
              maxWidth={75}
              flexShrink={0}
              flexDirection="row"
              justifyContent="center"
              paddingTop={1}
            >
              <text>
                <span style={{ fg: theme.brand.base }}>● Tip</span>
                <span style={{ fg: theme.text.base }}> {tips[tipIndex()]}</span>
              </text>
            </box>
          </Show>
        </Show>
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <Slot path="home.footer" />
      </box>
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}

function UpdateNotification(props: { width: number }) {
  const update = useUpdateNotification()
  const exit = useExit()
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const backdrop = () => (hovered() ? theme.background.action.primary.hovered : theme.background.base)
  createEffect(() => {
    update.notification()
    setHovered(false)
  })

  return (
    <Show when={update.notification()} keyed>
      {(state) => {
        const version = state.version.replace(/^v/, "")
        const remote = state.source === "server" && state.remote
        return (
          <Show when={!remote || state.type === "available"}>
            <box
              flexShrink={0}
              flexDirection="row"
              justifyContent="center"
              width={props.width}
              maxWidth="100%"
              gap={1}
              backgroundColor={hovered() ? theme.background.action.primary.hovered : undefined}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => setHovered(false)}
              onMouseUp={() => {
                if (remote) return update.dismiss()
                if (state.type === "installed") return exit()
                update.open?.("notification")
              }}
            >
              <FadeInText fg={theme.text.muted} backdrop={backdrop()}>
                <Show when={!remote}>
                  <span style={{ fg: theme.text.action.primary.selected }}>
                    {state.type === "installed" ? "/exit" : "/update"}
                  </span>
                </Show>
                {remote
                  ? "remote server update available"
                  : state.type === "installed"
                    ? ` restart to use v${version}`
                    : ` to install v${version}`}
              </FadeInText>
            </box>
          </Show>
        )
      }}
    </Show>
  )
}
