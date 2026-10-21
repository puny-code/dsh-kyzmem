/**
 * 宫殿遥测聚合：从 op_log 实时聚合最近 N 天的关键指标，全部数据本地保留、不外传。
 * 暴露给路由 /api/kyzmem/telemetry（计数快照）与 /api/kyzmem/stats（十二项指标），
 * 供面板「今日速览」「管家日志」「指标卡」展示。
 *
 * 为什么把指标做成纯函数：面板和 /stats 都要同一套口径，而 op_log / stats 的取数方式
 * 未来可能换（走 countAudit 聚合 SQL 而非全量扫描）。纯函数 `computeMetrics` 只吃
 * 「已查好的行」，取数侧（`collectMetrics`）可以随时替换实现而不动口径。
 *
 * @module dsh-kyzmem/telemetry/aggregate
 */

import type { KyzmemScope, MaintenanceDebt, OperationLogRow, SearchChannelStat, StoreStats } from '../types.ts'
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

/** 面板十二项指标（/api/kyzmem/stats 的 metrics 字段）。 */
export interface TelemetryMetrics {
  /** 采用率 = recall-used / (recall-used + recall-ignored)，窗口内。 */
  readonly adoptionRate?: number
  /** 窗口内「召回归因被采用」次数。 */
  readonly recallUsed?: number
  /** 窗口内「召回归因被忽略」次数。 */
  readonly recallIgnored?: number
  /** drop 率 = drop / (write + drop)，窗口内（chitchat / 精确重复 / 近似重复占比）。 */
  readonly dropRate?: number
  /** 待裁决冲突对数（各库 stats.openConflicts 之和）。 */
  readonly openConflicts?: number
  /**
   * 过期命中占比（过期存量 / (active + expired)）。
   * 为什么是近似：store 目前只在检索命中上带逐条 expired 标记，不回写 op_log；
   * 用「库内过期占比」代替「命中里过期占比」，方向一致且不需要新增写放大。
   */
  readonly expiredHitRate?: number
  /** 未确认占比 = 非 user-confirmed 分级 / 全部已分级条目。 */
  readonly unconfirmedRatio?: number
  /** 注入 token 估算（op_log 'inject' 的 detail.tokens 之和；运行时未接时缺省）。 */
  readonly injectTokens?: number
  /** 检索耗时 p95（ms，op_log 'recall' 的 detail.durationMs，最近邻取整）。 */
  readonly searchP95Ms?: number
  /** 周增长 = 窗口内写入数 / max(1, active 总量)（0-1 比例，无历史快照时的可用近似）。 */
  readonly weeklyGrowth?: number
  /** 复习完成率 = 窗口内 review-answer / max(1, 到期数)，上限 1。 */
  readonly reviewCompletionRate?: number
  /** 后台欠账 = 待裁决 + 到期复习 + 未清摄取 + 缺摘要（无调度器快照时用已知项之和）。 */
  readonly maintenanceDebt?: number
}

/** 指标聚合的输入（全部是已查好的数据，便于单测直接构造）。 */
export interface MetricInputs {
  readonly windowDays: number
  /** 各库 stats 快照（取不到的库不出现）。 */
  readonly stats: readonly StoreStats[]
  /** op_log 行（含窗口外的行也可以：给了 sinceMs 就按时间过滤）。 */
  readonly ops: readonly OperationLogRow[]
  /** 窗口起点（ms）；缺省 = ops 已预先过滤。 */
  readonly sinceMs?: number
  /** 后台整理欠账快照（维护调度器给出；未接时缺省）。 */
  readonly debt?: MaintenanceDebt
  /** 今日到期复习条数；缺省取各库 stats.dueCount 之和。 */
  readonly dueCount?: number
}

/** 解析 op_log 的 detail（BATCH 行是 JSON；坏行返回 undefined，指标侧不因此中断）。 */
function parseDetail(detail: string | null): Record<string, unknown> | undefined {
  if (detail === null || detail === '') return undefined
  try {
    const parsed: unknown = JSON.parse(detail)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 最近邻法 p95（样本少时退化为最大值；返回值保留一位小数）。 */
function percentile95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length) - 1
  const picked = sorted[Math.max(0, Math.min(sorted.length - 1, rank))]
  return picked === undefined ? undefined : Math.round(picked * 10) / 10
}

