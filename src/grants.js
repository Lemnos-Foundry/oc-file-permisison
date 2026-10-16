import { randomUUID } from "node:crypto"
import path from "node:path"

export const LEASE_TTL_MS = 12_000
export const HEARTBEAT_MS = 3_000

// Tool resources are canonical directory boundaries, not arbitrary permission globs.
// Compare literal directory prefixes, so wildcard characters in names cannot widen a grant.
export function boundary(resource) {
  if (typeof resource !== "string" || !resource.endsWith("/*")) {
    throw new Error("Expected a canonical external folder boundary ending in /*.")
  }
  const directory = resource.slice(0, -2)
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === path.parse(directory).root) {
    throw new Error("Only a specific absolute folder can be approved, not the filesystem root.")
  }
  return process.platform === "win32" ? directory.replaceAll("\\", "/").toLowerCase() : directory
}

export function covers(granted, requested) {
  try {
    const parent = boundary(granted)
    const child = boundary(requested)
    return child === parent || child.startsWith(`${parent}/`)
  } catch {
    return false
  }
}

export class Grants {
  constructor({ now = () => performance.now(), ttlMs = LEASE_TTL_MS } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    this.owners = new Map()
  }

  open() {
    const ownerID = randomUUID()
    this.owners.set(ownerID, { expires: this.now() + this.ttlMs, grants: new Map() })
    return { ownerID, ttlMs: this.ttlMs }
  }

  owner(ownerID) {
    const owner = this.owners.get(ownerID)
    if (!owner) return undefined
    if (owner.expires <= this.now()) {
      this.owners.delete(ownerID)
      return undefined
    }
    return owner
  }

  heartbeat(ownerID) {
    const owner = this.owner(ownerID)
    if (!owner) return { active: false }
    owner.expires = this.now() + this.ttlMs
    return { active: true }
  }

  add(ownerID, rootSessionID, resources) {
    const owner = this.owner(ownerID)
    if (!owner) throw new Error("This terminal's permission lease expired. Approve the request again.")
    resources.forEach(boundary)
    const grantID = randomUUID()
    owner.grants.set(grantID, { rootSessionID, resources: [...resources] })
    return () => owner.grants.delete(grantID)
  }

  allows(rootSessionID, resources) {
    if (!resources.length) return false
    const approved = []
    for (const ownerID of this.owners.keys()) {
      const owner = this.owner(ownerID)
      if (!owner) continue
      for (const grant of owner.grants.values()) {
        if (grant.rootSessionID === rootSessionID) approved.push(...grant.resources)
      }
    }
    return resources.every((requested) => approved.some((granted) => covers(granted, requested)))
  }

  revoke(ownerID, rootSessionID) {
    const owner = this.owner(ownerID)
    if (!owner) return
    for (const [id, grant] of owner.grants) {
      if (grant.rootSessionID === rootSessionID) owner.grants.delete(id)
    }
  }

  close(ownerID) {
    this.owners.delete(ownerID)
  }

  prune() {
    for (const ownerID of this.owners.keys()) this.owner(ownerID)
  }

  clear() {
    this.owners.clear()
  }
}
