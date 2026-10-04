import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { providerFailure } from "./rsi-driver"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test.each(["observed", "plain-eof", "earlier-unknown", "later-success", "still-running", "legacy", "shutdown"])(
  "provider recovery uses only the final trusted wire observation: %s",
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-provider-"))
    roots.push(root)
    await fs.mkdir(path.join(root, "control"))
    const db = new Database(path.join(root, "control/requests.db"))
    db.exec(
      "CREATE TABLE request(id INTEGER PRIMARY KEY, peer_pid INTEGER, outcome TEXT, finished REAL, status INTEGER, terminal_at REAL, close_reason TEXT)",
    )
    db.exec("INSERT INTO request VALUES(1,42,'response.completed',1,200,1,'terminal_eof')")
    db.exec("INSERT INTO request VALUES(2,42,'transport_failed',2,200,NULL,'eof_without_terminal')")
    if (kind === "still-running") db.exec("UPDATE request SET finished=NULL WHERE id=2")
    if (kind === "earlier-unknown") db.exec("UPDATE request SET outcome='transport_failed' WHERE id=1")
    if (kind === "later-success")
      db.exec("INSERT INTO request VALUES(3,42,'response.completed',3,200,3,'terminal_eof')")
    if (kind !== "legacy") {
      db.exec(
        "CREATE TABLE provider_failure(request_id INTEGER PRIMARY KEY,kind TEXT,status INTEGER,code TEXT,frame_sha256 TEXT)",
      )
      if (kind !== "plain-eof")
        db.prepare("INSERT INTO provider_failure VALUES(2,'provider-unavailable',200,'500',?)").run("a".repeat(64))
    }
    if (kind === "shutdown")
      db.exec("UPDATE request SET outcome='gateway_stopped_unknown',close_reason='gateway_shutdown' WHERE id=2")
    db.close()
    const result = await providerFailure(root)
    if (kind === "observed") expect(result).toMatchObject({ request_id: 2, status: 200, code: "500" })
    else expect(result).toBeUndefined()
  },
)
