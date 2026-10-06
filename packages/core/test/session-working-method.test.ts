import { expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { SessionWorkingMethod } from "../src/session/working-method"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const id = SessionSchema.ID.make("ses_learning")
const context = { sessionID: id, assistantMessageID: SessionMessage.ID.make("msg_current"), toolCallID: "learn" }
function assistant(
  messageID: string,
  name = "bash",
  status: "completed" | "error" | "running" = "completed",
  text = "expected 1; actual 2",
) {
  return Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: messageID,
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "test" },
    time: { created: 1, completed: 2 },
    content: [
      { type: "reasoning", id: "private", text: "PRIVATE_REASONING" },
      {
        type: "tool",
        id: "probe",
        name,
        provider: { executed: false, metadata: { test: { secret: "PRIVATE_METADATA" } } },
        time: { created: 1, completed: 2 },
        state: {
          status,
          input: { command: "probe" },
          structured: { exit: 1, truncated: true, timeout: false, secret: "PRIVATE_STRUCTURED" },
          content: [{ type: "text", text }],
          ...(status === "error" ? { error: { type: "unknown", message: "PUBLIC_ERROR" } } : {}),
        },
      },
    ],
  })
}
const witness = assistant("msg_witness")
const evidence = {
  messageID: witness.id,
  callID: "probe",
  channel: "content" as const,
  block: 0,
  hash: Hash.sha256("expected 1; actual 2"),
  quote: "actual 2",
}
const revision = {
  action: "revise" as const,
  expectedRevision: 0,
  condition: "When a universal claim rests on one observation",
  previous: "Generalize directly",
  change: "Try a cheap boundary contrast before implementation",
  expectation: "Find scope errors before committing to the rule",
  reconsiderWhen: "The contrast cannot change an action",
  reason: "A recorded counterexample contradicts the broad rule",
  evidence: [evidence],
}
const insert = (message: SessionMessage.Message, seq: number, sessionID = id) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(SessionMessageTable)
      .values({
        session_id: sessionID,
        seq,
        id: message.id,
        type: message.type,
        data: Schema.encodeSync(SessionMessage.Message)(message),
      })
      .run()
      .pipe(Effect.orDie)
  })
const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values([
      {
        id,
        project_id: Project.ID.global,
        slug: "learning",
        directory: "/project",
        title: "learning",
        version: "test",
      },
      {
        id: SessionSchema.ID.make("ses_other"),
        project_id: Project.ID.global,
        slug: "other",
        directory: "/project",
        title: "other",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* insert(witness, 1)
  yield* insert(assistant("msg_current", "working_method"), 10)
  return yield* SessionWorkingMethod.Service
})
// Stage the actual called-event shape before invoking the domain, as SessionRunner does.
const update = (
  methods: SessionWorkingMethod.Interface,
  invocation: SessionWorkingMethod.Invocation,
  input: typeof SessionWorkingMethod.Revise.Type | typeof SessionWorkingMethod.Retract.Type,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.Service
    const database = yield* Database.Service
    const stored = yield* sessions.message(invocation.assistantMessageID)
    if (stored?.message.type !== "assistant") throw new Error("Missing fixture assistant")
    if (!stored.message.content.some((part) => part.type === "tool" && part.id === invocation.toolCallID)) {
      const message = {
        ...stored.message,
        content: [
          ...stored.message.content,
          {
            type: "tool" as const,
            id: invocation.toolCallID,
            name: SessionWorkingMethod.toolName,
            time: { created: DateTime.makeUnsafe(2) },
            state: { status: "running" as const, input, structured: {}, content: [] },
          },
        ],
      }
      yield* database.db
        .update(SessionMessageTable)
        .set({ data: Schema.encodeSync(SessionMessage.Assistant)(message) })
        .where(eq(SessionMessageTable.id, invocation.assistantMessageID))
        .run()
        .pipe(Effect.orDie)
    }
    return yield* methods.update(invocation, input)
  })
