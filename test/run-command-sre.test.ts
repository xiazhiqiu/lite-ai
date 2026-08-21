import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isReadOnlyCommandCall,
} from '../src/tools/run-command.js'
import { isSreReadOnlyCommand, classifySreMutatingCommand, extractUrlFromRequestArgs } from '../src/tools/sre-whitelist.js'

test('isSreReadOnlyCommand: kubectl 只读子命令放行', () => {
  assert.equal(isSreReadOnlyCommand('kubectl', ['get', 'pods']), true)
  assert.equal(isSreReadOnlyCommand('kubectl', ['describe', 'pod', 'nginx']), true)
  assert.equal(isSreReadOnlyCommand('kubectl', ['logs', 'api-server-xxx']), true)
  assert.equal(isSreReadOnlyCommand('kubectl', ['top', 'pods']), true)
  assert.equal(isSreReadOnlyCommand('kubectl', ['explain', 'pods']), true)
  assert.equal(isSreReadOnlyCommand('kubectl', ['diff']), true)
  assert.equal(isSreReadOnlyCommand('kubectl', ['version']), true)
})

test('isSreReadOnlyCommand: kubectl 写子命令拒绝', () => {
  assert.equal(isSreReadOnlyCommand('kubectl', ['scale', 'deploy', 'api', '--replicas=3']), false)
  assert.equal(isSreReadOnlyCommand('kubectl', ['delete', 'pod', 'nginx']), false)
  assert.equal(isSreReadOnlyCommand('kubectl', ['rollout', 'undo', 'deploy/api']), false)
  assert.equal(isSreReadOnlyCommand('kubectl', ['exec', 'pod', '--', 'sh']), false)
  assert.equal(isSreReadOnlyCommand('kubectl', ['apply', '-f', 'manifest.yaml']), false)
})

test('isSreReadOnlyCommand: docker 只读子命令放行', () => {
  assert.equal(isSreReadOnlyCommand('docker', ['ps']), true)
  assert.equal(isSreReadOnlyCommand('docker', ['logs', 'container-xxx']), true)
  assert.equal(isSreReadOnlyCommand('docker', ['stats']), true)
  assert.equal(isSreReadOnlyCommand('docker', ['inspect', 'container-xxx']), true)
  assert.equal(isSreReadOnlyCommand('docker', ['images']), true)
})

test('isSreReadOnlyCommand: docker 写子命令拒绝', () => {
  assert.equal(isSreReadOnlyCommand('docker', ['restart', 'container-xxx']), false)
  assert.equal(isSreReadOnlyCommand('docker', ['rm', 'container-xxx']), false)
  assert.equal(isSreReadOnlyCommand('docker', ['kill', 'container-xxx']), false)
  assert.equal(isSreReadOnlyCommand('docker', ['exec', 'container', 'sh']), false)
  assert.equal(isSreReadOnlyCommand('docker', ['stop', 'container-xxx']), false)
})

test('isSreReadOnlyCommand: curl GET 放行', () => {
  assert.equal(isSreReadOnlyCommand('curl', ['http://host/health']), true)
  assert.equal(isSreReadOnlyCommand('curl', ['-s', 'http://host/metrics']), true)
  assert.equal(isSreReadOnlyCommand('curl', ['-H', 'Accept: json', 'http://host/api']), true)
})

test('isSreReadOnlyCommand: curl 写方法拒绝', () => {
  assert.equal(isSreReadOnlyCommand('curl', ['-X', 'POST', 'http://host/api']), false)
  assert.equal(isSreReadOnlyCommand('curl', ['-X', 'DELETE', 'http://host/api/1']), false)
  assert.equal(isSreReadOnlyCommand('curl', ['-XPUT', 'http://host/api']), false)
  assert.equal(isSreReadOnlyCommand('curl', ['--request', 'PATCH', 'http://host/api']), false)
})

test('isSreReadOnlyCommand: jq/column 纯只读', () => {
  assert.equal(isSreReadOnlyCommand('jq', ['.status']), true)
  assert.equal(isSreReadOnlyCommand('column', ['-t']), true)
})

