import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { put } from "./archive"
import { digest, duration } from "./ledger"
import { reconcile, terminalUsage } from "./usage-reconciliation"

const tokens = {
  inputTokens: 4593,
  outputTokens: 802,
  totalTokens: 5395,
  cacheReadInputTokens: 4349,
  reasoningTokens: 26,
}
const usage = {
  input_tokens: 4593,
  output_tokens: 802,
  total_tokens: 5395,
  input_tokens_details: { cached_tokens: 4349, cache_write_tokens: 241 },
  output_tokens_details: { reasoning_tokens: 26 },
}
const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n"
const stream = () =>
  frame({ type: "response.created", response: { id: "response" } }) +
  frame({ type: "response.completed", response: { id: "response", status: "completed", usage } })

function sample(core?: typeof tokens) {
  const identity = { contractID: "pct_eval_instance", operationID: "operation", sessionID: "session", jobID: "worker" }
  const operation = {
    id: "operation",
    source: { contractID: identity.contractID, sessionID: "session", identity: "execution", deadline: 1000 + duration },
    kind: "provider",
    status: "interrupted",
    startedAt: 1000,
    endedAt: 1010,
    usage: { state: core ? "reported" : "unknown", value: core },
    usageEvents: [] as { type: string; value: typeof tokens }[],
  }
  const admission = {
    identity: { ...identity },
    role: "worker",
    deadline: 1000 + duration,
    requestID: "request",
    hash: "a".repeat(64),
    bytes: 20,
  }
  const wire = {
    boundary: "provider",
    role: "worker",
    origin: "http://127.0.0.1",
    event: { kind: "wire", at: 1, identity: { ...identity }, requestID: "request" },
  }
  const response = { ...wire, event: { ...wire.event, identity: { ...identity }, kind: "response", at: 2 } }
  const capture = {
    ...wire,
    event: {
      ...wire.event,
      identity: { ...identity },
      kind: "transport",
      at: 3,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: Buffer.from(stream()).toString("base64"),
      complete: true,
      truncated: false,
    },
  }
  const complete = { ...wire, event: { ...wire.event, identity: { ...identity }, kind: "complete", at: 4 } }
  return {
    operation,
    admission,
    wire,
    response,
    capture,
    complete,
    records: [admission, wire, response, capture, complete] as unknown[],
    originalUsage: {
      operationID: operation.id,
      stage: "worker",
      turns: 1,
      actions: 0,
      wireRequests: 1,
      tokens: core?.totalTokens ?? null,
      unknown: !core,
      cost: null,
    },
  }
}