/** 逐项求和，但只在至少一个库回报了该字段时才算数（否则「缺省」而不是「0」）。 */
function sumDefined(
  stats: readonly StoreStats[],
  pick: (stats: StoreStats) => number | undefined,
): number | undefined {
  let total = 0
  let seen = false
  for (const item of stats) {
    const value = pick(item)
    if (value === undefined) continue
    total += value
    seen = true
  }
  return seen ? total : undefined
}

/**
 * 十二项指标的纯函数聚合。
 * 为什么缺省而不给 0：面板把 undefined 渲染成「—」；给 0 会被读成「确实是零」，
 * 而多数缺省其实来自「这一层还没接上」（如 injectTokens），0 会掩盖接入缺口。
 */
export function computeMetrics(inputs: MetricInputs): TelemetryMetrics {
  const { stats, debt } = inputs
  const sinceMs = inputs.sinceMs
  const inWindow = sinceMs === undefined
    ? inputs.ops
    : inputs.ops.filter(row => row.at >= sinceMs)
  const count = (op: string): number => inWindow.reduce((n, row) => n + (row.op === op ? 1 : 0), 0)

  const recallUsed = count('recall-used')
  const recallIgnored = count('recall-ignored')
  const writes = count('write')
  const drops = count('drop')
  const reviewAnswers = count('review-answer')

  const adoptionDenom = recallUsed + recallIgnored
  const adoptionRate = adoptionDenom > 0 ? recallUsed / adoptionDenom : undefined

  const dropDenom = writes + drops
  const dropRate = dropDenom > 0 ? drops / dropDenom : undefined

  const openConflicts = sumDefined(stats, item => item.openConflicts)
  const expired = sumDefined(stats, item => item.expired)
  const activeTotal = stats.reduce((n, item) => n + item.active, 0)
  const expiredHitRate = expired !== undefined && activeTotal + expired > 0
    ? expired / (activeTotal + expired)
    : undefined

  // byTier 是 Record<tier, count>：非 user-confirmed 一律算「未确认」（含缺分级的历史条目）。
  let tierTotal = 0
  let tierUnconfirmed = 0
  let tierSeen = false
  for (const item of stats) {
    const byTier = item.byTier
    if (byTier === undefined) continue
    for (const [tier, amount] of Object.entries(byTier)) {
      tierTotal += amount
      tierSeen = true
      if (tier !== 'user-confirmed') tierUnconfirmed += amount
    }
  }
  const unconfirmedRatio = tierSeen && tierTotal > 0 ? tierUnconfirmed / tierTotal : undefined

  // 注入 token：运行时（hook）尚未回写 op_log 时保持缺省；口径按 detail.tokens 求和。
  let injectTokens: number | undefined
  for (const row of inWindow) {
    if (row.op !== 'inject') continue
    const tokens = parseDetail(row.detail)?.['tokens']
    if (typeof tokens === 'number' && Number.isFinite(tokens)) injectTokens = (injectTokens ?? 0) + tokens
  }

  // 检索耗时：store 在 'recall' 的 BATCH detail 里写 durationMs（缺省时该项缺省）。
  const durations: number[] = []
  for (const row of inWindow) {
    if (row.op !== 'recall') continue
    const duration = parseDetail(row.detail)?.['durationMs']
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) durations.push(duration)
  }
  const searchP95Ms = percentile95(durations)

  // 周增长：写入 / 存量；上限 1（面板按 0-1 比例画条，超过 1 说明存量极小，夹到满格即可）。
  const weeklyGrowth = activeTotal > 0 ? Math.min(1, writes / activeTotal) : undefined

  const dueCount = inputs.dueCount ?? sumDefined(stats, item => item.dueCount)
  const reviewCompletionRate = dueCount !== undefined && dueCount > 0
    ? Math.min(1, reviewAnswers / dueCount)
    : undefined

  const maintenanceDebt = debt !== undefined
    ? debt.openConflicts + debt.dueReviews + debt.pendingIngests + debt.missingSummaries
    : openConflicts !== undefined || dueCount !== undefined
      ? (openConflicts ?? 0) + (dueCount ?? 0)
      : undefined

  return {
    recallUsed,
    recallIgnored,
    ...(adoptionRate === undefined ? {} : { adoptionRate }),
    ...(dropRate === undefined ? {} : { dropRate }),
    ...(openConflicts === undefined ? {} : { openConflicts }),
    ...(expiredHitRate === undefined ? {} : { expiredHitRate }),
    ...(unconfirmedRatio === undefined ? {} : { unconfirmedRatio }),
    ...(injectTokens === undefined ? {} : { injectTokens }),
    ...(searchP95Ms === undefined ? {} : { searchP95Ms }),
    ...(weeklyGrowth === undefined ? {} : { weeklyGrowth }),
    ...(reviewCompletionRate === undefined ? {} : { reviewCompletionRate }),
    ...(maintenanceDebt === undefined ? {} : { maintenanceDebt }),
  }
}

