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

/** 从 curl/wget 参数中提取目标 URL（https:// 或 http:// 开头的参数），用于授权前缀匹配。 */
export function extractUrlFromRequestArgs(args?: string[]): string | undefined {
  return args?.find(a => /^https?:\/\//i.test(a))
}

/**
 * 判定是否为 ES 只读检索端点（_search/_count/_sql 等）。
 * 这类端点的 POST 本质是查询，属只读操作，允许放行。
 */
function isSearchEndpoint(url: string): boolean {
  return /\/_(search|msearch|count|sql|eql|validate)(\/|\?|$)/.test(url)
}

/**
 * 未显式配置授权前缀时，用于 fail-closed 的目标地址黑名单。
 * 拒绝私网 / 回环 / 链路本地 / 云元数据等内网目标，防止 curl/wget 被用于 SSRF 探访内网或读取云厂商 IAM 元数据。
 */
function isBlockedRequestUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return true
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true

  const host = parsed.hostname.toLowerCase()
  // 回环地址（localhost / 127.0.0.1 / ::1）属于运维人员本机，且在数据源工具层面本就可达，予以放行。
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  // 常见云元数据主机名
  if (host === 'metadata' || host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal')) {
    return true
  }
  // IPv6 本地链路 / ULA(唯一本地地址)（回环 ::1 已在上面放行）
  if (host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) {
    return true
  }
  // IPv4 特殊 / 私有地址段（127.0.0.0/8 回环除外，放行）
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const oct = v4.slice(1).map(Number)
    if (oct.some(n => n < 0 || n > 255)) return true
    const [a, b] = oct
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // 10.0.0.0/8 私有
    if (a === 169 && b === 254) return true // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 bench
    return false
  }
  return false
}

/** curl/wget 本地落盘/上传类副作用参数（永不视为只读）。 */
function hasRemoteWriteFlag(args?: string[]): boolean {
  return args?.some(arg =>
    arg === '-o' || arg === '-O' || arg === '-T' ||
    arg.startsWith('--output') || arg.startsWith('--remote-name') || arg.startsWith('--upload-file'),
  ) ?? false
}

/** curl/wget 携带请求体/数据载荷的参数（隐式 POST，仅命中检索端点时视为只读）。 */
function hasRequestBodyFlag(args?: string[]): boolean {
  return args?.some(arg =>
    arg === '-d' || arg === '-F' ||
    arg.startsWith('--data') || arg.startsWith('--form') || arg.startsWith('--json') ||
    arg.startsWith('--post') || arg.startsWith('--body'),
  ) ?? false
}

/**
 * 判定 SRE 命令是否为只读诊断命令（子命令级白名单）。
 * kubectl/docker 需校验子命令；curl/wget 需校验无写方法；jq/column 纯只读。
 *
 * @param allowedUrlPrefixes 可选：已授权只读数据源的 URL 前缀白名单。
 *   提供时，curl/wget 的目标 URL 必须先命中任一前缀才会被放行（fail-closed），
 *   防止"GET 到任意内网地址"也被静默放行。
 */
export function isSreReadOnlyCommand(
  command: string,
  args?: string[],
  allowedUrlPrefixes?: Iterable<string>,
): boolean {
  if (!SRE_READONLY_COMMANDS.has(command)) return false

  if (command === 'kubectl') {
    const sub = args?.[0]
    if (sub === undefined || !KUBECTL_READONLY_SUBCOMMANDS.has(sub)) return false
    // 敏感资源类型（Secret/ConfigMap 等）禁止只读放行，须走审批（避免 base64 凭据回灌给模型）。
    if (sub === 'get') {
      // 跳过子命令自身，取资源类型参数（如 'secrets' / 'secret my-secret' / 'svc,secrets'）。
      const resource = args?.slice(1).find(a => !a.startsWith('-'))
      if (resource && /(^|[\/\s,])secrets?($|[\/\s,])|(^|[\/\s,])configmaps?($|[\/\s,])/i.test(resource)) {
        return false
      }
    }
    return true
  }

  if (command === 'docker') {
    const sub = args?.[0]
    return sub !== undefined && DOCKER_READONLY_SUBCOMMANDS.has(sub)
  }

  if (command === 'curl' || command === 'wget') {
    const url = extractUrlFromRequestArgs(args)
    if (!url) return false

    // 若配置了授权前缀，目标 URL 必须先命中其一（普通 GET 也不能跨前缀放行）。
    if (allowedUrlPrefixes) {
      let hit = false
      for (const prefix of allowedUrlPrefixes) {
        if (url.startsWith(prefix)) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
    // 未显式配置授权前缀时，fail-closed：拒绝私网/回环/链路本地/云元数据等内网目标（防 SSRF）。
    else if (isBlockedRequestUrl(url)) {
      return false
    }

    // 本地落盘/上传类副作用参数（-o/-O/-T/--output/--upload-file 等）永不视为只读。
    if (hasRemoteWriteFlag(args)) return false

    const searchEndpoint = isSearchEndpoint(url)

    // 携带请求体/数据载荷（-d/--data/--form/--json 等，隐式 POST）：
    // 仅当命中只读检索端点时视为只读，否则判定为非只读写请求。
    if (hasRequestBodyFlag(args) && !searchEndpoint) return false

    // 检查是否含显式写方法标志（-X POST / --method PUT / -XPOST 紧凑形式）
    const hasWriteMethod = args?.some((arg, idx) => {
      if (arg === '-X' || arg === '--request') {
        const method = args[idx + 1]?.toUpperCase()
        if (method === 'POST' && searchEndpoint) return false
        return method !== undefined && DANGEROUS_HTTP_METHODS.has(method)
      }
      // -XPOST 紧凑形式
      const compact = arg.match(/^-[Xx](\w+)$/)
      if (compact) {
        if (compact[1].toUpperCase() === 'POST' && searchEndpoint) return false
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