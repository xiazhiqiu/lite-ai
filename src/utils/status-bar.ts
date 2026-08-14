export type StatusBarConfig = {
  time: string // 当前时间
  elapsed: string // 已运行时长，如 '3m12s'
  toolUsage: string // '3 (read_file:2, grep_files:1)'
  ctx: string // '42% (normal)'
  cwd: string // 工作目录
}

/**
 * 构建状态栏文本。框架可观测事实，格式固定、无散文。
 */
export function buildAgentStatusBar(cfg: StatusBarConfig): string {
  return [
    '<agent_status>',
    `time: ${cfg.time}`,
    `elapsed: ${cfg.elapsed}`,
    `tools: ${cfg.toolUsage}`,
    `ctx: ${cfg.ctx}`,
    `cwd: ${cfg.cwd}`,
    '</agent_status>',
  ].join('\n')
}

/** env 开关，默认关闭。置 LITE_AI_STATUS_BAR=1 启用状态栏注入。 */
export function isStatusBarEnabled(): boolean {
  return process.env.LITE_AI_STATUS_BAR === '1'
}

/** 将毫秒格式化为 'Xm Ys' 或 'Zs'。 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) {
    return `${minutes}m${seconds}s`
  }
  return `${seconds}s`
}