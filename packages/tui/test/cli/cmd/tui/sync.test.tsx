/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("projects V2 Contract approval into the existing permission UI", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit({
        directory: "/tmp/opencode/packages/tui",
        project: "proj_test",
        payload: {
          id: "evt_contract_permission",
          type: "permission.v2.asked",
          properties: {
            id: "per_contract",
            sessionID: "ses_contract",
            action: "contract_issue",
            resources: ["spec-hash"],
            metadata: { goal: "Continue later", details: "Authority: filesystem.read" },
            source: { type: "tool", messageID: "msg_contract", callID: "call_contract" },
          },
        },
      })
      await wait(() => sync.data.permission.ses_contract?.length === 1)

      expect(sync.data.permission.ses_contract?.[0]).toEqual({
        id: "per_contract",
        sessionID: "ses_contract",
        permission: "contract_issue",
        patterns: ["spec-hash"],
        always: [],
        metadata: { goal: "Continue later", details: "Authority: filesystem.read", __v2: true },
        tool: { messageID: "msg_contract", callID: "call_contract" },
      })

      emit({
        directory: "/tmp/opencode/packages/tui",
        project: "proj_test",
        payload: {
          id: "evt_contract_permission_reply",
          type: "permission.v2.replied",
          properties: { sessionID: "ses_contract", requestID: "per_contract", reply: "once" },
        },
      })
      await wait(() => sync.data.permission.ses_contract?.length === 0)
    } finally {
      app.renderer.destroy()
    }
  })
})
