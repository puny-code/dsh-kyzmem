/**
 * 后台整理调度（欠账驱动，取代夜间定时器）。
 *
 * 为什么不用 setInterval：宿主进程可能整天不重启也可能随时休眠；钟点触发既可能空转，
 * 也可能在用户最忙时抢 IO。这里改成「欠账够了才跑 + 每次只花一小笔预算」：
 * - 触发点由 index 在 apply / session-disposed / pre-step 调 kickMaintenance（幂等、fire-and-forget）；
 * - 单飞靠 op_log 'maintenance-lease'（跨进程有效，5 分钟自然过期）；
 * - 三任务轮转 decay → merge → refurb，避免同一类欠账长期挤占预算；
 * - 饥饿保护：7 天没跑过就强制跑一小轮，防止长期无欠账的库永远得不到维护。
 * @module dsh-kyzmem/maintenance/scheduler
 */

import type { KyzmemLanguage } from '../i18n/language.ts'
import { message } from '../i18n/messages.ts'
import { autoResolveBatch } from '../automation/orchestrator.ts'
import { liveHotConfig } from '../automation/live-config.ts'
import { retryDeadLetters } from '../ingest/hook.ts'
import type { MemoryJudge } from '../write-disposition.ts'
import { DEFAULT_REFURB_OPTIONS, gatherRefurbSuggestions } from '../refurb.ts'
import { runConsolidation } from '../consolidation/run.ts'
import type { HistoryBackfillRules, HistoryRunResult } from '../ingest/history.ts'
import type { ResolvedHistoryRules } from '../config.ts'
import type { KyzmemEmbedder } from '../embedder/interface.ts'
import type { KyzmemStore } from '../store/interface.ts'
import type { KyzmemScope, MaintenanceDebt, MaintenanceJob, MaintenanceRunResult } from '../types.ts'
import {
  ACTIVE_GROWTH_THRESHOLD, DUE_REVIEWS_THRESHOLD, MAINTENANCE_MIN_INTERVAL_MS,
  MAINTENANCE_STARVATION_MS, OPEN_CONFLICTS_THRESHOLD, computeDebt,
} from './debt.ts'

export { computeDebt } from './debt.ts'
export {
  ACTIVE_GROWTH_THRESHOLD, DUE_REVIEWS_THRESHOLD, MAINTENANCE_MIN_INTERVAL_MS,
  MAINTENANCE_STARVATION_MS, OPEN_CONFLICTS_THRESHOLD, GROWTH_WINDOW_MS,
} from './debt.ts'

/** 单次整理的预算：条数硬上限 + 时间软上限（超时只截断后续循环，不杀当前 SQL）。 */
export interface MaintenanceBudget {
  /** 时间软上限（毫秒）：传给 consolidation 的 deadline，循环内自查。 */
  readonly ms: number
  /** 单次处理条数上限（缺省任务份额）。 */
  readonly items: number
  /** 单次允许的辅助 LLM 调用数（0 = 只做本地规则）。 */
  readonly llmCalls: number
  /** decay 任务份额：减载档 100，正常档同 items。 */
  readonly decayItems?: number
  /** merge 任务份额：减载档 ≤50。 */
  readonly mergeItems?: number
}

/** 自动裁决联动的运行依赖（P2）：欠账门与预算门都在调度器侧判定。 */
export interface MaintenanceAutoResolveOptions {
  /** 后台裁决器（makeJudge 按路由现建；缺省 = 只跑规则轨）。 */
  readonly judge?: MemoryJudge
  /** 本轮最多自动解决的对数（autoResolveBatch 的 maxAuto，缺省 5）。 */
  readonly maxAuto?: number
  /** 24 小时自动解决上限（autoResolveBatch 的 dailyMax，缺省 20）。 */
  readonly dailyMax?: number
  /** 审计版本号（auto-action/auto-proposed 的 version 字段，调用方传插件 VERSION）。 */
  readonly version: string
}

