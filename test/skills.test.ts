import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BUILTIN_SKILLS = [
  'oom-troubleshoot',
  'latency-degradation',
  'error-rate-spike',
  'log-burst-analysis',
]

let tmpCwd: string

test('before: 创建隔离 cwd', async () => {
  tmpCwd = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-skills-'))
})

test('after: 清理临时 cwd', async () => {
  if (tmpCwd) {
    await rm(tmpCwd, { recursive: true, force: true })
  }
})

test('discoverSkills: 任意 cwd 下都能发现 4 个内置故障域 skill', async () => {
  const { discoverSkills } = await import('../src/skills.js')
  const skills = await discoverSkills(tmpCwd)
  const byName = new Map(skills.map(s => [s.name, s]))
  for (const name of BUILTIN_SKILLS) {
    const skill = byName.get(name)
    assert.ok(skill, `内置 skill ${name} 应被发现`)
    assert.equal(skill.source, 'builtin')
    assert.ok(skill.description.length > 0, `${name} 应有描述`)
  }
})

test('loadSkill: 能读取内置 skill 的完整 SOP 内容', async () => {
  const { loadSkill } = await import('../src/skills.js')
  const skill = await loadSkill(tmpCwd, 'oom-troubleshoot')
  assert.ok(skill)
  assert.match(skill.content, /## 取证顺序/)
  assert.match(skill.content, /## 典型根因模式/)
  assert.match(skill.content, /OOMKilled/)
})

test('load_skill 工具: 返回 SKILL 名/路径/完整内容', async () => {
  const { createLoadSkillTool } = await import('../src/tools/load-skill.js')
  const tool = createLoadSkillTool(tmpCwd)
  const result = await tool.run({ name: 'latency-degradation' })
  assert.equal(result.ok, true)
  assert.match(result.output, /SKILL: latency-degradation/)
  assert.match(result.output, /SOURCE: builtin/)
  assert.match(result.output, /P99/)
})

test('load_skill 工具: 未知 skill 返回错误', async () => {
  const { createLoadSkillTool } = await import('../src/tools/load-skill.js')
  const tool = createLoadSkillTool(tmpCwd)
  const result = await tool.run({ name: 'no-such-skill' })
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown skill/)
})

test('loadSkill: 拒绝目录穿越技能名（防任意 SKILL.md 读取）', async () => {
  const { loadSkill } = await import('../src/skills.js')
  for (const name of [
    '../../../../etc/passwd',
    'a/b',
    '..',
    '.',
    'a\\b',
    '/etc/passwd',
  ]) {
    const skill = await loadSkill(tmpCwd, name)
    assert.equal(skill, null, `技能名 ${JSON.stringify(name)} 应被拒绝`)
  }
})
