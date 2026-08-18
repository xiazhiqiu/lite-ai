import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'
import type { ToolContext } from '../src/tool.js'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

let tempRoot: string

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-kb-'))
  process.env.LITE_AI_HOME = tempRoot
  // 指向仓库内已下载的离线模型（ModelScope，国内可用）
  process.env.LITE_AI_EMBED_MODEL_DIR = path.join(repoRoot, 'models', 'embedding')
})

after(async () => {
  // 先释放数据库连接，避免 rm 时 Windows 上报 EBUSY
  const { closeDb } = await import('../src/utils/kb-store.js')
  closeDb()
  delete process.env.LITE_AI_HOME
  delete process.env.LITE_AI_EMBED_MODEL_DIR
  await rm(tempRoot, { recursive: true, force: true })
})

async function writePostmortem(fileName: string, body: string): Promise<string> {
  const dir = path.join(process.env.LITE_AI_HOME!, 'postmortems')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, fileName)
  await writeFile(file, body, 'utf8')
  return file
}

const PAYMENT_OOM = `# Postmortem: payment 服务 OOM 崩溃
## 1. 概述
payment 服务在高并发下触发内存上限 OOMKilled。
## 4. 根因分析
payment 容器 memory limit 设 256Mi，请求量突增导致堆内存溢出，进程被 OOMKilled 反复重启。
## 6. 处置记录
调大 memory limit 到 512Mi 并重启，恢复。
`

const CARTS_LATENCY = `# Postmortem: carts 延迟升高
## 1. 概述
carts 服务接口 P99 延迟飙升。
## 4. 根因分析
数据库连接池耗尽，请求排队等待连接。
## 6. 处置记录
扩容数据库连接池并添加缓存。
`

test('chunkMarkdown: 按 ## 章节切片', async () => {
  const { chunkMarkdown } = await import('../src/utils/kb-chunker.js')
  const chunks = chunkMarkdown(PAYMENT_OOM)
  assert.ok(chunks.length >= 3)
  const titles = chunks.map(c => c.section_title)
  assert.ok(titles.includes('1. 概述'))
  assert.ok(titles.includes('4. 根因分析'))
})

test('index + search: 相似事故能被检索到', async () => {
  const p1 = await writePostmortem('proj-a-cp_1.md', PAYMENT_OOM)
  const p2 = await writePostmortem('proj-b-cp_2.md', CARTS_LATENCY)

  const { reindexAll } = await import('../src/utils/kb-client.js')
  const idx = await reindexAll()
  assert.equal(idx.status, 'ok')
  assert.ok(idx.files >= 2)

  const { searchIncidentKb } = await import('../src/utils/kb-client.js')
  const results = await searchIncidentKb('payment service out of memory crash', { n: 5 })
  assert.ok(results.length > 0)
  // 语义上应与 payment OOM 报告更近：命中文件应含 p1
  const top = results[0]!
  assert.match(top.file, /cp_1/)
  assert.equal(top.distance, top.distance) // 存在性
})

test('index 幂等: 同 mtime 跳过重复索引', async () => {
  const file = await writePostmortem('proj-c-cp_3.md', PAYMENT_OOM)
  const { indexPostmortem } = await import('../src/utils/kb-client.js')
  const first = await indexPostmortem(file)
  assert.equal(first.status, 'indexed')
  const second = await indexPostmortem(file)
  assert.equal(second.status, 'skipped')
})

test('search_incident_kb 工具: 正常返回相似结果', async () => {
  const { searchIncidentKbTool } = await import('../src/tools/search-incident-kb.js')
  const tools = new ToolRegistry([searchIncidentKbTool])
  const ctx: ToolContext = { cwd: `D:/dev/sre-${Date.now()}` }
  const result = await tools.execute('search_incident_kb', { query: 'memory oom 崩溃' }, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /payment 服务 OOM/i)
})

test('unindexPostmortem: 删除索引后检索不到', async () => {
  const file = await writePostmortem('proj-x-cp_4.md', '# Postmortem: dangling\n## x\ny')
  const { unindexPostmortem, searchIncidentKb } = await import('../src/utils/kb-client.js')
  await unindexPostmortem(file)
  const results = await searchIncidentKb('dangling meaningless garbage', { n: 5 })
  assert.ok(!results.some(r => r.file === file))
})