import { useCallback, useState } from 'react'
import { getApiKey, setApiKey } from './api/client.js'
import { InvestigationStream } from './components/InvestigationStream.js'
import { SessionList } from './components/SessionList.js'
import { ChatInput } from './components/ChatInput.js'
import { AlertView } from './components/AlertView.js'
import { UsageView } from './components/UsageView.js'

type Tab = 'console' | 'alerts' | 'usage'

/**
 * 值班台外壳（T10）。
 *
 * ## 视图模型
 *
 * - `console`：左侧调查列表 + 右侧调查流 + 底部输入（**主视图**）
 * - `alerts`：告警诊断列表，点击跳转到 console 的对应调查
 * - `usage`：审计用量
 *
 * ## 鉴权门（AuthGate）
 *
 * T6 起所有 API 都要 `Authorization`。前端无法在"没有 key"时静默工作——
 * 所以这里做一道门：没有 key 就遮罩要求输入。
 *
 * **key 只存内存**（`client.ts` 的模块级变量），刷新即需重输：
 * 这是刻意的取舍（见 client.ts 注释），避免把凭据长期驻留 localStorage。
 * 代价是刷新要重贴，内网值班台可接受。
 *
 * 401 时**自动弹出这道门**：任何 API 调用抛 `UnauthorizedError` 都会
 * 触发 `onUnauthorized`，把用户拉回输入界面而不是显示一个空列表。
 */
export function App(): React.ReactElement {
  const [hasKey, setHasKey] = useState(() => getApiKey() !== null)
  const [tab, setTab] = useState<Tab>('console')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [refreshKey, setRefreshKey] = useState(0)
  const [gateOpen, setGateOpen] = useState(() => getApiKey() === null)

  const handleUnauthorized = useCallback((): void => {
    setApiKey(null)
    setHasKey(false)
    setGateOpen(true)
  }, [])

  /** 从告警/用量页跳到某个调查。 */
  const openJob = useCallback((jobId: string): void => {
    setTab('console')
    setSelectedJobId(jobId)
    // 打开历史调查时不预设 sessionId：让用户的下一句成为"新开调查"。
    // 若要续聊该调查的会话，由详情流加载后回填 —— 见下方 onSubmitted 语义。
    setSessionId(undefined)
  }, [])

  /**
   * 从左侧**会话栏**选中一个会话（第 1 档）。
   *
   * 与 `openJob` 的区别：这里用户明确"进入这个会话"，所以**预设 `sessionId`** ——
   * 输入框随之变成"追问"（复用该会话上下文），这正是会话侧栏的意义。
   */
  const selectSession = useCallback((sid: string, latestJobId: string): void => {
    setSessionId(sid)
    setSelectedJobId(latestJobId)
  }, [])

  /**
   * 分叉完成：切到新会话。
   *
   * 新会话**还没有 job**（fork 只复制历史），所以清空 `selectedJobId`、只设
   * `sessionId` —— 用户在这里发第一句追问时会在新会话下建 job，随后就出现在左侧。
   */
  const handleForked = useCallback((newSessionId: string): void => {
    setTab('console')
    setSessionId(newSessionId)
    setSelectedJobId(null)
    setRefreshKey(k => k + 1)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">LA</span>
          <span>lite-ai 值班台</span>
        </div>

        <nav className="nav">
          <button
            aria-current={tab === 'console' ? 'page' : undefined}
            onClick={() => setTab('console')}
          >
            控制台
          </button>
          <button
            aria-current={tab === 'alerts' ? 'page' : undefined}
            onClick={() => setTab('alerts')}
          >
            告警诊断
          </button>
          <button
            aria-current={tab === 'usage' ? 'page' : undefined}
            onClick={() => setTab('usage')}
          >
            审计用量
          </button>
        </nav>

        <span className="topbar-spacer" />

        {hasKey ? (
          <button
            className="btn small"
            onClick={() => {
              setApiKey(null)
              setHasKey(false)
              setGateOpen(true)
            }}
          >
            切换密钥
          </button>
        ) : null}
      </header>

      <div className="body">
        {tab === 'console' ? (
          <>
            <SessionList
              selectedSessionId={sessionId ?? null}
              onSelect={selectSession}
              onForked={handleForked}
              refreshKey={refreshKey}
              onUnauthorized={handleUnauthorized}
            />
            <main className="main">
              {selectedJobId !== null ? (
                <InvestigationStream key={selectedJobId} jobId={selectedJobId} />
              ) : (
                <div className="empty">
                  从左侧选择一次调查，或在下方发起新的排查
                  <span className="empty-hint">
                    告警自动诊断会在列表里出现，点开即可看到完整调查过程
                  </span>
                </div>
              )}
              <ChatInput
                sessionId={sessionId}
                onUnauthorized={handleUnauthorized}
                onSubmitted={result => {
                  setSelectedJobId(result.jobId)
                  setSessionId(result.sessionId)
                  setRefreshKey(k => k + 1)
                }}
              />
            </main>
          </>
        ) : null}

        {tab === 'alerts' ? (
          <main className="main">
            <AlertView onOpenJob={openJob} onUnauthorized={handleUnauthorized} />
          </main>
        ) : null}

        {tab === 'usage' ? (
          <main className="main">
            <UsageView onOpenJob={openJob} onUnauthorized={handleUnauthorized} />
          </main>
        ) : null}
      </div>

      {gateOpen ? (
        <AuthGate
          onDone={() => {
            setHasKey(true)
            setGateOpen(false)
          }}
          onCancel={
            getApiKey() !== null
              ? () => {
                  setGateOpen(false)
                }
              : undefined
          }
        />
      ) : null}
    </div>
  )
}

/** 密钥输入遮罩。 */
function AuthGate({
  onDone,
  onCancel,
}: {
  onDone: () => void
  onCancel?: () => void
}): React.ReactElement {
  const [value, setValue] = useState('')

  const submit = (): void => {
    const v = value.trim()
    if (v.length === 0) return
    setApiKey(v)
    onDone()
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <h2>访问密钥</h2>
        <p>
          值班台需要 API key 才能读取调查数据。密钥<strong>仅保存在当前页面内存</strong>
          中，刷新后需重新输入。
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          placeholder="粘贴访问密钥…"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
          }}
        />
        <div className="gate-actions">
          {onCancel !== undefined ? (
            <button className="btn" onClick={onCancel}>
              取消
            </button>
          ) : null}
          <button className="btn primary" onClick={submit} disabled={value.trim().length === 0}>
            进入
          </button>
        </div>
      </div>
    </div>
  )
}
