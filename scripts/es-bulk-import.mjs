/**
 * 把转换器产出的 logs.ndjson（ES _bulk 请求体，2行一条文档）分批 POST 到真实 ES。
 * 用法: node scripts/es-bulk-import.mjs <ndjson> <es-url>
 */
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const [ndjsonPath, esUrl = 'http://localhost:19200'] = process.argv.slice(2)
if (!ndjsonPath) {
  console.error('usage: node scripts/es-bulk-import.mjs <logs.ndjson> [es-url]')
  process.exit(1)
}

const BATCH = 1000 // 每批 1000 条文档（2000 行）
let indexed = 0
let failed = 0

async function postBatch(batch) {
  const res = await fetch(`${esUrl}/_bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: batch.join('\n') + '\n',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const json = await res.json()
  for (const item of json.items ?? []) {
    const s = item.index?.status ?? 0
    if (s >= 400) { failed++; if (failed <= 5) console.error('  err item:', JSON.stringify(item).slice(0, 200)) }
    else indexed++
  }
}

const rl = createInterface({ input: createReadStream(ndjsonPath, { encoding: 'utf8' }), crlfDelay: Infinity })
let lines = []
let docCount = 0
for await (const line of rl) {
  if (!line.trim()) continue
  lines.push(line)
  if (lines.length === BATCH * 2) {
    await postBatch(lines)
    lines = []
    docCount += BATCH
    process.stdout.write(`\rindexed ${indexed} / failed ${failed}`)
  }
}
if (lines.length) {
  await postBatch(lines)
  docCount += lines.length / 2
}
console.log(`\ndone. total=${indexed} failed=${failed}`)