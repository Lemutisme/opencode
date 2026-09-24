import { appendFileSync } from "node:fs"

const [role, mode, evidence] = process.argv.slice(2)
if (role === "worker") {
  process.on("message", (message: { id: string }) => {
    setTimeout(() => {
      appendFileSync(evidence, JSON.stringify({ event: "still_executing", at: Date.now() }) + "\n")
      process.send!({ id: message.id, result: "late result" })
    }, 90)
  })
  process.send!({ ready: true, pid: process.pid })
  setInterval(() => {}, 1000)
} else {
  const worker = Bun.spawn([process.execPath, import.meta.path, "worker", mode, evidence], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      if (mode !== "no-ready") process.send!(message)
    },
  })
  process.on("message", (message) => worker.send(message))
  process.on("SIGTERM", () =>
    setTimeout(async () => {
      worker.kill("SIGKILL")
      await worker.exited
      process.exit(mode === "unconfirmed" ? 126 : 143)
    }, 180),
  )
  setInterval(() => {}, 1000)
}
