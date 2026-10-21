/**
 * 翻新清单：每周扫描 active 条目，按规则生成建议（合并 / 迁移 / 降级 / 拆分）。
 * 建议不直接执行，仅生成预览；UI 或 kyzmem_audit_refurb 工具读取预览，用户逐条确认。
 * @module dsh-kyzmem/refurb
 */

import type { ConflictPair, KyzmemScope, MemoryRecord } from './types.ts'
import type { KyzmemLanguage } from './i18n/language.ts'
import { roomLabel } from './i18n/rooms.ts'
import { messageIn } from './i18n/messages.ts'

/** 单条翻新建议的动议。 */
export type RefurbAction = 'merge' | 'demote' | 'review' | 'split'

/** 一条翻新建议。 */
export interface RefurbSuggestion {
  readonly action: RefurbAction
  /** 主要记忆 id（用户确认后聚焦此 id）。 */
  readonly primaryId: string
  /** 合并场景：候选副本 id 列表。 */
  readonly candidates: readonly string[]
  readonly scope: KyzmemScope
  /** 给 agent / 用户的决策理由（中文，≤80 字）。 */
  readonly reason: string
  /** 建议置信度 0-1（高 = 强烈建议立即执行；低 = 仅提示）。 */
  readonly confidence: number
}

/** 翻新参数（按需调阈值；缺省用历史经验值）。 */
export interface RefurbOptions {
  /** active 条目少于该数时不出任何建议（默认 8）：小库样本太少，逐条命中噪声大于价值。 */
  readonly minActive: number
  /** importance 低于该值的 active 条目建议降级（默认 0.2）。 */
  readonly demoteBelow: number
  /** lastAccessedAt 早于该天数的条目建议复习（默认 60）。 */
  readonly staleDays: number
  /** 同 scope 中同 kind 内容前 20 字相同的对子建议合并（默认 0）。 */
  readonly duplicateTitleWindow: number
}

/** 缺省参数。 */
export const DEFAULT_REFURB_OPTIONS: RefurbOptions = {
  minActive: 8,
  demoteBelow: 0.2,
  staleDays: 60,
  duplicateTitleWindow: 0,
}

/** 冲突对超过该天数仍未裁决 → 升级为高优先建议（长期不处理说明两条信念在打架）。 */
export const CONFLICT_ESCALATE_DAYS = 30

/**
 * 待裁决冲突 → 高优先「review」建议（合并候选的另一来源：contradicts 边）。
 * 冲突是检索期就会误导 agent 的硬伤，因此即便库很小（未达 minActive）也要提示。
 * 30 天未裁决的升级：置信度 0.9（普通冲突 0.75），排在面板列表前列。
 * @param conflicts - store.listConflicts 返回的冲突对。
 * @param language - 理由文案语言。
 * @param now - 当前时间（测试可注入）。
 */
export function gatherConflictSuggestions(
  conflicts: readonly ConflictPair[],
  language: KyzmemLanguage,
  now: number = Date.now(),
): readonly RefurbSuggestion[] {
  const suggestions: RefurbSuggestion[] = []
  for (const pair of conflicts) {
    const days = Math.max(0, Math.floor((now - pair.createdAt) / 86_400_000))
    const escalated = days >= CONFLICT_ESCALATE_DAYS
    suggestions.push({
      action: 'review',
      primaryId: pair.left.id,
      candidates: [pair.right.id],
      // 冲突对跨 scope 时以左条目的 scope 为准（面板按它分流到对应宫殿列表）。
      scope: pair.left.scope,
      reason: escalated
        ? messageIn(language, 'misc.refurbConflictEscalatedReason', { days })
        : messageIn(language, 'misc.refurbConflictReason', { days }),
      confidence: escalated ? 0.9 : 0.75,
    })
  }
  return suggestions
}

/**
 * 扫描一组 active 条目，按规则生成翻新建议。
 * 仅扫描同 scope 内的内容；跨 scope 的相似合并留给上层判定。
 * active 条目少于 `options.minActive` 时返回空列表：小库样本太少，逐条命中噪声大于价值。
 * 冲突对（contradicts 边）是独立来源：即使小库也给出 review 建议（见 gatherConflictSuggestions）。
 * @param records - 候选条目。
 * @param language - 房间名的显示语言（房间里存的是标识符，不是文本）。
 * @param options - 阈值（缺省用 DEFAULT_REFURB_OPTIONS）。
 * @param conflicts - 待裁决冲突对（store.listConflicts）；缺省不出冲突建议（向后兼容）。
 * @param now - 当前时间（测试可注入）。
 */
