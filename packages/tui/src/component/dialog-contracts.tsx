import type { ProContractInfo } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, onCleanup, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { DialogContractExecution } from "./dialog-contract-execution"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export async function loadDialogContracts(input: {
  scope?: string
  directory?: string
  list: (query: { scope: string }) => Promise<{ data?: { data: ProContractInfo[] }; error?: unknown }>
}) {
  // Older manually issued Contracts used directory scopes. Preserve their
  // visibility while natural-language and new manual issuance use project IDs.
  const scopes = [...new Set([input.scope, input.directory].filter((scope): scope is string => !!scope))]
  const results = await Promise.all(scopes.map((scope) => input.list({ scope })))
  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
  return [
    ...new Map(
      results.flatMap((result) => result.data?.data ?? []).map((contract) => [contract.id, contract]),
    ).values(),
  ]
}

export function DialogContracts(props: { scope?: string } = {}) {
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const [contracts, { refetch }] = createResource(
    () => ({ scope: props.scope ?? project.project(), directory: sdk.directory }),
    (input) =>
      loadDialogContracts({ ...input, list: (query) => sdk.client.v2.proContract.list(query) }).catch((error) => {
        toast.show({ variant: "error", message: errorMessage(error) })
        return []
      }),
  )
  onMount(() => {
    const timer = setInterval(() => {
      if (!contracts.loading) void refetch()
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const options = createMemo(() =>
    (contracts() ?? []).map((contract) => ({
      title: contract.spec.goal,
      value: contract,
      description: `${contract.pendingRevision ? "revision pending" : contract.status} · ${contract.scope}`,
      details: [
        `Contract: ${contract.id}`,
        `Settlement claim: ${contract.spec.evidence.claim ?? contract.spec.goal}`,
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
        `Budget: ${contract.spec.budget.turns ?? "unbounded"} turns · ${contract.spec.budget.actions ?? "unbounded"} actions`,
        `Deadline: ${new Date(contract.spec.budget.deadline).toUTCString()} (${contract.spec.budget.deadline} ms)`,
      ],
      onSelect: () => {
        manage(contract)
      },
    })),
  )

  function manage(contract: ProContractInfo) {
    dialog.replace(() => (
      <DialogSelect
        title={contract.spec.goal}
        options={[
          {
            title: "Open execution Session",
            description: "View the dedicated OpenCode executor, if this Contract has one",
            value: "session",
            onSelect: () => void openExecution(contract),
          },
          {
            title: "Refresh status",
            description: "Reload the latest handoff and principal decisions",
            value: "refresh",
            onSelect: () => void refresh(contract),
          },
          ...(contract.status === "verification" && contract.handoff && contract.spec.evidence.type === "principal"
            ? [
                {
                  title: "Attest settlement claim",
                  description: contract.spec.evidence.claim ?? contract.spec.goal,
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
                    `Budget: ${contract.pendingRevision.spec.budget.turns ?? "unbounded"} turns · ${contract.pendingRevision.spec.budget.actions ?? "unbounded"} actions`,
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
          ...(contract.status === "discharged" || contract.status === "released"
            ? []
            : [
                {
                  title: "Release without evidence",
                  description: "Explicitly end the obligation",
                  value: "release",
                  onSelect: () => void release(contract),
                },
              ]),
        ]}
      />
    ))
  }

  async function refresh(contract: ProContractInfo) {
    const result = await sdk.client.v2.proContract.get({ contractID: contract.id })
    if (result.error) return toast.show({ variant: "error", message: errorMessage(result.error) })
    manage(result.data.data)
  }

  async function openExecution(contract: ProContractInfo) {
    const result = await sdk.client.v2.proContract.execution({ contractID: contract.id })
    if (result.error) return toast.show({ variant: "error", message: errorMessage(result.error) })
    const session = await sdk.client.v2.session.get({ sessionID: result.data.sessionID })
    if (session.error) return toast.show({ variant: "error", message: "The execution Session has not started yet" })
    // Native execution records live in session_message, not the legacy TUI's
    // message/part projection. Never open a blank legacy editor for this work.
    dialog.replace(() => <DialogContractExecution sessionID={result.data.sessionID} />)
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
