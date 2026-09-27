import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isReadOnlyCommandCall } from '../src/tools/command-guard.js'
import { bashTool } from '../src/tools/bash-tool.js'
import { kubectlTool } from '../src/tools/kubectl-tool.js'
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

describe('bash × command-guard 接线', () => {
  test('deny：kubectl get secrets 直接拒，不触发审批', async () => {
    const { calls, permissions } = makePermissions()
    const result = await bashTool.run(
      { command: 'kubectl get secrets' },
      { cwd, permissions },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /denied by command guard/)
    assert.equal(calls.length, 0)
  })

  test('deny：snippet 中读 secrets 带重定向也拒（deny 优先于 approval）', async () => {
    const { calls, permissions } = makePermissions()
    const result = await bashTool.run(
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
      const result = await bashTool.run(
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
      await bashTool.run({ command: 'ls | zig build' }, { cwd, permissions })
    } catch {
      // 审批后的真实执行在无 bash/无 zig 环境会失败——与本测试无关
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, 'bash')
    assert.deepEqual(calls[0]!.args, ['-lc', 'ls | zig build'])
    assert.match(calls[0]!.forcePromptReason ?? '', /unknown command 'zig'/)
  })

  test('approval：find -delete 转审批且带原语 reason', async () => {
    const { calls, permissions } = makePermissions()
    try {
      await bashTool.run(
        { command: 'find . -name zz-guard-none -delete' },
        { cwd, permissions },
      )
    } catch {
      // 同上：执行层失败与判定无关
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, 'bash')
    assert.deepEqual(calls[0]!.args, ['-lc', 'find . -name zz-guard-none -delete'])
    assert.match(calls[0]!.forcePromptReason ?? '', /-delete/)
  })

  test('approval 被用户拒绝：ensureCommand 抛错 → 工具失败', async () => {
    const { permissions } = makePermissions({ reject: true })
    await assert.rejects(
      () =>
        bashTool.run(
          { command: 'find . -name x -delete' },
          { cwd, permissions },
        ),
      /Command denied/,
    )
  })

  test('无 permissions：kubectl get secrets 被 secret 硬拦（强制只读模式）', async () => {
    const result = await bashTool.run({ command: 'kubectl get secrets' }, { cwd })
    assert.equal(result.ok, false)
    assert.match(result.output, /read-only mode/)
  })

  test('无 permissions：只读白名单命令不被强制只读闸拦截', async () => {
    // 判定层（与环境无关）：白名单命令通过无 permissions 分支使用的同一闸门
    // （bash-tool.ts 强制只读分支即调用 isReadOnlyCommandCall）
    assert.equal(isReadOnlyCommandCall({ command: 'uname' }), true)
    // 端到端：判定层放行后才会走到真实 spawn。执行层结果与本测试无关
    // （Windows PATH 上无 uname → ENOENT；沙箱可能拦 spawn → EPERM），
    // 唯一断言：失败不得来自判定层的 read-only 拒绝。
    try {
      const result = await bashTool.run({ command: 'uname' }, { cwd })
      if (!result.ok) {
        assert.doesNotMatch(result.output, /read-only mode/)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assert.doesNotMatch(message, /read-only mode/)
    }
  })

  test('无 permissions：命令替换保持 fail-closed 拒绝', async () => {
    const result = await bashTool.run({ command: 'echo $(pwd)' }, { cwd })
    assert.equal(result.ok, false)
    assert.match(result.output, /read-only mode/)
  })

  test('kubectl 工具：只读子命令免审批直行', async () => {
    const { calls, permissions } = makePermissions()
    const mod = await import('../src/tools/kubectl-tool.js')
    const origExec = mod.__hooks.kubectlExec
    mod.__hooks.kubectlExec = async () => ({
      stdout: 'NAME READY STATUS',
      stderr: '',
    })
    try {
      const result = await kubectlTool.run(
        { command: 'get pods -n sock-shop' },
        { cwd, permissions },
      )
      assert.equal(result.ok, true)
      assert.match(result.output, /NAME READY/)
    } finally {
      mod.__hooks.kubectlExec = origExec
    }
    assert.equal(calls.length, 0)
  })

  test('kubectl 工具：写子命令转审批（ensureCommand 收到 kubectl + argv）', async () => {
    const { calls, permissions } = makePermissions()
    const mod = await import('../src/tools/kubectl-tool.js')
    const origExec = mod.__hooks.kubectlExec
    mod.__hooks.kubectlExec = async () => ({
      stdout: 'scaled',
      stderr: '',
    })
    try {
      await kubectlTool.run(
        { command: 'scale deploy api --replicas=3' },
        { cwd, permissions },
      )
    } catch {
      // 审批后的真实执行与判定无关
    } finally {
      mod.__hooks.kubectlExec = origExec
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, 'kubectl')
    assert.deepEqual(calls[0]!.args, ['scale', 'deploy', 'api', '--replicas=3'])
    assert.match(calls[0]!.forcePromptReason ?? '', /not in the read-only subcommand set/)
  })

  test('kubectl 工具：secret 硬拦无审批出口', async () => {
    const { calls, permissions } = makePermissions()
    const result = await kubectlTool.run(
      { command: 'get secrets' },
      { cwd, permissions },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /would expose cluster secrets/)
    assert.equal(calls.length, 0)
  })

  test('kubectl 工具：无 permissions 写子命令 fail-closed 拒绝', async () => {
    const result = await kubectlTool.run(
      { command: 'delete pod nginx' },
      { cwd },
    )
    assert.equal(result.ok, false)
    assert.match(result.output, /read-only mode/)
  })
})
