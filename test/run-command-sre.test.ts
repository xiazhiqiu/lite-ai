import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isReadOnlyCommandCall,
} from '../src/tools/run-command.js'
import { isSreReadOnlyCommand } from '../src/tools/sre-whitelist.js'

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
