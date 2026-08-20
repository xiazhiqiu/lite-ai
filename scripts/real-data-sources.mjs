#!/usr/bin/env node
/**
 * 真实数据源注入工具：把单个 RE2-SS 实例目录的 CSV 转成可灌入真实
 * Elasticsearch / Prometheus 的中间产物，供本地真实容器使用。
 *
 * 用法（Node):
 *   node scripts/real-data-sources.mjs <scenarioDir> --out <dir>
 *
 * 产出:
 *   logs.ndjson    —— ES _bulk 请求体（index sock-shop-logs，字段对齐 mock)
 *   metrics.prom   —— Prometheus OpenMetrics/expfmt 文本，含 (metric{labels} value tsMs)
 *
 * 说明：
 *   - logs.csv 的 timestamp 是纳秒 epoch；ES 按毫秒存, `tsMs` 保留原始毫秒供范围检索。
 *   - metrics.csv 为宽表(time, col1, col2, ...)，列名即指标名, 标签由列名推导,
 *     与 src/eval/mock/csv.ts 的 labelsForColumn 保持一致。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** 与 src/eval/mock/csv.ts parseCsvLine 等价的 CSV 行解析（支持引号、逗号、""转义） */
function parseCsvLine(line) {
  const fields = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { fields.push(cur); cur = '' }
    else cur += ch
  }
  fields.push(cur)
  return fields
}

const NODE_METRIC_RE = /_(node|memory|disk|network|cpu|sockets?)-/

/** 列名 → Prometheus 标签。node 系列带 node 标签，其余带 container，与 mock 一致 */
function labelsForColumn(column) {
  if (column.startsWith('gke-')) {
    const m = NODE_METRIC_RE.exec(column)
    return m && m.index > 0 ? { node: column.slice(0, m.index) } : { node: column }
  }
  const idx = column.indexOf('_')
  return idx > 0 ? { container: column.slice(0, idx) } : {}
}

function promEscape(v) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Prometheus metric 名合法化：仅允许 [a-zA-Z_:][a-zA-Z0-9_:]*；数据集列名含 '-' 需转换 */
function sanitizeMetricName(name) {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/^[^a-zA-Z_:]/, '_')
}

/** 与 src/eval/mock/csv.ts deriveSeverity 一致：从 level + 消息关键字推导 severity */
const ERROR_HINT =
  /\bERROR\b|exception|HttpServerErrorException|Service Unavailable|timeout|Prematurely|refused|unavailable|failed|error/i
const WARN_HINT = /\bWARN\b|Retrying|socket exception|socket|too many/i

function deriveSeverity(level, message) {
  const lv = (level || '').trim().toUpperCase()
  if (lv === 'ERROR' || lv === 'WARN' || lv === 'INFO' || lv === 'DEBUG') return lv
  if (ERROR_HINT.test(message)) return 'ERROR'
  if (WARN_HINT.test(message)) return 'WARN'
  return 'INFO'
}

/** metrics.csv → OpenMetrics 行（带秒级两端的样本；metric 名规范化） */
function buildMetricsProm(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return ''
  const header = parseCsvLine(lines[0])
  const names = header.slice(1)
  const series = names.map(name => ({ name, labels: labelsForColumn(name), points: [] }))
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const t = Number(cols[0])
    if (!Number.isFinite(t)) continue
    for (let c = 1; c < cols.length && c - 1 < series.length; c++) {
      const v = Number(cols[c])
      if (cols[c] !== '' && Number.isFinite(v)) series[c - 1].points.push([t, v])
    }
  }
  const out = []
  for (const s of series) {
    if (s.points.length === 0) continue
    const labels = Object.entries(s.labels)
      .map(([k, v]) => `${k}="${promEscape(v)}"`)
      .join(',')
    const name = sanitizeMetricName(s.name)
    const sb = `${name}${labels ? `{${labels}}` : ''}`
    for (const [ts, val] of s.points) {
      // OpenMetrics value TS: <value> <seconds>（promtool 按秒解析并 ×1000 存为毫秒）
      out.push(`${sb} ${val} ${ts}`)
    }
  }
  out.push('# EOF')
  return out.join('\n')
}

/** logs.csv → ES bulk NDJSON（sock-shop-logs 索引） */
function buildLogsBulk(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return ''
  const header = parseCsvLine(lines[0])
  const idx = {}
  header.forEach((h, i) => (idx[h] = i))
  const get = (cols, name) => {
    const i = idx[name]
    return i === undefined ? '' : (cols[i] ?? '')
  }
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const message = get(cols, 'message')
    if (!message) continue
    const level = get(cols, 'level')
    const timestampNs = Number(get(cols, 'timestamp')) || 0
    const doc = {
      time: get(cols, 'time'),
      timestamp: timestampNs,               // 纳秒，保持与 mock 一致
      tsMs: Math.floor(timestampNs / 1e6),   // 毫秒, 供 range 检索
      container_name: get(cols, 'container_name'),
      message,
      level,
      severity: deriveSeverity(level, message),
      req_path: get(cols, 'req_path'),
      error: get(cols, 'error'),
    }
    out.push(JSON.stringify({ index: { _index: 'sock-shop-logs' } }))
    out.push(JSON.stringify(doc))
  }
  return out.join('\n')
}

async function main() {
  const scenarioDir = process.argv[2]
  const outFlagIdx = process.argv.indexOf('--out')
  const outDir = outFlagIdx !== -1 ? process.argv[outFlagIdx + 1] : scenarioDir
  if (!scenarioDir) {
    console.error('usage: node scripts/real-data-sources.mjs <scenarioDir> [--out <dir>]')
    process.exit(1)
  }

  const [metricsCsv, logsCsv, injectTimeRaw] = await Promise.all([
    readFile(path.join(scenarioDir, 'metrics.csv'), 'utf8').catch(() => ''),
    readFile(path.join(scenarioDir, 'logs.csv'), 'utf8').catch(() => ''),
    readFile(path.join(scenarioDir, 'inject_time.txt'), 'utf8').catch(() => ''),
  ])
  const injectTime = Number(injectTimeRaw.trim()) || 0

  await mkdir(outDir, { recursive: true })
  const logsBulk = buildLogsBulk(logsCsv)
  const metricsProm = buildMetricsProm(metricsCsv)
  await writeFile(path.join(outDir, 'logs.ndjson'), logsBulk, 'utf8')
  await writeFile(path.join(outDir, 'metrics.prom'), metricsProm, 'utf8')
  await writeFile(path.join(outDir, 'inject_time.txt'), String(injectTime) + '\n', 'utf8')

  const esDocCount = (logsBulk.split('\n').length) / 2
  console.log(`scenario: ${scenarioDir}`)
  console.log(`  inject_time: ${injectTime}`)
  console.log(`  logs.ndjson: ${logsBulk.length} bytes (~${Math.floor(esDocCount)} docs)`)
  console.log(`  metrics.prom: ${metricsProm.length} bytes`)
  console.log(`  out: ${outDir}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})