import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Clock, Effect } from "effect"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import path from "path"
import type { Argv } from "yargs"
import { effectCmd, fail } from "../effect-cmd"

const IssueCommand = effectCmd({
  command: "issue",
  describe: "issue an outstanding contract",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("id", { type: "string", describe: "contract ID" })
      .option("scope", { type: "string", demandOption: true, describe: "quiescence scope" })
      .option("goal", { type: "string", demandOption: true, describe: "optimization objective" })
      .option("execution-policy", { type: "string", describe: "exact policy offered to future Contracts" })
      .option("claim", { type: "string", describe: "exact proposition the evidence may settle" })
      .option("brief", { type: "string", describe: "context for the future executor" })
      .option("require", { type: "array", string: true, describe: "required Contract as ID@revision" })
      .option("model", { type: "string", demandOption: true, describe: "execution model as provider/model" })
      .option("variant", { type: "string", describe: "model variant" })
      .option("write", { type: "boolean", describe: "allow workspace changes and process execution" })
      .option("turns", { type: "number", describe: "maximum provider turns" })
      .option("at", { type: "string", describe: "activation time as an ISO timestamp" }),
  handler: Effect.fn("Cli.contract.issue")(function* (args) {
    const activateAt = args.at ? Date.parse(args.at) : undefined
    if (activateAt !== undefined && !Number.isFinite(activateAt))
      return yield* fail(`Invalid activation time: ${args.at}`)
    if (args.turns !== undefined && (!Number.isInteger(args.turns) || args.turns <= 0))
      return yield* fail(`Invalid turn budget: ${args.turns}`)
    const contracts = yield* ProContract.Service
    const bindings = yield* ProContractOpenCode.Service
    const now = yield* Clock.currentTimeMillis
    const id = args.id ? ProContract.ID.make(args.id) : ProContract.ID.create()
    const model = ModelV2.parse(args.model)
    const base = (yield* contracts.get(id))?.spec ?? ProContract.defaultSpec(args.goal, now)
    const requires = yield* Effect.forEach(args.require ?? [], (value) => {
      if (typeof value !== "string") return fail("Invalid required Contract")
      const match = /^(pct_.+)@([1-9]\d*)$/.exec(value)
      if (!match) return fail(`Invalid required Contract: ${value}`)
      return Effect.succeed({ contractID: ProContract.ID.make(match[1]), revision: Number(match[2]) })
    })
    const spec = {
      ...base,
      goal: args.goal,
      policy: args.executionPolicy ?? base.policy,
      brief: args.brief ?? base.brief,
      requires: args.require === undefined ? base.requires : requires,
      authority: args.write ? (["filesystem.read", "filesystem.write", "process.execute"] as const) : base.authority,
      budget: args.turns === undefined ? base.budget : { ...base.budget, turns: args.turns },
      evidence: args.claim === undefined ? base.evidence : { ...base.evidence, claim: args.claim },
      trigger: activateAt === undefined ? base.trigger : { type: "time" as const, at: activateAt },
    }
    const executionModel = ModelV2.Ref.make({
      providerID: model.providerID,
      id: model.modelID,
      variant: args.variant ? ModelV2.VariantID.make(args.variant) : undefined,
    })
    const receipt = yield* bindings.issue({
      id,
      scope: args.scope,
      spec,
      location: { directory: AbsolutePath.make(process.cwd()) },
      model: executionModel,
      now,
    })
    if (receipt.decision.type === "rejected") return yield* fail(receipt.decision.reason)
    const contract = receipt.contract
    if (!contract) return yield* Effect.die("Accepted contract was not loaded")
    const execution = receipt.execution
    if (!execution) return yield* Effect.die("Accepted contract execution was not created")
    if (
      execution.location.directory !== process.cwd() ||
      execution.model.providerID !== executionModel.providerID ||
      execution.model.id !== executionModel.id ||
      execution.model.variant !== executionModel.variant
    )
      return yield* fail("Contract execution binding does not match")
    console.log(JSON.stringify({ contract: ProContract.info(contract), execution }, null, 2))
    return undefined
  }),
})

