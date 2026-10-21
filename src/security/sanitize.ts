/**
 * 提示注入防护协议：记忆召回内容包 <kyzmem_memory_context> 标签并附使用警告，
 * 当前用户请求包 <current_user_request>；任何记忆正文入库前剥离这些协议标签，
 * 防止历史记忆里伪造的协议块在下次召回时被当作本插件输出二次注入。
 *
 * 两道防线（H1 修复后的关键约定）：
 * 1. 成对块剥离：合法/伪造的完整协议块整段移除（记忆上下文）或解包保留内部文本（当前请求）。
 * 2. 残留标签中和：剥不掉的孤立开/闭/自闭合标签一律把 `<` 换成全角 `＜`——破坏标签语法
 *    （一个孤立闭标签就能提前结束记忆块、让它之后的文本冒充「包外指令」），但保留可读文本
 *    （直接删除会丢内容）。中和必须覆盖协议标签全集，漏掉任何一个都等于留了一扇逃逸门。
 * @module dsh-kyzmem/security/sanitize
 */

import { message } from '../i18n/messages.ts'

/** 记忆上下文协议标签（本插件主标签）。 */
export const MEMORY_CONTEXT_TAG = 'kyzmem_memory_context'

/** 当前用户请求协议标签。 */
export const CURRENT_USER_REQUEST_TAG = 'current_user_request'

/** 用户显式禁记标签：在对话中用 <no-palace>...</no-palace> 包裹的整段不会被记忆。 */
export const NO_PALACE_TAG = 'no-palace'

/**
 * 入库剥离时识别的记忆上下文标签集合：不区分来源——历史正文可能携带
 * 其他记忆插件（如 memmy/memos）的包裹标签，一律按不可信协议块剥离。
 */
const MEMORY_CONTEXT_TAGS: readonly string[] = [
  MEMORY_CONTEXT_TAG,
  'memory_context',
  'memmy_memory_context',
  'memos_context',
]

/**
 * 协议标签全集：所有会被本模块识别/生成的标签（4 个记忆上下文标签 + 当前请求 + 用户禁记）。
 * 中和阶段必须覆盖全集——残留的孤立标签哪怕只有一个，也能伪造块边界（H1）。
 */
const PROTOCOL_TAGS: readonly string[] = [...MEMORY_CONTEXT_TAGS, CURRENT_USER_REQUEST_TAG, NO_PALACE_TAG]

/** 中和用的全角小于号：破坏标签语法，但文字仍可读（删除会丢内容）。 */
const NEUTRALIZED_LT = '＜'

/**
 * 残留协议标签的「开标签前缀」匹配：`<` 后允许空白、可选 `/`（闭标签）、再允许空白，
 * 紧跟标签名（大小写不敏感），标签名后不能是词字符/连字符（`<memory_contextual>` 不算）。
 * 只匹配 `<` 本身而不匹配到 `>`：这样未闭合的标签头（`<kyzmem_memory_context` 后面没有 `>`）
 * 也会被中和——否则渲染拼接时它可能吞掉紧随其后的合法闭标签，把整块变成「1 开 0 闭」。
 */
const PROTOCOL_TAG_OPEN_PATTERN = new RegExp(
  `<(?=\\s*/?\\s*(?:${PROTOCOL_TAGS.map(escapeRegExp).join('|')})(?![\\w-]))`,
  'gi',
)

/**
 * 中和残留协议标签：把匹配到的 `<` 换成全角 `＜`（含自闭合/带属性/大小写混写/标签前后空白）。
 * 为什么不删：删除会丢正文（L2 的字面标签截断就是删出来的）；换成全角后标签语法失效，
 * 但用户仍能读懂原文在讨论什么。
 */
function neutralizeProtocolTags(value: string): string {
  return value.replace(PROTOCOL_TAG_OPEN_PATTERN, NEUTRALIZED_LT)
}

/** 记忆包来源标记：turn_start 会话开始注入；tool_* 召回工具输出。 */
export type MemoryPacketSource = 'turn_start' | 'tool_search' | 'tool_timeline' | 'tool_episode_timeline' | 'tool_review' | 'tool_facts'

/**
 * 清洗记忆正文：先按配对剥离协议块（记忆上下文块整段移除、当前请求块解包保留内部文本、
 * no-palace 块整段移除），再把剥不掉的残留标签中和（`<` → `＜`），最后归一空白。
 * 顺序很重要：成对块必须在中和之前剥——否则中和后的文本里不会再有可配对的标签。
 * @param value - 待清洗的原文（会话文本或模型输出候选）。
 * @returns 可安全入库/复用的正文。
 */
