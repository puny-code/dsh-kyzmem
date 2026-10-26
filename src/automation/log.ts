/**
 * 自动动作的统一审计格式。
 *
 * 所有自动动作（冲突裁决、死信重试、复习调排、重锚、回填……）都经这里写 op_log：
 * 同一 op 名（`auto-action` 生效 / `auto-proposed` 影子），detail 必含 rule id、
 * 阈值、相似度、左右 id、批次 id、版本号。target 固定 `'BATCH'`，与既有
 * decay/conflict-resolve 的批量审计口径一致。
 *
 * @module dsh-kyzmem/automation-log
 */
import type { KyzmemStore } from '../store/interface.ts'
import type { KyzmemEdgeType, ReviewSchedule } from '../types.ts'

/** 自动动作的审计 op 名：`auto-action` = 已生效；`auto-proposed` = 影子期只记录。 */
export type AutoAuditOp = 'auto-action' | 'auto-proposed'

/** 撤销一条 supersedes/contradicts 边（无向语义，两个方向都删）。 */
export interface AutoUndoEdge {
  readonly from: string
  readonly to: string
  readonly type: KyzmemEdgeType
}

/** 撤销一次排期变更：把条目的 SM-2 四元组写回快照值。 */
export interface AutoUndoSchedule {
  readonly id: string
  readonly review: ReviewSchedule
}

/**
 * 撤销规格（随动作一起记进 detail，`undoAutoBatch` 按此回滚）。
 * 只描述「如何回到动作前」，不含任何判断逻辑。
 */
export interface AutoUndoSpec {
  /** 需要重新置 active 的条目 id（归档类动作填输家）。 */
  readonly restoreIds?: readonly string[]
  /** 需要删除的边（归档时建的 supersedes、误建的 contradicts）。 */
  readonly removeEdges?: readonly AutoUndoEdge[]
  /** 需要写回的排期快照（改排期类动作填动作前的值）。 */
  readonly restoreSchedule?: readonly AutoUndoSchedule[]
}

/** 自动动作审计条目：缺省项一律存 undefined（不进 JSON），必填 6 键缺一不可。 */
export interface AutoActionEntry {
  readonly op: AutoAuditOp
  /** 规则 id（如 `r-tier`）：定位「哪条规则干的」。 */
  readonly ruleId: string
  /** 命中时的阈值快照（如 `{ contradictMin: 0.88 }`）。 */
  readonly thresholds: Readonly<Record<string, number>>
  /** 触发相似度（无相似度的动作可省略）。 */
  readonly similarity?: number
  /** 动作涉及的左右条目 id（单条目动作可省略）。 */
  readonly leftId?: string
  readonly rightId?: string
  /** 批次 id（撤销单元：`undoAutoBatch` 按此回滚）。 */
  readonly batchId: string
  /** 插件版本（行为漂移时可按版本过滤审计）。 */
  readonly version: string
  /** 备注（如 `shadow only`）。 */
  readonly note?: string
  /** 排期类动作的回滚数据（如改排期前的 review 值）。 */
  readonly prevReview?: unknown
  /** 撤销规格：有它才能被 `undoAutoBatch` 回滚；纯标注类动作可省略。 */
  readonly undo?: AutoUndoSpec
}

/**
 * 写一条自动动作审计。只做 JSON 拼装 + `store.audit`，不做任何决策；
 * detail 键缺失由调用方保证（类型必填），这里不二次校验。
 */
export async function logAutoAction(store: KyzmemStore, entry: AutoActionEntry): Promise<void> {
  const { op, ...detail } = entry
  await store.audit(op, 'BATCH', JSON.stringify(detail))
}
