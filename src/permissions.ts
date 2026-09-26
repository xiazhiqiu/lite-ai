import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LITE_AI_DIR } from './config.js'
import { isEnoentError } from './utils/errors.js'

export type PermissionDecision =
  | 'allow_once'
  | 'allow_always'
  | 'allow_prefix'
  | 'allow_turn'
  | 'allow_all_turn'
  | 'deny_once'
  | 'deny_always'
  | 'deny_with_feedback'

export type PermissionChoice = {
  key: string
  label: string
  decision: PermissionDecision
}

export type PermissionPromptResult = {
  decision: PermissionDecision
  feedback?: string
}

type EnsureCommandOptions = {
  forcePromptReason?: string
}

export type PermissionRequest = {
  kind: 'path' | 'command' | 'edit'
  summary: string
  details: string[]
  scope: string
  choices: PermissionChoice[]
}

export type PermissionPromptHandler = (
  request: PermissionRequest,
) => Promise<PermissionPromptResult>

type PermissionStore = {
  allowedDirectoryPrefixes?: string[]
  deniedDirectoryPrefixes?: string[]
  allowedCommandPatterns?: string[]
  allowedCommandPrefixes?: string[]
  deniedCommandPatterns?: string[]
  allowedEditPatterns?: string[]
  deniedEditPatterns?: string[]
}

type PathIntent = 'read' | 'write' | 'list' | 'search' | 'command_cwd'

const PERMISSIONS_PATH = path.join(LITE_AI_DIR, 'permissions.json')

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath)
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function matchesDirectoryPrefix(
  targetPath: string,
  directories: Iterable<string>,
): boolean {
  for (const directory of directories) {
    if (isWithinDirectory(directory, targetPath)) {
      return true
    }
  }

  return false
}

