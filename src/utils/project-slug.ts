/** 由 cwd 派生项目标识（统一规则），保证跨 session 共享同一份数据。 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}