import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { createAppFixture } from "./fixture/app"

// Elitza's model dialog offers only the OpenRouter free endpoint plus providers the
// user connected themselves (BYOK). OpenCode's Zen models are rejected by the
// upstream free tier and paid OpenRouter models are out of scope, so both stay hidden.
test("model dialog offers only the OpenRouter free endpoint and BYOK providers", async () => {
  await using state = await tmpdir()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "project",
    title: "Model offering fixture",
    agent: "build",
    model: { providerID: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    state: state.path,
    config: {
      animations: false,
      keybinds: { "model.list": "f8" },
    },
    args: { sessionID: session.id },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }],
        })
      if (url.pathname === "/api/provider")
        return json({
          location,
          data: [
            { id: "openrouter", name: "OpenRouter" },
            { id: "opencode", name: "OpenCode" },
            { id: "demo", name: "Demo" },
          ],
        })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "nvidia/nemotron-3-super-120b-a12b:free",
              providerID: "openrouter",
              name: "Nemotron Super Free",
              variants: [],
              cost: [{ input: 0, output: 0 }],
              time: { released: 0 },
            },
            {
              id: "nvidia/nemotron-paid",
              providerID: "openrouter",
              name: "Nemotron Paid Pro",
              variants: [],
              cost: [{ input: 5, output: 15 }],
              time: { released: 0 },
            },
            {
              id: "ling-3.0-flash-fin-free",
              providerID: "opencode",
              name: "Zen Ling Free",
              variants: [],
              cost: [{ input: 0, output: 0 }],
              time: { released: 0 },
            },
            {
              id: "first",
              providerID: "demo",
              name: "First model",
              variants: [],
              cost: [],
              time: { released: 0 },
            },
          ],
        })
      if (url.pathname === "/api/command")
        return json({ location, data: [{ name: "review", description: "Review the input" }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · Nemotron Super Free"))
  setup.mockInput.pressKey("F8")
  // DialogSelect focuses its filter on a timer; wait for the dialog and its focus together.
  await setup.waitForFrame(
    (frame) => frame.includes("Select model") && setup.renderer.currentFocusedRenderable instanceof InputRenderable,
  )
  await setup.waitForFrame((frame) => frame.includes("Nemotron Super Free"))
  const frame = setup.captureCharFrame()
  expect(frame).toInclude("First model")
  expect(frame).not.toInclude("Nemotron Paid Pro")
  expect(frame).not.toInclude("Zen Ling Free")
})