async function run<A, E>(
  body: Effect.Effect<A, E, SessionWorkingMethod.Service | SessionStore.Service | Database.Service | Global.Service>,
) {
  await using directory = await tmpdir()
  return Effect.runPromise(
    body.pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([SessionWorkingMethod.node, SessionStore.node, Database.node, Global.node]),
          [[Global.node, Global.layerWith({ data: directory.path })]],
        ),
      ),
    ),
  )
}

test("catalogue discloses public bodies and allowlisted diagnostics, not reasoning/provider/structured metadata", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const catalog = yield* methods.read(context, { action: "read" })
      expect(catalog).toMatchObject({
        observations: [
          {
            messageID: evidence.messageID,
            hash: evidence.hash,
            warnings: { truncated: true },
            excerpt: "expected 1; actual 2",
          },
          { channel: "diagnostic", excerpt: expect.stringContaining("not-semantic-correctness") },
          { channel: "input", interpretation: "declared-input-not-execution", excerpt: '{"command":"probe"}' },
        ],
      })
      expect(JSON.stringify(catalog)).not.toContain("PRIVATE_")
      const page = yield* methods.read(context, { action: "read", observation: { ...evidence, offset: 0, length: 8 } })
      expect(page).toMatchObject({ observation: { data: "expected", nextOffset: 8, eof: false } })
    }),
  ))

test("a byte-grounded conditional trial becomes active without claiming semantic validity", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      expect(yield* methods.view(id)).toMatchObject({ revision: 0, active: [] })
      const result = yield* update(methods, context, revision)
      expect(result).toMatchObject({
        receipt: { revision: 1, status: "trial-unverified", observations: [{ hash: evidence.hash }] },
        retry: false,
      })
      const view = yield* methods.view(id)
      expect(view.active[0].input).toEqual(revision)
      expect(SessionWorkingMethod.render(view)).toContain("retrospective")
      expect(yield* methods.view(SessionSchema.ID.make("ses_other"))).toMatchObject({ revision: 0, active: [] })
    }),
  ))

test("exact invocation retries are idempotent while changed inputs and stale revisions fail", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      yield* update(methods, context, revision)
      expect(yield* update(methods, context, revision)).toMatchObject({ retry: true, receipt: { revision: 1 } })
      expect(
        (yield* update(methods, context, { ...revision, change: "different" }).pipe(Effect.flip)).message,
      ).toContain("conflicts")
      expect(
        (yield* update(methods, { ...context, toolCallID: "next" }, revision).pipe(Effect.flip)).message,
      ).toContain("changed")
      expect((yield* methods.view(id)).revision).toBe(1)
    }),
  ))

test("concurrent expectedRevision updates serialize with exactly one accepted writer", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const results = yield* Effect.all(
        [
          update(methods, context, revision).pipe(Effect.result),
          update(methods, { ...context, toolCallID: "competitor" }, revision).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.filter((item) => item._tag === "Success")).toHaveLength(1)
      expect((yield* methods.view(id)).revision).toBe(1)
    }),
  ))

test("replacement and retraction preserve history and never resurrect ancestors", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      yield* update(methods, context, revision)
      yield* update(
        methods,
        { ...context, toolCallID: "replace" },
        { ...revision, expectedRevision: 1, replaces: 1, condition: "Narrower condition" },
      )
      expect((yield* methods.view(id)).active.map((entry) => entry.revision)).toEqual([2])
      yield* update(
        methods,
        { ...context, toolCallID: "retract" },
        { action: "retract", expectedRevision: 2, replaces: 2, reason: "No longer useful" },
      )
      expect((yield* methods.view(id)).active).toEqual([])
      expect(yield* methods.read(context, { action: "read", revision: 1 })).toMatchObject({
        receipt: { revision: 1, input: revision },
      })
      expect(yield* methods.read(context, { action: "read", historyOffset: 0 })).toMatchObject({ total: 3 })
      expect(
        (yield* update(
          methods,
          { ...context, toolCallID: "revive" },
          { ...revision, expectedRevision: 3, replaces: 1 },
        ).pipe(Effect.flip)).message,
      ).toContain("active")
    }),
  ))

