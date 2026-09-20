/**
 * 服务端鉴权（T6）——**共享 API key → userId 解析**，零第三方依赖。
 *
 * ## 为什么不是"一个 secret 一刀切"
 *
 * T3 的 `webhook.secret` 只能回答"你是不是自己人"，回答不了"**你是谁**"。
 * 而 per-user 隔离（甲看不到乙的调查）要求每个请求都带回一个 `userId`。
 * 所以这里的形态是 **key → user 映射表**，而不是单个 secret：
 * 一把 key 换一个身份，验证通过即拿到 `userId`。
 *
 * HolmesGPT 是单一共享 key（`server.py:364-387`：`key != HOLMES_API_KEY` 一刀切），
 * 它没有 per-user 概念。我们比它**多走一步**：验证 + 身份解析合并在一次恒定时间
 * 比较里完成。
 *
 * ## 从 HolmesGPT 抄到的一条安全教训（CVE-2026-48710）
 *
 * 它的豁免路径判定用的是 `request.scope["path"]` 而**不是** `request.url.path`。
 * 原因：后者由 Host 头重建，而 Host 是**攻击者可控**的——伪造 Host 可以让
 * `/healthz` 之类的豁免判定命中错误的路径，从而绕过鉴权。
 *
 * 我们这里的对应物是：**鉴权只吃原始 URL 的 pathname，且匹配是精确相等**
 * （见 `isExemptPath`），不做前缀/后缀模糊匹配、不信任任何转发头。
 * 防御面不同（我们没建 URL 对象），但结论一致：**豁免判定必须窄且确定**。
 */

/**
 * 单个身份的凭据记录。
 *
 * `key` 是明文共享密钥（银行内网形态：由运维下发、轮换，不落到客户端可逆存储）。
 * 之所以不存哈希：与 HolmesGPT 同构的对称共享密钥，服务端必须能拿到原文做比较；
 * 真正的边界是"密钥不出内网 + 传输走 TLS"。
 */
import { timingSafeEqual } from 'node:crypto'

export type ApiKeyEntry = {
  key: string
  userId: string
}

export type AuthConfig = {
  /** key → userId 映射。**空数组 = 不启用鉴权**（仅回环可容忍，见 fail-fast）。 */
  keys: readonly ApiKeyEntry[]
  /**
   * 免鉴权路径（精确匹配）。
   * 默认 `['/healthz', '/readyz']` —— LB / k8s 探针不可能带业务凭证。
   */
  exemptPaths?: readonly string[]
}

/** 鉴权结果：允许则带 `userId`，拒绝则带机器可读的原因（便于测试与审计断言）。 */
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'missing' | 'invalid'; status: 401 }

const DEFAULT_EXEMPT_PATHS: readonly string[] = ['/healthz', '/readyz']

/**
 * 从 `Authorization: Bearer <token>` 或 `X-API-Key: <token>` 提取候选密钥。
 *
 * 两者都接受的理由：前者是 HTTP 标准、浏览器/curl 自然带；后者是很多告警
 * provider 的既有习惯（对齐 HolmesGPT 的 `X-API-Key`）。裸 token 也容忍 ——
 * 内网脚本常直接塞 header，没必要为此 400。
 */
function extractApiKey(headers: Record<string, unknown>): string | null {
  const auth = headers['authorization']
  if (typeof auth === 'string' && auth.length > 0) {
    const raw = auth.startsWith('Bearer ') || auth.startsWith('bearer ')
      ? auth.slice('Bearer '.length)
      : auth
    const token = raw.trim()
    if (token.length > 0) return token
  }

  const apiKey = headers['x-api-key']
  if (typeof apiKey === 'string') {
    const token = apiKey.trim()
    if (token.length > 0) return token
  }

  return null
}

/**
 * 恒定时间比较两个字符串。
 *
 * **为什么不能直接 `===`**：JS 的字符串比较在首个不同字符处提前返回，逐字节的
 * 耗时差可被远程放大成时序侧信道，用来**逐字符猜测密钥**。`timingSafeEqual`
 * 与否决分支配合即可消除。
 *
 * 长度不等时直接返回 false：长度本身不是秘密（密钥长度由运维设定、且远小于
 * 可被猜出的熵），但**不能**在长度相等时短路——那才是真正的泄漏点。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // 长度相等（UTF-8 字节数可能仍不等，如多字节字符）：再核一次字节长度
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * 判定路径是否免鉴权。
 *
 * **精确相等，不做前缀/子串匹配**。这一点至关重要：
 * 若写成 `path.startsWith('/healthz')`，那么 `/healthz/../../chat` 这类
 * 归一化前的路径有概率骗过判定（不同框架归一化时机不同）。精确匹配把
 * 这个歧义彻底消灭——豁免面是一个**有限集合**，不是一个"命名空间"。
 */
