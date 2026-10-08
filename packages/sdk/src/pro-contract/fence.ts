export * as ContractFence from "./fence"

import { readFileSync } from "node:fs"

export type Identity = { pid: number; birth: string }
type Child = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exited" | "exitCode" | "signalCode" | "kill">

export function identity(pid: number): Identity {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/)
  if (!fields[19]) throw new Error("Missing native process birth identity")
  return { pid, birth: fields[19] }
}

/** The five-second cleanup grace is not an extension of the work deadline.
 * A signal request is not evidence of exit; every owned target is observed. */
export function own(input: { worker: Child; deadline: number; signal: AbortSignal }) {
  const errors = new Set<string>()
  const attempt = <T>(body: () => T) => {
    try {
      return body()
    } catch (error) {
      errors.add(error instanceof Error ? error.message : String(error))
    }
  }
  const child = (process: Child) => {
    const target = { process, identity: attempt(() => identity(process.pid)), exited: false }
    process.exited.then(
      () => {
        target.exited = true
      },
      (error: unknown) => {
        errors.add(String(error))
      },
    )
    return target
  }
  const worker = child(input.worker)
  const state: {
    runtime?: Identity
    gateway?: ReturnType<typeof child>
    stop?: { time: number; deadline: number; monotonic: number; until: number; reason: string }
  } = {}
  const stopped = Promise.withResolvers<never>()
  // Cancellation can arrive before the caller reaches its first bounded wait.
  void stopped.promise.catch(() => {})
  const observed = (target: ReturnType<typeof child>) =>
    target.exited || (target.identity !== undefined && attempt(() => exited(target.identity!)) === true)
  const kill = (target: ReturnType<typeof child>, signal: "SIGKILL" | "SIGTERM") => {
    if (!observed(target)) attempt(() => target.process.kill(signal))
  }
  const signal = () => {
    // Each target is attempted independently, including when another target
    // disappeared between its identity check and the signal syscall.
    if (state.runtime && attempt(() => exited(state.runtime!)) === false)
      attempt(() => process.kill(state.runtime!.pid, "SIGKILL"))
    kill(worker, "SIGKILL")
    if (state.gateway) kill(state.gateway, performance.now() >= state.stop!.monotonic + 1000 ? "SIGKILL" : "SIGTERM")
  }
  const stop = (reason = "Native execution stopped") => {
    if (!state.stop) {
      const time = Date.now()
      const monotonic = performance.now()
      state.stop = { time, deadline: time + 5000, monotonic, until: monotonic + 5000, reason }
      stopped.reject(new Error(reason))
    }
    signal()
  }
  const abort = () => stop("Native execution cancelled")
  const timer = setTimeout(() => stop("Native execution deadline expired"), Math.max(1, input.deadline - Date.now()))
  const startup = setTimeout(
    () => stop("Native execution startup timed out"),
    Math.max(1, Math.min(30000, input.deadline - Date.now())),
  )
  // This also escalates the gateway if cancellation occurs outside a wait.
  const escalation = setInterval(() => {
    if (state.stop) signal()
  }, 20)
  input.signal.addEventListener("abort", abort, { once: true })
  if (input.signal.aborted) abort()
  return {
    stop,
    wait: <T>(promise: PromiseLike<T>) => {
      if (Date.now() >= input.deadline) stop("Native execution deadline expired")
      // A previously settled work promise must not outrun an already-set stop.
      if (state.stop) {
        // The interrupted operation can still reject when its process exits.
        void Promise.resolve(promise).catch(() => {})
        return stopped.promise
      }
      return Promise.race([promise, stopped.promise])
    },
    ready: () => clearTimeout(startup),
    runtime(value: Identity) {
      if (state.runtime) throw new Error("Native runtime identity is already owned")
      state.runtime = value
      if (state.stop) signal()
    },
    gateway(value: Child) {
      if (state.gateway) throw new Error("Native gateway is already owned")
      state.gateway = child(value)
      if (state.stop) signal()
    },
    ownership: () => ({
      wrapperPID: worker.process.pid,
      wrapper: worker.identity,
      runtime: state.runtime,
      gateway: state.gateway?.identity,
      deadline: input.deadline,
    }),
    async finish(file: string) {
      clearTimeout(timer)
      clearTimeout(startup)
      input.signal.removeEventListener("abort", abort)
      stop()
      const status = () => ({
        wrapperExited: observed(worker),
        runtimeExited: state.runtime ? attempt(() => exited(state.runtime!)) === true : false,
        gatewayExited: state.gateway ? observed(state.gateway) : true,
      })
      while (performance.now() < state.stop!.until) {
        const current = status()
        if (current.wrapperExited && current.runtimeExited && current.gatewayExited) break
        signal()
        await Bun.sleep(Math.min(20, Math.max(1, state.stop!.until - performance.now())))
      }
      clearInterval(escalation)
      const current = status()
      const receipt = {
        pid: worker.process.pid,
        wrapper: worker.identity,
        exitCode: worker.process.exitCode,
        signal: worker.process.signalCode,
        runtime: state.runtime,
        gateway: state.gateway?.identity,
        acknowledged: current.wrapperExited && current.runtimeExited && current.gatewayExited,
        ...current,
        gatewayExitCode: state.gateway?.process.exitCode,
        gatewaySignal: state.gateway?.process.signalCode,
        deadline: input.deadline,
        cleanupStarted: state.stop!.time,
        cleanupDeadline: state.stop!.deadline,
        cleanupElapsed: performance.now() - state.stop!.monotonic,
        reason: state.stop!.reason,
        errors: [...errors],
        time: Date.now(),
      }
      await Bun.write(file, JSON.stringify(receipt))
      return receipt
    },
  }
}

function exited(identity: Identity) {
  try {
    const fields = readFileSync(`/proc/${identity.pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/)
    if (!fields[19]) throw new Error("Malformed native process birth identity")
    return fields[19] !== identity.birth || fields[0] === "Z" || fields[0] === "X"
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return true
    throw error
  }
}
