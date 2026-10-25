import { describe, expect, test } from "bun:test"
import {
  alignPlanToKey,
  isRegionPlan,
  mimoEndpoint,
  mimoKeyFamily,
  type OnboardingState,
} from "./onboarding.js"

function state(answers: Record<string, string>): OnboardingState {
  return { active: true, step: 4, pending: "mimo_key", answers, started: "2026-10-25T00:00:00Z", completed: null }
}

describe("mimoKeyFamily", () => {
  test("sk keys are the standard API", () => {
    expect(mimoKeyFamily("sk-ec9rrj8qw8yon04uwh3jgytw8twn0vs9wlxbh2k0bd6ia7j4")).toBe("standard")
    expect(mimoKeyFamily("SK-ABC")).toBe("standard")
    expect(mimoKeyFamily("  sk-x  ")).toBe("standard")
  })

  test("tp keys are Token Plan keys", () => {
    expect(mimoKeyFamily("tp-evx1v52660notssa3g7rgkn7vylzow9eaqsa1xd94v4eduzi")).toBe("token-plan")
    expect(mimoKeyFamily("TP-ABC")).toBe("token-plan")
    expect(mimoKeyFamily("tp-x")).toBe("token-plan")
  })

  test("anything else is unknown", () => {
    expect(mimoKeyFamily("smoke-mimo-key")).toBe("unknown")
    expect(mimoKeyFamily("")).toBe("unknown")
  })
})

describe("isRegionPlan", () => {
  test("only the Token Plan regions count", () => {
    expect(isRegionPlan("europe")).toBe(true)
    expect(isRegionPlan("Singapore")).toBe(true)
    expect(isRegionPlan("china")).toBe(true)
    expect(isRegionPlan("standard")).toBe(false)
    expect(isRegionPlan("")).toBe(false)
    expect(isRegionPlan("not now")).toBe(false)
  })
})

describe("alignPlanToKey", () => {
  test("an sk key forces the standard endpoint", () => {
    const aligned = alignPlanToKey(state({ mimo_plan: "europe" }), "sk-abc")
    expect(aligned.answers.mimo_plan).toBe("standard")
    expect(aligned.pending).toBe("mimo_key")
    expect(aligned.active).toBe(true)
  })

  test("a tp key keeps its region", () => {
    const aligned = alignPlanToKey(state({ mimo_plan: "singapore" }), "tp-abc")
    expect(aligned.answers.mimo_plan).toBe("singapore")
    expect(aligned.pending).toBe("mimo_key")
  })

  test("a tp key without a region re-opens the region question", () => {
    const aligned = alignPlanToKey(state({ mimo_plan: "standard" }), "tp-abc")
    expect(aligned.answers.mimo_plan).toBe("")
    expect(aligned.pending).toBe("mimo_plan")
    expect(aligned.active).toBe(true)
    expect(aligned.completed).toBeNull()
  })

  test("an unknown key changes nothing", () => {
    const aligned = alignPlanToKey(state({ mimo_plan: "europe" }), "smoke-mimo-key")
    expect(aligned.answers.mimo_plan).toBe("europe")
    expect(aligned.pending).toBe("mimo_key")
  })
})

describe("resolveTokenPlanRegion", () => {
  test("the key picks its own region, hint first", async () => {
    const { resolveTokenPlanRegion } = await import("./wizard.js")
    const calls: string[] = []
    const region = await resolveTokenPlanRegion("tp-abc", "europe", async (_key, endpoint) => {
      calls.push(endpoint)
      return endpoint === mimoEndpoint("singapore")
    })
    expect(region).toBe("singapore")
    expect(calls[0]).toBe(mimoEndpoint("europe"))
    expect(calls[1]).toBe(mimoEndpoint("singapore"))
  })

  test("the hint wins when it accepts the key", async () => {
    const { resolveTokenPlanRegion } = await import("./wizard.js")
    const region = await resolveTokenPlanRegion("tp-abc", "china", async () => true)
    expect(region).toBe("china")
  })

  test("a standard hint is not probed", async () => {
    const { resolveTokenPlanRegion } = await import("./wizard.js")
    const calls: string[] = []
    const region = await resolveTokenPlanRegion("tp-abc", "standard", async (_key, endpoint) => {
      calls.push(endpoint)
      return false
    })
    expect(region).toBeUndefined()
    expect(calls).toEqual([mimoEndpoint("europe"), mimoEndpoint("singapore"), mimoEndpoint("china")])
  })
})
