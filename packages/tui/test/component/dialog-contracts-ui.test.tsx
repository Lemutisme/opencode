/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ProContractInfo } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { DialogContracts } from "../../src/component/dialog-contracts"
import { ProjectProvider, useProject } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"
import { tmpdir } from "../fixture/fixture"
import { wait } from "../cli/cmd/tui/sync-fixture"

test("project Contracts are visible and keyboard navigation opens even a completed executor", async () => {
  await using dir = await tmpdir()
  await Bun.write(`${dir.path}/kv.json`, "{}")
  const scopes: string[] = []
  const nativeRequests: URL[] = []
  let status: ProContractInfo["status"] = "active"
  const calls = createFetch((url) => {
    if (url.pathname === "/api/contract") {
      scopes.push(url.searchParams.get("scope") ?? "")
      return json({
        data:
          url.searchParams.get("scope") === "proj_test"
            ? [
                {
                  id: "pct_ui",
                  scope: "proj_test",
                  issuer: "local-owner",
                  revision: 1,
                  status,
                  specHash: "frozen",
                  spec: {
                    goal: "Durable user task",
                    brief: "",
                    requires: [],
                    authority: ["filesystem.read"],
                    trigger: { type: "immediate" },
                    budget: { deadline: 21_600_000 },
                    evidence: { type: "principal", claim: "Independently reviewed" },
                    resolution: { maxAttempts: 1, retryDelay: 0 },
                  },
                },
              ]
            : [],
      })
    }
    if (url.pathname === "/api/contract/pct_ui/execution") return json({ sessionID: "ses_executor" })
    if (url.pathname === "/api/session/ses_executor") return json({ data: { id: "ses_executor" } })
    if (url.pathname === "/api/session/ses_executor/message") {
      nativeRequests.push(url)
      if (url.searchParams.get("cursor") === "older")
        return json({
          data: [{ type: "user", id: "msg_old", time: { created: 0 }, text: "Earlier approved request" }],
          cursor: {},
        })
      return json({
        data: [
          {
            type: "assistant",
            id: "msg_ready",
            agent: "build",
            model: { id: "test-model", providerID: "test" },
            time: { created: 1, completed: 2 },
            content: [
              {
                type: "tool",
                id: "call_ready",
                name: "contract_report_ready",
                time: { created: 1, completed: 2 },
                state: { status: "completed", input: {}, content: [], structured: { recorded: true } },
              },
            ],
          },
        ],
        cursor: { next: "older" },
      })
    }
  })
  function Probe() {
    const project = useProject()
    const dialog = useDialog()
    onMount(async () => {
      await project.sync()
      dialog.replace(() => <DialogContracts />)
    })
    return <box />
  }
  function Harness() {
    const keymap = createDefaultOpenTuiKeymap(useRenderer())
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, useRenderer(), config))
    return (
      <TestTuiContexts paths={{ state: dir.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                  <ProjectProvider>
                    <ToastProvider>
                      <DialogProvider>
                        <Probe />
                      </DialogProvider>
                    </ToastProvider>
                  </ProjectProvider>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 35 })
  try {
    await wait(() => scopes.includes("proj_test") && scopes.includes(directory))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Durable user task")
    expect(app.captureCharFrame()).toContain("unbounded")
    const before = scopes.length
    status = "discharged"
    await wait(() => scopes.length >= before + 2)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("discharged")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Open execution Session")
    expect(app.captureCharFrame()).not.toContain("Release without evidence")
    app.mockInput.pressEnter()
    await wait(() => nativeRequests.length > 0)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("contract_report_ready")
    expect(app.captureCharFrame()).toContain("read-only transcript")
    app.mockInput.pressEnter()
    await app.renderOnce()
    app.mockInput.pressKey("\x1b[6~")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain('"recorded": true')
    const requests = nativeRequests.length
    app.mockInput.pressEnter()
    await wait(() => nativeRequests.length > requests)
    await app.renderOnce()
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await wait(() => nativeRequests.some((url) => url.searchParams.get("cursor") === "older"))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Earlier approved request")
  } finally {
    app.renderer.destroy()
  }
})
