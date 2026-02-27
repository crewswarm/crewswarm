#!/usr/bin/env node
/**
 * OpenCrew RT CLI - Start/stop/status the realtime server
 */
import { startServer, runtimeStatus } from './dist/opencrew-rt.js'

const action = process.argv[2] || 'start'

if (action === 'start') {
  const port = Number(process.env.CREWSWARM_RT_PORT || '18889')
  const host = process.env.CREWSWARM_RT_HOST || '127.0.0.1'
  const requireToken = process.env.CREWSWARM_RT_REQUIRE_TOKEN !== '0'
  const token = process.env.CREWSWARM_RT_AUTH_TOKEN || ''
  
  console.log(`[opencrew-rt] Starting server on ${host}:${port}...`)
  startServer({
    host,
    port,
    secure: false,
    requireToken,
    token,
  }).then(() => {
    console.log(`[opencrew-rt] Server running on ws://${host}:${port}`)
  }).catch(err => {
    console.error(`[opencrew-rt] Failed to start: ${err.message}`)
    process.exit(1)
  })
} else if (action === 'status') {
  console.log(JSON.stringify(runtimeStatus(), null, 2))
} else {
  console.log('Usage: node opencrew-rt-cli.mjs [start|status]')
}
