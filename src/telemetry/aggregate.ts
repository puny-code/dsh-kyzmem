/**
 * 宫殿遥测聚合：从 op_log 实时聚合最近 N 天的关键指标，全部数据本地保留、不外传。
 * 暴露给路由 /api/kyzmem/telemetry（计数快照）与 /api/kyzmem/stats（十八项指标），
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
import type { KyzmemLanguage } from '../i18n/language.ts'
import { checkAnchors } from '../anchor.ts'
import { estimateTokens } from '../token.ts'

/** 聚合窗口（默认 7 天，可由路由 query 覆盖）。 */
const DEFAULT_WINDOW_DAYS = 7

/** 首问召回注入的审计 op（R5 曝光/激活的时间锚点）。 */
const QUERY_RECALL_OP = 'query-recall'

/** 渐进式披露（下钻）的审计 op：`kyzmem_examine` 每次成功返回按 scope 各写一条 detail.ids。 */
const EXAMINE_OP = 'examine'

/** 每个分库最多实时复验的文件锚条数：/stats 是面板轮询接口，stat 次数必须有上限。 */
const ANCHOR_METRIC_SAMPLE = 40

/**
 * token 估算的「单位成本样本」：注入文本由插件按部署语言渲染——中文正文几乎全是 CJK
 * （1.5 token/字），英俄正文全窄字符（4 字符/token）。用代表样本过一遍 `estimateTokens`
 * 拿到每字符成本，再乘审计里记的 chars，口径与 `src/token.ts` 同源（不是另写一套 chars/4）。
 */
const TOKEN_SAMPLE: Readonly<Record<KyzmemLanguage, string>> = { zh: '字字', en: 'aaaa', ru: 'aaaa' }

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

/** 面板指标（/api/kyzmem/stats 的 metrics 字段；R5 起十八项）。 */
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
  /**
   * 注入曝光字符（R5）≈ Σ(注入字符 × 该次注入之后的请求数)。
   * **估算**：op_log 不记会话 id，按「一次 query-recall 注入 → 下一条 query-recall」切段，
   * 段内 op_log 行数当作「后续请求数」的上界（每请求至少一行审计）。不当作计费口径。
   */
  readonly exposureChars?: number
  /** 窗口内首问召回注入次数（exposure 的样本量、activationRate 的分母）。 */
  readonly injectionCount?: number
  /** 激活率（R5）= 注入后同段内出现检索/下钻的会话比例；无注入时缺省。 */
  readonly activationRate?: number
  /**
   * 下钻率（R5）= examine 次数 / 索引检索次数。
   * 分母为 0（窗口内没人用 index 模式检索）时给缺省而不是 0——0% 会被读成「没人下钻」，
   * 而真相是「还没开始测量」。
   */
  readonly drillDownRate?: number
  /** 注入 token 估算（R5，`estimateTokens` 同源口径）：按注入 chars 折算，与 injectTokens 不同源。 */
  readonly tokenCostEstimate?: number
  /** 带锚条目里「可能过期」（stale + missing）的比例（R5，mtime 实时抽样复验）；无样本时缺省。 */
  readonly staleAnchorRate?: number
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
  /** 注入文本的渲染语言（token 估算的字符宽度口径；缺省 zh）。 */
  readonly language?: KyzmemLanguage
  /**
   * 文件锚复验结果（R5 stale 命中率）：由 `collectMetrics` 用 anchorRoot 实时 stat 得到。
   * 缺省 = 未复验（该项缺省，面板显示「—」）。
   */
  readonly anchors?: {
    /** 取样的带锚条目总数。 */
    readonly total: number
    /** 能判定状态（intact/stale/missing）的条数。 */
    readonly checked: number
    /** 其中「可能过期」的条数（stale + missing）。 */
    readonly stale: number
  }
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
 * 注入字符 → token 估算（R5 的 token 成本口径），与 `src/token.ts` 的 `estimateTokens` 同源。
 *
 * 审计只留 chars、不留正文（隐私 + 体量），所以无法逐字估算：用该语言的代表样本算单位成本，
 * 再乘总量。中英混排会被高估一点——这是估算，不当作计费口径（方案 §9）。
 * @param chars - 注入字符总数。
 * @param language - 注入文本的渲染语言。
 */
