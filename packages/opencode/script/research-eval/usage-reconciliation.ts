import { infrastructure } from "./infrastructure"
import { isUtf8 } from "node:buffer"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { digest, duration } from "./ledger"

type ObjectValue = Record<string, unknown>
type Counts = {
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  nonCachedInputTokens?: number
  reasoningTokens?: number
}
type Unresolved = { state: "unresolved"; reason: string; disputed: boolean }
type Terminal = {
  state: "reported"
  protocol: "responses" | "chat"
  responseID: string
  terminalHash: string
  bodyHash: string
  usage: Counts
  rawUsage: ObjectValue
}
const unresolved = (reason: string, disputed = false): Unresolved => ({ state: "unresolved", reason, disputed })
const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : undefined
const parse = (value: string) => object(Option.getOrUndefined(json(value)))
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const hashPattern = /^[a-f0-9]{64}$/
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const stable = (value: unknown): string =>
  JSON.stringify(value, (_, item: unknown) => {
    const record = object(item)
    return record
      ? Object.fromEntries(
          Object.keys(record)
            .sort()
            .map((key) => [key, record[key]]),
        )
      : item
  })

function counts(value: ObjectValue, protocol: "responses" | "chat" | "core"): Counts | undefined {
  const input =
    protocol === "core" ? value.inputTokens : value[protocol === "responses" ? "input_tokens" : "prompt_tokens"]
  const output =
    protocol === "core" ? value.outputTokens : value[protocol === "responses" ? "output_tokens" : "completion_tokens"]
  const total = protocol === "core" ? value.totalTokens : value.total_tokens
  const details = object(value[protocol === "responses" ? "input_tokens_details" : "prompt_tokens_details"])
  const generated = object(value[protocol === "responses" ? "output_tokens_details" : "completion_tokens_details"])
  const read = protocol === "core" ? value.cacheReadInputTokens : details?.cached_tokens
  const write = protocol === "core" ? value.cacheWriteInputTokens : details?.cache_write_tokens
  const reasoning = protocol === "core" ? value.reasoningTokens : generated?.reasoning_tokens
  const nonCached = protocol === "core" ? value.nonCachedInputTokens : undefined
  if (
    !integer(total) ||
    (protocol !== "core" && (!integer(input) || !integer(output))) ||
    [input, output, read, write, reasoning, nonCached].some((item) => item !== undefined && !integer(item)) ||
    (integer(input) && integer(output) && (!integer(input + output) || input + output !== total)) ||
    (integer(input) && [read, write, nonCached].some((item) => integer(item) && item > input)) ||
    (integer(output) && integer(reasoning) && reasoning > output) ||
    (integer(input) && integer(read) && integer(write) && read + write > input) ||
    (integer(input) && integer(read) && integer(nonCached) && read + nonCached !== input)
  )
    return
  return {
    totalTokens: total,
    ...(integer(input) ? { inputTokens: input } : {}),
    ...(integer(output) ? { outputTokens: output } : {}),
    ...(integer(read) ? { cacheReadInputTokens: read } : {}),
    ...(integer(write) ? { cacheWriteInputTokens: write } : {}),
    ...(integer(reasoning) ? { reasoningTokens: reasoning } : {}),
    ...(integer(nonCached)
      ? { nonCachedInputTokens: nonCached }
      : integer(input) && integer(read)
        ? { nonCachedInputTokens: input - read }
        : {}),
  }
}

function disagrees(left: Counts, right: Counts) {
  return Object.entries(left).some(
    ([key, value]) => right[key as keyof Counts] !== undefined && right[key as keyof Counts] !== value,
  )
}

