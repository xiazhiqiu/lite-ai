import type { McpServerConfig, RuntimeConfig } from '../config.js'
import type { McpServerSummary } from '../mcp.js'
import { createMcpBackedTools } from '../mcp.js'
import { discoverSkills } from '../skills.js'
import { ToolRegistry } from '../tool.js'
import { isTodosEnabled } from '../utils/todo-store.js'
import { askUserTool } from './ask-user.js'
import { createLoadSkillTool } from './load-skill.js'
import { runCommandTool, isReadOnlyCommandCall } from './run-command.js'
import { rewriteTodoListTool } from './todo-write.js'
import { updateTodoStatusTool } from './todo-status.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { hypothesisTrackerTool } from './hypothesis-tracker.js'
import { incidentCheckpointTool } from './incident-checkpoint.js'
import { tailLogsTool, followLogsTool, stopFollowTool } from './tail-logs.js'
import { generatePostmortemTool } from './generate-postmortem.js'
import { searchIncidentKbTool } from './search-incident-kb.js'
import { buildEnabledTools } from './data-sources/registry.js'

export const SUB_AGENT_TOOL_NAMES = [
  'load_skill',
  'web_fetch',
  'web_search',
  'run_command',
] as const

function summarizeServerEndpoint(config: McpServerConfig): string {
  const remoteUrl = config.url?.trim()
  if (remoteUrl) return remoteUrl
  const command = config.command?.trim() ?? ''
  const args = config.args?.join(' ') ?? ''
  return `${command} ${args}`.trim()
}

function buildConnectingMcpSummaries(
  mcpServers: Record<string, McpServerConfig>,
): McpServerSummary[] {
  return Object.entries(mcpServers).map(([name, config]) => ({
    name,
    command: summarizeServerEndpoint(config),
    status: config.enabled === false ? 'disabled' : 'connecting',
    toolCount: 0,
    protocol:
      config.protocol === 'auto' || config.protocol === undefined
        ? undefined
        : config.protocol,
  }))
}

export async function createDefaultToolRegistry(args: {
  cwd: string
  runtime: RuntimeConfig | null
}): Promise<ToolRegistry> {
  const skills = await discoverSkills(args.cwd)
  const mcpServers = args.runtime?.mcpServers ?? {}
  const enabledDataSourceTools = await buildEnabledTools()

  return new ToolRegistry([
    askUserTool,
    {
      ...runCommandTool,
      isParallelSafe: input =>
        isReadOnlyCommandCall(input as { command: string; args?: string[] }),
    },
    ...enabledDataSourceTools.map(tool => ({ ...tool, isParallelSafe: () => true })),
    { ...createLoadSkillTool(args.cwd), isParallelSafe: () => true },
    { ...webFetchTool, isParallelSafe: () => true },
    { ...webSearchTool, isParallelSafe: () => true },
    hypothesisTrackerTool,
    incidentCheckpointTool,
    { ...tailLogsTool, isParallelSafe: () => true },
    followLogsTool,
    stopFollowTool,
    generatePostmortemTool,
    { ...searchIncidentKbTool, isParallelSafe: () => true },
    ...(isTodosEnabled() ? [rewriteTodoListTool, updateTodoStatusTool] : []),
  ], {
    skills,
    mcpServers: buildConnectingMcpSummaries(mcpServers),
  })
}

/**
 * 构建 webhook 自动诊断可用的只读工具子集（C1）。
 *
 * 只允许无副作用的诊断数据源（指标/链路/日志/SQL 只读查询）与只读告警检索，
 * 严格排除：run_command / web_fetch / web_search / load_skill / ask_user /
 * 写类工具（generate_postmortem、todo、follow）及任意 MCP 工具。
 * 即使用户绕过 webhook.secret，通道也只能做只读诊断，无法执行命令或外联。
 */
export async function createWebhookDiagnosisToolRegistry(args: {
  cwd: string
}): Promise<ToolRegistry> {
  const skills = await discoverSkills(args.cwd)
  const enabledDataSourceTools = await buildEnabledTools()
  return new ToolRegistry(
    [
      ...enabledDataSourceTools.map(tool => ({ ...tool, isParallelSafe: () => true })),
      { ...tailLogsTool, isParallelSafe: () => true },
      { ...searchIncidentKbTool, isParallelSafe: () => true },
    ],
    {
      skills,
      mcpServers: [],
    },
  )
}

export async function hydrateMcpTools(args: {
  cwd: string
  runtime: RuntimeConfig | null
  tools: ToolRegistry
}): Promise<void> {
  const mcp = await createMcpBackedTools({
    cwd: args.cwd,
    mcpServers: args.runtime?.mcpServers ?? {},
  })
  args.tools.addTools(mcp.tools)
  args.tools.setMcpServers(mcp.servers)
  args.tools.addDisposer(mcp.dispose)
}