test("source lookup rejects foreign, current, future, pending, pruned bodies, self metadata and mismatched quotes", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      yield* insert(assistant("msg_foreign"), 1, SessionSchema.ID.make("ses_other"))
      yield* insert(assistant("msg_future"), 11)
      yield* insert(assistant("msg_pending", "bash", "running"), 2)
      yield* insert(assistant("msg_self", "working_method"), 3)
      const pruned = assistant("msg_pruned")
      const tool = pruned.content[1]
      if (tool.type !== "tool") throw new Error("Expected tool")
      yield* insert({ ...pruned, content: [{ ...tool, time: { ...tool.time, pruned: DateTime.makeUnsafe(3) } }] }, 4)
      for (const messageID of ["msg_foreign", "msg_current", "msg_future", "msg_pending", "msg_self", "msg_pruned"]) {
        const failure = yield* update(methods, context, {
          ...revision,
          evidence: [{ ...evidence, messageID: SessionMessage.ID.make(messageID) }],
        }).pipe(Effect.flip)
        expect(failure._tag).toBe("WorkingMethodError")
      }
      expect(
        (yield* update(
          methods,
          { ...context, toolCallID: "bad-quote" },
          { ...revision, evidence: [{ ...evidence, quote: "invented" }] },
        ).pipe(Effect.flip)).message,
      ).toContain("quote")
      expect(
        (yield* update(
          methods,
          { ...context, toolCallID: "bad-hash" },
          { ...revision, evidence: [{ ...evidence, hash: "0".repeat(64) }] },
        ).pipe(Effect.flip)).message,
      ).toContain("bytes changed")
      expect((yield* methods.view(id)).revision).toBe(0)
    }),
  ))

test("execution diagnostics remain usable when bodies are pruned; error display is separately addressable", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const error = assistant("msg_error", "bash", "error")
      yield* insert(error, 2)
      const capture = SessionWorkingMethod.captures(error).find((item) => item.channel === "error")!
      yield* update(methods, context, {
        ...revision,
        evidence: [
          {
            ...evidence,
            messageID: capture.messageID,
            channel: "error",
            hash: capture.hash,
            quote: "PUBLIC_ERROR",
          },
        ],
      })
      expect((yield* methods.view(id)).active[0].observations).toMatchObject([{ channel: "error", status: "error" }])
      const original = assistant("msg_pruned")
      const tool = original.content[1]
      if (tool.type !== "tool") throw new Error("Expected tool")
      const pruned = { ...original, content: [{ ...tool, time: { ...tool.time, pruned: DateTime.makeUnsafe(3) } }] }
      yield* insert(pruned, 3)
      const diagnostic = SessionWorkingMethod.captures(pruned)[0]
      expect(diagnostic.channel).toBe("diagnostic")
      yield* update(
        methods,
        { ...context, toolCallID: "diagnostic" },
        {
          ...revision,
          expectedRevision: 1,
          evidence: [
            {
              ...evidence,
              messageID: diagnostic.messageID,
              channel: "diagnostic",
              hash: diagnostic.hash,
              quote: '"pruned":true',
            },
          ],
        },
      )
    }),
  ))