function formatCommandSignature(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

/**
 * 从命令签名提取可前缀化的前缀（command + 首个参数）。
 * 任何旗标在场（-lc / -e / --force / -f）都不提供前缀选项（fail-closed）：
 * - 旗标可能携带任意载荷：bash -lc <脚本>、node -e <代码> —— 前 2 词无区分度；
 * - 旗标可能改变危险等级：git push --force —— 'git push' 前缀会连 force push 一起放行。
 * 旗标自由的调用（kubectl logs app-1、node scripts/healthcheck.js）才可播种前缀。
 * 返回 null 表示本次审批不出现"记住前缀"选项。
 */
export function extractCommandPrefix(
  command: string,
  args: string[],
): string | null {
  const trimmed = args.map(arg => arg.trim())
  if (trimmed.some(arg => !arg || arg.startsWith('-'))) {
    return null
  }

  const first = trimmed[0]
  if (!first) {
    return null
  }
  return `${command} ${first}`.trim()
}

/**
 * 词边界前缀匹配：前缀与签名按空白逐词比较（而非字符串 startsWith），
 * 防止 'kubectl get' 误命中 'kubectl getx pods'。
 */
export function matchesCommandPrefix(
  signature: string,
  prefixes: Iterable<string>,
): boolean {
  const tokens = signature.split(/\s+/).filter(Boolean)

  for (const prefix of prefixes) {
    const prefixTokens = prefix.split(/\s+/).filter(Boolean)
    if (prefixTokens.length === 0 || prefixTokens.length > tokens.length) {
      continue
    }

    let matched = true
    for (let i = 0; i < prefixTokens.length; i++) {
      if (tokens[i] !== prefixTokens[i]) {
        matched = false
        break
      }
    }

    if (matched) {
      return true
    }
  }

  return false
}

export function classifyDangerousCommand(command: string, args: string[]): string | null {
  const normalizedArgs = args.map(arg => arg.trim()).filter(Boolean)
  const signature = formatCommandSignature(command, normalizedArgs)

  if (command === 'git') {
    if (normalizedArgs.includes('reset') && normalizedArgs.includes('--hard')) {
      return `git reset --hard can discard local changes (${signature})`
    }

    if (normalizedArgs.includes('clean')) {
      return `git clean can delete untracked files (${signature})`
    }

    if (
      normalizedArgs.includes('checkout') &&
      normalizedArgs.includes('--')
    ) {
      return `git checkout -- can overwrite working tree files (${signature})`
    }

    if (
      normalizedArgs.includes('restore') &&
      normalizedArgs.some(arg => arg.startsWith('--source'))
    ) {
      return `git restore --source can overwrite local files (${signature})`
    }

    if (
      normalizedArgs.includes('push') &&
      normalizedArgs.some(arg => arg === '--force' || arg === '-f')
    ) {
      return `git push --force rewrites remote history (${signature})`
    }
  }

  if (command === 'npm' && normalizedArgs.includes('publish')) {
    return `npm publish affects a registry outside this machine (${signature})`
  }

  if (
    command === 'node' ||
    command === 'python3' ||
    command === 'bun' ||
    command === 'bash' ||
    command === 'sh'
  ) {
    return `${command} can execute arbitrary local code (${signature})`
  }

  // SRE 写操作识别（kubectl/docker 写子命令、curl 写方法）
  const sreDanger = classifySreDangerousCommand(command, normalizedArgs, signature)
  if (sreDanger) return sreDanger

  return null
}

// kubectl/docker 写操作子命令（需审批）
const KUBECTL_DANGEROUS_SUBCOMMANDS = new Set([
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
])

const DOCKER_DANGEROUS_SUBCOMMANDS = new Set([
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
])

const CURL_DANGEROUS_METHODS = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

function classifySreDangerousCommand(
  command: string,
  args: string[],
  signature: string,
): string | null {
  if (command === 'kubectl') {
    const sub = args[0]
    if (sub !== undefined && KUBECTL_DANGEROUS_SUBCOMMANDS.has(sub)) {
      return `kubectl ${sub} is a mutating operation on cluster resources (${signature})`
    }
  }

  if (command === 'docker') {
    const sub = args[0]
    if (sub !== undefined && DOCKER_DANGEROUS_SUBCOMMANDS.has(sub)) {
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

async function readPermissionStore(storePath: string): Promise<PermissionStore> {
  try {
    const content = await readFile(storePath, 'utf8')
    return JSON.parse(content) as PermissionStore
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

async function writePermissionStore(
  storePath: string,
  store: PermissionStore,
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true })
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

export class PermissionManager {
  private readonly allowedDirectoryPrefixes = new Set<string>()
  private readonly deniedDirectoryPrefixes = new Set<string>()
  private readonly sessionAllowedPaths = new Set<string>()
  private readonly sessionDeniedPaths = new Set<string>()
  private readonly allowedCommandPatterns = new Set<string>()
  private readonly allowedCommandPrefixes = new Set<string>()
  private readonly deniedCommandPatterns = new Set<string>()
  private readonly sessionAllowedCommands = new Set<string>()
  private readonly sessionDeniedCommands = new Set<string>()
  private readonly allowedEditPatterns = new Set<string>()
  private readonly deniedEditPatterns = new Set<string>()
  private readonly sessionAllowedEdits = new Set<string>()
  private readonly sessionDeniedEdits = new Set<string>()
  private readonly turnAllowedEdits = new Set<string>()
  private turnAllowAllEdits = false
  private ready: Promise<void>

  constructor(
    private readonly workspaceRoot: string,
    private readonly prompt?: PermissionPromptHandler,
    private readonly storePath: string = PERMISSIONS_PATH,
  ) {
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    const store = await readPermissionStore(this.storePath)

    for (const directory of store.allowedDirectoryPrefixes ?? []) {
      this.allowedDirectoryPrefixes.add(normalizePath(directory))
    }

    for (const directory of store.deniedDirectoryPrefixes ?? []) {
      this.deniedDirectoryPrefixes.add(normalizePath(directory))
    }

    for (const pattern of store.allowedCommandPatterns ?? []) {
      this.allowedCommandPatterns.add(pattern)
    }

    for (const prefix of store.allowedCommandPrefixes ?? []) {
      this.allowedCommandPrefixes.add(prefix)
    }

    for (const pattern of store.deniedCommandPatterns ?? []) {
      this.deniedCommandPatterns.add(pattern)
    }

    for (const pattern of store.allowedEditPatterns ?? []) {
      this.allowedEditPatterns.add(normalizePath(pattern))
    }

    for (const pattern of store.deniedEditPatterns ?? []) {
      this.deniedEditPatterns.add(normalizePath(pattern))
    }
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  beginTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  endTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  getSummary(): string[] {
    const summary = [`cwd: ${this.workspaceRoot}`]

    if (this.allowedDirectoryPrefixes.size > 0) {
      summary.push(
        `extra allowed dirs: ${[...this.allowedDirectoryPrefixes].slice(0, 4).join(', ')}`,
      )
    } else {
      summary.push('extra allowed dirs: none')
    }

    if (this.allowedCommandPatterns.size > 0) {
      summary.push(
        `dangerous allowlist: ${[...this.allowedCommandPatterns].slice(0, 4).join(', ')}`,
      )
    } else {
      summary.push('dangerous allowlist: none')
    }

    if (this.allowedCommandPrefixes.size > 0) {
      summary.push(
        `allowed command prefixes: ${[...this.allowedCommandPrefixes].slice(0, 4).join(', ')}`,
      )
    }

    if (this.allowedEditPatterns.size > 0) {
      summary.push(
        `trusted edit targets: ${[...this.allowedEditPatterns].slice(0, 2).join(', ')}`,
      )
    }

    return summary
  }

  private async persist(): Promise<void> {
    await writePermissionStore(this.storePath, {
      allowedDirectoryPrefixes: [...this.allowedDirectoryPrefixes],
      deniedDirectoryPrefixes: [...this.deniedDirectoryPrefixes],
      allowedCommandPatterns: [...this.allowedCommandPatterns],
      allowedCommandPrefixes: [...this.allowedCommandPrefixes],
      deniedCommandPatterns: [...this.deniedCommandPatterns],
      allowedEditPatterns: [...this.allowedEditPatterns],
      deniedEditPatterns: [...this.deniedEditPatterns],
    })
  }

  async ensurePathAccess(targetPath: string, intent: PathIntent): Promise<void> {
    await this.ready

    const normalizedTarget = normalizePath(targetPath)
    if (isWithinDirectory(this.workspaceRoot, normalizedTarget)) {
      return
    }

    if (
      this.sessionDeniedPaths.has(normalizedTarget) ||
      matchesDirectoryPrefix(normalizedTarget, this.deniedDirectoryPrefixes)
    ) {
      throw new Error(`Access denied for path outside cwd: ${normalizedTarget}`)
    }

    if (
      this.sessionAllowedPaths.has(normalizedTarget) ||
      matchesDirectoryPrefix(normalizedTarget, this.allowedDirectoryPrefixes)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Path ${normalizedTarget} is outside cwd ${this.workspaceRoot}. Start lite-ai in TTY mode to approve it.`,
      )
    }

    const scopeDirectory =
      intent === 'list' || intent === 'command_cwd'
        ? normalizedTarget
        : path.dirname(normalizedTarget)

    const promptResult = await this.prompt({
      kind: 'path',
      summary: `lite-ai wants ${intent.replace('_', ' ')} access outside the current cwd`,
      details: [
        `cwd: ${this.workspaceRoot}`,
        `target: ${normalizedTarget}`,
        `scope directory: ${scopeDirectory}`,
      ],
      scope: scopeDirectory,
      choices: [
        { key: 'y', label: 'allow once', decision: 'allow_once' },
        { key: 'a', label: 'allow this directory', decision: 'allow_always' },
        { key: 'n', label: 'deny once', decision: 'deny_once' },
        { key: 'd', label: 'deny this directory', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedPaths.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedDirectoryPrefixes.add(scopeDirectory)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedDirectoryPrefixes.add(scopeDirectory)
      await this.persist()
    } else {
      this.sessionDeniedPaths.add(normalizedTarget)
    }

    throw new Error(`Access denied for path outside cwd: ${normalizedTarget}`)
  }

  async ensureCommand(
    command: string,
    args: string[],
    commandCwd: string,
    options?: EnsureCommandOptions,
  ): Promise<void> {
    await this.ready

    await this.ensurePathAccess(commandCwd, 'command_cwd')

    const dangerousReason = classifyDangerousCommand(command, args)
    const reason = options?.forcePromptReason?.trim() || dangerousReason
    if (!reason) {
      return
    }

    const signature = formatCommandSignature(command, args)
    // deny 检查（从宽）：持久层 deny_always 的签名按词边界前缀匹配——
    // 拒绝过的命令连同以它开头的更长变体一起拦下（fail-closed 方向的从宽）。
    // sessionDeniedCommands 保持精确匹配：deny_once 的语义只是同签名不再重复询问。
    if (
      this.sessionDeniedCommands.has(signature) ||
      this.deniedCommandPatterns.has(signature) ||
      matchesCommandPrefix(signature, this.deniedCommandPatterns)
    ) {
      throw new Error(`Command denied: ${signature}`)
    }

    if (
      this.sessionAllowedCommands.has(signature) ||
      this.allowedCommandPatterns.has(signature)
    ) {
      return
    }

    // 前缀放行（词边界匹配）：deny/精确 allow 之后、审批之前。
    // 注意 secret 硬拦在命令闸（command-guard）上游已是 deny，永远不会走到这里，
    // 因此前缀放行无法漂白 secret 读取。
    if (matchesCommandPrefix(signature, this.allowedCommandPrefixes)) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Command requires approval: ${signature}. Start lite-ai in TTY mode to approve it.`,
      )
    }

    const commandPrefix = extractCommandPrefix(command, args)
    const choices: PermissionChoice[] = [
      { key: 'y', label: 'allow once', decision: 'allow_once' },
      { key: 'a', label: 'always allow this command', decision: 'allow_always' },
      ...(commandPrefix
        ? [
            {
              key: 'p',
              label: `always allow commands starting with '${commandPrefix}'`,
              decision: 'allow_prefix' as const,
            },
          ]
        : []),
      { key: 'n', label: 'deny once', decision: 'deny_once' },
      { key: 'd', label: 'always deny this command', decision: 'deny_always' },
    ]

    const promptResult = await this.prompt({
      kind: 'command',
      summary: options?.forcePromptReason
        ? 'lite-ai wants approval for this command'
        : 'lite-ai wants to run a dangerous command',
      details: [
        `cwd: ${commandCwd}`,
        `command: ${signature}`,
        `reason: ${reason}`,
      ],
      scope: signature,
      choices,
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedCommands.add(signature)
      return
    }

    if (promptResult.decision === 'allow_prefix' && commandPrefix) {
      this.allowedCommandPrefixes.add(commandPrefix)
      await this.persist()
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedCommandPatterns.add(signature)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedCommandPatterns.add(signature)
      await this.persist()
    } else {
      this.sessionDeniedCommands.add(signature)
    }

    throw new Error(`Command denied: ${signature}`)
  }

  async ensureEdit(targetPath: string, diffPreview: string): Promise<void> {
    await this.ready

    const normalizedTarget = normalizePath(targetPath)

    if (
      this.sessionDeniedEdits.has(normalizedTarget) ||
      this.deniedEditPatterns.has(normalizedTarget)
    ) {
      throw new Error(`Edit denied: ${normalizedTarget}`)
    }

    if (
      this.sessionAllowedEdits.has(normalizedTarget) ||
      this.turnAllowedEdits.has(normalizedTarget) ||
      this.turnAllowAllEdits ||
      this.allowedEditPatterns.has(normalizedTarget)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Edit requires approval: ${normalizedTarget}. Start lite-ai in TTY mode to review it.`,
      )
    }

    const promptResult = await this.prompt({
      kind: 'edit',
      summary: 'lite-ai wants to apply a file modification',
      details: [
        `target: ${normalizedTarget}`,
        '',
        diffPreview,
      ],
      scope: normalizedTarget,
      choices: [
        { key: '1', label: 'apply once', decision: 'allow_once' },
        { key: '2', label: 'allow this file in this turn', decision: 'allow_turn' },
        { key: '3', label: 'allow all edits in this turn', decision: 'allow_all_turn' },
        { key: '4', label: 'always allow this file', decision: 'allow_always' },
        { key: '5', label: 'reject once', decision: 'deny_once' },
        { key: '6', label: 'reject and send guidance to model', decision: 'deny_with_feedback' },
        { key: '7', label: 'always reject this file', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedEdits.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_turn') {
      this.turnAllowedEdits.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_all_turn') {
      this.turnAllowAllEdits = true
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedEditPatterns.add(normalizedTarget)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_with_feedback') {
      const guidance = promptResult.feedback?.trim()
      if (guidance) {
        throw new Error(
          `Edit denied: ${normalizedTarget}\nUser guidance: ${guidance}`,
        )
      }
      this.sessionDeniedEdits.add(normalizedTarget)
      throw new Error(`Edit denied: ${normalizedTarget}`)
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedEditPatterns.add(normalizedTarget)
      await this.persist()
    } else {
      this.sessionDeniedEdits.add(normalizedTarget)
    }

    throw new Error(`Edit denied: ${normalizedTarget}`)
  }
}

export function getPermissionsPath(): string {
  return PERMISSIONS_PATH
}
