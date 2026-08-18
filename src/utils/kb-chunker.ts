export type Chunk = {
  section_title: string
  content: string
}

/**
 * 将 postmortem Markdown 按 `## ` 章节标题切片。
 * - 每个 `## ` 标题及其正文作为一个 chunk（标题行保留，便于检索定位来源章节）。
 * - 标题前的文档元信息（首行的 `# Postmortem:`）作为前置 chunk。
 * - 无任何 `## ` 标题的文档整体作为一个 chunk。
 */
export function chunkMarkdown(md: string): Chunk[] {
  if (!md.trim()) return []
  const lines = md.split(/\r?\n/)

  const sections: { title: string; body: string[] }[] = []
  let current: { title: string; body: string[] } | null = null
  const leading: string[] = []

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      const title = line.replace(/^##\s+/, '').trim()
      current = { title, body: [] }
      sections.push(current)
      continue
    }
    if (current) {
      current.body.push(line)
    } else {
      leading.push(line)
    }
  }

  const chunks: Chunk[] = []
  const leadingText = leading.join('\n').trim()
  if (leadingText) {
    chunks.push({ section_title: '', content: leadingText })
  }
  for (const section of sections) {
    const content = section.body.join('\n').trim()
    chunks.push({ section_title: section.title, content })
  }
  return chunks
}