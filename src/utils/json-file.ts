import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isEnoentError } from './errors.js'

/**
 * 进程内按文件路径的串行化队列，保证同一文件的"读取→修改→写入"不会被并发交错。
 * 跨进程的并发写（如 webhook 诊断与 TTY 会话同时操作同一 cwd）仍建议交给文件锁/数据库，
 * 此处的目标是让单进程内读改写保持原子，并从崩溃中恢复（写是原子的）。
 */
const fileQueues = new Map<string, Promise<unknown>>()

async function serialized<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prev = (fileQueues.get(filePath) ?? Promise.resolve()) as Promise<unknown>
  const run = Promise.resolve(prev).then(task, task)
  // slot 总是成功 settle，避免等待期间产生 unhandled rejection
  const slot = run.then(
    () => undefined,
    () => undefined,
  )
  fileQueues.set(filePath, slot)
  try {
    return await run
  } finally {
    // 仅在仍为队尾时清理，避免 Map 无限增长
    if (fileQueues.get(filePath) === slot) {
      fileQueues.delete(filePath)
    }
  }
}

/**
 * 读取 JSON。文件不存在、解析失败或结构不匹配时都回退到 fallback()，
 * 保证半损坏的残留文件不会中断整场事故诊断。
 */
export async function readJsonDegraded<T>(
  filePath: string,
  isShape: (value: unknown) => boolean,
  fallback: () => T,
): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isShape(parsed) ? (parsed as T) : fallback()
  } catch (error) {
    if (isEnoentError(error)) return fallback()
    // 其余错误（JSON 语法错误等）同样降级为空，而不是把异常抛出
    return fallback()
  }
}

/** 原子写 JSON：先写入临时文件再 rename 覆盖，崩溃/中断不会留下半截 JSON。 */
export async function atomicWriteJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp`
  const content = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)
}

export class AbortMutationError extends Error {
  constructor(message?: string) {
    super(message ?? 'mutation aborted without persisting')
    this.name = 'AbortMutationError'
  }
}

/**
 * 原子"读改写成"：在进程内按文件串行执行 read → mutate → 原子写。
 * - mutate 拿到当前值（读取失败时是 fallback），直接改这份对象即可；
 *   函数返回持久化后的新值，便于调用方直接复用。
 * - mutate 内 `throw new AbortMutationError()` 可中止本次改动且不落盘
 *   （用于保留现有的"校验失败返回 ok:false"语义），此时返回当前（未修改的）值。
 */
export async function mutateJsonFile<T>(
  filePath: string,
  isShape: (value: unknown) => boolean,
  fallback: () => T,
  mutate: (current: T) => void,
): Promise<T> {
  return serialized(filePath, async () => {
    const current = await readJsonDegraded(filePath, isShape, fallback)
    let result = current
    try {
      mutate(current)
      await atomicWriteJsonFile(filePath, current)
      result = current
    } catch (error) {
      if (error instanceof AbortMutationError) {
        // 校验失败：不落盘，返回当前值供调用方构造 ok:false
        return current
      }
      throw error
    }
    return result
  })
}