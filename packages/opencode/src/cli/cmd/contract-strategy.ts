import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractPolicy } from "@opencode-ai/core/pro-contract/policy"
import { ProContractPromotion } from "@opencode-ai/core/pro-contract/promotion"
import { Clock, Effect, Schema } from "effect"
import path from "path"
import type { Argv } from "yargs"
import { effectCmd, fail } from "../effect-cmd"

const AuthorizeCommand = effectCmd({
  command: "authorize",
  describe: "locally authorize a seed and freeze its task-pareto protocol; no improvement is claimed",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("scope", { type: "string", demandOption: true, describe: "new strategy scope" })
      .option("protocol", { type: "string", demandOption: true, describe: "frozen evaluation protocol JSON file" })
      .option("bundle", { type: "string", demandOption: true, describe: "solver/generator bundle JSON file" }),
  handler: Effect.fn("Cli.contract.strategy.authorize")(function* (args) {
    const protocol = yield* readJson(args.protocol, ProContractPromotion.Protocol)
    const bundle = yield* readJson(args.bundle, ProContractPolicy.Bundle)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const state = yield* policies.authorize({ scope: args.scope, protocol, bundle, now })
    console.log(JSON.stringify(state, null, 2))
  }),
})

const ShowCommand = effectCmd({
  command: "show <scope>",
  describe: "show the frozen protocol, selection revision, and supporting Contract history",
  instance: false,
  builder: (yargs) => yargs.positional("scope", { type: "string", demandOption: true, describe: "strategy scope" }),
  handler: Effect.fn("Cli.contract.strategy.show")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    const state = yield* policies.get(args.scope)
    if (!state) return yield* fail(`Strategy scope not found: ${args.scope}`)
    console.log(JSON.stringify(state, null, 2))
  }),
})

const BindCommand = effectCmd({
  command: "bind <scope>",
  describe: "resolve a standing policy and its ordinary Contract requirement without executing it",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("role", { choices: ["solver", "generator"] as const, demandOption: true, describe: "execution role" }),
  handler: Effect.fn("Cli.contract.strategy.bind")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    console.log(JSON.stringify(yield* policies.bind({ scope: args.scope, role: args.role }), null, 2))
  }),
})

const ProposeCommand = effectCmd({
  command: "propose",
  describe: "issue an ordinary promotion Contract for an exact generated strategy.json handoff",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .option("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("bundle", { type: "string", demandOption: true, describe: "generated solver/generator bundle JSON file" })
      .option("generation", {
        type: "string",
        demandOption: true,
        describe: "JSON file containing the generation Contract's exact contractID, revision, and subjectHash",
      }),
  handler: Effect.fn("Cli.contract.strategy.propose")(function* (args) {
    const bundle = yield* readJson(args.bundle, ProContractPolicy.Bundle)
    const generation = yield* readJson(args.generation, ProContractPolicy.Generation)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const contract = yield* policies.propose({
      scope: args.scope,
      expectedRevision: args.expectedRevision,
      bundle,
      generation,
      now,
    })
    console.log(JSON.stringify(ProContract.info(contract), null, 2))
  }),
})

const SettleCommand = effectCmd({
  command: "settle <contractID>",
  describe: "locally attest external evaluation evidence and select only a qualified task-pareto successor",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("contractID", { type: "string", demandOption: true, describe: "promotion Contract ID" })
      .option("evidence", {
        type: "string",
        demandOption: true,
        describe: "complete external evaluation evidence JSON file",
      }),
  handler: Effect.fn("Cli.contract.strategy.settle")(function* (args) {
    const evidence = yield* readJson(args.evidence, ProContractPromotion.Evidence)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const result = yield* policies.settle({ contractID: ProContract.ID.make(args.contractID), evidence, now })
    console.log(JSON.stringify({ ...result, contract: ProContract.info(result.contract) }, null, 2))
    if (!result.decision.eligible) return yield* fail("Candidate did not satisfy the frozen task-pareto protocol", 2)
  }),
})

const RollbackCommand = effectCmd({
  command: "rollback <scope>",
  describe: "locally select the previous strategy with standing Contract support",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs).positional("scope", { type: "string", demandOption: true, describe: "strategy scope" }),
  handler: Effect.fn("Cli.contract.strategy.rollback")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const state = yield* policies.rollback({ scope: args.scope, expectedRevision: args.expectedRevision, now })
    console.log(JSON.stringify(state, null, 2))
  }),
})

const RevokeCommand = effectCmd({
  command: "revoke <scope>",
  describe: "locally withdraw selected strategy support and close dependent execution",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .positional("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("evidence-hash", { type: "string", demandOption: true, describe: "SHA-256 of the revocation evidence" })
      .check(
        (args) => /^[a-f0-9]{64}$/.test(args["evidence-hash"]) || "--evidence-hash must be a lowercase SHA-256 digest",
      ),
  handler: Effect.fn("Cli.contract.strategy.revoke")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const state = yield* policies.revoke({
      scope: args.scope,
      expectedRevision: args.expectedRevision,
      evidenceHash: args.evidenceHash,
      now,
    })
    console.log(JSON.stringify(state, null, 2))
  }),
})

export const ContractStrategyCommand = effectCmd({
  command: "strategy",
  describe: "manage explicit local strategy authority, task-pareto promotion, and rollback",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(AuthorizeCommand)
      .command(ShowCommand)
      .command(BindCommand)
      .command(ProposeCommand)
      .command(SettleCommand)
      .command(RollbackCommand)
      .command(RevokeCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.contract.strategy")(function* () {}),
})

function withRevision(yargs: Argv) {
  return yargs
    .option("expected-revision", {
      type: "number",
      demandOption: true,
      describe: "exact observed strategy selection revision",
    })
    .check(
      (args) =>
        (Number.isSafeInteger(args["expected-revision"]) && args["expected-revision"] > 0) ||
        "--expected-revision must be a positive safe integer",
    )
}

function readJson<A>(file: string, schema: Schema.Codec<A, unknown>) {
  return Effect.promise(() => Bun.file(path.resolve(file)).text()).pipe(
    Effect.catchDefect((cause) =>
      fail(`Cannot read JSON file ${file}: ${cause instanceof Error ? cause.message : String(cause)}`),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })),
    Effect.catchTag("SchemaError", (error) => fail(`Invalid JSON file ${file}: ${error.message}`)),
  )
}
