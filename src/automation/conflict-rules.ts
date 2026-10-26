/**
 * 冲突规则自动裁决（方案 1，高置信子集）。
 *
 * 只处理「可判定的不对称」两种情形，其余一律弃权（`r-abstain`），宁可漏过也不误伤：
 * - R1 `r-tier`：一方 user-confirmed、另一方非确认 → 归档非确认方；
 * - R2 `r-newer`：同 scope＋同 kind（仅 preference|decision）＋实体交集非空＋创建时间差
 *   ≥ 30 天＋新者 importance/confidence 双高且差值 ≥ 0.15 → 归档旧者。
 *
 * 实体名由调用方提供（store.entitiesOfNodes），这里只做归一化交集
 * （normalizeEntityName：trim + 压空白 + 小写）。
 *
 * @module dsh-kyzmem/automation-conflict-rules
 */
import { normalizeEntityName } from '../types.ts'
import type { ConflictPair, KyzmemSourceTier } from '../types.ts'

/** 年龄差门槛：30 天（毫秒）。 */
export const RULE_NEWER_MIN_AGE_MS = 30 * 24 * 3600 * 1000
/** 新者双高差值门槛：importance 与 confidence 都要高出至少 0.15。 */
export const RULE_NEWER_MIN_GAP = 0.15
/** R2 只看这两类 kind：事实类（fact/episode/skill）的新旧关系不由时间决定。 */
const RULE_NEWER_KINDS = new Set(['preference', 'decision'])

/** 低可信来源：user-confirmed 之外都算（缺省视为 agent-inferred）。 */
function isLowTier(tier: KyzmemSourceTier | undefined): boolean {
  return tier === undefined || tier !== 'user-confirmed'
}

export type RuleAction = 'archive-left' | 'archive-right' | 'none'
export type RuleId = 'r-tier' | 'r-newer' | 'r-abstain'
export interface RuleVerdict {
  readonly action: RuleAction
  readonly ruleId: RuleId
}

/** 调用方提供的双方实体名（原始写法即可，内部归一化后再交集）。 */
export interface RuleEntityHints {
  readonly left: readonly string[]
  readonly right: readonly string[]
}

/**
 * 对一对待裁决冲突做规则裁决。
 * @returns 归档哪一端（或弃权）+ 命中规则 id（审计与撤销用）。
 */
export function ruleVerdict(pair: ConflictPair, entities?: RuleEntityHints): RuleVerdict {
  const { left, right } = pair
  // R1：确认过的赢——只有「一方确认、另一方没确认」才判；双确认、双非确认都弃权。
  if (left.sourceTier === 'user-confirmed' && isLowTier(right.sourceTier)) {
    return { action: 'archive-right', ruleId: 'r-tier' }
  }
  if (right.sourceTier === 'user-confirmed' && isLowTier(left.sourceTier)) {
    return { action: 'archive-left', ruleId: 'r-tier' }
  }
  // R2：新者胜——四个条件缺一弃权。
  if (
    left.scope === right.scope
    && left.kind === right.kind
    && RULE_NEWER_KINDS.has(left.kind)
    && entities !== undefined
  ) {
    const leftNames = new Set(entities.left.map(normalizeEntityName))
    const shared = entities.right.some(name => leftNames.has(normalizeEntityName(name)))
    if (shared) {
      const older = left.createdAt <= right.createdAt ? left : right
      const newer = older === left ? right : left
      const archiveLeft = older === left
      if (
        newer.createdAt - older.createdAt >= RULE_NEWER_MIN_AGE_MS
        && newer.importance - older.importance >= RULE_NEWER_MIN_GAP
        && newer.confidence - older.confidence >= RULE_NEWER_MIN_GAP
      ) {
        return { action: archiveLeft ? 'archive-left' : 'archive-right', ruleId: 'r-newer' }
      }
    }
  }
  return { action: 'none', ruleId: 'r-abstain' }
}
