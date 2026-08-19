// SRE 只读诊断命令白名单（子命令级白名单，防止 kubectl delete 等写操作误入）。
// 独立成模块以便按命令分组维护；新增数据源（ES 更多端点、pagerduty 等）在此扩展。

// SRE 只读诊断命令集
export const SRE_READONLY_COMMANDS = new Set([
  'kubectl',
  'docker',
  'curl',
  'wget',
  'jq',
  'column',
])

const KUBECTL_READONLY_SUBCOMMANDS = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'diff',
  'version',
])

const DOCKER_READONLY_SUBCOMMANDS = new Set([
  'ps',
  'logs',
  'stats',
  'inspect',
  'version',
  'images',
])

// curl/wget 危险 HTTP 方法（写操作）
const DANGEROUS_HTTP_METHODS = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

/**
 * 判定 SRE 命令是否为只读诊断命令（子命令级白名单）。
 * kubectl/docker 需校验子命令；curl/wget 需校验无写方法；jq/column 纯只读。
 */
export function isSreReadOnlyCommand(command: string, args?: string[]): boolean {
  if (!SRE_READONLY_COMMANDS.has(command)) return false

  if (command === 'kubectl') {
    const sub = args?.[0]
    return sub !== undefined && KUBECTL_READONLY_SUBCOMMANDS.has(sub)
  }

  if (command === 'docker') {
    const sub = args?.[0]
    return sub !== undefined && DOCKER_READONLY_SUBCOMMANDS.has(sub)
  }

  if (command === 'curl' || command === 'wget') {
    // 目标 URL 指向只读检索端点（Elasticsearch 的 _search/_count/_sql 等）时，
    // POST 是只读查询操作，允许放行（ES 检索惯用 POST /_search）。
    const url = args?.find(a => /^https?:\/\//.test(a)) ?? ''
    const isSearchEndpoint =
      /\/_(search|msearch|count|sql|eql|validate)(\/|\?|$)/.test(url)

    // 检查是否含写方法标志（-X POST / --method PUT 等）
    const hasWriteMethod = args?.some((arg, idx) => {
      if (arg === '-X' || arg === '--request') {
        const method = args[idx + 1]?.toUpperCase()
        if (method === 'POST' && isSearchEndpoint) return false
        return method !== undefined && DANGEROUS_HTTP_METHODS.has(method)
      }
      // -XPOST 紧凑形式
      const compact = arg.match(/^-[Xx](\w+)$/)
      if (compact) {
        if (compact[1].toUpperCase() === 'POST' && isSearchEndpoint) return false
        return DANGEROUS_HTTP_METHODS.has(compact[1].toUpperCase())
      }
      return false
    })
    return !hasWriteMethod
  }

  // jq / column 纯只读
  return true
}

// ---- 写操作（mutating）判定 ----
// 与上面的只读白名单互补：只读判定用于放行/并发，写判定用于触发审批。
// kubectl/docker 的子命令与 curl/wget 的 HTTP 方法策略集中在此处维护，
// 作为 kunectl/docker/curl 命令策略的唯一事实来源。

export const SRE_MUTATING_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  kubectl: new Set([
    'scale',
    'delete',
    'rollout',
    'exec',
    'apply',
    'create',
    'edit',
    'patch',
    'replace',
    'cordon',
    'uncordon',
    'drain',
    'taint',
    'annotate',
    'label',
    'port-forward',
    'proxy',
  ]),
  docker: new Set([
    'restart',
    'rm',
    'exec',
    'kill',
    'stop',
    'start',
    'pause',
    'unpause',
    'run',
    'build',
    'push',
    'pull',
    'tag',
    'load',
    'save',
    'import',
    'commit',
    'update',
    'volume',
    'network',
  ]),
}

export const CURL_DANGEROUS_METHODS = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

/**
 * 判定 SRE 命令是否为写操作（kubectl/docker 写子命令、curl/wget 写 HTTP 方法）。
 * 命中时返回审批原因文案（含 signature），供权限层弹窗展示；否则返回 null。
 */
export function classifySreMutatingCommand(
  command: string,
  args: string[],
  signature: string,
): string | null {
  if (command === 'kubectl') {
    const sub = args[0]
    if (sub !== undefined && SRE_MUTATING_SUBCOMMANDS.kubectl?.has(sub)) {
      return `kubectl ${sub} is a mutating operation on cluster resources (${signature})`
    }
  }

  if (command === 'docker') {
    const sub = args[0]
    if (sub !== undefined && SRE_MUTATING_SUBCOMMANDS.docker?.has(sub)) {
      return `docker ${sub} is a mutating operation on containers/images (${signature})`
    }
  }

  if (command === 'curl' || command === 'wget') {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-X' || arg === '--request') {
        const method = args[i + 1]?.toUpperCase()
        if (method !== undefined && CURL_DANGEROUS_METHODS.has(method)) {
          return `${command} -X ${method} is a mutating HTTP request (${signature})`
        }
      }
      const compact = arg.match(/^-[Xx](\w+)$/)
      if (compact && CURL_DANGEROUS_METHODS.has(compact[1].toUpperCase())) {
        return `${command} -X ${compact[1].toUpperCase()} is a mutating HTTP request (${signature})`
      }
    }
  }

  return null
}