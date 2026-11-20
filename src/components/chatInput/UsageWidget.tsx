import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { getBalance } from '../../services/api/client.js'
import { useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { useSettings } from '../../services/settings.js'

/**
 * 用量小圆圈：点开显示当前对话的上下文占用量（字符数估算）与账户余额。
 * 圆环按上下文占用比例绘制。
 */

/** 上下文窗口估算（token 数），deepseek 常见为 64k */
const CONTEXT_LIMIT = 64 * 1024

/** 粗略估算 token：中文按每字 1 token、连续 ASCII 按约 4 字符 1 token */
const estimateTokens = (text: string): number => {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const ascii = text.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '').length
  return cjk + Math.ceil(ascii / 4)
}

const round = (value: number) => Math.round((value / 1024) * 10) / 10

export const UsageWidget = () => {
  const t = useTranslate()
  const activeId = useChatStore((state) => state.activeId)
  const sessionCache = useChatStore((state) => state.sessionCache)
  const apiKey = useSettings((state) => state.apiKey)
  const [open, setOpen] = useState(false)
  const [balance, setBalance] = useState<string | null>(null)
  const [balanceFailed, setBalanceFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 当前会话的可见消息总字符数
  const session = activeId ? sessionCache[activeId] : undefined
  const tokens = session
    ? estimateTokens(getVisibleMessages(session).map((m) => (m.role === 'user' ? m.content : '')).join(''))
    : 0
  const ratio = Math.min(1, tokens / CONTEXT_LIMIT)

  const queryBalance = useCallback(async () => {
    if (!apiKey) {
      return
    }
    setBalanceFailed(false)
    try {
      const result = await getBalance(apiKey)
      const cny = result.balance_infos.find((item) => item.currency === 'CNY')
      const usd = result.balance_infos.find((item) => item.currency === 'USD')
      const parts: string[] = []
      if (cny) {
        parts.push(`¥${cny.total_balance}`)
      }
      if (usd) {
        parts.push(`$${usd.total_balance}`)
      }
      setBalance(parts.join(' · ') || t('balanceUnavailable'))
    } catch {
      setBalanceFailed(true)
    }
  }, [apiKey, t])

  // 打开时查询余额
  useEffect(() => {
    if (open) {
      void queryBalance()
    }
  }, [open, queryBalance])

  // 点击外部关闭
  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const percent = Math.round(ratio * 100)

  return (
    <div ref={rootRef} className={clsx('ds-usage-widget')}>
      <button
        type="button"
        className="ds-usage-ring"
        aria-label={t('balanceLabel')}
        onClick={() => setOpen((value) => !value)}
        style={
          {
            '--ratio': `${ratio}`,
          } as React.CSSProperties
        }
      >
        <span className="ds-usage-ring-inner" />
      </button>
      {open ? (
        <div className="ds-usage-panel">
          <div className="ds-usage-row">
            <span>{t('balanceLabel')}</span>
            <span className="ds-usage-value">
              {balanceFailed ? t('balanceFailed') : balance ?? t('balanceLoading')}
            </span>
          </div>
          <div className="ds-usage-row">
            <span>{t('contextUsage')}</span>
            <span className="ds-usage-value">
              {round(tokens)}k / {CONTEXT_LIMIT / 1024}k
            </span>
          </div>
          <div className="ds-usage-bar">
            <div className="ds-usage-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="ds-usage-caption">{percent}%</div>
        </div>
      ) : null}
    </div>
  )
}
