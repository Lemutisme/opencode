export * as ContractObservations from "./observations"

import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { request } from "node:http"
import type { Shell } from "@opencode/schema/shell"

export type Identity = { sessionID: string; messageID: string; callID: string; tool: string }
export type Kind = "native-result" | "model-visible" | "shell-capture"
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024

/** Public, candidate-controlled observations are not acceptance evidence. The
 * authenticated host chooses all archive paths and adds execution identity. */
export function json(identity: Identity, kind: Exclude<Kind, "shell-capture">, value: unknown, deadline: number) {
  const bytes = Buffer.from(JSON.stringify(value))
  return publish({ ...identity, kind }, bytes.length, [bytes], deadline)
}

/** Shell captures are combined stdout/stderr bytes, not separated oracle streams.
 * Save them before upstream's bounded exited-shell cache can unlink the file. */
export async function shell(
  identity: Identity,
  info: Pick<Shell.Info, "file" | "status" | "exit" | "signal">,
  deadline: number,
) {
  const directory = "/state/data/opencode/shell"
  const resolved = await fs.realpath(info.file)
  if (!resolved.startsWith(directory + path.sep) || resolved !== path.resolve(info.file))
    throw new Error("Shell observation leaves this native capture directory")
  const file = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error("Shell observation is not a regular file")
    const size = Math.min(stat.size, MAX_CAPTURE_BYTES)
    await publish(
      {
        ...identity,
        kind: "shell-capture",
        capture: {
          stream: "combined",
          encoding: "bytes",
          totalBytes: stat.size,
          complete:
            info.status === "exited" && info.exit !== undefined && info.signal === undefined && stat.size === size,
          timeout: info.status === "timeout",
          status: info.status,
          ...(info.exit === undefined ? {} : { exit: info.exit }),
          ...(info.signal === undefined ? {} : { signal: info.signal }),
        },
      },
      size,
      size ? file.createReadStream({ start: 0, end: size - 1, autoClose: false }) : [],
      deadline,
    )
  } finally {
    await file.close()
  }
}

async function publish(
  metadata: Identity & { kind: Kind; capture?: Record<string, string | number | boolean> },
  size: number,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  deadline: number,
) {
  if (size > MAX_CAPTURE_BYTES) throw new Error("Individual observation exceeds the capture infrastructure bound")
  if (Date.now() >= deadline) throw new Error("Original deadline reached while retaining observations")
  const call = request({
    socketPath: "/channel/provider.sock",
    path: "/v1/observations",
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "x-observation": Buffer.from(JSON.stringify(metadata)).toString("base64"),
    },
    agent: false,
  })
  const timer = setTimeout(
    () => call.destroy(new Error("Observation retention operation deadline reached")),
    Math.max(1, Math.min(30000, deadline - Date.now())),
  )
  const completed = new Promise<void>((resolve, reject) => {
    call.once("error", reject)
    call.once("response", (response) => {
      response.resume()
      response.once("error", reject)
      response.once("end", () =>
        response.statusCode === 201
          ? resolve()
          : reject(new Error(`Public observation archive rejected the write: ${response.statusCode}`)),
      )
    })
  })
  // Attach a rejection handler before streaming, without hiding failure at the
  // awaited boundary. Socket failure must not become an unhandled rejection.
  void completed.catch(() => undefined)
  try {
    for await (const chunk of chunks) {
      if (Date.now() >= deadline) throw new Error("Original deadline reached while retaining observations")
      if (!call.write(chunk))
        await new Promise<void>((resolve, reject) => {
          const failure = (error: Error) => {
            call.off("drain", drained)
            reject(error)
          }
          const drained = () => {
            call.off("error", failure)
            resolve()
          }
          call.once("drain", drained)
          call.once("error", failure)
        })
    }
    call.end()
    await completed
  } finally {
    clearTimeout(timer)
    call.destroy()
  }
}
