import { Grants, HEARTBEAT_MS } from "./grants.js"
import { SessionFolders } from "./rpc.js"

export async function setupServer(ctx, grants = new Grants()) {
  const root = async (sessionID) => {
    const visited = new Set()
    while (!visited.has(sessionID) && visited.size < 64) {
      visited.add(sessionID)
      const session = await ctx.session.get({ sessionID })
      if (!session.parentID) return sessionID
      sessionID = session.parentID
    }
    throw new Error("Unable to determine this conversation's parent session.")
  }

  const rpc = await ctx.rpc.register(SessionFolders, {
    open: async () => grants.open(),
    heartbeat: async ({ ownerID }) => grants.heartbeat(ownerID),
    close: async ({ ownerID }) => {
      grants.close(ownerID)
      return {}
    },
    revoke: async ({ ownerID, rootSessionID }) => {
      grants.revoke(ownerID, rootSessionID)
      return {}
    },
    grant: async ({ ownerID, rootSessionID, sessionID, requestID, resources }, call) => {
      try {
        const request = await ctx.permission.get({ sessionID, requestID })
        if (request.action !== "external_directory" || request.sessionID !== sessionID) {
          throw new Error("Only pending external-folder requests can receive a temporary grant.")
        }
        if (request.resources.length !== resources.length || request.resources.some((value, index) => value !== resources[index])) {
          throw new Error("The permission request changed. Review and approve it again.")
        }
        if (await root(sessionID) !== rootSessionID) {
          throw new Error("The request does not belong to the selected conversation.")
        }
        // Install before replying: the agent can start its next tool as soon as the reply resolves.
        // Roll back this grant only if the pending request was already handled by another client.
        const rollback = grants.add(ownerID, rootSessionID, request.resources)
        try {
          // V2.0.21 names this field `decision`, despite the docs' `reply` example.
          await ctx.permission.reply({ sessionID, requestID, decision: "once" })
        } catch (error) {
          rollback()
          throw error
        }
        return { resources: [...request.resources] }
      } catch (error) {
        return call.error("approval_failed", error?.message ?? "The request could not be approved. Review it and try again.", {})
      }
    },
  })

  let hook
  try {
    hook = await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "external_directory" || event.effect !== "ask") return
      if (grants.allows(await root(event.sessionID), event.resources)) event.effect = "allow"
    })
  } catch (error) {
    await rpc.dispose()
    throw error
  }

  const timer = setInterval(() => grants.prune(), HEARTBEAT_MS)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    grants.clear()
    await hook.dispose()
    await rpc.dispose()
  }
}