/** Parse only the two completed SSE protocols already admitted by the research gateway. */
export function terminalUsage(capture: ObjectValue): Terminal | Unresolved {
  if (capture.complete !== true || capture.truncated !== false) return unresolved("partial_transport")
  if (!integer(capture.status) || capture.status < 200 || capture.status >= 300) return unresolved("http_unsuccessful")
  if (!/^text\/event-stream(?:\s*;|$)/i.test(String(object(capture.headers)?.["content-type"] ?? "")))
    return unresolved("unsupported_content_type")
  if (
    typeof capture.body !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(capture.body)
  )
    return unresolved("invalid_base64")
  const body = Buffer.from(capture.body, "base64")
  if (body.length > 16 * 1024 * 1024 || body.toString("base64") !== capture.body || !isUtf8(body))
    return unresolved("invalid_body")
  const text = body.toString("utf8").replace(/\r\n?/g, "\n")
  if (!text.endsWith("\n\n")) return unresolved("unterminated_sse_frame")
  const frames = text.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").filter((line) => line === "data" || line.startsWith("data:"))
    return data.length ? [data.map((line) => line.slice(5).replace(/^ /, "")).join("\n")] : []
  })
  if (!frames.length) return unresolved("missing_terminal")
  const done = frames.filter((frame) => frame === "[DONE]")
  if (done.length > 1 || (done.length && frames.at(-1) !== "[DONE]")) return unresolved("conflicting_terminal", true)
  const payloads = frames.filter((frame) => frame !== "[DONE]").map(parse)
  if (payloads.some((frame) => !frame)) return unresolved("malformed_sse_json")
  const events = payloads.filter((frame): frame is ObjectValue => !!frame)
  const responses = events.some((event) => typeof event.type === "string" && event.type.startsWith("response."))
  if (responses) {
    if (events.some((event) => typeof event.type !== "string" || !event.type.startsWith("response.")))
      return unresolved("mixed_or_failed_protocol")
    if (events.some((event) => ["response.incomplete", "response.failed"].includes(String(event.type))))
      return unresolved("response_not_completed")
    const terminals = events.filter((event) => event.type === "response.completed")
    if (terminals.length !== 1 || events.at(-1) !== terminals[0])
      return unresolved("ambiguous_terminal", terminals.length > 1)
    const response = object(terminals[0].response)
    if (
      !response ||
      typeof response.id !== "string" ||
      !response.id ||
      response.status !== "completed" ||
      response.error != null
    )
      return unresolved("invalid_completed_response")
    if (events.some((event) => object(event.response)?.id !== undefined && object(event.response)?.id !== response.id))
      return unresolved("response_identity_conflict", true)
    const rawUsage = object(response.usage)
    const usage = rawUsage && counts(rawUsage, "responses")
    if (!usage || !rawUsage) return unresolved("invalid_terminal_usage")
    return {
      state: "reported",
      protocol: "responses",
      responseID: response.id,
      bodyHash: digest(body),
      terminalHash: digest(frames.filter((frame) => frame !== "[DONE]").at(-1)!),
      usage,
      rawUsage,
    }
  }
  if (done.length !== 1) return unresolved("missing_chat_done")
  if (
    !events.length ||
    events.some(
      (event) =>
        event.object !== "chat.completion.chunk" ||
        typeof event.id !== "string" ||
        !event.id ||
        event.id !== events[0].id ||
        !Array.isArray(event.choices),
    )
  )
    return unresolved("invalid_chat_identity", true)
  const terminals = events.filter((event) => event.usage != null)
  if (terminals.length !== 1 || events.at(-1) !== terminals[0])
    return unresolved("ambiguous_terminal", terminals.length > 1)
  if (!events.some((event) => list(event.choices).some((choice) => typeof object(choice)?.finish_reason === "string")))
    return unresolved("missing_chat_finish")
  const rawUsage = object(terminals[0].usage)
  const usage = rawUsage && counts(rawUsage, "chat")
  if (!usage || !rawUsage) return unresolved("invalid_terminal_usage")
  return {
    state: "reported",
    protocol: "chat",
    responseID: String(events[0].id),
    bodyHash: digest(body),
    terminalHash: digest(frames.at(-2)!),
    usage,
    rawUsage,
  }
}

