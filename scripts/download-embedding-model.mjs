// 从 ModelScope 下载 all-MiniLM-L6-v2 ONNX 模型文件到本地目录。
// 用法: node scripts/download-embedding-model.mjs <目标目录>
// 注意: <目标目录> 是 embedding 模型的"父目录"（含 Xenova/all-MiniLM-L6-v2 层级），
//       与 LITE_AI_EMBED_MODEL_DIR / kb-embedder 的 localModelRoot 约定一致。
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: node scripts/download-embedding-model.mjs <target-dir>')
  process.exit(1)
}

const model = 'Xenova/all-MiniLM-L6-v2'
const base = `https://modelscope.cn/models/${model}/resolve/master`
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model.onnx',
]

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return buf.length
}

// 模型文件写入 {outDir}/{model}/...（含 Xenova/all-MiniLM-L6-v2 层级），
// 与 kb-embedder 的 localModelRoot 约定一致：outDir 是"包含 Xenova/... 的父目录"。
const modelRoot = path.join(outDir, ...model.split('/'))
let total = 0
for (const f of files) {
  const destDir = path.dirname(path.join(modelRoot, f))
  await mkdir(destDir, { recursive: true })
  const dest = path.join(modelRoot, f)
  const url = `${base}/${f}`
  try {
    const n = await download(url, dest)
    total += n
    console.log(`OK ${f} (${(n / 1024 / 1024).toFixed(1)} MB)`)
  } catch (e) {
    console.error(`FAIL ${f}: ${e.message}`)
    if (f.endsWith('model.onnx')) {
      console.log('model.onnx 下载失败，其余文件仍可用，稍后重试')
    } else {
      process.exitCode = 1
    }
  }
}
console.log(`done. total=${(total / 1024 / 1024).toFixed(1)} MB -> ${outDir}`)