export function isExemptPath(
  pathname: string,
  exemptPaths: readonly string[] = DEFAULT_EXEMPT_PATHS,
): boolean {
  return exemptPaths.includes(pathname)
}

/**
 * 校验请求身份。
 *
 * 关键实现细节：**遍历全部 key、不提前 return**。若在第一个匹配处就返回，
 * 那么"命中的 key 排在前面"与"排在后面"的耗时不同——攻击者可用此判断
 * 自己的 key 与哪个位置的前缀重合，进而缩小搜索空间。这里对所有条目
 * 都做一次恒定时间比较，用位或累积结果，最后统一决定。
 *
 * @returns 允许 → `{ ok: true, userId }`；拒绝 → 401，`reason` 区分"没带凭证"
 *          与"凭证不对"（对客户端都回同一个 401 文案，理由只用于服务端审计/测试）。
 */
export function authenticate(
  headers: Record<string, unknown>,
  config: AuthConfig,
): AuthResult {
  const candidate = extractApiKey(headers)
  if (candidate === null) {
    return { ok: false, reason: 'missing', status: 401 }
  }

  // 空 key 表 = 不启用鉴权（仅回环场景，config 层已 fail-fast 拦住非回环）。
  if (config.keys.length === 0) {
    return { ok: false, reason: 'invalid', status: 401 }
  }

  let matchedUserId: string | null = null
  for (const entry of config.keys) {
    // 恒定时间比较；命中后**继续跑完**，用 matchedUserId 收口，避免提前返回。
    if (constantTimeEqual(entry.key, candidate)) {
      matchedUserId = entry.userId
    }
  }

  if (matchedUserId === null) {
    return { ok: false, reason: 'invalid', status: 401 }
  }
  return { ok: true, userId: matchedUserId }
}

/**
 * 从环境变量解析 key 表。
 *
 * 格式：`LITE_AI_API_KEYS="key1:user1,key2:user2"`（逗号分隔、冒号分字段）。
 *
 * 兜底：若只配了单个 `LITE_AI_API_KEY`（无 user 字段），则整把 key 对应
 * `LITE_AI_DEFAULT_USER`（默认 `operator`）。这条兜底是为了兼容 T3 的
 * `webhook.secret` 单密钥形态——老部署升级上来不用改配置也能跑，只是
 * 所有人共用一个身份（per-user 隔离退化成"大家都是一伙的"）。
 *
 * @returns 解析出的 key 表；无任何配置时返回 `[]`（由调用方决定是否 fail-fast）。
 */
export function resolveApiKeysFromEnv(
  env: Record<string, string | undefined>,
): ApiKeyEntry[] {
  const raw = env.LITE_AI_API_KEYS?.trim()
  if (raw !== undefined && raw.length > 0) {
    const entries: ApiKeyEntry[] = []
    for (const part of raw.split(',')) {
      const trimmed = part.trim()
      if (trimmed.length === 0) continue
      // 只切第一个冒号：密钥本身允许含冒号（如 base64 里的 `=` 不会出现在冒号位置，
      // 但为稳妥仍按"首个冒号"分割，避免 user 字段里出现冒号时被误切）。
      const idx = trimmed.indexOf(':')
      if (idx <= 0 || idx === trimmed.length - 1) continue
      const key = trimmed.slice(0, idx).trim()
      const userId = trimmed.slice(idx + 1).trim()
      if (key.length === 0 || userId.length === 0) continue
      entries.push({ key, userId })
    }
    return entries
  }

  const single = env.LITE_AI_API_KEY?.trim()
  if (single !== undefined && single.length > 0) {
    return [{ key: single, userId: env.LITE_AI_DEFAULT_USER?.trim() || 'operator' }]
  }

  return []
}

/**
 * fail-fast 配置校验（对齐 HolmesGPT `server.py:911,918`）。
 *
 * 语义：**绑定非回环地址却没有配置任何 key → 拒绝启动**。
 *
 * 理由：服务端形态下 `/chat` 会触发真实调查（烧 token、可能执行工具），
 * 无鉴权暴露在网络上等于把诊断能力开放给任何人。这里宁可直接起不来，
 * 也不允许"忘了配 key"静默降级成公开服务。
 *
 * @throws 当 `host` 非回环且 `keys` 为空时抛错（错误信息写明如何配置）。
 */
export function assertAuthConfigForBinding(
  host: string,
  keys: readonly ApiKeyEntry[],
): void {
  if (keys.length > 0) return
  if (isLoopbackHost(host)) return
  throw new Error(
    `[serve] 绑定到非回环地址 ${host} 时必须配置 API key，否则拒绝启动（防未授权调查）。` +
      `请设置 LITE_AI_API_KEYS="<key>:<userId>[,...]" 或 LITE_AI_API_KEY=<key>。`,
  )
}

/** 回环地址判定（与 webhook/index.ts:72、server/index.ts:43 同一口径）。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}
