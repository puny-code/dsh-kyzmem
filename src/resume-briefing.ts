/**
 * `[RESUME]` 恢复简报（方案 §7 采纳项 D）：把「上一个会话留下了什么」放回开场。
 *
 * 素材一直都在——`session_summaries` 表（schema v9 起，摄取期由辅助 LLM 生成的一句话
 * 摘要）与「今日待回忆」计数都已经在库里，缺的只是开场那三行。模型自己不会想起来去查
 * 「上次聊到哪了」，而记忆插件最该回答的第一个问题恰恰是这个。
 *
 * 取舍：
 *  - **只用已落库的数据**：摘要取 `session_summaries` 最近一条（`latestSessionSummary`），
 *    due 数与 pending 摄取数复用既有计数。不为这段简报新增任何采集链路，也不起 LLM。
 *  - **整块有硬上限**（`resumeBriefingChars`，默认 200）：这是每会话都要付的固定成本，
 *    不能因为某条摘要特别长就把开场撑爆。超限先压摘要、再丢计数行、最后硬截断。
 *  - **每会话一次**，压缩（compaction）会把注入的快照摘要掉，与画像/首问召回同一判据：
 *    出现新的压缩事件时允许再注入一次。
 *  - **项目库不存在就不注入**（调用方用 `openProjectStoreIfExists`）：不为一次性 cwd 建空库。
 *
 * @module dsh-kyzmem/resume-briefing
 */

import type { KyzmemLanguage } from './i18n/language.ts'
import { messageIn } from './i18n/messages.ts'
import { truncateItem } from './retrieve/budget.ts'

/** `[RESUME]` 小节整块字符上限的缺省值（配置 `resumeBriefingChars`）。 */
export const RESUME_BRIEFING_CHARS_DEFAULT = 200

/**
 * 项目分库打开/查询的时间预算。
 *
 * 这是「别在这里挂死」的护栏，不是延迟目标：热路径实测开库 8–30ms（建表校验 + 一次
 * `session_summaries` 查询），但冷启动实测能到 200–500ms（同批还压着旧库导入、迁移检查、
 * 首轮排桩）。取 200ms 时简报会随机缺席——「有摘要必注入」的测试实测 3 条挂 2 条，
 * 而这恰恰是最伤的状态：功能看起来在，只是时有时无。首问召回那 30ms 的口径是给
 * 「可有可无」的召回用的，不该套在「上次聊到哪」上（方案 §7 D 把它当开场固定项）。
 * 500ms 是「一次会话只付一次」的上限：超过就当作没有简报，绝不拖住首轮请求。
 */
export const RESUME_PROJECT_OPEN_MS = 500

/** 摘要正文的字符上限（超出截断；整块上限再压时会更短）。 */
export const RESUME_SUMMARY_MAX_CHARS = 120

/** 压预算时摘要的下限：再短就只剩一行没有信息量的标题。 */
export const RESUME_SUMMARY_FLOOR_CHARS = 24

/**
 * 是否该在本步注入恢复简报。
 * 同一 agent 每次会话只注入一次（`resumeAgent`）；压缩后允许再注入一次——与首问召回同口径。
 */
export interface ResumeBriefingGate {
  /** 配置开关 `resumeBriefing`。 */
  readonly enabled: boolean
  /** 当前 agent（= 会话）标识。 */
  readonly agentId: string
  /** 上次注入简报时的 agent id；null = 本会话还没注过。 */
  readonly resumeAgent: string | null
  /** 上次注入时观察到的压缩计数；null = 还没注过。 */
  readonly resumeCompactions: number | null
  /** 本步观察到的压缩计数。 */
  readonly compactionCount: number
}

/**
 * 判断本步是否该注入 `[RESUME]`。
 * @param gate - 会话/配置状态。
 * @returns 该注入返回 true。
 */
export function shouldRunResumeBriefing(gate: ResumeBriefingGate): boolean {
  if (!gate.enabled) return false
  if (gate.resumeAgent !== gate.agentId) return true
  return gate.resumeCompactions !== null && gate.compactionCount > gate.resumeCompactions
}

/** 渲染输入：素材全部来自已落库的数据。 */
export interface ResumeBriefingInput {
  /** 上一条会话的一句话摘要。 */
  readonly summary: string
  /** 该摘要的最后写入时刻（简报里的日期锚点）。 */
  readonly updatedAt: number
  /** 今日待回忆条数（user + project 合并，已在调用方算好）。 */
  readonly due: number
  /** 未清 pending 摄取轮数；拿不到时传 0（该行省略）。 */
  readonly pendingIngests: number
  /** 整块字符上限（配置 `resumeBriefingChars`）。 */
  readonly chars: number
  /** 渲染语言。 */
  readonly language: KyzmemLanguage
}

/**
 * 渲染 `[RESUME]` 小节。
 *
 * 版式（三行，后两行按非零才出现）：
 * ```
 * [RESUME] 上次会话（2026-10-20）：……
 * 今日待回忆 3 条
 * 上次未完成摄取 2 条
 * ```
 * 预算从紧到松依次让位：截断摘要 → 丢掉计数行 → 硬截断整块。摘要正文先归一为单行
 * （多行摘要会把版式打散，也会让「一行一条」的预算失真）。
 * @param input - 摘要、计数、预算与语言。
 * @returns 渲染好的小节（可能为空串：摘要本身为空时）。
 */
export function renderResumeBriefing(input: ResumeBriefingInput): string {
  const line = input.summary.replace(/\s+/gu, ' ').trim()
  if (line === '') return ''
  const date = new Date(input.updatedAt).toISOString().slice(0, 10)
  const cap = Math.max(RESUME_SUMMARY_FLOOR_CHARS, Math.floor(input.chars))
  let extras: string[] = []
  if (input.due > 0) extras.push(messageIn(input.language, 'core.resumeDue', { count: input.due }))
  if (input.pendingIngests > 0) {
    extras.push(messageIn(input.language, 'core.resumePendingIngest', { count: input.pendingIngests }))
  }
  const render = (summary: string): string =>
    [messageIn(input.language, 'core.resumeHeader', { date, summary }), ...extras].join('\n')

  let summary = truncateItem(line, RESUME_SUMMARY_MAX_CHARS)
  let block = render(summary)
  if (block.length > cap) {
    // 先压摘要：计数行是十几二十个字符的小字，摘要是唯一能大幅伸缩的部分。
    const overhead = block.length - summary.length
    const room = Math.max(RESUME_SUMMARY_FLOOR_CHARS, cap - overhead - 1)
    summary = truncateItem(line, room)
    block = render(summary)
  }
  if (block.length > cap) {
    // 摘要压到底还超（语言特别长/预算特别小）：按「后加的先生」丢掉计数行。
    while (extras.length > 0 && block.length > cap) {
      extras = extras.slice(0, -1)
      block = render(summary)
    }
  }
  if (block.length > cap) block = `${block.slice(0, Math.max(0, cap - 1))}…`
  return block
}