test("compaction and a fresh service recover method state and exact prior evidence without replay", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      yield* update(methods, context, revision)
      const database = yield* Database.Service
      const sessions = yield* SessionStore.Service
      yield* insert(
        Schema.decodeUnknownSync(SessionMessage.Compaction)({
          id: "msg_compaction",
          type: "compaction",
          reason: "auto",
          summary: "Lossy unrelated summary",
          recent: "",
          time: { created: 3 },
        }),
        5,
      )
      expect((yield* sessions.context(id)).some((entry) => entry.id === witness.id)).toBe(false)
      expect(
        yield* methods.read(context, { action: "read", observation: { ...evidence, offset: 0, length: 100 } }),
      ).toMatchObject({ observation: { data: "expected 1; actual 2" } })
      const global = yield* Global.Service
      const restored = SessionWorkingMethod.make(path.join(global.data, "working-method"), sessions, database.db)
      expect((yield* restored.view(id)).active[0].input).toEqual(revision)
      yield* database.db
        .update(SessionMessageTable)
        .set({
          data: Schema.encodeSync(SessionMessage.Assistant)(assistant("msg_witness", "bash", "completed", "changed")),
        })
        .where(eq(SessionMessageTable.id, witness.id))
        .run()
        .pipe(Effect.orDie)
      expect(
        (yield* update(methods, { ...context, toolCallID: "changed" }, { ...revision, expectedRevision: 1 }).pipe(
          Effect.flip,
        )).message,
      ).toContain("bytes changed")
    }),
  ))

test("long histories have bounded active views and explicit addressable omissions, without update ceilings", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      for (const index of Array.from({ length: 36 }, (_, index) => index)) {
        yield* update(
          methods,
          { ...context, toolCallID: `learn-${index}` },
          { ...revision, expectedRevision: index, change: "x".repeat(2048) },
        )
      }
      const view = yield* methods.view(id)
      expect(view.revision).toBe(36)
      expect(view.omittedCount).toBeGreaterThan(0)
      expect(view.active.length + view.omittedCount).toBe(36)
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(18 * 1024)
      expect(yield* methods.read(context, { action: "read", revision: view.omitted[0] })).toMatchObject({
        receipt: { revision: view.omitted[0] },
      })
    }),
  ))

test("staged and committed revert suppress detached trials without resurrecting their ancestors", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const database = yield* Database.Service
      yield* update(methods, context, revision)
      yield* insert(assistant("msg_later", "working_method"), 20)
      yield* update(
        methods,
        { ...context, assistantMessageID: SessionMessage.ID.make("msg_later") },
        { ...revision, expectedRevision: 1, replaces: 1 },
      )
      yield* database.db
        .update(SessionTable)
        .set({ revert: { messageID: witness.id } })
        .where(eq(SessionTable.id, id))
        .run()
        .pipe(Effect.orDie)
      expect(yield* methods.view(id)).toMatchObject({ active: [], suppressed: [1, 2], suppressedCount: 2 })
      yield* database.db
        .update(SessionTable)
        .set({ revert: null })
        .where(eq(SessionTable.id, id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* methods.view(id)).active.map((entry) => entry.revision)).toEqual([2])
      yield* database.db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_later")))
        .run()
        .pipe(Effect.orDie)
      expect(yield* methods.view(id)).toMatchObject({ active: [], suppressed: [2] })
      expect(
        (yield* update(
          methods,
          { ...context, toolCallID: "detached" },
          { ...revision, expectedRevision: 2, replaces: 2 },
        ).pipe(Effect.flip)).message,
      ).toContain("active")
      expect(yield* methods.read(context, { action: "read", revision: 2 })).toMatchObject({ receipt: { revision: 2 } })
    }),
  ))

test("deleted or recreated Session identities cannot adopt an orphaned learning ledger", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const database = yield* Database.Service
      const sessions = yield* SessionStore.Service
      yield* update(methods, context, revision)
      const session = (yield* sessions.get(id))!
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
      expect((yield* methods.view(id).pipe(Effect.flip)).message).toContain("does not exist")
      yield* database.db
        .insert(SessionTable)
        .values({
          id,
          project_id: Project.ID.global,
          slug: "recreated",
          directory: "/project",
          title: "recreated",
          version: "test",
          time_created: DateTime.toEpochMillis(session.time.created) + 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect((yield* methods.view(id).pipe(Effect.flip)).message).toContain("another Session")
    }),
  ))

