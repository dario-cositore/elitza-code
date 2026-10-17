import { expect, test } from "bun:test"
import { isElitzaEvent, ElitzaEvent, type ElitzaEventEncoded } from "../src/groups/event.js"

type JsonShape<Value> = Value extends string | number | boolean | null
  ? Value
  : Value extends undefined
    ? never
    : Value extends ReadonlyArray<infer Item>
      ? ReadonlyArray<JsonShape<Item>>
      : Value extends object
        ? {
            readonly [Key in keyof Value as undefined extends Value[Key] ? never : Key]: JsonShape<Value[Key]>
          } & {
            readonly [Key in keyof Value as undefined extends Value[Key] ? Key : never]?: JsonShape<
              Exclude<Value[Key], undefined>
            >
          }
        : Value

// JSON.stringify omits undefined object properties, so normalize them before
// requiring every runtime event shape to fit its encoded wire contract.
const wireReady: [JsonShape<ElitzaEvent>] extends [JsonShape<ElitzaEventEncoded>] ? true : false = true

test("classifies public events by type", () => {
  expect(isElitzaEvent({ type: "server.connected" })).toBe(true)
  expect(isElitzaEvent({ type: "mcp.status.changed" })).toBe(true)
  expect(isElitzaEvent({ type: "mcp.resources.changed" })).toBe(true)
  expect(isElitzaEvent({ type: "mcp.tools.changed" })).toBe(false)
  expect(isElitzaEvent({ type: "acme.updated" })).toBe(false)
})

test("keeps public event runtime values within the encoded contract", () => {
  expect(wireReady).toBe(true)
})
