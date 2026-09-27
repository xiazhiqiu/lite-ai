import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import {
  clampToolOutput,
  httpGet,
  DEFAULT_OUTPUT_CHARS,
  type ToolsetStatus,
} from './base.js'
import type { ResolvedToolsetConfig } from '../../config.js'

/**
 * GitLab 只读工具集（REST API v4）。
 * 路由对齐 HolmesGPT 的 git 类工具：gitlab_url + gitlab_token（PRIVATE-TOKEN）。
 * 所有工具均为只读 GET；fail-closed：无 gitlab_url 则 disabled。
 *
 * 配置示例（settings.json）：
 * {
 *   "toolsets": {
 *     "gitlab": {
 *       "type": "gitlab",
 *       "config": {
 *         "gitlab_url": "{{ env.GITLAB_URL }}",
 *         "gitlab_token": "{{ env.GITLAB_TOKEN }}"
 *       }
 *     }
 *   }
 * }
 */

export function checkGitlabConfig(
  toolset: ResolvedToolsetConfig,
): ToolsetStatus {
  const url = toolset.config.gitlab_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      name: toolset.name,
      type: 'gitlab',
      enabled: false,
      reason: '缺少 gitlab_url',
    }
  }
  return { name: toolset.name, type: 'gitlab', enabled: true }
}

const projectId = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9_.\-/][A-Za-z0-9_.\-/]*$/,
    '非法 project id（支持数字 ID 或 group/project 形式）',
  )

/** 发送带 PRIVATE-TOKEN 的 GET 并解析 JSON；非 2xx 或非 JSON 时给出稳定错误信息。 */
async function apiGet(
  baseUrl: string,
  path: string,
  params: Record<string, string | undefined>,
  token?: string,
): Promise<{ ok: boolean; output: string }> {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  const headers: Record<string, string> = {}
  if (token) headers['PRIVATE-TOKEN'] = token
  const http = await httpGet(url.toString(), { headers })
  if (!http.ok) {
    return {
      ok: false,
      output: clampToolOutput(
        `HTTP ${http.status}: ${http.text}`,
        DEFAULT_OUTPUT_CHARS,
      ),
    }
  }
  try {
    const parsed = JSON.parse(http.text) as unknown
    return { ok: true, output: JSON.stringify(parsed, null, 2) }
  } catch {
    return {
      ok: false,
      output: clampToolOutput(
        `Invalid JSON (HTTP ${http.status}): ${http.text}`,
        DEFAULT_OUTPUT_CHARS,
      ),
    }
  }
}

/** 生成单一只读工具（闭包捕获 baseUrl + token）。 */
function glTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  exec: (
    ctx: { baseUrl: string; token?: string },
    input: T,
  ) => Promise<{ ok: boolean; output: string }>,
  ctx: { baseUrl: string; token?: string },
): ToolDefinition<T> {
  return {
    name: `gitlab_${name}`,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    schema,
    isReadOnly: true,
    async run(input) {
      return exec(ctx, input)
    },
  }
}

export function buildGitlabTools(
  toolset: ResolvedToolsetConfig,
): ToolDefinition<unknown>[] {
  const baseUrl =
    String(toolset.config.gitlab_url).replace(/\/+$/, '') + '/api/v4'
  const token =
    toolset.config.gitlab_token !== undefined
      ? String(toolset.config.gitlab_token)
      : undefined
  const ctx = { baseUrl, token }

  return [
    glTool(
      'list_merge_requests',
      '列出项目的合并请求（MR），可按状态 / 目标分支过滤。',
      z.object({
        project_id: projectId,
        state: z.enum(['opened', 'closed', 'merged', 'all']).optional(),
        target_branch: z.string().min(1).max(255).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      (c, input) =>
        apiGet(
          c.baseUrl,
          `/projects/${encodeURIComponent(input.project_id)}/merge_requests`,
          {
            state: input.state,
            target_branch: input.target_branch,
            per_page:
              input.per_page !== undefined ? String(input.per_page) : undefined,
          },
          c.token,
        ),
      ctx,
    ),
    glTool(
      'get_merge_request',
      '获取单个合并请求（MR）的详情。',
      z.object({
        project_id: projectId,
        merge_request_iid: z.number().int().min(1),
      }),
      (c, input) =>
        apiGet(
          c.baseUrl,
          `/projects/${encodeURIComponent(input.project_id)}/merge_requests/${input.merge_request_iid}`,
          {},
          c.token,
        ),
      ctx,
    ),
    glTool(
      'list_pipelines',
      '列出项目的 CI 流水线（pipeline），可按分支 / 状态过滤。',
      z.object({
        project_id: projectId,
        ref: z.string().min(1).max(255).optional(),
        status: z
          .enum([
            'created',
            'pending',
            'running',
            'success',
            'failed',
            'canceled',
            'skipped',
          ])
          .optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      (c, input) =>
        apiGet(
          c.baseUrl,
          `/projects/${encodeURIComponent(input.project_id)}/pipelines`,
          {
            ref: input.ref,
            status: input.status,
            per_page:
              input.per_page !== undefined ? String(input.per_page) : undefined,
          },
          c.token,
        ),
      ctx,
    ),
    glTool(
      'get_pipeline',
      '获取流水线详情，并附带该流水线的作业（jobs）列表。',
      z.object({
        project_id: projectId,
        pipeline_id: z.number().int().min(1),
      }),
      async (c, input) => {
        const base = `/projects/${encodeURIComponent(input.project_id)}/pipelines/${input.pipeline_id}`
        const pipe = await apiGet(c.baseUrl, base, {}, c.token)
        if (!pipe.ok) return pipe
        const jobs = await apiGet(c.baseUrl, `${base}/jobs`, {}, c.token)
        if (!jobs.ok) {
          return {
            ok: true,
            output: pipe.output + '\n\n[jobs 获取失败] ' + jobs.output,
          }
        }
        return { ok: true, output: pipe.output + '\n\n' + jobs.output }
      },
      ctx,
    ),
    glTool(
      'get_commit',
      '获取单个 commit 的详情（含 message 与 stats）。',
      z.object({
        project_id: projectId,
        sha: z.string().min(1).max(64),
      }),
      (c, input) =>
        apiGet(
          c.baseUrl,
          `/projects/${encodeURIComponent(input.project_id)}/repository/commits/${input.sha}`,
          {},
          c.token,
        ),
      ctx,
    ),
  ]
}
