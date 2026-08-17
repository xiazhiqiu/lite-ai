import type { McpServerConfig, RuntimeConfig } from '../config.js'
import type { McpServerSummary } from '../mcp.js'
import { createMcpBackedTools } from '../mcp.js'
import { discoverSkills } from '../skills.js'
import { ToolRegistry } from '../tool.js'
import { isTodosEnabled } from '../utils/todo-store.js'
import { askUserTool } from './ask-user.js'
import { editFileTool } from './edit-file.js'
import { grepFilesTool } from './grep-files.js'
import { listFilesTool } from './list-files.js'
import { createLoadSkillTool } from './load-skill.js'
import { modifyFileTool } from './modify-file.js'
import { patchFileTool } from './patch-file.js'
import { readFileTool } from './read-file.js'
import { runCommandTool, isReadOnlyCommandCall } from './run-command.js'
import { rewriteTodoListTool } from './todo-write.js'
import { updateTodoStatusTool } from './todo-status.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { writeFileTool } from './write-file.js'
import { hypothesisTrackerTool } from './hypothesis-tracker.js'

export const SUB_AGENT_TOOL_NAMES = [
  'list_files',
  'grep_files',
  'read_file',
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

  return new ToolRegistry([
    askUserTool,
    { ...listFilesTool, isParallelSafe: () => true },
    { ...grepFilesTool, isParallelSafe: () => true },
    { ...readFileTool, isParallelSafe: () => true },
    writeFileTool,
    modifyFileTool,
    editFileTool,
    patchFileTool,
    {
      ...runCommandTool,
      isParallelSafe: input =>
        isReadOnlyCommandCall(input as { command: string; args?: string[] }),
    },
    { ...createLoadSkillTool(args.cwd), isParallelSafe: () => true },
    { ...webFetchTool, isParallelSafe: () => true },
    { ...webSearchTool, isParallelSafe: () => true },
    hypothesisTrackerTool,
    ...(isTodosEnabled() ? [rewriteTodoListTool, updateTodoStatusTool] : []),
  ], {
    skills,
    mcpServers: buildConnectingMcpSummaries(mcpServers),
  })
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