export function tokensOfChars(chars: number, language: KyzmemLanguage): number {
  if (!(chars > 0)) return 0
  const sample = TOKEN_SAMPLE[language]
  return Math.ceil(chars * (estimateTokens(sample) / sample.length))
}

/** 一条 op 是否算「注入之后的主动使用」：工具检索（mode='search'，首问召回用 'query-recall' 不算）或下钻。 */
function isActivationEvent(row: OperationLogRow): boolean {
  if (row.op === EXAMINE_OP) return true
  return row.op === 'recall' && parseDetail(row.detail)?.['mode'] === 'search'
}

/**
 * 指标的纯函数聚合（R5 起十八项）。
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

  // —— R5 曝光 / 激活 / token 成本：按 query-recall 注入点切段 ——
  // op_log 不记会话 id（query-recall 的 target 恒为 BATCH），所以用时间序近似：
  // 一次 injected 注入 = 一次会话的开场，到下一条 query-recall 之间的 op_log 行 = 这次注入
  // 之后该会话的活动。同时开着两个会话时会串味——这是能拿到的最小代价近似，
  // 只用来量趋势，不当作计费口径（方案 §9）。
  const timeline = [...inWindow].sort((a, b) => a.at - b.at)
  let injectionCount = 0
  let injectedChars = 0
  let activatedSessions = 0
  let exposureChars = 0
  /** 当前段（仅在 injected 注入之后存在）：注入字符 + 已观察事件数 + 是否已激活。 */
  let segment: { readonly chars: number; events: number; activated: boolean } | undefined
  const closeSegment = (): void => {
    if (segment === undefined) return
    // 「该注入之后的请求数」用段内 op_log 行数近似：每个请求至少产生一行审计，工具调用可能多行，
    // 所以这是上界估计——曝光是成本口径，宁可高估不低估。
    exposureChars += segment.chars * Math.max(1, segment.events)
    if (segment.activated) activatedSessions++
    segment = undefined
  }
  for (const row of timeline) {
    if (row.op === QUERY_RECALL_OP) {
      closeSegment()
      const detail = parseDetail(row.detail)
      if (detail?.['outcome'] !== 'injected') continue
      const rawChars = detail['chars']
      const chars = typeof rawChars === 'number' && Number.isFinite(rawChars) && rawChars > 0 ? rawChars : 0
      injectionCount++
      injectedChars += chars
      segment = { chars, events: 0, activated: false }
      continue
    }
    if (segment === undefined) continue
    segment.events++
    if (!segment.activated && isActivationEvent(row)) segment.activated = true
  }
  closeSegment()
  const activationRate = injectionCount > 0 ? activatedSessions / injectionCount : undefined
  const tokenCostEstimate = injectionCount > 0
    ? tokensOfChars(injectedChars, inputs.language ?? 'zh')
    : undefined

  // —— R5 下钻率 ——
  // 分母 = 工具检索次数（recall 审计 mode='search'；index 与 full 在审计里不区分，
  // 首问召回用 mode='query-recall' 已排除）；分子 = examine 事件数。
  let indexSearches = 0
  let examineRuns = 0
  for (const row of inWindow) {
    if (row.op === EXAMINE_OP) {
      examineRuns++
      continue
    }
    if (row.op === 'recall' && parseDetail(row.detail)?.['mode'] === 'search') indexSearches++
  }
  // 分母为 0 才给缺省：只要窗口内有人用 index 模式检索，"检索了但没下钻" 就是一个
  // 真实测量值 0，不能显示成「—」（那会被读成「还没开始测量」）。
  const drillDownRate = indexSearches > 0 ? Math.min(1, examineRuns / indexSearches) : undefined

  // —— R5 stale 命中率 ——
  // stale（文件变了）与 missing（文件没了）都算「可能过期」：对使用者而言含义相同——
  // 这条记忆指向的文件已经不是它当初那个文件了。无法判定（stat 报错/路径非法）的条目
  // 不进分母：宁可少算，也不把「测不出来」标成「过期」。
  const anchors = inputs.anchors
  const staleAnchorRate = anchors !== undefined && anchors.checked > 0
    ? anchors.stale / anchors.checked
    : undefined

  return {
    recallUsed,
    recallIgnored,
    ...(injectionCount === 0 ? {} : { exposureChars }),
    injectionCount,
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
    ...(activationRate === undefined ? {} : { activationRate }),
    ...(drillDownRate === undefined ? {} : { drillDownRate }),
    ...(tokenCostEstimate === undefined ? {} : { tokenCostEstimate }),
    ...(staleAnchorRate === undefined ? {} : { staleAnchorRate }),
  }
}

