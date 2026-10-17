import type { EventApi } from "@elitza/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}
