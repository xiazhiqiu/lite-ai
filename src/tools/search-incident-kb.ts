import path from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import {
  checkKbAvailable,
  reindexAll,
  searchIncidentKb,
} from '../utils/kb-client.js'

const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('搜索查询：事故现象、服务名或故障类型的自然语言描述'),
  n: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('返回结果数（默认 5）'),
  service: z
    .string()
    .optional()
    .describe('按服务名精确过滤（如 payment）。留空则检索全部历史事故'),
})

type Input = z.infer<typeof InputSchema>

function formatResults(query: string, results: Awaited<ReturnType<typeof searchIncidentKb>>): string {
  if (results.length === 0) {
    return `为 "${query}" 未找到相似历史事故。继续正常诊断流程。`
  }
  const lines = results.map((r, i) => {
    const section = r.section ? `/ ${r.section}` : ''
    const service = r.service ? ` [service:${r.service}]` : ''
    return (
      `${i + 1}. [相似度 ${(1 - r.distance).toFixed(3)}] ${path.basename(r.file)}${section}${service}\n` +
      `   文件: ${r.file}\n` +
      `   片段: ${r.content.slice(0, 300)}${r.content.length > 300 ? '…' : ''}`
    )
  })
  return `为 "${query}" 找到 ${results.length} 条相似历史事故（可按 file 用 read_file 查看完整报告）：\n\n${lines.join('\n\n')}`
}

export const searchIncidentKbTool: ToolDefinition<Input> = {
  name: 'search_incident_kb',
  description:
    'Search the incident knowledge base for semantically similar historical incidents using local embeddings. Before starting a diagnosis, call this with the incident symptoms / service name / fault type to find past postmortems that may share the same root cause. Returns the most similar report sections with a similarity score; use read_file on the returned file path to inspect the full report. Requires a pre-downloaded local embedding model (see scripts/download-embedding-model.mjs).',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询：事故现象、服务名或故障类型的自然语言描述',
      },
      n: { type: 'number', description: '返回结果数（默认 5）' },
      service: {
        type: 'string',
        description: '按服务名精确过滤（如 payment）。留空则检索全部历史事故',
      },
    },
    required: ['query'],
  },

  schema: InputSchema,
  isReadOnly: true, // 语义检索只读

  async run(input: Input, context) {
    const available = checkKbAvailable()
    if (!available.ok) {
      return {
        ok: false,
        output:
          '事故知识库不可用：本地 embedding 模型缺失。请先下载模型后重试：\n' +
          '  1. 下载模型到项目默认目录 models/embedding：\n' +
          '     node scripts/download-embedding-model.mjs models/embedding\n' +
          '     （如需其他位置，可设置环境变量 LITE_AI_EMBED_MODEL_DIR 指向模型父目录）\n' +
          '  2. 完成后重新调用本工具即可检索相似历史事故。\n' +
          `原始错误：${available.modelError ?? '未知错误'}`,
      }
    }

    // 首次查询时补齐未索引的 postmortems（增量补漏）
    if (available.indexedFiles === 0 && context?.cwd) {
      await reindexAll().catch(() => {})
    }

    const results = await searchIncidentKb(input.query, {
      n: input.n ?? 5,
      service: input.service,
    })
    return { ok: true, output: formatResults(input.query, results) }
  },
}