type RecordRow = { hash: string; line: number; value: ObjectValue }
type Operation = {
  id: string
  source: { contractID: string; sessionID: string; jobID?: string; identity: string; deadline: number }
  kind: string
  status: string
  startedAt: number
  endedAt?: number
  usage: { state: string; value?: ObjectValue }
}
function operation(value: unknown): Operation {
  const row = object(value)
  const source = object(row?.source)
  const usage = object(row?.usage)
  if (
    !row ||
    !source ||
    !usage ||
    typeof row.id !== "string" ||
    !row.id ||
    !["provider", "compaction", "tool", "verification"].includes(String(row.kind)) ||
    !["running", "completed", "failed", "interrupted", "unknown"].includes(String(row.status)) ||
    !["unknown", "reported"].includes(String(usage.state)) ||
    !Array.isArray(row.usageEvents) ||
    [source.contractID, source.sessionID, source.identity].some((item) => typeof item !== "string" || !item) ||
    (source.jobID !== undefined && (typeof source.jobID !== "string" || !source.jobID)) ||
    !integer(source.deadline) ||
    !integer(row.startedAt) ||
    (row.endedAt !== undefined && (!integer(row.endedAt) || row.endedAt < row.startedAt))
  )
    throw new Error("Invalid archived operation")
  return row as unknown as Operation
}

function requestChain(
  op: Operation,
  rows: RecordRow[],
):
  | Unresolved
  | {
      terminal: Terminal
      requestID: string
      admission: RecordRow
      wire: RecordRow
      capture: RecordRow
      duplicates: string[]
    } {
  const associated = rows.filter(
    (row) =>
      object(object(row.value.event)?.identity ?? row.value.identity)?.operationID === op.id &&
      // Bare lifecycle/process observations are not gateway requests (notably kill).
      !(
        row.value.event === undefined &&
        row.value.boundary === undefined &&
        ["begin", "spawn", "alive", "exit", "cleaned", "kill"].includes(String(row.value.kind))
      ),
  )
  const requestID = (row: RecordRow) =>
    row.value.event === undefined ? row.value.requestID : object(row.value.event)?.requestID
  if (associated.some((row) => typeof requestID(row) !== "string" || !String(requestID(row)).trim()))
    return unresolved("invalid_request_id", true)
  const requests = [...new Set(associated.map((row) => String(requestID(row))))]
  if (requests.length !== 1)
    return unresolved(requests.length ? "multiple_requests" : "missing_request", requests.length > 1)
  const matching = rows.filter((row) => requestID(row) === requests[0])
  const identity = {
    contractID: op.source.contractID,
    sessionID: op.source.sessionID,
    jobID: op.source.jobID ?? "worker",
    operationID: op.id,
  }
  const role = op.source.jobID ? "reviewer" : "worker"
  if (
    matching.some(
      (row) =>
        stable(row.value.event === undefined ? row.value.identity : object(row.value.event)?.identity) !==
          stable(identity) || row.value.role !== role,
    )
  )
    return unresolved("request_identity_conflict", true)
  const unique = matching.filter((row, index) => matching.findIndex((other) => other.hash === row.hash) === index)
  const admission = unique.filter((row) => !row.value.event)
  const wires = unique.filter((row) => row.value.boundary === "provider" && object(row.value.event)?.kind === "wire")
  const response = unique.filter(
    (row) => row.value.boundary === "provider" && object(row.value.event)?.kind === "response",
  )
  const captures = unique.filter(
    (row) => row.value.boundary === "provider" && object(row.value.event)?.kind === "transport",
  )
  if (admission.length !== 1 || wires.length !== 1 || response.length !== 1 || captures.length !== 1)
    return unresolved(
      "missing_or_ambiguous_request_chain",
      admission.length > 1 || wires.length > 1 || response.length > 1 || captures.length > 1,
    )
  if (
    admission[0].value.deadline !== op.source.deadline ||
    !hashPattern.test(String(admission[0].value.hash)) ||
    !integer(admission[0].value.bytes) ||
    admission[0].value.bytes === 0 ||
    typeof wires[0].value.origin !== "string" ||
    !/^https?:\/\//.test(wires[0].value.origin) ||
    unique.some(
      (row) =>
        row.value.event &&
        (row.value.boundary !== "provider" ||
          row.value.origin !== wires[0].value.origin ||
          !["wire", "response", "transport", "complete"].includes(String(object(row.value.event)?.kind)) ||
          !Number.isFinite(object(row.value.event)?.at)),
    ) ||
    !(admission[0].line < wires[0].line && wires[0].line < response[0].line && response[0].line < captures[0].line)
  )
    return unresolved("request_provenance_conflict", true)
  const terminal = terminalUsage(object(captures[0].value.event)!)
  if (terminal.state === "unresolved") return terminal
  return {
    terminal,
    requestID: requests[0],
    admission: admission[0],
    wire: wires[0],
    capture: captures[0],
    duplicates: matching
      .filter((row, index) => matching.findIndex((other) => other.hash === row.hash) !== index)
      .map((row) => row.hash),
  }
}

