/**
 * command-guard：run_command 免审批/审批/硬拒的三态判定管线（纯函数，无 IO）。
 *
 * 分层职责（对齐 HolmesGPT：通用底座 + 命令域判定器）：
 * - 本模块只做「命令字符串 → 三态判定」：allow（免审批）/ approval（转审批）/ deny（硬拒）。
 * - 权限底座（三层名单、审批回调、fail-closed 硬拒）仍在 permissions.ts，互不依赖执行层。
 * - 并发只读判定（isReadOnlyCommandCall）自 run-command.ts 迁入：同属命令字符串判定，
 *   且复用同一套白名单集合，避免两处名单漂移。
 *
 * fail-closed 原则：任何无法 100% 确认安全的输入（未闭合引号、子 shell、命令替换、
 * 未知命令）一律不给 allow——宁可多一次审批，不可漏放一次。
 */

import { classifyDangerousCommand } from '../permissions.js'

// ---------------------------------------------------------------------------
// 白名单集合（自 run-command.ts 迁入，语义不变）
// ---------------------------------------------------------------------------

// Claude Code separates "read-only shell commands" from mutating/runtime commands.
// We keep the same shape here so safe observability commands are easy to extend.
export const READONLY_COMMANDS = new Set([
  'pwd',
  'ls',
  'find',
  'rg',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'sed',
  'echo',
  'df',
  'du',
  'free',
  'uname',
  'uptime',
  'whoami',
])

export const DEVELOPMENT_COMMANDS = new Set([
  'git',
  'npm',
  'node',
  'python3',
  'pytest',
  'bash',
  'sh',
  'bun',
])

// SRE 只读诊断命令集（子命令级白名单，防止 kubectl delete 等写操作误入）
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

export function isAllowedCommand(command: string): boolean {
  return (
    READONLY_COMMANDS.has(command) ||
    DEVELOPMENT_COMMANDS.has(command) ||
    SRE_READONLY_COMMANDS.has(command)
  )
}

export function isReadOnlyCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command)
}

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

// 并发安全只读命令白名单（保守集，不含 sed/vim 等可写工具）。
// 与上层 READONLY_COMMANDS 解耦：该集合仅供并发准入判断，
// 而并发的只读判定必须排除一切可能写盘的命令。
const CONCURRENT_READONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'echo',
  'pwd',
  'which',
  'date',
  'env',
  'whoami',
  'uname',
  'df',
  'du',
  'free',
  'uptime',
])

const CONCURRENT_READONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
])

