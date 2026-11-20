import { useEffect, useRef, useState } from 'react'

/** 每次步进的间隔（毫秒）：越小越平滑，但 CPU 开销越大 */
const TICK_MS = 40
/** 每次步进释放的最大字符数：控制「每秒吐字」速度，接近原生 App 语速 */
const CHARS_PER_TICK = 1.0
/** 单条回复超过该字符数后，逐步加快追赶，避免长回复太久不出完 */
const SPEEDUP_THRESHOLD = 400

/**
 * 匀速逐字流式渲染：内容按固定节奏（每 TICK_MS 释放 CHARS_PER_TICK 字）渐进显示，
 * 视觉上接近原生 App 的匀速出字，而不是一簇一簇或瞬间全部出现。
 * 关闭节流（非流式）时直接返回完整内容。
 */
export const useThrottleMarkdownRender = (content: string, enable: boolean) => {
  const [output, setOutput] = useState(content)
  const shownRef = useRef(0)
  const contentRef = useRef(content)

  // 内容持续更新时记录最新长度；结束（enable 变 false）时一下子显示全部。
  useEffect(() => {
    contentRef.current = content
    if (!enable) {
      // 非流式：直接显示全部，重置进度
      shownRef.current = content.length
      setOutput(content)
    }
  }, [content, enable])

  // 流式过程中以固定节奏推进显示位置，直到追上最新内容。
  useEffect(() => {
    if (!enable) {
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const step = () => {
      const target = contentRef.current.length
      const shown = shownRef.current
      if (shown >= target) {
        // 已追上，等下一次内容到达再触发
        timer = setTimeout(step, TICK_MS)
        return
      }
      // 长回复逐步加快追赶速度，避免积压太多出不完
      const backlog = target - shown
      const perTick = CHARS_PER_TICK + Math.floor(backlog / SPEEDUP_THRESHOLD)
      let next = Math.min(target, shown + perTick)
      // 至少前进一步，确保推进
      if (next <= shown) {
        next = Math.min(target, shown + 1)
      }
      shownRef.current = next
      setOutput(contentRef.current.slice(0, next))
      timer = setTimeout(step, TICK_MS)
    }
    timer = setTimeout(step, TICK_MS)
    return () => clearTimeout(timer)
  }, [enable])

  return enable ? output : content
}
