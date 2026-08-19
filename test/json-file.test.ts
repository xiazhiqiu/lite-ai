import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AbortMutationError,
  atomicWriteJsonFile,
  mutateJsonFile,
  readJsonDegraded,
} from '../src/utils/json-file.js'

const isNumeric = (v: unknown): v is { n: number } =>
  typeof v === 'object' && v !== null && typeof (v as { n: unknown }).n === 'number'

test('json-file: 原子写、读降级、并发串行、Abort 不落盘', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'json-file-'))
  const file = path.join(dir, 'x.json')
  const fallback = () => ({ n: 0 })
  try {
    // 不存在 → fallback
    assert.deepEqual(await readJsonDegraded(file, isNumeric, fallback), { n: 0 })

    // 原子写后可读
    await atomicWriteJsonFile(file, { n: 7 })
    assert.deepEqual(await readJsonDegraded(file, isNumeric, fallback), { n: 7 })

    // 损坏 JSON → fallback（不抛异常）
    await writeFile(file, '{corrupt json', 'utf8')
    assert.deepEqual(await readJsonDegraded(file, isNumeric, fallback), { n: 0 })

    // 50 次并发读改写 → 不丢任何一次更新（按文件串行）
    await atomicWriteJsonFile(file, { n: 0 })
    await Promise.all(
      Array.from({ length: 50 }, () =>
        mutateJsonFile(file, isNumeric, fallback, cur => {
          cur.n += 1
        }),
      ),
    )
    assert.equal((await readJsonDegraded(file, isNumeric, fallback)).n, 50)

    // AbortMutationError → 中止且不落盘
    await atomicWriteJsonFile(file, { n: 100 })
    await mutateJsonFile(file, isNumeric, fallback, () => {
      throw new AbortMutationError('stop')
    })
    assert.equal((await readJsonDegraded(file, isNumeric, fallback)).n, 100)

    // 成功后不留临时文件
    await atomicWriteJsonFile(file, { n: 1 })
    const leftovers = (await readdir(dir)).filter(n => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})