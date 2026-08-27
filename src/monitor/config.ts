// src/monitor/config.ts
import type { MonitorConfig } from './types.js'

/** 读正整型 env：primary 优先，回退 fallback，非法/缺失回退默认值。 */
function readPositiveInt(
  primary: string | undefined,
  fallback: string | undefined,
  def: number,
): number {
  const raw = primary ?? fallback
  if (raw == null || raw.trim() === '') return def
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : def
}

/**
 * 读取回合监控统一配置。
 * 命名空间 LITE_AI_MONITOR_*；LITE_AI_TOOL_REPEAT_NOTICE_MAX 向后兼容回退。
 * 控制流型阈值（空响应/thinking/续跑）保持模块常量，不暴露为配置（YAGNI）。
 */
export function readMonitorConfig(): MonitorConfig {
  return {
    toolRepeatNoticeMax: readPositiveInt(
      process.env.LITE_AI_MONITOR_TOOL_REPEAT_MAX,
      process.env.LITE_AI_TOOL_REPEAT_NOTICE_MAX,
      3,
    ),
    consecutiveFailureMax: readPositiveInt(
      process.env.LITE_AI_MONITOR_CONSECUTIVE_FAILURE_MAX,
      undefined,
      3,
    ),
  }
}