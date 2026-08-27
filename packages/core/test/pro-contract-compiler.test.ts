import { describe, expect, test } from "bun:test"
import { ProContract } from "@opencode-ai/core/pro-contract"
import { ProContractOpenCode } from "@opencode-ai/core/pro-contract/open-code"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"

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
              (violation) => violation.rule === "evaluation" || candidate[violation.rule],
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
    const evaluation = ProContract.EvaluationPlan.make({
      evaluatorHash: "evaluator-v1",
      deadline: base.budget.deadline + 100,
    })
    const input = {
      spec: { ...base, evidence: { type: "principal" as const } },
      request,
      evaluation,
      configuredPolicy: {
        contractID: ProContract.ID.make("pct_compiler_policy"),
        revision: 1,
        policy: true as const,
      },
    }
    const first = ProContractOpenCode.compileSpec(input)
    const second = ProContractOpenCode.compileSpec(
      first.type === "accepted" ? { spec: first.spec, request, evaluation } : input,
    )

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
        settlement: { type: "dependent", evaluation },
      },
      specHash: expect.any(String),
      manifestHash: expect.any(String),
    })
    expect(second).toEqual(first)
    const changed = ProContractOpenCode.compileSpec({
      ...input,
      evaluation: { ...evaluation, deadline: evaluation.deadline + 1 },
    })
    expect(changed.type).toBe("accepted")
    if (changed.type === "accepted") expect(changed.manifestHash).not.toBe(first.manifestHash)
  })

  test("rejects an evaluation deadline that cannot outlive delivery", () => {
    expect(
      ProContractOpenCode.compileSpec({
        spec: base,
        request,
        evaluation: { evaluatorHash: "evaluator-v1", deadline: base.budget.deadline },
      }),
    ).toMatchObject({
      type: "rejected",
      violations: [{ rule: "evaluation" }],
    })
  })

  test("binds duty graph, Location, and model into formation identity", () => {
    const id = ProContract.ID.make("pct_compiler_formation")
    const location = { directory: AbsolutePath.make("/workspace") }
    const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("model-a") })
    const evaluation = ProContract.EvaluationPlan.make({
      evaluatorHash: "evaluator-v1",
      deadline: base.budget.deadline + 100,
    })
    const formation = ProContractOpenCode.formationHash({ id, scope: "scope", spec: base, location, model, evaluation })

    expect(ProContractOpenCode.formationHash({ id, scope: "scope", spec: base, location, model, evaluation })).toBe(
      formation,
    )
    expect(ProContractOpenCode.formationHash({ id, scope: "scope", spec: base, location, model })).not.toBe(formation)
    expect(
      ProContractOpenCode.formationHash({
        id,
        scope: "scope",
        spec: base,
        location: { directory: AbsolutePath.make("/other") },
        model,
        evaluation,
      }),
    ).not.toBe(formation)
    expect(
      ProContractOpenCode.formationHash({
        id,
        scope: "scope",
        spec: base,
        location,
        model: ModelV2.Ref.make({
          providerID: ProviderV2.ID.make("openai"),
          id: ModelV2.ID.make("model-b"),
        }),
        evaluation,
      }),
    ).not.toBe(formation)
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