async function fixture(
  input: {
    core?: typeof tokens
    evaluation?: "feedback-v2" | "repair-lifecycle-v1"
    failure?: boolean
    noOperations?: boolean
    conflictingSnapshot?: boolean
    retainedOnly?: ("provider" | "tool")[]
    change?: (value: ReturnType<typeof sample>) => void
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-reconciliation-"))
  const directory = path.join(root, "source")
  await mkdir(directory)
  const data = sample(input.core)
  input.change?.(data)
  const operations = input.noOperations ? [] : [data.operation]
  const archive = path.join(directory, "instance", "archive")
  const transportHash = await put(archive, data.records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  const evidence = {
    operations: [
      ...(input.conflictingSnapshot ? [{ ...data.operation, status: "completed" }] : operations),
      ...(input.retainedOnly ?? []).map((kind, index) => ({ ...data.operation, id: "retained-only-" + index, kind })),
    ],
  }
  const evidenceHash = await put(archive, { ...evidence, run: { id: "pct_eval_instance" }, jobs: [] })
  const agreement = {
    id: "pct_eval_instance",
    spec: { budget: { deadline: 1000 + duration } },
    ...(input.evaluation === "repair-lifecycle-v1" ? { manifest: { feedbackProtocol: "repair-lifecycle:1" } } : {}),
  }
  const shared = {
    codeHash: "c".repeat(64),
    evaluation: input.evaluation ?? "feedback-v2",
    mode: "local-fixture",
    issuedAt: 1000,
    deadline: 1000 + duration,
    transportHash,
  }
  const retainedHash = input.failure
    ? await put(archive, {
        ...shared,
        agreement,
        records: data.records.slice(1),
        retained: { evidence: { ...evidence, hash: evidenceHash } },
        partial: [
          { status: "fulfilled", value: operations },
          { status: "fulfilled", value: [] },
        ],
      })
    : undefined
  const resultHash = await put(
    directory,
    input.failure
      ? { instance: "instance", failure: "Fixture infrastructure failure", retained: { hash: retainedHash } }
      : {
          ...shared,
          monitored: {
            run: { id: "pct_eval_instance", input: agreement },
            evidence: { ...evidence, hash: evidenceHash },
          },
          usage: input.noOperations ? [] : [data.originalUsage],
        },
  )
  const cohort =
    JSON.stringify({
      mode: "development-calibration",
      configuration: { evaluation: shared.evaluation, runner: shared.codeHash },
      instances: [{ id: "instance" }],
    }) + "\n"
  await Bun.write(path.join(directory, "cohort.json"), cohort)
  const row = {
    previous: digest(cohort),
    at: 1100,
    id: "instance",
    status: input.failure ? "infrastructure_failure" : "pending_scoring",
    evidence: resultHash,
  }
  await Bun.write(
    path.join(directory, "events.jsonl"),
    JSON.stringify({ ...row, hash: digest(JSON.stringify(row)) }) + "\n",
  )
  return {
    root,
    directory,
    data,
    transportHash,
    evidenceHash,
    resultHash,
    retainedHash,
    output: path.join(root, "derived"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test("complete Responses usage is independent of interrupted Core execution and includes subsets once", async () => {
  const input = await fixture()
  try {
    const original = await Bun.file(path.join(input.directory, "objects", input.resultHash)).text()
    const report = await reconcile(input)
    expect(report.totals).toMatchObject({
      originalKnownTokens: 0,
      supplementalTokens: 5395,
      effectiveKnownTokens: 5395,
      cost: null,
    })
    expect(report.rows[0].operations[0]).toMatchObject({
      executionStatus: "interrupted",
      state: "supplement",
      originalTokens: null,
      originalUsage: { turns: 1, actions: 0, wireRequests: 1, tokens: null, unknown: true },
      effectiveTokens: 5395,
      operation: { usageEvents: [], usage: { state: "unknown" } },
    })
    const sidecar = await Bun.file(path.join(input.output, "reconciliation.json")).json()
    expect(sidecar.facts[0]).toMatchObject({
      resultHash: input.resultHash,
      transportHash: input.transportHash,
      executionIdentityProvenance: "archived-operation-source",
      identity: { identity: "execution", operationID: "operation", requestID: "request" },
      operationSource: { hash: input.evidenceHash, pointer: "/operations/0" },
    })
    expect(await Bun.file(path.join(input.directory, "objects", input.resultHash)).text()).toBe(original)
    const again = await reconcile({ directory: input.directory, output: path.join(input.root, "again") })
    expect(again).toEqual(report)
  } finally {
    await input.cleanup()
  }
})

test("known Core usage is corroborated once and mutually known detail conflicts stay unresolved", async () => {
  for (const core of [
    tokens,
    { ...tokens, inputTokens: 4594, outputTokens: 801 },
    { ...tokens, reasoningTokens: 25 },
  ]) {
    const input = await fixture({ core })
    try {
      const report = await reconcile(input)
      expect(report.totals.originalKnownTokens).toBe(5395)
      expect(report.totals.supplementalTokens).toBe(0)
      if (core === tokens)
        expect(report.rows[0].operations[0]).toMatchObject({ state: "confirmation", effectiveTokens: 5395 })
      else
        expect(report.rows[0].operations[0]).toMatchObject({
          state: "unresolved",
          reason: "core_transport_usage_conflict",
          originalTokens: 5395,
          effectiveTokens: null,
        })
    } finally {
      await input.cleanup()
    }
  }
})

test("identical capture records deduplicate without altering original request accounting", async () => {
  const input = await fixture({ change: (value) => value.records.push(value.capture, value.admission, value.wire) })
  try {
    const report = await reconcile(input)
    expect(report.totals.supplementalTokens).toBe(5395)
    expect(report.rows[0].operations[0]).toMatchObject({ originalUsage: { wireRequests: 1 }, state: "supplement" })
    const sidecar = await Bun.file(path.join(input.output, "reconciliation.json")).json()
    expect(sidecar.facts).toHaveLength(1)
  } finally {
    await input.cleanup()
  }
})

test("malformed request IDs on additional operation records cannot disappear from attribution", async () => {
  for (const requestID of [undefined, 123, null, false, "", " "]) {
    for (const core of [undefined, tokens]) {
      const input = await fixture({
        core,
        change: (value) => {
          value.records.push({
            ...value.wire,
            // A valid wrapper ID must not repair a malformed provider event ID.
            requestID: "request",
            event: { ...value.wire.event, requestID },
          })
        },
      })
      try {
        const report = await reconcile(input)
        expect(report.rows[0].operations[0]).toMatchObject({
          state: "unresolved",
          reason: "invalid_request_id",
          originalTokens: core?.totalTokens ?? null,
          effectiveTokens: null,
        })
        expect(report.totals.supplementalTokens).toBe(0)
        expect(report.tokenReconciliationComplete).toBe(false)
      } finally {
        await input.cleanup()
      }
    }
  }
})

test("bare kill and process observations do not require provider request IDs", async () => {
  const input = await fixture({
    change: (value) => {
      for (const kind of ["begin", "spawn", "alive", "exit", "cleaned", "kill"])
        value.records.push({ kind, at: 5, identity: { ...value.wire.event.identity }, host: { pid: 1 } })
    },
  })
  try {
    const report = await reconcile(input)
    expect(report.totals.supplementalTokens).toBe(5395)
    expect(report.rows[0].operations[0]).toMatchObject({ state: "supplement", executionStatus: "interrupted" })
  } finally {
    await input.cleanup()
  }
})

test("a wrapper identity cannot repair a provider event's missing identity", async () => {
  const input = await fixture({
    change: (value) => {
      value.records[3] = {
        ...value.capture,
        identity: value.capture.event.identity,
        event: Object.fromEntries(Object.entries(value.capture.event).filter(([key]) => key !== "identity")),
      }
    },
  })
  try {
    const report = await reconcile(input)
    expect(report.rows[0].operations[0]).toMatchObject({
      state: "unresolved",
      reason: "request_identity_conflict",
      effectiveTokens: null,
    })
    expect(report.totals.supplementalTokens).toBe(0)
    expect(report.tokenReconciliationComplete).toBe(false)
  } finally {
    await input.cleanup()
  }
})

test("conflicting consumed Core usage events cannot be hidden by a matching last value", async () => {
  const input = await fixture({
    core: tokens,
    change: (value) => value.operation.usageEvents.push({ type: "finish", value: { ...tokens, reasoningTokens: 25 } }),
  })
  try {
    const report = await reconcile(input)
    expect(report.rows[0].operations[0]).toMatchObject({
      state: "unresolved",
      reason: "core_usage_event_conflict",
      originalTokens: 5395,
      effectiveTokens: null,
    })
  } finally {
    await input.cleanup()
  }
})

const rejections = [
  [
    "partial transport",
    (value: ReturnType<typeof sample>) => {
      value.capture.event.complete = false
    },
  ],
  [
    "truncated transport",
    (value: ReturnType<typeof sample>) => {
      value.capture.event.truncated = true
    },
  ],
  [
    "missing admission",
    (value: ReturnType<typeof sample>) => {
      value.records.shift()
    },
  ],
  [
    "missing wire",
    (value: ReturnType<typeof sample>) => {
      value.records.splice(1, 1)
    },
  ],
  [
    "wrong Session",
    (value: ReturnType<typeof sample>) => {
      value.capture.event.identity.sessionID = "another"
    },
  ],
  [
    "wrong Contract",
    (value: ReturnType<typeof sample>) => {
      value.capture.event.identity.contractID = "another"
    },
  ],
  [
    "wrong job",
    (value: ReturnType<typeof sample>) => {
      value.capture.event.identity.jobID = "another"
    },
  ],
  [
    "wrong operation",
    (value: ReturnType<typeof sample>) => {
      value.capture.event.identity.operationID = "another"
    },
  ],
  [
    "wrong role",
    (value: ReturnType<typeof sample>) => {
      value.capture.role = "reviewer"
    },
  ],
  [
    "wrong deadline",
    (value: ReturnType<typeof sample>) => {
      value.admission.deadline++
    },
  ],
  [
    "multiple requests",
    (value: ReturnType<typeof sample>) => {
      value.records.push({ ...value.admission, requestID: "second" })
    },
  ],
  [
    "conflicting captures",
    (value: ReturnType<typeof sample>) => {
      value.records.push({ ...value.capture, event: { ...value.capture.event, at: 5 } })
    },
  ],
  [
    "script boundary",
    (value: ReturnType<typeof sample>) => {
      value.wire.boundary = "script"
    },
  ],
] as const

for (const [name, change] of rejections)
  test(name + " cannot supply a supplemental fact", async () => {
    const input = await fixture({ change })
    try {
      const report = await reconcile(input)
      expect(report.totals.supplementalTokens).toBe(0)
      expect(report.rows[0].operations[0]).toMatchObject({
        state: "unresolved",
        effectiveTokens: null,
        executionStatus: "interrupted",
      })
    } finally {
      await input.cleanup()
    }
  })

test("a known Core value survives missing corroboration, but a disputed source does not become effective known usage", async () => {
  for (const conflict of [false, true]) {
    const input = await fixture({
      core: tokens,
      change: (value) => {
        if (conflict) value.capture.event.identity.sessionID = "wrong"
        else value.capture.event.complete = false
      },
    })
    try {
      const report = await reconcile(input)
      expect(report.rows[0].operations[0]).toMatchObject({
        originalTokens: 5395,
        state: "unresolved",
        effectiveTokens: conflict ? null : 5395,
      })
      expect(report.accountingComplete).toBe(false)
    } finally {
      await input.cleanup()
    }
  }
})

test("retained failure operation snapshots bind supplements without changing failure or interrupted status", async () => {
  const input = await fixture({ failure: true })
  try {
    const report = await reconcile(input)
    expect(report.totals.supplementalTokens).toBe(5395)
    expect(report.rows[0]).toMatchObject({
      status: "infrastructure_failure",
      resultHash: input.resultHash,
      retainedHash: input.retainedHash,
    })
    expect(report.rows[0].operations[0]).toMatchObject({ executionStatus: "interrupted", state: "supplement" })
    const sidecar = await Bun.file(path.join(input.output, "reconciliation.json")).json()
    expect(sidecar.facts[0].operationSource).toMatchObject({ hash: input.retainedHash, pointer: "/partial/0/value/0" })
  } finally {
    await input.cleanup()
  }
})

test("conflicting failure snapshots and missing operation snapshots remain unresolved", async () => {
  for (const noOperations of [false, true]) {
    const input = await fixture({ failure: true, conflictingSnapshot: !noOperations, noOperations })
    try {
      const report = await reconcile(input)
      expect(report.totals.supplementalTokens).toBe(0)
      expect(report.accountingComplete).toBe(false)
      if (noOperations) {
        expect(report.rows[0].operations).toEqual([])
        expect(report.rows[0].unassignedTransport.length).toBeGreaterThan(0)
      } else
        expect(report.rows[0].operations[0]).toMatchObject({
          reason: "operation_snapshot_conflict",
          effectiveTokens: null,
        })
    } finally {
      await input.cleanup()
    }
  }
})

test("operations only in retained failure evidence remain visible and cannot imply complete accounting", async () => {
  for (const core of [undefined, tokens]) {
    for (const noOperations of [false, true]) {
      const input = await fixture({ failure: true, core, noOperations, retainedOnly: ["tool", "provider"] })
      try {
        const report = await reconcile(input)
        const extra = report.rows[0].operations.filter((item) => item.operationID.startsWith("retained-only-"))
        expect(extra).toHaveLength(2)
        for (const [index, item] of extra.entries())
          expect(item).toMatchObject({
            state: "unresolved",
            reason: "operation_missing_from_failure_snapshot",
            originalTokens: null,
            originalUsage: null,
            effectiveTokens: null,
            executionStatus: "interrupted",
            operationSource: { hash: input.evidenceHash, pointer: `/operations/${index + (noOperations ? 0 : 1)}` },
            operation: { usage: { state: core ? "reported" : "unknown" } },
          })
        expect(report.tokenReconciliationComplete).toBe(false)
        expect(report.totals.unknownOperations).toBeGreaterThanOrEqual(2)
        expect(report.totals.originalKnownTokens).toBe(core && !noOperations ? 5395 : 0)
        const sidecar = await Bun.file(path.join(input.output, "reconciliation.json")).json()
        expect(
          sidecar.unresolved.filter(
            (item: { reason: string }) => item.reason === "operation_missing_from_failure_snapshot",
          ),
        ).toHaveLength(2)
      } finally {
        await input.cleanup()
      }
    }
  }
})

test("altered objects and mismatched event-chain identities fail before publishing derived evidence", async () => {
  for (const target of ["result", "transport", "evidence", "chain"]) {
    const input = await fixture()
    try {
      const file =
        target === "result"
          ? path.join(input.directory, "objects", input.resultHash)
          : target === "chain"
            ? path.join(input.directory, "events.jsonl")
            : path.join(
                input.directory,
                "instance",
                "archive",
                "objects",
                target === "transport" ? input.transportHash : input.evidenceHash,
              )
      await Bun.write(file, (await Bun.file(file).text()) + " ")
      if (target === "chain")
        await Bun.write(file, (await Bun.file(file).text()).replace('"id":"instance"', '"id":"other"'))
      await expect(reconcile(input)).rejects.toThrow()
      expect(await Bun.file(path.join(input.output, "report.json")).exists()).toBe(false)
    } finally {
      await input.cleanup()
    }
  }
})

test("output must be a new directory outside the original tree, including symlinks", async () => {
  const input = await fixture()
  try {
    await expect(reconcile({ ...input, output: path.join(input.directory, "derived") })).rejects.toThrow("outside")
    await symlink(input.directory, path.join(input.root, "alias"))
    await expect(reconcile({ ...input, output: path.join(input.root, "alias", "derived") })).rejects.toThrow("outside")
    await mkdir(input.output)
    await expect(reconcile(input)).rejects.toThrow()
  } finally {
    await input.cleanup()
  }
})

test("strict SSE completion and integer usage reject partial or conflicting provider claims", () => {
  for (const body of [
    stream().slice(0, -2),
    frame({ type: "response.incomplete", response: { id: "response", status: "incomplete", usage } }),
    frame({ type: "response.failed", response: { id: "response", status: "failed", usage } }),
    stream() + frame({ type: "response.completed", response: { id: "response", status: "completed", usage } }),
    frame({ type: "response.created", response: { id: "other" } }) + stream(),
    "data: not-json\n\n",
    ...[-1, 5395.5, 0, Number.MAX_SAFE_INTEGER + 1].map((total_tokens) =>
      frame({
        type: "response.completed",
        response: { id: "response", status: "completed", usage: { ...usage, total_tokens } },
      }),
    ),
    frame({
      type: "response.completed",
      response: {
        id: "response",
        status: "completed",
        usage: { ...usage, output_tokens_details: { reasoning_tokens: 803 } },
      },
    }),
  ])
    expect(terminalUsage({ ...sample().capture.event, body: Buffer.from(body).toString("base64") }).state).toBe(
      "unresolved",
    )
  const capture = sample().capture.event
  capture.body = Buffer.from(stream().replaceAll("\n", "\r\n")).toString("base64")
  expect(terminalUsage(capture)).toMatchObject({ state: "reported", usage: tokens })
  capture.body = Buffer.from(
    JSON.stringify({ type: "response.completed", response: { id: "response", status: "completed", usage } }, null, 2)
      .split("\n")
      .map((line) => "data: " + line)
      .join("\n") + "\n\n",
  ).toString("base64")
  expect(terminalUsage(capture)).toMatchObject({ state: "reported", usage: tokens })
})

test("Chat Completions requires final usage and DONE and shares inclusive token semantics", () => {
  const body =
    frame({ id: "chat", object: "chat.completion.chunk", choices: [{ finish_reason: "stop" }] }) +
    frame({
      id: "chat",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })
  expect(
    terminalUsage({ ...sample().capture.event, body: Buffer.from(body + "data: [DONE]\n\n").toString("base64") }),
  ).toMatchObject({
    state: "reported",
    protocol: "chat",
    usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadInputTokens: 8, reasoningTokens: 2 },
  })
  expect(terminalUsage({ ...sample().capture.event, body: Buffer.from(body).toString("base64") }).state).toBe(
    "unresolved",
  )
})

test("lifecycle cohort usage retains interrupted state and separates the same source-bound supplement", async () => {
  const input = await fixture({ evaluation: "repair-lifecycle-v1" })
  try {
    const report = await reconcile(input)
    expect(report.totals.supplementalTokens).toBe(5395)
    expect(report.totals.effectiveKnownTokens).toBe(5395)
    expect(report.rows[0].operations[0].executionStatus).toBe("interrupted")
    expect(report.totals.cost).toBeNull()
  } finally {
    await input.cleanup()
  }
})