// 若命令含这些字符，判定为可能写盘/副作用，不得并行。
const DANGEROUS_PATTERN = /[><&$`|;]/

function hasDangerousToken(token: string): boolean {
  return DANGEROUS_PATTERN.test(token)
}

/**
 * 判定一次 run_command 调用实例是否可并发执行（只读）。
 * fail-closed：任何无法 100% 确认只读的情况都返回 false。
 * - 带 args 数组：command 为 argv0，args 为 argv1..；仅白名单命令 + git 只读子命令通过。
 * - 单字符串 command：按 shell 分隔符拆段，逐段校验 argv0 与危险符号。
 * 绝不复用 isReadOnlyCommand（其白名单含 sed）。
 */
export function isReadOnlyCommandCall(input: {
  command: string
  args?: string[]
}): boolean {
  const trimmed = input.command.trim()
  if (!trimmed) return false

  if ((input.args?.length ?? 0) > 0) {
    return isReadOnlyArgv(trimmed, input.args!)
  }

  return isReadOnlySnippet(trimmed)
}

function isReadOnlyArgv(argv0: string, args: string[]): boolean {
  if (args.some(hasDangerousToken)) return false

  if (argv0 === 'git') {
    const sub = args[0]
    return sub !== undefined && CONCURRENT_READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  // SRE 只读诊断命令（kubectl get/logs、docker ps/logs、curl GET 等）
  if (isSreReadOnlyCommand(argv0, args)) return true

  return CONCURRENT_READONLY_COMMANDS.has(argv0)
}

function isReadOnlySnippet(command: string): boolean {
  // 拆成 shell 段（| & && || ; 各自成段），但若是命令替换/重定向等，直接拒。
  const segments = command
    .split(/(&&|\|\||[|;])/g)
    .map(segment => segment.trim())
    .filter(Boolean)

  for (const segment of segments) {
    if (segment === '&&' || segment === '||' || segment === '|' || segment === ';') {
      continue
    }
    if (!isReadOnlySegment(segment)) {
      return false
    }
  }
  return true
}

function isReadOnlySegment(segment: string): boolean {
  // 重定向 / 命令替换 / 后台符 / 子 shell —— 一律非只读
  if (hasDangerousToken(segment)) return false

  const [argv0, ...argv] = splitCommandLine(segment)
  if (!argv0) return false

  if (argv0 === 'git') {
    const sub = argv[0]
    return sub !== undefined && CONCURRENT_READONLY_GIT_SUBCOMMANDS.has(sub)
  }

  // SRE 只读诊断命令
  if (isSreReadOnlyCommand(argv0, argv)) return true

  return CONCURRENT_READONLY_COMMANDS.has(argv0)
}

/**
 * 把一行命令切分为 argv：感知引号与反斜杠转义，引号内空白不分词。
 * 自 run-command.ts 迁入，语义不变。
 */
export function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of commandLine) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (escaping) {
    current += '\\'
  }

  if (current.length > 0) {
    parts.push(current)
  }

  return parts
}

// ---------------------------------------------------------------------------
// 五级判定管线（新增）：拆段 → secret 硬拦 → argv 原语 → 段级白名单 → 三态汇总
// ---------------------------------------------------------------------------

export type GuardVerdict = 'allow' | 'approval' | 'deny'

export type GuardResult = {
  verdict: GuardVerdict
  reason?: string
}

const VERDICT_RANK: Record<GuardVerdict, number> = {
  allow: 0,
  approval: 1,
  deny: 2,
}

function escalate(a: GuardResult, b: GuardResult): GuardResult {
  if (VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict]) return b
  if (VERDICT_RANK[b.verdict] < VERDICT_RANK[a.verdict]) return a
  return a.reason ? a : b
}

/** 硬编码封禁（对齐 HolmesGPT config.py HARDCODED_BLOCKS）：提权即拒，无审批出口。 */
const HARDCODED_BLOCKS = new Set(['sudo', 'su'])

/**
 * 引号感知的 shell 拆段：引号外的 && || | ; 才是分隔符。
 * 返回 null 表示「无法安全拆段」——未闭合引号、子 shell ( )、命令替换
 * $( 与反引号、独立后台符 &。调用方必须把 null 当作 approval（fail-closed）。
 */
export function splitShellSegments(command: string): string[] | null {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  const push = (): void => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (escaping) {
      current += char
      escaping = false
      continue
    }

    // 单引号内无转义；双引号内与引号外反斜杠生效。转义字符保留原样，
    // 由 splitCommandLine 在段内再次解析。
    if (char === '\\' && quote !== "'") {
      escaping = true
      current += char
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push()
      i++
      continue
    }
    if (char === '|' || char === ';') {
      push()
      continue
    }
    if (char === '&') {
      // >&N 的 fd 复制上下文（如 2>&1）放行；独立后台符不可安全拆段。
      // 写向文件的 >&file 由 findFileRedirect 再判（& 后非数字）。
      let j = current.length - 1
      while (j >= 0 && current[j] === ' ') j--
      if (current[j] === '>') {
        current += char
        continue
      }
      return null
    }
    if (char === '(' || char === ')' || char === '`') return null
    if (char === '$' && command[i + 1] === '(') return null
    current += char
  }

  if (quote) return null
  push()
  return segments.length > 0 ? segments : null
}

/**
 * 段内引号外的文件重定向扫描。`2>&1` / `>&2` 这类 fd 复制放行；
 * `>` `>>`（写/追加文件）与 `<` `<<`（输入/heredoc，保守）返回描述。
 */
export function findFileRedirect(segment: string): string | null {
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!

    if (escaping) {
      escaping = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '>') {
      if (segment[i + 1] === '>') return 'append redirection (>>)'
      let j = i + 1
      while (j < segment.length && segment[j] === ' ') j++
      if (segment[j] === '&' && /\d/.test(segment[j + 1] ?? '')) {
        i = j + 1
        continue
      }
      return 'output redirection (>) writes to a file'
    }
    if (char === '<') {
      return 'input redirection (<)'
    }
  }

  return null
}

// kubectl 中「flag 自带独立值」的清单：命中时跳过下一个参数，避免把 flag 的值
// 误认成资源词（如 `-o json` 的 json）。`--flag=value` 自含形式不需要跳。
const KUBECTL_VALUE_FLAGS = new Set([
  '-o',
  '--output',
  '-n',
  '--namespace',
  '--context',
  '--cluster',
  '--user',
  '--kubeconfig',
  '-l',
  '--selector',
  '--field-selector',
  '--sort-by',
  '--as',
])

/**
 * secret 暴露硬拦：kubectl get/describe 资源词含 secret(s)（含逗号组合与
 * secret/name 形式）即命中；docker swarm 的 secret 子命令保守全拦。
 * 返回 null 表示不涉及 secret。
 */
