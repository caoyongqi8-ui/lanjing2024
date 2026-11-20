import { streamMessage } from '../api/client.js'
import type { ChatModel } from '../api/types.js'
import type { Message } from './types.js'
import { getContextRounds, getReplyText } from './reply.js'

/**
 * 记忆引擎：每个会话独立的「设定 + 事实库」，纯本地 IndexedDB，随请求注入、剧情推进时异步抽取沉淀。
 *
 * - 设定(setting)：开局写一次的世界观/规则，作为 system 注入，每次请求都带。
 * - 事实(facts)：自然语言短句，从回复中抽取累积，检索后按相关性+时间注入。
 * - 触发式抽取：满足条件才调一次轻量抽取，正常闲聊轮次零额外 token。
 */

/** 单条事实 */
export type MemoryFact = {
  text: string
  createdAt: number
}

/** 一个会话的记忆记录（IndexedDB memories 表的值） */
export type SessionMemory = {
  id: string
  setting: string
  facts: MemoryFact[]
}

const emptyMemory = (id: string): SessionMemory => ({ id, setting: '', facts: [] })

const FACT_CAP = 200
/** 注入请求时，最多携带的事实条数 */
export const FACT_INJECT_LIMIT = 8
/** 触发抽取的最小回复长度（字符） */
const EXTRACT_MIN_LENGTH = 120

const EXTRACT_MODEL: ChatModel = 'deepseek-flash'

/** 触发式抽取的信号词（用户输入里出现即触发） */
const TRIGGER_WORDS = [
  '存档',
  '记住',
  '记下',
  '获得',
  '得到',
  '捡到',
  '拾取',
  '击杀',
  '打败',
  '击败',
  '出发',
  '前往',
  '离开',
  '遇到',
  '遇到',
  '遇见',
  '给了',
  '交给',
  '买了',
  '卖掉',
  '学会',
  '升级',
  '提升',
  '好感',
  '委托',
  '任务',
  '线索',
  '装备',
  '武器',
  '剧情',
]

const matchTrigger = (text: string): boolean =>
  TRIGGER_WORDS.some((word) => text.includes(word))

/**
 * 判断本轮是否应触发「记忆抽取」。
 * - 手动触发（force）恒为真；
 * - 否则：用户输入含信号词，或回复文本较长（视为有实质剧情推进）。
 */
export const shouldExtract = (question: string, replyText: string, force = false): boolean =>
  force || matchTrigger(question) || replyText.length >= EXTRACT_MIN_LENGTH

/** 简单中文分词：按非字母数字下划线切分，去掉过短词与停用词。 */
const tokenize = (text: string): string[] => {
  const stop = new Set([
    '的',
    '了',
    '是',
    '在',
    '我',
    '你',
    '他',
    '她',
    '它',
    '这',
    '那',
    '和',
    '与',
    '或',
    '就',
    '都',
    '很',
    '也',
    '有',
    '吗',
    '呢',
    '吧',
    '啊',
    '一个',
    '这个',
    '那个',
    '什么',
    '怎么',
  ])
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 2 && !stop.has(token))
}

/**
 * 从事实库中检索与问题最相关的事实：关键词重叠得分 + 时间衰减，取前 limit 条。
 * 纯前端计算，不调网络。
 */
