import path from "path"
import { Schema } from "effect"
import { Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionObservationPack } from "@opencode-ai/core/session/observation-pack"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { Hash } from "@opencode-ai/core/util/hash"

const Protocol = Schema.Struct({
  inputs: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  parameters: Schema.Struct({
    threshold_bytes: Schema.Number,
    recent_completed_assistants: Schema.Number,
    excerpt_bytes: Schema.Number,
    diagnostic_pattern: Schema.String,
  }),
})
const Snapshot = Schema.Struct({
  sessionMessageCount: Schema.Number,
  execution: Schema.Struct({
    turnsUsed: Schema.Number,
    model: Schema.Struct({ id: Schema.String, providerID: Schema.String }),
  }),
  messages: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
})

/** Replays frozen history through the production projector; makes no model or candidate execution calls. */
export async function study(protocolFile: string, outputFile: string) {
  const protocol = Schema.decodeUnknownSync(Protocol)(await Bun.file(protocolFile).json())
  if (
    protocol.parameters.threshold_bytes !== SessionObservationPack.THRESHOLD_BYTES ||
    protocol.parameters.recent_completed_assistants !== SessionObservationPack.RECENT_ASSISTANTS ||
    protocol.parameters.excerpt_bytes !== SessionObservationPack.EXCERPT_BYTES ||
    protocol.parameters.diagnostic_pattern !== SessionObservationPack.DIAGNOSTIC_PATTERN
  )
    throw new Error("Production packing parameters differ from the frozen protocol")
  const results = await Promise.all(
    protocol.inputs.map(async (input) => {
      const raw = await Bun.file(input.path).text()
      if (Hash.sha256(raw) !== input.sha256) throw new Error(`Changed frozen input: ${input.path}`)
      const snapshot = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Snapshot)))(raw)
      const messages = snapshot.messages.data
      if (messages.length !== snapshot.sessionMessageCount) throw new Error(`Incomplete history: ${input.path}`)
      const model = Model.make({
        ...snapshot.execution.model,
        provider: snapshot.execution.model.providerID,
        route: OpenAIChat.route,
      })
      const original = JSON.stringify(messages)
      const recalls = new Map<string, { bytes: number; pages: number }>()
      const requests = messages.flatMap((message, index) => {
        if (message.type !== "assistant") return []
        const prefix = messages.slice(0, index)
        const projected = SessionObservationPack.project(prefix)
        projected.forEach((candidate, index) => {
          const source = prefix[index]!
          if (candidate.type !== "assistant" || source.type !== "assistant") {
            if (JSON.stringify(candidate) !== JSON.stringify(source)) throw new Error("Changed non-assistant message")
            return
          }
          candidate.content.forEach((part, contentIndex) => {
            const sourcePart = source.content[contentIndex]!
            if (
              part.type !== "tool" ||
              sourcePart.type !== "tool" ||
              part.state.status !== "completed" ||
              sourcePart.state.status !== "completed"
            ) {
              if (JSON.stringify(part) !== JSON.stringify(sourcePart)) throw new Error("Changed protected content")
              return
            }
            if (
              JSON.stringify({ ...part, state: { ...part.state, content: [] } }) !==
              JSON.stringify({ ...sourcePart, state: { ...sourcePart.state, content: [] } })
            )
              throw new Error("Changed tool identity, input, status or structured result")
            part.state.content.forEach((block, blockIndex) => {
              const sourceBlock =
                sourcePart.state.status === "completed" ? sourcePart.state.content[blockIndex] : undefined
              if (block.type !== "text" || sourceBlock?.type !== "text" || block.text === sourceBlock.text) return
              const recall = Schema.decodeUnknownSync(
                Schema.UnknownFromJsonString.pipe(
                  Schema.decodeTo(Schema.Struct({ recall: SessionObservationPack.ReadInput })),
                ),
              )(block.text).recall
              const key = JSON.stringify(recall)
              if (recalls.has(key)) return
              const bytes = Buffer.from(sourceBlock.text)
              const pages = Array.from({ length: Math.ceil(bytes.length / 997) }, (_, index) => {
                const page = SessionObservationPack.read(source, { ...recall, offset: index * 997, length: 997 })
                if (!page || page.nextOffset !== Math.min(bytes.length, index * 997 + 997))
                  throw new Error("Missing or discontinuous recall page")
                return Buffer.from(page.data, page.encoding === "utf8" ? "utf8" : "base64")
              })
              if (!Buffer.concat(pages).equals(bytes)) throw new Error("Recall changed recorded bytes")
              recalls.set(key, { bytes: bytes.length, pages: pages.length })
            })
          })
        })
        return [
          {
            baselineBytes: Buffer.byteLength(JSON.stringify(toLLMMessages(prefix, model))),
            packedBytes: Buffer.byteLength(JSON.stringify(toLLMMessages(projected, model))),
          },
        ]
      })
      if (JSON.stringify(messages) !== original) throw new Error("Mutated durable source")
      if (Hash.sha256(await Bun.file(input.path).text()) !== input.sha256)
        throw new Error("Frozen source changed during replay")
      const baselineBytes = requests.reduce((sum, request) => sum + request.baselineBytes, 0)
      const packedBytes = requests.reduce((sum, request) => sum + request.packedBytes, 0)
      return {
        task: path.basename(path.dirname(input.path)),
        source: input.path,
        sourceHash: input.sha256,
        recordedTurns: snapshot.execution.turnsUsed,
        reconstructedRequests: requests.length,
        baselineBytes,
        packedBytes,
        savedBytes: baselineBytes - packedBytes,
        savedFraction: baselineBytes ? (baselineBytes - packedBytes) / baselineBytes : 0,
        packedBlocks: recalls.size,
        recalledBytes: [...recalls.values()].reduce((sum, value) => sum + value.bytes, 0),
        checkedPages: [...recalls.values()].reduce((sum, value) => sum + value.pages, 0),
        unchangedHistory: true,
        unchangedInputsAndStatuses: true,
        exactRecall: true,
        requests,
      }
    }),
  )
  const total = (
    key: "baselineBytes" | "packedBytes" | "savedBytes" | "packedBlocks" | "checkedPages" | "recalledBytes",
  ) => results.reduce((sum, row) => sum + row[key], 0)
  const report = {
    kind: "fixed-trajectory-replay",
    protocolHash: Hash.sha256(await Bun.file(protocolFile).text()),
    limitations: [
      "Canonical message JSON bytes, not provider wire tokens, billed cost or live quality.",
      "Reconstructed request prefixes exclude retries and assume completed exported assistants delimit requests.",
      "Tool catalog overhead, actual future recalls, compaction and prompt-cache invalidation are not included.",
      "Candidates and historical behavioral scores are unchanged; this does not establish quality retention under changed context.",
    ],
    parameters: {
      thresholdBytes: SessionObservationPack.THRESHOLD_BYTES,
      recentAssistants: SessionObservationPack.RECENT_ASSISTANTS,
      excerptBytes: SessionObservationPack.EXCERPT_BYTES,
      diagnosticPattern: SessionObservationPack.DIAGNOSTIC_PATTERN,
    },
    total: {
      baselineBytes: total("baselineBytes"),
      packedBytes: total("packedBytes"),
      savedBytes: total("savedBytes"),
      packedBlocks: total("packedBlocks"),
      checkedPages: total("checkedPages"),
      recalledBytes: total("recalledBytes"),
    },
    results,
  }
  await Bun.write(outputFile, JSON.stringify(report, null, 2) + "\n")
  return report
}

if (import.meta.main) {
  const protocol = Bun.argv[2]
  const output = Bun.argv[3]
  if (!protocol || !output)
    throw new Error("Usage: bun script/pro-contract-observation-study.ts PROTOCOL_JSON OUTPUT_JSON")
  console.log(JSON.stringify((await study(protocol, output)).total))
}
