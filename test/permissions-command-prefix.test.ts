import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractCommandPrefix,
  matchesCommandPrefix,
  PermissionManager,
} from '../src/permissions.js'
import type {
  PermissionChoice,
  PermissionDecision,
  PermissionRequest,
} from '../src/permissions.js'

let tempRoot: string
let storePath: string

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-perm-prefix-'))
  storePath = path.join(tempRoot, 'permissions.json')
})

after(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

type PromptCall = {
  summary: string
  command: string
  choices: PermissionChoice[]
}

function makePrompt(decisions: PermissionDecision[]) {
  const calls: PromptCall[] = []
  return {
    calls,
    prompt: async (request: PermissionRequest) => {
      calls.push({
        summary: request.summary,
        command: request.details.find(d => d.startsWith('command: ')) ?? '',
        choices: request.choices,
      })
      return { decision: decisions.shift() ?? 'deny_once' }
    },
  }
}

/**
 * decisions 为 null 时不挂 prompt handler：
 * 若本应免审批的路径漏放行，会直接抛 "requires approval" 而非被 mock 兜底。
 */
function newManager(
  decisions: PermissionDecision[] | null,
  overrideStorePath: string = storePath,
) {
  if (decisions === null) {
    return { calls: [] as PromptCall[], manager: new PermissionManager(tempRoot, undefined, overrideStorePath) }
  }
  const { calls, prompt } = makePrompt(decisions)
  const manager = new PermissionManager(tempRoot, prompt, overrideStorePath)
  return { calls, manager }
}

async function writeStore(name: string, store: object): Promise<string> {
  const storePathNamed = path.join(tempRoot, name)
  await writeFile(storePathNamed, JSON.stringify(store, null, 2))
  return storePathNamed
}

test('extractCommandPrefix：command + 首参构成前缀', () => {
  assert.equal(extractCommandPrefix('kubectl', ['logs', 'app-1']), 'kubectl logs')
  assert.equal(extractCommandPrefix('docker', ['stop', 'web']), 'docker stop')
  assert.equal(
    extractCommandPrefix('node', ['scripts/healthcheck.js']),
    'node scripts/healthcheck.js',
  )
})

test('extractCommandPrefix：任何旗标在场返回 null（fail-closed）', () => {
  // 旗标携带任意载荷：bash -lc 前缀化等于永久放行任意脚本
  assert.equal(extractCommandPrefix('bash', ['-lc', 'ls | zig build']), null)
  assert.equal(extractCommandPrefix('node', ['-e', 'code']), null)
  // 旗标改变危险等级：'git push' 前缀会连 force push 一起放行
  assert.equal(extractCommandPrefix('git', ['push', '--force', 'origin']), null)
  // find 的参数几乎全是旗标（-name/-delete），永远不播种前缀
  assert.equal(extractCommandPrefix('find', ['.', '-name', 'x', '-delete']), null)
  // 旗标在后面的位置同样拦截
  assert.equal(extractCommandPrefix('kubectl', ['logs', '-f', 'app']), null)
  // 无参数无前缀可言
  assert.equal(extractCommandPrefix('npm', []), null)
  assert.equal(extractCommandPrefix('npm', ['   ']), null)
})

test('matchesCommandPrefix：逐词比较，词边界防误命中', () => {
  assert.equal(matchesCommandPrefix('kubectl get pods', ['kubectl get']), true)
  // 字符串 startsWith 会误命中，逐词比较不会
  assert.equal(matchesCommandPrefix('kubectl getx pods', ['kubectl get']), false)
  assert.equal(matchesCommandPrefix('kubectl logs app', ['kubectl logs']), true)
  assert.equal(matchesCommandPrefix('kubectl logs', ['kubectl logs app']), false)
  assert.equal(matchesCommandPrefix('kubectl', ['kubectl get']), false)
  assert.equal(matchesCommandPrefix('kubectl get pods', []), false)
})

test('审批框：非旗标形态提供第 5 档 allow_prefix', async () => {
  const { calls, manager } = newManager(['allow_once'])
  await manager.ensureCommand('kubectl', ['logs', 'app-1'], tempRoot, {
    forcePromptReason: 'guard pipeline',
  })

  assert.equal(calls.length, 1)
  const p = calls[0]!.choices.find(choice => choice.key === 'p')
  assert.ok(p, 'choices 应包含 p 档')
  assert.equal(p!.decision, 'allow_prefix')
  assert.match(p!.label, /kubectl logs/)
})

test('审批框：旗标形态（bash -lc）不提供 allow_prefix', async () => {
  const { calls, manager } = newManager(['allow_once'])
  await manager.ensureCommand('bash', ['-lc', 'ls'], tempRoot)

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0]!.choices.find(choice => choice.key === 'p'),
    undefined,
  )
  // 其余四档仍在
  assert.deepEqual(
    calls[0]!.choices.map(choice => choice.key),
    ['y', 'a', 'n', 'd'],
  )
})

test('allow_prefix 决策：落盘 + 同实例内同前缀不同参数免审批', async () => {
  const { calls, manager } = newManager(['allow_prefix'])
  await manager.ensureCommand('kubectl', ['logs', 'app-1'], tempRoot, {
    forcePromptReason: 'guard pipeline',
  })
  assert.equal(calls.length, 1)

  // 同前缀第二个命令：前缀放行，不再触发审批
  await manager.ensureCommand('kubectl', ['logs', 'app-2'], tempRoot, {
    forcePromptReason: 'guard pipeline',
  })
  assert.equal(calls.length, 1)

  const store = JSON.parse(await readFile(storePath, 'utf8'))
  assert.deepEqual(store.allowedCommandPrefixes, ['kubectl logs'])
})

