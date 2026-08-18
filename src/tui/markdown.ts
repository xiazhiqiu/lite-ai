import { stringDisplayWidth } from './chrome.js'

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const MAGENTA = '\u001b[35m'
const BOLD = '\u001b[1m'

/**
 * 表格单元格对齐方式。
 * 由分隔符行推断：`:---:` 居中、`---:` 右对齐，其余左对齐。
 */
type CellAlign = 'left' | 'center' | 'right'

function parseAlign(sep: string): CellAlign {
  const trimmed = sep.trim()
  let s = trimmed
  const center = s.startsWith(':') && s.endsWith(':')
  const right = s.endsWith(':')
  s = s.replace(/^:/, '').replace(/:$/, '')
  const hasDashes = /-+/.test(s)
  if (!hasDashes) return 'left'
  if (center) return 'center'
  if (right) return 'right'
  return 'left'
}

function alignCell(cell: string, width: number, align: CellAlign): string {
  const visible = stringDisplayWidth(cell)
  if (visible >= width) return cell
  const pad = ' '.repeat(width - visible)
  if (align === 'center') {
    const left = Math.floor(pad.length / 2)
    return `${pad.slice(0, left)}${cell}${pad.slice(left)}`
  }
  if (align === 'right') return `${pad}${cell}`
  return `${cell}${pad}` // left
}

/** 判定是否为分隔符行（如 |:---|---:|）。 */
function isSeparatorLine(line: string): boolean {
  const t = line.trim()
  if (!/^\|/.test(t) || !/\|$/.test(t)) return false
  const inner = t.slice(1, -1)
  const cells = inner.split('|').map(c => c.trim())
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c))
}

/** 判定是否为普通表格行（以 | 起始、结尾）。 */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** 解析一个表格块，返回对齐后的几行文本。 */
function renderTableBlock(start: number, lines: string[]): {
  rows: string[]
  endIndex: number
} {
  // 收集连续表格行：必须至少包含一条分隔符行
  let index = start
  const collected: string[] = []
  while (index < lines.length && isTableRow(lines[index]!)) {
    collected.push(lines[index]!)
    index += 1
  }

  let sepIndex = -1
  for (let i = 0; i < collected.length; i += 1) {
    if (isSeparatorLine(collected[i]!)) {
      sepIndex = i
      break
    }
  }

  if (sepIndex === -1) {
    return { rows: collected, endIndex: index }
  }

  const aligns = collected[sepIndex]!
    .slice(1, -1)
    .split('|')
    .map(c => parseAlign(c))
  const colCount = aligns.length

  // 解析数据行（跳过分隔行），保持原始行内对齐
  const dataLines: { cells: string[]; isHeader: boolean }[] = []
  for (let i = 0; i < collected.length; i += 1) {
    if (i === sepIndex) continue
    const raw = collected[i]!
    const cells = raw
      .slice(1, -1)
      .split('|')
      .map(c => c.trim())
    dataLines.push({ cells, isHeader: i < sepIndex })
  }
  if (dataLines.length === 0) {
    return { rows: collected, endIndex: index }
  }

  // 计算每列最大显示宽度
  const widths: number[] = new Array(colCount).fill(0)
  for (const { cells } of dataLines) {
    for (let c = 0; c < colCount; c += 1) {
      const cell = cells[c] ?? ''
      const w = stringDisplayWidth(cell)
      if (w > widths[c]!) widths[c] = w
    }
  }

  const rows: string[] = []
  for (const { cells, isHeader } of dataLines) {
    const parts: string[] = []
    for (let c = 0; c < colCount; c += 1) {
      const raw = cells[c] ?? ''
      const align = c === 0 ? 'left' : c < aligns.length ? aligns[c]! : 'left'
      const padded = alignCell(raw, widths[c]!, align)
      parts.push(padded)
    }
    const rowText = parts.join(` ${DIM}│${RESET} `)
    rows.push(
      isHeader
        ? `${CYAN}${BOLD}${rowText}${RESET}`
        : `${rowText}`,
    )
  }

  // 弱化分隔线：以列宽拼一段虚线
  const dashed = (widths as number[])
    .map(w => '-'.repeat(Math.max(1, w)))
    .join(` ${DIM}│${RESET} `)
  rows.splice(1, 0, `${DIM}${dashed}${RESET}`)

  // 若输入行首尾带 | 且我们解析时截掉，这里还原外边框竖线
  const boxedRows = rows.map(r => `${DIM}│${RESET}${r}${DIM}│${RESET}`)

  return { rows: boxedRows, endIndex: index }
}

/** 渲染单行（非表格逻辑，与历史行为一致）。 */
function renderLine(line: string): string {
  let formatted = line

  if (line.startsWith('```')) return `${DIM}${line}${RESET}`
  if (/^\s*[-*]\s+/.test(line)) {
    formatted = line.replace(/^\s*[-*]\s+/, `${YELLOW}•${RESET} `)
  }

  formatted = formatted.replace(/`([^`]+)`/g, `${MAGENTA}$1${RESET}`)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)

  return formatted
}

export function renderMarkdownish(input: string): string {
  const lines = input.split('\n')
  let inCodeBlock = false
  const out: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock
      out.push(`${DIM}${line}${RESET}`)
      continue
    }

    if (inCodeBlock) {
      out.push(`${DIM}${line}${RESET}`)
      continue
    }

    // 表格块（至少含一条分隔符行）
    if (isTableRow(line)) {
      const { rows, endIndex } = renderTableBlock(i, lines)
      out.push(...rows)
      i = endIndex - 1
      continue
    }

    let formatted = line

    if (line.startsWith('### ')) {
      formatted = `${CYAN}${BOLD}${line.slice(4)}${RESET}`
    } else if (line.startsWith('## ')) {
      formatted = `${CYAN}${BOLD}${line.slice(3)}${RESET}`
    } else if (line.startsWith('# ')) {
      formatted = `${CYAN}${BOLD}${line.slice(2)}${RESET}`
    } else if (line.startsWith('> ')) {
      formatted = `${DIM}${line}${RESET}`
    } else {
      formatted = renderLine(line)
    }

    out.push(formatted)
  }

  return out.join('\n')
}
