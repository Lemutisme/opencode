import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization, PrincipalAuthorization } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization, PrincipalAuthorization } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

const unauthorized = Effect.fnUntraced(function* () {
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
  )
  return yield* new UnauthorizedError({ message: "Authentication required" })
})

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect
        const credential = yield* credentialFromRequest(request)
        if (ServerAuth.authorized(credential, config)) return yield* effect
        return yield* unauthorized()
      }),
    )
  }),
)

export const principalAuthorizationLayer = Layer.effect(
  PrincipalAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    return PrincipalAuthorization.of((effect) =>
      Effect.gen(function* () {
        if (!ServerAuth.required(config)) return yield* unauthorized()
        const credential = yield* credentialFromRequest(yield* HttpServerRequest.HttpServerRequest)
        if (ServerAuth.authorized(credential, config)) return yield* effect
        return yield* unauthorized()
      }),
    )
  }),
)
