import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

export default Runtime.handler(Commands.commands.contract, (input) =>
  Effect.tryPromise(async (signal) => {
    if (process.platform !== "linux" || typeof Bun === "undefined")
      throw new Error("The isolated Contract execution profile requires Linux and Bun")
    const root = path.resolve(input.root)
    if (input.action === "cancel") {
      await Bun.write(path.join(root, "CANCEL"), `Explicit cancellation at ${new Date().toISOString()}\n`)
      process.stdout.write(JSON.stringify({ cancelled: root }) + "\n")
      return
    }
    const profile = Option.getOrUndefined(input.profile)
    if (!profile) throw new Error("--profile is required")
    const { ProContractRSI } = await import("@opencode/sdk/pro-contract")
    const config = Schema.decodeUnknownSync(Schema.fromJsonString(ProContractRSI.Configuration))(
      await Bun.file(profile).text(),
      { onExcessProperty: "error" },
    )
    const host = await ProContractRSI.open(root, config)
    try {
      if (input.action === "inspect") {
        process.stdout.write(JSON.stringify(host.store.read(), null, 2) + "\n")
        return
      }
      const task = Option.getOrUndefined(input.task)
      if (!task) throw new Error("--task is required for execution")
      const admitted = Schema.decodeUnknownSync(Schema.fromJsonString(ProContractRSI.Task))(
        await Bun.file(task).text(),
        { onExcessProperty: "error" },
      )
      const result = await host.run(admitted, { resume: input.action === "resume", signal })
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      if (result.contract.status !== "discharged") process.exitCode = 2
    } finally {
      host.close()
    }
  }),
)
