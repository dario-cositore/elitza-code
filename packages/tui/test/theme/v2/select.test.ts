import { expect, test } from "bun:test"
import { selectTheme, selectThemeMode, supportsThemeMode, themeModes } from "@opencode/theme/tui"
import { getElitzaTheme } from "../../../src/theme"

test("selects complete light and dark themes independently", () => {
  const light = selectTheme(getElitzaTheme(), "light")
  const dark = selectTheme(getElitzaTheme(), "dark")
  expect(selectTheme(getElitzaTheme())).toEqual(light)
  expect(light.hue).toEqual(getElitzaTheme().light.hue)
  expect(dark.text).toEqual(getElitzaTheme().base.text)
  expect(dark.hue).toEqual(getElitzaTheme().dark.hue)
  expect(selectThemeMode(getElitzaTheme(), "dark")).toEqual({ theme: dark, mode: "dark" })
})

test("selects the available mode when the requested mode is missing", () => {
  const lightOnly = { base: getElitzaTheme().base, light: getElitzaTheme().light } as const
  const darkOnly = { base: getElitzaTheme().base, dark: getElitzaTheme().dark } as const

  expect(themeModes(lightOnly)).toEqual(["light"])
  expect(themeModes(darkOnly)).toEqual(["dark"])
  expect(supportsThemeMode(lightOnly, "light")).toBeTrue()
  expect(supportsThemeMode(lightOnly, "dark")).toBeFalse()
  expect(selectThemeMode(lightOnly, "dark")).toEqual({ theme: selectTheme(getElitzaTheme(), "light"), mode: "light" })
  expect(selectThemeMode(darkOnly, "light")).toEqual({ theme: selectTheme(getElitzaTheme(), "dark"), mode: "dark" })
})