/** 整理任务的运行依赖（由 index 注入）。 */
export interface MaintenanceRunOptions {
  /** 当前时间（测试可注入）。 */
  readonly now?: number
  /** 归档门槛天数（缺省 90，与 resolved.decayAfterDays 对齐由调用方传）。 */
  readonly olderThanDays?: number
  /** 库主 scope（user 库传 'user'，项目库传 'project'）。 */
  readonly scope?: KyzmemScope
  readonly language?: KyzmemLanguage
  /** 嵌入器（惰性 Promise）；未传 = 合并阶段仅启发式。 */
  readonly embedder?: Promise<KyzmemEmbedder | undefined>
  /**
   * 跨库合并回调（index 传入：枚举 dbDir 下 project-*.db 逐库整理）。
   * 未传时退回「只在当前 store 上跑 runConsolidation」。
   */
  readonly consolidate?: (store: KyzmemStore, maxItems: number, deadline: number) => Promise<number>
  /**
   * 自动裁决联动（P2）：欠账门（待裁决 >5）+ 预算门（llmCalls > 0 才带 judge）都在这里判。
   * 未传 = 本轮不跑自动裁决，只做既有整理三任务。
   */
  readonly autoResolve?: MaintenanceAutoResolveOptions
}

/** shouldRun 的判定依据（用于面板/测试解释为什么跳过）。 */
export type MaintenanceRunReason = 'due' | 'starved' | 'fresh'

/** 单次 kick 的结果说明。 */
export interface MaintenancePlan {
  readonly job: MaintenanceJob
  /** true = 饥饿保护的小轮（只做有限的衰减/合并，不碰 LLM）。 */
  readonly small: boolean
  readonly reason: MaintenanceRunReason
}

const MAINTENANCE_RUN_OP = 'maintenance-run'
const MAINTENANCE_LEASE_OP = 'maintenance-lease'
const ACTIVE_DAY_OP = 'active-day'

/** 单飞租约时长：一次整理理应远小于 5 分钟；进程崩溃后租约自然过期，不需要手动清。 */
export const MAINTENANCE_LEASE_MS = 5 * 60_000

/** 任务轮转顺序（契约：decay → merge → refurb）。 */
export const MAINTENANCE_ROTATION: readonly MaintenanceJob[] = ['decay', 'merge', 'refurb']

/** 本进程的租约 owner 前缀：pid + 启动时刻，跨进程互斥时用来区分。 */
const LEASE_OWNER_BASE = `${process.pid}-${Date.now().toString(36)}`

/** 同一 store 对象的进程内单飞：租约是跨进程的兜底，进程内更快拦掉重复 kick。 */
const inFlight = new WeakSet<object>()

/** 判断某类任务是否欠账超阈值。 */
export function jobDebtDue(job: MaintenanceJob, debt: MaintenanceDebt): boolean {
  if (job === 'decay') return debt.activeGrowth > ACTIVE_GROWTH_THRESHOLD
  if (job === 'merge') return debt.openConflicts > OPEN_CONFLICTS_THRESHOLD
  return debt.dueReviews > DUE_REVIEWS_THRESHOLD
}

/**
 * 该不该跑某个任务。
 * - 刚跑过（<1 天）一律不跑；
 * - 7 天没跑过 → 强制（饥饿保护）；
 * - 否则看该类任务的欠账是否超阈值。
 * @param lastRunAt - 上一次 maintenance-run 的时间（op_log 读取）；undefined = 从未跑过。
 */
export function shouldRun(job: MaintenanceJob, debt: MaintenanceDebt, lastRunAt: number | undefined, now: number = Date.now()): boolean {
  if (lastRunAt !== undefined && now - lastRunAt < MAINTENANCE_MIN_INTERVAL_MS) return false
  if (lastRunAt === undefined || now - lastRunAt >= MAINTENANCE_STARVATION_MS) return true
  return jobDebtDue(job, debt)
}

/**
 * 选择本次要跑的任务：从上次任务的下一个开始轮转，优先挑欠账超标的；
 * 全都不超标时走饥饿保护（轮转下一项，小轮）。
 * @param lastJob - 最近一次 maintenance-run 记录的任务；undefined = 从未跑过。
 */
