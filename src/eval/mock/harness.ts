/**
 * Mock 数据源 harness：为给定 RE2-SS 场景目录启动
 * Prometheus / Elasticsearch / k8s API server，并注入 KUBECONFIG。
 *
 * 用法：
 *   const src = await startMockSources(scenarioDir)
 *   // ... 让 agent 通过 run_command（curl/kubectl）查询 src.prometheusUrl / src.elasticsearchUrl / kubectl
 *   await src.stop()
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  loadLogs,
  loadMetrics,
  loadPodNodes,
  mergePodNodes,
  type LogEntry,
  type MetricSeries,
} from './csv.js'
import { createPrometheusServer } from './mock-prometheus.js'
import { createElasticsearchServer } from './mock-elasticsearch.js'
import { createKubernetesServer } from './mock-kubernetes.js'

export interface MockSources {
  scenarioDir: string
  prometheusUrl: string
  elasticsearchUrl: string
  k8sUrl: string
  kubeconfigPath: string
  injectTime: number
  series: MetricSeries[]
  logs: LogEntry[]
  stop: () => Promise<void>
}

let kubeconfigDir: string | undefined

async function readTextIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return undefined
  }
}

export async function startMockSources(scenarioDir: string): Promise<MockSources> {
  const metricsCsv = (await readTextIfExists(path.join(scenarioDir, 'metrics.csv'))) ?? ''
  const logsCsv = (await readTextIfExists(path.join(scenarioDir, 'logs.csv'))) ?? ''
  const podNode1 = (await readTextIfExists(path.join(scenarioDir, 'pod-node-1.csv'))) ?? ''
  const podNode2 = (await readTextIfExists(path.join(scenarioDir, 'pod-node-2.csv'))) ?? ''
  const injectTime = Number((await readTextIfExists(path.join(scenarioDir, 'inject_time.txt')))?.trim()) || 0

  const series = loadMetrics(metricsCsv)
  const logs = loadLogs(logsCsv)
  const pods = mergePodNodes(loadPodNodes(podNode1), loadPodNodes(podNode2))

  const prom = await createPrometheusServer({ series })
  const es = await createElasticsearchServer({ entries: logs })
  const k8s = await createKubernetesServer({ pods, logs })

  // 写 kubeconfig 并注入 KUBECONFIG，让 kubectl 指向 mock API server
  kubeconfigDir ??= await mkdtemp(path.join(os.tmpdir(), 'lite-ai-kube-'))
  const kubeconfigPath = path.join(kubeconfigDir, `kubeconfig-${Date.now()}.yaml`)
  const kubeconfig = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- cluster:',
    `    server: ${k8s.url}`,
    '  name: mock',
    'contexts:',
    '- context:',
    '    cluster: mock',
    '    user: mock',
    `    namespace: sock-shop`,
    '  name: mock',
    'current-context: mock',
    'users:',
    '- name: mock',
    '  user:',
    '    token: mock-token',
    '',
  ].join('\n')
  await writeFile(kubeconfigPath, kubeconfig, 'utf8')

  const previousKubeconfig = process.env.KUBECONFIG
  process.env.KUBECONFIG = kubeconfigPath

  return {
    scenarioDir,
    prometheusUrl: prom.url,
    elasticsearchUrl: es.url,
    k8sUrl: k8s.url,
    kubeconfigPath,
    injectTime,
    series,
    logs,
    stop: async () => {
      await Promise.all([
        new Promise<void>(resolve => prom.server.close(() => resolve())),
        new Promise<void>(resolve => es.server.close(() => resolve())),
        new Promise<void>(resolve => k8s.server.close(() => resolve())),
      ])
      if (previousKubeconfig === undefined) {
        delete process.env.KUBECONFIG
      } else {
        process.env.KUBECONFIG = previousKubeconfig
      }
    },
  }
}

export async function cleanupKubeconfigDir(): Promise<void> {
  if (kubeconfigDir) {
    await rm(kubeconfigDir, { recursive: true, force: true })
    kubeconfigDir = undefined
  }
}
