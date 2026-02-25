import type { Plugin } from "@opencode-ai/plugin"
import { OpenClawBridgePlugin } from "./openclaw-bridge.ts"
import { SharedMemoryPlugin } from "./shared-memory.ts"
import { OpenCrewRealtimePlugin } from "./opencrew-rt.ts"
import { OpenCrewDBPlugin } from "./opencrew-db.ts"

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
