import { z } from 'zod'
import type { PermissionManager } from './permissions.js'
import type { SkillSummary } from './skills.js'
import type { McpServerSummary } from './mcp.js'

export type ToolContext = {
  cwd: string
  permissions?: PermissionManager
}

export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: 'running' | 'completed' | 'failed'
  startedAt: number
}

export type ToolResult = {
  ok: boolean
  output: string
  backgroundTask?: BackgroundTaskResult
  awaitUser?: boolean
}

export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run(input: TInput, context: ToolContext): Promise<ToolResult>
  /** 判定该调用实例是否可与其它 safe 工具并行。缺省 = false（fail-closed）。 */
  isParallelSafe?: (input: unknown) => boolean
  /** 标记该工具是否为只读（无副作用）。用于子 agent 工具白名单筛选。fail-closed：缺省 = false。 */
  isReadOnly?: boolean
}

type ToolRegistryMetadata = {
  skills?: SkillSummary[]
  mcpServers?: McpServerSummary[]
}

export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  private metadataStore: ToolRegistryMetadata
  private readonly disposers: Array<() => Promise<void>> = []

  constructor(
    tools: ToolDefinition<unknown>[],
    metadata: ToolRegistryMetadata = {},
    disposer?: () => Promise<void>,
  ) {
    this.toolsStore = [...tools]
    this.metadataStore = metadata
    if (disposer) {
      this.disposers.push(disposer)
    }
  }

  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  subset(names: readonly string[]): ToolRegistry {
    const allowedNames = new Set(names)
    return new ToolRegistry(
      this.toolsStore.filter(tool => allowedNames.has(tool.name)),
    )
  }

  /**
   * 构建子 agent 可用的工具子集（动态白名单）。
   * 收集规则（fail-closed）：
   *   1. 内置只读工具白名单（list_files/grep_files/read_file/load_skill/web_fetch/web_search）
   *   2. 所有 isReadOnly === true 的工具（含 MCP 只读工具）
   *   3. run_command（其 isParallelSafe 已对只读命令做细粒度判定）
   * 不含任何 isReadOnly 未声明或为 false 的工具。
   */
  subsetForSubAgent(builtinReadOnlyNames: readonly string[]): ToolRegistry {
    const builtinSet = new Set(builtinReadOnlyNames)
    const subAgentTools = this.toolsStore.filter(tool => {
      if (builtinSet.has(tool.name)) return true
      if (tool.isReadOnly === true) return true
      return false
    })
    return new ToolRegistry(subAgentTools)
  }

  getSkills(): SkillSummary[] {
    return this.metadataStore.skills ?? []
  }

  getMcpServers(): McpServerSummary[] {
    return this.metadataStore.mcpServers ?? []
  }

  setMcpServers(servers: McpServerSummary[]): void {
    this.metadataStore = {
      ...this.metadataStore,
      mcpServers: [...servers],
    }
  }

  addTools(nextTools: ToolDefinition<unknown>[]): void {
    const existingNames = new Set(this.toolsStore.map(tool => tool.name))
    for (const tool of nextTools) {
      if (existingNames.has(tool.name)) {
        continue
      }
      this.toolsStore.push(tool)
      existingNames.add(tool.name)
    }
  }

  addDisposer(disposer: () => Promise<void>): void {
    this.disposers.push(disposer)
  }

  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolName}`,
      }
    }

    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        output: parsed.error.message,
      }
    }

    try {
      return await tool.run(parsed.data, context)
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(disposer => disposer()))
  }
}