export function planMaintenance(
  debt: MaintenanceDebt,
  lastRunAt: number | undefined,
  lastJob: MaintenanceJob | undefined,
  now: number = Date.now(),
): MaintenancePlan | undefined {
  if (lastRunAt !== undefined && now - lastRunAt < MAINTENANCE_MIN_INTERVAL_MS) return undefined
  const start = lastJob === undefined ? 0 : (MAINTENANCE_ROTATION.indexOf(lastJob) + 1) % MAINTENANCE_ROTATION.length
  const order = MAINTENANCE_ROTATION.map((_, index) => MAINTENANCE_ROTATION[(start + index) % MAINTENANCE_ROTATION.length]!)
  const dueJob = order.find(job => jobDebtDue(job, debt))
  if (dueJob !== undefined) {
    const starved = lastRunAt === undefined || now - lastRunAt >= MAINTENANCE_STARVATION_MS
    return { job: dueJob, small: starved, reason: starved ? 'starved' : 'due' }
  }
  // 无欠账：只有饥饿才跑，且只跑小轮（大轮留给有真实欠账的情况）。
  if (lastRunAt === undefined || now - lastRunAt >= MAINTENANCE_STARVATION_MS) {
    return { job: order[0]!, small: true, reason: 'starved' }
  }
  return undefined
}

/** 减载档预算：久未活跃时把 decay 限到 100 条、merge 限到 50 条，避免开机抢 IO。 */
export function idleBudget(base: MaintenanceBudget): MaintenanceBudget {
  return {
    ...base,
    decayItems: Math.min(base.decayItems ?? 100, 100),
    mergeItems: Math.min(base.mergeItems ?? 50, 50),
  }
}

/** 解析租约 detail（损坏的旧记录当过期处理，不让格式演进卡住调度）。 */
function parseLease(detail: string | null): { owner: string; until: number } | undefined {
  if (detail === null) return undefined
  try {
    const parsed = JSON.parse(detail) as { owner?: unknown; until?: unknown }
    if (typeof parsed.owner !== 'string' || typeof parsed.until !== 'number') return undefined
    return { owner: parsed.owner, until: parsed.until }
  } catch {
    return undefined
  }
}

/**
 * 获取单飞租约。
 * @returns 本次租约的 detail 串（释放时精确匹配清掉）；被他人持有时 undefined。
 */
async function acquireLease(store: KyzmemStore, now: number, owner: string): Promise<string | undefined> {
  const [row] = await store.recentAudit(MAINTENANCE_LEASE_OP, 1)
  if (row !== undefined) {
    const lease = parseLease(row.detail)
    if (lease !== undefined && lease.until > now) return undefined
    // 过期/损坏的租约顺手清掉：否则 op_log 每个进程崩溃都留一条，永久增长。
    try {
      await store.clearAudit(MAINTENANCE_LEASE_OP, row.detail ?? '')
    } catch {
      // 清理失败不阻塞：租约按 until 自然过期。
    }
  }
  const detail = JSON.stringify({ owner, until: now + MAINTENANCE_LEASE_MS })
  await store.audit(MAINTENANCE_LEASE_OP, 'BATCH', detail)
  return detail
}

/** 释放租约（仅清自己写的那条；失败无碍，过期即失效）。 */
async function releaseLease(store: KyzmemStore, detail: string): Promise<void> {
  try {
    await store.clearAudit(MAINTENANCE_LEASE_OP, detail)
  } catch {
    // 释放失败不抛：租约 5 分钟后自然过期，下一次 kick 会接管。
  }
}

/** decay 任务：归档低重要度长期条目（limit 由预算控制，避免长事务）。 */
async function runDecayJob(store: KyzmemStore, budget: MaintenanceBudget, options: MaintenanceRunOptions): Promise<number> {
  const limit = budget.decayItems ?? budget.items
  return store.decay({ olderThanDays: options.olderThanDays ?? 90, limit })
}

/** merge 任务：跨库 consolidation（优先用调用方注入的 sweep），返回合并条数。 */
async function runMergeJob(store: KyzmemStore, budget: MaintenanceBudget, options: MaintenanceRunOptions, deadline: number): Promise<number> {
  const maxItems = budget.mergeItems ?? budget.items
  if (options.consolidate !== undefined) return options.consolidate(store, maxItems, deadline)
  const report = await runConsolidation(store, options.embedder ?? Promise.resolve(undefined), {
    olderThanDays: options.olderThanDays ?? 30,
    scope: options.scope === 'project' || options.scope === 'shared' ? options.scope : 'user',
    maxRecords: maxItems,
    deadline,
  })
  return report.merged
}

