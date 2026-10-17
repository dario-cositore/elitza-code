import type { ElitzaEvent } from "@elitza/client"
import { useClient } from "./client"

type EventMetadata = {
  directory: string | undefined
}
type ElitzaEventMap = { [Type in ElitzaEvent["type"]]: Extract<ElitzaEvent, { type: Type }> }

export function useEvent() {
  const client = useClient()

  function subscribe(handler: (event: ElitzaEvent, metadata: EventMetadata) => void) {
    return client.event.listen(({ details }) => {
      if (details.type === "server.connected") return
      handler(details, { directory: details.location?.directory })
    })
  }

  function on<T extends ElitzaEvent["type"]>(
    type: T,
    handler: (event: ElitzaEventMap[T], metadata: EventMetadata) => void,
  ) {
    return client.event.on(type, (event) => {
      handler(event, { directory: event.location?.directory })
    })
  }

  return {
    subscribe,
    on,
  }
}
