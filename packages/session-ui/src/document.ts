import type { FileDiffInfo, SessionMessageInfo, SessionStatus } from "@elitza/client/promise"

export type SessionDocument = {
  sessionID: string
  messages: SessionMessageInfo[]
  status: SessionStatus
  diffs: FileDiffInfo[]
}
