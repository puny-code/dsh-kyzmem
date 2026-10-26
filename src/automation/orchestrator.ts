/**
 * P1.3 冲突裁决编排器：规则先行、Judge 双轨、逐条审计、日上限。
 *
 * - r-tier（一方确认、另一方没确认）→ 自动执行（keep 确认侧），输家归档，
 *   审计行带 undo（restoreIds=[输家]），批次可整体撤销。注意 undo 只恢复条目，
 *   被删的 contradicts 边不重建（重建等于把刚解决的冲突又摆回来）。
 * - r-newer / r-abstain → 人工：无 judge 直接记 auto-proposed；有 judge 则走
 *   双轨——双提示词一致性确认「左条是否已被右条取代」，一致且过线才执行，
 *   否则同样记 proposed 留给人。judge 抛错（无路由/调用失败）一律降级为
 *   proposed，不中断整批。
 * - 日上限：24h 内 conflict-rule 系 auto-action 达 20 条后，只记 proposed
 *   （skippedCap 计数）；单次最多读 5 对、最多自动执行 5 对。
 *
 * @module dsh-kyzmem/automation/orchestrator
 */
import type { KyzmemStore } from '../store/interface.ts'
import type { ConflictPair, KyzmemScope } from '../types.ts'
import { logAutoAction } from './log.ts'
import { RULE_NEWER_MIN_AGE_MS, ruleVerdict } from './conflict-rules.ts'
import type { JudgeAnswers, MemoryJudge } from '../write-disposition.ts'

/** 双提示词一致性：同一判断的正反两种问法，正反答案互补后仍应一致。 */
export interface ConsistencyPair {
  readonly id: string
  readonly negatedId: string
  readonly instructions: string
  readonly negatedInstructions: string
}

export interface ConsistentAnswers {
  readonly answers: Readonly<Record<string, number>>
  readonly abstained: readonly string[]
}

/** 正反答案互补后允许的最大差值：超过即视为模型自己都没想清楚，弃权。 */
export const CONSISTENCY_MAX_DIFF = 0.3

/**
 * 对同一组判断问两遍（正问 + 反问），互补概率差值超限的 id 弃权，
 * 通过的取两次互补值的均值。judge 抛错时直接向上抛，由调用方降级。
 */
export async function askConsistent(
  judge: MemoryJudge,
  state: string,
  pairs: readonly ConsistencyPair[],
  maxDiff: number = CONSISTENCY_MAX_DIFF,
): Promise<ConsistentAnswers> {
  const forward: JudgeAnswers = await judge.ask(
    state,
    pairs.map(pair => ({ id: pair.id, instructions: pair.instructions })),
  )
  const backward: JudgeAnswers = await judge.ask(
    state,
    pairs.map(pair => ({ id: pair.negatedId, instructions: pair.negatedInstructions })),
  )
  const answers: Record<string, number> = {}
  const abstained: string[] = []
  for (const pair of pairs) {
    const first = forward[pair.id]
    const second = backward[pair.negatedId]
    if (typeof first !== 'number' || typeof second !== 'number') {
      throw new Error(`dsh-kyzmem: judge answer for "${pair.id}" is missing in a consistency round`)
    }
    if (Math.abs(first - (1 - second)) > maxDiff) {
      abstained.push(pair.id)
      continue
    }
    answers[pair.id] = (first + (1 - second)) / 2
  }
  return { answers, abstained }
}

/** 单次最多读几对（P1 批 5）。 */
export const AUTO_RESOLVE_BATCH_LIMIT = 5
/** 单次最多自动执行几对（P1 批 5）。 */
export const AUTO_RESOLVE_RUN_MAX = 5
/** 24h 内 conflict-rule 系 auto-action 上限（上线后口径）。 */
export const AUTO_RESOLVE_DAILY_MAX = 20

export interface AutoResolveBatchDeps {
  /** 未传则只有规则轨：r-tier 执行，其余全部 proposed。 */
  readonly judge?: MemoryJudge
  readonly now?: () => number
  readonly limit?: number
  readonly maxAuto?: number
  readonly dailyMax?: number
  readonly version: string
}

export interface AutoResolveBatchResult {
  readonly processed: number
  readonly autoResolved: number
  readonly proposed: number
  readonly skippedCap: number
}

const CONFLICT_RULE_PREFIX = 'conflict-rule/'