/** Read frozen files only; new evidence and reports are written exclusively into a new external directory. */
export async function reconcile(input: { directory: string; output: string }) {
  const directory = await realpath(input.directory)
  const output = path.join(await realpath(path.dirname(path.resolve(input.output))), path.basename(input.output))
  if (output === directory || output.startsWith(directory + path.sep))
    throw new Error("Output must be outside the original cohort")
  // Existing files, directories and symlinks are rejected by this exclusive creation.
  await mkdir(output, { mode: 0o700 })
  const sources = new Map<string, string>()
  const read = async (file: string) => {
    const absolute = await realpath(path.join(directory, file))
    if (!absolute.startsWith(directory + path.sep)) throw new Error("Source path escapes cohort")
    const bytes = await Bun.file(absolute).text()
    const hash = digest(bytes)
    if (sources.has(file) && sources.get(file) !== hash) throw new Error("Source changed during reconciliation")
    sources.set(file, hash)
    return bytes
  }
  const archived = async (prefix: string, hash: unknown) => {
    if (typeof hash !== "string" || !hashPattern.test(hash)) throw new Error("Invalid archive hash")
    const raw = await read(path.join(prefix, "objects", hash))
    if (digest(raw) !== hash) throw new Error("Archive hash mismatch: " + hash)
    return raw
  }
  const cohortRaw = await read("cohort.json")
  const cohort = parse(cohortRaw)
  const configuration = object(cohort?.configuration)
  if (
    !cohort ||
    !configuration ||
    !["feedback-v2", "repair-lifecycle-v1"].includes(String(configuration?.evaluation)) ||
    !hashPattern.test(String(configuration.runner))
  )
    throw new Error("Only retained versioned feedback cohorts are supported")
  const instances = list(cohort.instances).map((item) => {
    const instance = object(item)
    if (!instance || typeof instance.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(instance.id))
      throw new Error("Invalid scheduled instance")
    return instance
  })
  if (!instances.length || new Set(instances.map((item) => item.id)).size !== instances.length)
    throw new Error("Invalid cohort denominator")
  const eventsRaw = await read("events.jsonl")
  const chain = { hash: digest(cohortRaw) }
  const events = eventsRaw
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const value = parse(line)
      if (!value) throw new Error("Invalid cohort event")
      const original = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "hash"))
      if (
        value.previous !== chain.hash ||
        value.hash !== digest(JSON.stringify(original)) ||
        value.id !== instances[index]?.id
      )
        throw new Error("Cohort chain or instance identity mismatch")
      chain.hash = String(value.hash)
      return value
    })
  if (events.length > instances.length) throw new Error("Unexpected cohort events")
  const rows = []
  const facts: ObjectValue[] = []
  for (const instance of instances) {
    const event = events.find((item) => item.id === instance.id)
    if (!event?.evidence) {
      rows.push({
        instanceID: instance.id,
        status: event?.status ?? "not_recorded",
        operations: [],
        unresolved: ["missing_result"],
        unassignedTransport: [],
      })
      continue
    }
    const result = parse(await archived("", event.evidence))
    if (!result) throw new Error("Invalid result object")
    const prefix = path.join(String(instance.id), "archive")
    const retainedHash = object(result.retained)?.hash
    const success = object(result.monitored)
    if (!success && !retainedHash) {
      rows.push({
        instanceID: instance.id,
        resultHash: event.evidence,
        status: event.status,
        operations: [],
        unresolved: ["missing_retained_failure"],
        unassignedTransport: [],
      })
      continue
    }
    const retained = success ? result : parse(await archived(prefix, retainedHash))
    if (!retained) throw new Error("Invalid retained failure")
    const run = object(success?.run)
    const agreement = success ? object(run?.input) : object(retained.agreement)
    infrastructure(configuration.infrastructure, String(configuration.evaluation))
    infrastructure(retained.infrastructure, String(retained.evaluation))
    if (stable(configuration.infrastructure) !== stable(retained.infrastructure))
      throw new Error("Usage infrastructure policy changed")
    if (!success && configuration.infrastructure && !agreement) {
      const attempt = parse(await read(path.join(String(instance.id), "attempt.json")))
      if (
        !attempt ||
        retained.codeHash !== configuration.runner ||
        result.instance !== instance.id ||
        retained.contractID !== "pct_eval_" + instance.id ||
        retained.attempted !== false ||
        !integer(retained.issuedAt) ||
        retained.deadline !== retained.issuedAt + duration ||
        attempt.issuedAt !== retained.issuedAt ||
        attempt.deadline !== retained.deadline ||
        attempt.codeHash !== retained.codeHash ||
        stable(attempt.infrastructure) !== stable(retained.infrastructure)
      )
        throw new Error("Pre-issuance accounting identity changed")
      await archived(prefix, retained.auditHash)
      const transport = await archived(prefix, retained.transportHash)
      rows.push({
        instanceID: instance.id,
        resultHash: event.evidence,
        retainedHash,
        status: event.status,
        transportHash: retained.transportHash,
        operations: [],
        unresolved: ["pre_issuance_operation_snapshot_unavailable"],
        unassignedTransport: transport
          .split("\n")
          .filter(Boolean)
          .map((line, index) => ({ hash: digest(line), line: index + 1 })),
      })
      continue
    }
    const protocol = object(agreement?.manifest)?.feedbackProtocol
    if (
      (retained.evaluation === "repair-lifecycle-v1" && protocol !== "repair-lifecycle:1") ||
      (protocol === "repair-lifecycle:1" && retained.evaluation !== "repair-lifecycle-v1")
    )
      throw new Error("Result feedback protocol does not match its evaluation")
    const contractID = "pct_eval_" + instance.id
    if (
      retained.codeHash !== configuration.runner ||
      retained.evaluation !== configuration!.evaluation ||
      agreement?.id !== contractID ||
      (success && run?.id !== contractID) ||
      (!success && result.instance !== instance.id) ||
      !integer(retained.issuedAt) ||
      retained.deadline !== retained.issuedAt + duration ||
      object(object(agreement?.spec)?.budget)?.deadline !== retained.deadline
    )
      throw new Error("Result identity or original deadline mismatch")
    const transportRaw = await archived(prefix, retained.transportHash)
    const transport = transportRaw
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        const value = parse(line)
        if (!value) throw new Error("Malformed transport archive")
        return { hash: digest(line), line: index + 1, value }
      })
    const nestedEvidence = object(success?.evidence ?? object(retained.retained)?.evidence)
    const evidence = nestedEvidence ? parse(await archived(prefix, nestedEvidence.hash)) : undefined
    if (nestedEvidence && (!evidence || stable(evidence.operations) !== stable(nestedEvidence.operations)))
      throw new Error("Archived operations differ from result snapshot")
    // collect() embeds full jobs in the result, but archives their hashes plus the run.
    // Operations are the exact shared projection; do not compare the two aggregate shapes.
    if (evidence?.run !== undefined && object(evidence.run)?.id !== contractID)
      throw new Error("Operation archive belongs to another run")
    const partial = object(list(retained.partial)[0])
    const primary = success ? list(evidence?.operations) : partial?.status === "fulfilled" ? list(partial.value) : []
    const archivedOperations = list(evidence?.operations).map(operation)
    if (new Set(archivedOperations.map((item) => item.id)).size !== archivedOperations.length)
      throw new Error("Duplicate operation in retained evidence")
    // Failure collection may observe additional work after partial[0] was captured.
    // Keep every archived operation, without treating a later snapshot as the original ledger.
    const snapshots = [
      ...primary,
      ...(!success
        ? list(evidence?.operations).filter((value) => !primary.some((item) => object(item)?.id === object(value)?.id))
        : []),
    ]
    const operations = snapshots.map(operation)
    const originalRows = success
      ? list(result.usage).map((value) => {
          const row = object(value)
          if (!row || typeof row.operationID !== "string") throw new Error("Invalid original usage row")
          return row
        })
      : []
    if (
      new Set(operations.map((item) => item.id)).size !== operations.length ||
      new Set(originalRows.map((item) => item.operationID)).size !== originalRows.length
    )
      throw new Error("Duplicate archived operation or usage row")
    if (
      success &&
      (originalRows.length !== operations.length ||
        originalRows.some((row) => !operations.some((op) => op.id === row.operationID)))
    )
      throw new Error("Original usage does not match archived operations")
    const bootstrapID = object(object(retained.bootstrap)?.identity)?.operationID
    const projected = operations.map((op, index) => {
      if (op.source.contractID !== contractID || op.source.deadline !== retained.deadline)
        throw new Error("Operation belongs to another contract or deadline")
      const evidenceOnly = index >= primary.length
      const operationSource = {
        hash: success || evidenceOnly ? nestedEvidence!.hash : retainedHash,
        pointer:
          success || evidenceOnly
            ? `/operations/${evidenceOnly ? archivedOperations.findIndex((item) => item.id === op.id) : index}`
            : `/partial/0/value/${index}`,
        hashOfValue: digest(stable(snapshots[index])),
      }
      const originalUsage = evidenceOnly
        ? undefined
        : (originalRows.find((row) => row.operationID === op.id) ?? {
            operationID: op.id,
            tokens: op.id === bootstrapID ? null : (op.usage.value?.totalTokens ?? null),
            unknown: op.id === bootstrapID || op.usage.state === "unknown",
            cost: null,
            turns: op.kind === "provider" ? 1 : 0,
            actions: ["tool", "verification"].includes(op.kind) ? 1 : 0,
            wireRequests: transport.filter(
              (row) =>
                row.value.boundary === "provider" &&
                object(row.value.event)?.kind === "wire" &&
                object(object(row.value.event)?.identity)?.operationID === op.id,
            ).length,
          })
      const core = op.usage.state === "reported" && op.usage.value ? counts(op.usage.value, "core") : undefined
      const originalTokens = originalUsage?.tokens
      const base = {
        operationID: op.id,
        executionStatus: op.status,
        operation: snapshots[index],
        operationSource,
        originalUsage: originalUsage ?? null,
        originalTokens: integer(originalTokens) ? originalTokens : null,
        cost: null,
      }
      const unknown = (reason: string, disputed = false) => ({
        ...base,
        state: "unresolved",
        reason,
        disputed,
        effectiveTokens: !disputed && core && op.id !== bootstrapID ? core.totalTokens : null,
        provenance: !disputed && core && op.id !== bootstrapID ? "core" : null,
      })
      if (evidenceOnly) return unknown("operation_missing_from_failure_snapshot", true)
      if (
        !success &&
        evidence &&
        list(evidence.operations).some(
          (value) => object(value)?.id === op.id && stable(value) !== stable(snapshots[index]),
        )
      )
        return unknown("operation_snapshot_conflict", true)
      if (op.id === bootstrapID) return unknown("scripted_operation")
      if (
        (op.usage.state === "reported" && !core) ||
        (op.usage.state === "unknown" && op.usage.value !== undefined) ||
        originalTokens !== (core?.totalTokens ?? null) ||
        originalUsage?.unknown !== (op.usage.state === "unknown")
      )
        return unknown("core_usage_snapshot_conflict", true)
      if (
        list(object(snapshots[index])?.usageEvents).some((event) => {
          const value = object(object(event)?.value)
          const reported = value && counts(value, "core")
          return !reported || !core || disagrees(core, reported)
        })
      )
        return unknown("core_usage_event_conflict", true)
      if (op.kind !== "provider") return unknown("not_provider_usage")
      const matching = requestChain(op, transport)
      if ("state" in matching) return unknown(matching.reason, matching.disputed)
      if (core && disagrees(core, matching.terminal.usage)) return unknown("core_transport_usage_conflict", true)
      const fact = {
        version: "research-usage-fact:1",
        kind: core ? "confirmation" : "supplement",
        instanceID: instance.id,
        resultHash: event.evidence,
        ...(success ? {} : { retainedHash }),
        transportHash: retained.transportHash,
        operationSource,
        operation: snapshots[index],
        executionIdentityProvenance: "archived-operation-source",
        identity: {
          ...op.source,
          operationID: op.id,
          jobID: op.source.jobID ?? "worker",
          requestID: matching.requestID,
        },
        admissionHash: matching.admission.hash,
        requestBodyHash: matching.admission.value.hash,
        wireHash: matching.wire.hash,
        captureHash: matching.capture.hash,
        responseBodyHash: matching.terminal.bodyHash,
        terminalHash: matching.terminal.terminalHash,
        responseID: matching.terminal.responseID,
        protocol: matching.terminal.protocol,
        usage: matching.terminal.usage,
        rawUsage: matching.terminal.rawUsage,
      }
      const id = digest(stable(fact))
      facts.push({ id, ...fact })
      return {
        ...base,
        state: fact.kind,
        factID: id,
        effectiveTokens: matching.terminal.usage.totalTokens,
        provenance: core ? "core" : "archived-provider-terminal",
        duplicateRecords: matching.duplicates,
      }
    })
    rows.push({
      instanceID: instance.id,
      resultHash: event.evidence,
      ...(success ? {} : { retainedHash }),
      status: event.status,
      transportHash: retained.transportHash,
      operations: projected,
      unresolved: operations.length ? [] : ["missing_operation_snapshot"],
      unassignedTransport: transport
        .filter(
          (row) =>
            row.value.boundary === "provider" &&
            !operations.some((op) => op.id === object(object(row.value.event)?.identity)?.operationID),
        )
        .map((row) => ({ hash: row.hash, line: row.line })),
    })
  }
  if (await Bun.file(path.join(directory, "report.json")).exists()) await read("report.json")
  // Seal only after proving that every input read still has its original bytes.
  for (const [file, hash] of sources)
    if (digest(await read(file)) !== hash) throw new Error("Source changed during reconciliation")
  const provenance = {
    cohortHash: digest(cohortRaw),
    eventsHash: digest(eventsRaw),
    executionTip: chain.hash,
    frozenCodeHash: configuration.runner,
    reconciliationCodeHash: digest(await Bun.file(import.meta.path).text()),
    sources: [...sources].map(([file, hash]) => ({ file, hash })),
  }
  const operations = rows.flatMap((row) => row.operations)
  const sum = (values: (number | null)[]) => {
    const total = values.reduce<number>((value, item) => value + (item ?? 0), 0)
    if (!integer(total)) throw new Error("Unsafe token subtotal")
    return total
  }
  const reconciliation = {
    version: "research-usage-reconciliation:1",
    provenance,
    facts,
    unresolved: rows.flatMap((row) => [
      ...row.unresolved.map((reason) => ({ instanceID: row.instanceID, reason })),
      ...row.operations.filter((op) => op.state === "unresolved").map((op) => ({ instanceID: row.instanceID, ...op })),
      ...row.unassignedTransport.map((record) => ({
        instanceID: row.instanceID,
        reason: "unassigned_transport",
        record,
      })),
    ]),
  }
  const reconciliationBytes = JSON.stringify(reconciliation, null, 2) + "\n"
  const report = {
    version: "research-usage-report:1",
    reconciliationHash: digest(reconciliationBytes),
    provenance,
    rows,
    totals: {
      originalKnownTokens: sum(operations.map((op) => op.originalTokens)),
      confirmedTokens: sum(operations.filter((op) => op.state === "confirmation").map((op) => op.effectiveTokens)),
      supplementalTokens: sum(operations.filter((op) => op.state === "supplement").map((op) => op.effectiveTokens)),
      effectiveKnownTokens: sum(operations.map((op) => op.effectiveTokens)),
      unknownOperations: operations.filter((op) => op.effectiveTokens === null).length,
      unresolvedRecords: reconciliation.unresolved.length,
      cost: null,
    },
    qualification: "not_run",
    tokenReconciliationComplete: reconciliation.unresolved.length === 0,
    // Token evidence cannot establish cost or unobserved external scoring usage.
    accountingComplete: false,
  }
  await Bun.write(path.join(output, "reconciliation.json"), reconciliationBytes)
  await Bun.write(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
  return report
}

if (import.meta.main) {
  const [directory, output, extra] = process.argv.slice(2)
  if (!directory || !output || extra)
    throw new Error("Usage: bun usage-reconciliation.ts COHORT_DIRECTORY NEW_OUTPUT_DIRECTORY")
  const report = await reconcile({ directory, output })
  console.log(
    JSON.stringify(
      { version: report.version, reconciliationHash: report.reconciliationHash, totals: report.totals },
      null,
      2,
    ),
  )
}
