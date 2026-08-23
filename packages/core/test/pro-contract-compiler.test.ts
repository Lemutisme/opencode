import { describe, expect, test } from "bun:test"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { RelativePath } from "@opencode-ai/core/schema"

const request = "Create compile.sh and executable, then validate the implementation."
const base = ProContract.defaultSpec("Ship the implementation", 0)

describe("OpenCode Contract compiler", () => {
  test("promotes the smallest rule set that retains valid proposals and rejects unsafe proposals", () => {
    const corpus = [
      { kind: "valid", spec: base, request },
      {
        kind: "valid",
        spec: ProContract.Spec.make({
          ...base,
          authority: ["filesystem.read", "filesystem.write", "process.execute"],
          evidence: {
            ...base.evidence,
            replay: {
              checks: [],
              protected: [],
              artifacts: [RelativePath.make("compile.sh"), RelativePath.make("executable")],
            },
          },
        }),
        request,
      },
      { kind: "unsafe", spec: { ...base, authority: ["workspace.read"] }, request },
      {
        kind: "unsafe",
        spec: ProContract.Spec.make({
          ...base,
          evidence: {
            ...base.evidence,
            replay: { checks: [], protected: [], artifacts: [RelativePath.make("secret-output")] },
          },
        }),
        request,
      },
    ] as const
    const candidates = [
      { authority: false, artifact: false },
      { authority: true, artifact: false },
      { authority: false, artifact: true },
      { authority: true, artifact: true },
    ]

    expect(
      candidates.map((candidate) => {
        const accepted = corpus.filter(
          (item) =>
            !ProContractOpenCode.diagnoseSpec({ spec: item.spec, request: item.request }).some(
              (violation) => candidate[violation.rule],
            ),
        )
        return {
          ...candidate,
          valid: accepted.filter((item) => item.kind === "valid").length,
          unsafe: accepted.filter((item) => item.kind === "unsafe").length,
        }
      }),
    ).toEqual([
      { authority: false, artifact: false, valid: 2, unsafe: 2 },
      { authority: true, artifact: false, valid: 2, unsafe: 1 },
      { authority: false, artifact: true, valid: 2, unsafe: 1 },
      { authority: true, artifact: true, valid: 2, unsafe: 0 },
    ])
  })

  test("compiles one deterministic principal-readable manifest", () => {
    const input = {
      spec: { ...base, evidence: { type: "principal" as const } },
      request,
      configuredPolicy: {
        contractID: ProContract.ID.make("pct_compiler_policy"),
        revision: 1,
        policy: true as const,
      },
    }
    const first = ProContractOpenCode.compileSpec(input)
    const second = ProContractOpenCode.compileSpec(first.type === "accepted" ? { spec: first.spec, request } : input)

    expect(first).toMatchObject({
      type: "accepted",
      spec: {
        brief: expect.stringContaining(`Original request:\n${request}`),
        evidence: { claim: base.goal },
        requires: [input.configuredPolicy],
      },
      manifest: {
        version: 1,
        adapter: "opencode",
        authority: base.authority,
      },
      specHash: expect.any(String),
      manifestHash: expect.any(String),
    })
    expect(second).toEqual(first)
  })

  test("returns every compiler violation without mutating the draft", () => {
    const spec = ProContract.Spec.make({
      ...base,
      authority: ["workspace.read", "workspace.execute"],
      evidence: {
        ...base.evidence,
        replay: { checks: [], protected: [], artifacts: [RelativePath.make("private.bin")] },
      },
    })
    const before = JSON.stringify(spec)
    const result = ProContractOpenCode.compileSpec({ spec, request })

    expect(result).toMatchObject({
      type: "rejected",
      violations: [
        { rule: "authority", values: ["workspace.read", "workspace.execute"] },
        { rule: "artifact", values: ["private.bin"] },
      ],
    })
    expect(JSON.stringify(spec)).toBe(before)
  })
})
