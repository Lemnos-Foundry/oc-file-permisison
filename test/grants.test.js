import assert from "node:assert/strict"
import { test } from "node:test"
import { boundary, covers, Grants } from "../src/grants.js"

test("folder matching includes descendants but excludes similarly named siblings", () => {
  assert.equal(covers("/reference/docs/*", "/reference/docs/*"), true)
  assert.equal(covers("/reference/docs/*", "/reference/docs/api/*"), true)
  assert.equal(covers("/reference/docs/*", "/reference/docs-private/*"), false)
  assert.equal(covers("/reference/docs/*", "/reference/*"), false)
})

test("wildcards and question marks in folder names are literal", () => {
  assert.equal(covers("/reference/a*b?/*", "/reference/aZZbX/*"), false)
  assert.equal(covers("/reference/a*b?/*", "/reference/a*b?/child/*"), true)
})

test("rejects broad, relative, non-canonical and non-boundary resources", () => {
  for (const value of ["*", "/*", "/", "relative/*", "/reference/../secret/*", "/reference//docs/*", "/reference/docs", "/reference/docs/**"]) {
    assert.throws(() => boundary(value))
    assert.equal(covers("/reference/docs/*", value), false)
  }
})

test("a lease grants access only to the approved conversation", () => {
  const grants = new Grants()
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*"])
  assert.equal(grants.allows("ses_one", ["/reference/docs/api/*"]), true)
  assert.equal(grants.allows("ses_two", ["/reference/docs/*"]), false)
  assert.equal(grants.allows("ses_one", []), false)
  assert.equal(grants.allows("ses_one", ["/reference/docs/*", "/secret/*"]), false)
})

test("every resource in a multi-folder request must be granted", () => {
  const grants = new Grants()
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*", "/reference/code/*"])
  assert.equal(grants.allows("ses_one", ["/reference/docs/api/*", "/reference/code/*"]), true)
})

test("normal closure revokes grants immediately", () => {
  const grants = new Grants()
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*"])
  grants.close(ownerID)
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), false)
  assert.deepEqual(grants.heartbeat(ownerID), { active: false })
})

test("expiry is checked on access even without the pruning timer", () => {
  let now = 0
  const grants = new Grants({ now: () => now, ttlMs: 12_000 })
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*"])
  now = 11_999
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), true)
  now = 12_000
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), false)
  assert.deepEqual(grants.heartbeat(ownerID), { active: false })
  assert.throws(() => grants.add(ownerID, "ses_one", ["/reference/docs/*"]), /expired/)
})

test("heartbeat extends a live lease but cannot resurrect an expired lease", () => {
  let now = 0
  const grants = new Grants({ now: () => now, ttlMs: 12_000 })
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*"])
  now = 3_000
  assert.deepEqual(grants.heartbeat(ownerID), { active: true })
  now = 12_001
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), true)
  now = 15_000
  assert.deepEqual(grants.heartbeat(ownerID), { active: false })
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), false)
})

test("revocation affects only the selected conversation and granting terminal", () => {
  const grants = new Grants()
  const one = grants.open().ownerID
  const two = grants.open().ownerID
  grants.add(one, "ses_one", ["/reference/docs/*"])
  grants.add(one, "ses_two", ["/reference/code/*"])
  grants.add(two, "ses_one", ["/reference/other/*"])
  grants.revoke(one, "ses_one")
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), false)
  assert.equal(grants.allows("ses_two", ["/reference/code/*"]), true)
  assert.equal(grants.allows("ses_one", ["/reference/other/*"]), true)
})

test("failed approval rollback preserves earlier grants", () => {
  const grants = new Grants()
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*"])
  const rollback = grants.add(ownerID, "ses_one", ["/reference/code/*"])
  rollback()
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), true)
  assert.equal(grants.allows("ses_one", ["/reference/code/*"]), false)
})

test("new server memory contains no previous grants", () => {
  const grants = new Grants()
  const { ownerID } = grants.open()
  grants.add(ownerID, "ses_one", ["/reference/docs/*"])
  assert.equal(new Grants().allows("ses_one", ["/reference/docs/*"]), false)
  grants.clear()
  assert.equal(grants.allows("ses_one", ["/reference/docs/*"]), false)
})
