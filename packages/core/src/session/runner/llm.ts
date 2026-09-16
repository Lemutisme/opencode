import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, Clock, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { ProContract } from "../../pro-contract"
import { ProContractOpenCode } from "../../pro-contract/open-code"
import { ProContractContext } from "../../pro-contract/context"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionObservationPack } from "../observation-pack"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { InterruptedToolInput } from "./interrupted-tool-input"
import { RepeatedToolInput } from "./repeated-tool-input"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const SETTLEMENT_WINDOW = 20
const MAX_PROVIDER_TURN_MS = 15 * 60 * 1_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const contracts = yield* ProContract.Service
    const contractBindings = yield* ProContractOpenCode.Service
    const observationPolicy = yield* SessionObservationPack.Policy
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: {
              type: "unknown",
              message:
                tool.state.status === "pending"
                  ? InterruptedToolInput.describe(tool.state.input, "Previous provider turn is no longer active")
                  : "Tool execution interrupted",
            },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, bound: boolean) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map((contexts) =>
          SystemContext.combine([
            ...contexts,
            ProContractContext.make(bound ? "execution" : agent.id === AgentV2.defaultID ? "admission" : undefined),
          ]),
        ),
      )

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const contractBinding = yield* contractBindings.forSession(session.id)
      const contract = contractBinding ? yield* contracts.get(contractBinding.contractID) : undefined
      const now = yield* Clock.currentTimeMillis
      const contractAttemptChanged =
        contractBinding &&
        contract &&
        (contractBinding.attemptKey === undefined
          ? contractBinding.revision !== contract.revision ||
            contract.challenge?.disclosure === "executor" ||
            contract.blocked !== undefined
          : contractBinding.attemptKey !== ProContractOpenCode.attemptKey(contract))
      const initialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemContext(agent, contractBinding !== undefined),
        session.id,
      )
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      if (
        contractBinding &&
        (contract?.status !== "active" ||
          !contractBinding.dispatched ||
          contractBinding.leaseOwner !== contractBindings.owner ||
          (contractBinding.leaseExpiresAt ?? 0) <= now ||
          contractBinding.revision !== contract.revision ||
          contractAttemptChanged)
      )
        return { needsContinuation: false, step: currentStep }
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(
          db,
          events,
          loadSystemContext(agent, contractBinding !== undefined),
          session.id,
        ))
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const previous = context.at(-1)
      const inputRecovery =
        previous?.type === "assistant" && previous.content.some(InterruptedToolInput.isUncalledFailure)
          ? RepeatedToolInput.make()
          : undefined
      // An issued Contract without a turn ceiling must not inherit a generic agent step ceiling.
      const isLastStep =
        !(contract && contract.spec.budget.turns === undefined) &&
        agent.info?.steps !== undefined &&
        currentStep >= agent.info.steps
      const authority = contract?.status === "active" ? contract.spec.authority : []
      const contractPermissions = contractBinding
        ? [
            { action: "*", resource: "*", effect: "deny" as const },
            ...(contract?.spec.evidence.replay
              ? [{ action: "contract_check", resource: "*", effect: "allow" as const }]
              : []),
            { action: "contract_report_ready", resource: "*", effect: "allow" as const },
            { action: "contract_read_observation", resource: "*", effect: "allow" as const },
            { action: "contract_report_blocked", resource: "*", effect: "allow" as const },
            { action: "contract_propose_revision", resource: "*", effect: "allow" as const },
            { action: "todowrite", resource: "*", effect: "allow" as const },
            { action: SessionObservationPack.toolName, resource: "*", effect: "allow" as const },
            ...(authority.includes("filesystem.read")
              ? [
                  { action: "read", resource: "*", effect: "allow" as const },
                  { action: "glob", resource: "*", effect: "allow" as const },
                  { action: "grep", resource: "*", effect: "allow" as const },
                ]
              : []),
            ...(authority.includes("filesystem.write")
              ? [{ action: "edit", resource: "*", effect: "allow" as const }]
              : []),
            ...(authority.includes("process.execute")
              ? [
                  { action: "bash", resource: "*", effect: "allow" as const },
                  ...(authority.includes("filesystem.write")
                    ? [{ action: "mutate_run", resource: "*", effect: "allow" as const }]
                    : []),
                ]
              : []),
            ...(authority.includes("reference.run")
              ? [
                  { action: "reference_run", resource: "*", effect: "allow" as const },
                  { action: "reference_read", resource: "*", effect: "allow" as const },
                ]
              : []),
          ]
        : [
            { action: "mutate_run", resource: "*", effect: "deny" as const },
            { action: "reference_run", resource: "*", effect: "deny" as const },
            { action: "reference_read", resource: "*", effect: "deny" as const },
            { action: "contract_check", resource: "*", effect: "deny" as const },
            { action: "contract_read_observation", resource: "*", effect: "deny" as const },
            { action: "contract_report_ready", resource: "*", effect: "deny" as const },
            { action: "contract_report_blocked", resource: "*", effect: "deny" as const },
            { action: "contract_propose_revision", resource: "*", effect: "deny" as const },
          ]
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize([
            ...(agent.info?.permissions ?? []),
            ...contractPermissions,
            ...(observationPolicy === "off" || (observationPolicy === "contract" && !contractBinding)
              ? [{ action: SessionObservationPack.toolName, resource: "*", effect: "deny" as const }]
              : []),
          ])
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const settlementWindow =
        contract?.status === "active" &&
        contractBinding !== undefined &&
        ((contract.spec.budget.turns !== undefined &&
          contract.spec.budget.turns - contractBinding.turnsUsed <= SETTLEMENT_WINDOW) ||
          (contract.spec.budget.actions !== undefined &&
            contract.spec.budget.actions - contractBinding.actionsUsed <= SETTLEMENT_WINDOW))
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [
          ...toLLMMessages(
            toolMaterialization?.definitions.some((tool) => tool.name === SessionObservationPack.toolName)
              ? SessionObservationPack.project(context)
              : context,
            model,
          ),
          ...(settlementWindow
            ? [
                Message.system(
                  "Settlement window active. Stop opening speculative work; petition verification when the evidence policy can adjudicate its claim, otherwise report blocked. Petition revision only for a necessary change to approved terms, not to restate the task or bypass the shared budget.",
                ),
              ]
            : []),
          ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      const deadline = contract?.spec.budget.deadline
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request, deadline }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      if (contractBinding && !(yield* contractBindings.reserveTurn(session.id, yield* Clock.currentTimeMillis)))
        return { needsContinuation: false, step: currentStep }
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      if (deadline !== undefined && deadline <= (yield* Clock.currentTimeMillis)) return yield* Effect.interrupt
      const providerStream = llm.stream(request).pipe(
        Stream.timeoutOrElse({ duration: "10 minutes", orElse: () => Stream.fromEffect(Effect.interrupt) }),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (
              overflowFailure ||
              (publisher.hasProviderError() && event.type !== "step-finish" && event.type !== "finish")
            )
              return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            // Publish the triggering prefix first; the stream finalizer flushes Input.Ended durably.
            const repeatedInput = inputRecovery?.observe(event, yield* Clock.currentTimeMillis)
            if (repeatedInput) return yield* Effect.fail(repeatedInput)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )
      const providerTurnStartedAt = yield* Clock.currentTimeMillis
      const providerTurnTimeout = Math.max(
        1,
        Math.min(
          MAX_PROVIDER_TURN_MS,
          contract?.status === "active" ? contract.spec.budget.deadline - providerTurnStartedAt : MAX_PROVIDER_TURN_MS,
        ),
      )
      // Idle timeout does not bound a provider that trickles deltas. One turn must not monopolize a finite Contract.
      const boundedProviderStream = providerStream.pipe(
        Effect.timeoutOrElse({ duration: providerTurnTimeout, orElse: () => Effect.interrupt }),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(boundedProviderStream).pipe(
            Effect.as(undefined),
            Effect.catchTag("RepeatedToolInput", Effect.succeed),
            Effect.exit,
          )
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request, deadline })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          const inputFailure = stream._tag === "Success" ? stream.value : undefined
          if (inputFailure) yield* withPublication(publisher.failAssistant(inputFailure.message))
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          // Provider completion does not imply tool completion. Keep the original deadline while tools settle.
          const settlement = awaitToolFibers(toolFibers)
          const settled = yield* restore(
            deadline === undefined
              ? settlement
              : settlement.pipe(
                  Effect.timeoutOrElse({
                    duration: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
                    orElse: () => Effect.interrupt,
                  }),
                ),
          ).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(
              publisher.failUnsettledTools("Tool execution interrupted", { inputStreamEnded: true }),
            )
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(
              publisher.failUnsettledTools("Tool execution interrupted", { inputStreamEnded: true }),
            )
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(
              publisher.failUnsettledTools(`Tool execution failed: ${message}`, { inputStreamEnded: true }),
            )
          }
          if (
            stream._tag === "Success" &&
            !inputFailure &&
            !publisher.hasProviderError() &&
            publisher.hasUncalledTools()
          )
            yield* publish(LLMEvent.providerError({ message: "Provider ended with unexecuted tool arguments" }))
          if (llmFailure)
            yield* withPublication(
              publisher.failUnsettledTools("Provider failed before completing tool input or result", {
                inputStreamEnded: true,
              }),
            )
          if (inputFailure)
            yield* withPublication(
              publisher.failUnsettledTools("Provider stream closed after a local tool-input recovery guard fired", {
                inputStreamEnded: true,
                inputFailure,
              }),
            )
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish:
                  publisher.hasProviderError() || inputFailure || stream._tag === "Failure"
                    ? "error"
                    : stepSettlement.finish,
                cost: yield* models.cost(session, stepSettlement.tokens),
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(
              publisher.failUnsettledTools("Tool execution interrupted", { inputStreamEnded: true }),
            )
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(
              publisher.failUnsettledTools("Provider did not return a tool result", { hostedOnly: true }),
            )
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          // The existing durable Contract recovery reschedules the same Session after finish=error.
          if (inputFailure) return { needsContinuation: false, step: currentStep }
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    ProContract.node,
    ProContractOpenCode.node,
    SessionObservationPack.policyNode,
  ],
})
