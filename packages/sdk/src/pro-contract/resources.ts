export * as ContractResources from "./resources"

import fs from "node:fs/promises"
import path from "node:path"

/** Split an already delegated instance allocation, without increasing its limit.
 * Call before creating worker processes; this is a single-host operator API. */
export async function enter(input: { hostBytes: number; toolBytes: number }) {
  if (
    !Number.isSafeInteger(input.hostBytes) ||
    !Number.isSafeInteger(input.toolBytes) ||
    input.hostBytes <= 0 ||
    input.toolBytes <= 0
  )
    throw new Error("Positive host/tool memory allocations required")
  const entry = (await Bun.file("/proc/self/cgroup").text())
    .trim()
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3)
  if (!entry || !entry.endsWith(".scope")) throw new Error("A fresh delegated systemd instance scope is required")
  const root = "/sys/fs/cgroup" + entry
  if (Number((await Bun.file(path.join(root, "memory.max")).text()).trim()) !== input.hostBytes + input.toolBytes)
    throw new Error("Memory partition does not conserve the original instance limit")
  const control = path.join(root, "control")
  const tools = path.join(root, "tools")
  await fs.mkdir(control)
  await fs.mkdir(tools)
  const processes = (await Bun.file(path.join(root, "cgroup.procs")).text()).trim().split("\n")
  if (processes.some((pid) => Number(pid) !== process.pid))
    throw new Error("Resource setup must precede child execution")
  await Bun.write(path.join(control, "cgroup.procs"), String(process.pid))
  await Bun.write(path.join(root, "cgroup.subtree_control"), "+memory +pids +cpu")
  await Bun.write(path.join(control, "memory.max"), String(input.hostBytes))
  await Bun.write(path.join(tools, "memory.max"), String(input.toolBytes))
  await Bun.write(path.join(tools, "memory.oom.group"), "1")
  process.env.OPENCODE_TOOL_CGROUP = tools
  return { root, control, tools, hostBytes: input.hostBytes, toolBytes: input.toolBytes }
}
