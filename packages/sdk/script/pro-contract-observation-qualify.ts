#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ProContract } from "@opencode/schema/pro-contract"
import { ProContractRSI } from "../src/pro-contract"
import { ProContractTask } from "../src/pro-contract/task"
import { ContractEnvironment } from "../src/pro-contract/environment"
import { continuation, observationFixture, recovered } from "../test/pro-contract/observation-wire"

const taskOnly = process.argv.includes("--task-only")
const cli = process.argv.includes("--cli")
const unrelated = Number(process.env.PROCONTRACT_QUALIFY_WARMUP ?? 26)
if (!Number.isSafeInteger(unrelated) || unrelated < 26)
  throw new Error("Observation qualification needs at least 26 actual unrelated shells")
const [root, release, bun = process.execPath, environmentFile] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--task-only" && arg !== "--cli")
if (!root || !release)
  throw new Error(
    "Usage: bun script/pro-contract-observation-qualify.ts NEW_ROOT FROZEN_RELEASE [BUN] [ENVIRONMENT_JSON]",
  )
await fs.mkdir(root, { mode: 0o700 })
const environment = environmentFile
  ? Schema.decodeUnknownSync(ContractEnvironment.Input)(await Bun.file(environmentFile).json())
  : undefined

// The successor receives no marker, hash or path from the scripted provider. It must
// locate the prior native command and recover the untranscoded bytes from the archive.
const repairFeedback = "PUBLIC_ACCEPTANCE_REPAIR_REQUIRED"
const recover = `python3 - <<'PY'
import base64, errno, hashlib, json, pathlib, socket
root = pathlib.Path('/admission/observations')
rows = [json.loads(line) for line in (root / 'index.jsonl').read_text().splitlines()]
def blob(row):
    value = (root / 'blobs' / row['hash']).read_bytes()
    assert len(value) == row['bytes']
    assert hashlib.sha256(value).hexdigest() == row['hash']
    return value
native = [(row, json.loads(blob(row))) for row in rows if row['kind'] == 'native-result']
origin = [row for row, value in native if value['input'].get('command', '').startswith("python3 - <<'PY'\\nimport base64, os\\n")]
assert len(origin) == 1
native = [(row, value) for row, value in native if row['sessionID'] == origin[0]['sessionID']]
def called(fragment):
    found = [(row, value) for row, value in native if fragment in value['input'].get('command', '')]
    assert len(found) == 1, (fragment, len(found))
    return found[0]
def capture(row):
    found = [item for item in rows if item['kind'] == 'shell-capture' and item['callID'] == row['callID']]
    assert len(found) == 1
    return found[0]
original, result = called('base64.b64decode')
assert result['status'] == 'completed'
saved = capture(original)
assert saved['capture']['stream'] == 'combined'
assert saved['capture']['encoding'] == 'bytes'
assert saved['capture']['complete'] is True
assert saved['capture']['timeout'] is False
assert saved['capture']['exit'] == 0
value = blob(saved)
assert saved['capture']['totalBytes'] == len(value) > 50 * 1024
marker = value.split(b'\\n', 1)[0]
assert marker.startswith(b'OBS_COUNTEREXAMPLE_')
assert marker not in value[-50 * 1024:]
assert '公共观测🧪'.encode() in value
assert bytes([0, 255, 254, 10]) in value
display = [row for row in rows if row['kind'] == 'model-visible' and row['callID'] == original['callID']]
assert len(display) == 1
assert marker not in blob(display[0])
nonzero = capture(called('OBS_EXPECTED_NONZERO')[0])['capture']
assert nonzero['complete'] is True and nonzero['exit'] == 7 and nonzero['timeout'] is False
timeout = capture(called('OBS_EXPECTED_TIMEOUT')[0])['capture']
assert timeout['complete'] is False and timeout['timeout'] is True
signal = capture(called('OBS_EXPECTED_SIGNAL')[0])['capture']
assert signal['complete'] is False and signal['signal'] == 'SIGKILL'
missing = [(row, item) for row, item in native if item['input'].get('path', '').endswith('intentionally-missing-observation-test.txt')]
assert len(missing) == 1 and missing[0][1]['status'] == 'error'
failed = [row for row in rows if row['kind'] == 'model-visible' and row['callID'] == missing[0][0]['callID']]
assert len(failed) == 1 and b'error' in blob(failed[0])
session = json.loads(pathlib.Path('/state/identity.json').read_text())['sessionID']
assert original['sessionID'] != session
assert len(set(row['sessionID'] for row in rows)) == (2 if pathlib.Path('/workspace/answer.txt').exists() else 1)
assert sorted(item.name for item in pathlib.Path('/workspace').iterdir()) in [['task.txt'], ['answer.txt', 'task.txt']]
readonly = []
for file in [root / 'index.jsonl', root / 'blobs' / saved['hash'], root / 'cannot-create']:
    try:
        with file.open('ab') as output:
            output.write(b'archive must never be writable')
    except OSError as error:
        assert error.errno in [errno.EROFS, errno.EACCES, errno.EPERM], error
        readonly.append(str(file))
    else:
        raise AssertionError('Observation archive was writable: ' + str(file))
peer = socket.socket(socket.AF_UNIX)
peer.settimeout(5)
peer.connect('/channel/provider.sock')
metadata = base64.b64encode(json.dumps(dict(kind='native-result', sessionID=session, messageID='foreign', callID='foreign', tool='shell')).encode())
peer.sendall(b'POST /v1/observations HTTP/1.0\\r\\nContent-Length: 0\\r\\nX-Observation: ' + metadata + b'\\r\\n\\r\\n')
assert b'403' in peer.recv(4096)
peer.close()
pathlib.Path('/workspace/answer.txt').write_bytes(marker + b'\\n')
print('${recovered} ' + json.dumps(dict(hash=saved['hash'], bytes=len(value), previousSession=original['sessionID'], session=session, readonly=readonly, timeoutHonest=True, errorHonest=True)))
PY`
const wire = observationFixture(
  recover,
  taskOnly
    ? { feedback: repairFeedback, command: recover + "\nprintf 'repaired\\n' > /workspace/acknowledged.txt" }
    : undefined,
  unrelated,
)
const initial = path.join(root, "input")
const verifier = path.join(root, "verifier")
await fs.mkdir(initial)
await fs.mkdir(verifier)
await Bun.write(path.join(initial, "task.txt"), "Public observation-continuity mechanics task.\n")
await Bun.write(
  path.join(verifier, "judge.py"),
  `import json,pathlib\ns=pathlib.Path('/workspace/answer.txt').read_text()\np=int(s==${JSON.stringify(wire.marker + "\n")})\n` +
    (taskOnly
      ? `ack=pathlib.Path('/workspace/acknowledged.txt')\np+=int(ack.exists() and ack.read_text()=='repaired\\n')\nprint(json.dumps(dict(passed=p,total=2,valid=True,feedback='${repairFeedback}: retain the answer and write repaired followed by a newline in acknowledged.txt.')))\n`
      : "print(json.dumps(dict(passed=p,total=1,valid=True)))\n"),
)
const config: ProContractRSI.Configuration = {
  runtime: { directory: release, bun, python: "/usr/bin/python3", bwrap: "/usr/bin/bwrap" },
  model: { id: "scripted", effort: "max", upstream: wire.url },
  seed: process.env.PROCONTRACT_QUALIFY_METHOD
    ? Schema.decodeUnknownSync(Schema.Struct({ instructions: Schema.NonEmptyString }))(
        await Bun.file(process.env.PROCONTRACT_QUALIFY_METHOD).json(),
        { onExcessProperty: "error" },
      )
    : { instructions: "Retain public evidence across checkpoints without confusing observations with acceptance." },
  proposals: 0,
  tests: (["safety", "development", "confirmation"] as const).map((panel) => ({
    id: panel,
    panel,
    repeats: panel === "safety" ? 1 : 2,
    total: 1,
    goal: "Unused frozen panel: this qualification does not propose or compare methods.",
    directory: initial,
    verifier: { directory: verifier, command: ["/usr/bin/python3", "/verifier/judge.py"] },
  })),
}
const deadline = Date.now() + 15 * 60 * 1000
const task: ProContractRSI.Task = {
  id: ProContract.ID.make("pct_observation_continuity"),
  goal:
    "OBS_CONTINUITY_ORIGINAL: recover the first line of the original public shell output after checkpoint and submit it as answer.txt." +
    (taskOnly ? " Also retain the repair acknowledgement as acknowledged.txt, containing repaired and a newline." : ""),
  directory: initial,
  total: taskOnly ? 2 : 1,
  deadline,
  verifier: { directory: verifier, command: ["/usr/bin/python3", "/verifier/judge.py"] },
  ...(environment ? { environment } : {}),
}
const profile = taskOnly ? { runtime: config.runtime, model: config.model, method: config.seed } : config
await Bun.write(path.join(root, "PROFILE.json"), JSON.stringify(profile, null, 2))
await Bun.write(path.join(root, "TASK.json"), JSON.stringify(task, null, 2))
const host =
  "method" in profile
    ? await ProContractTask.open(path.join(root, "campaign"), profile)
    : await ProContractRSI.open(path.join(root, "campaign"), profile)