test("malformed persisted learning fails closed instead of becoming empty state", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const global = yield* Global.Service
      yield* update(methods, context, revision)
      yield* Effect.promise(() => Bun.write(path.join(global.data, "working-method", Hash.sha256(id) + ".json"), "{}"))
      expect((yield* methods.view(id).pipe(Effect.flip))._tag).toBe("WorkingMethodError")
    }),
  ))

test("Unicode observation catalogues fit serialized bounds and page all captures without hiding conditions", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      for (const index of Array.from({ length: 8 }, (_, index) => index)) {
        yield* update(
          methods,
          { ...context, toolCallID: `large-${index}` },
          { ...revision, expectedRevision: index, change: "中🙂".repeat(300) },
        )
      }
      const original = assistant("msg_many")
      const tool = original.content[1]
      if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed tool")
      yield* insert(
        {
          ...original,
          content: [
            {
              ...tool,
              state: {
                ...tool.state,
                content: Array.from({ length: 40 }, (_, index) => ({
                  type: "text" as const,
                  text: `${index}:` + "中🙂".repeat(500),
                })),
              },
            },
          ],
        },
        4,
      )
      const decode = Schema.decodeUnknownSync(
        Schema.Struct({
          observations: Schema.Array(Schema.Struct({ channel: Schema.String, block: Schema.Number })),
          nextCaptureOffset: Schema.Number,
          totalCaptures: Schema.Number,
        }),
      )
      const offsets = { value: 0 }
      const seen: string[] = []
      while (true) {
        const response = yield* methods.read(context, {
          action: "read",
          messageID: original.id,
          captureOffset: offsets.value,
        })
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(40 * 1024)
        const page = decode(response)
        seen.push(...page.observations.map((capture) => `${capture.channel}:${capture.block}`))
        expect(page.nextCaptureOffset).toBeGreaterThan(offsets.value)
        if (page.nextCaptureOffset === page.totalCaptures) break
        offsets.value = page.nextCaptureOffset
      }
      expect(new Set(seen).size).toBe(42)
      expect(seen).toContain("input:0")
      const output = SessionWorkingMethod.captures({
        ...original,
        content: [{ ...tool, state: { ...tool.state, content: [{ type: "text", text: "中🙂" }] } }],
      })[0]
      yield* insert(
        {
          ...original,
          id: SessionMessage.ID.make("msg_unicode"),
          content: [{ ...tool, state: { ...tool.state, content: [{ type: "text", text: "中🙂" }] } }],
        },
        5,
      )
      expect(
        yield* methods.read(context, {
          action: "read",
          observation: {
            ...evidence,
            messageID: SessionMessage.ID.make("msg_unicode"),
            hash: output.hash,
            offset: 1,
            length: 1,
          },
        }),
      ).toMatchObject({ observation: { encoding: "base64" } })
    }),
  ))

test("public JSON-only output is readable but private structured metadata and input are not outcome evidence", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const original = assistant("msg_json")
      const tool = original.content[1]
      if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed tool")
      const message = {
        ...original,
        content: [{ ...tool, state: { ...tool.state, content: [], structured: { expected: 1, actual: 2 } } }],
      }
      yield* insert(message, 2)
      const observed = SessionWorkingMethod.captures(message)
      const output = observed.find((item) => item.channel === "structured")!
      expect(output.text).toBe('{"expected":1,"actual":2}')
      yield* update(methods, context, {
        ...revision,
        evidence: [
          { ...evidence, messageID: message.id, channel: "structured", hash: output.hash, quote: '"actual":2' },
        ],
      })
      expect(SessionWorkingMethod.captures(witness).some((item) => item.channel === "structured")).toBe(false)
      expect(Schema.is(SessionWorkingMethod.Evidence)({ ...evidence, channel: "input" })).toBe(false)
      const provider = { ...message, content: [{ ...message.content[0], provider: { executed: true } }] }
      expect(SessionWorkingMethod.captures(provider).some((item) => item.channel === "structured")).toBe(false)
    }),
  ))