export function gatherRefurbSuggestions(
  records: readonly MemoryRecord[],
  language: KyzmemLanguage,
  options: RefurbOptions = DEFAULT_REFURB_OPTIONS,
  conflicts: readonly ConflictPair[] = [],
  now: number = Date.now(),
): readonly RefurbSuggestion[] {
  // 冲突建议排最前：它是「检索会答错」的硬伤，优先级高于门牌/拆分等整理项。
  const suggestions: RefurbSuggestion[] = [...gatherConflictSuggestions(conflicts, language, now)]
  const active = records.filter(r => r.status === 'active')
  // 小库早退：样本太少时（尤其门牌规则）几乎逐条命中，噪声大于价值。
  if (active.length < options.minActive) return suggestions
  const byScope = new Map<KyzmemScope, MemoryRecord[]>()
  for (const record of active) {
    const list = byScope.get(record.scope) ?? []
    list.push(record)
    byScope.set(record.scope, list)
  }
  // 规则 1：低重要性 + 长期未访问 → 降级。
  for (const record of active) {
    const daysSinceAccess = (now - record.lastAccessedAt) / 86_400_000
    if (record.importance < options.demoteBelow && daysSinceAccess > options.staleDays) {
      suggestions.push({
        action: 'demote',
        primaryId: record.id,
        candidates: [],
        scope: record.scope,
        reason: messageIn(language, 'misc.refurbDemoteReason', {
          importance: record.importance.toFixed(2),
          threshold: options.demoteBelow,
          days: Math.floor(daysSinceAccess),
        }),
        confidence: 0.7,
      })
    }
  }
  // 规则 2：同 scope 同 kind 且内容前缀重复 → 合并候选。
  for (const [scope, list] of byScope) {
    const byKind = new Map<string, MemoryRecord[]>()
    for (const record of list) {
      const bucket = byKind.get(record.kind) ?? []
      bucket.push(record)
      byKind.set(record.kind, bucket)
    }
    for (const [, items] of byKind) {
      if (items.length < 2) continue
      const seen = new Set<string>()
      for (const record of items) {
        const key = record.content.slice(0, 20)
        if (seen.has(key)) continue
        seen.add(key)
        const dupes = items.filter(other => other.id !== record.id && other.content.startsWith(key))
        if (dupes.length > 0) {
          suggestions.push({
            action: 'merge',
            primaryId: record.id,
            candidates: dupes.map(d => d.id),
            scope,
            reason: messageIn(language, 'misc.refurbMergeReason', { count: dupes.length }),
            confidence: 0.6,
          })
        }
      }
    }
  }
  // 规则 3：从未访问但重要性 ≥ 0.7 → 复习（用户可能忘记这条）。
  for (const record of active) {
    if (record.accessCount === 0 && record.importance >= 0.7) {
      suggestions.push({
        action: 'review',
        primaryId: record.id,
        candidates: [],
        scope: record.scope,
        reason: messageIn(language, 'misc.refurbReviewReason', { importance: record.importance.toFixed(2) }),
        confidence: 0.5,
      })
    }
  }
  // 规则 4：content 长度 > 400 → 拆分。
  for (const record of active) {
    if (record.content.length > 400) {
      suggestions.push({
        action: 'split',
        primaryId: record.id,
        candidates: [],
        scope: record.scope,
        reason: messageIn(language, 'misc.refurbSplitReason', { length: record.content.length }),
        confidence: 0.6,
      })
    }
  }
  // 规则 5（门牌纪律）：无门牌或门牌分 < 0.5 → 补挂/重写铭牌（唯一 · 差异化 · 带日期）。
  for (const record of active) {
    const score = record.imageryScore
    if (score !== undefined && score >= 0.5) continue
    const slot = record.slot === undefined ? '' : `${roomLabel(record.slot.room, language)}#${record.slot.index} `
    suggestions.push({
      action: 'review',
      primaryId: record.id,
      candidates: [],
      scope: record.scope,
      reason: score === undefined
        ? messageIn(language, 'misc.refurbNoPlacardReason', { slot })
        : messageIn(language, 'misc.refurbLowPlacardReason', { slot, score: score.toFixed(2) }),
      confidence: 0.4,
    })
  }
  return suggestions
}