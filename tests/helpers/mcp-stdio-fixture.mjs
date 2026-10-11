import { writeFileSync } from 'node:fs'

if (process.env.AURA_STDIO_FIXTURE_MARKER) writeFileSync(process.env.AURA_STDIO_FIXTURE_MARKER, String(process.pid))
if (process.argv.includes('--exit-early')) {
  process.stdout.write('fixture finished\n')
} else if (process.argv.includes('--ignore-eof')) {
  process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n')
  process.stdin.resume()
  setInterval(() => {}, 1000)
} else if (process.argv.includes('--echo')) {
  process.stdin.pipe(process.stdout)
} else {
  let pending = ''
  process.stderr.write('fixture stderr\n')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      if (!Object.hasOwn(request, 'id')) continue
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }, electron: process.env.ELECTRON_RUN_AS_NODE ?? null, privateMarker: process.env.DSH_AURA_STDIO_ORIGINAL_ELECTRON ?? null }
        : { tools: [{ name: 'fixture_tool', inputSchema: { type: 'object' } }] }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
    }
  })
}
