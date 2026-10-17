import type { EventApi } from "@elitza/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}
