import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

export const DEFAULT_EMBEDDING_DIMENSION = 384

/**
 * 向量库（sqlite-vec 虚拟表）的 embedding 维度。
 * 默认 384，用户自备维度不同的模型时可用 LITE_AI_EMBED_DIMENSION 覆盖。
 * 向量库在首次建表时维度即锁定，改动维度需重建知识库表。
 */
export function embeddingDimension(): number {
  const raw = process.env.LITE_AI_EMBED_DIMENSION
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMBEDDING_DIMENSION
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid LITE_AI_EMBED_DIMENSION "${raw}". Must be a positive integer (e.g. 384, 768, 1536).`,
    )
  }
  return n
}

export type ProviderName = 'anthropic' | 'openai'

export function resolveProviderName(raw: unknown): ProviderName {
  return String(raw ?? 'openai').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai'
}

/**
 * 替换 dataSources[]：内置 toolset 的启用与连接配置。
 * 与 mcpServers 平级；key 为 toolset 名，value 描述该 toolset 的类型 + 连接参数。
 * 未配置任何 toolsets 时，各内置 toolset 因 config 不完整 → disabled，行为与老配置一致。
 */
export type LLMToolSetConfig = {
  /** 启用该 toolset。缺省 true；但 config 不完整时仍按 prerequisite 判 disabled。 */
  enabled?: boolean
  /** 工具集类型：prometheus | elasticsearch | kubernetes | database | tempo */
  type?: string
  /** 连接参数，随 toolset 而异；支持 {{ env.NAME }} 占位，解析时替换、密钥不落盘。 */
  config?: Record<string, unknown>
}

/** 解析后的 toolset 配置：env 占位已替换、合并默认值。 */
export type ResolvedToolsetConfig = {
  name: string
  type: string
  config: Record<string, unknown>
}

export type LiteAISettings = {
  env?: Record<string, string | number>
  model?: string
  provider?: ProviderName
  maxOutputTokens?: number
  /** thinking 模式模型（如 deepseek-reasoner）多轮对话是否把 reasoning_content 原样回传 */
  passBackReasoning?: boolean
  mcpServers?: Record<string, McpServerConfig>
  webhook?: Partial<WebhookConfig>
  /** 内置/可扩展 toolset 启用配置。name → 配置；见 LLMToolSetConfig。 */
  toolsets?: Record<string, LLMToolSetConfig>
}

export type WebhookConfig = {
  /** 监听端口，默认 8787 */
  port: number
  /** 监听地址，默认 127.0.0.1 */
  host: string
  /** 可选校验 token */
  secret?: string
  /** 收到 firing 告警后是否自动诊断，默认 true */
  autoDiagnose: boolean
  /** 诊断完成后 POST 摘要到此地址 */
  notifyUrl?: string
  /** 通知请求自定义头 */
  notifyHeaders: Record<string, string>
}

export const DEFAULT_WEBHOOK_PORT = 8787
export const DEFAULT_WEBHOOK_HOST = '127.0.0.1'

/** 读取 webhook 配置，与 settings.json 中的 webhook 覆盖项合并默认值。 */
export async function loadWebhookConfig(): Promise<WebhookConfig> {
  const effectiveSettings = await loadEffectiveSettings()
  const webhook = effectiveSettings.webhook ?? {}
  return {
    port: webhook.port ?? DEFAULT_WEBHOOK_PORT,
    host: webhook.host ?? DEFAULT_WEBHOOK_HOST,
    secret: webhook.secret,
    autoDiagnose: webhook.autoDiagnose ?? true,
    notifyUrl: webhook.notifyUrl,
    notifyHeaders: webhook.notifyHeaders ?? {},
  }
}

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string | number>
  url?: string
  headers?: Record<string, string | number>
  cwd?: string
  enabled?: boolean
  protocol?: 'auto' | 'content-length' | 'newline-json' | 'streamable-http'
  /** 声明该 server 提供的只读工具名列表（匹配 descriptor.name）。标记为只读的工具可被子 agent 调用。 */
  readOnlyTools?: string[]
}

export type RuntimeConfig = {
  provider: ProviderName
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
  /** thinking 模式模型多轮对话是否把 reasoning_content 原样回传；缺省时按模型名自动判断 */
  passBackReasoning?: boolean
  mcpServers: Record<string, McpServerConfig>
  sourceSummary: string
}

export type McpConfigScope = 'user' | 'project'

export const LITE_AI_DIR = process.env.LITE_AI_HOME
  ? path.resolve(process.env.LITE_AI_HOME)
  : path.join(os.homedir(), '.lite-ai')
export const LITE_AI_SETTINGS_PATH = path.join(LITE_AI_DIR, 'settings.json')
export const LITE_AI_HISTORY_PATH = path.join(LITE_AI_DIR, 'history.jsonl')
export const LITE_AI_PERMISSIONS_PATH = path.join(LITE_AI_DIR, 'permissions.json')
export const LITE_AI_MCP_PATH = path.join(LITE_AI_DIR, 'mcp.json')
export const LITE_AI_MCP_TOKENS_PATH = path.join(LITE_AI_DIR, 'mcp-tokens.json')
export const LITE_AI_PROJECTS_DIR = path.join(LITE_AI_DIR, 'projects')
export const LITE_AI_TODOS_DIR = path.join(LITE_AI_DIR, 'todos')
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
export const PROJECT_MCP_PATH = path.join(process.cwd(), '.mcp.json')

export async function readMcpTokensFile(
  filePath = LITE_AI_MCP_TOKENS_PATH,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return parsed as Record<string, string>
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

export async function saveMcpTokensFile(
  tokens: Record<string, string>,
  filePath = LITE_AI_MCP_TOKENS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

async function readSettingsFile(filePath: string): Promise<LiteAISettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as LiteAISettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('mcpServers' in parsed) ||
      typeof parsed.mcpServers !== 'object' ||
      parsed.mcpServers === null
    ) {
      return {}
    }

    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export function getMcpConfigPath(
  scope: McpConfigScope,
  cwd = process.cwd(),
): string {
  return scope === 'project' ? path.join(cwd, '.mcp.json') : LITE_AI_MCP_PATH
}

export async function loadScopedMcpServers(
  scope: McpConfigScope,
  cwd = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFile(getMcpConfigPath(scope, cwd))
}

export async function saveScopedMcpServers(
  scope: McpConfigScope,
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const targetPath = getMcpConfigPath(scope, cwd)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(
    targetPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    'utf8',
  )
}

function mergeSettings(
  base: LiteAISettings,
  override: LiteAISettings,
): LiteAISettings {
  const mergedMcpServers = {
    ...(base.mcpServers ?? {}),
  }

  for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
    mergedMcpServers[name] = {
      ...(mergedMcpServers[name] ?? {}),
      ...server,
      env: {
        ...(mergedMcpServers[name]?.env ?? {}),
        ...(server.env ?? {}),
      },
      headers: {
        ...(mergedMcpServers[name]?.headers ?? {}),
        ...(server.headers ?? {}),
      },
    }
  }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    mcpServers: mergedMcpServers,
    toolsets: {
      ...(base.toolsets ?? {}),
      ...(override.toolsets ?? {}),
    },
  }
}

export async function loadEffectiveSettings(): Promise<LiteAISettings> {
  const [claudeSettings, globalMcpConfig, projectMcpConfig, liteAISettings] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readMcpConfigFile(LITE_AI_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
      readSettingsFile(LITE_AI_SETTINGS_PATH),
    ])
  return mergeSettings(
    mergeSettings(
      mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
      { mcpServers: projectMcpConfig },
    ),
    liteAISettings,
  )
}

export async function saveLiteAISettings(
  updates: LiteAISettings,
): Promise<void> {
  await mkdir(LITE_AI_DIR, { recursive: true })
  const existing = await readSettingsFile(LITE_AI_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    LITE_AI_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const effectiveSettings = await loadEffectiveSettings()
  const env = {
    ...(effectiveSettings.env ?? {}),
    ...process.env,
  }

  const rawProvider =
    process.env.LITE_AI_PROVIDER ||
    effectiveSettings.provider ||
    'openai'
  const provider = resolveProviderName(rawProvider)
  const isOpenAI = provider === 'openai'

  const model =
    process.env.LITE_AI_MODEL ||
    effectiveSettings.model ||
    String(env[isOpenAI ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'] ?? '').trim()

  const baseUrl = isOpenAI
    ? String(env.OPENAI_BASE_URL ?? '').trim() || 'https://api.openai.com/v1'
    : String(env.ANTHROPIC_BASE_URL ?? '').trim() || 'https://api.anthropic.com'
  const authToken = isOpenAI
    ? undefined
    : String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined
  const apiKey = isOpenAI
    ? String(env.OPENAI_API_KEY ?? '').trim() || undefined
    : String(env.ANTHROPIC_API_KEY ?? '').trim() || undefined
  const rawMaxOutputTokens =
    process.env.LITE_AI_MAX_OUTPUT_TOKENS ??
    effectiveSettings.maxOutputTokens ??
    env.LITE_AI_MAX_OUTPUT_TOKENS
  const parsedMaxOutputTokens =
    rawMaxOutputTokens === undefined ? NaN : Number(rawMaxOutputTokens)
  const maxOutputTokens =
    Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
      ? Math.floor(parsedMaxOutputTokens)
      : undefined

  const rawPassBackReasoning =
    env.LITE_AI_PASS_BACK_REASONING ??
    effectiveSettings.passBackReasoning
  const passBackReasoning =
    typeof rawPassBackReasoning === 'string'
      ? rawPassBackReasoning === '1' ||
        rawPassBackReasoning.toLowerCase() === 'true'
      : typeof rawPassBackReasoning === 'number'
        ? rawPassBackReasoning === 1
        : rawPassBackReasoning

  if (!model) {
    throw new Error(
      `No model configured. Set ~/.lite-ai/settings.json or env.${isOpenAI ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'}.`,
    )
  }

  if (isOpenAI) {
    if (!apiKey) {
      throw new Error(
        `No auth configured. Set OPENAI_API_KEY in ~/.lite-ai/settings.json or process env.`,
      )
    }
  } else if (!authToken && !apiKey) {
    throw new Error(
      `No auth configured. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in ~/.lite-ai/settings.json or process env.`,
    )
  }

  return {
    provider,
    model,
    baseUrl,
    authToken,
    apiKey,
    maxOutputTokens,
    passBackReasoning,
    mcpServers: effectiveSettings.mcpServers ?? {},
    sourceSummary: `config: ${LITE_AI_SETTINGS_PATH} > ${CLAUDE_SETTINGS_PATH} > process.env (provider=${provider})`,
  }
}