/** refurb 任务：扫描 active 条目 + 待裁决冲突，产出建议条数（预览由面板/工具按需重算）。 */
async function runRefurbJob(store: KyzmemStore, budget: MaintenanceBudget, options: MaintenanceRunOptions): Promise<number> {
  const now = options.now ?? Date.now()
  const scope: KyzmemScope = options.scope ?? 'user'
  const records = await store.topActive(scope, Math.max(budget.items, DEFAULT_REFURB_OPTIONS.minActive))
  const conflicts = await store.listConflicts([scope], budget.items)
  const suggestions = gatherRefurbSuggestions(
    records,
    options.language ?? 'zh',
    DEFAULT_REFURB_OPTIONS,
    conflicts.items,
    now,
  )
  return suggestions.length
}

async function runJob(store: KyzmemStore, job: MaintenanceJob, budget: MaintenanceBudget, options: MaintenanceRunOptions, deadline: number): Promise<number> {
  if (job === 'decay') return runDecayJob(store, budget, options)
  if (job === 'merge') return runMergeJob(store, budget, options, deadline)
  return runRefurbJob(store, budget, options)
}

/** 增量回填窗口（天）：每天覆盖最近 7 天，幂等键保证重复跑不写重复记忆。 */
export const INCREMENTAL_BACKFILL_DAYS = 7
/** 增量回填连败熔断：连续 3 轮抛错即停，记暂停，当天不再跑。 */
export const INCREMENTAL_BACKFILL_MAX_CONSECUTIVE_FAILURES = 3
/** 增量回填单次超时（毫秒）：到期 abort，state 记 cancelled，不记暂停（下次 kick 重试）。 */
export const INCREMENTAL_BACKFILL_TIMEOUT_MS = 10 * 60_000
const BACKFILL_RUN_OP = 'backfill-run'
const BACKFILL_PAUSE_OP = 'backfill-pause'

/** 增量回填的运行依赖（index 注入：复用回填引擎，规则沿用配置默认值）。 */
export interface IncrementalBackfillRunner {
  readonly run: (
    rules: HistoryBackfillRules,
    signal: AbortSignal,
    options?: { maxConsecutiveFailures?: number },
  ) => Promise<HistoryRunResult>
  readonly defaults: ResolvedHistoryRules
}

export type IncrementalBackfillOutcome =
  | 'ran' | 'skipped-unconfigured' | 'skipped-idle' | 'skipped-no-budget' | 'skipped-today' | 'skipped-paused'

function parseBackfillDetail(detail: string | null): Record<string, unknown> | undefined {
  if (detail === null) return undefined
  try {
    const parsed: unknown = JSON.parse(detail)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    // 损坏的审计行当不存在：只影响今天跑不跑，不影响正确性。
  }
  return undefined
}

function auditDate(row: { at: number; detail: string | null } | undefined): string | undefined {
  const parsed = row === undefined ? undefined : parseBackfillDetail(row.detail)
  return typeof parsed?.['date'] === 'string' ? parsed['date'] as string : undefined
}

/**
 * 每日增量回填（Phase 4）：最近 7 天、配额内、连败暂停、减载档跳过。
 * - 减载档（久未活跃）不跑：开机回来先让人用，整理靠边站；
 * - llmCalls 预算为 0 不跑：回填每轮都要调辅助模型，无调用额度硬跑只会全失败；
 * - 一天只跑一次（backfill-run 按 UTC 日期去重，手动跑也算一次）；
 * - 上次以连败熔断收尾且之后没有成功完成过，不跑（等人工跑通一次自动清除）。
 * 跑完记 backfill-run（含 state/turnsDone/memoriesWritten）；熔断收尾额外记 backfill-pause。
 * @returns outcome 供 kick 解释「为什么没跑」；state 仅 ran 时有值。
 */
