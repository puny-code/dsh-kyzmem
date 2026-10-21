/**
 * 后台整理欠账：把「现在该做什么」从「现在几点」里解耦。
 * 为什么弃用 24h 定时器：用户不常开 GUI，setInterval 在休眠/重启后会漂移甚至整体失联；
 * 而真正决定该不该整理的是库的欠账（增长 / 冲突 / 复习积压），不是钟点。
 * @module dsh-kyzmem/maintenance/debt
 */

import type { MaintenanceDebt } from '../types.ts'
import type { KyzmemStore } from '../store/interface.ts'

/** 增长率统计窗：7 天（契约定义）。 */
export const GROWTH_WINDOW_MS = 7 * 86_400_000

/** 欠账阈值：近 7 天新增超过当前 active 总量的 10%。 */
export const ACTIVE_GROWTH_THRESHOLD = 0.1

/** 欠账阈值：待裁决冲突超过 5 对。 */
export const OPEN_CONFLICTS_THRESHOLD = 5

/** 欠账阈值：到期复习超过 20 条。 */
export const DUE_REVIEWS_THRESHOLD = 20

/** 两次整理的最小间隔：1 天——刚整理过就不重复扫，避免每次 pre-step 都开库。 */
export const MAINTENANCE_MIN_INTERVAL_MS = 86_400_000

/** 饥饿保护：距上次整理超过 7 天，即使没有欠账也强制跑一小轮（轮转三任务）。 */
export const MAINTENANCE_STARVATION_MS = 7 * 86_400_000

/**
 * 计算当前欠账快照。
 * 所有计数都从 store 的既有只读面取：不新增表、不依赖进程内状态，
 * 这样多个进程（host + 面板路由）看到的是同一份欠账。
 * @param store - 目标库（通常是 user 库；项目库各自的维护由 kick 按库触发）。
 * @param now - 当前时间（测试可注入）。
 */
export async function computeDebt(store: KyzmemStore, now: number = Date.now()): Promise<MaintenanceDebt> {
  const stats = await store.stats()
  const active = stats.active
  // 近 7 天写入量：每次 record 写入都会落一条 op_log 'write'（store 既有行为），
  // 所以不需要额外统计表；增长率用「新增 / 当前总量」，空库直接 0（避免除零）。
  const writes = await store.countAudit('write', now - GROWTH_WINDOW_MS)
  const openConflicts = stats.openConflicts
    ?? (await store.listConflicts(['user', 'project', 'shared'], 1)).total
  const dueReviews = stats.dueCount ?? (await store.dueReviews(now, DUE_REVIEWS_THRESHOLD + 1)).length
  // pending 摄取键是 op_log 'ingest-pending' 的 detail（未清数 = 欠账轮数）。
  const pendingIngests = (await store.listAuditDetails('ingest-pending')).length
  return {
    activeGrowth: active <= 0 ? 0 : Math.min(1, writes / active),
    openConflicts,
    dueReviews,
    pendingIngests,
    // 会话摘要缺失检测需要扫所有会话日志（跨库），代价高且非本批目标：先恒 0。
    missingSummaries: 0,
  }
}
