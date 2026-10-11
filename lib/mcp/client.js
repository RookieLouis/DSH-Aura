import { apply as upstreamApply } from '@deepseek-ai/dsh-mcp-client'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export { Config, inject, name } from '@deepseek-ai/dsh-mcp-client'

/** Only Aura's known legacy Python servers need the pre-initialize compatibility bridge. */
export function prepareAuraStdioConfig(config, runtime = process) {
  if (config.transport !== 'stdio' || !['unreal_inspector', 'unreal_editor'].includes(config.serverName)) return config
  if (!Array.isArray(config.args) || config.args.length !== 1 || typeof config.args[0] !== 'string') return config
  const script = config.args[0].replaceAll('\\', '/').toLowerCase()
  const suffixes = [`/aura/mcp/${config.serverName}.py`, `/aura-client/mcp/${config.serverName}.py`]
  if (!suffixes.some((suffix) => script.endsWith(suffix))) return config
  if (!['python', 'python3', 'python.exe', 'python3.exe'].includes(basename(config.command.replaceAll('\\', '/')).toLowerCase())) return config
  const env = { ...config.env }
  if (runtime.versions.electron) {
    // The child wrapper must run Electron as Node; Python receives the original value.
    env.DSH_AURA_STDIO_ORIGINAL_ELECTRON = JSON.stringify(env.ELECTRON_RUN_AS_NODE ?? runtime.env.ELECTRON_RUN_AS_NODE ?? null)
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  return {
    ...config,
    command: runtime.execPath,
    args: ['--expose-internals', fileURLToPath(new URL('./legacy-stdio.js', import.meta.url)), config.command, ...config.args],
    env,
  }
}

/** Keep upstream registration, reconnection and tool-call behavior intact. */
export async function apply(ctx, config) {
  return upstreamApply(ctx, prepareAuraStdioConfig(config))
}