test('isSreReadOnlyCommand: 非 SRE 命令返回 false', () => {
  assert.equal(isSreReadOnlyCommand('ls', []), false)
  assert.equal(isSreReadOnlyCommand('git', ['status']), false)
  assert.equal(isSreReadOnlyCommand('npm', ['install']), false)
})

test('isReadOnlyCommandCall: kubectl 只读命令可并发', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'kubectl', args: ['get', 'pods'] }), true)
  assert.equal(
    isReadOnlyCommandCall({ command: 'kubectl', args: ['describe', 'pod', 'nginx'] }),
    true,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'kubectl get pods' }),
    true,
  )
})

test('isReadOnlyCommandCall: kubectl 写命令不可并发', () => {
  assert.equal(
    isReadOnlyCommandCall({ command: 'kubectl', args: ['scale', 'deploy', '--replicas=3'] }),
    false,
  )
  assert.equal(isReadOnlyCommandCall({ command: 'kubectl delete pod nginx' }), false)
})

test('isReadOnlyCommandCall: docker 只读命令可并发', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'docker', args: ['ps'] }), true)
  assert.equal(isReadOnlyCommandCall({ command: 'docker logs container-xxx' }), true)
})

test('isReadOnlyCommandCall: curl GET 可并发，POST 不可', () => {
  assert.equal(isReadOnlyCommandCall({ command: 'curl http://host/health' }), true)
  assert.equal(
    isReadOnlyCommandCall({ command: 'curl', args: ['-X', 'POST', 'http://host/api'] }),
    false,
  )
})

test('isReadOnlyCommandCall: 多段命令含 SRE 只读可并发', () => {
  assert.equal(
    isReadOnlyCommandCall({ command: 'kubectl get pods && kubectl get svc' }),
    true,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'kubectl get pods && kubectl scale deploy --replicas=3' }),
    false,
  )
})

test('isReadOnlyCommandCall: 只读管道（含引号内 | 正则）放行', () => {
  // 注：head 可读任意本地文件、需审批，过滤示例改用同为只读过滤段的 sort -u。
  assert.equal(
    isReadOnlyCommandCall({
      command:
        'curl -s "http://localhost:19090/api/v1/label/__name__/values" | tr "," "\\n" | grep -iE "cpu|container|process" | sort -u',
    }),
    true,
  )
  assert.equal(
    isReadOnlyCommandCall({
      command: 'kubectl get pods -n sock-shop | grep -i carts | sort -u',
    }),
    true,
  )
})

test('isReadOnlyCommandCall: 前导 bash -lc 包装的只读命令放行', () => {
  assert.equal(
    isReadOnlyCommandCall({
      command: 'bash -lc curl -s "http://localhost:19200/sock-shop-logs/_count"',
    }),
    true,
  )
  assert.equal(
    isReadOnlyCommandCall({
      command:
        'bash -lc bash -lc curl -s "http://localhost:19090/api/v1/label/__name__/values" | tr "," "\\n" | grep -iE "cpu|container|process" | sort -u',
    }),
    true,
  )
})

test('isReadOnlyCommandCall: 管道内写操作仍拒绝', () => {
  assert.equal(
    isReadOnlyCommandCall({ command: 'curl -X DELETE "http://localhost:19200/sock-shop-logs" | head' }),
    false,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'ls; rm -rf /tmp' }),
    false,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'bash -lc rm -rf /tmp/x' }),
    false,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'curl -s "http://x" > /tmp/f' }),
    false,
  )
  assert.equal(
    isReadOnlyCommandCall({ command: 'echo $(rm -rf /)' }),
    false,
  )
})

test('classifySreMutatingCommand: kubectl 写子命令返回原因', () => {
  const reason = classifySreMutatingCommand('kubectl', ['delete', 'pod', 'nginx'], 'kubectl delete pod nginx')
  assert.ok(reason?.includes('kubectl delete is a mutating operation'))
  assert.equal(
    classifySreMutatingCommand('kubectl', ['get', 'pods'], 'kubectl get pods'),
    null,
  )
})

test('classifySreMutatingCommand: docker 写子命令返回原因', () => {
  assert.ok(
    classifySreMutatingCommand('docker', ['rm', 'c'], 'docker rm c')?.includes(
      'docker rm is a mutating operation',
    ),
  )
  assert.equal(classifySreMutatingCommand('docker', ['ps'], 'docker ps'), null)
})

