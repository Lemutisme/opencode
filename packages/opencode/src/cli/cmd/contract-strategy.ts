import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractPolicy } from "@opencode-ai/core/pro-contract/policy"
import { ProContractPromotion } from "@opencode-ai/core/pro-contract/promotion"
import { Clock, Effect, Schema } from "effect"
import path from "path"
import type { Argv } from "yargs"
import { effectCmd, fail } from "../effect-cmd"

const roles = ["incumbent", "research_executor", "solver", "generator"] as const

const AuthorizeCommand = effectCmd({
  command: "authorize",
  describe: "locally authorize a seed and freeze its task-pareto protocol; no improvement is claimed",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("scope", { type: "string", demandOption: true, describe: "new strategy scope" })
      .option("protocol", { type: "string", demandOption: true, describe: "frozen evaluation protocol JSON file" })
      .option("bundle", { type: "string", demandOption: true, describe: "strategy bundle JSON file" }),
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
  describe: "resolve a role's execution authorization without adding a result-evidence dependency",
  instance: false,
  builder: (yargs) =>
    yargs.positional("scope", { type: "string", demandOption: true, describe: "strategy scope" }).option("role", {
      choices: roles,
      demandOption: true,
      describe: "execution role (solver/generator are aliases)",
    }),
  handler: Effect.fn("Cli.contract.strategy.bind")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    console.log(JSON.stringify(yield* policies.bind({ scope: args.scope, role: args.role }), null, 2))
  }),
})

const ProposeCommand = effectCmd({
  command: "propose",
  describe: "issue an ordinary promotion Contract for an exact generated strategy.json handoff",
  instance: false,
  builder: withCandidate,
  handler: Effect.fn("Cli.contract.strategy.propose")(function* (args) {
    const bundle = yield* readJson(args.bundle, ProContractPolicy.Bundle)
    const generation = yield* readJson(args.generation, ProContractPolicy.Generation)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const contract = yield* policies.propose({
      scope: args.scope,
      expectedRevision: args["expected-revision"],
      bundle,
      generation,
      targetVersion: args["target-version"],
      now,
    })
    console.log(JSON.stringify(ProContract.info(contract), null, 2))
  }),
})

