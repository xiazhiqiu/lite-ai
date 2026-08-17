/**
 * Mock Kubernetes API server：供真实 kubectl 客户端查询。
 *
 * 从 RE2-SS 数据推导集群状态：
 *   - pod-node CSV → Pod 与 Node（namespace: sock-shop）
 *   - logs.csv     → 每个 Pod 的容器日志（kubectl logs）
 *
 * 实现 kubectl get/describe/logs 所需的最小 REST API 子集（含发现机制），
 * 未实现的端点返回 404 Status，kubectl 可容忍。
 */
import http from 'node:http'
import type { LogEntry, PodPlacement } from './csv.js'

export interface KubernetesOptions {
  pods: PodPlacement[]
  logs: LogEntry[]
  port?: number
  namespace?: string
}

export interface KubernetesInstance {
  server: http.Server
  url: string
  port: number
}

const NAMESPACE = 'sock-shop'

/** Pod 名 → 容器名（logs 中已知容器名的最长前缀匹配） */
function containerForPod(pod: string, containerNames: string[]): string {
  const sorted = [...containerNames].sort((a, b) => b.length - a.length)
  for (const c of sorted) {
    if (pod.startsWith(`${c}-`)) return c
  }
  return pod.split('-')[0]!
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function notFound(res: http.ServerResponse, path: string): void {
  json(res, 404, {
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    message: `the server could not find the requested resource: ${path}`,
    reason: 'NotFound',
    code: 404,
  })
}

export function createKubernetesServer(
  options: KubernetesOptions,
): Promise<KubernetesInstance> {
  return new Promise((resolve) => {
    const { pods, logs, port = 0, namespace = NAMESPACE } = options

    const containerNames = [...new Set(logs.map(l => l.container))].filter(Boolean)
    const nodeNames = [...new Set(pods.map(p => p.node))].filter(Boolean)

    // 每个 Pod 的容器日志
    const logsByPod = new Map<string, LogEntry[]>()
    for (const p of pods) {
      const container = containerForPod(p.pod, containerNames)
      logsByPod.set(p.pod, logs.filter(l => l.container === container))
    }

    const nodeObj = (name: string) => ({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        name,
        labels: { 'kubernetes.io/hostname': name },
        resourceVersion: '1',
        creationTimestamp: '2024-01-18T20:00:00Z',
      },
      spec: {},
      status: {
        phase: 'Running',
        addresses: [{ type: 'InternalIP', address: '10.140.0.1' }],
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'KubeletReady',
            message: 'kubelet is posting ready status',
            lastHeartbeatTime: '2024-01-18T21:30:00Z',
            lastTransitionTime: '2024-01-18T20:00:00Z',
          },
        ],
        capacity: { cpu: '4', memory: '16Gi' },
        allocatable: { cpu: '4', memory: '16Gi' },
      },
    })

    const podObj = (p: PodPlacement, idx: number) => {
      const container = containerForPod(p.pod, containerNames)
      return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: p.pod,
          namespace,
          uid: `mock-uid-${idx}`,
          resourceVersion: '1',
          creationTimestamp: '2024-01-18T20:30:00Z',
          labels: { app: container, 'app.kubernetes.io/name': container },
          ownerReferences: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              name: container,
              uid: `mock-dep-${idx}`,
              controller: true,
            },
          ],
        },
        spec: {
          nodeName: p.node,
          containers: [
            {
              name: container,
              image: `weaveworksdemos/${container}:latest`,
              resources: { limits: { cpu: '1', memory: '1Gi' } },
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
            },
          ],
          dnsPolicy: 'ClusterFirst',
          restartPolicy: 'Always',
          schedulerName: 'default-scheduler',
        },
        status: {
          phase: 'Running',
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              reason: 'ContainersReady',
              message: 'containers with unready status: []',
              lastProbeTime: null,
              lastTransitionTime: '2024-01-18T20:30:30Z',
            },
            { type: 'ContainersReady', status: 'True', lastProbeTime: null },
            { type: 'PodScheduled', status: 'True' },
          ],
          hostIP: '10.140.0.1',
          podIP: `10.24.0.${idx + 10}`,
          podIPs: [{ ip: `10.24.0.${idx + 10}` }],
          startTime: '2024-01-18T20:30:30Z',
          qosClass: 'Burstable',
          containerStatuses: [
            {
              name: container,
              ready: true,
              restartCount: 0,
              image: `weaveworksdemos/${container}:latest`,
              imageID: 'docker://mock',
              containerID: `docker://mock-${idx}`,
              started: true,
              state: { running: { startedAt: '2024-01-18T20:30:30Z' } },
              lastState: {},
            },
          ],
        },
      }
    }

    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      const pathOnly = url.split('?')[0]!

      if (pathOnly === '/' || pathOnly === '/healthz') {
        json(res, 200, { ok: true })
        return
      }

      // 版本
      if (pathOnly === '/version') {
        json(res, 200, {
          major: '1',
          minor: '28',
          gitVersion: 'v1.28.0',
          gitCommit: 'mock',
          gitTreeState: 'clean',
          buildDate: '2024-01-01T00:00:00Z',
          goVersion: 'go1.20',
          compiler: 'gc',
          platform: 'linux/amd64',
        })
        return
      }

      // 核心 API 版本
      if (pathOnly === '/api') {
        json(res, 200, {
          kind: 'APIVersions',
          apiVersion: 'v1',
          versions: ['v1'],
          serverAddressByClientCIDRs: [],
        })
        return
      }

      // 核心 v1 资源列表
      if (pathOnly === '/api/v1') {
        json(res, 200, {
          kind: 'APIResourceList',
          groupVersion: 'v1',
          resources: [
            { name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'pods/log', singularName: '', namespaced: true, kind: 'Pod', verbs: ['get'] },
            { name: 'pods/status', singularName: '', namespaced: true, kind: 'Pod', verbs: ['get', 'patch', 'update'] },
            { name: 'nodes', singularName: 'node', namespaced: false, kind: 'Node', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'namespaces', singularName: 'namespace', namespaced: false, kind: 'Namespace', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'events', singularName: 'event', namespaced: true, kind: 'Event', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'services', singularName: 'service', namespaced: true, kind: 'Service', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'replicationcontrollers', singularName: 'replicationcontroller', namespaced: true, kind: 'ReplicationController', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'configmaps', singularName: 'configmap', namespaced: true, kind: 'ConfigMap', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'secrets', singularName: 'secret', namespaced: true, kind: 'Secret', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'endpoints', singularName: 'endpoints', namespaced: true, kind: 'Endpoints', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'persistentvolumeclaims', singularName: 'persistentvolumeclaim', namespaced: true, kind: 'PersistentVolumeClaim', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'serviceaccounts', singularName: 'serviceaccount', namespaced: true, kind: 'ServiceAccount', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
            { name: 'pods/exec', singularName: '', namespaced: true, kind: 'PodExecOptions', verbs: ['create', 'get'] },
          ],
        })
        return
      }

      // 分组列表
      if (pathOnly === '/apis') {
        json(res, 200, {
          kind: 'APIGroupList',
          apiVersion: 'v1',
          groups: [
            {
              name: 'apps',
              versions: [{ groupVersion: 'apps/v1', version: 'v1' }],
              preferredVersion: { groupVersion: 'apps/v1', version: 'v1' },
            },
            {
              name: 'batch',
              versions: [{ groupVersion: 'batch/v1', version: 'v1' }],
              preferredVersion: { groupVersion: 'batch/v1', version: 'v1' },
            },
            {
              name: 'networking.k8s.io',
              versions: [{ groupVersion: 'networking.k8s.io/v1', version: 'v1' }],
              preferredVersion: { groupVersion: 'networking.k8s.io/v1', version: 'v1' },
            },
            {
              name: 'rbac.authorization.k8s.io',
              versions: [{ groupVersion: 'rbac.authorization.k8s.io/v1', version: 'v1' }],
              preferredVersion: { groupVersion: 'rbac.authorization.k8s.io/v1', version: 'v1' },
            },
          ],
        })
        return
      }

      const apiResourceList = (groupVersion: string, resources: Array<Record<string, unknown>>) =>
        json(res, 200, { kind: 'APIResourceList', groupVersion, resources })

      if (pathOnly === '/apis/apps/v1') {
        apiResourceList('apps/v1', [
          { name: 'deployments', singularName: 'deployment', namespaced: true, kind: 'Deployment', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'replicasets', singularName: 'replicaset', namespaced: true, kind: 'ReplicaSet', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'statefulsets', singularName: 'statefulset', namespaced: true, kind: 'StatefulSet', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'daemonsets', singularName: 'daemonset', namespaced: true, kind: 'DaemonSet', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
        ])
        return
      }
      if (pathOnly === '/apis/batch/v1') {
        apiResourceList('batch/v1', [
          { name: 'jobs', singularName: 'job', namespaced: true, kind: 'Job', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'cronjobs', singularName: 'cronjob', namespaced: true, kind: 'CronJob', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
        ])
        return
      }
      if (pathOnly === '/apis/networking.k8s.io/v1') {
        apiResourceList('networking.k8s.io/v1', [
          { name: 'ingresses', singularName: 'ingress', namespaced: true, kind: 'Ingress', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
        ])
        return
      }
      if (pathOnly === '/apis/rbac.authorization.k8s.io/v1') {
        apiResourceList('rbac.authorization.k8s.io/v1', [
          { name: 'roles', singularName: 'role', namespaced: true, kind: 'Role', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'rolebindings', singularName: 'rolebinding', namespaced: true, kind: 'RoleBinding', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'clusterroles', singularName: 'clusterrole', namespaced: false, kind: 'ClusterRole', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
          { name: 'clusterrolebindings', singularName: 'clusterrolebinding', namespaced: false, kind: 'ClusterRoleBinding', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
        ])
        return
      }

      // ── 具体资源 ──
      const listPod = (name: string | undefined) => {
        const list = name ? pods.filter(p => p.pod === name) : pods
        json(res, 200, {
          kind: 'PodList',
          apiVersion: 'v1',
          metadata: { resourceVersion: '1' },
          items: list.map((p, i) => podObj(p, i)),
        })
      }

      // namespace 列表
      const nsMatch = pathOnly.match(/^\/api\/v1\/namespaces(?:\/([^/]+))?$/)
      if (nsMatch) {
        const name = nsMatch[1]
        if (!name) {
          json(res, 200, {
            kind: 'NamespaceList',
            apiVersion: 'v1',
            metadata: { resourceVersion: '1' },
            items: [
              {
                apiVersion: 'v1',
                kind: 'Namespace',
                metadata: { name: namespace, resourceVersion: '1', creationTimestamp: '2024-01-18T20:00:00Z' },
                status: { phase: 'Active' },
              },
            ],
          })
        } else if (name === namespace) {
          json(res, 200, {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: namespace, resourceVersion: '1', creationTimestamp: '2024-01-18T20:00:00Z' },
            status: { phase: 'Active' },
          })
        } else {
          notFound(res, pathOnly)
        }
        return
      }

      // nodes
      const nodeMatch = pathOnly.match(/^\/api\/v1\/nodes(?:\/([^/]+))?$/)
      if (nodeMatch) {
        const name = nodeMatch[1]
        if (!name) {
          json(res, 200, {
            kind: 'NodeList',
            apiVersion: 'v1',
            metadata: { resourceVersion: '1' },
            items: nodeNames.map(nodeObj),
          })
        } else if (nodeNames.includes(name)) {
          json(res, 200, nodeObj(name))
        } else {
          notFound(res, pathOnly)
        }
        return
      }

      // 命名空间内 pods / pod / logs
      const podMatch = pathOnly.match(
        /^\/api\/v1\/namespaces\/([^/]+)\/pods(?:\/([^/]+))?(?:\/(log|status))?$/,
      )
      if (podMatch) {
        const [, ns, podName, sub] = podMatch
        if (ns !== namespace) {
          notFound(res, pathOnly)
          return
        }
        if (!podName) {
          listPod(undefined)
        } else if (sub === 'log') {
          const entries = logsByPod.get(podName) ?? []
          const lines = entries
            .slice(-500)
            .map(e => `[${new Date(e.timestampNs / 1e6).toISOString()}] ${e.message}`)
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(lines.join('\n'))
        } else if (sub === 'status') {
          const p = pods.find(x => x.pod === podName)
          if (!p) {
            notFound(res, pathOnly)
            return
          }
          json(res, 200, podObj(p, pods.indexOf(p) ))
        } else {
          const p = pods.find(x => x.pod === podName)
          if (!p) {
            notFound(res, pathOnly)
            return
          }
          json(res, 200, podObj(p, pods.indexOf(p) ))
        }
        return
      }

      // 命名空间内空资源（events/services/replicationcontrollers/configmaps/secrets/...）
      const emptyListMatch = pathOnly.match(
        /^\/api\/v1\/namespaces\/([^/]+)\/(events|services|replicationcontrollers|configmaps|secrets|endpoints|persistentvolumeclaims|serviceaccounts|resourcequotas|limitranges)$/,
      )
      if (emptyListMatch) {
        const [, ns, kind] = emptyListMatch
        if (ns !== namespace) {
          notFound(res, pathOnly)
          return
        }
        json(res, 200, {
          kind: `${kind[0]!.toUpperCase()}${kind.slice(1)}List`,
          apiVersion: 'v1',
          metadata: { resourceVersion: '1' },
          items: [],
        })
        return
      }

      // apps/batch 命名空间内空列表
      const appsListMatch = pathOnly.match(
        /^\/apis\/(apps\/v1|batch\/v1|networking\.k8s\.io\/v1)\/namespaces\/([^/]+)\/(deployments|replicasets|statefulsets|daemonsets|jobs|cronjobs|ingresses)$/,
      )
      if (appsListMatch) {
        const [, gv, , kind] = appsListMatch
        json(res, 200, {
          kind: `${kind[0]!.toUpperCase()}${kind.slice(1)}List`,
          apiVersion: gv,
          metadata: { resourceVersion: '1' },
          items: [],
        })
        return
      }

      notFound(res, pathOnly)
    })

    server.listen(port, () => {
      const addr = server.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, url: `http://127.0.0.1:${p}`, port: p })
    })
  })
}