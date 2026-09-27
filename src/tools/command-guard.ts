/**
 * command-guard：bash / kubectl 工具免审批/审批/硬拒的三态判定管线。
 *
 * 分层职责（对齐 HolmesGPT：通用底座 + 命令域判定器）：
 * - 本模块只做「命令字符串 → 三态判定」：allow（免审批）/ approval（转审批）/ deny（硬拒）。
 * - 权限底座（三层名单、审批回调、fail-closed 硬拒）仍在 permissions.ts，互不依赖执行层。
 * - 并发只读判定（isReadOnlyCommandCall）自 run-command.ts 迁入：同属命令字符串判定，
 *   且复用同一套白名单集合，避免两处名单漂移。
 *
 * fail-closed 原则：任何无法 100% 确认安全的输入一律不给 allow——宁可多一次审批，
 * 不可漏放一次。bash 路径优先用 tree-sitter AST 分段（对齐 HolmesGPT 的
 * tree-sitter-bash，见 bash-parser.ts）：能解析时逐段（含 `$(...)` 内嵌命令）
 * 判定；解析器不可用/解析失败时回退手写拆段器，未闭合引号、子 shell、
 * 命令替换在该回退路径下一律转审批。
 */

import { classifyDangerousCommand } from '../permissions.js'
import { parseBashSegments } from './bash-parser.js'
import type { ParsedBashSegment } from './bash-parser.js'

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
 * 判定一次 bash 调用实例是否可并发执行（只读）。
 * fail-closed：任何无法 100% 确认只读的情况都返回 false。
 * 按 shell 分隔符拆段，逐段校验 argv0 与危险符号。
 * 绝不复用 isReadOnlyCommand（其白名单含 sed）。
 */
export function isReadOnlyCommandCall(input: {
  command: string
}): boolean {
  const trimmed = input.command.trim()
  if (!trimmed) return false

  return isReadOnlySnippet(trimmed)
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

/** 非真实文件的重定向/输出目标：null 池、标准流、终端与 fd 别名（对齐 HG argv_utils.py:12）。 */
const BENIGN_REDIRECT_TARGETS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
])

export function isBenignRedirectTarget(target: string): boolean {
  return BENIGN_REDIRECT_TARGETS.has(target) || target.startsWith('/dev/fd/')
}

/**
 * 段内引号外的文件重定向扫描。`2>&1` / `>&2` 这类 fd 复制放行；
 * `>` `>>`（写/追加文件）与 `<` `<<`（输入/heredoc，保守）返回描述。
 * 良性目标（/dev/null、/dev/stdout 等）不是真实文件写，放行——
 * 对齐 HG argv_utils.py 的 BENIGN_REDIRECT_TARGETS。
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
      const isAppend = segment[i + 1] === '>'
      let j = isAppend ? i + 2 : i + 1
      while (j < segment.length && segment[j] === ' ') j++
      if (segment[j] === '&' && /\d/.test(segment[j + 1] ?? '')) {
        i = j + 1
        continue
      }
      let wordEnd = j
      while (wordEnd < segment.length && !/\s/.test(segment[wordEnd]!)) wordEnd++
      const target = segment
        .slice(j, wordEnd)
        .replace(/^["']+|["']+$/g, '')
      if (!isBenignRedirectTarget(target)) {
        return isAppend
          ? 'append redirection (>>)'
          : 'output redirection (>) writes to a file'
      }
      i = Math.max(wordEnd - 1, i)
      continue
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

// ---------------------------------------------------------------------------
// 参数原语判定（阶段三，对齐 HG command_arg_rules.py + argv_utils.py）：
// 白名单只看命令名不看参数，少数命令的参数能把「只读工具」变成任意执行/
// 文件写/删除。这些原语命中一律转审批，白名单成员与既往授权都越不过。
// ---------------------------------------------------------------------------

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

/** GNU getopt_long 接受无歧义长选项缩写：`--out` 视同 `--output`（对齐 HG argv_utils.abbreviates，从宽匹配）。 */
function abbreviatesLongOption(
  opt: string,
  targets: ReadonlySet<string>,
): boolean {
  if (opt.length <= 2 || !opt.startsWith('--')) return false
  for (const target of targets) {
    if (target.startsWith(opt)) return true
  }
  return false
}

/**
 * minimal getopt 解析（对齐 HG argv_utils.parse_argv）：只建模两件
 * 「只看名字的检查」会漏的事——短选项聚簇（`-ro` == `-r -o`）与取值选项
 * （值是簇内余下字符或下一 token）。只需精确到「哪些旗标在场 + 位置参数
 * 列表」，不是完整 getopt。
 */
