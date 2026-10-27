/**
 * Standalone launcher for the Elitza CRM "house".
 *
 * The same server is auto-started by the brain plugin whenever the engine
 * (elitza serve) runs, so this script is only needed for running it on its
 * own (e.g. during development).
 *
 * Run:  bun run script/crm-view.ts
 * Then open http://127.0.0.1:8787
 */
import { startCrmView } from "../src/crmview.js"

const handle = startCrmView()
if (!handle) {
  console.error("CRM view could not start (port in use or other error).")
  process.exit(1)
}
// Keep the process alive.
setInterval(() => {}, 1 << 30)