test("blank/malformed learning text fails while empty observation bodies remain distinct from absent", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      expect((yield* update(methods, context, { ...revision, change: "  " }).pipe(Effect.flip)).message).toContain(
        "nonblank",
      )
      expect(
        (yield* update(methods, context, { ...revision, reason: "bad\ud800" }).pipe(Effect.flip)).message,
      ).toContain("well-formed")
      const empty = assistant("msg_empty", "bash", "completed", "")
      const observed = SessionWorkingMethod.captures(empty)
      expect(observed[0]).toMatchObject({ channel: "content", text: "", bytes: 0 })
      expect(observed.find((item) => item.channel === "diagnostic")?.text).toContain('"emptyTextBlocks":1')
    }),
  ))

test("mutations require their exact local recorded running invocation; only recorded retries survive settlement", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const database = yield* Database.Service
      const prepare = (
        input: typeof revision,
        status: "running" | "completed" = "running",
        name = "working_method",
        executed = false,
      ) =>
        Effect.gen(function* () {
          const original = assistant("msg_current")
          const message = {
            ...original,
            content: [
              {
                type: "tool" as const,
                id: context.toolCallID,
                name,
                provider: { executed },
                time: { created: DateTime.makeUnsafe(2) },
                state: { status, input, structured: {}, content: [] },
              },
            ],
          }
          yield* database.db
            .update(SessionMessageTable)
            .set({ data: Schema.encodeSync(SessionMessage.Assistant)(message) })
            .where(eq(SessionMessageTable.id, context.assistantMessageID))
            .run()
            .pipe(Effect.orDie)
        })
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("exact local running")
      yield* prepare({ ...revision, change: "Different recorded operation" })
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("differs")
      yield* prepare(revision, "completed")
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("exact local running")
      yield* prepare(revision, "running", "another_tool")
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("exact local running")
      yield* prepare(revision, "running", "working_method", true)
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("exact local running")
      yield* prepare(revision)
      expect(yield* methods.update(context, revision)).toMatchObject({ retry: false })
      yield* prepare(revision, "completed")
      expect(yield* methods.update(context, revision)).toMatchObject({ retry: true })
      expect((yield* methods.view(id)).revision).toBe(1)
      yield* prepare({ ...revision, change: "Changed after settlement" }, "completed")
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("differs")
    }),
  ))

test("admitted public user feedback grounds an explicitly unverified trial without invented tool identity", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const feedback = Schema.decodeUnknownSync(SessionMessage.User)({
        id: "msg_correction",
        type: "user",
        time: { created: 3 },
        text: "You treated a tentative premise as established. Separate assumptions from proved claims.",
        files: [{ uri: "file:///PRIVATE_ATTACHMENT", mime: "text/plain", description: "PRIVATE_DESCRIPTION" }],
        metadata: { secret: "PRIVATE_USER_METADATA" },
      })
      yield* insert(feedback, 3)
      const reference = { messageID: feedback.id, channel: "user" as const, block: 0, hash: Hash.sha256(feedback.text) }
      const catalog = yield* methods.read(context, { action: "read", messageID: feedback.id })
      expect(catalog).toMatchObject({
        observations: [
          {
            ...reference,
            interpretation: "user-feedback-statement-not-independent-verification",
            excerpt: feedback.text,
          },
        ],
      })
      expect(JSON.stringify(catalog)).not.toContain("PRIVATE_")
      const projected = Schema.decodeUnknownSync(
        Schema.Struct({ observations: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
      )(catalog)
      expect(projected.observations[0]).not.toHaveProperty("callID")
      expect(projected.observations[0]).not.toHaveProperty("tool")
      expect(
        yield* methods.read(context, { action: "read", observation: { ...reference, offset: 0, length: 1000 } }),
      ).toMatchObject({ observation: { data: feedback.text, eof: true } })
      yield* update(methods, context, {
        ...revision,
        condition: "When presenting a proof with tentative premises",
        change: "Label assumptions and separately check any step depending on them",
        evidence: [{ ...reference, quote: "Separate assumptions" }],
      })
      expect((yield* methods.view(id)).active[0]).toMatchObject({
        status: "trial-unverified",
        observations: [{ channel: "user", interpretation: "user-feedback-statement-not-independent-verification" }],
      })
      expect(
        Schema.is(SessionWorkingMethod.Evidence)({ ...reference, callID: "fabricated", quote: "Separate assumptions" }),
      ).toBe(false)
      expect(Schema.is(SessionWorkingMethod.Evidence)({ ...reference, block: 1, quote: "Separate assumptions" })).toBe(
        false,
      )
      expect(Schema.is(SessionWorkingMethod.Evidence)({ ...evidence, callID: undefined })).toBe(false)
    }),
  ))

