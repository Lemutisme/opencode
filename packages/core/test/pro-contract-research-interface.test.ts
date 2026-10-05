import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ProContractTrajectory } from "../src/pro-contract/trajectory"
import { ProContractVersion } from "../src/pro-contract/version"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const Reason = Schema.Struct({ type: Schema.Literal("reason"), id: Schema.String, prompt: Schema.String })

describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !Bun.which("bwrap"))(
  "research packet interface guide",
  () => {
    test("generated native prompt describes actual projected records, not an invented flat output schema", async () => {
      await using root = await tmpdir()
      const workspace = path.join(root.path, "workspace")
      await mkdir(workspace)
      const original = JSON.stringify({
        sessionID: "ses_interface_fixture",
        sessionMessageCount: 1,
        messages: {
          data: [
            {
              id: "msg_example",
              type: "assistant",
              time: { created: 1 },
              content: [
                {
                  id: "part_recorded",
                  type: "tool",
                  name: "example",
                  time: { created: 1 },
                  state: {
                    status: "completed",
                    input: {},
                    content: [{ type: "text", text: "ok\n" }, { type: "image" }],
                  },
                },
                {
                  id: "part_error",
                  type: "tool",
                  name: "example",
                  time: { created: 2 },
                  state: { status: "error", input: {}, content: [], error: { message: "patch failed" } },
                },
                {
                  id: "part_pending",
                  type: "tool",
                  name: "example",
                  time: { created: 3 },
                  state: { status: "pending", input: '{"incomplete":' },
                },
              ],
            },
          ],
        },
      })
      const packet = ProContractTrajectory.project({
        source: original,
        sourceID: "schema-development",
        sourceHash: Hash.sha256(original),
      })
      await Bun.write(path.join(workspace, "packet.json"), JSON.stringify(packet))
      const versions = ProContractVersion.make({ directory: path.join(root.path, "store") })
      const frozen = await versions.freeze({
        directory: path.resolve(import.meta.dir, "../script/trajectory-research"),
        entrypoint: "workflow.ts",
      })
      const run = await versions.run({
        versionHash: frozen.versionHash,
        task: {
          contractID: "pct_interface_fixture",
          revision: 1,
          specHash: "interface-fixture",
          input: {
            question: "What does the public evidence actually contain?",
            packets: [
              { path: "packet.json", sourceID: packet.source.id, summary: "Projected development observations" },
            ],
          },
        },
        workspace,
        deadline: Date.now() + 30_000,
        view: { responses: [], unresolvedReasoning: [] },
      })
      expect(run.status).toBe("completed")
      const prompt = Schema.decodeUnknownSync(Reason)(run.result!.requests![0]).prompt
      const example = JSON.parse(prompt.split("Structural example (selected fields):\n")[1].split("\n")[0])
      expect(packet.records[0]).toMatchObject(example)
      expect(packet.records[0].id).not.toBe(packet.records[0].messageID)
      expect(packet.records.map((record) => record.messageID)).toEqual(["msg_example", "msg_example", "msg_example"])
      expect(prompt).toContain("Use exact record.id, not messageID, for inspect selections[].recordIDs")
      expect(prompt).toContain("tool.output is only availability")
      expect(prompt).toContain("tool.content[i].text.text when available")
      expect(prompt).toContain("Decode tool.input.text as JSON only when available and encoding is canonical-json")
      expect(packet.records[0].tool?.input).toMatchObject({
        status: "complete",
        encoding: "canonical-json",
        text: "{}",
      })
      expect(packet.records[0].tool?.content[1]).toEqual({ order: 1, status: "unavailable", reason: "non-text-output" })
      expect(packet.records[1].tool?.error).toMatchObject({
        status: "complete",
        encoding: "utf8",
        text: "patch failed",
      })
      expect(prompt).toContain("tool.error.text carries the captured error")
      expect(packet.records[2].tool?.input).toMatchObject({ status: "unavailable", reason: "pending-input-unparsed" })
      expect(packet.records[2].tool?.input).not.toHaveProperty("text")
      expect(packet.records[2].tool?.output).toBe("pending")
      expect(prompt).toContain("absent text is not empty output or a negative result")
      expect(prompt).toContain("not inner-command success or accepted conclusions")
      expect(run.result?.requests).toHaveLength(1)
    })
  },
)