export function classifySecretAccess(
  argv0: string,
  args: string[],
): string | null {
  if (argv0 === 'kubectl') {
    const sub = args[0]
    if (sub !== 'get' && sub !== 'describe') return null

    const rest = args.slice(1)
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      if (arg.startsWith('-')) {
        if (!arg.includes('=') && KUBECTL_VALUE_FLAGS.has(arg)) i++
        continue
      }
      for (const part of arg.split(',')) {
        if (/^secrets?(\/|$)/i.test(part)) {
          return `kubectl ${sub} ${arg} would expose cluster secrets`
        }
      }
      return null
    }
    return null
  }

  if (argv0 === 'docker') {
    if (args[0] === 'secret') {
      return 'docker secret operations may expose swarm secrets'
    }
    return null
  }

  return null
}

const FIND_DANGEROUS_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fls',
  '-fprint',
  '-fprint0',
  '-fprintf',
])

/**
 * argv 级危险原语检查：免审批白名单只看命令名不看参数的补丁层。
 * find -delete/-exec、sed -i、sort -o 等参数会让「只读命令」产生写副作用。
 */
export function findDangerousArgvPrimitive(
  argv0: string,
  args: string[],
): string | null {
  if (argv0 === 'find') {
    for (const arg of args) {
      if (FIND_DANGEROUS_FLAGS.has(arg) || arg.startsWith('-fprint')) {
        return `find ${arg} mutates the filesystem or executes commands`
      }
    }
    return null
  }

  if (argv0 === 'sed') {
    for (const arg of args) {
      if (arg === '-i' || arg.startsWith('--in-place')) {
        return `sed ${arg} rewrites files in place`
      }
      // 短选项组合里的粘连 i（如 -ni、-Ei）：sed 安全短选项不含 i
      if (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('i')) {
        return `sed ${arg} rewrites files in place (combined short flags)`
      }
    }
    return null
  }

  if (argv0 === 'sort') {
    for (const arg of args) {
      if (arg === '-o' || /^-o[^-]/.test(arg) || arg.startsWith('--output')) {
        return `sort ${arg} writes to a file`
      }
    }
    return null
  }

  return null
}

/**
 * 单命令（argv 形态）判定：secret 硬拦 → 参数原语 → 白名单成员。
 * argv 形态经 execFile 执行、无 shell 语义，重定向字符只是字面参数，
 * 因此这里不做重定向检查（shell 形态由 evaluateCommandSnippet 负责）。
 */
export function evaluateCommandArgv(argv0: string, args: string[]): GuardResult {
  if (!argv0) return { verdict: 'approval', reason: 'empty command' }

  if (HARDCODED_BLOCKS.has(argv0)) {
    return {
      verdict: 'deny',
      reason: `'${argv0}' is blocked outright (privilege escalation)`,
    }
  }

  const secret = classifySecretAccess(argv0, args)
  if (secret) return { verdict: 'deny', reason: secret }

  const primitive = findDangerousArgvPrimitive(argv0, args)
  if (primitive) return { verdict: 'approval', reason: primitive }

  if (!isAllowedCommand(argv0)) {
    return {
      verdict: 'approval',
      reason: `unknown command '${argv0}' is not in the built-in command sets`,
    }
  }

  if (DEVELOPMENT_COMMANDS.has(argv0)) {
    const danger = classifyDangerousCommand(argv0, args)
    if (danger) return { verdict: 'approval', reason: danger }
    return { verdict: 'allow' }
  }

  if (SRE_READONLY_COMMANDS.has(argv0)) {
    return isSreReadOnlyCommand(argv0, args)
      ? { verdict: 'allow' }
      : {
          verdict: 'approval',
          reason: `'${argv0} ${args[0] ?? ''}' is not in the read-only subcommand set`,
        }
  }

  return { verdict: 'allow' }
}

/**
 * shell 片段（snippet 形态）判定主入口：拆段 → 逐段判定 → 取最严结论。
 * - 任一段 deny → 整条 deny（无审批出口，如 secret 硬拦）
 * - 任一段 approval / 解析失败 → 整条 approval
 * - 全段 allow → allow
 */
export function evaluateCommandSnippet(command: string): GuardResult {
  const trimmed = command.trim()
  if (!trimmed) return { verdict: 'deny', reason: 'empty command' }

  const segments = splitShellSegments(trimmed)
  if (segments === null) {
    return {
      verdict: 'approval',
      reason:
        'command could not be safely parsed (unclosed quotes, subshell, or command substitution)',
    }
  }

  let worst: GuardResult = { verdict: 'allow' }
  for (const segment of segments) {
    const [argv0, ...args] = splitCommandLine(segment)
    let segmentResult = evaluateCommandArgv(argv0 ?? '', args)

    const redirect = findFileRedirect(segment)
    if (redirect) {
      segmentResult = escalate(segmentResult, {
        verdict: 'approval',
        reason: redirect,
      })
    }

    worst = escalate(worst, segmentResult)
    if (worst.verdict === 'deny') return worst
  }

  return worst
}
