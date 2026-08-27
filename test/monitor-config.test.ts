// test/monitor-config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMonitorConfig } from '../src/monitor/config.js'

test('readMonitorConfig: 无 env 时返回默认值', () => {
  delete process.env.LITE_AI_MONITOR_TOOL_REPEAT_MAX
  delete process.env.LITE_AI_TOOL_REPEAT_NOTICE_MAX
  delete process.env.LITE_AI_MONITOR_CONSECUTIVE_FAILURE_MAX
  assert.deepEqual(readMonitorConfig(), {
    toolRepeatNoticeMax: 3,
    consecutiveFailureMax: 3,
  })
})

test('readMonitorConfig: 新命名空间优先，非法值回退默认', () => {
  process.env.LITE_AI_MONITOR_TOOL_REPEAT_MAX = '5'
  process.env.LITE_AI_MONITOR_CONSECUTIVE_FAILURE_MAX = 'abc'
  assert.deepEqual(readMonitorConfig(), {
    toolRepeatNoticeMax: 5,
    consecutiveFailureMax: 3,
  })
})

test('readMonitorConfig: 旧变量可回退（向后兼容）', () => {
  delete process.env.LITE_AI_MONITOR_TOOL_REPEAT_MAX
  process.env.LITE_AI_TOOL_REPEAT_NOTICE_MAX = '7'
  assert.equal(readMonitorConfig().toolRepeatNoticeMax, 7)
})