test('classifySreMutatingCommand: curl 写方法返回原因，GET 不返回', () => {
  assert.ok(
    classifySreMutatingCommand('curl', ['-X', 'POST', 'http://host/api'], 'curl -X POST http://host/api')?.includes(
      'curl -X POST is a mutating HTTP request',
    ),
  )
  assert.ok(
    classifySreMutatingCommand('wget', ['-XPUT', 'http://host/api'], 'wget -XPUT http://host/api')?.includes(
      'wget -X PUT is a mutating HTTP request',
    ),
  )
  assert.equal(classifySreMutatingCommand('curl', ['http://host/health'], 'curl http://host/health'), null)
})

test('extractUrlFromRequestArgs: 提取 curl/wget 目标 URL', () => {
  assert.equal(
    extractUrlFromRequestArgs(['-s', 'http://localhost:19200/sock-shop-logs/_count']),
    'http://localhost:19200/sock-shop-logs/_count',
  )
  assert.equal(extractUrlFromRequestArgs(['-H', 'Accept: json', 'https://host/api']), 'https://host/api')
  assert.equal(extractUrlFromRequestArgs(['-s']), undefined)
})

test('isSreReadOnlyCommand: 命中授权前缀的 GET 放行', () => {
  const prefixes = new Set(['http://localhost:19200', 'http://localhost:19090'])
  assert.equal(
    isSreReadOnlyCommand('curl', ['-s', 'http://localhost:19090/api/v1/label/__name__/values'], prefixes),
    true,
  )
  assert.equal(
    isSreReadOnlyCommand('curl', ['-s', 'http://localhost:19200/sock-shop-logs/_count'], prefixes),
    true,
  )
})

test('isSreReadOnlyCommand: 命中授权前缀的检索型 POST 放行', () => {
  const prefixes = new Set(['http://localhost:19200'])
  assert.equal(
    isSreReadOnlyCommand('curl', ['-X', 'POST', 'http://localhost:19200/sock-shop-logs/_search'], prefixes),
    true,
  )
  assert.equal(
    isSreReadOnlyCommand('curl', ['-XPOST', 'http://localhost:19200/sock-shop-logs/_count'], prefixes),
    true,
  )
})

test('isSreReadOnlyCommand: 非授权前缀的 GET 不放行（fail-closed）', () => {
  const prefixes = new Set(['http://localhost:19200'])
  assert.equal(
    isSreReadOnlyCommand('curl', ['-s', 'http://evil.example/metrics'], prefixes),
    false,
  )
  assert.equal(
    isSreReadOnlyCommand('curl', ['-s', 'http://localhost:19090/api/v1/query'], prefixes),
    false,
  )
})

test('isSreReadOnlyCommand: 授权前缀内写方法仍拒绝', () => {
  const prefixes = new Set(['http://localhost:19200'])
  assert.equal(
    isSreReadOnlyCommand('curl', ['-X', 'DELETE', 'http://localhost:19200/sock-shop-logs'], prefixes),
    false,
  )
  assert.equal(
    isSreReadOnlyCommand('curl', ['-X', 'PUT', 'http://localhost:19200/sock-shop-logs/_doc/1'], prefixes),
    false,
  )
})

test('isReadOnlyCommandCall: 授权前缀放行且跨前缀拦截', () => {
  const prefixes = new Set(['http://localhost:19200', 'http://localhost:19090'])
  assert.equal(
    isReadOnlyCommandCall(
      { command: 'curl -s "http://localhost:19090/api/v1/query" -X POST' },
      prefixes,
    ),
    false,
  )
  // GET 到授权前缀
  assert.equal(
    isReadOnlyCommandCall(
      { command: 'curl -s "http://localhost:19090/api/v1/label/__name__/values"' },
      prefixes,
    ),
    true,
  )
  // GET 到未授权前缀
  assert.equal(
    isReadOnlyCommandCall(
      { command: 'curl -s "http://evil.example/x"' },
      prefixes,
    ),
    false,
  )
})
