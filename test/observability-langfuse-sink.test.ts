/**
 * Langfuse sink 的**接线**测试（不碰网络、不依赖真实 Langfuse）。
 *
 * ## 这里钉的是什么
 *
 * `langfuse-sink.ts` 里每一处 SDK 调用都包了 try/catch（纪律 2），副作用是
 * **上报彻底坏掉时本模块一声不吭**；而 SDK 的后台批量导出失败只走 OTel `diag`，
 * 其默认实现是 **no-op** —— 错误在那一步被丢掉，SDK 自己也不打印。
 *
 * 实测对照（两个独立进程，见 `tmp/probe-diag-fix.mjs`）：
 * baseUrl 指向无人监听的端口时，**不装 diag 输出 0 行，装了 diag 才看得到
 * `ECONNREFUSED`**。所以"diag 真的被接上了"这件事必须被自动化钉住 ——
 * 否则哪天有人删掉那行 `installExportDiagnostics`，回归测试全绿而缺口悄悄回来。
 *
 * ## 为什么这样测（而不是真等一次导出失败）
 *
 * 真等一轮批量导出要 ~5-8 秒（`LANGFUSE_FLUSH_INTERVAL` 默认值），且依赖
 * "导出真的失败"这种间接条件。这里改成**直接往 `diag` 发一条消息**，断言它能
 * 到调用方的 `log` —— 这正是"接线通不通"的最小充分证据，毫秒级且确定。
 *
 * 顺带钉住 `baseUrl` 的透传：`GET /trace/:jobId` 的 B 轨字段靠它回报"去哪看"。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diag } from '@opentelemetry/api'
import { createLangfuseTracingSink } from '../src/observability/langfuse-sink.js'

describe('Langfuse sink：导出失败不再静默（diag 接线）', () => {
  it('装配真实 sink 后，OTel diag 的 error/warn 会流到调用方的 log；info 被挡掉', async () => {
    const lines: Array<{ level: string; message: string }> = []
    const sink = await createLangfuseTracingSink({
      credentials: {
        publicKey: 'pk-lf-test-0000',
        secretKey: 'sk-lf-test-0000',
        // 指向一个必然没人监听的端口：整个用例**不产生任何出站请求**
        // （没发 span，就没有待导出批次），但足以让 SDK 正常装配。
        baseUrl: 'http://127.0.0.1:1',
      },
      log: (level, message) => lines.push({ level, message }),
    })

    try {
      assert.equal(sink.enabled, true)
      assert.equal(sink.baseUrl, 'http://127.0.0.1:1', 'baseUrl 要透传（/trace 靠它回报）')

      diag.error('模拟批量导出失败')
      diag.warn('模拟警告')
      diag.info('这条不该出现')

      assert.ok(
        lines.some(l => l.level === 'error' && l.message.includes('模拟批量导出失败')),
        'diag.error 必须到 log（否则就是"接上了却看不到坏"）',
      )
      assert.ok(
        lines.some(l => l.level === 'warn' && l.message.includes('模拟警告')),
        'diag.warn 必须到 log',
      )
      // DiagLogLevel.WARN 刻意挡掉 INFO/DEBUG：OTel 的 DEBUG 会打印 span 细节，
      // 可能含工具输入输出（保密性），不能一路放行到日志里。
      assert.ok(
        !lines.some(l => l.message.includes('这条不该出现')),
        'diag.info 必须被 WARN 级别挡掉',
      )
    } finally {
      await sink.shutdown()
    }
  })
})
