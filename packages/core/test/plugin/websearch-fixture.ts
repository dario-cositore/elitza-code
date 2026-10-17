import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AppNodeBuilder } from "@elitza/core/effect/app-node-builder"
import { LayerNode } from "@elitza/util/effect/layer-node"
import { Credential } from "@elitza/core/credential"
import { Config } from "@elitza/core/config"
import { Bus } from "@elitza/core/bus"
import { Form } from "@elitza/core/form"
import { Integration } from "@elitza/core/integration"
import { WebSearch } from "@elitza/core/websearch"
import { testEffect } from "../lib/effect"

interface WebSearchRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

export const requests: WebSearchRequest[] = []
export const signals: AbortSignal[] = []
let responseBody = ""
let responseStatus = 200
let responseHeaders: Record<string, string> = {}

export function resetWebSearchFixture(body: string, status = 200) {
  requests.length = 0
  signals.length = 0
  responseBody = body
  responseStatus = status
  responseHeaders = {}
}

export function setResponseHeaders(headers: Record<string, string>) {
  responseHeaders = headers
}

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, _url, signal) =>
    Effect.sync(() => {
      signals.push(signal)
      if (request.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${request.body._tag}`)
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(new TextDecoder().decode(request.body.body)),
      })
      return HttpClientResponse.fromWeb(
        request,
        new Response(responseBody, { status: responseStatus, headers: responseHeaders }),
      )
    }),
  ),
)

export const webSearchIntegrationTest = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node, Form.node, WebSearch.node]), [
      Config.node.replace(Config.testLayer()),
    ]),
    http,
  ),
)
