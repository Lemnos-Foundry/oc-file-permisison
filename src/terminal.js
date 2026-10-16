import { HEARTBEAT_MS } from "./grants.js"
import { SessionFolders } from "./rpc.js"

export function setupTerminal(ctx) {
  const rpc = ctx.client.rpc(SessionFolders)
  const owners = new Map()
  const controller = new AbortController()
  let closed = false
  let busy = false
  let beating = false

  const selected = () => {
    const route = ctx.ui.router.current()
    if (route.type !== "session") return undefined
    const rootSessionID = ctx.data.session.root(route.sessionID)
    const session = ctx.data.session.get(rootSessionID)
    const location = session?.location ?? ctx.location ?? ctx.data.location.default()
    return { rootSessionID, location }
  }
  const options = (location) => ({
    location,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  })
  const key = (location) => JSON.stringify(location)
  const toast = (message, variant = "info") => {
    if (!closed) ctx.ui.toast.show({ title: "Session folder permissions", message, variant })
  }

  const owner = async (location) => {
    const existing = owners.get(key(location))
    if (existing) return existing
    const result = await rpc.open({}, options(location))
    if (closed) {
      await rpc.close({ ownerID: result.ownerID }, { location, signal: AbortSignal.timeout(2_000) })
      throw new Error("The terminal has closed.")
    }
    const entry = { ownerID: result.ownerID, location }
    owners.set(key(location), entry)
    return entry
  }

  const heartbeat = async () => {
    if (closed || beating) return
    beating = true
    try {
      await Promise.all([...owners.entries()].map(async ([locationKey, entry]) => {
        try {
          const result = await rpc.heartbeat({ ownerID: entry.ownerID }, {
            location: entry.location,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
          })
          if (!result.active && owners.get(locationKey) === entry) {
            owners.delete(locationKey)
            toast("Temporary folder grants expired. Approve folder access again.", "warning")
          }
        } catch {
          // The server expires the lease even if the connection is lost or the terminal is killed.
          // Do not silently recreate an expired lease or replay previous grants.
        }
      }))
    } finally {
      beating = false
    }
  }

  const approve = async () => {
    if (closed || busy) return
    busy = true
    try {
      const current = selected()
      if (!current) return toast("Open a conversation with a pending external-folder request.")
      const family = ctx.data.session.family(current.rootSessionID)
      const sessionIDs = [...new Set([current.rootSessionID, ...family])]
      await Promise.all(sessionIDs.map((sessionID) => ctx.data.session.permission.sync(sessionID)))
      const pending = sessionIDs.flatMap((sessionID) => ctx.data.session.permission.list(sessionID) ?? [])
        .filter((request) => request.action === "external_directory")
      if (closed) return
      if (!pending.length) return toast("No external-folder permission request is pending in this conversation.")
      let request = pending[0]
      if (pending.length > 1) {
        const requestID = await ctx.ui.dialog.select({
          title: "Choose a pending folder request",
          options: pending.map((item) => ({
            title: item.resources.map((resource) => ctx.ui.format.path(resource)).join(", "),
            description: ctx.data.session.get(item.sessionID)?.title ?? item.sessionID,
            value: item.id,
          })),
        })
        request = pending.find((item) => item.id === requestID)
        if (!request || closed) return
      }
      const confirmed = await ctx.ui.dialog.confirm({
        title: "Allow external folder for this session?",
        message: `${request.resources.join("\n")}\n\nAllow these folders and their subfolders in this conversation and its subagents until this terminal closes. Other permissions still apply. No project approval will be saved.`,
        label: { confirm: "Allow for this session", cancel: "Cancel" },
      })
      if (!confirmed || closed) return
      const entry = await owner(current.location)
      if (closed) return
      await rpc.grant({
        ownerID: entry.ownerID,
        rootSessionID: current.rootSessionID,
        sessionID: request.sessionID,
        requestID: request.id,
        resources: [...request.resources],
      }, options(current.location))
      ctx.data.session.permission.invalidate(request.sessionID)
      toast("Folder access allowed until this terminal closes.", "success")
    } catch (error) {
      toast(error?.message ?? String(error), "error")
    } finally {
      busy = false
    }
  }

  const revoke = async () => {
    if (closed || busy) return
    busy = true
    try {
      const current = selected()
      if (!current) return toast("Open the conversation whose temporary grants you want to revoke.")
      const entry = owners.get(key(current.location))
      if (entry) await rpc.revoke({ ownerID: entry.ownerID, rootSessionID: current.rootSessionID }, options(current.location))
      toast("This terminal's temporary folder grants for this conversation were revoked.", "success")
    } catch (error) {
      toast(error?.message ?? String(error), "error")
    } finally {
      busy = false
    }
  }

  // Mount the keymap in an app slot so its Solid owner is disposed with the plugin.
  const removeSlot = ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 20,
        commands: [
          {
            id: "session-folders.allow",
            title: "Allow external folder for this session",
            group: "Permissions",
            bind: "ctrl+alt+a",
            palette: true,
            slash: { name: "allow-session" },
            enabled: () => !closed && ctx.ui.router.current().type === "session",
            run: approve,
          },
          {
            id: "session-folders.revoke",
            title: "Revoke this session's temporary folder permissions",
            group: "Permissions",
            palette: true,
            slash: { name: "revoke-session-folders" },
            enabled: () => !closed && ctx.ui.router.current().type === "session",
            run: revoke,
          },
        ],
        bindings: ["session-folders.allow"],
      }))
      return null
    },
  })

  const stopAsked = ctx.data.on("permission.asked", (event) => {
    if (event.data.action !== "external_directory") return
    const current = selected()
    if (!current || ctx.data.session.root(event.data.sessionID) !== current.rootSessionID) return
    toast("Use Ctrl+Alt+A or 'Allow external folder for this session' in the command palette for temporary access.")
  })
  const timer = setInterval(() => { void heartbeat() }, HEARTBEAT_MS)
  timer.unref?.()

  // OpenCode V2.0.21 awaits plugin cleanup during normal terminal shutdown.
  return async () => {
    closed = true
    clearInterval(timer)
    controller.abort()
    stopAsked()
    removeSlot()
    const entries = [...owners.values()]
    owners.clear()
    await Promise.all(entries.map((entry) => rpc.close({ ownerID: entry.ownerID }, {
      location: entry.location,
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined)))
  }
}
