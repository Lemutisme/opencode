/** Prefer sacrificing a tool process over its supervising Session on Linux OOM.
 * This changes neither the container's memory budget nor the daemon priority.
 * Setting priority in the shell before user code runs also covers descendants.
 */
export function oomCommand(
  command: string,
  enabled = process.env.OPENCODE_PROTECT_CONTROL_PLANE === "1",
  platform = process.platform,
) {
  if (!enabled || platform !== "linux") return command
  const broker = process.env.OPENCODE_PROCESS_BROKER_SOCKET
  const join = broker
    ? `python3 -I -S /opt/procontract/benchmark_process_client.py '${broker.replaceAll("'", "'\\''")}' tool || exit 125
`
    : ""
  return `${join}printf '1000\\n' > /proc/self/oom_score_adj || exit 125\n${command}`
}