export async function maybeRunIncrementalBackfill(
  store: KyzmemStore,
  backfill: IncrementalBackfillRunner | undefined,
  budget: MaintenanceBudget,
  options?: { idle?: boolean; now?: number },
): Promise<{ outcome: IncrementalBackfillOutcome; state?: HistoryRunResult['state'] }> {
  if (backfill === undefined) return { outcome: 'skipped-unconfigured' }
  if (options?.idle === true) return { outcome: 'skipped-idle' }
  if (budget.llmCalls <= 0) return { outcome: 'skipped-no-budget' }
  const now = options?.now ?? Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const recentRuns = await store.recentAudit(BACKFILL_RUN_OP, 10)
  // 暂停门优先于 today 门：熔断后需要人工跑通一次，操作员看到的应该是 paused 而不是 today。
  // 同一次熔断收尾 backfill-run 与 backfill-pause 落在同一毫秒（at 相等），必须用 >=。
  const [lastPause] = await store.recentAudit(BACKFILL_PAUSE_OP, 1)
  const [lastRun] = recentRuns.slice(0, 1)
  if (lastPause !== undefined && (lastRun === undefined || lastPause.at >= lastRun.at)) {
    return { outcome: 'skipped-paused' }
  }
  if (recentRuns.some(row => auditDate(row) === today)) return { outcome: 'skipped-today' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), INCREMENTAL_BACKFILL_TIMEOUT_MS)
  try {
    const result = await backfill.run(
      {
        days: INCREMENTAL_BACKFILL_DAYS,
        maxTotalTurns: Math.min(budget.items, backfill.defaults.maxTotalTurns),
      },
      controller.signal,
      { maxConsecutiveFailures: INCREMENTAL_BACKFILL_MAX_CONSECUTIVE_FAILURES },
    )
    await store.audit(BACKFILL_RUN_OP, 'BATCH', JSON.stringify({
      date: today, auto: true, state: result.state,
      turnsDone: result.turnsDone, memoriesWritten: result.memoriesWritten,
    }))
    if (result.state === 'failed') {
      await store.audit(BACKFILL_PAUSE_OP, 'BATCH', JSON.stringify({ date: today, reason: 'consecutive-failures' }))
    }
    return { outcome: 'ran', state: result.state }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 跑一次自动裁决（P2 联动位）：内部 try/catch，失败只告警、不触碰既有整理的返回值。
 * 预算门：llmCalls <= 0 时不带 judge（纯规则轨）；双重失败（judge 和规则都抛错）
 * 由 autoResolveBatch 内部静默吞掉，这里只防它自身抛出的意外错误。
 */
async function runAutoResolve(
  store: KyzmemStore,
  opts: MaintenanceAutoResolveOptions,
  budget: MaintenanceBudget,
  now: number,
): Promise<MaintenanceRunResult['autoResolve']> {
  try {
    return await autoResolveBatch(store, {
      ...(opts.judge === undefined || budget.llmCalls <= 0 ? {} : { judge: opts.judge }),
      ...(opts.maxAuto === undefined ? {} : { maxAuto: opts.maxAuto }),
      ...(opts.dailyMax === undefined ? {} : { dailyMax: opts.dailyMax }),
      version: opts.version,
      now: () => now,
    })
  } catch (error) {
    console.warn(message('core.warnAutoResolveFailed'), error)
    return undefined
  }
}

/**
 * 跑一次整理任务（单任务 + 可选自动裁决联动）。
 * 语义：先抢租约（跨进程单飞），欠账门（待裁决 >5）通过且传了 autoResolve 依赖时先跑
 * 自动裁决，再跑本轮任务，最后写 'maintenance-run'（含 job/items/ms/debt，联动跑过
 * 则附 autoResolve 结果），
 * 租约在 finally 释放。时间预算为软上限：靠各任务的条数上限与 deadline 自查控制。
 * @returns 未抢到租约时 items=0、ms=0（不写 maintenance-run，避免伪造「刚整理过」）。
 */
export async function runMaintenance(
  store: KyzmemStore,
  job: MaintenanceJob,
  budget: MaintenanceBudget,
  options: MaintenanceRunOptions = {},
): Promise<MaintenanceRunResult> {
  const started = Date.now()
  const now = options.now ?? started
  const debt = await computeDebt(store, now)
  const owner = `${LEASE_OWNER_BASE}:${job}`
  const lease = await acquireLease(store, now, owner)
  if (lease === undefined) return { job, items: 0, ms: 0, debt }
  try {
    // P2 联动位：欠账门（待裁决 >5，与 merge 任务同阈值）通过且调用方传了依赖时，
    // 先跑自动裁决再跑本轮任务；无欠账 = 纯规则也判不出东西，直接省掉。
    const autoResolve = options.autoResolve !== undefined && debt.openConflicts > OPEN_CONFLICTS_THRESHOLD
      ? await runAutoResolve(store, options.autoResolve, budget, now)
      : undefined
    const deadline = started + Math.max(budget.ms, 1)
    const items = await runJob(store, job, budget, options, deadline)
    const ms = Date.now() - started
    // 审计失败不应吞掉整理结果，但也不能让 fire-and-forget 逃逸成未处理 rejection。
    try {
      await store.audit(MAINTENANCE_RUN_OP, 'BATCH', JSON.stringify({
        job, items, ms, debt, ...(autoResolve === undefined ? {} : { autoResolve }),
      }))
    } catch (error) {
      console.warn(message('core.warnMaintenanceAuditFailed'), error)
    }
    return { job, items, ms, debt, ...(autoResolve === undefined ? {} : { autoResolve }) }
  } finally {
    await releaseLease(store, lease)
  }
}

/** 最近一次 maintenance-run 记录的任务（用于轮转），读不到返回 undefined。 */
async function lastRunJob(store: KyzmemStore): Promise<MaintenanceJob | undefined> {
  const [row] = await store.recentAudit(MAINTENANCE_RUN_OP, 1)
  if (row === undefined || row.detail === null) return undefined
  try {
    const parsed = JSON.parse(row.detail) as { job?: unknown }
    const job = parsed.job
    return job === 'decay' || job === 'merge' || job === 'refurb' ? job : undefined
  } catch {
    return undefined
  }
}

/** 记录活跃日（一天一条）：维护调度据此判断「减载档」。 */
export async function recordActiveDay(store: KyzmemStore, now: number = Date.now()): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10)
  const existing = await store.listAuditDetails(ACTIVE_DAY_OP)
  if (!existing.includes(day)) await store.audit(ACTIVE_DAY_OP, 'AUX', day)
  // 只保留最近几天：这是「最后活跃时间」的近似来源，历史日不需要留档。
  for (const detail of existing) {
    if (detail === day) continue
    try {
      await store.clearAudit(ACTIVE_DAY_OP, detail)
    } catch {
      // 清理失败无碍：下一次 recordActiveDay 会重试。
    }
  }
}