const ArchiveCommand = effectCmd({
  command: "archive",
  describe: "retain an exact generated candidate without requesting formal adoption",
  instance: false,
  builder: withCandidate,
  handler: Effect.fn("Cli.contract.strategy.archive")(function* (args) {
    const bundle = yield* readJson(args.bundle, ProContractPolicy.Bundle)
    const generation = yield* readJson(args.generation, ProContractPolicy.Generation)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const state = yield* policies.archiveCandidate({
      scope: args.scope,
      expectedRevision: args["expected-revision"],
      bundle,
      generation,
      targetVersion: args["target-version"],
      now,
    })
    console.log(JSON.stringify(state, null, 2))
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

const SelectResearchCommand = effectCmd({
  command: "select-research",
  describe: "authorize an archived candidate to conduct research without adopting it for service",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .option("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("bundle-hash", { type: "string", demandOption: true, describe: "exact archived strategy bundle hash" })
      .option("qualification", {
        type: "string",
        describe: "independent research-use qualification JSON file, not deployment evidence",
      }),
  handler: Effect.fn("Cli.contract.strategy.selectResearch")(function* (args) {
    const qualification =
      args.qualification === undefined
        ? undefined
        : yield* readJson(args.qualification, ProContractPolicy.Qualification)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const state = yield* policies.selectResearch({
      scope: args.scope,
      expectedRevision: args.expectedRevision,
      bundleHash: args.bundleHash,
      qualification,
      now,
    })
    console.log(JSON.stringify(state, null, 2))
  }),
})

const RecordExperimentCommand = effectCmd({
  command: "record-experiment",
  describe: "retain a source-bound experiment, including negative or inconclusive outcomes",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .option("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("experiment", { type: "string", demandOption: true, describe: "experiment record JSON file" }),
  handler: Effect.fn("Cli.contract.strategy.recordExperiment")(function* (args) {
    const experiment = yield* readJson(args.experiment, ProContractPolicy.Experiment)
    const policies = yield* ProContractPolicy.Service
    const state = yield* policies.recordExperiment({
      scope: args.scope,
      expectedRevision: args.expectedRevision,
      experiment,
    })
    console.log(JSON.stringify(state, null, 2))
  }),
})

const CompleteResearchCommand = effectCmd({
  command: "complete-research",
  describe: "locally accept an exact research handoff and retain its experiment without granting deployment",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .option("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("generation", { type: "string", demandOption: true, describe: "exact research handoff JSON file" })
      .option("experiment", {
        type: "string",
        demandOption: true,
        describe: "experiment record and evidence hash JSON file",
      }),
  handler: Effect.fn("Cli.contract.strategy.completeResearch")(function* (args) {
    const generation = yield* readJson(args.generation, ProContractPolicy.Generation)
    const experiment = yield* readJson(args.experiment, ProContractPolicy.Experiment)
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const result = yield* policies.completeResearch({
      scope: args.scope,
      expectedRevision: args.expectedRevision,
      generation,
      experiment,
      now,
    })
    console.log(JSON.stringify({ ...result, contract: ProContract.info(result.contract) }, null, 2))
  }),
})

const ViewCommand = effectCmd({
  command: "view <scope>",
  describe: "read only the explicitly selected archived versions and experiments",
  instance: false,
  builder: (yargs) =>
    yargs
      .version(false)
      .positional("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("version", { type: "array", string: true, default: [], describe: "archived bundle hashes" })
      .option("experiment", { type: "array", string: true, default: [], describe: "archived experiment IDs" }),
  handler: Effect.fn("Cli.contract.strategy.view")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    const view = yield* policies.view({
      scope: args.scope,
      versionHashes: args.version,
      experimentIDs: args.experiment,
    })
    console.log(JSON.stringify(view, null, 2))
  }),
})

const RollbackCommand = effectCmd({
  command: "rollback <scope>",
  describe: "locally select the previous strategy with standing Contract support",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .positional("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("role", { choices: roles, default: "incumbent" as const, describe: "role to roll back" }),
  handler: Effect.fn("Cli.contract.strategy.rollback")(function* (args) {
    const policies = yield* ProContractPolicy.Service
    const now = yield* Clock.currentTimeMillis
    const state = yield* policies.rollback({
      scope: args.scope,
      expectedRevision: args.expectedRevision,
      role: args.role,
      now,
    })
    console.log(JSON.stringify(state, null, 2))
  }),
})

const RevokeCommand = effectCmd({
  command: "revoke <scope>",
  describe: "locally withdraw a role's execution authorization without invalidating independent results",
  instance: false,
  builder: (yargs) =>
    withRevision(yargs)
      .positional("scope", { type: "string", demandOption: true, describe: "strategy scope" })
      .option("role", {
        choices: roles,
        default: "incumbent" as const,
        describe: "role whose authorization is withdrawn",
      })
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
      role: args.role,
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
      .command(ArchiveCommand)
      .command(ProposeCommand)
      .command(SettleCommand)
      .command(SelectResearchCommand)
      .command(RecordExperimentCommand)
      .command(CompleteResearchCommand)
      .command(ViewCommand)
      .command(RollbackCommand)
      .command(RevokeCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.contract.strategy")(function* () {}),
})

function withCandidate(yargs: Argv) {
  return withRevision(yargs)
    .option("scope", { type: "string", demandOption: true, describe: "strategy scope" })
    .option("bundle", { type: "string", demandOption: true, describe: "generated strategy bundle JSON file" })
    .option("target-version", {
      type: "string",
      describe: "bundle hash modified by this research, not its executor",
    })
    .option("generation", {
      type: "string",
      demandOption: true,
      describe:
        "JSON file containing the generation Contract's exact contractID, revision, subjectHash, and optional runID",
    })
}

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