/** 指标采集结果：指标 + 最近窗口内的检索通道统计（面板「检索通道」表）。 */
export interface MetricsGathering {
  readonly metrics: TelemetryMetrics
  readonly channels: readonly SearchChannelStat[]
}

/**
 * 指标采集：读各库 op_log 与 stats，交给 `computeMetrics` 聚合。
 *
 * 为什么用 recentOps 而不是 store.countAudit：A 侧的聚合读接口与本函数同批落地，
 * 合入顺序不定；recentOps 是既有接口，先保证任一时刻都能编译/运行，等
 * countAudit 稳定后可只替换本函数的取数部分，口径不变。
 *
 * @param openStore - 按 scope 取分库；取不到（库未创建）时跳过该库。
 * @param scopes - 参与聚合的 scope 列表。
 * @param windowDays - 聚合窗口天数。
 * @param now - 参考时刻（测试注入）。
 */
export async function collectMetrics(
  openStore: (scope: KyzmemScope) => Promise<KyzmemStore>,
  scopes: readonly KyzmemScope[],
  windowDays: number = DEFAULT_WINDOW_DAYS,
  now: number = Date.now(),
): Promise<MetricsGathering> {
  const sinceMs = now - windowDays * 86_400_000
  const stats: StoreStats[] = []
  const ops: OperationLogRow[] = []
  for (const scope of scopes) {
    try {
      const store = await openStore(scope)
      const [storeStats, rows] = await Promise.all([store.stats(), store.recentOps(50_000)])
      stats.push(storeStats)
      for (const row of rows) if (row.at >= sinceMs) ops.push(row)
    } catch {
      // 该 scope 的库尚未创建：跳过，指标缺省而不是报错。
    }
  }
  return { metrics: computeMetrics({ windowDays, stats, ops, sinceMs }), channels: channelsOf(ops) }
}

/**
 * 从 recall 批次的 detail.channels 汇总各道统计（跨库相加）。
 * 检索通道由 store.search 返回并写入 op_log；旧版本 detail 没有该字段时返回空数组。
 */
function channelsOf(ops: readonly OperationLogRow[]): readonly SearchChannelStat[] {
  const merged = new Map<'fts' | 'vector' | 'graph', { tookMs: number; hits: number; degraded: boolean }>()
  for (const row of ops) {
    if (row.op !== 'recall') continue
    const channels = parseDetail(row.detail)?.['channels']
    if (!Array.isArray(channels)) continue
    for (const entry of channels) {
      if (entry === null || typeof entry !== 'object') continue
      const raw = entry as Record<string, unknown>
      const channel = raw['channel']
      if (channel !== 'fts' && channel !== 'vector' && channel !== 'graph') continue
      const tookMs = typeof raw['tookMs'] === 'number' ? raw['tookMs'] : 0
      const hits = typeof raw['hits'] === 'number' ? raw['hits'] : 0
      const degraded = raw['degraded'] === true
      const current = merged.get(channel)
      merged.set(channel, {
        tookMs: (current?.tookMs ?? 0) + tookMs,
        hits: (current?.hits ?? 0) + hits,
        degraded: degraded || (current?.degraded ?? false),
      })
    }
  }
  return Array.from(merged.entries()).map(([channel, value]) => ({
    channel,
    tookMs: Math.round(value.tookMs * 10) / 10,
    hits: value.hits,
    degraded: value.degraded,
  }))
}
