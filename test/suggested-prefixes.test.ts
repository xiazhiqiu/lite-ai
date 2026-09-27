import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  deriveSuggestedPrefixes,
  evaluateBashCommand,
  validateSuggestedPrefixes,
} from '../src/tools/command-guard.js'

// suggested_prefixes 机制对齐 HolmesGPT：
// - bash_toolset.py:123 模型必填参数（每段一个前缀）
// - validation.py:571 前缀必须出现在命令里（PREFIX_NOT_IN_COMMAND → deny）
// - tool_calling_llm.py:461-503 只持久化模型声明过、人批过的前缀

describe('validateSuggestedPrefixes 前缀一致性校验', () => {
  test('一致：每段一个前缀且都出现在命令里 → null', () => {
    assert.equal(
      validateSuggestedPrefixes('kubectl get pods | grep app', [
        'kubectl get',
        'grep',
      ]),
      null,
    )
    assert.equal(
      validateSuggestedPrefixes('kubectl get pods', ['kubectl get']),
      null,
    )
    // 引号剥除后按词匹配：声明引号内的词也算出现（对齐 HG :610-611 注释语义）
    assert.equal(
      validateSuggestedPrefixes("kubectl get 'secret'", ['kubectl get secret']),
      null,
    )
  })

  test('空数组 → deny（HG：必填，缺失给自纠提示）', () => {
    const reason = validateSuggestedPrefixes('ls', [])
    assert.match(reason!, /required/)
    assert.match(reason!, /suggested_prefixes/)
  })

  test('幻觉前缀：声明的前缀不在命令里 → deny', () => {
    assert.match(
      validateSuggestedPrefixes('kubectl get pods', ['kubectl delete'])!,
      /does not appear in the command/,
    )
  })

  test('声明无关作用域：cat 命令声明 curl 前缀 → deny', () => {
    assert.match(
      validateSuggestedPrefixes('cat a.log', ['curl'])!,
      /does not appear in the command/,
    )
  })

  test('段数不匹配 → deny（每段一个前缀）', () => {
    assert.match(
      validateSuggestedPrefixes('kubectl get pods | grep app', ['kubectl get'])!,
      /one prefix per command segment/,
    )
  })

  test('词边界：子串撞不上（kubectl ge ≠ kubectl get）', () => {
    assert.match(
      validateSuggestedPrefixes('kubectl get pods', ['kubectl ge'])!,
      /does not appear/,
    )
  })

  test('2>&1 不算独立段（fd 复制留在段内）', () => {
    assert.equal(
      validateSuggestedPrefixes('kubectl get pods 2>&1 | grep err', [
        'kubectl get',
        'grep',
      ]),
      null,
    )
  })

  test('解析失败（命令替换）跳过段数校验，仅查词面出现', () => {
    assert.equal(validateSuggestedPrefixes('echo $(pwd)', ['echo']), null)
  })
})

describe('deriveSuggestedPrefixes（/cmd 快捷方式与 mock 模型的兜底推导）', () => {
  test('每段取前两个词', () => {
    assert.deepEqual(deriveSuggestedPrefixes('kubectl get pods | grep app'), [
      'kubectl get',
      'grep app',
    ])
  })

  test('单段单词', () => {
    assert.deepEqual(deriveSuggestedPrefixes('ls'), ['ls'])
  })

  test('解析失败退化为整条命令首词', () => {
    assert.deepEqual(deriveSuggestedPrefixes('echo $(pwd)'), ['echo'])
  })
})

describe('evaluateBashCommand：前缀 deny 优先于白名单 allow（对齐 HG validate_command 顺序）', () => {
  test('命令本身可免审批，但前缀不一致仍整条 deny', () => {
    const result = evaluateBashCommand('kubectl get pods', ['kubectl delete'])
    assert.equal(result.verdict, 'deny')
    assert.match(result.reason!, /does not appear/)
  })

  test('一致 + 全段白名单 → allow', () => {
    assert.equal(
      evaluateBashCommand('kubectl get pods', ['kubectl get']).verdict,
      'allow',
    )
  })

  test('一致 + 未知命令 → approval', () => {
    const result = evaluateBashCommand('zig build', ['zig build'])
    assert.equal(result.verdict, 'approval')
  })

  test('一致 + secret 段 → deny（secret 硬拦不受前缀影响）', () => {
    const result = evaluateBashCommand('kubectl get secrets', ['kubectl get'])
    assert.equal(result.verdict, 'deny')
    assert.match(result.reason!, /secrets/)
  })
})
