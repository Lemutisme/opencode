import { expect, test } from "bun:test"
import { ProContractTrajectory } from "../src/pro-contract/trajectory"
import { Hash } from "../src/util/hash"

const output = "\u001b[31merror\u001b[0m\r\n中文\u0000raw\n"

function user(id = "msg_user", text = "Compare the observed CLI behavior") {
  return { type: "user", id, text, time: { created: 10 } }
}

function assistant(content: unknown[], id = "msg_assistant") {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { id: "fixed-model", providerID: "test" },
    content,
    time: { created: 20, completed: 40 },
    cost: 0.125,
    tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 50, write: 0 } },
    finish: "tool-calls",
  }
}

function tool(status: "completed" | "error" = "completed") {
  return {
    type: "tool",
    id: "call_probe",
    name: "bash",
    provider: { executed: false, metadata: { hidden: "PROVIDER_SECRET" } },
    time: { created: 21, ran: 22, completed: 39 },
    state: {
      status,
      input: { command: "printf '\\0'; exit 2", description: "Probe one boundary" },
      content: [{ type: "text", text: output }],
      structured: { private: "STRUCTURED_SECRET" },
      result: { opaque: "RESULT_SECRET" },
      error: status === "error" ? { type: "unknown", message: "Invalid tool input" } : undefined,
    },
  }
}

function snapshot(messages: unknown[] = [user(), assistant([tool()])]) {
  return {
    version: 2,
    contract: {
      id: "pct_task",
      revision: 1,
      scope: "ordinary-task",
      status: "verification",
      specHash: Hash.sha256("exact task"),
      spec: {
        goal: "Reproduce documented behavior",
        brief: "Deliver a program and recorded probes",
        budget: { deadline: 60_000 },
        requires: [],
        evidence: { claim: "A frozen delivery, not exhaustive correctness", replay: { private: "EVALUATOR_SECRET" } },
      },
      handoff: {
        subjectHash: Hash.sha256("candidate"),
        summary: "The local probes passed",
        uncertainties: ["Unobserved interactions remain"],
        time: 42,
      },
    },
    execution: {
      contractID: "pct_task",
      revision: 1,
      sessionID: "ses_native",
      promptID: "msg_user",
      turnsUsed: 1,
      actionsUsed: 1,
      executionPolicy: "Investigate discriminating observations",
      model: { id: "fixed-model", providerID: "test" },
      leaseOwner: "PRIVATE_EXECUTOR_STATE",
    },
    messages: { data: messages },
    sessionMessageCount: messages.length,
    evaluation: { hiddenTests: "HIDDEN_TEST_SECRET" },
  }
}

function project(
  value: unknown,
  options: Omit<ProContractTrajectory.Input, "source" | "sourceID" | "sourceHash"> = {},
) {
  const source = JSON.stringify(value)
  return ProContractTrajectory.project({
    source,
    sourceID: "authorized-archive/native.json",
    sourceHash: Hash.sha256(source),
    ...options,
  })
}

test("projects actual native coordinates, exact public tool bytes, status, time and usage without inferring success", () => {
  const packet = project(snapshot())
  expect(packet.capture).toBe("complete")
  expect(packet.contract).toMatchObject({ id: "pct_task", revision: 1, status: "verification" })
  expect(packet.scope).toMatchObject({
    sourceMessages: 2,
    sourceCompleteness: "declared-complete",
    selectedPublicRecords: 2,
  })
  expect(packet.index[1].usage).toEqual({
    cost: 0.125,
    tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 50, write: 0 } },
  })
  expect(packet.records[1]).toMatchObject({
    id: "msg_assistant:0",
    messageID: "msg_assistant",
    messageOrder: 1,
    contentOrder: 0,
    partID: "call_probe",
    time: { created: 21, ran: 22, completed: 39 },
    tool: {
      status: "completed",
      output: "recorded",
      interpretation: "unverified-observation",
      content: [
        {
          order: 0,
          text: {
            status: "complete",
            text: output,
            bytes: Buffer.byteLength(output),
            hash: Hash.sha256(output),
            encoding: "utf8",
          },
        },
      ],
    },
  })
  expect(JSON.stringify(packet)).not.toContain("targetExecution")
  expect(packet.purpose).toBe("development-only")
  expect(packet.scope.interpretation).toBe("unverified-observations")
})