const PolicyCommand = effectCmd({
  command: "policy [contractID]",
  describe: "select an evidenced Contract as the default execution policy",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("contractID", { type: "string", describe: "discharged Policy Contract ID" })
      .option("clear", { type: "boolean", default: false, describe: "remove the default execution policy" })
      .option("config", { type: "string", default: "opencode.json", describe: "location configuration file" }),
  handler: Effect.fn("Cli.contract.policy")(function* (args) {
    if (args.clear === (args.contractID !== undefined)) return yield* fail("Provide one Policy Contract ID or --clear")
    const file = path.resolve(args.config)
    const source = (yield* Effect.promise(() => Bun.file(file).exists()))
      ? yield* Effect.promise(() => Bun.file(file).text())
      : "{}"
    const errors: ParseError[] = []
    parse(source, errors, { allowTrailingComma: true })
    if (errors.length) return yield* fail(`Invalid JSONC configuration: ${file}`)
    if (args.clear) {
      yield* Effect.promise(() =>
        Bun.write(
          file,
          applyEdits(
            source,
            modify(source, ["contract_policy"], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
          ),
        ),
      )
      console.log(JSON.stringify({ config: file, policy: null }, null, 2))
      return
    }
    const contractID = ProContract.ID.make(args.contractID)
    const contracts = yield* ProContract.Service
    const contract = yield* contracts.get(contractID)
    if (!contract) return yield* fail(`Contract not found: ${contractID}`)
    if (contract.status !== "discharged" || !contract.spec.policy || !contract.attestationID || !contract.handoff)
      return yield* fail(`Policy Contract is not evidenced: ${contractID}`)
    const attestation = yield* contracts.getAttestation(contract.attestationID)
    if (!attestation) return yield* fail(`Policy attestation not found: ${contract.attestationID}`)
    const policy = { contractID, revision: contract.revision, policy: true as const }
    yield* Effect.promise(() =>
      Bun.write(
        file,
        applyEdits(
          source,
          modify(source, ["contract_policy"], policy, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        ),
      ),
    )
    console.log(
      JSON.stringify(
        {
          config: file,
          policy,
          policyText: contract.spec.policy,
          specHash: contract.specHash,
          subjectHash: attestation.subjectHash,
          evidenceHash: attestation.evidenceHash,
          attestationID: attestation.id,
        },
        null,
        2,
      ),
    )
  }),
})

const ListCommand = effectCmd({
  command: "list",
  describe: "list contracts",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("scope", { type: "string", describe: "filter by quiescence scope" })
      .option("format", { type: "string", choices: ["table", "json"], default: "table" }),
  handler: Effect.fn("Cli.contract.list")(function* (args) {
    const contracts = (yield* ProContract.Service.use((service) => service.list(args.scope))).map(ProContract.info)
    if (args.format === "json") {
      console.log(JSON.stringify(contracts, null, 2))
      return
    }
    if (contracts.length === 0) return
    console.log("Contract ID\tStatus\tScope\tGoal")
    for (const contract of contracts)
      console.log(`${contract.id}\t${contract.status}\t${contract.scope}\t${contract.spec.goal}`)
  }),
})

const ShowCommand = effectCmd({
  command: "show <contractID>",
  describe: "show one contract",
  instance: false,
  builder: (yargs) => yargs.positional("contractID", { type: "string", demandOption: true, describe: "contract ID" }),
  handler: Effect.fn("Cli.contract.show")(function* (args) {
    const contract = yield* ProContract.Service.use((service) => service.get(ProContract.ID.make(args.contractID)))
    if (!contract) return yield* fail(`Contract not found: ${args.contractID}`)
    console.log(JSON.stringify(ProContract.info(contract), null, 2))
    return undefined
  }),
})

const ExportCommand = effectCmd({
  command: "export <contractID> <directory>",
  describe: "materialize the exact contract handoff",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("contractID", { type: "string", demandOption: true, describe: "contract ID" })
      .positional("directory", { type: "string", demandOption: true, describe: "new output directory" }),
  handler: Effect.fn("Cli.contract.export")(function* (args) {
    const contractID = ProContract.ID.make(args.contractID)
    const contract = yield* ProContract.Service.use((service) => service.get(contractID))
    if (!contract) return yield* fail(`Contract not found: ${contractID}`)
    const handoff = contract.handoff
    if (!handoff) return yield* fail(`Contract has no current handoff: ${contractID}`)
    const binding = yield* ProContractOpenCode.Service.use((service) => service.get(contractID))
    if (!binding) return yield* fail(`OpenCode execution not found: ${contractID}`)
    const directory = AbsolutePath.make(path.resolve(args.directory))
    yield* Snapshot.Service.use((service) =>
      service.materialize({ snapshot: Snapshot.ID.make(handoff.subjectHash), directory }),
    ).pipe(
      Effect.provide(LocationServiceMap.Service.get(binding.location)),
      Effect.provide(buildLocationServiceMap()),
      Effect.catchTag("Snapshot.Error", (error) => fail(error.message)),
    )
    console.log(JSON.stringify({ contractID, subjectHash: handoff.subjectHash, directory }, null, 2))
  }),
})

const QuietCommand = effectCmd({
  command: "quiet <scope>",
  describe: "check whether a scope has outstanding contracts",
  instance: false,
  builder: (yargs) => yargs.positional("scope", { type: "string", demandOption: true, describe: "scope" }),
  handler: Effect.fn("Cli.contract.quiet")(function* (args) {
    const result = yield* ProContract.Service.use((service) => service.quiet(args.scope))
    console.log(JSON.stringify(result, null, 2))
    if (!result.quiet) return yield* fail(`${result.outstanding.length} contract(s) remain outstanding`, 2)
    return undefined
  }),
})

const ReleaseCommand = effectCmd({
  command: "release <contractID>",
  describe: "explicitly release a contract",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("contractID", { type: "string", demandOption: true, describe: "contract ID" })
      .option("reason", { type: "string", demandOption: true, describe: "release reason" }),
  handler: Effect.fn("Cli.contract.release")(function* (args) {
    const receipt = yield* ProContract.Service.use((service) =>
      service.release({ contractID: ProContract.ID.make(args.contractID), reason: args.reason }),
    )
    if (receipt.decision.type === "rejected") return yield* fail(receipt.decision.reason)
    console.log(JSON.stringify({ frontier: receipt.frontier, hash: receipt.hash }, null, 2))
    return undefined
  }),
})

const AttestCommand = effectCmd({
  command: "attest <contractID>",
  describe: "attest evidence and discharge a contract",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("contractID", { type: "string", demandOption: true, describe: "contract ID" })
      .option("evidence-hash", { type: "string", demandOption: true, describe: "evidence hash" }),
  handler: Effect.fn("Cli.contract.attest")(function* (args) {
    const receipt = yield* ProContract.Service.use((service) =>
      service.principalAttest({
        contractID: ProContract.ID.make(args.contractID),
        evidenceHash: args.evidenceHash,
      }),
    )
    if (receipt.decision.type === "rejected") return yield* fail(receipt.decision.reason)
    console.log(JSON.stringify({ frontier: receipt.frontier, hash: receipt.hash }, null, 2))
    return undefined
  }),
})

const RevisionDecisionCommand = effectCmd({
  command: "revision <contractID>",
  describe: "accept or reject a pending contract revision",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("contractID", { type: "string", demandOption: true, describe: "contract ID" })
      .option("accept", { type: "boolean", demandOption: true, describe: "accept the pending revision" }),
  handler: Effect.fn("Cli.contract.revision")(function* (args) {
    const contractID = ProContract.ID.make(args.contractID)
    const receipt = yield* ProContract.Service.use((service) =>
      service.decideRevision({ contractID, accept: args.accept }),
    )
    if (receipt.decision.type === "rejected") return yield* fail(receipt.decision.reason)
    console.log(JSON.stringify({ frontier: receipt.frontier, hash: receipt.hash }, null, 2))
    return undefined
  }),
})

const ResumeCommand = effectCmd({
  command: "resume <contractID>",
  describe: "resume an escalated contract",
  instance: false,
  builder: (yargs) => yargs.positional("contractID", { type: "string", demandOption: true, describe: "contract ID" }),
  handler: Effect.fn("Cli.contract.resume")(function* (args) {
    const contractID = ProContract.ID.make(args.contractID)
    const receipt = yield* ProContract.Service.use((service) => service.resume(contractID))
    if (receipt.decision.type === "rejected") return yield* fail(receipt.decision.reason)
    console.log(JSON.stringify({ frontier: receipt.frontier, hash: receipt.hash }, null, 2))
    return undefined
  }),
})

export const ContractCommand = effectCmd({
  command: "contract",
  describe: "manage persistent contracts",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(IssueCommand)
      .command(PolicyCommand)
      .command(ListCommand)
      .command(ShowCommand)
      .command(ExportCommand)
      .command(QuietCommand)
      .command(ReleaseCommand)
      .command(AttestCommand)
      .command(RevisionDecisionCommand)
      .command(ResumeCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.contract")(function* () {}),
})
