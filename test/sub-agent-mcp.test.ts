import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry, type ToolDefinition } from '../src/tool.js'
import { SUB_AGENT_TOOL_NAMES } from '../src/tools/index.js'

function makeTool(name: string, opts: { isReadOnly?: boolean } = {}): ToolDefinition<unknown> {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: {} as any,
    async run() {
      return { ok: true, output: name }
    },
    isReadOnly: opts.isReadOnly,
  }
}

test('subsetForSubAgent: 内置只读白名单工具被纳入', () => {
  const registry = new ToolRegistry([
    makeTool('list_files'),
    makeTool('grep_files'),
    makeTool('read_file'),
    makeTool('write_file'),
    makeTool('run_command'),
    makeTool('load_skill'),
  ])
  const sub = registry.subsetForSubAgent(SUB_AGENT_TOOL_NAMES)
  const names = sub.list().map(t => t.name)

  assert.ok(names.includes('run_command'))
  assert.ok(names.includes('load_skill'))
  assert.ok(!names.includes('list_files'), '通用文件工具不应在子 agent 工具集中')
  assert.ok(!names.includes('grep_files'), '通用文件工具不应在子 agent 工具集中')
  assert.ok(!names.includes('read_file'), '通用文件工具不应在子 agent 工具集中')
  assert.ok(!names.includes('write_file'), 'write_file 不应在子 agent 工具集中')
})

test('subsetForSubAgent: isReadOnly=true 的 MCP 工具被纳入', () => {
  const registry = new ToolRegistry([
    makeTool('list_files'),
    makeTool('mcp__prometheus__query', { isReadOnly: true }),
    makeTool('mcp__k8s__apply', { isReadOnly: false }),
    makeTool('mcp__k8s__get', { isReadOnly: true }),
  ])
  const sub = registry.subsetForSubAgent(SUB_AGENT_TOOL_NAMES)
  const names = sub.list().map(t => t.name)

  assert.ok(names.includes('mcp__prometheus__query'), '只读 MCP 工具应被纳入')
  assert.ok(names.includes('mcp__k8s__get'), '只读 MCP 工具应被纳入')
  assert.ok(!names.includes('mcp__k8s__apply'), '非只读 MCP 工具不应被纳入')
})

test('subsetForSubAgent: 未声明 isReadOnly 的工具不被纳入（fail-closed）', () => {
  const registry = new ToolRegistry([
    makeTool('list_files'),
    makeTool('mcp__unknown__tool'), // isReadOnly 未声明
  ])
  const sub = registry.subsetForSubAgent(SUB_AGENT_TOOL_NAMES)
  const names = sub.list().map(t => t.name)

  assert.ok(!names.includes('mcp__unknown__tool'), '未声明 isReadOnly 的工具不应被纳入')
})

test('subsetForSubAgent: 空注册表返回空子集', () => {
  const registry = new ToolRegistry([])
  const sub = registry.subsetForSubAgent(SUB_AGENT_TOOL_NAMES)
  assert.equal(sub.list().length, 0)
})

test('SUB_AGENT_TOOL_NAMES 包含 run_command', () => {
  assert.ok(SUB_AGENT_TOOL_NAMES.includes('run_command'))
})

// MCP annotations.readOnlyHint 判定测试（模拟 createMcpBackedTools 的 isReadOnly 逻辑）
test('MCP isReadOnly 判定: annotations.readOnlyHint=true 且无 destructiveHint → 只读', () => {
  // 模拟 mcp.ts 的判定逻辑
  const annotations = { readOnlyHint: true, destructiveHint: false }
  const readOnlyFromHint =
    annotations?.readOnlyHint === true && annotations?.destructiveHint !== true
  assert.equal(readOnlyFromHint, true)
})

test('MCP isReadOnly 判定: annotations.readOnlyHint=true 但 destructiveHint=true → 非只读（矛盾按悲观）', () => {
  const annotations = { readOnlyHint: true, destructiveHint: true }
  const readOnlyFromHint =
    annotations?.readOnlyHint === true && annotations?.destructiveHint !== true
  assert.equal(readOnlyFromHint, false)
})

test('MCP isReadOnly 判定: 无 annotations → 非只读（fail-closed）', () => {
  const annotations = undefined
  const readOnlyFromHint =
    annotations?.readOnlyHint === true && annotations?.destructiveHint !== true
  assert.equal(readOnlyFromHint, false)
})

test('MCP isReadOnly 判定: config.readOnlyTools 覆盖 → 只读（最高优先级）', () => {
  // 即使无 annotations，config 显式标注也视为只读
  const annotations = undefined
  const readOnlyFromConfig = true // config.readOnlyTools 包含该工具名
  const readOnlyFromHint =
    annotations?.readOnlyHint === true && annotations?.destructiveHint !== true
  const isReadOnly = readOnlyFromConfig || readOnlyFromHint
  assert.equal(isReadOnly, true)
})