test("never projects hidden reasoning, provider metadata, system/private payloads or external evaluator data", () => {
  const packet = project(
    snapshot([
      { ...user(), metadata: { private: "USER_METADATA_SECRET" } },
      { id: "msg_system", type: "system", time: { created: 11 }, text: "SYSTEM_SECRET" },
      {
        id: "msg_compaction",
        type: "compaction",
        time: { created: 12 },
        summary: "COMPACTION_SECRET",
        recent: "RECENT_SECRET",
      },
      assistant([
        {
          type: "reasoning",
          id: "reasoning_0",
          text: "REASONING_SECRET",
          providerMetadata: { openai: { reasoningEncryptedContent: "ENCRYPTED_SECRET" } },
        },
        { ...tool(), providerMetadata: { secret: "EXTRA_PROVIDER_SECRET" } },
        {
          type: "text",
          id: "text_0",
          text: "Public conclusion",
          providerMetadata: { secret: "PUBLIC_PART_METADATA_SECRET" },
        },
      ]),
    ]),
  )
  expect(JSON.stringify(packet)).not.toContain("SECRET")
  expect(packet.records).toHaveLength(3)
  expect(packet.records[1].contentOrder).toBe(1)
  expect(packet.records[2].text).toMatchObject({ status: "complete", text: "Public conclusion" })
  expect(packet.index[1]).toMatchObject({ visibility: "excluded", records: 0 })
})

test("redacts nested provider-private envelopes in tool inputs and reports the loss rather than claiming exact capture", () => {
  const call = tool()
  const packet = project(
    snapshot([
      user(),
      assistant([
        {
          ...call,
          state: {
            ...call.state,
            input: {
              command: "probe",
              nested: [
                {
                  reasoningEncryptedContent: "NESTED_SECRET",
                  providerMetadata: { secret: "NESTED_SECRET" },
                  reasoning: "NESTED_SECRET",
                  ordinary: 1,
                },
              ],
            },
          },
        },
      ]),
    ]),
  )
  expect(packet.capture).toBe("truncated")
  expect(packet.records[1].tool?.input).toMatchObject({
    status: "redacted",
    omitted: 3,
    encoding: "canonical-json",
    text: '{"command":"probe","nested":[{"ordinary":1}]}',
  })
  expect(JSON.stringify(packet)).not.toContain("NESTED_SECRET")
})

test("source and packet hashes bind exact bytes and changed projections", () => {
  const source = JSON.stringify(snapshot())
  expect(() =>
    ProContractTrajectory.project({ source: source + " ", sourceID: "archive", sourceHash: Hash.sha256(source) }),
  ).toThrow("source hash mismatch")
  const packet = project(snapshot())
  expect(packet.hash).toBe(
    Hash.sha256(JSON.stringify(Object.fromEntries(Object.entries(packet).filter(([key]) => key !== "hash")))),
  )
  expect(project(snapshot())).toEqual(packet)
  expect(project(snapshot(), { selection: { limit: 1 } }).hash).not.toBe(packet.hash)
})

test("message selection preserves archive order and an index without flooding the selected context", () => {
  const source = snapshot([user(), assistant([tool()]), { ...user("msg_last", "Another task"), time: { created: 1 } }])
  const full = project(source)
  const selected = project(source, { selection: { messageIDs: ["msg_last", "msg_user"] } })
  expect(selected.records.map((record) => record.messageID)).toEqual(["msg_user", "msg_last"])
  expect(selected.index.map((entry) => entry.order)).toEqual([0, 1, 2])
  expect(selected.index[1]).toMatchObject({ records: 1, selected: false })
  expect(selected.records[0].hash).toBe(full.records[0].hash)
  expect(project(source, { selection: { offset: 1, limit: 1 } }).records.map((record) => record.messageID)).toEqual([
    "msg_assistant",
  ])
  expect(project(source, { selection: { limit: 0 } }).records).toEqual([])
})

test("rejects unknown, duplicate, negative or out-of-range requested identities/windows", () => {
  expect(() => project(snapshot(), { selection: { messageIDs: ["msg_missing"] } })).toThrow("selected message identity")
  expect(() => project(snapshot(), { selection: { messageIDs: ["msg_user", "msg_user"] } })).toThrow(
    "selected message identity",
  )
  expect(() => project(snapshot(), { selection: { offset: -1 } })).toThrow("invalid message window")
  expect(() => project(snapshot(), { selection: { offset: 3 } })).toThrow("invalid message window")
})

test("rejects forged identities and mismatched execution coordinates", () => {
  const source = snapshot()
  expect(() => project({ ...source, execution: { ...source.execution, contractID: "pct_other" } })).toThrow(
    "inconsistent Contract",
  )
  expect(() => project({ ...source, execution: { ...source.execution, revision: 2 } })).toThrow("inconsistent Contract")
  expect(() => project({ ...source, sessionID: "ses_other" })).toThrow("inconsistent Session")
  expect(() => project(snapshot([{ ...user(), sessionID: "ses_other" }]))).toThrow("another Session")
  expect(() => project(snapshot([user(), user()]))).toThrow("duplicate message")
  expect(() => project(snapshot([assistant([{ ...tool(), messageID: "msg_other" }])]))).toThrow("forged part")
})

test("native provider part identities are message-and-type local, not globally unique", () => {
  const source = snapshot([
    user(),
    assistant([
      { type: "text", id: "0", text: "First public text" },
      { type: "text", id: "0", text: "Next fragment with reused provider ID" },
      { type: "reasoning", id: "0", text: "EXCLUDED_SECRET" },
    ]),
    assistant([{ type: "text", id: "0", text: "Second public text" }], "msg_next"),
  ])
  const packet = project(source)
  expect(packet.records.map((record) => record.id)).toEqual([
    "msg_user:user",
    "msg_assistant:0",
    "msg_assistant:1",
    "msg_next:0",
  ])
  expect(JSON.stringify(packet)).not.toContain("EXCLUDED_SECRET")
})

