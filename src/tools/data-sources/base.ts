import type { ToolDefinition } from '../../tool.js'
import type { ResolvedToolsetConfig } from '../../config.js'

/**
 * data-source toolset 公共基础设施。
 * 各 toolset（prometheus/elasticsearch/kubernetes/database）产出一组 ToolDefinition，
 * 由 registry.ts 汇总后按 enabled 配置注入主工具注册表。
 */

/** 任意 JSON 兼容的输入输出，由各 toolset 定义具体 schema。 */
export type ToolInput = Record<string, unknown>

/** 单个只读 toolset 的约束结果：enabled + 原因/名称描述。 */
export type ToolsetStatus = {
  name: string
  type: string
  enabled: boolean
  /** 未启用时说明原因，如 "缺少 prometheus_url"。 */
  reason?: string
}

/** 一次 HTTP 响应封装，供 toolset 用原生 fetch 访问 ES/Prometheus。 */
export type HttpResult = {
  ok: boolean
  status: number
  text: string
}

/** 统一 fetch 封装：非 2xx 不抛错，返回正文供上层解析。 */
export async function httpGet(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const res = await fetch(url, {
      headers: options.headers ?? {},
      signal: controller.signal,
    })
    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 截断 tool 输出到上限，避免超大响应占满上下文。
 * 超长时在末尾追加截断标记。
 */
export function clampToolOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n...[truncated at ${maxChars} chars]`
}

export const DEFAULT_OUTPUT_CHARS = 8_000

/**
 * 把字符串数组（如指标名/标签值列表）压缩为摘要，避免一次性输出几千条占满上下文。
 * 仅返回总数 + 前缀采样，列表过大时标注截断并给出数量上限。
 */
export function summarizeStringList(
  values: string[],
  maxItems = 30,
): string {
  if (values.length <= maxItems) {
    return `${values.length} total: [${values.join(', ')}]`
  }
  return (
    `${values.length} total: [${values.slice(0, maxItems).join(', ')}] ` +
    `...(${values.length - maxItems} more omitted)`
  )
}

/** 把 ES/Prometheus 的 JSON 响应解析为稳定字符串（失败时给原始文本与原因）。 */
export function resultFromJson(
  http: HttpResult,
  maxChars = DEFAULT_OUTPUT_CHARS,
): { ok: boolean; output: string } {
  if (!http.ok) {
    return {
      ok: false,
      output: clampToolOutput(`HTTP ${http.status}: ${http.text}`, maxChars),
    }
  }
  try {
    const parsed = JSON.parse(http.text) as unknown
    return {
      ok: true,
      output: clampToolOutput(JSON.stringify(parsed, null, 2), maxChars),
    }
  } catch {
    return {
      ok: false,
      output: clampToolOutput(`Invalid JSON (HTTP ${http.status}): ${http.text}`, maxChars),
    }
  }
}

/**
 * 从已解析 config 中读取 provider schema 的核心入口列表。
 * 每个 toolset 据此判断配置是否满足前置条件，未满足则 disabled。
 */
export function checkConfig(
  toolset: ResolvedToolsetConfig,
  requiredKeys: string[],
): ToolsetStatus {
  const missing = requiredKeys.filter(key => {
    const value = toolset.config[key]
    return value === undefined || value === null || value === ''
  })
  return {
    name: toolset.name,
    type: toolset.type,
    enabled: missing.length === 0,
    ...(missing.length > 0
      ? { reason: `缺少配置: ${missing.join(', ')}` }
      : {}),
  }
}