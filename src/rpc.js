import { Rpc } from "@opencode/plugin/rpc"

const string = { type: "string", minLength: 1 }
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

export const SessionFolders = Rpc.define({
  id: "local.session-folders",
  events: {},
  methods: {
    open: { input: object({}), output: object({ ownerID: string, ttlMs: { type: "number" } }) },
    heartbeat: {
      input: object({ ownerID: string }),
      output: object({ active: { type: "boolean" } }),
    },
    close: { input: object({ ownerID: string }), output: object({}) },
    grant: {
      input: object({
        ownerID: string,
        rootSessionID: string,
        sessionID: string,
        requestID: string,
        resources: { type: "array", items: string, minItems: 1 },
      }),
      output: object({ resources: { type: "array", items: string } }),
      errors: { approval_failed: object({}) },
    },
    revoke: { input: object({ ownerID: string, rootSessionID: string }), output: object({}) },
  },
})
