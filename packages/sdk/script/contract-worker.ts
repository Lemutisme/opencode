// Native V2 worker. This process cannot attest, issue, or change the host ledger.
import { Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ContractDelivery } from "./contract-delivery"
import { ContractAdvisory } from "./contract-advisory"
import { contractProfile, drainDelivery } from "./contract-profile"
import { ProviderTransport } from "@opencode/core/effect/provider-transport"
import { requestExecutor } from "@opencode/core/effect/app-node-platform"
import { PromiseSdk } from "../src/promise"

export const Input = Schema.Struct({
  contractID: Schema.String,
  revision: Schema.Int,
  sessionID: Schema.String,
  promptID: Schema.String,
  deadline: Schema.Number,
  directory: Schema.String,
  reference: Schema.String,
  state: Schema.String,
  standing: Schema.String,
  socket: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  prompt: Schema.String,
  advisory: Schema.optional(ContractAdvisory.Config),
})
const Standing = Schema.Struct({
  contractID: Schema.String,
  revision: Schema.Int,
  deadline: Schema.Number,
  active: Schema.Boolean,
})
export function initialPrompt(input: Pick<typeof Input.Type, "prompt" | "advisory">) {
  return (
    input.prompt +
    "\n\n" +
    ContractDelivery.instructions +
    (input.advisory ? "\n\n" + ContractAdvisory.instructions(input.advisory) : "")
  )
}

export function workerConfig(input: Pick<typeof Input.Type, "model" | "effort">) {
  return JSON.stringify({
    model: `openai/${input.model}`,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "execute", resource: "*", effect: "deny" },
    ],
    providers: {
      openai: {
        package: "@opencode/ai/providers/openai",
        canonical: "openai",
        env: [],
        settings: {
          baseURL: "http://programbench-provider.invalid/v1",
          apiKey: "no-upstream-credential",
          transport: "http",
          timeout: 900000,
          chunkTimeout: 900000,
        },
        models: {
          [input.model]: {
            limit: { context: 272000, output: 128000 },
            capabilities: { tools: true, reasoning: true, input: ["text"], output: ["text"] },
            body: { reasoning: { effort: input.effort }, max_output_tokens: 128000, store: false },
            variants: [{ id: input.effort, body: { reasoning: { effort: input.effort } } }],
          },
        },
      },
    },
  })
}

export async function waitForResearcher(
  host: Pick<PromiseSdk.Interface, "sessions">,
  sessionID: string,
  advisory?: ContractAdvisory.Service,
) {
  await host.sessions.wait({ sessionID })
  await advisory?.settle()
}

export function idleAdvisory(input: {
  host: Pick<PromiseSdk.Interface, "sessions" | "message">
  sessionID: string
  delivery: Pick<Awaited<ReturnType<typeof ContractDelivery.create>>, "exclusive">
  advisory?: ContractAdvisory.Service
  assertActive: () => Promise<void>
}) {
  const advisory = input.advisory
  if (!advisory) return undefined
  return (text: string) =>
    input.delivery.exclusive(async () => {
      await advisory.settle()
      const review = await advisory.review({
        node: "idle",
        statement: () => ContractAdvisory.latestText(input.host, input.sessionID),
      })
      await input.assertActive()
      return review ? advisory.render("idle", undefined, review, text) : undefined
    })
}