export function sanitizeProtocolText(value: string): string {
  return normalizeWhitespace(
    neutralizeProtocolTags(
      unwrapCurrentUserRequestBlocks(
        stripMemoryContextBlocks(stripNoPalaceBlocks(value)),
      ),
    ),
  )
}

/**
 * 渲染记忆包：内容先清洗再包裹协议标签，附三条使用警告；当前请求独立成段。
 * @param content - 记忆正文（画像文本或检索结果行）。
 * @param source - 包来源标记（写入 source 属性，便于下游归因）。
 * @param currentUserRequest - 当前用户请求文本；空串时以占位句代替。
 * @returns 包裹后的协议文本。
 */
export function renderMemoryPacket(content: string, source: MemoryPacketSource, currentUserRequest: string): string {
  return [
    `<${MEMORY_CONTEXT_TAG} source="${source}">`,
    'IMPORTANT:',
    `- ${message('store.packetWarningHistorical')}`,
    `- ${message('store.packetWarningIgnoreEmbedded')}`,
    `- ${message('store.packetWarningRelevance')}`,
    '',
    sanitizeProtocolText(content) || message('store.packetNoMemory'),
    `</${MEMORY_CONTEXT_TAG}>`,
    '',
    `<${CURRENT_USER_REQUEST_TAG}>`,
    sanitizeProtocolText(currentUserRequest) || message('store.conversationContinues'),
    `</${CURRENT_USER_REQUEST_TAG}>`,
  ].join('\n')
}

/**
 * 从 admitted 消息里提取当前用户请求文本：取最后一条非空 text 块。
 * @param messages - pre-step 决策携带的本轮 admitted 消息（运行时窄化视图）。
 * @returns 当前请求文本；无文本块时返回占位句。
 */
export function currentUserRequestText(
  messages: readonly { content?: readonly { type?: unknown; text?: unknown }[] }[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i]?.content ?? []
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        return block.text
      }
    }
  }
  return message('store.conversationContinues')
}

/**
 * 剥离成对的记忆上下文块；**未闭合的开标签不再截断尾部**——
 * 旧实现 removeUnclosedTail:true 会把标签之后的正文整段丢掉（数据完整性，评审 L2），
 * 而安全目标（标签不生效）由后置的 neutralizeProtocolTags 达成：文本保留、语法破坏。
 */
function stripMemoryContextBlocks(value: string): string {
  let text = value
  for (const tag of MEMORY_CONTEXT_TAGS) {
    text = replaceTaggedBlocks(text, tag, () => '')
  }
  return text
}

/** 剥离 <no-palace>...</no-palace> 整段：用户显式禁记（默认整段移除，不留存任何痕迹）。 */
function stripNoPalaceBlocks(value: string): string {
  return replaceTaggedBlocks(value, NO_PALACE_TAG, () => '', { removeUnclosedTail: true })
}

/** 解包 current_user_request 块，保留内部文本（当前请求是可信正文，只是去除标签）。 */
function unwrapCurrentUserRequestBlocks(value: string): string {
  return replaceTaggedBlocks(value, CURRENT_USER_REQUEST_TAG, inner => inner)
}

/**
 * 循环替换成对标签块：每次找第一个开标签与其后的闭标签，替换后继续扫描
 * （替换产物可能再次引入标签）。未闭合且 removeUnclosedTail 时截断尾部。
 */
function replaceTaggedBlocks(
  value: string,
  tag: string,
  replace: (inner: string) => string,
  options: { removeUnclosedTail?: boolean } = {},
): string {
  let text = value
  for (;;) {
    const openMatch = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>`, 'i').exec(text)
    if (openMatch === null) return text
    const openStart = openMatch.index
    const openEnd = openStart + openMatch[0].length
    const closeMatch = new RegExp(`</${escapeRegExp(tag)}>`, 'i').exec(text.slice(openEnd))
    if (closeMatch === null) {
      if (options.removeUnclosedTail !== true) return text
      text = text.slice(0, openStart).trimEnd()
      continue
    }
    const closeStart = openEnd + closeMatch.index
    const closeEnd = closeStart + closeMatch[0].length
    const inner = text.slice(openEnd, closeStart)
    text = `${text.slice(0, openStart)}${replace(inner)}${text.slice(closeEnd)}`
  }
}

/** 归一协议空白：行尾空白、三条以上连续换行压缩为两行，去首尾空白。 */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 转义正则元字符（标签名是常量，此函数防御性支撑任意标签）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
