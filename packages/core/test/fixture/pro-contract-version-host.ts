import { ProContractVersion } from "../../src/pro-contract/version"

const runner = ProContractVersion.make({ directory: process.argv[2], runtime: process.execPath })
await runner.run({
  versionHash: process.argv[3],
  workspace: process.argv[4],
  id: process.argv[5],
  task: { marker: process.argv[6] },
  view: {},
  deadline: Date.now() + 10_000,
})
