import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  classifySecretAccess,
  evaluateCommandArgv,
  evaluateCommandSnippet,
  findDangerousArgvPrimitive,
  findFileRedirect,
  splitShellSegments,
} from '../src/tools/command-guard.js'

describe('splitShellSegments 引号感知拆段', () => {
  test('简单管道拆两段', () => {
    assert.deepEqual(splitShellSegments('kubectl get pods | grep nginx'), [
      'kubectl get pods',
      'grep nginx',
    ])
  })

  test('引号内的管道不拆（echo "a|b" 是单段）', () => {
    assert.deepEqual(splitShellSegments('echo "a|b"'), ['echo "a|b"'])
  })

  test('&& 与 ; 混合拆段', () => {
    assert.deepEqual(splitShellSegments('git status && git diff; ls'), [
      'git status',
      'git diff',
      'ls',
    ])
  })

  test('未闭合引号返回 null（fail-closed）', () => {
    assert.equal(splitShellSegments('grep "pattern file'), null)
  })

  test('命令替换 $( 返回 null', () => {
    assert.equal(splitShellSegments('echo $(pwd)'), null)
  })

  test('反引号替换返回 null', () => {
    assert.equal(splitShellSegments('echo `pwd`'), null)
  })

  test('子 shell 括号返回 null', () => {
    assert.equal(splitShellSegments('(cd /tmp && ls)'), null)
  })

  test('单引号内的 $ 不触发命令替换判定', () => {
    assert.deepEqual(splitShellSegments("echo '$HOME'"), ["echo '$HOME'"])
  })
})

describe('findFileRedirect 段内重定向', () => {
  test('写重定向命中', () => {
    assert.ok(findFileRedirect('cat a > b.txt'))
    assert.ok(findFileRedirect('ls >> out.log'))
  })

  test('fd 复制 2>&1 放行', () => {
    assert.equal(findFileRedirect('kubectl get pods 2>&1'), null)
    assert.equal(findFileRedirect('cmd >&2'), null)
  })

  test('输入重定向保守命中', () => {
    assert.ok(findFileRedirect('wc -l < file'))
  })

  test('引号内的重定向字符不算', () => {
    assert.equal(findFileRedirect('echo "a > b"'), null)
  })
})

describe('findDangerousArgvPrimitive 参数原语', () => {
  test('find -delete / -exec 命中', () => {
    assert.ok(findDangerousArgvPrimitive('find', ['.', '-name', '*', '-delete']))
    assert.ok(findDangerousArgvPrimitive('find', ['.', '-exec', 'rm', '{}', ';']))
  })

  test('find -name 只读放行', () => {
    assert.equal(findDangerousArgvPrimitive('find', ['.', '-name', '*.log']), null)
  })

  test('sed -i 命中（含粘连形式 -ni）', () => {
    assert.ok(findDangerousArgvPrimitive('sed', ['-i', 's/a/b/', 'f.txt']))
    assert.ok(findDangerousArgvPrimitive('sed', ['-ni', 's/a/b/', 'f.txt']))
    assert.ok(findDangerousArgvPrimitive('sed', ['--in-place', 's/a/b/', 'f.txt']))
  })

  test('sed 普通替换放行', () => {
    assert.equal(findDangerousArgvPrimitive('sed', ['-n', '1,10p', 'f.txt']), null)
  })

  test('sort -o 命中', () => {
    assert.ok(findDangerousArgvPrimitive('sort', ['-o', 'out.txt', 'in.txt']))
    assert.ok(findDangerousArgvPrimitive('sort', ['--output=out.txt', 'in.txt']))
  })

  test('非目标命令不检查', () => {
    assert.equal(findDangerousArgvPrimitive('grep', ['-delete']), null)
  })
})

