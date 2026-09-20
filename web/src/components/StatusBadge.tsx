import type { JobStatus } from '../api/types.js'
import { STATUS_LABELS } from '../format.js'

/** 状态徽标：进行中带脉冲点，让"还在跑"一眼可辨。 */
export function StatusBadge({ status }: { status: JobStatus }): React.ReactElement {
  const active = status === 'pending' || status === 'running'
  return (
    <span className={`badge ${status}`}>
      {active ? <span className="pulse" /> : null}
      {STATUS_LABELS[status]}
    </span>
  )
}
