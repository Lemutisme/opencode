import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import { createServer } from "node:net"
import path from "node:path"
import { corpus, corpusVersion, publish } from "./corpus"
import { candidate, execute, launcher } from "./isolation"

test("frozen matrix has 48 paired probes and 18 complete tasks, with independent development variants", () => {
  expect(corpusVersion).toBe("synthetic-node:3")
  const tasks = corpus("qualification")
  expect(tasks).toHaveLength(66)
  expect(tasks.filter((item) => item.oracle.instance.track === "probe")).toHaveLength(48)
  expect(tasks.filter((item) => item.oracle.instance.defective)).toHaveLength(24)
  expect(tasks.filter((item) => item.oracle.fault)).toHaveLength(6)
  expect(new Set(tasks.map((item) => item.packet.id)).size).toBe(66)
  expect(tasks.map((item) => item.packet.id)).toEqual(corpus("qualification").map((item) => item.packet.id))
  expect(
    corpus("development").every(
      (item) =>
        !tasks.some(
          (qualified) =>
            qualified.packet.id === item.packet.id ||
            qualified.packet.files["data.json"] === item.packet.files["data.json"],
        ),
    ),
  ).toBe(true)
  tasks.forEach((item) => {
    const publicSide = publish(item.packet)
    expect(Object.keys(publicSide)).toEqual(["version", "id", "brief", "files", "requirements", "expectedTests"])
    expect(JSON.stringify(publicSide)).not.toContain('"defective"')
    expect(JSON.stringify(publicSide)).not.toContain(item.oracle.target.mechanism)
    const data = JSON.parse(item.packet.files["data.json"])
    expect(
      (data.b.reduce((a: number, b: number) => a + b, 0) - data.a.reduce((a: number, b: number) => a + b, 0)) /
        data.a.length,
    ).toBe(item.oracle.expected.effect)
    if (item.oracle.instance.family.startsWith("P")) {
      const pair = tasks.find(
        (other) =>
          other.oracle.instance.family === item.oracle.instance.family &&
          other.oracle.instance.repeat === item.oracle.instance.repeat &&
          other.oracle.instance.defective !== item.oracle.instance.defective,
      )!
      expect(item.packet.files).toEqual(pair.packet.files)
      expect(
        Object.keys(item.packet.plan).filter((key) => item.packet.plan[key] !== pair.packet.plan[key]),
      ).toHaveLength(1)
    }
  })
})

test("every public population is mapped and P1 pairs isolate a witnessed exploratory-selection defect", () => {
  for (const split of ["development", "qualification"] as const) {
    for (const item of corpus(split)) {
      const data = JSON.parse(item.packet.files["data.json"]) as {
        a: number[]
        b: number[]
        observationIDs: string[]
        primaryIDs: string[]
        split: { train: string[]; validation: string[]; test: string[] }
        exploratoryThresholds: number[]
      }
      expect(data.observationIDs).toHaveLength(data.a.length)
      expect(data.b).toHaveLength(data.a.length)
      expect(new Set(data.observationIDs).size).toBe(data.observationIDs.length)
      expect(data.primaryIDs).toEqual(data.observationIDs)
      expect([...data.split.train, ...data.split.validation, ...data.split.test].toSorted()).toEqual(
        data.observationIDs.toSorted(),
      )
      expect(Object.values(data.split).every((ids) => ids.length > 0)).toBe(true)
      expect(item.oracle.population).toEqual({
        observationIDs: data.observationIDs,
        primaryIDs: data.primaryIDs,
        split: data.split,
      })
      if (item.oracle.instance.family !== "P1") continue
      const contrast = (id: string, threshold: number) => {
        const index = data.observationIDs.indexOf(id)
        return Number(data.b[index] >= threshold) - Number(data.a[index] >= threshold)
      }
      expect(data.exploratoryThresholds.map((threshold) => contrast(data.split.validation[0], threshold))).toEqual([
        1, 0,
      ])
      expect(data.exploratoryThresholds.map((threshold) => contrast(data.split.test[0], threshold))).toEqual([0, 1])
      expect(item.oracle.expected.effect).toBe(3)
      expect(item.packet.plan.method).toContain("optional exploratory threshold-rate comparison")
      expect(item.packet.plan.method).toContain("primary result unchanged")
      const other = corpus(split).find(
        (pair) =>
          pair.oracle.instance.family === "P1" &&
          pair.oracle.instance.repeat === item.oracle.instance.repeat &&
          pair.oracle.instance.defective !== item.oracle.instance.defective,
      )!
      expect(item.packet.files).toEqual(other.packet.files)
      expect(item.packet.brief).toBe(other.packet.brief)
      expect(Object.keys(item.packet.plan).filter((key) => item.packet.plan[key] !== other.packet.plan[key])).toEqual([
        "method",
      ])
    }
  }
})

