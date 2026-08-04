import type { ProContractInfo } from "@opencode-ai/sdk/v2"
import { createMemo, createResource } from "solid-js"
import { useSDK } from "../context/sdk"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export function DialogContracts(props: { scope?: string } = {}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [contracts, { refetch }] = createResource(() =>
    sdk.client.v2.proContract
      .list(props.scope ? { scope: props.scope } : undefined)
      .then((result) => {
        if (result.error) throw result.error
        return result.data.data
      })
      .catch((error) => {
        toast.show({ variant: "error", message: errorMessage(error) })
        return []
      }),
  )

  const options = createMemo(() =>
    (contracts() ?? []).map((contract) => ({
      title: contract.spec.goal,
      value: contract,
      description: `${contract.pendingRevision ? "revision pending" : contract.status} · ${contract.scope}`,
      details: [
        `Contract: ${contract.id}`,
        `Brief: ${contract.spec.brief ? "provided" : "none"}`,
        `Requires: ${contract.spec.requires.map((item) => `${item.contractID}@${item.revision}`).join(", ") || "none"}`,
        ...(contract.handoff
          ? [
              `Handoff: ${contract.handoff.summary}`,
              `Uncertainties: ${contract.handoff.uncertainties.length}`,
              ...(contract.handoff.replay
                ? [
                    `Replay: ${contract.handoff.replay.passed ? "passed" : "failed"}`,
                    `Replay evidence: ${contract.handoff.replay.evidenceHash}`,
                  ]
                : []),
            ]
          : []),
        ...(contract.challenge
          ? [
              `Challenge: ${contract.challenge.disclosure === "sealed" ? "sealed" : (contract.challenge.summary ?? "verification failed")}`,
              `Rejected subject: ${contract.challenge.subjectHash}`,
              `Negative witness: ${contract.challenge.evidenceHash}`,
            ]
          : []),
        `Authority: ${contract.spec.authority.join(", ")}`,
        `Budget: ${contract.spec.budget.turns} turns · ${contract.spec.budget.actions} actions`,
      ],
      onSelect: () => {
        if (contract.status === "discharged" || contract.status === "released") return
        manage(contract)
      },
    })),
  )

  function manage(contract: ProContractInfo) {
    dialog.replace(() => (
      <DialogSelect
        title={contract.spec.goal}
        options={[
          ...(contract.status === "verification" && contract.handoff && contract.spec.evidence.type === "principal"
            ? [
                {
                  title: "Attest completion",
                  description: "Discharge with principal evidence",
                  value: "attest",
                  onSelect: () => void attest(contract),
                },
              ]
            : []),
          ...(contract.pendingRevision
            ? [
                {
                  title: "Accept proposed revision",
                  description: contract.pendingRevision.reason,
                  details: [
                    `Goal: ${contract.pendingRevision.spec.goal}`,
                    `Brief: ${contract.pendingRevision.spec.brief ? "updated" : "empty"}`,
                    `Authority: ${contract.pendingRevision.spec.authority.join(", ")}`,
                    `Budget: ${contract.pendingRevision.spec.budget.turns} turns · ${contract.pendingRevision.spec.budget.actions} actions`,
                  ],
                  value: "accept",
                  onSelect: () => void decideRevision(contract, true),
                },
                {
                  title: "Reject proposed revision",
                  description: contract.pendingRevision.reason,
                  value: "reject",
                  onSelect: () => void decideRevision(contract, false),
                },
              ]
            : []),
          ...(contract.status === "escalated" && contract.escalation
            ? [
                {
                  title: "Resume escalated contract",
                  description: contract.escalation.reason,
                  value: "resume",
                  onSelect: () => void resume(contract),
                },
              ]
            : []),
          {
            title: "Release without evidence",
            description: "Explicitly end the obligation",
            value: "release",
            onSelect: () => void release(contract),
          },
        ]}
      />
    ))
  }

  async function attest(contract: ProContractInfo) {
    const evidenceHash = await DialogPrompt.show(dialog, "Evidence hash", {
      placeholder: "Artifact, report, or decision hash",
    })
    if (!evidenceHash?.trim()) return dialog.replace(() => <DialogContracts {...props} />)
    const result = await sdk.client.v2.proContract.attest({
      contractID: contract.id,
      evidenceHash: evidenceHash.trim(),
    })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error) })
      return dialog.replace(() => <DialogContracts {...props} />)
    }
    toast.show({ variant: "success", message: "Contract discharged" })
    dialog.replace(() => <DialogContracts {...props} />)
  }

  async function decideRevision(contract: ProContractInfo, accept: boolean) {
    const result = await sdk.client.v2.proContract.decideRevision({ contractID: contract.id, accept })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error) })
      return dialog.replace(() => <DialogContracts {...props} />)
    }
    toast.show({ variant: "success", message: accept ? "Revision accepted" : "Revision rejected" })
    dialog.replace(() => <DialogContracts {...props} />)
  }

  async function resume(contract: ProContractInfo) {
    const result = await sdk.client.v2.proContract.resume({ contractID: contract.id })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error) })
      return dialog.replace(() => <DialogContracts {...props} />)
    }
    toast.show({ variant: "success", message: "Contract resumed" })
    dialog.replace(() => <DialogContracts {...props} />)
  }

  async function release(contract: ProContractInfo) {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Release contract",
      `Release “${contract.spec.goal}”? This ends the obligation without discharge evidence.`,
    )
    if (!confirmed) {
      dialog.replace(() => <DialogContracts {...props} />)
      return
    }
    const reason = await DialogPrompt.show(dialog, "Release reason", { placeholder: "Why is this duty released?" })
    if (!reason?.trim()) {
      dialog.replace(() => <DialogContracts {...props} />)
      return
    }
    const result = await sdk.client.v2.proContract.release({ contractID: contract.id, reason: reason.trim() })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error) })
      dialog.replace(() => <DialogContracts {...props} />)
      return
    }
    toast.show({ variant: "success", message: "Contract released" })
    await refetch()
    dialog.replace(() => <DialogContracts {...props} />)
  }

  return <DialogSelect title="Contracts" options={options()} />
}
