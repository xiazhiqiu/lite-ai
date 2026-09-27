/**
 * bash-parser：web-tree-sitter + tree-sitter-bash WASM 解析基础设施。
 *
 * 对齐 HolmesGPT 的解析栈（shell_parser.py:24 `import tree_sitter_bash`）：
 * 与 HG 同一套 bash 语法。本模块只负责「命令字符串 → AST 命令段列表」，
 * 不做任何安全判定；判定逻辑仍在 command-guard.ts
 * （单向依赖：command-guard → bash-parser）。
 *
 * fail-closed 约定（调用方把 null 一律当作「回退到手写拆段器」）：
 * - 懒加载单例；wasm 加载过程中的任何异常被捕获并返回 null（首次失败时
 *   打一次 warn），此后进程内不再重试。
 * - 解析结果含 ERROR/MISSING 节点（rootNode.hasError）→ 返回 null。
 * - 零命令节点（如纯变量赋值 x=1）→ 返回 null，交回退路径按未知命令审批。
 *
 * 段的口径：按文档序收集语法树中所有 `command` 节点——顶层命令、管道/
 * 逻辑链各段、`$(...)` / `<(...)` 内嵌命令各自成段；引号内内容不透明
 * （`bash -lc "a && b"` 是一个段）；heredoc 体是文本，不产生段。
 * 重定向挂在 redirected_statement 上（`cmd > f` 的 `> f` 不在 command
 * 节点文本里），因此每段携带最近外层 redirected_statement 的文本供
 * 调用方做重定向扫描（2>&1 放行、写文件转审批，语义同 findFileRedirect）。
 *
 * hasDynamicArgs（阶段三，对齐 HG shell_parser._Visitor.is_dynamic）：
 * 参数子树是否含运行时展开（$VAR / ${...} / $(...) / 反引号 / <(...)），
 * 供判定层做「动态参数闸」——argv 级规则无法静态校验展开后的运行时值。
 * 单引号（raw_string）与 $'...'（ansi_c_string）是纯字面量，不算动态。
 */

import { createRequire } from 'node:module'
import { Parser, Language } from 'web-tree-sitter'
import type { Node as SyntaxNode } from 'web-tree-sitter'

export interface ParsedBashSegment {
  /** command 节点的源码文本（引号保持原样）。 */
  text: string
  /** command_name 子节点的文本；缺失时为 null（调用方回退到首词）。 */
  argv0: string | null
  /** 最近外层 redirected_statement 的文本；无外层重定向时为 null。 */
  redirectText: string | null
  /**
   * 参数子树（argv0 之外）是否含运行时展开节点。AST 不可用的回退场景
   * 下由调用方自行做文本级保守判定，因此 DI 注入的假段可省略此字段。
   */
  hasDynamicArgs?: boolean
}

export type BashSegmentParser = (command: string) => ParsedBashSegment[] | null

/** 运行时展开节点类型（对齐 HG shell_parser.py:41 _DYNAMIC）。 */
const DYNAMIC_ARGV_NODE_TYPES = new Set([
  'simple_expansion',
  'expansion',
  'command_substitution',
  'process_substitution',
])

/** 纯字面量叶子：内部文本不经展开（对齐 HG shell_parser.py:50 _LITERAL_LEAVES）。 */
const LITERAL_ARGV_NODE_TYPES = new Set(['raw_string', 'ansi_c_string'])

/** 参数子树是否含运行时展开（对齐 HG _Visitor.is_dynamic 的递归口径）。 */
function subtreeHasDynamicArg(node: SyntaxNode): boolean {
  if (DYNAMIC_ARGV_NODE_TYPES.has(node.type)) return true
  if (LITERAL_ARGV_NODE_TYPES.has(node.type)) return false
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && subtreeHasDynamicArg(child)) return true
  }
  return false
}

let parserPromise: Promise<Parser | null> | null = null
let testParserOverride: BashSegmentParser | null | undefined = undefined
/** 就绪后的解析器快照：同步路径（parseBashSegmentsSync）用它做零等待解析。 */
let readyParser: Parser | null = null

async function loadParser(): Promise<Parser | null> {
  try {
    await Parser.init()
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')
    const language = await Language.load(wasmPath)
    const parser = new Parser()
    parser.setLanguage(language)
    readyParser = parser
    return parser
  } catch (error) {
    console.warn(
      '[bash-parser] web-tree-sitter unavailable, falling back to the hand-written splitter:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

function getParser(): Promise<Parser | null> {
  parserPromise ??= loadParser()
  return parserPromise
}

/**
 * 测试注入口：注入函数可模拟任意解析结果；注入 null 模拟「wasm 不可用」
 * 走手写回退；注入 undefined 恢复真实解析器。测试用完必须复位。
 */
export function __setBashSegmentParserForTests(
  override: BashSegmentParser | null | undefined,
): void {
  testParserOverride = override
}

/** 解析主体（同步）：tree-sitter 的 parse 本身是同步调用，仅供已就绪的解析器使用。 */
function extractSegments(
  parser: Parser,
  command: string,
): ParsedBashSegment[] | null {
  try {
    const tree = parser.parse(command)
    if (!tree) return null
    try {
      const root = tree.rootNode
      if (root.hasError) return null

      const segments: ParsedBashSegment[] = []
      const walk = (node: SyntaxNode, redirectText: string | null): void => {
        if (node.type === 'command') {
          let argv0: string | null = null
          let argv0Seen = false
          let hasDynamicArgs = false
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i)
            if (!child) continue
            // 首个 command_name 是 argv0，不计入参数动态性（对齐 HG 只查 words[1:]）。
            if (child.type === 'command_name' && !argv0Seen) {
              argv0 = child.text
              argv0Seen = true
              continue
            }
            if (!hasDynamicArgs && subtreeHasDynamicArg(child)) {
              hasDynamicArgs = true
            }
          }
          segments.push({ text: node.text, argv0, redirectText, hasDynamicArgs })
        }
        const nextRedirect =
          node.type === 'redirected_statement' ? node.text : redirectText
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (child) walk(child, nextRedirect)
        }
      }
      walk(root, null)

      return segments.length > 0 ? segments : null
    } finally {
      tree.delete()
    }
  } catch {
    return null
  }
}

/**
 * 把命令解析为按文档序的命令段列表。返回 null 表示「解析器不可用或无法
 * 给出可信分段」，调用方必须回退到手写拆段路径（fail-closed）。
 */
export async function parseBashSegments(
  command: string,
): Promise<ParsedBashSegment[] | null> {
  if (testParserOverride !== undefined) {
    return testParserOverride ? testParserOverride(command) : null
  }

  const parser = await getParser()
  if (!parser) return null
  return extractSegments(parser, command)
}

/**
 * 同步快照解析：解析器已就绪时零等待返回段列表；未就绪（异步加载中）
 * 返回 null，由调用方回退手写拆段（fail-closed）。供同步判定入口
 * （isReadOnlyCommandCall → isParallelSafe 并发谓词 / 无人值守护栏）使用。
 */
export function parseBashSegmentsSync(
  command: string,
): ParsedBashSegment[] | null {
  if (testParserOverride !== undefined) {
    return testParserOverride ? testParserOverride(command) : null
  }
  return readyParser ? extractSegments(readyParser, command) : null
}

// 模块加载即启动解析器初始化（fire-and-forget）：让同步快照路径在进程起来后
// 尽快可用；就绪前的同步调用拿到 null 走回退路径，行为与未引入前一致。
void getParser()
