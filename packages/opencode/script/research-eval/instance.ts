import { mkdir, open } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import type { ProContractJob } from "@opencode-ai/core/pro-contract/job"
import type { ResearchModel } from "../../../sdk-next/src/research/model"
import { publish, type Packet } from "./corpus"
import { issue, recoveryJobs } from "./driver"
import { digest, duration } from "./ledger"
import { infrastructure, type Infrastructure } from "./infrastructure"
import { hostEvidence } from "./host-evidence"
import { start } from "./host"
import { provider, type Route, type Transport } from "./provider"
import { launcher } from "./isolation"
import { bootstrap, probe, type Bootstrap } from "./probe"
import { monitor } from "./controller"
import { collect, put } from "./archive"
import { stage } from "./accounting"
import { codeIdentity } from "./provenance"
import { active, killAtProcess, processIdentity, testProcess, window, type Observation } from "./observe"

type InstanceInput = {
  mode: "model" | "local-fixture"
  directory: string
  packet: Packet
  entry: "plan" | "final" | "research" | "followup"
  evaluation?: "feedback-v2" | "repair-lifecycle-v1" | "advisory-v3"
  feedbackGuidance?: "closure:1"
  fault?: "provider" | "test_process"
  fixtureFault?: "before_issue"
  routes: Record<"worker" | "reviewer", Route>
  limits: Record<"worker" | "reviewer", { context: number; output: number }>
  timeouts: { provider: number; verification: number; cleanup: number }
  bun: string
  node: string
  signal: AbortSignal
  frozenCode?: string
  infrastructure?: Infrastructure
}

export async function runInstance(input: InstanceInput) {
  if (input.fixtureFault && (input.mode !== "local-fixture" || input.evaluation !== "advisory-v3"))
    throw new Error("Deterministic infrastructure injection requires explicit local v3 fixture mode")
  if (input.feedbackGuidance && input.evaluation !== "repair-lifecycle-v1")
    throw new Error("Closeout guidance requires lifecycle evaluation")
  if (!input.infrastructure) return executeInstance(input)
  infrastructure(input.infrastructure, input.evaluation)
  const codeHash = await codeIdentity()
  if (input.mode === "model" && codeHash !== input.frozenCode) throw new Error("Frozen runtime identity differs")
  const issuedAt = Date.now()
  const attempt = {
    version: 1,
    mode: input.mode,
    evaluation: input.evaluation,
    ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
    infrastructure: input.infrastructure,
    codeHash,
    contractID: "pct_eval_" + input.packet.id,
    issuedAt,
    deadline: issuedAt + duration,
  }
  await mkdir(input.directory, { recursive: false, mode: 0o700 })
  await Bun.write(path.join(input.directory, "attempt.json"), JSON.stringify(attempt, null, 2) + "\n")
  return executeInstance(input, issuedAt).catch(async (error) => {
    if (!(await Bun.file(path.join(input.directory, "failure.json")).exists())) {
      const archive = path.join(input.directory, "archive")
      const audit = await hostEvidence({
        directory: archive,
        storage: path.join(input.directory, "host"),
        contractID: attempt.contractID,
      })
      const hash = await put(archive, {
        ...attempt,
        attempted: false,
        admitted: false,
        failure: String(error),
        auditHash: await put(archive, audit),
        transportHash: await put(
          archive,
          await Bun.file(path.join(archive, "transport.jsonl"))
            .text()
            .catch(() => ""),
        ),
        records: [],
        partial: [],
        coordinates: "attempt",
      })
      await Bun.write(
        path.join(input.directory, "failure.json"),
        JSON.stringify({ hash, reason: String(error), at: Date.now() }) + "\n",
      )
    }
    throw error
  })
}

