import assert from "node:assert/strict"
import { test } from "node:test"
import { Grants } from "../src/grants.js"
import { setupServer } from "../src/server.js"

async function fixture(t) {
  const grants = new Grants()
  const requests = new Map()
  let handlers
  let evaluate
  const replies = []
  const parents = { ses_child: "ses_root", ses_grandchild: "ses_child" }
  const ctx = {
    session: { get: async ({ sessionID }) => ({ id: sessionID, parentID: parents[sessionID] }) },
    rpc: { register: async (_definition, implementation) => {
      handlers = implementation
      return { dispose: async () => {} }
    } },
    permission: {
      get: async ({ sessionID, requestID }) => {
        const request = requests.get(requestID)
        if (!request || request.sessionID !== sessionID) throw new Error("Request not found")
        return request
      },
      reply: async (input) => {
        replies.push(input)
        if (!requests.delete(input.requestID)) throw new Error("Request already handled")
      },
      hook: async (_name, callback) => {
        evaluate = callback
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await setupServer(ctx, grants)
  t.after(cleanup)
  const { ownerID } = await handlers.open()
  const add = (id = "per_one", sessionID = "ses_root", action = "external_directory", resources = ["/reference/docs/*"]) => {
    const request = { id, sessionID, action, resources, save: ["*"] }
    requests.set(id, request)
    return request
  }
  const approve = (request, extra = {}) => handlers.grant({
    ownerID, rootSessionID: "ses_root", sessionID: request.sessionID,
    requestID: request.id, resources: request.resources, ...extra,
  }, { error: (_type, message) => { throw new Error(message) } })
  const check = async (overrides = {}) => {
    const event = { sessionID: "ses_root", action: "external_directory", resources: ["/reference/docs/*"], effect: "ask", ...overrides }
    await evaluate(event)
    return event.effect
  }
  return { handlers, ctx, ownerID, approve, add, check, grants, requests, replies, cleanup }
}

test("approves once without saving the tool's broader proposed patterns", async (t) => {
  const f = await fixture(t)
  await f.approve(f.add())
  assert.deepEqual(f.replies, [{ sessionID: "ses_root", requestID: "per_one", decision: "once" }])
  assert.equal(await f.check(), "allow")
  assert.equal(await f.check({ resources: ["/secret/*"] }), "ask")
  assert.equal(await f.check({ sessionID: "ses_other" }), "ask")
})

test("a conversation grant covers its subagents without crossing into another conversation", async (t) => {
  const f = await fixture(t)
  await f.approve(f.add("per_child", "ses_child"))
  assert.equal(await f.check({ sessionID: "ses_grandchild" }), "allow")
  assert.equal(await f.check(), "allow")
  assert.equal(await f.check({ sessionID: "ses_other" }), "ask")
})

test("does not change configured or plugin denials, reads, edits, or existing allows", async (t) => {
  const f = await fixture(t)
  await f.approve(f.add())
  assert.equal(await f.check({ effect: "deny" }), "deny")
  assert.equal(await f.check({ action: "edit" }), "ask")
  assert.equal(await f.check({ action: "read" }), "ask")
  assert.equal(await f.check({ effect: "allow", resources: ["/unrelated/*"] }), "allow")
})

test("rejects stale requests, unrelated sessions and other permission actions", async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.approve(f.add(), { resources: ["/secret/*"] }), /changed/)
  await assert.rejects(f.approve(f.add("per_other", "ses_other")), /selected conversation/)
  await assert.rejects(f.approve(f.add("per_edit", "ses_root", "edit")), /Only pending/)
  await assert.rejects(f.approve({ id: "per_missing", sessionID: "ses_root", resources: ["/reference/docs/*"] }), /not found/)
  assert.equal(await f.check(), "ask")
  assert.equal(f.replies.length, 0)
})

test("rolls back only the new grant when permission reply fails", async (t) => {
  const f = await fixture(t)
  await f.approve(f.add())
  f.ctx.permission.reply = async () => { throw new Error("Already replied") }
  await assert.rejects(f.approve(f.add("per_two", "ses_root", "external_directory", ["/reference/code/*"])), /Already replied/)
  assert.equal(await f.check(), "allow")
  assert.equal(await f.check({ resources: ["/reference/code/*"] }), "ask")
})

test("closing or revoking the granting terminal restores prompting", async (t) => {
  const f = await fixture(t)
  await f.approve(f.add())
  await f.handlers.revoke({ ownerID: f.ownerID, rootSessionID: "ses_root" })
  assert.equal(await f.check(), "ask")
  await f.approve(f.add("per_two"))
  await f.handlers.close({ ownerID: f.ownerID })
  assert.equal(await f.check(), "ask")
  await assert.rejects(f.approve(f.add("per_three")), /expired/)
})
