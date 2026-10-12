import type { SessionMessage } from "@opencode-ai/sdk/v2"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export function DialogContractExecution(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [cursor, setCursor] = createSignal<string>()
  const [failure, setFailure] = createSignal<string>()
  const [page, { refetch }] = createResource(
    () => ({ cursor: cursor() }),
    async (input) => {
      const result = await sdk.client.v2.session.messages({
        sessionID: props.sessionID,
        order: "desc",
        limit: 100,
        cursor: input.cursor,
      })
      if (result.error) {
        setFailure(errorMessage(result.error))
        toast.show({ variant: "error", message: errorMessage(result.error) })
        return
      }
      setFailure(undefined)
      return result.data
    },
  )
  onMount(() => {
    const timer = setInterval(() => {
      if (!page.loading && cursor() === undefined) void refetch()
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <DialogSelect
      title={`Execution Session ${props.sessionID}`}
      footer={<text>Native, read-only transcript · newest first</text>}
      options={[
        ...(page()?.data ?? []).map((message) => ({
          title:
            message.type === "assistant"
              ? `assistant: ${message.content.map((part) => (part.type === "tool" ? `${part.name} (${part.state.status})` : part.type)).join(", ")}`
              : message.type,
          value: message.id,
          description: "text" in message ? message.text.split("\n")[0].slice(0, 100) : message.id,
          onSelect: () => dialog.replace(() => <DialogContractMessage message={message} sessionID={props.sessionID} />),
        })),
        ...(page()?.cursor.next
          ? [{ title: "Older messages", value: "older", onSelect: () => setCursor(page()?.cursor.next) }]
          : []),
        ...(cursor() ? [{ title: "Latest messages", value: "latest", onSelect: () => setCursor(undefined) }] : []),
      ]}
      emptyView={
        <text>{page.loading ? "Loading native execution records…" : (failure() ?? "No execution records yet")}</text>
      }
    />
  )
}

function DialogContractMessage(props: { message: SessionMessage; sessionID: string }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  let scroll: ScrollBoxRenderable | undefined
  onMount(() => dialog.setSize("xlarge"))
  useBindings(() => ({
    bindings: [
      { key: "up", desc: "Scroll up", group: "Transcript", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll down", group: "Transcript", cmd: () => scroll?.scrollBy(1) },
      {
        key: "pageup",
        desc: "Previous page",
        group: "Transcript",
        cmd: () => scroll?.scrollBy(-1, "viewport"),
      },
      { key: "pagedown", desc: "Next page", group: "Transcript", cmd: () => scroll?.scrollBy(1, "viewport") },
      {
        key: "return",
        desc: "Back to transcript",
        group: "Transcript",
        cmd: () => dialog.replace(() => <DialogContractExecution sessionID={props.sessionID} />),
      },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.theme.text}>
        {props.message.type} · {props.message.id}
      </text>
      <scrollbox
        ref={(value) => {
          scroll = value
        }}
        height={Math.max(4, dimensions().height - Math.floor(dimensions().height / 4) - 10)}
      >
        <text fg={theme.theme.text} wrapMode="word" flexShrink={0}>
          {JSON.stringify(props.message, null, 2)}
        </text>
      </scrollbox>
      <text fg={theme.theme.textMuted}>
        Exact native JSON record · arrows/page keys scroll · enter back · esc close
      </text>
    </box>
  )
}
