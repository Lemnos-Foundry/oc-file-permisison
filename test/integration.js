// Run manually against a fresh, disposable directory. No prompts or models are invoked.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { SessionFolders } from "../src/rpc.js"
import { LEASE_TTL_MS } from "../src/grants.js"

const directory = process.argv[2]
if (!directory) throw new Error("Pass a disposable test directory as the first argument.")
const endpoint = await Service.discover()
if (!endpoint) throw new Error("No healthy OpenCode service is running.")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const location = { directory }
const rpc = client.rpc(SessionFolders)
const sessions = []
let ownerID
const resource = "/session-folder-permissions-integration/reference/*"
// The running server supports parentID; the 2.0.21 generated client omits it.
const createChild = (input) => JSON.parse(execFileSync("opencode", [
  "api", "post", "/api/session", "--data", JSON.stringify(input),
], { encoding: "utf8" })).data

try {
  const root = await client.session.create({ title: "Temporary folder plugin integration test", location, agent: "build" })
  sessions.push(root.id)
  // Session creation waits for cold-location plugin activation. Inventory reads do not.
  const inventory = await client.plugin.list({ location })
  const plugin = inventory.data.find((item) => item.id === "local.session-folder-permissions")
  assert.equal(plugin?.state.status, "active", JSON.stringify(plugin))
  assert.equal(plugin.features.tui, true)
  console.log("PASS: server and terminal entrypoints discovered")
  const child = createChild({ parentID: root.id, agent: "build", title: "Temporary folder plugin integration child" })
  sessions.push(child.id)
  assert.equal(child.parentID, root.id)
  const other = await client.session.create({ title: "Temporary folder plugin isolated conversation", location, agent: "build" })
  sessions.push(other.id)
  const denied = createChild({
    parentID: root.id, agent: "build", title: "Temporary folder plugin integration denied child",
    permissions: [{ action: "external_directory", resource: "*", effect: "deny" }],
  })
  sessions.push(denied.id)
  const savedBefore = await client.permission.saved.list({ projectID: root.projectID })
  const ask = (sessionID, resources = [resource]) => client.permission.create({
    sessionID, action: "external_directory", resources, save: [resource],
  })
  const pending = await ask(root.id)
  assert.equal(pending.effect, "ask")
  ownerID = (await rpc.open({}, { location })).ownerID
  await rpc.grant({
    ownerID, rootSessionID: root.id, sessionID: root.id,
    requestID: pending.id, resources: [resource],
  }, { location })
  assert.equal((await ask(root.id)).effect, "allow")
  assert.equal((await ask(child.id, [resource.replace("/*", "/subfolder/*")])).effect, "allow")
  assert.equal((await ask(other.id)).effect, "ask")
  assert.equal((await ask(denied.id)).effect, "deny")
  console.log("PASS: temporary grant allows conversation and child only, preserves explicit deny")

  const savedAfter = await client.permission.saved.list({ projectID: root.projectID })
  const relevant = (items) => items.filter((item) => item.action === "external_directory" && item.resource === resource)
  assert.deepEqual(relevant(savedAfter), relevant(savedBefore))
  console.log("PASS: no project-wide approval saved")

  await rpc.close({ ownerID }, { location })
  assert.equal((await ask(root.id)).effect, "ask")
  console.log("PASS: normal terminal cleanup restores prompting")

  ownerID = (await rpc.open({}, { location })).ownerID
  const next = await ask(root.id)
  await rpc.grant({ ownerID, rootSessionID: root.id, sessionID: root.id, requestID: next.id, resources: [resource] }, { location })
  await delay(LEASE_TTL_MS + 100)
  assert.equal((await ask(root.id)).effect, "ask")
  assert.deepEqual(await rpc.heartbeat({ ownerID }, { location }), { active: false })
  console.log("PASS: lost heartbeat expires grants and cannot resurrect them")
} finally {
  if (ownerID) await rpc.close({ ownerID }, { location }).catch(() => {})
  for (const sessionID of sessions.reverse()) {
    await client.session.remove({ sessionID }).catch(() => {})
  }
}
