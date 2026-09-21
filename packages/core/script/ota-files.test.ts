import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { artifact, run, stateDirectory } from "./ota-native"

const roots: string[] = []
const helper = path.join(import.meta.dir, "ota-files.py")
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ota-state-"))
  roots.push(root)
  await mkdir(path.join(root, "old"))
  return { root, old: path.join(root, "old"), next: path.join(root, "next"), receipt: path.join(root, "fork.json") }
}

test("quiescent snapshot preserves committed WAL and needs no inverse migration", async () => {
  const f = await fixture()
  await run([
    "python3",
    "-I",
    "-c",
    `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('pragma journal_mode=WAL');c.execute('pragma wal_autocheckpoint=0')
c.execute('create table memory (value text)');c.execute("insert into memory values ('keep')");c.commit()
os._exit(0)
`,
    path.join(f.old, "memory.db"),
  ])
  expect(await Bun.file(path.join(f.old, "memory.db-wal")).exists()).toBe(true)
  await run(["python3", "-I", helper, "fork", f.old, f.next, f.receipt])
  const changed = new Database(path.join(f.next, "memory.db"))
  expect(changed.query("SELECT value FROM memory").get()).toEqual({ value: "keep" })
  changed.exec("ALTER TABLE memory ADD COLUMN incompatible INTEGER; UPDATE memory SET value='trial-damaged'")
  changed.close()
  const rollback = path.join(f.root, "rollback")
  await run(["python3", "-I", helper, "fork", f.old, rollback, path.join(f.root, "rollback.json")])
  const restored = new Database(path.join(rollback, "memory.db"))
  expect(restored.query("SELECT * FROM memory").get()).toEqual({ value: "keep" })
  restored.close()
  expect((await stat(path.join(f.old, "memory.db"))).ino).not.toBe((await stat(path.join(f.next, "memory.db"))).ino)
})

test("snapshot never follows a model-created link into authority state", async () => {
  const f = await fixture()
  const authority = path.join(f.root, "authority")
  await Bun.write(authority, "authoritative history")
  await symlink(authority, path.join(f.old, "escape"))
  await run(["python3", "-I", helper, "fork", f.old, f.next, f.receipt])
  expect(await Bun.file(authority).text()).toBe("authoritative history")
  expect(JSON.parse(await run(["python3", "-I", helper, "tree", f.next]))).toEqual({ escape: { link: authority } })
})

test("host startup and grading reject guest links in parent directories", async () => {
  const f = await fixture()
  await mkdir(path.join(f.root, "authority"))
  await Bun.write(path.join(f.root, "authority/h"), "private")
  await symlink(path.join(f.root, "authority"), path.join(f.old, "work"))
  await expect(stateDirectory(f.old, "work")).rejects.toThrow("unsafe private state")
  await expect(artifact(path.join(f.old, "work"), "h")).rejects.toThrow("unsafe artifact")
  expect(await Bun.file(path.join(f.root, "authority/h")).text()).toBe("private")
})

test.each(["hardlink", "fifo"])("snapshot rejects %s rather than sharing unsafe mutable state", async (kind) => {
  const f = await fixture()
  if (kind === "hardlink") {
    await Bun.write(path.join(f.old, "one"), "data")
    await link(path.join(f.old, "one"), path.join(f.old, "two"))
  }
  if (kind === "fifo") await run(["mkfifo", path.join(f.old, "fifo")])
  await expect(run(["python3", "-I", helper, "fork", f.old, f.next, f.receipt])).rejects.toThrow()
  expect(await Bun.file(f.receipt).exists()).toBe(false)
})

test("export refuses symlink archives and accepts only the exact regular artifact", async () => {
  const f = await fixture()
  const archive = path.join(f.root, "good.tar")
  await run([
    "python3",
    "-I",
    "-c",
    `import io,tarfile,sys
with tarfile.open(sys.argv[1],'w') as t:
 m=tarfile.TarInfo('opencode');m.size=4;t.addfile(m,io.BytesIO(b'code'))
with tarfile.open(sys.argv[2],'w') as t:
 m=tarfile.TarInfo('opencode');m.type=tarfile.SYMTYPE;m.linkname='/etc/passwd';t.addfile(m)
`,
    archive,
    path.join(f.root, "bad.tar"),
  ])
  const good = Bun.spawn(["python3", "-I", helper, "export", path.join(f.root, "opencode"), "opencode", "1024"], {
    stdin: Bun.file(archive),
    stderr: "pipe",
  })
  expect(await good.exited).toBe(0)
  expect(await Bun.file(path.join(f.root, "opencode")).text()).toBe("code")
  const bad = Bun.spawn(["python3", "-I", helper, "export", path.join(f.root, "escaped"), "opencode", "1024"], {
    stdin: Bun.file(path.join(f.root, "bad.tar")),
    stderr: "pipe",
  })
  await new Response(bad.stderr).text()
  expect(await bad.exited).not.toBe(0)
  expect(await Bun.file(path.join(f.root, "escaped")).exists()).toBe(false)
})

test("full source snapshots cannot omit code through export-ignore attributes", async () => {
  const f = await fixture()
  await run(["git", "init", "-q", f.old])
  await Bun.write(path.join(f.old, ".gitattributes"), "secret.ts export-ignore\n")
  await Bun.write(path.join(f.old, "secret.ts"), "export const realCode = 1\n")
  await run(["git", "-C", f.old, "add", "."])
  const output = path.join(f.root, "source.tar")
  await run(["python3", "-I", helper, "source", f.old, output])
  const names = await run(["tar", "-tf", output])
  expect(names).toContain("secret.ts")
})
