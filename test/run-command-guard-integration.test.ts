import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isReadOnlyCommandCall } from '../src/tools/command-guard.js'
import { runCommandTool } from '../src/tools/run-command.js'
import type { PermissionManager } from '../src/permissions.js'

const cwd = process.cwd()

type EnsureCall = {
  command: string
  args: string[]
  forcePromptReason?: string
}

function makePermissions(options?: { reject?: boolean }) {
  const calls: EnsureCall[] = []
  const permissions = {
    ensureCommand: async (
      command: string,
      args: string[],
      _cwd: string,
      opts?: { forcePromptReason?: string },
    ) => {
      calls.push({
        command,
        args,
        forcePromptReason: opts?.forcePromptReason,
      })
      if (options?.reject) {
        throw new Error(`Command denied: ${command}`)
      }
    },
  }
  return {
    calls,
    permissions: permissions as unknown as PermissionManager,
  }
}

describe('run_command × command-guard 接线', () => {
  test('deny：kubectl get secrets 直接拒，不触发审批', async () => {
    const { calls, permissions } = makePermissions()
    const result = await runCommandTool.run(
      { command: 'kubectl get secrets' },
      { cwd, permissions },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /denied by command guard/)
    assert.equal(calls.length, 0)
  })

  test('deny：snippet 中读 secrets 带重定向也拒（deny 优先于 approval）', async () => {
    const { calls, permissions } = makePermissions()
    const result = await runCommandTool.run(
      { command: 'kubectl get secrets > out.yaml' },
      { cwd, permissions },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /would expose cluster secrets/)
    assert.equal(calls.length, 0)
  })

  test('allow：全段只读管道免审批（不触发 ensureCommand）', async () => {
    const { calls, permissions } = makePermissions()
    try {
      const result = await runCommandTool.run(
        { command: 'echo hello | grep hello' },
        { cwd, permissions },
      )
      assert.equal(result.ok, true)
    } catch {
      // Windows 无 bash 时执行层 ENOENT——判定层行为已由下方断言验证
    }
    assert.equal(calls.length, 0)
  })

  test('approval：未知第二段转审批（ensureCommand 收到 bash -lc 整条 + 管线 reason）', async () => {
    const { calls, permissions } = makePermissions()
    try {
      await runCommandTool.run({ command: 'ls | zig build' }, { cwd, permissions })
    } catch {
      // 审批后的真实执行在无 bash/无 zig 环境会失败——与本测试无关
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, 'bash')
    assert.deepEqual(calls[0]!.args, ['-lc', 'ls | zig build'])
    assert.match(calls[0]!.forcePromptReason ?? '', /unknown command 'zig'/)
  })

  test('approval：find -delete（argv 形态）转审批且带原语 reason', async () => {
    const { calls, permissions } = makePermissions()
    try {
      await runCommandTool.run(
        { command: 'find', args: ['.', '-name', 'zz-guard-none', '-delete'] },
        { cwd, permissions },
      )
    } catch {
      // 同上：执行层失败与判定无关
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, 'find')
    assert.match(calls[0]!.forcePromptReason ?? '', /-delete/)
  })

  test('approval 被用户拒绝：ensureCommand 抛错 → 工具失败', async () => {
    const { permissions } = makePermissions({ reject: true })
    await assert.rejects(
      () =>
        runCommandTool.run(
          { command: 'find', args: ['.', '-name', 'x', '-delete'] },
          { cwd, permissions },
        ),
      /Command denied/,
    )
  })

  test('无 permissions：kubectl get secrets 被 secret 硬拦（强制只读模式）', async () => {
    const result = await runCommandTool.run({ command: 'kubectl get secrets' }, { cwd })
    assert.equal(result.ok, false)
    assert.match(result.output, /read-only mode/)
  })

  test('无 permissions：只读白名单命令不被强制只读闸拦截', async () => {
    // 判定层（与环境无关）：白名单命令通过无 permissions 分支使用的同一闸门
    // （run-command.ts 强制只读分支即调用 isReadOnlyCommandCall）
    assert.equal(isReadOnlyCommandCall({ command: 'uname', args: [] }), true)
    // 端到端：判定层放行后才会走到真实 spawn。执行层结果与本测试无关
    // （Windows PATH 上无 uname → ENOENT；沙箱可能拦 spawn → EPERM），
    // 唯一断言：失败不得来自判定层的 read-only 拒绝。
    try {
      const result = await runCommandTool.run({ command: 'uname' }, { cwd })
      if (!result.ok) {
        assert.doesNotMatch(result.output, /read-only mode/)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assert.doesNotMatch(message, /read-only mode/)
    }
  })

  test('无 permissions：管道命令保持 fail-closed 拒绝', async () => {
    const result = await runCommandTool.run({ command: 'echo a | grep a' }, { cwd })
    assert.equal(result.ok, false)
    assert.match(result.output, /read-only mode/)
  })
})