test("tool errors remain observations and malformed public records fail closed without echoing secret data", () => {
  expect(project(snapshot([user(), assistant([tool("error")])])).records[1].tool).toMatchObject({
    status: "error",
    error: { text: "Invalid tool input" },
    output: "recorded",
  })
  expect(() => project(snapshot([assistant([{ ...tool(), state: { status: "error", input: {} } }])]))).toThrow(
    "missing tool error",
  )
  expect(() =>
    project(snapshot([assistant([{ ...tool(), state: { status: "completed", input: "SECRET" } }])])),
  ).toThrow("malformed tool input")
  expect(() => project(snapshot([assistant([{ type: "text", id: "text", text: { secret: "SECRET" } }])]))).toThrow(
    "malformed native public record",
  )
  expect(() => project(snapshot([{ ...user(), id: "forged" }]))).toThrow("malformed native public record")
})

test("field and record limits expose unavailable hashes and truncation without partial or fabricated output", () => {
  const source = snapshot([user(), assistant([{ type: "text", id: "large", text: "X".repeat(100) }])])
  const packet = project(source, { limits: { fieldBytes: 64 } })
  expect(packet.records[1].text).toEqual({
    status: "unavailable",
    reason: "field-byte-guard",
    bytes: 100,
    hash: Hash.sha256("X".repeat(100)),
    encoding: "utf8",
  })
  expect(packet.capture).toBe("truncated")
  const capped = project(source, { limits: { records: 1 } })
  expect(capped.records).toHaveLength(1)
  expect(capped.scope).toMatchObject({ availablePublicRecords: 2, selectedPublicRecords: 2 })
  expect(capped.capture).toBe("truncated")
  expect(capped.records[0].hash).toBe(project(source).records[0].hash)
})

test("oversized execution policies are included in aggregate capture status", () => {
  const source = snapshot()
  const packet = project(
    { ...source, execution: { ...source.execution, executionPolicy: "X".repeat(500) } },
    { limits: { fieldBytes: 100 } },
  )
  expect(packet.execution?.executionPolicy?.status).toBe("unavailable")
  expect(packet.capture).toBe("truncated")
})

test("pending arguments, pruned outputs and non-text payloads never masquerade as complete observed results", () => {
  const call = tool()
  const packet = project(
    snapshot([
      user(),
      assistant([
        {
          ...call,
          id: "pending",
          state: { status: "pending", input: '{"reasoningEncryptedContent":"PENDING_SECRET"' },
        },
        { ...call, id: "pruned", time: { ...call.time, pruned: 50 } },
        {
          ...call,
          id: "file",
          state: { ...call.state, content: [{ type: "file", uri: "file:///FILE_SECRET", mime: "image/png" }] },
        },
      ]),
    ]),
  )
  expect(packet.capture).toBe("truncated")
  expect(packet.records[1].tool).toMatchObject({
    output: "pending",
    input: { status: "unavailable", reason: "pending-input-unparsed" },
  })
  expect(packet.records[2].tool?.output).toBe("unavailable")
  expect(packet.records[3].tool?.content).toEqual([{ order: 0, status: "unavailable", reason: "non-text-output" }])
  expect(JSON.stringify(packet)).not.toContain("SECRET")
  expect(() =>
    project(snapshot([assistant([{ ...call, state: { status: "pending", input: "{}", content: [] } }])])),
  ).toThrow("malformed pending tool input")
})

test("selected Session sources distinguish unknown source completeness from a declared full transcript", () => {
  const packet = project({ sessionID: "ses_selected", messages: { data: [user()] } })
  expect(packet.scope.sourceCompleteness).toBe("unknown")
  expect(packet.contract).toBeUndefined()
  expect(packet.execution).toBeUndefined()
  expect(project({ ...snapshot(), sessionMessageCount: 3 }).scope.sourceCompleteness).toBe("partial")
  expect(() => project({ ...snapshot(), sessionMessageCount: 1 })).toThrow("inconsistent message count")
})

test("source/message/output operation guards and malformed JSON fail explicitly unavailable", () => {
  expect(() => project(snapshot(), { limits: { sourceBytes: 1 } })).toThrow("source byte guard")
  expect(() => project(snapshot(), { limits: { messages: 1 } })).toThrow("message count guard")
  expect(() => project(snapshot(), { limits: { outputBytes: 1 } })).toThrow("output byte guard")
  expect(() => project(snapshot(), { limits: { records: 0 } })).toThrow("invalid operation guard")
  expect(() =>
    ProContractTrajectory.project({ source: "{", sourceID: "archive", sourceHash: Hash.sha256("{") }),
  ).toThrow("malformed source JSON")
})
