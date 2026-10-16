import assert from "node:assert/strict"
import { test } from "node:test"
import { Host } from "@opencode/plugin/host"
import { fileURLToPath } from "node:url"
import { SessionFolders } from "../src/rpc.js"

test("local package exposes all entrypoints OpenCode's directory loader needs", () => {
  const directory = fileURLToPath(new URL("../", import.meta.url))
  const entrypoints = Host.resolve({ directory })
  assert.ok(entrypoints.server.endsWith("/index.js"))
  assert.ok(entrypoints.tui.endsWith("/tui.js"))
  assert.ok(entrypoints.rpc.endsWith("/rpc.js"))
})

test("RPC contract supplies the schemas required by V2.0.21 and V2.0.22", () => {
  assert.deepEqual(SessionFolders.events, {})
  for (const [name, method] of Object.entries(SessionFolders.methods)) {
    assert.equal(method.input.type, "object", `${name} needs an input schema`)
    assert.equal(method.output.type, "object", `${name} needs an output schema`)
    assert.equal(method.input.additionalProperties, false)
    assert.equal(method.output.additionalProperties, false)
  }
})
