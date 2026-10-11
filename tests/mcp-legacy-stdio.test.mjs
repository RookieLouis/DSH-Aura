import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { prepareAuraStdioConfig } from '../lib/mcp/client.js'

const bridge = fileURLToPath(new URL('../lib/mcp/legacy-stdio.js', import.meta.url))
const fixture = fileURLToPath(new URL('./helpers/mcp-stdio-fixture.mjs', import.meta.url))
const frame = (method, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n'

function launch(args = [], env = {}, command = process.execPath) {
  const child = spawn(process.execPath, [bridge, command, fixture, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const closed = once(child, 'close')
  return { child, closed, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr).toString() }
}

test('compatibility applies only to known Aura legacy Python entries and preserves caller config', () => {
  const runtime = { execPath: 'electron.exe', versions: { electron: '1' }, env: {} }
  const config = { transport: 'stdio', serverName: 'unreal_inspector', command: 'D:/UE/Aura/PortablePython/Windows/python.exe', args: ['D:/UE/Aura/MCP/unreal_inspector.py'], env: { CUSTOM: 'preserved' }, toolCallTimeoutMs: 300000 }
  const wrapped = prepareAuraStdioConfig(config, runtime)
  assert.equal(wrapped.command, runtime.execPath)
  assert.deepEqual(wrapped.args.slice(2), [config.command, ...config.args])
  assert.equal(wrapped.args[1], bridge)
  assert.equal(wrapped.env.CUSTOM, 'preserved')
  assert.equal(wrapped.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(wrapped.env.DSH_AURA_STDIO_ORIGINAL_ELECTRON, 'null')
  assert.equal(wrapped.toolCallTimeoutMs, config.toolCallTimeoutMs)
  assert.deepEqual(config.env, { CUSTOM: 'preserved' })
  for (const other of [
    { ...config, serverName: 'browser' },
    { ...config, serverName: 'unreal_mcp' },
    { ...config, transport: 'streamable-http' },
    { ...config, args: ['D:/custom/unreal_inspector.py'] },
    { ...config, args: [...config.args, '--custom'] },
    { ...config, command: 'custom-server.exe' },
  ]) assert.equal(prepareAuraStdioConfig(other, runtime), other)
  const standalone = prepareAuraStdioConfig(config, { ...runtime, versions: {} })
  assert.equal(standalone.env.ELECTRON_RUN_AS_NODE, undefined)
  const explicit = prepareAuraStdioConfig({ ...config, env: { ELECTRON_RUN_AS_NODE: '0' } }, runtime)
  assert.equal(explicit.env.DSH_AURA_STDIO_ORIGINAL_ELECTRON, '"0"')
})

test('compatibility covers the default aura-client install and Unreal plugin installs', () => {
  for (const serverName of ['unreal_inspector', 'unreal_editor']) {
    for (const root of ['C:\\Users\\Example\\AppData\\Local\\Programs\\aura-client', 'D:\\UE_5.8\\Engine\\Plugins\\Marketplace\\Aura']) {
      const command = `${root}\\PortablePython\\Windows\\python.exe`
      const script = `${root}\\MCP\\${serverName}.py`
      const config = { transport: 'stdio', serverName, command, args: [script] }
      const wrapped = prepareAuraStdioConfig(config)
      assert.equal(wrapped.command, process.execPath, `${root}: ${serverName} was not wrapped`)
      assert.deepEqual(wrapped.args.slice(2), [command, script])
    }
  }
})

test('discover replies for string and zero ids without spawning the real server', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-mcp-probe-'))
  const marker = join(dir, 'started')
  const run = launch([], { AURA_STDIO_FIXTURE_MARKER: marker })
  try {
    const firstReply = once(run.child.stdout, 'data')
    const start = performance.now()
    run.child.stdin.write(frame('server/discover', 'probe'))
    await firstReply
    assert.ok(performance.now() - start < 2500, 'probe must finish before a protocol timeout')
    run.child.stdin.end(frame('server/discover', 0))
    const [code] = await run.closed
    assert.equal(code, 0)
    const replies = run.stdout().toString().trim().split('\n').map(JSON.parse)
    assert.deepEqual(replies.map((reply) => [reply.id, reply.error.code]), [['probe', -32601], [0, -32601]])
    assert.equal(existsSync(marker), false, 'disposable probe must not launch Python')
  } finally {
    run.child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fragmented Unicode initialize and batched tools/list relay with stderr separated and environment restored', { timeout: 5000 }, async () => {
  const run = launch([], { ELECTRON_RUN_AS_NODE: '1', DSH_AURA_STDIO_ORIGINAL_ELECTRON: 'null' })
  const requests = Buffer.from(frame('initialize', '中文🌏') + frame('tools/list', 2))
  run.child.stdin.write(requests.subarray(0, 43))
  run.child.stdin.end(requests.subarray(43))
  const [code] = await run.closed
  assert.equal(code, 0)
  const replies = run.stdout().toString().trim().split('\n').map(JSON.parse)
  assert.deepEqual(replies.map((reply) => reply.id), ['中文🌏', 2])
  assert.equal(replies[0].result.electron, null)
  assert.equal(replies[0].result.privateMarker, null)
  assert.equal(replies[1].result.tools[0].name, 'fixture_tool')
  assert.match(run.stderr(), /fixture stderr/)
})

test('byte relay respects backpressure and preserves a large frame exactly', { timeout: 10000 }, async () => {
  const run = launch(['--echo'])
  const payload = Buffer.from(frame('echo') + '中🌏'.repeat(400000) + '\n')
  run.child.stdin.end(payload)
  const [code] = await run.closed
  assert.equal(code, 0)
  assert.deepEqual(run.stdout(), payload)
})

test('stdin EOF reaps a server that ignores EOF', { timeout: 5000 }, async () => {
  const run = launch(['--ignore-eof'])
  const response = once(run.child.stdout, 'data')
  run.child.stdin.write(frame('initialize'))
  await response
  const pid = JSON.parse(run.stdout().toString()).pid
  run.child.stdin.end()
  const [code] = await run.closed
  assert.equal(code, 0)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'server process must be reaped')
})

test('server exit closes the bridge even while caller stdin remains open', { timeout: 5000 }, async () => {
  const run = launch(['--exit-early'])
  run.child.stdin.write(frame('initialize'))
  const [code] = await run.closed
  assert.equal(code, 0)
  assert.equal(run.stdout().toString(), 'fixture finished\n')
})

test('bridge restores an explicit Electron environment value for the real server', { timeout: 5000 }, async () => {
  const run = launch([], { ELECTRON_RUN_AS_NODE: '1', DSH_AURA_STDIO_ORIGINAL_ELECTRON: '"0"' })
  run.child.stdin.end(frame('initialize'))
  const [code] = await run.closed
  assert.equal(code, 0)
  assert.equal(JSON.parse(run.stdout().toString()).result.electron, '0')
})

test('failed subprocess launch exits nonzero and reports only on stderr', { timeout: 5000 }, async () => {
  const run = launch([], {}, join(tmpdir(), 'aura-no-such-executable'))
  run.child.stdin.end(frame('initialize'))
  const [code] = await run.closed
  assert.equal(code, 1)
  assert.equal(run.stdout().length, 0)
  assert.match(run.stderr(), /could not start/)
})
