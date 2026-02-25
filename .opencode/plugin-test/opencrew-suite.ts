import type { Plugin } from "@opencode-ai/plugin"
import { OpenClawBridgePlugin } from "./openclaw-bridge.js"
import { SharedMemoryPlugin } from "./shared-memory.js"
import { OpenCrewRealtimePlugin } from "./opencrew-rt.js"
import { OpenCrewDBPlugin } from "./opencrew-db.js"

export const OpenCrewSuitePlugin: Plugin = async (ctx) => {
  const [bridge, memory, realtime, db] = await Promise.all([
    OpenClawBridgePlugin(ctx),
    SharedMemoryPlugin(ctx),
    OpenCrewRealtimePlugin(ctx),
    OpenCrewDBPlugin(ctx),
  ])
  return {
    tool: {
      ...bridge.tool,
      ...memory.tool,
      ...realtime.tool,
      ...db.tool,
    },
  }
}

export default OpenCrewSuitePlugin
