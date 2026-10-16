import assert from "node:assert/strict"
import { test } from "node:test"
import { setupTerminal } from "../src/terminal.js"

function fixture(t, { confirm = true, pending = true } = {}) {
  const calls = []
  const toasts = []
  let commands
  let asked
  const request = { id: "per_one", sessionID: "ses_child", action: "external_directory", resources: ["/reference/docs/*"] }
  const rpc = {
    open: async (_input, options) => { calls.push(["open", options]); return { ownerID: "terminal-one", ttlMs: 12_000 } },
    heartbeat: async () => ({ active: true }),
    grant: async (input, options) => { calls.push(["grant", input, options]); return { resources: input.resources } },
    close: async (input, options) => { calls.push(["close", input, options]) },
    revoke: async (input, options) => { calls.push(["revoke", input, options]) },
  }
  const location = { directory: "/workspace" }
  const ctx = {
    location,
    client: { rpc: () => rpc },
    data: {
      session: {
        root: () => "ses_root",
        family: () => ["ses_root", "ses_child"],
        get: () => ({ title: "Test conversation", location }),
        permission: {
          sync: async () => {},
          list: (sessionID) => pending && sessionID === "ses_child" ? [request] : [],
          invalidate: (sessionID) => { calls.push(["invalidate", sessionID]) },
        },
      },
      location: { default: () => location },
      on: (_event, callback) => { asked = callback; return () => { calls.push(["stopAsked"]) } },
    },
    keymap: { layer: (input) => { commands = input().commands } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_root" }) },
      toast: { show: (input) => { toasts.push(input) } },
      format: { path: (value) => value },
      dialog: {
        confirm: async (input) => { calls.push(["confirm", input]); return confirm },
        select: async () => request.id,
      },
      slot: (input) => { input.render(); return () => { calls.push(["removeSlot"]) } },
    },
  }
  const cleanup = setupTerminal(ctx)
  t.after(cleanup)
  const run = (id) => commands.find((command) => command.id === id).run()
  return { calls, toasts, run, cleanup, rpc, asked, ctx }
}

test("approval requires confirmation and sends the exact pending request to its location", async (t) => {
  const f = fixture(t)
  await f.run("session-folders.allow")
  const grant = f.calls.find(([method]) => method === "grant")
  assert.deepEqual(grant[1], {
    ownerID: "terminal-one", rootSessionID: "ses_root", sessionID: "ses_child",
    requestID: "per_one", resources: ["/reference/docs/*"],
  })
  assert.deepEqual(grant[2].location, { directory: "/workspace" })
  assert.equal(f.toasts.at(-1).variant, "success")
  assert.ok(f.calls.find(([method]) => method === "confirm"))
})

test("cancelling the dialog creates no lease and approves nothing", async (t) => {
  const f = fixture(t, { confirm: false })
  await f.run("session-folders.allow")
  assert.equal(f.calls.some(([method]) => method === "open" || method === "grant"), false)
})

test("no pending external-folder request creates no grant", async (t) => {
  const f = fixture(t, { pending: false })
  await f.run("session-folders.allow")
  assert.match(f.toasts.at(-1).message, /No external-folder/)
  assert.equal(f.calls.some(([method]) => method === "grant"), false)
})

test("terminal cleanup closes its leases without granting or persisting permissions", async (t) => {
  const f = fixture(t)
  await f.run("session-folders.allow")
  await f.cleanup()
  assert.deepEqual(f.calls.find(([method]) => method === "close")[1], { ownerID: "terminal-one" })
  assert.ok(f.calls.find(([method]) => method === "stopAsked"))
  const count = f.calls.length
  await f.run("session-folders.allow")
  assert.equal(f.calls.length, count)
})

test("manual revocation targets only the current terminal and conversation", async (t) => {
  const f = fixture(t)
  await f.run("session-folders.allow")
  await f.run("session-folders.revoke")
  assert.deepEqual(f.calls.find(([method]) => method === "revoke")[1], {
    ownerID: "terminal-one", rootSessionID: "ses_root",
  })
})

test("RPC errors are shown instead of reporting successful approval", async (t) => {
  const f = fixture(t)
  f.rpc.grant = async () => { throw new Error("Request already handled") }
  await f.run("session-folders.allow")
  assert.equal(f.toasts.at(-1).variant, "error")
  assert.match(f.toasts.at(-1).message, /already handled/)
})