test("user evidence rejects future, foreign, missing, pending, system and empty-body false witnesses", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const database = yield* Database.Service
      const make = (messageID: string, text = "Please distinguish assumptions from evidence") =>
        Schema.decodeUnknownSync(SessionMessage.User)({ id: messageID, type: "user", time: { created: 3 }, text })
      const future = make("msg_future_feedback")
      const foreign = make("msg_foreign_feedback")
      const empty = make("msg_empty_feedback", "")
      yield* insert(future, 11)
      yield* insert(foreign, 1, SessionSchema.ID.make("ses_other"))
      yield* insert(empty, 3)
      yield* insert(
        Schema.decodeUnknownSync(SessionMessage.System)({
          id: "msg_system_feedback",
          type: "system",
          time: { created: 4 },
          text: future.text,
        }),
        4,
      )
      yield* database.db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_pending_feedback"),
          session_id: id,
          prompt: { text: future.text },
          delivery: "queue",
          admitted_seq: 9,
        })
        .run()
        .pipe(Effect.orDie)
      for (const messageID of [
        future.id,
        foreign.id,
        "msg_missing_feedback",
        "msg_pending_feedback",
        "msg_system_feedback",
        witness.id,
      ]) {
        expect(
          (yield* update(
            methods,
            { ...context, toolCallID: `feedback-${messageID}` },
            {
              ...revision,
              evidence: [
                {
                  messageID: SessionMessage.ID.make(messageID),
                  channel: "user",
                  block: 0,
                  hash: Hash.sha256(future.text),
                  quote: "assumptions",
                },
              ],
            },
          ).pipe(Effect.flip))._tag,
        ).toBe("WorkingMethodError")
      }
      expect(
        (yield* update(
          methods,
          { ...context, toolCallID: "empty-body" },
          {
            ...revision,
            evidence: [
              {
                messageID: empty.id,
                channel: "user",
                block: 0,
                hash: Hash.sha256(""),
                quote: "assumptions",
              },
            ],
          },
        ).pipe(Effect.flip)).message,
      ).toContain("quote")
      expect(
        Schema.is(SessionWorkingMethod.Evidence)({
          messageID: empty.id,
          channel: "user",
          block: 0,
          hash: Hash.sha256(""),
          quote: "",
        }),
      ).toBe(false)
      expect(SessionWorkingMethod.captures(empty)[0]).toMatchObject({ channel: "user", text: "", bytes: 0 })
      expect((yield* methods.view(id)).revision).toBe(0)
      const catalog = yield* methods.read(context, { action: "read" })
      expect(JSON.stringify(catalog)).not.toContain("msg_pending_feedback")
      expect(JSON.stringify(catalog)).not.toContain("msg_system_feedback")
    }),
  ))