test("OS isolation denies oracle, parent paths, symlinks, process memory and network; separate candidate executor distinguishes the boundary bug", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-isolation-"))
  try {
    const work = path.join(root, "work")
    await mkdir(work)
    const binary = await launcher(root)
    const secret = path.join(root, "oracle.json")
    await Bun.write(secret, "hidden-answer-canary")
    await symlink(secret, path.join(work, "link"))
    await Bun.write(
      path.join(work, "attack.mjs"),
      `import fs from 'node:fs'; import net from 'node:net'; const out=[]; for(const file of ${JSON.stringify([secret, "../oracle.json", "link", `/proc/${process.pid}/environ`, `/proc/${process.pid}/mem`, path.join(import.meta.dir, "corpus.ts")])}) { try { fs.readFileSync(file); out.push('LEAK') } catch(e) { out.push(e.code) } } await new Promise(resolve=>{ const s=net.connect(443,'1.1.1.1'); s.on('connect',()=>{out.push('LEAK');s.destroy();resolve()});s.on('error',e=>{out.push(e.code);resolve()}) }); console.log(JSON.stringify(out));`,
    )
    const result = await execute({
      launcher: binary,
      directory: work,
      argv: ["/usr/bin/node", "attack.mjs"],
      timeout: 5000,
    })
    expect(result).toMatchObject({ exit: 0, timedOut: false, truncated: false })
    expect(result.stdout).not.toContain("LEAK")
    expect(JSON.parse(result.stdout)).toHaveLength(7)
    expect(JSON.parse(result.stdout).every((code: string) => ["EACCES", "EPERM"].includes(code))).toBe(true)
    for (const task of corpus("qualification").filter(
      (item) => item.oracle.instance.family === "F1" && item.oracle.instance.repeat === 1,
    )) {
      const result = await candidate({
        launcher: binary,
        directory: work,
        source: task.packet.preparation["analysis.mjs"],
        inputs: task.oracle.inputs,
        timeout: 5000,
      })
      expect(result.exit).toBe(0)
      expect(JSON.stringify(result.values) === JSON.stringify(task.oracle.outputs)).toBe(
        !task.oracle.instance.defective,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("candidate timeout kills nested children and denies detached process escape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-tree-"))
  try {
    const work = path.join(root, "work")
    await mkdir(work)
    const binary = await launcher(root)
    const started = performance.now()
    const result = await execute({
      launcher: binary,
      directory: work,
      timeout: 500,
      argv: [
        "/usr/bin/node",
        "-e",
        `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); console.log(child.pid); setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(child.pid); setInterval(()=>{},1000)`,
      ],
    })
    expect(result.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
    const { processIdentity, sameProcess } = await import("./observe")
    const ids = result.stdout.trim().split(/\s+/).map(Number)
    expect(ids).toHaveLength(2)
    for (const pid of ids) {
      const identity = await processIdentity(pid)
      expect(identity ? sameProcess(identity, identity) : false).toBe(false)
    }
    const escaped = await execute({
      launcher: binary,
      directory: work,
      timeout: 1000,
      argv: ["/usr/bin/setsid", "--wait", "/usr/bin/node", "-e", "setInterval(()=>{},1000)"],
    })
    expect(escaped.stderr).toContain("Operation not permitted")
    expect(escaped.exit).not.toBe(0)
    expect(escaped.timedOut).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("broker denies a different address on the allowed gateway port", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-address-"))
  const gateway = createServer((socket) => socket.end("provider"))
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve))
  const address = gateway.address()
  if (!address || typeof address === "string") throw new Error("Missing listener")
  const privateServer = createServer((socket) => socket.end("ORACLE_LEAK"))
  await new Promise<void>((resolve) => privateServer.listen(address.port, "127.0.0.2", resolve))
  try {
    const work = path.join(root, "work")
    await mkdir(work)
    const binary = await launcher(root)
    await Bun.write(
      path.join(work, "fastopen.c"),
      `#define _GNU_SOURCE
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
int main() { struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons(${address.port})}; inet_pton(AF_INET,"127.0.0.2",&address.sin_addr); struct iovec io={"hello",5}; struct msghdr message={.msg_name=&address,.msg_namelen=sizeof(address),.msg_iov=&io,.msg_iovlen=1}; struct mmsghdr messages={.msg_hdr=message}; for(int i=0;i<3;i++) { int fd=socket(AF_INET,SOCK_STREAM,0); int result=i==0?sendto(fd,"hello",5,MSG_FASTOPEN,(struct sockaddr*)&address,sizeof(address)):i==1?sendmsg(fd,&message,MSG_FASTOPEN):sendmmsg(fd,&messages,1,MSG_FASTOPEN); printf("%d:%d\\n",result,errno); close(fd); } }
`,
    )
    const compiler = Bun.spawn(["gcc", path.join(work, "fastopen.c"), "-o", path.join(work, "fastopen")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await compiler.exited).toBe(0)
    const fastopen = await execute({
      launcher: binary,
      directory: work,
      port: address.port,
      timeout: 2000,
      argv: [path.join(work, "fastopen")],
    })
    expect(fastopen.stdout.trim().split("\n")).toEqual(["-1:1", "-1:1", "-1:1"])
    expect(fastopen.timedOut).toBe(false)
    for (const host of ["127.0.0.2", "127.0.0.1"]) {
      const result = await execute({
        launcher: binary,
        directory: work,
        port: address.port,
        timeout: 2000,
        argv: [
          "/usr/bin/node",
          "-e",
          `const s=require('node:net').connect(${address.port},'${host}');s.on('data',b=>process.stdout.write(b));s.on('error',e=>console.log(e.code))`,
        ],
      })
      expect(result.timedOut).toBe(false)
      expect(result.stdout.trim()).toBe(host === "127.0.0.1" ? "provider" : "EPERM")
      expect(result.stdout).not.toContain("ORACLE_LEAK")
    }
  } finally {
    gateway.close()
    privateServer.close()
    await rm(root, { recursive: true, force: true })
  }
})
