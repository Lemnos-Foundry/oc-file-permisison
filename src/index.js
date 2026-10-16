import { Plugin } from "@opencode/plugin"
import { setupServer } from "./server.js"

export default Plugin.define({
  id: "local.session-folder-permissions",
  setup: setupServer,
})
