/** Frozen cohort entrypoint. Imports only the release named by the frozen input;
 * no retries, implicit recovery, or private-score feedback to the solver. */
import fs from "node:fs/promises"
import path from "node:path"
import { Endpoint } from "./endpoint"

const root = import.meta.dir
const [id, rawDeadline] = process.argv.slice(2)
if (!id || !/^[0-8]-[a-z][a-z0-9]{0,15}-r[12]$/.test(id)) throw new Error("Invalid frozen assignment")
const directory = path.join(root, "runs", id)
const protocol = (await Bun.file(path.join(root, "PROTOCOL.json")).json()) as {
  cohortToken: string
  assignments: Endpoint.Assignment[]
}
const frozen = (await Bun.file(path.join(root, "FROZEN.json")).json()) as { sdkDirectory: string }
if (!path.isAbsolute(frozen.sdkDirectory) || (await fs.realpath(frozen.sdkDirectory)) !== frozen.sdkDirectory)
  throw new Error("Frozen SDK directory must be canonical")
const assignment = protocol.assignments.find((item) => item.id === id)
if (!assignment) throw new Error("Unassigned allocation")
const admission = (await Bun.file(path.join(directory, "ADMISSION.json")).json()) as Endpoint.Admission
const deadline = Number(rawDeadline)
if (
  admission.version !== 1 ||
  admission.id !== id ||
  admission.cohortRoot !== root ||
  admission.cohortToken !== protocol.cohortToken ||
  admission.cohortToken !== process.env.PROCONTRACT_COHORT_TOKEN ||
  admission.admissionID !== process.env.PROCONTRACT_ADMISSION_ID ||
  id !== process.env.PROCONTRACT_ALLOCATION_ID ||
  !Number.isSafeInteger(deadline) ||
  deadline !== admission.deadline ||
  deadline !== admission.started + 21600000 ||
  admission.started > Date.now() ||
  deadline <= Date.now()
)
  throw new Error("Conflicting or expired original admission")
for (const reference of [assignment.profile, assignment.task]) {
  if (Bun.SHA256.hash(await Bun.file(reference.path).bytes(), "hex") !== reference.sha256)
    throw new Error("Frozen input changed")
}
// The entrypoint is copied unchanged; freeze pins sdkDirectory and all release
// files. Dynamic imports do not require path substitution in frozen code.
const { Schema } = await import(path.join(frozen.sdkDirectory, "packages/sdk/node_modules/effect/dist/index.js"))
const { ProContractRSI } = await import(path.join(frozen.sdkDirectory, "packages/sdk/src/pro-contract/index.ts"))
const { ProContractTask } = await import(path.join(frozen.sdkDirectory, "packages/sdk/src/pro-contract/task.ts"))
const { ContractResources } = await import(path.join(frozen.sdkDirectory, "packages/sdk/src/pro-contract/resources.ts"))
const profile = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([ProContractTask.Configuration, ProContractRSI.Configuration])),
)(await Bun.file(assignment.profile.path).text(), { onExcessProperty: "error" })
const original = Schema.decodeUnknownSync(Schema.fromJsonString(ProContractRSI.Task))(
  await Bun.file(assignment.task.path).text(),
  { onExcessProperty: "error" },
)
if (
  profile.runtime.directory !== frozen.sdkDirectory ||
  !("programbench" in original.verifier) ||
  original.verification !== "terminal" ||
  original.verifier.programbench.instance !== assignment.instance
)
  throw new Error("Frozen runtime or task placement differs")
const resources = await ContractResources.enter({ hostBytes: 2147483648, toolBytes: 6442450944 })
const task = { ...original, deadline }
await Bun.write(
  path.join(directory, "ADMITTED.json"),
  JSON.stringify(
    {
      id,
      admissionID: admission.admissionID,
      task,
      profile: assignment.profile,
      taskReference: assignment.task,
      started: admission.started,
      deadline,
      resources,
    },
    null,
    2,
  ),
)
const abort = new AbortController()
const host =
  "method" in profile
    ? await ProContractTask.open(path.join(directory, "campaign"), profile)
    : await ProContractRSI.open(path.join(directory, "campaign"), profile)
const stop = () => abort.abort(new Error("Explicit cohort cancellation"))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
const timer = setInterval(async () => {
  if (await Bun.file(path.join(root, "CANCEL")).exists()) stop()
}, 200)
const failure: { message?: string } = {}
try {
  await host.run(task, { signal: abort.signal })
} catch (error) {
  failure.message = String(error)
  await Bun.write(
    path.join(directory, "FAILURE.json"),
    JSON.stringify(
      {
        id,
        error: failure.message,
        deadline,
        finished: Date.now(),
        ledger: path.join(directory, "campaign", "ledger.sqlite"),
      },
      null,
      2,
    ),
  )
} finally {
  clearInterval(timer)
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
}
const state = host.store.read()
if (
  "method" in profile &&
  (!("kind" in state.protocol) ||
    state.compared.length ||
    Object.keys(state.proposals).length ||
    state.active.hash !== state.seed)
)
  throw new Error("Fixed-task execution admitted method research or changed the frozen method")
host.close()
const result = await Endpoint.finish({
  directory,
  admission,
  assignment,
  task,
  aborted: abort.signal.aborted,
  hostError: failure.message,
  checkpoint: state.tasks[task.id]?.checkpoint,
  summary: {
    contract: state.kernel.contracts[task.id]?.status ?? "missing",
    proposals: Object.keys(state.proposals).length,
    comparisons: state.compared.length,
    selectedMethod: state.active.hash,
    seedMethod: state.seed,
  },
})
console.log(JSON.stringify({ id, outcome: result.endpoint.outcome, score: result.result.score }))
if (result.endpoint.outcome !== "scored") process.exitCode = 1
