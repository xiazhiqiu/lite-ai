/**
 * 多源告警适配器测试（T1 + T2）。
 *
 * 重点验证三件事：
 * 1. 每个源能被**正确识别**（尤其 Grafana 与 Alertmanager 的结构重叠 + generic 兜底不抢）。
 * 2. 每个源被**正确归一化**为统一 Alert（含 source 字段、severity 词表映射、状态映射）。
 * 3. **关联层对来源盲**——不同源吐出的 Alert 形状一致，可直接进 The correlation pipeline。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alertmanagerAdapter,
  genericAdapter,
  grafanaAdapter,
  opsgenieAdapter,
  pagerdutyAdapter,
  routeAlertSource,
} from '../src/webhook/sources/index.js'
import { normalizeSeverity, severityWeight } from '../src/webhook/types.js'

// ---------------------------------------------------------------- fixtures

const alertmanagerPayload = {
  status: 'firing',
  receiver: 'am-webhook',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'DiskFull', severity: 'critical', instance: 'a:9100' },
      annotations: { summary: 'disk almost full', description: 'mount=/data' },
      startsAt: '2026-09-17T10:00:00Z',
    },
    {
      // resolved 应被过滤
      status: 'resolved',
      labels: { alertname: 'AlreadyGone', severity: 'warning' },
      annotations: {},
      startsAt: '2026-09-17T10:01:00Z',
    },
  ],
}

const grafanaPayload = {
  orgId: 1,
  receiver: 'grafana-webhook',
  status: 'firing',
  title: '[FIRING:1] Payment alert',
  alerts: [
    {
      status: 'alerting',
      labels: { alertname: 'PodCrashLoop', severity: 'critical', grafana_folder: 'Prod' },
      annotations: { summary: 'pod restarting' },
      startsAt: '2026-09-17T10:05:00Z',
      valueString: '[ metric=restarts labels={pod=pay-1} value=12 ]',
    },
    {
      // Grafana 的恢复态是 ok，应被过滤
      status: 'ok',
      labels: { alertname: 'RecoveredOne' },
      annotations: {},
      startsAt: '2026-09-17T10:06:00Z',
    },
  ],
}

const pagerdutyV2 = {
  messages: [
    {
      id: 'msg-1',
      event: 'incident.trigger',
      incident: {
        id: 'PABC',
        incident_number: 12, // 注意：真实 payload 里是数字
        title: 'MySQL replication broken',
        description: 'Slave lag > 300s',
        status: 'triggered',
        created_on: '2026-09-17T10:10:00Z',
        html_url: 'https://acme.pagerduty.com/incidents/PABC',
        service: { id: 'SVC1', name: 'payments' },
        urgency: 'high',
      },
    },
  ],
}

const pagerdutyV3 = {
  event: { id: 'evt-1', event_type: 'incident.triggered' },
  incident: {
    id: 'PXYZ',
    title: 'API error rate spike',
    severity: 'critical',
    status: 'triggered',
    created_on: '2026-09-17T10:11:00Z',
    service: { id: 'SVC2', name: 'api-gateway' },
  },
}

const opsgeniePayload = {
  action: 'Create',
  integrationName: 'prod-integration',
  alert: {
    alertId: 'A1',
    message: 'Listen queue size is high',
    status: 'open',
    priority: 'P1',
    entity: 'mailserver-a',
    tags: ['queue_size', 'overload'],
    details: { 'current size': 90000, 'max size': 20000 },
    createdAt: '2026-09-17T10:20:00Z',
    alertUrl: 'https://app.opsgenie.com/alert/A1',
  },
}

const businessAlert = {
  alertname: 'OrderSuccessRateDrop',
  severity: 'warning',
  summary: 'success rate dropped 20% in 5m',
  labels: { service: 'orders', env: 'prod' },
  startsAt: '2026-09-17T10:30:00Z',
  source: 'business-monitor',
}

// ---------------------------------------------------------------- T2: 识别与路由

test('routeAlertSource: 各源按注册顺序正确命中', () => {
  assert.equal(routeAlertSource(grafanaPayload).name, 'grafana')
  assert.equal(routeAlertSource(pagerdutyV2).name, 'pagerduty')
  assert.equal(routeAlertSource(pagerdutyV3).name, 'pagerduty')
  assert.equal(routeAlertSource(opsgeniePayload).name, 'opsgenie')
  assert.equal(routeAlertSource(alertmanagerPayload).name, 'alertmanager')
  assert.equal(routeAlertSource(businessAlert).name, 'generic')
})

test('generic 不抢占：有 alerts 数组的 payload 不属于它', () => {
  assert.equal(genericAdapter.matches(alertmanagerPayload), false)
  assert.equal(genericAdapter.matches(grafanaPayload), false)
})

test('grafana 与 alertmanager 靠 orgId 区分（结构高度重叠）', () => {
  // 无 orgId → 不是 grafana，落 alertmanager
  assert.equal(grafanaAdapter.matches(alertmanagerPayload), false)
  // 有 orgId 且有 alerts 数组 → grafana 且排在 alertmanager 之前
  assert.equal(grafanaAdapter.matches(grafanaPayload), true)
  assert.equal(alertmanagerAdapter.matches(grafanaPayload), true) // 重叠证明：顺序才决定归属
  assert.equal(routeAlertSource(grafanaPayload).name, 'grafana')
})

test('routeAlertSource: 无法识别的 payload 抛错', () => {
  assert.throws(() => routeAlertSource({ nobody: 'knows me' }), /无法识别告警源/)
  assert.throws(() => routeAlertSource(null), /无法识别告警源/)
  assert.throws(() => routeAlertSource([1, 2, 3]), /无法识别告警源/)
})

// ---------------------------------------------------------------- T2: 字段映射

test('alertmanager: firing 原样透传 + startsAt 不归一化；resolved 如实标注', () => {
  const alerts = alertmanagerAdapter.parse(alertmanagerPayload)
  assert.equal(alerts.length, 2)
  const a = alerts[0]!
  assert.equal(a.title, 'DiskFull')
  assert.equal(a.severity, 'critical')
  assert.equal(a.source, 'alertmanager')
  assert.equal(a.description, 'mount=/data')
  assert.equal(a.summary, 'disk almost full')
  assert.equal(a.status, 'firing')
  assert.equal(a.startsAt, '2026-09-17T10:00:00Z') // 既有行为：原样透传不归一化
  assert.deepEqual(a.labels, { alertname: 'DiskFull', severity: 'critical', instance: 'a:9100' })

  // T6：resolved 不再在适配器层丢弃，而是如实标注状态，交由管道收敛（不触发 RCA）。
  const recovered = alerts[1]!
  assert.equal(recovered.title, 'AlreadyGone')
  assert.equal(recovered.status, 'resolved')
})

test('grafana: alerting/ok 状态映射 + valueString 兜底为描述', () => {
  const alerts = grafanaAdapter.parse(grafanaPayload)
  assert.equal(alerts.length, 2)
  const a = alerts[0]!
  assert.equal(a.title, 'PodCrashLoop')
  assert.equal(a.severity, 'critical')
  assert.equal(a.source, 'grafana')
  assert.equal(a.status, 'firing')
  assert.match(a.description, /metric=restarts/)
  assert.ok(a.startsAt.startsWith('2026-09-17T10:05'))
  // Grafana 的恢复态是 ok → resolved（T6：不再丢弃）
  assert.equal(alerts[1]!.title, 'RecoveredOne')
  assert.equal(alerts[1]!.status, 'resolved')
})

test('pagerduty v2: urgency 映射 severity + 数字 incident_number 保留', () => {
  const alerts = pagerdutyAdapter.parse(pagerdutyV2)
  assert.equal(alerts.length, 1)
  const a = alerts[0]!
  assert.equal(a.title, 'MySQL replication broken')
  assert.equal(a.severity, 'error') // urgency=high → error
  assert.equal(a.source, 'pagerduty')
  assert.equal(a.labels.service, 'payments')
  assert.equal(a.labels.urgency, 'high')
  assert.equal(a.labels.incident_number, '12') // 数字被转成字符串而非丢弃
  assert.match(a.description, /https:\/\/acme\.pagerduty\.com/)
  assert.ok(a.startsAt.startsWith('2026-09-17T10:10'))
})

test('pagerduty v3: 单事件形态 + severity 字段优先于 urgency', () => {
  const alerts = pagerdutyAdapter.parse(pagerdutyV3)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]!.severity, 'critical')
  assert.equal(alerts[0]!.labels.service, 'api-gateway')
})

test('pagerduty: resolved 事件如实标注（T6：不再丢弃）', () => {
  const body = {
    messages: [
      { id: 'm', event: 'incident.resolve', incident: { id: 'P1', title: 'done', status: 'resolved', service: { name: 's' } } },
    ],
  }
  const alerts = pagerdutyAdapter.parse(body)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]!.status, 'resolved')
})

test('opsgenie: P1→critical + tags 转 labels + Close 动作视为恢复', () => {
  const alerts = opsgenieAdapter.parse(opsgeniePayload)
  assert.equal(alerts.length, 1)
  const a = alerts[0]!
  assert.equal(a.title, 'Listen queue size is high')
  assert.equal(a.severity, 'critical') // P1
  assert.equal(a.source, 'opsgenie')
  assert.equal(a.labels.queue_size, 'true')
  assert.equal(a.labels.overload, 'true')
  assert.equal(a.labels.entity, 'mailserver-a')
  assert.match(a.description, /current size=90000/)
  assert.match(a.description, /app\.opsgenie\.com/)

  // T6：Close 动作 → resolved，如实标注后交由管道收敛（不再丢弃）
  const closing = { ...opsgeniePayload, action: 'Close' }
  const closed = opsgenieAdapter.parse(closing)
  assert.equal(closed.length, 1)
  assert.equal(closed[0]!.status, 'resolved')
})

test('opsgenie: P3/P5 优先级映射正确', () => {
  const at = (priority: string) =>
    opsgenieAdapter.parse({
      action: 'Create',
      alert: { message: 'x', priority, status: 'open' },
    })[0]!.severity
  assert.equal(at('P3'), 'warning')
  assert.equal(at('P5'), 'info')
})

test('generic: 单对象解析 + source 可覆盖 + tags 数组支持', () => {
  const alerts = genericAdapter.parse(businessAlert)
  assert.equal(alerts.length, 1)
  const a = alerts[0]!
  assert.equal(a.title, 'OrderSuccessRateDrop')
  assert.equal(a.severity, 'warning')
  assert.equal(a.source, 'business-monitor') // payload 自带 source 优先
  assert.equal(a.labels.service, 'orders')

  const tagged = genericAdapter.parse({ title: 'CacheMissSpike', tags: ['cache', 'redis'] })
  assert.equal(tagged[0]!.source, 'generic') // 缺省回落
  assert.equal(tagged[0]!.labels.cache, 'true')
  assert.equal(tagged[0]!.labels.redis, 'true')
})

test('generic: resolved 单条如实标注（T6：不再丢弃）', () => {
  const alerts = genericAdapter.parse({ alertname: 'X', status: 'resolved' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]!.status, 'resolved')
})

// ---------------------------------------------------------------- T1: severity 归一化

test('normalizeSeverity: 多源外来词表映射到标准词', () => {
  assert.equal(normalizeSeverity('disaster'), 'critical') // Zabbix
  assert.equal(normalizeSeverity('average'), 'warning') // Zabbix
  assert.equal(normalizeSeverity('ALARM'), 'error') // CloudWatch（大小写不敏感）
  assert.equal(normalizeSeverity('P3'), 'warning') // Opsgenie
})

test('normalizeSeverity: 已识别别名保持原样（不改动既有 Alertmanager 路径权重）', () => {
  for (const raw of ['critical', 'error', 'warning', 'info', 'high', 'medium', 'p1', 'p2', 'sev1']) {
    assert.equal(normalizeSeverity(raw), raw)
    assert.equal(severityWeight(normalizeSeverity(raw)), severityWeight(raw))
  }
})

test('normalizeSeverity: 外来词归一化后权重确实提升（原本会落到默认 2）', () => {
  assert.equal(severityWeight('disaster'), 2) // 归一化前：落到默认值
  assert.equal(severityWeight(normalizeSeverity('disaster')), 4)
})

// ---------------------------------------------------------------- 关联层对来源盲

test('不同源吐出的 Alert 形状一致，可直接进关联管线', () => {
  const all = [
    ...alertmanagerAdapter.parse(alertmanagerPayload),
    ...grafanaAdapter.parse(grafanaPayload),
    ...pagerdutyAdapter.parse(pagerdutyV2),
    ...opsgenieAdapter.parse(opsgeniePayload),
    ...genericAdapter.parse(businessAlert),
  ]
  // alertmanager / grafana 各多带 1 条 resolved（T6 起不再在适配器层丢弃）
  assert.equal(all.length, 7)
  for (const a of all) {
    assert.ok(a.id.length > 0, 'id 不能为空')
    assert.ok(a.title.length > 0)
    assert.ok(typeof a.startsAt === 'string' && a.startsAt.length > 0)
    assert.ok(
      a.status === 'firing' || a.status === 'resolved',
      `status 必须是 firing/resolved 二态之一: ${a.status}`,
    )
    assert.equal(typeof a.labels, 'object')
    assert.ok(a.source && a.source.length > 0, `source 必须标记: ${a.title}`)
  }
  const firing = all.filter(a => a.status === 'firing')
  assert.equal(firing.length, 5) // 每个源各贡献 1 条 firing 告警
  assert.deepEqual(
    firing.map(a => a.source),
    ['alertmanager', 'grafana', 'pagerduty', 'opsgenie', 'business-monitor'],
  )
  assert.equal(all.filter(a => a.status === 'resolved').length, 2)
})
