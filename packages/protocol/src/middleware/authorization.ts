import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { UnauthorizedError } from "../errors"

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@opencode/HttpApiAuthorization", {
  error: UnauthorizedError,
}) {}

export class PrincipalAuthorization extends HttpApiMiddleware.Service<PrincipalAuthorization>()(
  "@opencode/ProContractPrincipalAuthorization",
  { error: UnauthorizedError },
) {}
