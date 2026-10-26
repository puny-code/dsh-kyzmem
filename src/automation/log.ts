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

/** 自动动作的审计 op 名：`auto-action` = 已生效；`auto-proposed` = 影子期只记录。 */
export type AutoAuditOp = 'auto-action' | 'auto-proposed'

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
}

/**
 * 写一条自动动作审计。只做 JSON 拼装 + `store.audit`，不做任何决策；
 * detail 键缺失由调用方保证（类型必填），这里不二次校验。
 */
export async function logAutoAction(store: KyzmemStore, entry: AutoActionEntry): Promise<void> {
  const { op, ...detail } = entry
  await store.audit(op, 'BATCH', JSON.stringify(detail))
}