/** 当天 0 点（本地）：日上限的窗口起点。 */
function dayStartOf(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 审计里数今天已经自动解决掉几对冲突（只数 auto-action，不数 proposed）。 */
async function countResolvedToday(store: KyzmemStore, now: number): Promise<number> {
  const dayStart = dayStartOf(now)
  const rows = await store.recentAudit('auto-action', 500)
  let count = 0
  for (const row of rows) {
    if (row.at < dayStart || typeof row.detail !== 'string') continue
    try {
      const detail = JSON.parse(row.detail) as { ruleId?: unknown }
      if (typeof detail.ruleId === 'string' && detail.ruleId.startsWith(CONFLICT_RULE_PREFIX)) count++
    } catch {
      continue
    }
  }
  return count
}

function pairState(pair: ConflictPair): string {
  return [
    `Left [${pair.left.id}] (${pair.left.kind}, tier=${pair.left.sourceTier ?? 'unknown'}): ${pair.left.content}`,
    `Right [${pair.right.id}] (${pair.right.kind}, tier=${pair.right.sourceTier ?? 'unknown'}): ${pair.right.content}`,
  ].join('\n')
}

/**
 * 读下一批待裁决冲突并逐条处置：r-tier 自动执行（配额内），其余人工。
 * 每条必写一条审计（auto-action 或 auto-proposed），批次 id 按运行时刻生成。
 */
export async function autoResolveBatch(
  store: KyzmemStore,
  deps: AutoResolveBatchDeps,
): Promise<AutoResolveBatchResult> {
  const now = deps.now === undefined ? Date.now() : deps.now()
  const limit = deps.limit ?? AUTO_RESOLVE_BATCH_LIMIT
  const maxAuto = deps.maxAuto ?? AUTO_RESOLVE_RUN_MAX
  const dailyMax = deps.dailyMax ?? AUTO_RESOLVE_DAILY_MAX
  const batchId = `auto-conflict-${now}`
  const thresholds = { newerMinAgeDays: RULE_NEWER_MIN_AGE_MS / 86_400_000 }

  let resolvedToday = await countResolvedToday(store, now)
  const { items } = await store.listConflicts(['user', 'project', 'shared'] as readonly KyzmemScope[], limit)
  let autoResolved = 0
  let proposed = 0
  let skippedCap = 0

  for (const pair of items) {
    const entityMap = await store.entitiesOfNodes([pair.left.id, pair.right.id])
    const verdict = ruleVerdict(pair, {
      left: (entityMap.get(pair.left.id) ?? []).map(entity => entity.name),
      right: (entityMap.get(pair.right.id) ?? []).map(entity => entity.name),
    })
    if (verdict.ruleId === 'r-tier') {
      const keepLeft = verdict.action === 'archive-right'
      const loser = keepLeft ? pair.right : pair.left
      if (autoResolved >= maxAuto || resolvedToday >= dailyMax) {
        skippedCap++
        proposed++
        await logAutoAction(store, {
          op: 'auto-proposed',
          ruleId: `${CONFLICT_RULE_PREFIX}r-tier`,
          thresholds,
          leftId: String(pair.left.id),
          rightId: String(pair.right.id),
          batchId,
          version: deps.version,
          note: 'daily-cap reached',
        })
        continue
      }
      await store.resolveConflict(pair.left.id, pair.right.id, keepLeft ? 'keep-left' : 'keep-right')
      await logAutoAction(store, {
        op: 'auto-action',
        ruleId: `${CONFLICT_RULE_PREFIX}r-tier`,
        thresholds,
        leftId: String(pair.left.id),
        rightId: String(pair.right.id),
        batchId,
        version: deps.version,
        undo: { restoreIds: [String(loser.id)] },
      })
      autoResolved++
      resolvedToday++
      continue
    }
    // 双轨：规则弃权/r-newer 的，有 judge 就问一句「左条是否已被右条取代」。
    let judgeDirection: 'left-wins' | 'right-wins' | undefined
    if (deps.judge !== undefined) {
      try {
        const consistent = await askConsistent(deps.judge, pairState(pair), [
          {
            id: 'left_outdated',
            negatedId: 'right_outdated',
            instructions: '左条是否已被右条取代（内容过时/被纠正）？',
            negatedInstructions: '右条是否已被左条取代（内容过时/被纠正）？',
          },
        ])
        const outdated = consistent.answers['left_outdated']
        if (outdated !== undefined && !consistent.abstained.includes('left_outdated')) {
          const bar = deps.judge.contradictMinProbability
          if (outdated >= bar) judgeDirection = 'right-wins'
          else if (outdated <= 1 - bar) judgeDirection = 'left-wins'
        }
      } catch {
        judgeDirection = undefined
      }
    }
    if (judgeDirection !== undefined && (autoResolved >= maxAuto || resolvedToday >= dailyMax)) {
      skippedCap++
      proposed++
      await logAutoAction(store, {
        op: 'auto-proposed',
        ruleId: `${CONFLICT_RULE_PREFIX}judge-newer`,
        thresholds,
        leftId: String(pair.left.id),
        rightId: String(pair.right.id),
        batchId,
        version: deps.version,
        note: 'daily-cap reached',
      })
      continue
    }
    if (judgeDirection === undefined) {
      proposed++
      await logAutoAction(store, {
        op: 'auto-proposed',
        ruleId: `${CONFLICT_RULE_PREFIX}${verdict.ruleId}`,
        thresholds,
        leftId: String(pair.left.id),
        rightId: String(pair.right.id),
        batchId,
        version: deps.version,
      })
      continue
    }
    const keepLeft = judgeDirection === 'left-wins'
    const loser = keepLeft ? pair.right : pair.left
    await store.resolveConflict(pair.left.id, pair.right.id, keepLeft ? 'keep-left' : 'keep-right')
    await logAutoAction(store, {
      op: 'auto-action',
      ruleId: `${CONFLICT_RULE_PREFIX}judge-newer`,
      thresholds,
      leftId: String(pair.left.id),
      rightId: String(pair.right.id),
      batchId,
      version: deps.version,
      undo: { restoreIds: [String(loser.id)] },
    })
    autoResolved++
    resolvedToday++
  }

  return { processed: items.length, autoResolved, proposed, skippedCap }
}
