/**
 * RE2-SS 测试集 CSV 数据加载：metrics.csv / logs.csv / pod-node-*.csv
 * 纯数据层，供 mock Prometheus / Elasticsearch / k8s API server 使用。
 */

/** 一个指标时序：__name__ + 标签 + (epoch 秒, 值) 采样点 */
export interface MetricSeries {
  name: string
  labels: Record<string, string>
  points: Array<[number, number]>
}

/** 一条日志（对应 logs.csv 的一行，也是 ES 的一个 _source 文档） */
export interface LogEntry {
  time: string // "20:50"
  timestampNs: number
  container: string
  message: string
  level: string
  severity: string // 从 level/消息关键字推导，便于 ES 按级别检索
  reqPath: string
  error: string
}

/** pod-node CSV 的一行 */
export interface PodPlacement {
  pod: string
  node: string
}

/** 解析一行 CSV（支持引号包裹字段、字段内含逗号与 "" 转义） */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

const NODE_METRIC_RE = /_(node|memory|disk|network|cpu|sockets?)-/

/** 从列名推导标签：node 系列 → {node}; 其余 → {container} */
function labelsForColumn(column: string): Record<string, string> {
  if (column.startsWith('gke-')) {
    const m = NODE_METRIC_RE.exec(column)
    if (m && m.index > 0) {
      return { node: column.slice(0, m.index) }
    }
    return { node: column }
  }
  const idx = column.indexOf('_')
  return idx > 0 ? { container: column.slice(0, idx) } : {}
}

/** metrics.csv（宽表: time + 每列一个时序）→ 时序列表 */
export function loadMetrics(csv: string): MetricSeries[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]!)
  const names = header.slice(1)
  const series: MetricSeries[] = names.map(name => ({
    name,
    labels: { ...labelsForColumn(name) },
    points: [],
  }))

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!)
    const t = Number(cols[0])
    if (!Number.isFinite(t)) continue
    for (let c = 1; c < cols.length && c - 1 < series.length; c++) {
      const v = Number(cols[c])
      if (cols[c] !== '' && Number.isFinite(v)) {
        series[c - 1]!.points.push([t, v])
      }
    }
  }

  return series.filter(s => s.points.length > 0)
}

const ERROR_HINT =
  /\bERROR\b|exception|HttpServerErrorException|Service Unavailable|timeout|Prematurely|refused|unavailable|failed|error/i
const WARN_HINT = /\bWARN\b|Retrying|socket exception|socket|too many/i

/** 从原始 level + 消息关键字推导 severity */
export function deriveSeverity(level: string, message: string): string {
  const lv = level.trim().toUpperCase()
  if (lv === 'ERROR' || lv === 'WARN' || lv === 'INFO' || lv === 'DEBUG') {
    return lv
  }
  if (ERROR_HINT.test(message)) return 'ERROR'
  if (WARN_HINT.test(message)) return 'WARN'
  return 'INFO'
}

/** logs.csv → 日志条目 */
export function loadLogs(csv: string): LogEntry[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]!)
  const idx: Record<string, number> = {}
  header.forEach((h, i) => (idx[h] = i))

  const get = (cols: string[], name: string): string => {
    const i = idx[name]
    return i === undefined ? '' : (cols[i] ?? '')
  }

  const entries: LogEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!)
    const message = get(cols, 'message')
    if (!message) continue
    const level = get(cols, 'level')
    entries.push({
      time: get(cols, 'time'),
      timestampNs: Number(get(cols, 'timestamp')) || 0,
      container: get(cols, 'container_name'),
      message,
      level,
      severity: deriveSeverity(level, message),
      reqPath: get(cols, 'req_path'),
      error: get(cols, 'error'),
    })
  }
  return entries
}

/** pod-node CSV → Pod 位置列表 */
export function loadPodNodes(csv: string): PodPlacement[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  const out: PodPlacement[] = []
  for (let i = 1; i < lines.length; i++) {
    const [pod, node] = parseCsvLine(lines[i]!)
    if (pod) out.push({ pod: pod.trim(), node: (node ?? '').trim() })
  }
  return out
}

/** 取两个 CSV 的并集（pod-node-1.csv + pod-node-2.csv 可能是不同视角） */
export function mergePodNodes(a: PodPlacement[], b: PodPlacement[]): PodPlacement[] {
  const map = new Map<string, string>()
  for (const p of [...a, ...b]) {
    if (!map.has(p.pod)) map.set(p.pod, p.node)
  }
  return [...map.entries()].map(([pod, node]) => ({ pod, node }))
}