test("oversized native rows are reported unavailable before malformed/private payloads can be decoded", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const database = yield* Database.Service
      const large = SessionMessage.ID.make("msg_large_native")
      yield* insert(assistant(large), 3)
      const bytes = SessionWorkingMethod.readGuards.message + 1
      // Deliberately not JSON: a decode-first implementation would defect instead of returning the guard.
      yield* database.db
        .run(sql`UPDATE session_message SET data = ${"!".repeat(bytes)} WHERE id = ${large}`)
        .pipe(Effect.orDie)
      const catalog = yield* methods.read(context, { action: "read", messageID: large })
      expect(catalog).toMatchObject({
        observations: [],
        observedMessages: [{ messageID: large, captures: 0, unavailable: { reason: "single-read-byte-guard", bytes } }],
      })
      expect(
        (yield* methods
          .read(context, { action: "read", observation: { ...evidence, messageID: large, offset: 0, length: 100 } })
          .pipe(Effect.flip)).message,
      ).toContain("recorded source is not absent")
      expect(
        (yield* update(methods, context, { ...revision, evidence: [{ ...evidence, messageID: large }] }).pipe(
          Effect.flip,
        )).message,
      ).toContain("single-read guard")
      expect((yield* methods.view(id)).revision).toBe(0)
      yield* database.db
        .run(sql`UPDATE session_message SET data = ${"!".repeat(bytes)} WHERE id = ${context.assistantMessageID}`)
        .pipe(Effect.orDie)
      expect((yield* methods.update(context, revision).pipe(Effect.flip)).message).toContain("Invocation unavailable")
    }),
  ))

test("oversized learning ledger fails before JSON parsing without truncation, reset or replacement", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const global = yield* Global.Service
      yield* update(methods, context, revision)
      const file = path.join(global.data, "working-method", Hash.sha256(id) + ".json")
      const bytes = SessionWorkingMethod.readGuards.ledger + 1
      yield* Effect.promise(() => Bun.write(file, "!".repeat(bytes)))
      expect((yield* methods.view(id).pipe(Effect.flip)).message).toContain(
        "single-read guard; archive retained unchanged",
      )
      expect(
        (yield* update(methods, { ...context, toolCallID: "after-large" }, { ...revision, expectedRevision: 1 }).pipe(
          Effect.flip,
        )).message,
      ).toContain("single-read guard")
      expect(Bun.file(file).size).toBe(bytes)
      expect(yield* Effect.promise(() => Bun.file(file).slice(0, 8).text())).toBe("!!!!!!!!")
    }),
  ))

test("failed observation API calls expose only real error/diagnostic signals, never self-reward claims", () =>
  run(
    Effect.gen(function* () {
      const methods = yield* setup
      const failure = assistant("msg_failed_method", "working_method", "error", "CLAIM_BODY_NOT_EVIDENCE")
      yield* insert(failure, 3)
      const observed = SessionWorkingMethod.captures(failure)
      expect(observed.map((capture) => capture.channel)).toEqual(["error", "diagnostic"])
      expect(observed.every((capture) => capture.interpretation === "execution-diagnostic-not-correctness")).toBe(true)
      expect(JSON.stringify(observed)).not.toContain("CLAIM_BODY_NOT_EVIDENCE")
      expect(SessionWorkingMethod.captures(assistant("msg_successful_method", "working_method"))).toEqual([])
      const error = observed[0]
      yield* update(methods, context, {
        ...revision,
        change: "Retrieve the currently recorded source before retrying a stale reference",
        evidence: [
          {
            messageID: failure.id,
            callID: "probe",
            channel: "error",
            block: 0,
            hash: error.hash,
            quote: "PUBLIC_ERROR",
          },
        ],
      })
      expect((yield* methods.view(id)).active[0]).toMatchObject({
        status: "trial-unverified",
        observations: [{ interpretation: "execution-diagnostic-not-correctness" }],
      })
    }),
  ))
