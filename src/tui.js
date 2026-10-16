import { Plugin } from "@opencode/plugin/tui"
import { setupTerminal } from "./terminal.js"

export default Plugin.define({
  id: "local.session-folder-permissions.tui",
  setup: setupTerminal,
})