/** 是否处于减载档（久未活跃）：无活跃记录视为久未活跃（新库先跑小轮，避免开机大扫）。 */
export async function isIdle(store: KyzmemStore, idleDays: number, now: number = Date.now()): Promise<boolean> {
  const lastActiveAt = await store.lastAuditAt(ACTIVE_DAY_OP)
  if (lastActiveAt === undefined) return true
  return now - lastActiveAt > idleDays * 86_400_000
}

/** kick 的依赖面：由 index 提供开库函数与预算。 */
export interface KickMaintenanceOptions extends MaintenanceRunOptions {
  readonly openStore: (scope: KyzmemScope) => Promise<KyzmemStore>
  readonly budget: MaintenanceBudget
  /** 减载档阈值天数（resolved.maintenance.idleDays）。 */
  readonly idleDays: number
  /** 总开关（resolved.maintenance.enabled）。 */
  readonly enabled?: boolean
  /** 成功跑完一次后的回调（index 用来打日志；不传则静默）。 */
  readonly onRun?: (result: MaintenanceRunResult) => void
  /** 失败回调（缺省 console.warn）。 */
  readonly onError?: (error: unknown) => void
  /**
   * 增量回填（Phase 4）：index 注入回填引擎，kick 按「每日一次」顺带跑。
   * 未传 = 不跑增量回填（手动回填照常用）。
   */
  readonly backfill?: IncrementalBackfillRunner
  /**
   * 热配置来源（Phase 2.1）：decayAfterDays 按次读覆盖层。
   * 只传 dbDir；未传 = decay 门槛用装载期快照。预算（ms/items/llmCalls）是冷键，仍走快照。
   */
  readonly hotDbDir?: string
}