/** 指标采集结果：指标 + 最近窗口内的检索通道统计（面板「检索通道」表）。 */
export interface MetricsGathering {
  readonly metrics: TelemetryMetrics
  readonly channels: readonly SearchChannelStat[]
}

/** 指标采集的可选项（R5：token 口径与文件锚复验需要的外部信息）。 */
export interface MetricsOptions {
  /** 注入文本的渲染语言：token 估算的字符宽度口径（缺省 zh）。 */
  readonly language?: KyzmemLanguage
  /**
   * 文件锚复验根（工作区绝对路径）：给定时才做 mtime 实时复验（每库至多
   * ANCHOR_METRIC_SAMPLE 条）。缺省 = 不复验，staleAnchorRate 缺省（面板显示「—」）。
   */
  readonly anchorRoot?: string
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
 * @param options - R5 口径参数：注入语言（token 估算）+ 文件锚复验根。
 */
export async function collectMetrics(
  openStore: (scope: KyzmemScope) => Promise<KyzmemStore>,
  scopes: readonly KyzmemScope[],
  windowDays: number = DEFAULT_WINDOW_DAYS,
  now: number = Date.now(),
  options: MetricsOptions = {},
): Promise<MetricsGathering> {
  const sinceMs = now - windowDays * 86_400_000
  const stats: StoreStats[] = []
  const ops: OperationLogRow[] = []
  // 锚点复验计数（R5 stale 命中率）：跨库累加，无法判定的条目不进 checked。
  let anchorTotal = 0
  let anchorChecked = 0
  let anchorStale = 0
  for (const scope of scopes) {
    let store: KyzmemStore
    try {
      store = await openStore(scope)
      const [storeStats, rows] = await Promise.all([store.stats(), store.recentOps(50_000)])
      stats.push(storeStats)
      for (const row of rows) if (row.at >= sinceMs) ops.push(row)
    } catch {
      // 该 scope 的库尚未创建：跳过，指标缺省而不是报错。
      continue
    }
    // 文件锚复验：只在给了根路径时做（无根 = 不知道文件在哪，测出来的都不对）。
    // 独立 try：锚点复验失败（权限/网络盘）不该把该库的 stats/op_log 一起丢掉。
    if (options.anchorRoot === undefined) continue
    try {
      const records = await store.listAnchors(ANCHOR_METRIC_SAMPLE)
      if (records.length === 0) continue
      anchorTotal += records.length
      const states = await checkAnchors(records, options.anchorRoot, ANCHOR_METRIC_SAMPLE)
      for (const state of states.values()) {
        anchorChecked++
        if (state !== 'intact') anchorStale++
      }
    } catch {
      // 锚点复验是增强项：失败只是该项缺省。
    }
  }
  return {
    metrics: computeMetrics({
      windowDays,
      stats,
      ops,
      sinceMs,
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(anchorTotal === 0 ? {} : { anchors: { total: anchorTotal, checked: anchorChecked, stale: anchorStale } }),
    }),
    channels: channelsOf(ops),
  }
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
