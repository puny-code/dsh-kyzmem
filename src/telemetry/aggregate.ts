/**
 * 宫殿遥测聚合：从 op_log 实时聚合最近 N 天的关键指标，全部数据本地保留、不外传。
 * 暴露给路由 /api/kyzmem/telemetry，供面板「今日速览」与「管家日志」展示计数。
 * @module dsh-kyzmem/telemetry/aggregate
 */

import type { KyzmemStore } from '../store/interface.ts'

/** 聚合窗口（默认 7 天，可由路由 query 覆盖）。 */
const DEFAULT_WINDOW_DAYS = 7

/** 聚合指标视图。 */
export interface TelemetrySnapshot {
  readonly windowDays: number
  readonly sinceMs: number
  readonly untilMs: number
  readonly counts: {
    readonly ingestRequests: number
    readonly ingestDones: number
    readonly searches: number
    readonly writes: number
    readonly updates: number
    readonly forgets: number
    readonly restores: number
    readonly distillRequests: number
    readonly compressRequests: number
    readonly searchRewrites: number
    readonly consumptions: number
    readonly consolidations: number
    readonly reviewAnswers: number
  }
  /** 各 scope 的活跃记忆数与开放率（signal ratio）。 */
  readonly scopes: ReadonlyArray<{
    readonly scope: 'user' | 'project' | 'shared'
    readonly active: number
    readonly total: number
    readonly signalRatio: number
  }>
  /**
   * 每日写入分布：v0.8.1+ 面板「活动热力日历」按此渲染。
   * 长度 = windowDays（默认 7，最长支持 90），元素 = 该日 0 点的 UTC ms 与写入/摄取合计。
   * 取不到时不返回（undefined），UI 端走降级（不画 / 画灰格子）。
   */
  readonly dailyWrites?: ReadonlyArray<{ readonly dayMs: number; readonly count: number }>
}

/** 从单库 op_log 统计各 op 的计数（窗口内）。 */
async function countByOp(store: KyzmemStore, sinceMs: number): Promise<Record<string, number>> {
  const ops = await store.recentOps(100_000)
  const counts: Record<string, number> = {}
  for (const op of ops) {
    if (op.at < sinceMs) continue
    counts[op.op] = (counts[op.op] ?? 0) + 1
  }
  return counts
}

/** 按天汇总 op_log 中的所有写侧活动（用于活动热力日历）。返回的 dayMs 是该日 0 点的本地时间戳。
 * 包含 write/update/ingest-done/ingest-request/distill-request/consolidation/restore/forget,排除纯读侧(search/outcome-report)。 */
async function countByDay(
  store: KyzmemStore,
  sinceMs: number,
  untilMs: number,
): Promise<Map<number, number>> {
  const ops = await store.recentOps(100_000)
  const counts = new Map<number, number>()
  const dayMs = (ms: number): number => {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const startDay = dayMs(sinceMs)
  const endDay = dayMs(untilMs)
  for (let t = startDay; t <= endDay; t += 86_400_000) counts.set(t, 0)
  // 写侧 op:任何改变记忆库状态的操作
  const writeOps = new Set(['write', 'update', 'ingest-done', 'ingest-request', 'distill-request', 'consolidation', 'restore', 'forget'])
  for (const op of ops) {
    if (op.at < sinceMs || op.at > untilMs) continue
    if (!writeOps.has(op.op)) continue
    const d = dayMs(op.at)
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return counts
}

/** 聚合两库的指标 + 各 scope 状态。
 * @param scopeFilter - 限定只聚合指定 scope；undefined = 三库全聚合（向后兼容）。 */
export async function aggregateTelemetry(
  openStore: (scope: 'user' | 'project' | 'shared') => Promise<KyzmemStore>,
  windowDays: number = DEFAULT_WINDOW_DAYS,
  scopeFilter?: 'user' | 'project' | 'shared',
): Promise<TelemetrySnapshot> {
  const untilMs = Date.now()
  const sinceMs = untilMs - windowDays * 86_400_000
  const scopes: Array<'user' | 'project' | 'shared'> = scopeFilter !== undefined
    ? [scopeFilter]
    : ['user', 'project', 'shared']
  const countsAgg = {
    ingestRequests: 0, ingestDones: 0, searches: 0, writes: 0, updates: 0,
    forgets: 0, restores: 0, distillRequests: 0, compressRequests: 0,
    searchRewrites: 0, consumptions: 0, consolidations: 0, reviewAnswers: 0,
  }
  // scopeViews 局部可变（push），返回时满足 TelemetrySnapshot['scopes'] 的 readonly 形状。
  type ScopeView = TelemetrySnapshot['scopes'][number]
  const scopeViews: ScopeView[] = []
  // 每日写入聚合：跨库合并 Map 累加（同一日 0 点对齐）
  const dailyTotals = new Map<number, number>()
  for (const scope of scopes) {
    try {
      const store = await openStore(scope)
      const [counts, stats, daily] = await Promise.all([
        countByOp(store, sinceMs),
        store.stats(),
        countByDay(store, sinceMs, untilMs),
      ])
      countsAgg.ingestRequests += counts['ingest-request'] ?? 0
      countsAgg.ingestDones += counts['ingest-done'] ?? 0
      countsAgg.searches += counts['search-rewrite-request'] ?? 0
      countsAgg.writes += counts['write'] ?? 0
      countsAgg.updates += counts['update'] ?? 0
      countsAgg.forgets += counts['forget'] ?? 0
      countsAgg.restores += counts['restore'] ?? 0
      countsAgg.distillRequests += counts['distill-request'] ?? 0
      countsAgg.compressRequests += counts['compress-request'] ?? 0
      countsAgg.searchRewrites += counts['search-rewrite-request'] ?? 0
      countsAgg.consumptions += (counts['outcome-report'] ?? 0)
      countsAgg.consolidations += counts['consolidation'] ?? 0
      countsAgg.reviewAnswers += counts['review-answer'] ?? 0
      scopeViews.push({ scope, active: stats.active, total: stats.total, signalRatio: stats.signalRatio })
      for (const [day, n] of daily) dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + n)
    } catch {
      // shared 库可能尚未创建，跳过；不影响其他 scope。
    }
  }
  // 按 dayMs 升序排成数组（v0.8.1+ 热力日历直接用）
  const dailyWrites = Array.from(dailyTotals.entries())
    .sort(([a], [b]) => a - b)
    .map(([dayMs, count]) => ({ dayMs, count }))
  return {
    windowDays,
    sinceMs,
    untilMs,
    counts: countsAgg,
    scopes: scopeViews,
    dailyWrites,
  }
}