function parseArgvOptions(
  args: string[],
  valueShortChars: string,
  valueLongOpts: ReadonlySet<string>,
): { options: Set<string>; positionals: string[] } {
  const options = new Set<string>()
  const positionals: string[] = []
  let endOfOptions = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (endOfOptions || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg) // '-'（stdin）按位置参数计
      i++
      continue
    }
    if (arg === '--') {
      endOfOptions = true
      i++
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      options.add(name)
      // 必填值长选项吞下一 token，除非值已内联（--name=value）。
      i += eq === -1 && abbreviatesLongOption(name, valueLongOpts) ? 2 : 1
      continue
    }
    // 短选项聚簇，如 -c、-cf、-ro、-ofile。
    let consumesNext = false
    for (let pos = 1; pos < arg.length; pos++) {
      const ch = arg[pos]!
      options.add('-' + ch)
      if (valueShortChars.includes(ch)) {
        // 值是簇内余下字符（-ofile 的 "file"）或下一 token；簇到此为止。
        consumesNext = pos === arg.length - 1
        break
      }
    }
    i += consumesNext ? 2 : 1
  }
  return { options, positionals }
}

/** sort 取值短选项：`-to` 的 o 是 -t 的值，不是输出旗标（对齐 HG SORT_VALUE_SHORT_CHARS）。 */
const SORT_VALUE_SHORT_CHARS = 'ktSTo'
const SORT_VALUE_LONG_OPTS = new Set([
  '--output',
  '--compress-program',
  '--buffer-size',
  '--key',
  '--field-separator',
  '--temporary-directory',
  '--batch-size',
  '--files0-from',
  '--random-source',
])
const SORT_EXEC_LONG_OPTS = new Set(['--compress-program'])
const SORT_WRITE_LONG_OPTS = new Set(['--output'])

const UNIQ_VALUE_SHORT_CHARS = 'fsw'
const UNIQ_VALUE_LONG_OPTS = new Set([
  '--skip-fields',
  '--skip-chars',
  '--check-chars',
])

/**
 * argv 级危险原语检查：免审批白名单只看命令名不看参数的补丁层。
 * find -delete/-exec、sed -i、sort -o/-–compress-program、uniq 输出文件等
 * 参数会让「只读命令」产生写副作用或执行程序。
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
    // 长选项按 GNU 缩写匹配（--out 视同 --output），短选项经聚簇解析
    // （-ro 的 o 是输出旗标）；对齐 HG command_arg_rules._sort_reason。
    const { options } = parseArgvOptions(
      args,
      SORT_VALUE_SHORT_CHARS,
      SORT_VALUE_LONG_OPTS,
    )
    const longOpts = [...options].filter(opt => opt.startsWith('--'))
    if (longOpts.some(opt => abbreviatesLongOption(opt, SORT_EXEC_LONG_OPTS))) {
      return "'sort --compress-program' can execute an arbitrary program"
    }
    if (
      options.has('-o') ||
      longOpts.some(opt => abbreviatesLongOption(opt, SORT_WRITE_LONG_OPTS))
    ) {
      return "'sort' output-file option writes to the filesystem"
    }
    return null
  }

  if (argv0 === 'uniq') {
    // `uniq [OPTION]... [INPUT [OUTPUT]]`：第 2 个位置参数是输出文件，
    // 除非是 '-'（stdout）或良性目标；对齐 HG command_arg_rules._uniq_reason。
    const { positionals } = parseArgvOptions(
      args,
      UNIQ_VALUE_SHORT_CHARS,
      UNIQ_VALUE_LONG_OPTS,
    )
    const second = positionals[1]
    if (
      positionals.length >= 2 &&
      second !== undefined &&
      second !== '-' &&
      !isBenignRedirectTarget(second)
    ) {
      return "'uniq' output-file argument writes to the filesystem"
    }
    return null
  }

  return null
}

/**
 * 参数含运行时展开时无法静态校验其值——展开结果可能正是上面拦的原语
 * （如 $FLAGS 展开成 -i/-o/-delete）。对 find/sed/sort/uniq 这类
 * argv-checked 命令转审批；对齐 HG validation.py:219-231 的
 * shell-expansion gate（HG 集合为 find/sort/uniq，本仓 sed 在白名单故并入）。
 */
const ARGV_CHECKED_COMMANDS = new Set(['find', 'sed', 'sort', 'uniq'])

export function isArgvCheckedCommand(name: string): boolean {
  return ARGV_CHECKED_COMMANDS.has(name)
}

function commandBasename(argv0: string): string {
  const idx = argv0.lastIndexOf('/')
  return idx >= 0 ? argv0.slice(idx + 1) : argv0
}

function dynamicArgReason(argv0: string): string {
  return `'${argv0}' builds an argument via shell expansion, which cannot be verified as read-only and requires approval`
}