export const retrieveFacts = (
  facts: MemoryFact[],
  question: string,
  limit = FACT_INJECT_LIMIT
): MemoryFact[] => {
  if (facts.length === 0) {
    return []
  }
  const queryTokens = new Set(tokenize(question))
  const now = Date.now()
  const scored = facts.map((fact, index) => {
    const tokens = tokenize(fact.text)
    const overlap = tokens.filter((token) => queryTokens.has(token)).length
    // 时间衰减：约 7 天一个半衰期
    const ageDays = (now - fact.createdAt) / 86400000
    const recency = 1 / (1 + ageDays / 7)
    // 位置靠后（越新）略加权，鼓励新事实
    const score = overlap * 3 + recency * 1 + (index / facts.length) * 0.5
    return { fact, score }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.fact)
}

/** 组装注入 system 的段落 */
export const buildSystemPrompt = (
  base: string,
  memory: SessionMemory,
  question: string
): string => {
  const parts: string[] = [base]
  if (memory.setting.trim()) {
    parts.push(`\n【当前游戏的设定】\n${memory.setting.trim()}`)
  }
  const facts = retrieveFacts(memory.facts, question)
  if (facts.length > 0) {
    parts.push(
      `\n【此前已发生的关键事实（请记住并遵循，不要矛盾）】\n${facts
        .map((fact) => `- ${fact.text}`)
        .join('\n')}`
    )
  }
  return parts.join('\n')
}

/**
 * 调用一次轻量请求，从回复文本中提取新事实。
 * 失败静默返回空数组（不影响主对话）。
 */
export const extractFacts = async (
  apiKey: string,
  sessionText: string,
  existingFacts: string[]
): Promise<string[]> => {
  if (!apiKey || !sessionText.trim()) {
    return []
  }
  const existingBlock = existingFacts.length > 0 ? `\n已有事实（避免重复）：\n${existingFacts.join('\n')}` : ''
  const prompt = `从下面这段文字冒险游戏的内容中，提取出本会话产生的新关键事实。要求：
1. 每条一行，用简短陈述句，只记客观事实（角色、物品、地点、事件、状态、关系），不记 AI 的客套话。
2. 与「已有事实」重复或无关紧要的不要输出。
3. 没有新事实就输出空。
${existingBlock}

内容如下：
${sessionText.slice(0, 6000)}`

  try {
    const events = streamMessage(
      apiKey,
      {
        model: EXTRACT_MODEL,
        system: '你是一个事实提取助手，只输出事实列表。',
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
        safety_check: { level: 'high' },
        tools: [],
      },
      new AbortController().signal
    )
    let text = ''
    for await (const event of events) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }
    return text
      .split('\n')
      .map((line) => line.replace(/^[-*·\s\d.、]+/, '').trim())
      .filter((line) => line.length >= 4 && line.length <= 200)
  } catch {
    return []
  }
}

/** 把一个会话的对话文本抽取成一句「世界观/题材设定」。失败返回空串。 */
export const extractSetting = async (apiKey: string, conversation: string): Promise<string> => {
  if (!apiKey || !conversation.trim()) {
    return ''
  }
  const prompt = `根据下面这段文字冒险游戏的对话，用一两句话概括它的题材、世界观和基本设定（如时代背景、主要角色身份、整体风格），用于之后长期记住这个游戏。直接输出概括即可。

内容如下：
${conversation.slice(0, 3000)}`
  try {
    const events = streamMessage(
      apiKey,
      {
        model: EXTRACT_MODEL,
        system: '你是一个设定概括助手，只输出简短概括。',
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
        safety_check: { level: 'high' },
        tools: [],
      },
      new AbortController().signal
    )
    let text = ''
    for await (const event of events) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }
    return text.trim().slice(0, 500)
  } catch {
    return ''
  }
}

/** 把抽取到的事实去重后合并进记忆，维护时间戳。 */
export const mergeFacts = (
  memory: SessionMemory,
  incoming: string[],
  now = Date.now()
): SessionMemory => {
  if (incoming.length === 0) {
    return memory
  }
  const existing = new Set(memory.facts.map((fact) => fact.text))
  const added: MemoryFact[] = []
  for (const text of incoming) {
    if (!existing.has(text)) {
      existing.add(text)
      added.push({ text, createdAt: now })
    }
  }
  if (added.length === 0) {
    return memory
  }
  const facts = [...memory.facts, ...added]
  // 超过上限时，按时间从最旧的开始裁剪
  return { ...memory, facts: facts.slice(-FACT_CAP) }
}

/** 从会话消息里提取「用户输入 + AI 回复」的成对文本，用于导入后批量生成记忆。 */
export const sessionConversationText = (messages: Message[]): string[] => {
  const chunks: string[] = []
  for (const [user, reply] of getContextRounds(messages)) {
    const replyText = getReplyText(reply)
    if (user.content.trim()) {
      chunks.push(`玩家：${user.content.trim()}`)
    }
    if (replyText.trim()) {
      chunks.push(`主持人：${replyText.trim().slice(0, 2000)}`)
    }
  }
  return chunks
}

export { emptyMemory }

/**
 * 从 db 读取、写入会话记忆。为保持纯函数式与 db 解耦，这里只导出类型与纯逻辑；
 * 实际的 IndexedDB 读写由 db.ts 提供（loadSessionMemory / saveSessionMemory / deleteSessionMemory）。
 */
export const normalizeMemory = (value: Partial<SessionMemory> | undefined, id: string): SessionMemory => ({
  id,
  setting: typeof value?.setting === 'string' ? value.setting : '',
  facts: Array.isArray(value?.facts)
    ? value.facts.filter(
        (fact): fact is MemoryFact =>
          typeof fact.text === 'string' && typeof fact.createdAt === 'number'
      )
    : [],
})