async function main() {
  const started = Date.now()
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(await Bun.file(process.argv[2]).text())
  const startup = Date.now() + 30_000
  while (!(await Bun.file(input.standing + ".ready").exists())) {
    if (Date.now() >= Math.min(startup, input.deadline)) throw new Error("Host did not admit this worker")
    await Bun.sleep(25)
  }
  const assertStanding = async () => {
    const standing = Schema.decodeUnknownSync(Schema.fromJsonString(Standing))(await Bun.file(input.standing).text())
    if (
      !standing.active ||
      standing.contractID !== input.contractID ||
      standing.revision !== input.revision ||
      standing.deadline !== input.deadline ||
      Date.now() >= input.deadline
    )
      throw new Error("Contract authority is absent, stale, or expired")
  }
  await assertStanding()
  // A fresh worker does not silently adopt V2 startup claims from another allocation.
  if (await Bun.file(`${input.state}/session.sqlite`).exists())
    throw new Error("Explicit recovery qualification is required")
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  const timer = setTimeout(stop, Math.max(0, input.deadline - Date.now()))
  const delivery = await ContractDelivery.create({
    directory: input.directory,
    state: input.state,
    reference: input.reference,
    deadline: input.deadline,
    signal: controller.signal,
    assertStanding,
  })
  const assertActive = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    controller.signal.throwIfAborted()
    await assertStanding()
  }
  const advisory = input.advisory
    ? ContractAdvisory.create({
        config: input.advisory,
        host: (): PromiseSdk.Interface => host,
        sessionID: input.sessionID,
        directory: input.directory,
        state: input.state,
        model: { providerID: "openai", id: input.model, variant: input.effort },
        prompt: input.prompt,
        deadline: input.deadline,
        started,
        signal: controller.signal,
        assertActive,
        probes: delivery.probes,
      })
    : undefined
  const host = await PromiseSdk.create(
    {
      app: { name: "procontract-v2-worker" },
      database: { path: `${input.state}/session.sqlite` },
      events: { persist: true },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: {
        directory: `${input.state}/config`,
        project: false,
        content: workerConfig(input),
      },
      plugins: [contractProfile(delivery, input.deadline, advisory)],
    },
    {
      overrides: [
        requestExecutor.replace(ProviderTransport.layerWith(input.socket).pipe(Layer.provide(FetchHttpClient.layer))),
      ],
    },
  )
  const interrupt = () => {
    void host.sessions.interrupt({ sessionID: input.sessionID }).catch(() => undefined)
  }
  try {
    const session = await host.sessions.create({
      id: input.sessionID,
      title: `Contract ${input.contractID}`,
      location: { directory: input.directory },
      model: { providerID: "openai", id: input.model, variant: input.effort },
    })
    controller.signal.addEventListener("abort", interrupt, { once: true })
    await assertStanding()
    if (controller.signal.aborted) throw new Error("Contract was cancelled before execution")
    await host.sessions.prompt({
      id: input.promptID,
      sessionID: session.id,
      text: initialPrompt(input),
    })
    const disposition = await drainDelivery({
      wait: async () => {
        await waitForResearcher(host, session.id, advisory)
        const log = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
        await Bun.write(`${input.state}/events.json`, JSON.stringify(log, null, 2))
        if (log.some((event) => event.type === "session.execution.failed"))
          throw new Error("Native V2 execution failed")
      },
      prompt: (text) => host.sessions.prompt({ sessionID: session.id, text }),
      status: delivery.status,
      assertActive,
      beforePrompt: idleAdvisory({ host, sessionID: session.id, delivery, advisory, assertActive }),
    })
    const messages = await host.message.list({ sessionID: session.id })
    await Bun.write(`${input.state}/messages.json`, JSON.stringify(messages, null, 2))
    const log = await Array.fromAsync(host.sessions.log({ sessionID: session.id }))
    await Bun.write(`${input.state}/events.json`, JSON.stringify(log, null, 2))
    if (log.some((event) => event.type === "session.execution.failed")) throw new Error("Native V2 execution failed")
    if (controller.signal.aborted) throw new Error("Contract cancelled or original deadline reached")
    await assertStanding()
    await Bun.write(
      `${input.state}/worker-ended.json`,
      JSON.stringify({
        sessionID: session.id,
        contractID: input.contractID,
        revision: input.revision,
        deadline: input.deadline,
        ended: Date.now(),
        authoritativeCompletion: false,
        delivery: disposition,
      }),
    )
  } finally {
    await advisory?.settle()
    clearTimeout(timer)
    await host.close()
  }
}

if (import.meta.main) await main()