/** AST 路径动态闸：段解析器已给出 hasDynamicArgs（单引号字面量不算，不误报）。 */
function astDynamicArgGate(segment: ParsedBashSegment, argv0: string): string | null {
  if (!segment.hasDynamicArgs) return null
  if (!isArgvCheckedCommand(commandBasename(argv0))) return null
  return dynamicArgReason(argv0)
}

/**
 * 手写回退路径动态闸：没有 AST，文本级保守判定（参数 token 含 $ 或反引号
 * 即视为动态）。回退路径本就是 AST 不可用时的兜底，宁可多转审批
 * （如 sed 's/$/x/' 的单引号 $ 会被误报，人批一次即可）；对齐 HG
 * 解析失败路径 check_unsafe_args_in_raw_command「errs toward flagging」。
 */
function fallbackDynamicArgGate(argv0: string, args: string[]): string | null {
  if (!isArgvCheckedCommand(commandBasename(argv0))) return null
  if (!args.some(arg => /[$`]/.test(arg))) return null
  return dynamicArgReason(argv0)
}

/**
 * 单命令段判定：secret 硬拦 → 参数原语 → 白名单成员。
 * 作为 evaluateCommandSnippet 的段级判定器使用；bash 工具不再有
 * 独立的 argv 执行形态（整条 snippet 经 bash -lc 执行，重定向等
 * shell 语义由 evaluateCommandSnippet 的 findFileRedirect 负责）。
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

    const dynamic = fallbackDynamicArgGate(argv0 ?? '', args)
    if (dynamic) {
      segmentResult = escalate(segmentResult, {
        verdict: 'approval',
        reason: dynamic,
      })
    }

    worst = escalate(worst, segmentResult)
    if (worst.verdict === 'deny') return worst
  }

  return worst
}

// ---------------------------------------------------------------------------
// suggested_prefixes（对齐 HolmesGPT bash toolset：bash_toolset.py:123 /
// validation.py validate_command / tool_calling_llm.py 持久化闭环）
// ---------------------------------------------------------------------------

/** 词级连续子序列匹配：prefixTokens 须作为 tokens 的连续片段出现。 */
function containsConsecutiveTokens(
  tokens: string[],
  prefixTokens: string[],
): boolean {
  if (prefixTokens.length === 0 || prefixTokens.length > tokens.length) {
    return false
  }
  outer: for (let i = 0; i <= tokens.length - prefixTokens.length; i++) {
    for (let j = 0; j < prefixTokens.length; j++) {
      if (tokens[i + j] !== prefixTokens[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * 前缀一致性校验（对齐 HG validation.py 的 PREFIX_NOT_IN_COMMAND，:571）：
 * 模型声明的每个前缀必须词级出现在命令里，且段数一致（每段一个前缀）。
 * 返回 null 表示一致；否则返回 deny 理由——前缀是"用户按 don't ask again 时
 * 会被记住的东西"，必须锚定在实际执行的命令上，不允许声明无关作用域。
 */
export function validateSuggestedPrefixes(
  command: string,
  prefixes: string[],
): string | null {
  if (prefixes.length === 0) {
    return "The 'suggested_prefixes' parameter is required. Provide one prefix per command segment (segments are separated by |, &&, ||, ;)."
  }

  // 解析失败（命令替换/未闭合引号/独立后台符）时跳过段数校验：
  // 该命令随后必然因 snippet 拆段失败转审批，无需在此重复拦截。
  const segments = splitShellSegments(command)
  if (segments && segments.length !== prefixes.length) {
    return `suggested_prefixes must contain one prefix per command segment: command has ${segments.length} segment(s), got ${prefixes.length} prefix(es)`
  }

  const tokens = splitCommandLine(command)
  for (const prefix of prefixes) {
    const prefixTokens = prefix.trim().split(/\s+/).filter(Boolean)
    if (prefixTokens.length === 0) {
      return 'suggested prefix must not be empty'
    }
    if (!containsConsecutiveTokens(tokens, prefixTokens)) {
      return `suggested prefix '${prefix}' does not appear in the command`
    }
  }

  return null
}

/**
 * 从命令推导建议前缀（每段取命令名 + 首个参数，供 /cmd 快捷方式与 mock
 * 模型兜底；真实模型应自行声明）。
 *
 * AST 优先：parseBashSegments 成功时按 AST 段推导，保证与
 * evaluateBashCommand 的段数校验天然一致（否则 `$(...)` 这类手写拆段器
 * 拆不了的命令会推导出错误段数，被误 deny）。解析器不可用/解析失败时
 * 回退到手写拆段（行为同阶段一：退化为整条命令的首词）。
 */
export async function deriveSuggestedPrefixes(command: string): Promise<string[]> {
  const trimmed = command.trim()
  if (!trimmed) return []

  const parsed = await parseBashSegments(trimmed)
  if (parsed) {
    return parsed
      .map(segment => {
        const tokens = splitCommandLine(segment.text)
        const start = segment.argv0 ? Math.max(tokens.indexOf(segment.argv0), 0) : 0
        const prefixTokens = tokens.slice(start, start + 2)
        return prefixTokens.join(' ') || segment.text
      })
      .filter(Boolean)
  }

  const segments = splitShellSegments(trimmed)
  if (!segments) {
    const first = splitCommandLine(trimmed)[0]
    return first ? [first] : []
  }

  return segments
    .map(segment => {
      const tokens = splitCommandLine(segment)
      return tokens.slice(0, 2).join(' ') || segment
    })
    .filter(Boolean)
}

/**
 * AST 段的前缀一致性校验：段数一致，且 prefix i 必须词级连续出现在
 * segment i 内（模型按序为每段声明一个前缀，对齐 HG 的 commands ↔
 * prefixes 逐项对应）。消息格式与 validateSuggestedPrefixes 保持一致，
 * 供模型自纠循环复用。
 */
function validateAstSuggestedPrefixes(
  segments: ParsedBashSegment[],
  prefixes: string[],
): string | null {
  if (prefixes.length === 0) {
    return "The 'suggested_prefixes' parameter is required. Provide one prefix per command segment (segments are separated by |, &&, ||, ;)."
  }

  if (segments.length !== prefixes.length) {
    return `suggested_prefixes must contain one prefix per command segment: command has ${segments.length} segment(s), got ${prefixes.length} prefix(es)`
  }

  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i]!.trim()
    const prefixTokens = prefix.split(/\s+/).filter(Boolean)
    if (prefixTokens.length === 0) {
      return 'suggested prefix must not be empty'
    }
    const segmentTokens = splitCommandLine(segments[i]!.text)
    if (!containsConsecutiveTokens(segmentTokens, prefixTokens)) {
      return `suggested prefix '${prefixes[i]}' does not appear in the command`
    }
  }

  return null
}

/**
 * bash 工具专用判定入口（阶段二：AST 优先，对齐 HolmesGPT 的
 * tree-sitter-bash 解析栈）：
 *
 * - AST 可用：段 = 文档序的所有 command 节点（含 `$(...)` 内嵌命令）。
 *   先做前缀一致性校验（deny 优先，对齐 HG validate_command 把
 *   PREFIX_NOT_IN_COMMAND 放在最前——即使命令本身可免审批，声明与命令
 *   不符也整条拒绝），再逐段走 secret 硬拦 → 参数原语 → 段级白名单，
 *   重定向（写文件/输入重定向）按段附带的外层 redirected_statement 判定。
 * - AST 不可用（wasm 加载失败 / 解析 ERROR / 零命令节点）：回退阶段一
 *   的手写拆段管线，语义不变（无法安全拆段 → approval，fail-closed）。
 */
export async function evaluateBashCommand(
  command: string,
  suggestedPrefixes: string[],
): Promise<GuardResult> {
  const trimmed = command.trim()
  if (!trimmed) return { verdict: 'deny', reason: 'empty command' }

  const parsed = await parseBashSegments(trimmed)
  if (parsed === null) {
    const prefixViolation = validateSuggestedPrefixes(
      trimmed,
      suggestedPrefixes,
    )
    if (prefixViolation) {
      return { verdict: 'deny', reason: prefixViolation }
    }
    return evaluateCommandSnippet(command)
  }

  const prefixViolation = validateAstSuggestedPrefixes(parsed, suggestedPrefixes)
  if (prefixViolation) {
    return { verdict: 'deny', reason: prefixViolation }
  }

  let worst: GuardResult = { verdict: 'allow' }
  for (const segment of parsed) {
    const tokens = splitCommandLine(segment.text)
    let argv0 = segment.argv0
    let args: string[]
    const argv0Index = argv0 ? tokens.indexOf(argv0) : -1
    if (argv0 && argv0Index >= 0) {
      args = tokens.slice(argv0Index + 1)
    } else {
      argv0 = tokens[0] ?? ''
      args = tokens.slice(1)
    }
    let segmentResult = evaluateCommandArgv(argv0, args)

    const redirect = findFileRedirect(segment.redirectText ?? segment.text)
    if (redirect) {
      segmentResult = escalate(segmentResult, {
        verdict: 'approval',
        reason: redirect,
      })
    }

    const dynamic = astDynamicArgGate(segment, argv0)
    if (dynamic) {
      segmentResult = escalate(segmentResult, {
        verdict: 'approval',
        reason: dynamic,
      })
    }

    worst = escalate(worst, segmentResult)
    if (worst.verdict === 'deny') return worst
  }

  return worst
}
