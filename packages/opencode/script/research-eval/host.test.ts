import { expect, test } from "bun:test"
import { createServer } from "node:net"
import { mkdtemp, mkdir, chmod, link, rm } from "node:fs/promises"
import { start } from "./host"
import { launcher } from "./isolation"
import { processIdentity, sameProcess } from "./observe"

for (const mode of ["cancel", "host-exit", "host-kill", "supervisor-kill"] as const) {
  test(`supervisor handles ${mode} without claiming unproven cleanup`, async () => {
    const root = await mkdtemp("/tmp/s6c-supervisor-review-")
    const work = root + "/work"
    const storage = root + "/storage"
    await mkdir(work)
    await mkdir(storage)
    await link(process.execPath, work + "/runtime")
    await Bun.write(
      work + "/fake-host.ts",
      `if(!process.send)throw new Error('No IPC');process.on('message',()=>process.exit(0));process.send({ready:true,pid:process.pid});setTimeout(()=>Bun.spawn(['${work}/orphan'],{cwd:'${work}',stdout:'ignore',stderr:'ignore'}),80);setInterval(()=>{},1000)`,
    )
    await Bun.write(work + "/wrapper", `#!/bin/sh\nexec '${work}/runtime' '${work}/fake-host.ts'\n`)
    await chmod(work + "/wrapper", 0o700)
    await Bun.write(
      work + "/orphan.c",
      `#include <unistd.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(){pid_t child=fork();if(child<0)return 1;if(child>0)return 0;if(setsid()<0)return 2;FILE*f=fopen("daemon.pid","w");fprintf(f,"%d",getpid());fclose(f);sleep(4);return 0;}\n`,
    )
    const build = Bun.spawn(["gcc", work + "/orphan.c", "-o", work + "/orphan"], { stdout: "ignore", stderr: "pipe" })
    if (await build.exited) throw new Error(await new Response(build.stderr).text())
    const listener = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    let host: Awaited<ReturnType<typeof start>> | undefined
    let daemon: Awaited<ReturnType<typeof processIdentity>>
    try {
      host = await start({
        storage,
        directory: work,
        launcher: await launcher(storage),
        port: (listener.address() as { port: number }).port,
        bun: work + "/wrapper",
        timeout: 1000,
      })
      for (let attempt = 0; attempt < 50 && !(await Bun.file(work + "/daemon.pid").exists()); attempt++)
        await Bun.sleep(20)
      const pid = Number(await Bun.file(work + "/daemon.pid").text())
      daemon = await processIdentity(pid)
      if (!daemon) throw new Error("No live daemon to test")
      await Bun.sleep(100)
      const begun = performance.now()
      if (mode === "host-exit") host.child.send({ exit: true })
      if (mode === "host-kill") process.kill(host.identity.pid, "SIGKILL")
      if (mode === "supervisor-kill") host.child.kill("SIGKILL")
      if (mode !== "cancel") await host.child.exited
      const stopped = await host.stop().then(
        () => "completed",
        (error) => String(error),
      )
      const after = await processIdentity(pid)
      const escaped = sameProcess(daemon, after)
      expect(performance.now() - begun).toBeLessThan(2000)
      if (mode === "supervisor-kill") expect(stopped).toContain("could not prove complete cleanup")
      else {
        expect(stopped).toBe("completed")
        expect(escaped).toBe(false)
      }
    } finally {
      if (daemon && sameProcess(daemon, await processIdentity(daemon.pid))) process.kill(daemon.pid, "SIGKILL")
      if (host && host.child.exitCode === null && host.child.signalCode === null) await host.stop()
      listener.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}