/**
 * 递归替换 value 中 string 里的 `{{ env.NAME }}` 占位为 env[NAME]。
 * 未命中的占位保留原文；非 string 值原样返回。
 * 用于 headers/url/凭据等，避免敏感信息离开运行时。
 */
export function resolveEnvTemplate(
  value: unknown,
  env: Record<string, string>,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) =>
      name in env ? env[name]! : `{{ env.${name} }}`,
    )
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveEnvTemplate(item, env))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        resolveEnvTemplate(val, env),
      ]),
    )
  }
  return value
}

/**
 * 读取已启用的 toolset 配置列表，并把 config 中的 env 占位替换为运行时环境变量。
 * enabled 缺省视为 true；enabled:false 的项被剔除。
 * prerequisite（config 完整性）由各 toolset 的 checkConfig 判定，这里不判。
 */
export async function loadResolvedToolsets(): Promise<ResolvedToolsetConfig[]> {
  try {
    const settings = await loadEffectiveSettings()
    const raw = settings.toolsets
    if (raw === undefined || typeof raw !== 'object') return []
    const env: Record<string, string> = {}
    for (const [k, v] of [
      ...Object.entries(process.env),
      ...Object.entries(settings.env ?? {}),
    ]) {
      if (v !== undefined && v !== null) env[k] = String(v)
    }
    const resolved: ResolvedToolsetConfig[] = []
    for (const [name, entry] of Object.entries(raw)) {
      if (entry === null || typeof entry !== 'object') continue
      if (entry.enabled === false) continue
      const type = typeof entry.type === 'string' ? entry.type : name
      const config =
        resolveEnvTemplate(entry.config ?? {}, env) as Record<string, unknown>
      resolved.push({ name, type, config })
    }
    return resolved
  } catch {
    return []
  }
}
