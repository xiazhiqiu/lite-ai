import {
  CLAUDE_SETTINGS_PATH,
  LITE_AI_MCP_PATH,
  LITE_AI_PERMISSIONS_PATH,
  LITE_AI_SETTINGS_PATH,
  loadRuntimeConfig,
  saveLiteAISettings,
} from './config.js'
import { initializeRepo, renderInitReport } from './init.js'
import { discoverInstructionFiles, renderMemoryReport } from './memory.js'
import type { ToolRegistry } from './tool.js'
import { listAlertRecords } from './webhook/alert-store.js'

export type SlashCommand = {
  name: string
  usage: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    usage: '/help',
    description: 'Show available slash commands.',
  },
  {
    name: '/tools',
    usage: '/tools',
    description: 'List tools available to the coding agent and tool shortcuts.',
  },
  {
    name: '/status',
    usage: '/status',
    description: 'Show current model and config source.',
  },
  {
    name: '/model',
    usage: '/model',
    description: 'Show the current model.',
  },
  {
    name: '/model',
    usage: '/model <model-name>',
    description: 'Persist a model override into ~/.lite-ai/settings.json.',
  },
  {
    name: '/config-paths',
    usage: '/config-paths',
    description: 'Show lite-ai and Claude fallback settings paths.',
  },
  {
    name: '/skills',
    usage: '/skills',
    description: 'List discovered SKILL.md workflows.',
  },
  {
    name: '/mcp',
    usage: '/mcp',
    description: 'Show configured MCP servers and connection state.',
  },
  {
    name: '/resume',
    usage: '/resume',
    description: 'Resume a saved session (interactive picker, or /resume <id>).',
  },
  {
    name: '/rename',
    usage: '/rename <name>',
    description: 'Rename the current session.',
  },
  {
    name: '/new',
    usage: '/new',
    description: 'Clear saved session and start fresh.',
  },
  {
    name: '/fork',
    usage: '/fork',
    description: 'Fork current session into a new independent session.',
  },
  {
    name: '/permissions',
    usage: '/permissions',
    description: 'Show lite-ai permission storage path.',
  },
  {
    name: '/exit',
    usage: '/exit',
    description: 'Exit lite-ai.',
  },
  {
    name: '/ls',
    usage: '/ls [path]',
    description: 'List files in a directory.',
  },
  {
    name: '/grep',
    usage: '/grep <pattern>::[path]',
    description: 'Search text in files.',
  },
  {
    name: '/read',
    usage: '/read <path>',
    description: 'Read a file directly.',
  },
  {
    name: '/write',
    usage: '/write <path>::<content>',
    description: 'Write a file directly.',
  },
  {
    name: '/modify',
    usage: '/modify <path>::<content>',
    description: 'Replace a file, showing a reviewable diff before applying it.',
  },
  {
    name: '/edit',
    usage: '/edit <path>::<search>::<replace>',
    description: 'Edit a file by exact replacement.',
  },
  {
    name: '/patch',
    usage: '/patch <path>::<search1>::<replace1>::<search2>::<replace2>...',
    description: 'Apply multiple replacements to one file in one command.',
  },
  {
    name: '/cmd',
    usage: '/cmd [cwd::]<command> [args...]',
    description: 'Run an allowed development command directly, optionally in another directory.',
  },
  {
    name: '/compact',
    usage: '/compact',
    description: 'Compress conversation context to free up context window space.',
  },
  {
    name: '/collapse',
    usage: '/collapse',
    description: 'Project old safe context spans into summaries without deleting the transcript.',
  },
  {
    name: '/snip',
    usage: '/snip',
    description: 'Remove a safe middle segment of conversation context without calling the model.',
  },
  {
    name: '/init',
    usage: '/init',
    description: 'Create .lite-ai/, .gitignore entries, and LITE.md in the current project (idempotent).',
  },
  {
    name: '/memory',
    usage: '/memory',
    description: 'Show instruction files loaded into the system prompt.',
  },
  {
    name: '/alerts',
    usage: '/alerts',
    description: 'List recent webhook-diagnosed incidents and their resume commands.',
  },
]

export function formatSlashCommands(): string {
  return SLASH_COMMANDS.map(command => `${command.usage}  ${command.description}`).join('\n')
}

export function findMatchingSlashCommands(input: string): string[] {
  return SLASH_COMMANDS
    .map(command => command.usage)
    .filter(command => command.startsWith(input))
}

function formatPermissionSummary(permissionSummary: string[] = []): string {
  const findValue = (label: string): string => {
    const raw = permissionSummary.find(part => part.startsWith(`${label}: `))
    return raw?.slice(label.length + 2).trim() || 'none'
  }

  return [
    `permission store: ${LITE_AI_PERMISSIONS_PATH}`,
    `cwd: ${findValue('cwd')}`,
    `extra allowed dirs: ${findValue('extra allowed dirs')}`,
    `dangerous allowlist: ${findValue('dangerous allowlist')}`,
  ].join('\n')
}

