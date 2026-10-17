import { registerCustomTheme } from "@pierre/diffs"
import { ElitzaTheme } from "./marked-theme"

let registered = false

export function registerElitzaTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Elitza", () => Promise.resolve(ElitzaTheme))
}