async function executeInstance(input: InstanceInput, startedAt?: number) {
  if (input.evaluation === "advisory-v3") {
    if (
      !["advisory-development:1", "required-calculation:1", "subject-generalization:1"].includes(
        input.packet.version,
      ) ||
      input.entry !== "research" ||
      input.fault ||
      !input.infrastructure
    )
      throw new Error("V3 requires its explicit scenario, autonomous entry and infrastructure; no scripted bootstrap")
  } else {
    const scenarioVersion =
      input.evaluation === "repair-lifecycle-v1" ? "repair-lifecycle-development:1" : "feedback-development:1"
    if (input.packet.version === "repair-lifecycle-development:1" && input.evaluation !== "repair-lifecycle-v1")
      throw new Error("Lifecycle scenario requires its explicit evaluation protocol")
    if (
      (input.entry === "followup") !==
      (!!input.evaluation && input.packet.version === scenarioVersion && input.entry !== "research")
    )
      throw new Error("Followup requires the explicit v2 scenario and policy")
    if (
      input.evaluation &&
      (input.packet.version !== scenarioVersion ||
        (input.entry === "followup") !== input.packet.expectedTests.includes("exploratory execution evidence"))
    )
      throw new Error("V2 execution requires a matching derived development scenario")
    if (input.evaluation && (input.fault || !["followup", "research"].includes(input.entry)))
      throw new Error("Unsupported v2 execution entry")
  }
  const codeHash = await codeIdentity()
  if (input.mode === "model" && input.frozenCode !== codeHash)
    throw new Error("Model execution requires the frozen runtime identity")
  if (!input.infrastructure) await mkdir(input.directory, { recursive: false, mode: 0o700 })
  const storage = path.join(input.directory, "host")
  const directory = path.join(input.directory, "workspace")
  const archive = path.join(input.directory, "archive")
  await Promise.all([storage, directory, archive].map((item) => mkdir(item, { mode: 0o700 })))
  await Bun.write(path.join(archive, "transport.jsonl"), "")
  const binary = await launcher(path.join(input.directory, "isolation"))
  const control = new AbortController()
  const records: Transport[] = []
  const observations: Observation[] = []
  const fault = { attempted: false, injected: false, oldID: "", recovered: undefined as unknown }
  const recoveryState = { promise: undefined as Promise<void> | undefined }
  const completion = { result: undefined as unknown, stopped: false, admitted: false, attempted: false }
  const current = { host: undefined as Awaited<ReturnType<typeof start>> | undefined }
  const issuedAt = startedAt ?? Date.now()
  const contractID = "pct_eval_" + input.packet.id
  const agreement = issue(publish(input.packet), {
    directory,
    contractID,
    issuedAt,
    worker: { providerID: "evaluation", id: "worker" } as ResearchModel.Input["model"],
    reviewer: { providerID: "evaluation", id: "reviewer" } as ResearchModel.Input["model"],
    executable: input.node,
    executableHash: digest(new Uint8Array(await Bun.file(input.node).arrayBuffer())),
    timeout: input.timeouts.verification,
    evaluation: input.evaluation,
    ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
  })
  const command = (action: string, id: string, payload?: unknown): Promise<unknown> => {
    if (!current.host) return Promise.reject(new Error("Research host unavailable"))
    return current.host.command(action, id, payload)
  }
  const get = async () => (await command("research-get", contractID)) as ResearchModel.Run
  const seed =
    input.entry === "followup"
      ? bootstrap({
          packet: input.packet,
          file: path.join(archive, "bootstrap.json"),
          protocol: new URL(input.routes.worker.endpoint).pathname,
        })
      : undefined
  const script = input.entry === "plan" || input.entry === "final" ? probe(input.packet, input.entry) : undefined
  const record = (value: unknown) =>
    appendFileSync(path.join(archive, "transport.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600, flush: true })
  const proxy = await provider({
    mode: input.mode,
    routes: input.routes,
    timeout: input.timeouts.provider,
    signal: control.signal,
    identify: async () => {
      const operations = ((await command("operations", contractID)) as ProContractJob.Operation[]).filter(
        (item) => item.kind === "provider" && item.status === "running",
      )
      if (operations.length !== 1) throw new Error("Provider operation is ambiguous")
      const operation = operations[0]
      const versions = (await command("research-history", contractID)) as { data: ResearchModel.Run }[]
      const role = stage(
        operation,
        versions.map((item) => item.data),
      )
      if (operation.source.jobID && !["plan_review", "review"].includes(role))
        throw new Error("Unknown provider job role")
      return {
        identity: {
          contractID,
          operationID: operation.id,
          sessionID: operation.source.sessionID,
          jobID: operation.source.jobID ?? "worker",
        },
        role: role === "worker" ? "worker" : "reviewer",
        deadline: agreement.spec.budget.deadline!,
      }
    },
    request: record,
    observe: (item) => {
      record(item)
      records.push(item)
      if (item.boundary !== "provider") return
      observations.push(item.event)
      if (
        input.fault !== "provider" ||
        fault.attempted ||
        item.event.kind !== "response" ||
        item.role !== "reviewer" ||
        !current.host?.identity
      )
        return
      fault.attempted = true
      fault.oldID = item.event.identity.jobID
      process.kill(current.host.identity.pid, "SIGKILL")
      const killed: Observation = {
        kind: "kill",
        at: performance.now(),
        identity: item.event.identity,
        host: current.host.identity,
      }
      observations.push(killed)
      record(killed)
      fault.injected = true
    },
    scriptProtocol: seed ? "route" : undefined,
    script: seed
      ? async (admission) => (admission.role === "worker" ? seed(await get(), admission) : undefined)
      : script
        ? async (admission) => (admission.role === "worker" ? script(await get()) : undefined)
        : undefined,
  })
  const abort = () => control.abort()
  input.signal.addEventListener("abort", abort, { once: true })
  if (input.signal.aborted) control.abort()
  const deadlineTimer = setTimeout(abort, Math.max(1, agreement.spec.budget.deadline! - Date.now()))
  const startup = async () => {
    current.host = await start({
      storage,
      directory,
      launcher: binary,
      port: Number(new URL(proxy.url).port),
      bun: input.bun,
      timeout: input.timeouts.cleanup,
      ...(input.infrastructure
        ? { infrastructure: input.infrastructure, deadline: agreement.spec.budget.deadline, signal: input.signal }
        : {}),
    })
  }
  try {
    await Bun.write(path.join(storage, "models.json"), "{}")
    const config = {
      providers: {
        evaluation: {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: proxy.url },
          models: Object.fromEntries(
            (["worker", "reviewer"] as const).map((role) => [
              role,
              {
                limit: input.limits[role],
                api: {
                  type: "aisdk",
                  package:
                    (role !== "worker" || !script) && new URL(input.routes[role].endpoint).pathname === "/v1/responses"
                      ? "@ai-sdk/openai"
                      : "@ai-sdk/openai-compatible",
                  url: proxy.url,
                },
              },
            ]),
          ),
        },
      },
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    }
    await Bun.write(path.join(directory, "opencode.json"), JSON.stringify(config))
    await Bun.write(path.join(storage, "config/opencode/opencode.json"), JSON.stringify(config))
    await Promise.all(
      Object.entries(publish(input.packet).files).map(([file, content]) =>
        Bun.write(path.join(directory, file), content),
      ),
    )
    const git = Bun.spawn(["git", "init", directory], {
      stdout: "ignore",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    })
    const gitTimer = setTimeout(() => git.kill("SIGKILL"), input.timeouts.cleanup)
    if (await git.exited) throw new Error("Cannot initialize evaluation workspace")
    clearTimeout(gitTimer)
    await startup()
    // Write the admission coordinates before the effect; failed issuance stays observable.
    const admission = await open(path.join(input.directory, "admission.json"), "wx", 0o600)
    await admission.writeFile(
      JSON.stringify({ mode: input.mode, issuedAt, deadline: agreement.spec.budget.deadline, agreement }),
    )
    await admission.sync()
    await admission.close()
    if (control.signal.aborted) throw new Error("Evaluation cancelled before issuance")
    if (input.fixtureFault === "before_issue") throw new Error("Local fixture: failure before issuance")
    completion.attempted = true
    await command("research-issue", contractID, agreement)
    completion.admitted = true
    const recover = () => {
      if (recoveryState.promise) return recoveryState.promise
      recoveryState.promise = (async () => {
        // stop waits for the trusted supervisor's complete tree cleanup before any restart.
        await current.host!.stop()
        if (control.signal.aborted || input.signal.aborted) throw new Error("Evaluation cancelled before recovery")
        await startup()
        if (control.signal.aborted || input.signal.aborted)
          throw new Error("Evaluation cancelled during recovery startup")
        const limit = Math.min(agreement.spec.budget.deadline!, Date.now() + input.timeouts.cleanup)
        const stopped = await (async () => {
          while (Date.now() < limit) {
            if (control.signal.aborted || input.signal.aborted) throw new Error("Evaluation cancelled during recovery")
            const value = await get()
            const binding = (await command("execution", contractID)) as { dispatched?: unknown }
            const job = (await command("job-get", fault.oldID)) as ProContractJob.Job
            if (value.stage === "unavailable" && !binding.dispatched && (job.leaseExpiresAt ?? 0) <= Date.now())
              return value
            await Bun.sleep(25)
          }
          throw new Error("Interrupted research state did not become recoverable")
        })()
        if (
          stopped.input.spec.budget.deadline !== agreement.spec.budget.deadline ||
          Date.now() >= agreement.spec.budget.deadline!
        )
          throw new Error("Recovery cannot renew the original deadline")
        if (control.signal.aborted || input.signal.aborted)
          throw new Error("Evaluation cancelled before explicit recovery")
        await command("job-cancel", fault.oldID)
        await command("job-audit", fault.oldID)
        const unknown = ((await command("operations", contractID)) as ProContractJob.Operation[]).filter(
          (item) => item.source.jobID === fault.oldID && item.status === "unknown",
        )
        if (!unknown.length) throw new Error("Scheduled recovery has no audited unknown operation")
        if (control.signal.aborted || input.signal.aborted || Date.now() >= agreement.spec.budget.deadline!)
          throw new Error("Evaluation cancelled or expired before recovery admission")
        await command("research-recover", contractID, { retry: true })
        fault.recovered = { oldID: fault.oldID, stopped, unknown, at: Date.now() }
      })()
      return recoveryState.promise
    }
    const port = {
      command: async (action: string, id: string, payload?: unknown): Promise<unknown> => {
        if (
          action === "research-get" &&
          input.fault &&
          !fault.attempted &&
          input.fault === "test_process" &&
          current.host?.identity
        ) {
          const run = await get()
          if (run.stage === "verification" && run.purpose === "experiment" && run.verifierJobID) {
            const child = await testProcess(current.host.identity, input.node, "acceptance.mjs")
            if (child) {
              fault.attempted = true
              fault.oldID = run.verifierJobID
              const identity = active(
                (await command("operations", contractID)) as ProContractJob.Operation[],
                run.verifierJobID,
                "verification",
              )
              observations.push({ kind: "spawn", at: performance.now(), identity, process: child })
              fault.injected = await killAtProcess(current.host.identity, child, identity, observations)
            }
          }
        }
        if (!fault.recovered && observations.some((item) => item.kind === "kill")) await recover()
        return command(action, id, payload).catch(async (error) => {
          if (
            fault.recovered ||
            !observations.some((item) => item.kind === "kill") ||
            ![
              "research-get",
              "research-history",
              "research-object",
              "job-get",
              "operations",
              "session-context",
            ].includes(action)
          )
            throw error
          await recover()
          return command(action, id, payload)
        })
      },
    }
    // No test-runner timeout: all monitoring shares the originally issued six-hour deadline.
    const monitored = await monitor({
      port,
      contractID,
      entry: input.entry,
      evaluation: input.evaluation,
      ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
      deadline: agreement.spec.budget.deadline!,
      archive,
      storage,
      observations: () => observations,
      signal: input.signal,
    })
    const versions = (await command("research-history", contractID)) as { version: number; data: ResearchModel.Run }[]
    const recovery = fault.recovered as { oldID: string; stopped: ResearchModel.Run; at: number } | undefined
    const jobs = recovery
      ? recoveryJobs(
          versions,
          recovery.stopped.version,
          input.fault === "provider" ? "plan" : "experiment",
          recovery.oldID,
        )
      : []
    const lineage = await Promise.all(jobs.map(async (id) => (await command("job-get", id)) as ProContractJob.Job))
    const operations = (await command("operations", contractID)) as ProContractJob.Operation[]
    control.abort()
    proxy.close()
    await current.host!.stop()
    completion.stopped = true
    if ((await codeIdentity()) !== codeHash) throw new Error("Runtime source changed during execution")
    const bootstrapRecord = input.evaluation
      ? await (Bun.file(path.join(archive, "bootstrap.json")).json() as Promise<Bootstrap>).catch(() => undefined)
      : undefined
    const result = {
      mode: input.mode,
      ...(input.infrastructure
        ? {
            infrastructure: input.infrastructure,
            auditHash: await put(archive, await hostEvidence({ directory: archive, storage, contractID })),
          }
        : {}),
      ...(input.evaluation ? { evaluation: input.evaluation, bootstrap: bootstrapRecord } : {}),
      ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
      codeHash,
      transportHash: await put(archive, await Bun.file(path.join(archive, "transport.jsonl")).text()),
      qualification: "not_run",
      issuedAt,
      deadline: agreement.spec.budget.deadline,
      monitored,
      fault: input.fault
        ? {
            ...fault,
            status: window(observations, input.fault),
            lineage,
            safe:
              !!recovery &&
              (recovery.stopped.replan
                ? versions.some(
                    (item) =>
                      item.version > recovery.stopped.version &&
                      !!item.data.plan?.approved &&
                      item.data.plan.jobID !== fault.oldID,
                  )
                : lineage.some((job) => job.input.previousJobID === fault.oldID)),
          }
        : undefined,
      usage: operations.map((operation) => ({
        stage: stage(
          operation,
          versions.map((item) => item.data),
        ),
        operationID: operation.id,
        milliseconds: operation.endedAt === undefined ? null : operation.endedAt - operation.startedAt,
        turns: operation.kind === "provider" ? 1 : 0,
        actions: ["tool", "verification"].includes(operation.kind) ? 1 : 0,
        wireRequests: records.filter(
          (item) =>
            item.boundary === "provider" &&
            item.event.kind === "wire" &&
            item.event.identity.operationID === operation.id,
        ).length,
        ...(input.evaluation
          ? { origin: operation.id === bootstrapRecord?.identity.operationID ? "script:initial-plan-only" : "host" }
          : {}),
        tokens:
          operation.id === bootstrapRecord?.identity.operationID ? null : (operation.usage.value?.totalTokens ?? null),
        cost: null,
        unknown: operation.id === bootstrapRecord?.identity.operationID || operation.usage.state === "unknown",
      })),
      scoring: monitored.prerequisiteBlocked ? "not_exposed" : "pending_blind_annotations",
      observations,
    }
    completion.result = result
    await Bun.write(
      path.join(input.directory, "result.json"),
      JSON.stringify({ hash: await put(archive, result), result }, null, 2) + "\n",
    )
    return result
  } catch (error) {
    // Close transport before sealing the failure so partial/complete tail records are included.
    control.abort()
    proxy.close()
    const stopped = input.infrastructure
      ? await current.host?.stop().then(
          () => ({ complete: true }),
          (reason) => ({ complete: false, reason: String(reason) }),
        )
      : undefined
    const audit = input.infrastructure ? await hostEvidence({ directory: archive, storage, contractID }) : undefined
    const partial = audit
      ? [
          "operations" in audit && audit.operations
            ? { status: "fulfilled" as const, value: audit.operations }
            : { status: "rejected" as const, reason: "Post-stop operations unknown" },
          "history" in audit && audit.history
            ? { status: "fulfilled" as const, value: audit.history }
            : { status: "rejected" as const, reason: "Post-stop history unknown" },
        ]
      : await Promise.allSettled([command("operations", contractID), command("research-history", contractID)])
    const failedRuns = partial[1]?.status === "fulfilled" ? (partial[1].value as { data: ResearchModel.Run }[]) : []
    const failedRun = failedRuns.at(-1)?.data
    const retained =
      input.evaluation && failedRun && !input.infrastructure
        ? await collect({ directory: archive, run: failedRun, storage, command }).then(
            (evidence) => ({ evidence }),
            (reason) => ({ reason: String(reason) }),
          )
        : undefined
    const cleanup = input.infrastructure
      ? (stopped ?? audit?.cleanup ?? { complete: false, reason: "host not returned" })
      : await current.host?.stop().then(
          () => ({ complete: true }),
          (reason) => ({ complete: false, reason: String(reason) }),
        )
    completion.stopped = true
    const transport = await Bun.file(path.join(archive, "transport.jsonl"))
      .text()
      .catch(() => "")
    const hash = await put(archive, {
      mode: input.mode,
      ...(input.evaluation
        ? {
            evaluation: input.evaluation,
            ...(input.feedbackGuidance ? { feedbackGuidance: input.feedbackGuidance } : {}),
            bootstrap: await (Bun.file(path.join(archive, "bootstrap.json")).json() as Promise<Bootstrap>).catch(
              () => undefined,
            ),
          }
        : {}),
      codeHash,
      ...(input.infrastructure ? { infrastructure: input.infrastructure, auditHash: await put(archive, audit) } : {}),
      admitted: completion.admitted,
      attempted: completion.attempted,
      agreement,
      failure: String(error),
      ...(input.evaluation ? { retained } : {}),
      issuedAt,
      deadline: agreement.spec.budget.deadline,
      records,
      observations,
      fault,
      cleanup,
      transportHash: await put(archive, transport),
      partial: partial.map((item) =>
        item.status === "fulfilled" ? item : { status: item.status, reason: String(item.reason) },
      ),
    })
    await Bun.write(
      path.join(input.directory, "failure.json"),
      JSON.stringify({ hash, reason: String(error), at: Date.now() }) + "\n",
    )
    throw error
  } finally {
    clearTimeout(deadlineTimer)
    input.signal.removeEventListener("abort", abort)
    control.abort()
    proxy.close()
    if (!completion.stopped)
      await current.host?.stop().catch(async (error) => {
        const previous = (await Bun.file(path.join(input.directory, "failure.json"))
          .json()
          .catch(() => undefined)) as unknown
        const failure = { cleanupFailure: String(error), previous, result: completion.result, at: Date.now() }
        const hash = await put(archive, failure)
        await Bun.write(path.join(input.directory, "cleanup-failure.json"), JSON.stringify({ hash, ...failure }) + "\n")
        throw error
      })
  }
}