try {
  const result = cli
    ? await (async () => {
        const child = Bun.spawn(
          [
            bun,
            path.join(release, "packages/cli/src/index.ts"),
            "contract",
            "run",
            path.join(root, "campaign"),
            "--profile",
            path.join(root, "PROFILE.json"),
            "--task",
            path.join(root, "TASK.json"),
          ],
          {
            cwd: path.join(release, "packages/cli"),
            env: {
              PATH: "/usr/bin:/bin",
              HOME: path.join(root, "cli-home"),
              XDG_DATA_HOME: path.join(root, "cli-data"),
              XDG_CONFIG_HOME: path.join(root, "cli-config"),
              XDG_CACHE_HOME: path.join(root, "cli-cache"),
              XDG_STATE_HOME: path.join(root, "cli-state"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await Bun.write(path.join(root, "CLI.json"), JSON.stringify({ code, stdout, stderr }))
        if (code !== 0) throw new Error(`Frozen native CLI failed: ${stderr}`)
        return Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ contract: Schema.Struct({ status: Schema.String }) })),
        )(stdout)
      })()
    : await host.run(task)
  if (result.contract.status !== "discharged") throw new Error("Independent final byte verification did not pass")
  if (wire.records.length !== unrelated + (taskOnly ? 10 : 8))
    throw new Error("Unexpected native observation qualification request schedule")
  const state = host.store.read()
  if (taskOnly && (!("kind" in state.protocol) || state.protocol.kind !== "task"))
    throw new Error("Task-only qualification admitted a research protocol")
  if (
    taskOnly &&
    wire.records.some((record) => {
      const handoff = record.request.tools.find((tool) => tool.name.endsWith("contract_handoff"))
      return !handoff?.parameters || JSON.stringify(handoff.parameters).includes('"propose"')
    })
  )
    throw new Error("Actual native tool schema exposed method research in a task-only allocation")
  if (state.compared.length || state.kernel.contracts[task.id].spec.budget.deadline !== deadline)
    throw new Error("Observation continuity changed policy authority or the original deadline")
  const ids = await fs.readdir(path.join(root, "campaign", "executions"))
  if (ids.length !== (taskOnly ? 3 : 2)) throw new Error("Qualification has an unexpected fresh execution count")
  const execution = await Promise.all(
    ids.map(async (id) => {
      const directory = path.join(root, "campaign", "executions", id)
      const handoff = Schema.decodeUnknownSync(Schema.Struct({ action: Schema.String, summary: Schema.String }))(
        await Bun.file(path.join(directory, "state", "result.json")).json(),
      )
      const identity = Schema.decodeUnknownSync(Schema.Struct({ sessionID: Schema.String }))(
        await Bun.file(path.join(directory, "state", "identity.json")).json(),
      )
      const fence = Schema.decodeUnknownSync(Schema.Struct({ deadline: Schema.Number, acknowledged: Schema.Boolean }))(
        await Bun.file(path.join(directory, "FENCED.json")).json(),
      )
      const admission = Schema.decodeUnknownSync(
        Schema.Struct({ deadline: Schema.Number, feedback: Schema.Array(Schema.String) }),
      )(await Bun.file(path.join(directory, "admission", "input.json")).json())
      const workspace = (await fs.readdir(path.join(directory, "workspace"))).sort()
      if (!fence.acknowledged || fence.deadline !== deadline || admission.deadline !== deadline)
        throw new Error("Execution fence or admission failed to preserve the original deadline")
      if (admission.feedback.some((value) => value.includes(wire.marker)))
        throw new Error("Checkpoint summary leaked the counterexample instead of recovering it")
      return { id, directory, handoff, sessionID: identity.sessionID, fence, workspace }
    }),
  )
  const first = execution.find((item) => item.handoff.action === "checkpoint")
  const second = execution.find((item) => item.handoff.action === "submit" && item.workspace.includes("answer.txt"))
  if (!first || !second || first.sessionID === second.sessionID || first.handoff.summary !== continuation)
    throw new Error("Fresh native Session continuation was not established")
  if (
    JSON.stringify(first.workspace) !== '["task.txt"]' ||
    !execution.some((item) => JSON.stringify(item.workspace) === '["answer.txt","task.txt"]') ||
    (taskOnly &&
      !execution.some((item) => JSON.stringify(item.workspace) === '["acknowledged.txt","answer.txt","task.txt"]'))
  )
    throw new Error("Observation logs were injected into the task workspace")
  if (
    taskOnly &&
    (!state.tasks[task.id].feedback.some((text) => text.startsWith(repairFeedback)) ||
      wire.records.filter((record) => record.repairing).length !== 2)
  )
    throw new Error("Independent negative evidence did not cause same-task public repair")
  if (
    wire.records
      .filter((item) => item.continued && item.step === 0)
      .some((item) => JSON.stringify(item.request).includes(wire.marker))
  )
    throw new Error("A successor received the counterexample before reading the observation archive")
  const lineages = await fs.readdir(path.join(root, "campaign", "observations"))
  if (lineages.length !== 1) throw new Error("Original task checkpoint changed observation lineage")
  const archive = path.join(root, "campaign", "observations", lineages[0])
  const records = (await Bun.file(path.join(archive, "index.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) =>
      Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ kind: Schema.String, hash: Schema.String, callID: Schema.String })),
      )(line),
    )
  const native = records.find((row) => row.kind === "native-result" && row.callID === "call_observation_1")
  if (!native) throw new Error("Missing original native result")
  const file = (await Bun.file(path.join(archive, "blobs", native.hash)).text()).match(
    /full output saved to (\/state\/[^\s\\\]"]+)/,
  )?.[1]
  if (!file || (await Bun.file(path.join(first.directory, file.slice(1))).exists()))
    throw new Error("Original native shell file was not demonstrably evicted by the 26 unrelated shells")
  const hash = Bun.SHA256.hash(wire.bytes, "hex")
  const saved = await Bun.file(path.join(archive, "blobs", hash)).bytes()
  if (Buffer.compare(wire.bytes, saved) !== 0) throw new Error("Unicode, NUL or non-UTF-8 bytes were changed")
  const report = {
    kind: "deterministic-native-observation-continuity-e2e",
    realModel: false,
    performanceClaim: false,
    taskOnly,
    cli,
    comparisons: state.compared.length,
    publicRepairFeedbackRetained:
      taskOnly && state.tasks[task.id].feedback.some((text) => text.startsWith(repairFeedback)),
    ...(environment ? { taskEnvironment: environment } : {}),
    result,
    deadline,
    sessions: execution.map((item) => item.sessionID),
    physicalRequests: wire.records.length,
    unrelatedShells: unrelated,
    rawBytes: wire.bytes.length,
    hash,
    originalShellFileEvicted: true,
    readOnlyArchive: true,
    nativeTimeoutAndErrorRetained: true,
    signalKillIsIncomplete: true,
    summaryContainsCounterexample: false,
    workspaceContainsObservationLogs: false,
    originalLineage: lineages[0],
    execution,
  }
  await Bun.write(path.join(root, "RESULT.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await Bun.write(path.join(root, "WIRE.json"), JSON.stringify(wire.records))
  host.close()
  wire.server.stop(true)
}