export async function tryHandleLocalCommand(
  input: string,
  context?: {
    cwd?: string
    tools?: ToolRegistry
    permissionSummary?: string[]
  },
): Promise<string | null> {
  const cwd = context?.cwd ?? process.cwd()

  if (input === '/') {
    return formatSlashCommands()
  }

  if (input === '/help') {
    return formatSlashCommands()
  }

  if (input === '/config-paths') {
    return [
      `lite-ai settings: ${LITE_AI_SETTINGS_PATH}`,
      `lite-ai permissions: ${LITE_AI_PERMISSIONS_PATH}`,
      `lite-ai mcp: ${LITE_AI_MCP_PATH}`,
      `compat fallback: ${CLAUDE_SETTINGS_PATH}`,
    ].join('\n')
  }

  if (input === '/permissions') {
    return formatPermissionSummary(context?.permissionSummary)
  }

  if (input === '/skills') {
    const skills = context?.tools?.getSkills() ?? []
    if (skills.length === 0) {
      return 'No skills discovered. Add skills under ~/.lite-ai/skills/<name>/SKILL.md, .lite-ai/skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md, or ~/.claude/skills/<name>/SKILL.md.'
    }

    return skills
      .map(
        skill =>
          `${skill.name}  ${skill.description}  [${skill.source}]`,
      )
      .join('\n')
  }

  if (input === '/mcp') {
    const servers = context?.tools?.getMcpServers() ?? []
    if (servers.length === 0) {
      return 'No MCP servers configured. Add mcpServers to ~/.lite-ai/settings.json, ~/.lite-ai/mcp.json, or project .mcp.json.'
    }

    return servers
      .map(server => {
        const suffix = server.error ? `  error=${server.error}` : ''
        const protocol = server.protocol ? `  protocol=${server.protocol}` : ''
        const resources =
          server.resourceCount !== undefined
            ? `  resources=${server.resourceCount}`
            : ''
        const prompts =
          server.promptCount !== undefined
            ? `  prompts=${server.promptCount}`
            : ''
        return `${server.name}  status=${server.status}  tools=${server.toolCount}${resources}${prompts}${protocol}${suffix}`
      })
      .join('\n')
  }

  if (input === '/status') {
    const runtime = await loadRuntimeConfig()
    return [
      `provider: ${runtime.provider}`,
      `model: ${runtime.model}`,
      `baseUrl: ${runtime.baseUrl}`,
      `auth: ${runtime.authToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'}`,
      `mcp servers: ${Object.keys(runtime.mcpServers).length}`,
      runtime.sourceSummary,
    ].join('\n')
  }

  if (input === '/init') {
    const report = await initializeRepo(cwd)
    return renderInitReport(report)
  }

  if (input === '/memory') {
    const files = await discoverInstructionFiles(cwd)
    return renderMemoryReport(files, cwd)
  }

  if (input === '/model') {
    const runtime = await loadRuntimeConfig()
    return `current model: ${runtime.model}`
  }

  if (input === '/alerts') {
    const records = (await listAlertRecords()).filter(r => r.status === 'diagnosed')
    if (records.length === 0) {
      return '[webhook] 暂无已诊断的告警会话。'
    }
    const lines = [`[webhook] ${records.length} recent diagnoses:`]
    for (const record of records.slice(0, 10)) {
      lines.push(`  ${record.severity.padEnd(9)} ${record.title}`)
      lines.push(`            since ${timeAgo(record.timestamp)}`)
      if (record.summary) {
        lines.push(`            summary: ${record.summary}`)
      }
      lines.push(`            resume: lite-ai --resume ${record.sessionId}`)
    }
    return lines.join('\n')
  }

  if (input.startsWith('/model ')) {
    const model = input.slice('/model '.length).trim()
    if (!model) {
      return '用法: /model <model-name>'
    }

    await saveLiteAISettings({ model })
    return `saved model=${model} to ${LITE_AI_SETTINGS_PATH}`
  }

  return null
}

export function completeSlashCommand(line: string): [string[], string] {
  const hits = SLASH_COMMANDS
    .map(command => command.usage)
    .filter(command => command.startsWith(line))

  return [hits.length > 0 ? hits : SLASH_COMMANDS.map(command => command.usage), line]
}

/** 相对时间描述，如 "2 min ago"。 */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return formatLongTime(seconds, 'second')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return formatLongTime(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatLongTime(hours, 'hour')
  return formatLongTime(Math.floor(hours / 24), 'day')
}

function formatLongTime(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`
}
