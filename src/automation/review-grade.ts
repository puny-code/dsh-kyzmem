/**
 * 采用信号排期（Phase 6/7A）：把「模型用没用证据」翻译成复习调度。
 *
 * - 注入的证据被引用（recall-used）→ 相关条目记 grade 4，SM-2 往后推（效果推进）；
 * - 某条目连续 3 次被注入但从未被引用 → 记 grade 2，排期往后压（别再占注入位）。
 * - 只改 `review` 字段：不碰 confidence，不碰排序权重——排期管「何时复习」，
 *   排序管「是否召回」，两件事不串味。
 * - 每日上限 20 条：用 `review-grade-auto` 审计计数，超出的本次不动（skippedCap）。
 * - 幂等键是「批次」：同一批证据只调一次度（调用方 auditRecallAdoption 已按批次去重）。
 *
 * @module dsh-kyzmem/review-grade
 */
import type { KyzmemStore } from '../store/interface.ts'
import type { ReviewGrade } from '../types.ts'

/** 被采用的 grade：SM-2 里「答对但略有犹豫」，间隔拉长、ease 微调。 */
export const ADOPTION_GRADE_USED: ReviewGrade = 4
/** 连续未被采用的 grade：SM-2 里「答错但想起来了」，间隔缩短、排到前面太占位所以往后压。 */
export const ADOPTION_GRADE_IGNORED: ReviewGrade = 2
/** 连续几次注入未采用才后排（计划值 3）。 */
export const ADOPTION_IGNORE_STREAK = 3
/** 每日最多调几条（计划值 20，used/ignored 共用一个池子）。 */
export const ADOPTION_SCHEDULE_PER_DAY = 20
/** 采用信号排期的审计 op：detail = {id, grade, reason}，面板与计数都读它。 */
const ADOPTION_GRADE_OP = 'review-grade-auto'
const MAX_SCAN_ROWS = 200

export interface AdoptionScheduleResult {
  readonly adjusted: number
  readonly skippedCap: boolean
}

interface RecallBatch {
  readonly ids: readonly string[]
  readonly used: boolean
}

function parseBatchIds(detail: string | null): string[] {
  if (detail === null) return []
  try {
    const parsed = JSON.parse(detail) as { ids?: unknown }
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** UTC 日期（每日上限的口径与死信重试一致）。 */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * 按 id 算「最近连续几次注入未被采用」：used 批次里出现过就清零冻结，
 * 没被注入的批次既不计也不清零（没轮到它，不算冷落）。
 * used 与 ignored 同毫秒并列时按 used 优先（保守：不降权）。
 */
export function adoptionIgnoreStreaks(batchesNewestFirst: readonly RecallBatch[]): Map<string, number> {
  const streak = new Map<string, number>()
  const stopped = new Set<string>()
  for (const batch of batchesNewestFirst) {
    for (const id of batch.ids) {
      if (stopped.has(id)) continue
      if (batch.used) {
        stopped.add(id)
        streak.delete(id)
      } else {
        streak.set(id, (streak.get(id) ?? 0) + 1)
      }
    }
  }
  return streak
}

/**
 * 读最近的采用审计，拼出「从新到旧」的批次序列（used/ignored 合并，used 优先）。
 * 行数上限 MAX_SCAN_ROWS，防止 op_log 很长时全表扫描。
 */
async function readRecentBatches(store: KyzmemStore): Promise<RecallBatch[]> {
  const [usedRows, ignoredRows] = await Promise.all([
    store.recentAudit('recall-used', MAX_SCAN_ROWS),
    store.recentAudit('recall-ignored', MAX_SCAN_ROWS),
  ])
  const batches: { at: number; used: boolean; ids: readonly string[] }[] = []
  for (const row of usedRows) batches.push({ at: row.at, used: true, ids: parseBatchIds(row.detail) })
  for (const row of ignoredRows) batches.push({ at: row.at, used: false, ids: parseBatchIds(row.detail) })
  // at 倒序；并列时 used 在前（保守口径）。
  batches.sort((a, b) => b.at - a.at || Number(b.used) - Number(a.used))
  return batches
}

async function todayAdjustedCount(store: KyzmemStore, now: number): Promise<number> {
  const day = utcDay(now)
  let count = 0
  for (const row of await store.recentAudit(ADOPTION_GRADE_OP, MAX_SCAN_ROWS)) {
    if (new Date(row.at).toISOString().slice(0, 10) !== day) break
    count += 1
  }
  return count
}

/**
 * 应用一次采用信号排期。used=true：整批 grade 4；used=false：连续 3 次未采用的 grade 2。
 * 返回实际调整条数与是否被每日上限拦下。失败一律抛错，由调用方（pre-step）降级吞掉。
 */
export async function applyAdoptionScheduling(
  store: KyzmemStore,
  ids: readonly string[],
  used: boolean,
  options: { now?: number; maxPerDay?: number; ignoreStreak?: number } = {},
): Promise<AdoptionScheduleResult> {
  const now = options.now ?? Date.now()
  const maxPerDay = options.maxPerDay ?? ADOPTION_SCHEDULE_PER_DAY
  const threshold = options.ignoreStreak ?? ADOPTION_IGNORE_STREAK
  let remaining = Math.max(0, maxPerDay - (await todayAdjustedCount(store, now)))
  let adjusted = 0
  let capped = false
  const qualify = async (): Promise<readonly string[]> => {
    if (used) return ids
    const streaks = adoptionIgnoreStreaks(await readRecentBatches(store))
    return ids.filter(id => (streaks.get(id) ?? 0) >= threshold)
  }
  for (const id of await qualify()) {
    if (remaining <= 0) { capped = true; break }
    await store.scheduleReview(id as never, used ? ADOPTION_GRADE_USED : ADOPTION_GRADE_IGNORED)
    await store.audit(
      ADOPTION_GRADE_OP,
      'BATCH',
      JSON.stringify({ id, grade: used ? ADOPTION_GRADE_USED : ADOPTION_GRADE_IGNORED, reason: used ? 'adopted' : 'ignored-streak' }),
    )
    remaining -= 1
    adjusted += 1
  }
  return { adjusted, skippedCap: capped }
}
