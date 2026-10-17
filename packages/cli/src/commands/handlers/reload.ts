import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Elitza } from "@elitza/client"
import { Service } from "@elitza/client/effect/service"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(
  Commands.commands.reload,
  Effect.fn("cli.reload")(function* (input: Runtime.Input<typeof Commands.commands.reload>) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = Elitza.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    yield* Effect.tryPromise({
      try: (signal) => client.location.reload({ signal }),
      catch: (cause) => cause,
    })
    process.stdout.write("Configuration reloaded" + EOL)
  }),
)
