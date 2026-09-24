import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Deferred, Effect, Latch, Option, Schema, Stream } from "effect"
import type { OpenCodeEvent } from "../src"

// Database.node captures its filename when the SDK is first imported. Keep that
// database alive for the suite; individual workspace directories remain isolated.
const database = { previous: Flag.OPENCODE_DB, directory: await mkdtemp(join(tmpdir(), "opencode-embedded-db-")) }
Flag.OPENCODE_DB = join(database.directory, "opencode.sqlite")
afterAll(async () => {
  Flag.OPENCODE_DB = database.previous
  await rm(database.directory, { recursive: true, force: true })
})

test("embedded client uses the real router and handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-"))
  const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      yield* opencode.tools.register({
        embedded_tool: Tool.make({
          description: "Embedded test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const created = yield* opencode.sessions.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* opencode.sessions.switchModel({ sessionID, model })
      const selected = yield* opencode.sessions.get({ sessionID })
      const page = yield* opencode.sessions.list({ directory: AbsolutePath.make(directory) })
      const active = yield* opencode.sessions.active()
      const admitted = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not run" }),
        resume: false,
      })
      const context = yield* opencode.sessions.context({ sessionID })
      const wake = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Promote this input" }),
      })
      const prompted = yield* opencode.sessions.events({ sessionID }).pipe(
        Stream.filter((event) => event.type === "session.next.prompted" && event.data.messageID === wake.id),
        Stream.runHead,
        Effect.timeout("10 seconds"),
        Effect.map(Option.getOrThrow),
      )
      const wakeContext = yield* opencode.sessions.context({ sessionID })
      const event = yield* opencode.sessions
        .events({ sessionID })
        .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrUndefined))
      const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
        Option.getOrThrow,
      )
      const message = yield* opencode.sessions.message({ sessionID, messageID: modelMessage.id })
      yield* opencode.sessions.interrupt({ sessionID })
      const other = yield* opencode.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
      const missing = yield* Effect.all(
        [
          opencode.sessions.events({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
          opencode.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
          opencode.sessions.message({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )
      const missingMessage = yield* Effect.flip(
        opencode.sessions.message({
          sessionID: other.id,
          messageID: modelMessage.id,
        }),
      )

      expect(created.id).toBe(sessionID)
      expect(selected.model?.id).toBe(model.id)
      expect(selected.model?.providerID).toBe(model.providerID)
      expect(page.data.some((session) => session.id === sessionID)).toBe(true)
      expect(active).toEqual({})
      expect(admitted.sessionID).toBe(sessionID)
      expect(prompted.type).toBe("session.next.prompted")
      expect(wakeContext).toContainEqual(expect.objectContaining({ id: wake.id, type: "user" }))
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
      expect(event).toMatchObject({ type: "session.next.model.switched", durable: { seq: 1 } })
      expect(message).toEqual(modelMessage)
      expect(missing.map((error) => error._tag)).toEqual([
        "SessionNotFoundError",
        "SessionNotFoundError",
        "SessionNotFoundError",
      ])
      expect(missingMessage._tag).toBe("MessageNotFoundError")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Location-owned runner events reach the ready global client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-events-"))
  const { AbsolutePath, Location, OpenCode, Prompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      const connected = yield* Latch.make(false)
      const prompted = yield* Deferred.make<OpenCodeEvent>()
      yield* opencode.events.subscribe().pipe(
        Stream.runForEach((event) =>
          event.type === "server.connected"
            ? connected.open
            : event.type === "session.next.prompted" && event.data.sessionID === sessionID
              ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      )
      yield* connected.await
      yield* opencode.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* opencode.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Observe this input" }) })

      const event = yield* Deferred.await(prompted).pipe(Effect.timeout("4 seconds"))
      expect(event.durable).toEqual(expect.objectContaining({ aggregateID: sessionID, seq: expect.any(Number) }))
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("independent embedded hosts do not share live notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-hosts-"))
  const { AbsolutePath, Agent, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const first = yield* OpenCode.create()
      const second = yield* OpenCode.create()
      const firstReady = yield* Latch.make(false)
      const secondReady = yield* Latch.make(false)
      const firstEvent = yield* Latch.make(false)
      const secondEvent = yield* Latch.make(false)
      const observe = (ready: Latch.Latch, event: Latch.Latch) =>
        Stream.runForEach((notification: OpenCodeEvent) =>
          notification.type === "server.connected"
            ? ready.open
            : notification.type === "session.next.agent.switched" && notification.data.sessionID === sessionID
              ? event.open
              : Effect.void,
        )

      yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
      yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
      yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
      yield* first.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* first.sessions.switchAgent({ sessionID, agent: Agent.ID.make("plan") })

      yield* firstEvent.await.pipe(Effect.timeout("2 seconds"))
      expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("embedded client is available as a Layer service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-layer-"))
  const { AbsolutePath, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service
        return yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
      }).pipe(Effect.provide(OpenCode.layer), Effect.scoped),
    )

    expect(created.id).toBe(sessionID)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("host driver controls the same scheduler and Location runner used by HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-driver-host-"))
  const { AbsolutePath, Model, OpenCode, Provider } = await import("../src")
  const { ProContract } = await import("@opencode-ai/core/pro-contract")
  const owners: string[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* OpenCode.create({
            contractDrivers: [
              {
                identity: "test-embedded:1",
                activate: () => true,
                claim: () => true,
                heartbeat: () => true,
                outcome: (view) => {
                  owners.push(view.binding.leaseOwner!)
                  return { type: "wait" }
                },
              },
            ],
          })
          const second = yield* OpenCode.create()
          const request = {
            id: ProContract.ID.create(),
            scope: "embedded-driver",
            driver: "test-embedded:1",
            spec: {
              ...ProContract.defaultSpec("Inspect the host", Date.now()),
              resolution: { maxAttempts: 1, retryDelay: 1 },
            },
            location: { directory: AbsolutePath.make(directory) },
            model: { providerID: Provider.ID.make("missing-provider"), id: Model.ID.make("missing-model") },
            now: Date.now(),
          }
          const issued = yield* first.contractExecution.issue(request)
          expect(issued.execution?.admission?.open).toBe(false)
          expect(
            (yield* second.contractExecution.issue({ ...request, id: ProContract.ID.create() })).decision.type,
          ).toBe("rejected")
          const http = first["server.proContract"]
          expect((yield* http.get({ contractID: request.id })).status).toBe("dormant")
          const opened = yield* first.contractExecution.setAdmission({
            expected: issued.execution!,
            context: issued.contract!.recognition.context!.target,
            open: true,
            reason: "Host inputs prepared",
          })
          expect(opened.binding).toBeDefined()
          const waited = yield* Effect.gen(function* () {
            while (true) {
              const current = yield* first.contractExecution.get(request.id)
              if (current?.attempts === 1 && !current.dispatched && current.admission?.open === false) return current
              yield* Effect.sleep("10 millis")
            }
          }).pipe(Effect.timeout("10 seconds"))
          expect(waited.attempts).toBe(1)
          expect(owners).toEqual([first.contractExecution.owner])
          expect(first.contractExecution.owner).not.toBe(second.contractExecution.owner)
          expect((yield* http.get({ contractID: request.id })).status).toBe("active")
          expect((yield* http.execution({ contractID: request.id })).dispatched).toBe(false)
        }),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