describe('classifySecretAccess secret 硬拦', () => {
  test('kubectl get secret(s) 命中', () => {
    assert.ok(classifySecretAccess('kubectl', ['get', 'secrets']))
    assert.ok(classifySecretAccess('kubectl', ['get', 'secret', 'db-cred', '-o', 'yaml']))
  })

  test('flag 值不被误认成资源词（-o json secrets 仍命中）', () => {
    assert.ok(classifySecretAccess('kubectl', ['get', '-o', 'json', 'secrets']))
  })

  test('自含 flag 形式不跳资源词', () => {
    assert.ok(classifySecretAccess('kubectl', ['get', '--context=prod', 'secrets']))
  })

  test('secret/name 与逗号组合命中', () => {
    assert.ok(classifySecretAccess('kubectl', ['get', 'secret/db-cred']))
    assert.ok(classifySecretAccess('kubectl', ['get', 'secret,configmap']))
  })

  test('普通资源放行', () => {
    assert.equal(classifySecretAccess('kubectl', ['get', 'pods', '-n', 'prod']), null)
  })

  test('类似词不误伤（secretx 不是 secret）', () => {
    assert.equal(classifySecretAccess('kubectl', ['get', 'secretx']), null)
  })

  test('docker secret 子命令保守全拦', () => {
    assert.ok(classifySecretAccess('docker', ['secret', 'ls']))
  })

  test('docker stop secret 不误伤（sub 是 stop）', () => {
    assert.equal(classifySecretAccess('docker', ['stop', 'secret']), null)
  })
})

describe('evaluateCommandArgv argv 形态判定', () => {
  test('kubectl get secrets → deny', () => {
    const r = evaluateCommandArgv('kubectl', ['get', 'secrets'])
    assert.equal(r.verdict, 'deny')
  })

  test('kubectl get pods → allow', () => {
    assert.equal(evaluateCommandArgv('kubectl', ['get', 'pods']).verdict, 'allow')
  })

  test('find -delete → approval（白名单内命令的危险参数）', () => {
    assert.equal(evaluateCommandArgv('find', ['.', '-delete']).verdict, 'approval')
  })

  test('kubectl delete pod → approval（非只读子命令）', () => {
    assert.equal(evaluateCommandArgv('kubectl', ['delete', 'pod', 'x']).verdict, 'approval')
  })

  test('未知命令 → approval', () => {
    assert.equal(evaluateCommandArgv('zig', ['build']).verdict, 'approval')
  })

  test('git push --force → approval（危险分类器）', () => {
    assert.equal(evaluateCommandArgv('git', ['push', '--force']).verdict, 'approval')
  })

  test('git status → allow', () => {
    assert.equal(evaluateCommandArgv('git', ['status']).verdict, 'allow')
  })

  test('sudo → deny（硬编码封禁）', () => {
    assert.equal(evaluateCommandArgv('sudo', ['rm', '-rf', '/']).verdict, 'deny')
  })
})

describe('evaluateCommandSnippet 片段判定主入口', () => {
  test('全段只读管道 → allow（旧架构会一刀切进审批）', () => {
    assert.equal(evaluateCommandSnippet('kubectl get pods -o wide | grep nginx').verdict, 'allow')
  })

  test('任一段 deny → 整条 deny 且优先于 approval（secret + 重定向）', () => {
    const r = evaluateCommandSnippet('kubectl get secrets > /tmp/out.yaml')
    assert.equal(r.verdict, 'deny')
  })

  test('危险原语 → approval', () => {
    assert.equal(
      evaluateCommandSnippet('find /var/log -name "*.log" -delete').verdict,
      'approval',
    )
  })

  test('重定向 → approval（fd 复制除外）', () => {
    assert.equal(evaluateCommandSnippet('cat a.txt > b.txt').verdict, 'approval')
    assert.equal(evaluateCommandSnippet('kubectl get pods 2>&1 | grep err').verdict, 'allow')
  })

  test('未知命令段 → approval', () => {
    assert.equal(evaluateCommandSnippet('ls | zig build').verdict, 'approval')
  })

  test('解析失败（未闭合引号）→ approval', () => {
    assert.equal(evaluateCommandSnippet('grep "pattern | ls').verdict, 'approval')
  })

  test('git status && git diff → allow', () => {
    assert.equal(evaluateCommandSnippet('git status && git diff').verdict, 'allow')
  })

  test('嵌套 shell 保守转审批', () => {
    assert.equal(evaluateCommandSnippet('bash -c "ls"').verdict, 'approval')
  })
})
