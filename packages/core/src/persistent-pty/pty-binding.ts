// Published separately by dario-cositore/elitza-code-pty; it has not migrated npm scopes.
import { binaryPath } from "@opencode-ai/pty"

const binding: string | { readonly path: string; readonly version: string; readonly sha256: string } | undefined =
  binaryPath

export default binding