test('前缀持久化跨实例生效（无 prompt 实例免审批）', async () => {
  // 前置：store 里已有 'kubectl logs'（上一用例写入）
  const { manager } = newManager(null, storePath)
  // 无 prompt handler：若前缀未生效会直接抛 requires approval
  await manager.ensureCommand('kubectl', ['logs', 'app-3'], tempRoot, {
    forcePromptReason: 'guard pipeline',
  })
})

test('词边界跨实例：kubectl get 前缀不放行 kubectl getx', async () => {
  const prefixStore = await writeStore('prefix-get.json', {
    allowedCommandPrefixes: ['kubectl get'],
  })

  const { manager } = newManager(null, prefixStore)
  await assert.rejects(
    () =>
      manager.ensureCommand('kubectl', ['getx', 'pods'], tempRoot, {
        forcePromptReason: 'guard pipeline',
      }),
    /requires approval/,
  )
})

test('deny 优先于前缀放行（持久层 deny_always 签名在前缀检查之前）', async () => {
  const combinedStore = await writeStore('prefix-deny.json', {
    allowedCommandPrefixes: ['kubectl delete'],
    deniedCommandPatterns: ['kubectl delete pod a'],
  })

  const { manager } = newManager(null, combinedStore)
  // 该签名同时命中前缀 'kubectl delete' 与精确 deny —— deny 必须胜出
  await assert.rejects(
    () =>
      manager.ensureCommand('kubectl', ['delete', 'pod', 'a'], tempRoot, {
        forcePromptReason: 'guard pipeline',
      }),
    /Command denied/,
  )
  // 同前缀下未被 deny 的其他签名仍走前缀放行
  await manager.ensureCommand('kubectl', ['delete', 'pod', 'b'], tempRoot, {
    forcePromptReason: 'guard pipeline',
  })
})

test('dangerous 分类命令同样受明确授权的前缀覆盖', async () => {
  const dangerousStore = await writeStore('prefix-dangerous.json', {})

  const { calls, manager } = newManager(['allow_prefix'], dangerousStore)
  // docker stop 是 dangerous 分类（mutating operation），审批框出现
  await manager.ensureCommand('docker', ['stop', 'web'], tempRoot)
  assert.equal(calls.length, 1)

  // 用户明确授权 'docker stop' 前缀后，同类命令免审批（用户知情选择）
  const { manager: manager2 } = newManager(null, dangerousStore)
  await manager2.ensureCommand('docker', ['stop', 'api'], tempRoot)
})

test('getSummary：存在前缀时输出 allowed command prefixes 行', async () => {
  const summaryStore = await writeStore('prefix-summary.json', {
    allowedCommandPrefixes: ['kubectl logs'],
  })

  const { manager } = newManager(null, summaryStore)
  await manager.whenReady()
  const summary = manager.getSummary()
  const line = summary.find(entry => entry.startsWith('allowed command prefixes:'))
  assert.ok(line)
  assert.match(line!, /kubectl logs/)
})

test('deny 从宽：deny_always 签名拦截以它开头的更长变体', async () => {
  const denyWideStore = await writeStore('deny-wide.json', {
    deniedCommandPatterns: ['kubectl delete pod a'],
  })

  const { manager } = newManager(null, denyWideStore)
  // 更长变体（从未直接见过）——词边界前缀命中，拦下
  await assert.rejects(
    () =>
      manager.ensureCommand('kubectl', ['delete', 'pod', 'a', '-n', 'prod'], tempRoot, {
        forcePromptReason: 'guard pipeline',
      }),
    /Command denied/,
  )
})

test('deny 从宽受词边界约束：不同词的兄弟签名不被拦', async () => {
  const denyWideStore = await writeStore('deny-wide-boundary.json', {
    deniedCommandPatterns: ['kubectl delete pod a'],
  })

  const { manager } = newManager(null, denyWideStore)
  // 'pod b' 与 deny 签名逐词不同——不走 deny，转而走审批（无 prompt → requires approval）
  await assert.rejects(
    () =>
      manager.ensureCommand('kubectl', ['delete', 'pod', 'b'], tempRoot, {
        forcePromptReason: 'guard pipeline',
      }),
    /requires approval/,
  )
})

test('deny 从宽压制前缀放行：更长的被拒变体不被 allow 前缀漂白', async () => {
  const interplayStore = await writeStore('deny-vs-prefix.json', {
    allowedCommandPrefixes: ['kubectl delete'],
    deniedCommandPatterns: ['kubectl delete pod a'],
  })

  const { manager } = newManager(null, interplayStore)
  // 'kubectl delete pod a -n prod' 同时命中 allow 前缀（'kubectl delete'）
  // 与 deny 前缀（'kubectl delete pod a'）——deny 判定序在前，必须胜出
  await assert.rejects(
    () =>
      manager.ensureCommand('kubectl', ['delete', 'pod', 'a', '-n', 'prod'], tempRoot, {
        forcePromptReason: 'guard pipeline',
      }),
    /Command denied/,
  )
})

test('session deny_once 保持精确：不扩大到更长变体', async () => {
  const sessionStore = await writeStore('deny-session-exact.json', {})
  const { calls, manager } = newManager(['deny_once', 'allow_once'], sessionStore)

  // 第一次：拒绝一次（落 sessionDeniedCommands，精确签名）
  await assert.rejects(
    () =>
      manager.ensureCommand('node', ['server.js'], tempRoot, {
        forcePromptReason: 'guard pipeline',
      }),
    /Command denied/,
  )

  // 第二次：更长变体不被 session deny 扩大拦截——重新走审批并放行
  await manager.ensureCommand('node', ['server.js', '--port', '2'], tempRoot, {
    forcePromptReason: 'guard pipeline',
  })
  assert.equal(calls.length, 2)
})