/**
 * 模块级配置：index 在 apply() 里注入一次依赖面（openStore / budget / idleDays）。
 * 为什么要有这一层：路由的 health 面板与 pre-step 只能零参调用 kickMaintenance（它们是
 * 并行开发的另一条线，约定就是「导出 kickMaintenance()」）；依赖面在装载期配置，
 * 调用期只触发，避免调用方到处传一遍同样的参数。
 */
let configured: KickMaintenanceOptions | undefined

/** 注入/覆盖 kickMaintenance 的依赖面（重复调用以最后一次为准，热重载/测试友好）。 */
export function configureMaintenance(options: KickMaintenanceOptions): void {
  configured = options
}

/**
 * 触发一次后台整理：幂等、fire-and-forget、绝不抛错。
 * 触发点：apply 完成后 setImmediate、session/disposed、pre-step step===1、health 路由。
 * @param options - 缺省用 configureMaintenance 注入的依赖面；未配置时静默跳过。
 */
export function kickMaintenance(options?: KickMaintenanceOptions): void {
  const effective = options ?? configured
  // 未配置 = 插件还没完成装载（或测试只装载了路由）：没有开库函数可调用，静默跳过。
  if (effective === undefined) return
  if (effective.enabled === false) return
  void (async () => {
    const store = await effective.openStore('user')
    if (inFlight.has(store)) return
    const now = effective.now ?? Date.now()
    const lastRunAt = await store.lastAuditAt(MAINTENANCE_RUN_OP)
    const debt = await computeDebt(store, now)
    const idle = await isIdle(store, effective.idleDays, now)
    // Phase 4：每日增量回填（独立于 plan，有自己的 today/pause/预算门）。
    // 跑过一次就返回：一次 kick 只做一件重活，plan 留给下一次事件触发。
    if (effective.backfill !== undefined && !inFlight.has(store)) {
      inFlight.add(store)
      try {
        const backfill = await maybeRunIncrementalBackfill(store, effective.backfill, effective.budget, { idle, now })
        if (backfill.outcome === 'ran') return
      } finally {
        inFlight.delete(store)
      }
    }
    // Phase 5：死信每日重试（轻量：只读审计 + 重记 pending，不调 LLM）。
    // 每日门在函数内部（同一 UTC 日期只跑一遍）；这里失败也不阻断整理主流程。
    try {
      await retryDeadLetters(store)
    } catch {
      // 审计读失败：下一次 kick 会重试；整理主流程不受影响。
    }
    const plan = planMaintenance(debt, lastRunAt, await lastRunJob(store), now)
    if (plan === undefined) return
    const budget = plan.small || idle ? idleBudget(effective.budget) : effective.budget
    // 热 decay 门槛（Phase 2.1）：面板改完 decayAfterDays，下一次 kick 即生效，不用重启。
    // 预算仍是冷键，走装载期快照。
    const live = effective.hotDbDir === undefined ? undefined : liveHotConfig(effective.hotDbDir)
    const runOptions = live === undefined
      ? { ...effective, now }
      : { ...effective, now, olderThanDays: live.decayAfterDays }
    inFlight.add(store)
    try {
      const result = await runMaintenance(store, plan.job, budget, runOptions)
      if (effective.onRun !== undefined) effective.onRun(result)
      // 默认记一条完成日志：维护是后台行为，没有日志时用户完全看不出它跑过。
      else console.log(message('core.logMaintenanceDone', { job: result.job, items: result.items, ms: result.ms }))
    } finally {
      inFlight.delete(store)
    }
  })().catch((error: unknown) => {
    // 宿主把未处理 rejection 当致命错误（fail-loud），整理失败必须就地吞掉。
    if (effective.onError !== undefined) effective.onError(error)
    else console.warn(message('core.warnMaintenanceFailed'), error)
  })
}
