import { spawn } from 'node:child_process'

/**
 * Aura's old Python SDK cannot answer server/discover before initialize. Answer
 * that optional probe locally without starting Python, then transparently relay
 * the real session. MCP's disposable probe therefore finishes immediately.
 */
const [command, ...args] = process.argv.slice(2)
const env = { ...process.env }
const originalElectron = env.DSH_AURA_STDIO_ORIGINAL_ELECTRON
delete env.DSH_AURA_STDIO_ORIGINAL_ELECTRON
if (originalElectron !== undefined) {
  const value = JSON.parse(originalElectron)
  if (value === null) delete env.ELECTRON_RUN_AS_NODE
  else env.ELECTRON_RUN_AS_NODE = value
}

let child
let pending = Buffer.alloc(0)
let stopping = false
let stopTimer
let forceTimer
let stoppedExitCode = 0

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  stoppedExitCode = exitCode
  process.stdin.pause()
  if (!child) {
    process.exitCode = exitCode
    process.stdin.destroy()
    return
  }
  process.stdin.unpipe(child.stdin)
  child.stdin.end()
  // Older Aura servers may keep background threads alive after stdin closes.
  stopTimer = setTimeout(() => {
    child.kill('SIGTERM')
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 250)
  }, 250)
}

function startSession(bytes) {
  process.stdin.pause()
  process.stdin.removeListener('data', onData)
  child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  child.stdout.on('error', () => stop(1))
  child.stderr.on('error', () => stop(1))
  child.stdin.on('error', () => stop(1))
  child.on('error', (error) => {
    console.error(`Aura MCP subprocess could not start: ${error.message}`)
    stop(1)
  })
  child.once('close', (code, signal) => {
    clearTimeout(stopTimer)
    clearTimeout(forceTimer)
    process.stdin.destroy()
    process.exitCode = stopping ? stoppedExitCode : code ?? (signal ? 1 : 0)
  })
  const relay = () => {
    if (stopping) return
    if (process.stdin.readableEnded) stop()
    else process.stdin.pipe(child.stdin)
  }
  if (child.stdin.write(bytes)) relay()
  else child.stdin.once('drain', relay)
}

function onData(chunk) {
  pending = Buffer.concat([pending, chunk])
  for (;;) {
    const newline = pending.indexOf(10)
    if (newline < 0) return
    const bytes = pending.subarray(0, newline + 1)
    let request
    try { request = JSON.parse(bytes.toString('utf8')) } catch {}
    if (request?.jsonrpc === '2.0' && request.method === 'server/discover' && Object.hasOwn(request, 'id')) {
      pending = pending.subarray(newline + 1)
      const reply = JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'
      if (!process.stdout.write(reply)) {
        process.stdin.pause()
        process.stdout.once('drain', () => {
          if (stopping) return
          onData(Buffer.alloc(0))
          if (!child) process.stdin.resume()
        })
        return
      }
      continue
    }
    const firstBytes = pending
    pending = Buffer.alloc(0)
    startSession(firstBytes)
    return
  }
}

process.stdout.on('error', () => stop(1))
process.stderr.on('error', () => stop(1))
process.stdin.on('error', () => stop(1))
process.stdin.on('end', () => {
  if (!child && pending.length) {
    startSession(pending)
    pending = Buffer.alloc(0)
  }
  stop()
})
process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(130))
if (!command) {
  console.error('Aura MCP compatibility bridge requires a server command')
  process.exitCode = 1
} else process.stdin.on('data', onData)
