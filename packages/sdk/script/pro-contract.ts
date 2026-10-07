#!/usr/bin/env bun
import path from "node:path"
import { Schema } from "effect"
import { ProContractRSI } from "../src/pro-contract"

const [action, root, profile, task] = process.argv.slice(2)
if (!["run", "resume", "inspect", "cancel"].includes(action) || !root || !path.isAbsolute(root))
  throw new Error("Usage: bun script/pro-contract.ts run|resume ROOT PROFILE TASK | inspect ROOT PROFILE | cancel ROOT")
if (action === "cancel") {
  await Bun.write(path.join(root, "CANCEL"), `Explicit cancellation at ${new Date().toISOString()}\n`)
  console.log(JSON.stringify({ cancelled: root }))
} else {
  if (!profile) throw new Error("Frozen profile required")
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(ProContractRSI.Configuration))(
    await Bun.file(profile).text(),
    { onExcessProperty: "error" },
  )
  const host = await ProContractRSI.open(root, config)
  const controller = new AbortController()
  const stop = () => controller.abort(new Error("Explicit CLI cancellation"))
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    if (action === "inspect") console.log(JSON.stringify(host.store.read(), null, 2))
    else {
      if (!task) throw new Error("Task file required")
      const input = Schema.decodeUnknownSync(Schema.fromJsonString(ProContractRSI.Task))(await Bun.file(task).text(), {
        onExcessProperty: "error",
      })
      console.log(
        JSON.stringify(await host.run(input, { resume: action === "resume", signal: controller.signal }), null, 2),
      )
    }
  } finally {
    host.close()
  }
}
