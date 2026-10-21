/**
 * 召回输出的字符预算：单条与总量双重截断，控制记忆正文占用的模型上下文。
 *
 * 为什么分成两档上限：v0.11.0 起「召回类」输出（索引/时间线/全文检索）的单条上限
 * 由部署配置 `recallPerItem` 下发（缺省 160 字：索引视图本来就不该带整段正文），
 * 而复习历史、巡游摘要这类「给人看的过程记录」不受该配置约束，继续用较宽的
 * RENDER_PER_ITEM_CHARS。两者混用一个常量会让调小召回预算的人意外截断面板文案。
 *
 * @module dsh-kyzmem/retrieve/budget
 */

import { message } from '../i18n/messages.ts'

/** 召回类输出单条内容的最大字符数（配置 `recallPerItem` 的缺省值，160）。 */
export const RECALL_PER_ITEM_CHARS = 160

/** 单次召回输出正文的总字符预算（配置 `recallTotal` 的缺省值，4800）。 */
export const RECALL_TOTAL_CHARS = 4800

/** 非召回类（复习历史、巡游摘要等）渲染的单条上限；不跟随部署配置，保持旧行为。 */
export const RENDER_PER_ITEM_CHARS = 1200

/**
 * 截断单条文本到 maxChars（超长加省略号）。
 * @param text - 原文。
 * @param maxChars - 上限；缺省 RENDER_PER_ITEM_CHARS（非召回类旧行为）。
 */
export function truncateItem(text: string, maxChars: number = RENDER_PER_ITEM_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/**
 * 预算内的贪心装填（保序）：按 cost 逐个判断，装不下的计入 dropped 并继续试后续更短的项。
 * @param items - 候选（已按相关性排序）。
 * @param cost - 单项占用预算（字符数等）。
 * @param totalBudget - 总预算。
 * @returns 保留项与丢弃数。
 */
export function fitWithinBudget<T>(
  items: readonly T[],
  cost: (item: T) => number,
  totalBudget: number,
): { kept: T[]; dropped: number } {
  const kept: T[] = []
  let used = 0
  let dropped = 0
  for (const item of items) {
    const size = cost(item)
    if (used + size > totalBudget) {
      dropped += 1
      continue
    }
    kept.push(item)
    used += size
  }
  return { kept, dropped }
}

/**
 * 总量预算内贪心装填行（保序；某行装不下时继续尝试更短的后续行），
 * 被跳过的行计数并在末尾追加提示行。
 * @param lines - 候选行（已按相关性排序）。
 * @param totalBudget - 总字符预算，默认 RECALL_TOTAL_CHARS。
 * @returns 装填后的行；有丢弃时末尾含「另有 N 条…」提示。
 */
export function enforceBudget(lines: readonly string[], totalBudget: number = RECALL_TOTAL_CHARS): string[] {
  const { kept, dropped } = fitWithinBudget(lines, line => line.length, totalBudget)
  if (dropped > 0) kept.push(message('store.budgetDropped', { count: dropped }))
  return kept
}

/**
 * 召回类输出的单条截断（走部署配置的 `recallPerItem`）。
 * @param text - 原文。
 * @param recallPerItem - 配置值；缺省 RECALL_PER_ITEM_CHARS。
 */
export function truncateRecallItem(text: string, recallPerItem: number = RECALL_PER_ITEM_CHARS): string {
  return truncateItem(text, recallPerItem)
}
