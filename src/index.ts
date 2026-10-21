/**
 * dsh-kyzmem：DeepSeek Harness 跨会话长期记忆插件（host 半）。
 * 注册 18 个 kyzmem_ 工具、会话开始注入画像（curated block 优先于派生画像）、
 * 自动摄取上一轮对话、蒸馏/衰减飞轮与审计能力。
 * @module dsh-kyzmem
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

// v4 消息源类型收编：本插件未声明裸名 kind，DSH v3→v4 迁移把本插件的历史源
// 统一改写为 `plugin:<包名>` 前缀形状（并去掉 plugin 字段），写入端沿用同一形状。
// 模式键声明合并让 MessageSource 联合收编该前缀，注入处无需类型断言。
// 本地别名：让 ambient 声明块里的引用落在普通类型位置（否则 noUnusedLocals 会把仅
// 在 `declare module` 块内引用的 import type 判成未使用）。
type PluginSourceFormed = ContextFormed
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    [kind: `plugin:${string}`]: { kind: `plugin:${string}` } & PluginSourceFormed
  }
}
import { resolveConfig } from './config.ts'
import type { KyzmemConfig, ResolvedKyzmemConfig } from './config.ts'
import type { KyzmemLanguage } from './i18n/language.ts'
import { message, messageIn, setMessageLanguage } from './i18n/messages.ts'
import { setExtraRedactWords } from './i18n/patterns.ts'
import { roomLabel } from './i18n/rooms.ts'
import { createLocalEmbedder } from './embedder/local.ts'
import type { KyzmemEmbedder } from './embedder/interface.ts'
import { FINAL_INGEST_TIMEOUT_MS, ensureSessionSummary, ingestFinalTurn, ingestPreviousTurn, ingestWriteRouting, lastTurnNumber, replayPendingIngests } from './ingest/hook.ts'
import { estimateHistoryBackfill, runHistoryBackfill } from './ingest/history.ts'
import type {
  HistoryBackfillDeps, HistoryBackfillRules, HistoryEstimate, HistoryLogSource, HistoryRunProgress, HistoryRunResult,
  HistorySessionHeader,
} from './ingest/history.ts'
import { consolidateDatabases } from './consolidation/run.ts'
import { configureMaintenance, isIdle, kickMaintenance, recordActiveDay } from './maintenance/scheduler.ts'
import type { KickMaintenanceOptions } from './maintenance/scheduler.ts'
import { reflectObservations } from './consolidation/reflect.ts'
import type { IngestRequestEventData } from './ingest/hook.ts'
import { parseJsonArray, routeFromEvents, streamText } from './llm/client.ts'
import type { LlmRoute, SessionEventLike } from './llm/client.ts'
import { registerKyzmemRoutes } from './routes.ts'
import type { ProjectPalaceView, RouteDeps } from './routes.ts'
import { migrateProjectDb, migrationWarning, resolveProjectIdentity } from './project/identity.ts'
import { importLegacyData } from './legacy/import.ts'
import { findProjectPalace, listProjectPalaces } from './project/registry.ts'
import type { ProjectPalace, WorkspaceRef } from './project/registry.ts'
import { openKyzmemStore } from './store/sqlite.ts'
import type { KyzmemStore } from './store/interface.ts'
import { createKyzmemTools } from './tools/create.ts'
import { currentUserRequestText, renderMemoryPacket } from './security/sanitize.ts'
import { wrapWithRationale } from './selection-rationale.ts'
import { buildAssessReminder, evidenceBatches } from './retrieve/evidence.ts'
import { estimateTokens } from './token.ts'
import type { KyzmemScope, Slot } from './types.ts'

/** Cordis 插件名（loader 诊断与注入 source 使用）。 */
export const name = 'dsh-kyzmem'

/** 插件版本：单一来源 = package.json（审计 F9：手写常量已漂移到 0.7.6，备份 _meta.json 随之记错版本）。 */
import pluginPackageJson from '../package.json' with { type: 'json' }
export const VERSION: string = pluginPackageJson.version

/** 必需服务：工具注册表与 LLM 流式端点（摄取/蒸馏的辅助调用）。 */
export const inject = ['tools', 'llm']

/** Loader 读取的配置校验面（cordis.yml config 字段）。 */
export { Config } from './config.ts'
export type { KyzmemConfig } from './config.ts'

/** 画像渲染结果：text 为注入文本；overflow 为未获得整行的条目（压缩候选）。 */
export interface ProfileRender {
  readonly text: string
  readonly overflow: readonly { id: string; kind: string; content: string }[]
}

/** 分级递减的单条正文预算：第 i 条预算 = max(floor, round(start × decay^i))。 */
export interface GraduatedItemBudget {
  /** 首条正文字符预算。 */
  readonly start: number
  /** 逐条递减系数。 */
  readonly decay: number
  /** 下限字符预算。 */
  readonly floor: number
}

/** 分级递减预算默认值（配置缺省时由 resolveConfig 显式落地，同值于此）。 */
export const DEFAULT_ITEM_BUDGET: GraduatedItemBudget = { start: 160, decay: 0.9, floor: 24 }

/**
 * 会话开始注入的画像渲染：按重要性降序装填，单条正文按分级递减预算截断
 * （首条 160 字、逐条 ×0.9、下限 24 字——排名越靠后单条越短，平滑降级替代
 * 整条降级索引行）；token 预算（估算见 estimateTokens：中文按 1.5 token/字、
 * 其余按 4 字符/token）是外层硬约束：截断后仍装不下的条目先以 40 字索引行
 * 兜底，索引行也装不下的折成末尾 `+N more; use kyzmem_search` 计数行；计数行同样占用预算。
 * @param records - 候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（含首尾固定行）。
 * @param language - 房间名的显示语言（房间里存的是标识符，不是文本）。
 * @param itemBudget - 分级递减的单条正文预算（缺省用 DEFAULT_ITEM_BUDGET；配置面在 resolveConfig）。
 * @returns 渲染文本与溢出条目（调用方可用辅助 LLM 压缩后重渲染）。
 */
export function renderProfileDetailed(
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
  language: KyzmemLanguage,
  itemBudget: GraduatedItemBudget = DEFAULT_ITEM_BUDGET,
  /** 是否把固定的「怎么用工具」footnote 计入文本；注入路径把它移到协议标签外包（控制面外移）。 */
  includeFooter = true,
): ProfileRender {
  const estimate = estimateTokens
  // 主厅：常驻核心记忆层（每次会话都在场），行内带宫殿坐标（房间 #桩位）让 agent 有位置感。
  const header = messageIn(language, 'core.profileHeader')
  const footer = messageIn(language, 'core.profileFooter')
  let remaining = Math.max(0, tokenBudget - estimate(header) - (includeFooter ? estimate(footer) : 0))
  const lines: string[] = []
  const overflow: { id: string; kind: string; content: string }[] = []
  records.forEach((record, index) => {
    // 分级递减：第 i 条正文预算 = max(floor, start × decay^i)，超长截断（保留条目数优先于单条完整度）。
    const budget = Math.max(itemBudget.floor, Math.round(itemBudget.start * itemBudget.decay ** index))
    const content = record.content.length > budget ? `${record.content.slice(0, budget)}…` : record.content
    const slot = record.slot === undefined ? '' : ` ${roomLabel(record.slot.room, language)}#${record.slot.index}`
    const line = `- [${record.kind}]${slot} ${content}`
    const cost = estimate(line)
    if (cost <= remaining) {
      lines.push(line)
      remaining -= cost
    } else {
      overflow.push(record)
    }
  })
  let more = 0
  // 末尾计数行同样占预算：先按最大位数预留再装索引行，否则补行后总量会超出预算。
  // 预算小到连预留都放不下时（remaining 转负）不输出计数行，保证总量不超承诺。
  remaining -= overflow.length === 0 ? 0 : estimate(`+${overflow.length} more; use kyzmem_search`)
  for (const record of overflow) {
    const line = `- [${record.kind}] #${record.id} ${record.content.slice(0, 40)}…`
    const cost = estimate(line)
    if (cost <= remaining) {
      lines.push(line)
      remaining -= cost
    } else {
      more += 1
    }
  }
  if (more > 0 && remaining >= 0) lines.push(`+${more} more; use kyzmem_search`)
  // footer 是控制面提示（「去调用工具」），注入路径要求放在 <memory_context> 标签之外，
  // 由调用方拼到协议包外；纯渲染接口默认保留，供面板/测试复用。
  const parts = includeFooter ? [header, ...lines, footer] : [header, ...lines]
  return { text: parts.join('\n'), overflow }
}

/**
 * 会话开始注入的画像渲染（只取文本；溢出明细见 renderProfileDetailed）。
 * @param records - 候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（含首尾固定行）。
 * @returns 注入文本。
 */
export function renderProfile(
  records: readonly { id: string; kind: string; content: string }[],
  tokenBudget: number,
  language: KyzmemLanguage,
): string {
  return renderProfileDetailed(records, tokenBudget, language).text
}

/**
 * curated block 段的标题行（模型据此知道这一段是人工维护的最高优先画像）。
 * Значение английское: автор написал эту строку по-английски, поэтому в китайском
 * наборе она совпадает с английской. Для показа берите
 * `messageIn(language, 'core.curatedHeader')` — так делает renderProfileWithCurated.
 * Модульная константа вычисляется при загрузке модуля, то есть ДО того, как плагин
 * узнаёт язык из настроек, и навсегда застыла бы в английском.
 */
export const CURATED_HEADER = message('core.curatedHeader')

/**
 * 画像渲染（curated 优先）：有 curated block 时其全文置于派生画像之前（模型可见的
 * 第一段），并先从 token 预算中扣除自身占用，剩余预算才给派生条目装填；派生段
 * 照旧走分级递减与索引行/计数行降级。curated 是用户显式维护的意志，即使超出剩余
 * 预算也完整注入（与 due 行同理）；block 缺省时等同 renderProfileDetailed。
 * @param curated - 当前态 curated block；undefined = 尚未编辑过。
 * @param records - 派生画像候选条目（调用方已按重要性排序、按条数截断）。
 * @param tokenBudget - 整段画像的 token 预算（curated 段与派生段共享）。
 * @param itemBudget - 分级递减的单条正文预算（透传 renderProfileDetailed）。
 * @returns 渲染文本与派生段的溢出条目。
 */
export function renderProfileWithCurated(
  curated: { content: string } | undefined,
  records: readonly { id: string; kind: string; content: string; slot?: Slot }[],
  tokenBudget: number,
  language: KyzmemLanguage,
  itemBudget: GraduatedItemBudget = DEFAULT_ITEM_BUDGET,
  /** 是否保留 footnote（注入路径传 false，把控制面提示移到协议标签之外）。 */
  includeFooter = true,
): ProfileRender {
  if (curated === undefined) return renderProfileDetailed(records, tokenBudget, language, itemBudget, includeFooter)
  const curatedSection = `${messageIn(language, 'core.curatedHeader')}\n${curated.content}`
  const detailed = renderProfileDetailed(records, Math.max(0, tokenBudget - estimateTokens(curatedSection)), language, itemBudget, includeFooter)
  return { text: `${curatedSection}\n${detailed.text}`, overflow: detailed.overflow }
}

/** 压缩辅助调用的输出 token 上限（40 字 × 若干条，短输出足够）。 */
const COMPRESS_MAX_TOKENS = 800
/** 压缩辅助调用超时：压缩在 pre-step 关键路径上，必须限时防阻塞首轮请求。 */
const COMPRESS_TIMEOUT_MS = 8000
/** turn_start 注入的巩固信念条数上限（按证据数、新近度倒序）。 */
const OBSERVATION_INJECT_LIMIT = 3
/** 单条信念注入截断字符数。 */
const OBSERVATION_INJECT_ITEM_CHARS = 120
/** 信念区块总字符上限（独立于画像 token 预算，避免与画像互相挤压）。 */
const OBSERVATION_INJECT_BLOCK_CHARS = 480
/** 今日待回忆计数上限：超过该值只显示 N+（避免大库把提示行撑长）。 */
const DUE_REVIEW_DISPLAY_CAP = 50
/** 减载档（久未活跃）下重放 pending 摄取的条数上限。 */
const IDLE_REPLAY_MAX_ITEMS = 3
/** 采用率观测：这些工具被调用即视为 agent 回查过记忆证据。 */
const RECALL_EVIDENCE_TOOLS = new Set(['kyzmem_assess', 'kyzmem_examine'])
/** recall op_log detail 里 ids 数组的信任上限（detail 有 512 字截断，防御性封顶）。 */
const MAX_RECALL_IDS = 64

/** 从 recall 审计 detail 里取命中 id；格式漂移时返回空数组（退化为只按工具调用判定）。 */
function parseRecallIds(detail: string | null): string[] {
  if (detail === null) return []
  try {
    const parsed = JSON.parse(detail) as { ids?: unknown }
    if (!Array.isArray(parsed.ids)) return []
    return parsed.ids.filter((id): id is string => typeof id === 'string' && id !== '').slice(0, MAX_RECALL_IDS)
  } catch {
    return []
  }
}

/**
 * 上一轮是否用到了召回证据：recall 之后的 assistant 文本含任一命中 id，或调用了回查类工具。
 * 这是「召回有没有被用上」唯一可得的信号——不追求精确归因，只做 used/ignored 二值统计。
 */
function recallWasUsed(events: readonly SessionEventLike[], ids: readonly string[], since: number): boolean {
  for (const event of events) {
    // recall 之前的历史轮次不算：只看这批证据之后产生的输出。
    if (event.time !== undefined && event.time < since) continue
    if (event.type === 'tool/call') {
      const name = (event.data as { name?: unknown } | null)?.name
      if (typeof name === 'string' && RECALL_EVIDENCE_TOOLS.has(name)) return true
      continue
    }
    if (event.type !== 'assistant/message') continue
    const content = (event.data as { content?: { type?: unknown; text?: unknown }[] } | null)?.content
    for (const block of content ?? []) {
      if (block?.type !== 'text') continue
      const text = block.text
      if (typeof text !== 'string') continue
      if (ids.some(id => text.includes(id))) return true
    }
  }
  return false
}

/**
 * R1 采用率：step>1 开答前读最近一条 recall 审计，检查上一轮是否用上了那批证据，
 * 写 op_log recall-used / recall-ignored（同一次 recall 只记一条，靠 state.lastRecallBatch 去重）。
 * 为什么在 pre-step 而不是工具层：只有下一轮开始时才可能知道模型有没有引用证据。
 */
async function auditRecallAdoption(
  openStore: (scope: KyzmemScope) => Promise<KyzmemStore>,
  openStoreForProjectCwd: (cwd: string) => Promise<KyzmemStore>,
  agent: Agent,
  state: { lastRecallBatch: string | null },
): Promise<void> {
  const events = agent.session.snapshotEvents() as unknown as readonly SessionEventLike[]
  const cwd = sessionCwd(agent.session)
  // recall 写在检索实际落到的库里：私人库永远查；有 cwd 时再查当前项目库（少开会话不用的库）。
  const stores: KyzmemStore[] = [await openStore('user')]
  if (cwd !== undefined) stores.push(await openStoreForProjectCwd(cwd))
  let latest: { store: KyzmemStore; at: number; ids: string[] } | undefined
  for (const store of stores) {
    const [row] = await store.recentAudit('recall', 1, 'BATCH')
    if (row === undefined) continue
    if (latest === undefined || row.at > latest.at) latest = { store, at: row.at, ids: parseRecallIds(row.detail) }
  }
  if (latest === undefined) return
  const batch = `${String(latest.at)}#${latest.ids.join(',')}`
  if (state.lastRecallBatch === batch) return
  state.lastRecallBatch = batch
  const used = recallWasUsed(events, latest.ids, latest.at)
  await latest.store.audit(used ? 'recall-used' : 'recall-ignored', 'BATCH', JSON.stringify({ batch, ids: latest.ids }))
}

/**
 * 画像超预算的辅助压缩：把装不下的条目交给辅助 LLM 压短，返回 id → 压缩文本。
 * 任何失败（无路由、输出不可解析、超时、调用异常）返回 undefined，调用方
 * 降级回索引行装填。压缩请求审计到 user 库 op_log（model-visible ⟺ logged：
 * 压缩产物本身会随注入消息进会话日志）。
 */
async function compressProfileOverflow(
  ctx: Context,
  agent: Agent,
  routeOverride: LlmRoute | undefined,
  overflow: readonly { id: string; kind: string; content: string }[],
  signal: AbortSignal,
): Promise<Map<string, string> | undefined> {
  try {
    const events = agent.session.snapshotEvents() as unknown as readonly SessionEventLike[]
    const route = routeOverride ?? routeFromEvents(events)
    if (route === undefined) return undefined
    const userText = JSON.stringify(overflow.map(record => ({ id: record.id, content: record.content })))
    const raw = await streamText(ctx, {
      route,
      system: message('core.compressSystem'),
      userText,
      maxTokens: COMPRESS_MAX_TOKENS,
      purpose: 'kyzmem-compress',
      sessionId: agent.session.id,
      signal: AbortSignal.any([signal, AbortSignal.timeout(COMPRESS_TIMEOUT_MS)]),
    })
    const parsed = parseJsonArray(raw)
    if (parsed === undefined) return undefined
    const ids = new Set(overflow.map(record => record.id))
    const compressed = new Map<string, string>()
    for (const item of parsed) {
      const entry = item as { id?: unknown; content?: unknown }
      if (typeof entry.id !== 'string' || typeof entry.content !== 'string') continue
      // 只接受输入清单里的 id 与非空且确实更短的压缩结果。
      if (!ids.has(entry.id) || entry.content.trim() === '' || entry.content.length >= overflow.find(record => record.id === entry.id)!.content.length) continue
      compressed.set(entry.id, entry.content.trim())
    }
    return compressed.size > 0 ? compressed : undefined
  } catch {
    // 压缩是增强路径：失败一律降级回现有索引行装填。
    return undefined
  }
}

/**
 * agent/pre-step waterfall：每轮第一步注入画像（内容与上次相同则跳过重复注入）；
 * 同时 fire-and-forget 触发上一轮的自动摄取（不阻塞请求）；进程内首次第一步
 * 重放待补做的末轮摄取。必须调用 next() 委托链路；reject 决策原样透传，
 * 记忆库为空或非首轮时不追加消息。
 */
async function preStep(
  ctx: Context,
  openStore: (scope: KyzmemScope) => Promise<KyzmemStore>,
  openStoreForProjectCwd: (cwd: string) => Promise<KyzmemStore>,
  resolved: ResolvedKyzmemConfig,
  embedder: Promise<KyzmemEmbedder | undefined>,
  state: {
    pendingReplayed: boolean
    lastProfileAgent: string | null
    lastProfileHash: string | null
    lastProfileCompactions: number | null
    /** 上次注入的评估提醒去重键 = 最近批次 id + pending 批次数。 */
    lastAssessReminder: string | null
    /** 上次统计过采用率的 recall 批次（at + ids），避免同一批证据重复记账。 */
    lastRecallBatch: string | null
    route: LlmRoute | undefined
  },
  logRequest: (data: IngestRequestEventData) => void,
  { agent, step, turn, signal }: { agent: Agent; step: number; turn: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  // 记录当前会话在用的路由：历史回填优先复用它——历史日志里的 provider/model 是当年的，
  // 在当前环境可能已不可用（如换过提供商），用当前模型才跑得通。
  if (step === 1) {
    const currentRoute = resolved.routeOverride ?? routeFromEvents(agent.session.snapshotEvents() as unknown as readonly SessionEventLike[])
    if (currentRoute !== undefined) state.route = currentRoute
  }
  const mode = resolved.ingest
  // 写入路由：本会话有 cwd 时默认进项目宫殿、逐条采纳模型的 scope 判定；无 cwd 只能进私人宫殿。
  const routing = ingestWriteRouting(sessionCwd(agent.session), openStoreForProjectCwd, openStore)
  // 活跃日 + 后台整理：apply 完成后、会话处置、每轮第一步三处触发（健康路由是第四处）。
  // 先判 idle 再记活跃日——顺序反了，刚写下的今天会让「久未活跃」永远为假。
  let idle = false
  if (step === 1) {
    try {
      const activeStore = await openStore('user')
      idle = await isIdle(activeStore, resolved.maintenance.idleDays)
      await recordActiveDay(activeStore)
    } catch (error) {
      console.warn(message('core.warnMaintenanceFailed'), error)
    }
    // 幂等 + fire-and-forget：scheduler 内部按欠账阈值与频率下限决定是否真跑，绝不阻塞本步。
    kickMaintenance()
  }
  if (step === 1 && mode !== 'off') {
    // 重放待补做的末轮摄取（上次会话 disposed 失败/超时的 pending 键）。
    if (!state.pendingReplayed) {
      state.pendingReplayed = true
      void replayPendingIngests({
        openStore: () => openStore('user'),
        resolveSession: makeSessionResolver(ctx, agent),
        resolveStore: openStoreForProjectCwd,
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
        ttlDaysByKind: resolved.ttlDaysByKind,
        ingestDeadLetterAttempts: resolved.ingestDeadLetterAttempts,
        // 减载档：久未活跃时只补最近的几条 pending，别在用户回来第一轮就补一堆。
        ...(idle ? { maxItems: IDLE_REPLAY_MAX_ITEMS } : {}),
      }).catch((error: unknown) => {
        console.warn(message('core.warnReplayPendingFailed'), error)
      })
    }
    // 自动摄取：新一轮第一步读上一轮日志。异步执行，失败仅告警计数。
    if (turn > 1) {
      void ingestPreviousTurn({
        events: agent.session.snapshotEvents() as unknown as readonly SessionEventLike[],
        sessionId: String(agent.id),
        turn,
        openStore: () => openStore('user'),
        openAuditStore: () => openStore('user'),
        ...routing,
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        call: params => streamText(ctx, { ...params, sessionId: agent.session.id }),
        logRequest,
        signal,
        ttlDaysByKind: resolved.ttlDaysByKind,
      }).catch((error: unknown) => {
        console.warn(message('core.warnIngestPreviousFailed'), error)
      })
    }
  }
  // R1 采用率：step>1 时检查上一轮 recall 之后模型有没有用那批证据（失败不影响对话）。
  if (step > 1) {
    try {
      await auditRecallAdoption(openStore, openStoreForProjectCwd, agent, state)
    } catch (error) {
      // 统计是旁路观测：宿主 fail-loud，必须就地吞掉。
      console.warn(message('core.warnRecallAuditFailed'), error)
    }
  }
  if (step !== 1 && resolved.assessReminder) {
    // 证据门收尾提醒：本会话存在未判定批次时在下一步开始前提醒（插件层注入，
    // 不动 agent-loop）；去重键 = 最近批次 id + pending 批次数——批次一变就重新提醒，
    // 批次判定完（pending 变少/清空）自然停发。文本比较会让「同文案新批次」漏提醒。
    const sessionId = String(agent.session.id)
    const pendingBatches = evidenceBatches.pendingBatches(sessionId)
    const pending = pendingBatches.length
    const latestBatchId = pendingBatches[pending - 1]?.batchId ?? '-'
    const reminderKey = `${latestBatchId}#${String(pending)}`
    const reminder = buildAssessReminder(pending, evidenceBatches.insufficientStreak(sessionId))
    if (reminder !== undefined && reminderKey !== state.lastAssessReminder) {
      state.lastAssessReminder = reminderKey
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: reminder }],
            source: { kind: `plugin:${name}`, form: 'snapshot', sections: [{ name, text: reminder }] },
          }),
        ],
      }
    }
  }
  // #32：画像「always present」不能只靠 step===1 的首轮注入——会话压缩（compaction）
  // 会把注入的快照摘要掉，而 step 在压缩/恢复后永远不会再等于 1，画像从此缺席直到
  // 重开对话。自上次注入以来出现 compaction/end 事件时，任何一轮都重新注入；哈希去重
  // 只在无压缩时生效（压缩后即使内容未变也要重注——旧包已不在上下文）。
  // 已知边界：应用重启后 state 清空，重启之前发生的压缩无法感知（此时历史快照仍在，
  // 保守不重注）；纯恢复（无压缩）时快照仍在历史里，维持不重注。
  const compactionCount = (agent.session.snapshotEvents() as unknown as readonly SessionEventLike[])
    .filter(event => event.type === 'compaction/end').length
  const compacted = state.lastProfileCompactions !== null && compactionCount > state.lastProfileCompactions
  if (state.lastProfileCompactions === null) state.lastProfileCompactions = compactionCount
  if (step !== 1 && !compacted) return decision
  const store = await openStore('user')
  // curated block：kyzmem_profile_edit 维护的画像段，优先于自动派生画像注入。
  const curated = await store.getProfileBlock('user')
  // 注入候选过滤：过期条目（expires_at ≤ now）与不可信 tier（不在 resolved.injectTiers）不进常驻画像。
  // 为什么在入口过滤而不是改 SQL：injectTiers 是运行期配置，topActive 还要被面板与工具复用；
  // 多取 3 倍候选再截断，避免过滤后画像空掉（高排名条目可能恰好全是过期/不可信）。
  const now = Date.now()
  const injectTiers = new Set<string>(resolved.injectTiers)
  const top = (await store.topActive('user', Math.max(resolved.profileTopN * 3, resolved.profileTopN)))
    .filter(record => (record.expiresAt === undefined || record.expiresAt > now)
      && injectTiers.has(record.sourceTier ?? 'agent-inferred'))
    .slice(0, resolved.profileTopN)
  if (top.length === 0 && curated === undefined) return decision
  // 今日待回忆提示（检索练习调度）：有到期条目时在画像末尾附一行，引导 agent 主动自测。
  // user + project 两库合并计数；50 为计数上限（超过显示 50+）。
  const dueTotal = resolved.reviewScheduling
    ? (await Promise.all((['user', 'project'] as const).map(async scope =>
        (await openStore(scope)).dueReviews(Date.now(), 50)))).reduce((sum, rows) => sum + rows.length, 0)
    : 0
  const detailed = renderProfileWithCurated(
    curated,
    top,
    resolved.injectTokenBudget,
    resolved.language,
    { start: resolved.injectItemBudgetStart, decay: resolved.injectItemBudgetDecay, floor: resolved.injectItemBudgetFloor },
    // 控制面外移：footnote 不进 <memory_context>，在下面拼到协议包之后。
    false,
  )
  let text = detailed.text
  // 超预算压缩：装不下的条目交给辅助 LLM 压短后重渲染；失败保持索引行降级不变。
  if (detailed.overflow.length > 0) {
    const compressed = await compressProfileOverflow(ctx, agent, resolved.routeOverride, detailed.overflow, signal)
    if (compressed !== undefined) {
      // 辅助请求审计（压缩产物随注入消息进会话日志；请求本身落 op_log 供归因）。
      void openStore('user').then(auditStore => auditStore.audit('compress-request', 'AUX', JSON.stringify({ count: detailed.overflow.length }))).catch(() => { /* 审计失败不影响注入 */ })
      text = renderProfileWithCurated(
        curated,
        top.map(record => {
          const shorter = compressed.get(record.id)
          return shorter === undefined ? record : { ...record, content: shorter }
        }),
        resolved.injectTokenBudget,
        resolved.language,
        { start: resolved.injectItemBudgetStart, decay: resolved.injectItemBudgetDecay, floor: resolved.injectItemBudgetFloor },
        false,
      ).text
    }
  }
  // 巩固信念区块：active 信念按证据数/新近度取前 N，拼入同一份画像包；
  // stale/refuted 不注入。区块独立于画像预算（固定硬上限），信念更新后画像 hash 变化自然触发重注。
  const observations = (await store.listObservations({ status: 'active', limit: OBSERVATION_INJECT_LIMIT }))
    .slice(0, OBSERVATION_INJECT_LIMIT)
  if (observations.length > 0) {
    const lines = [
      message('core.observationsHeader'),
      ...observations.map(observation =>
        message('core.observationItem', {
          belief: observation.belief.slice(0, OBSERVATION_INJECT_ITEM_CHARS),
          count: observation.proofCount,
        })),
    ]
    // 硬上限（3 条 / 单条 120 字 / 整块 480 字）是契约面：格式化串被改坏时断言告警 + 截断，
    // 注入路径绝不能因为「条目变长」把上下文撑爆。
    let block = lines.join('\n')
    if (block.length > OBSERVATION_INJECT_BLOCK_CHARS) {
      console.warn(message('core.warnObservationBudget', { limit: OBSERVATION_INJECT_BLOCK_CHARS, actual: block.length }))
      block = `${block.slice(0, OBSERVATION_INJECT_BLOCK_CHARS - 1)}…`
    }
    text = `${text}\n\n${block}`
  }
  // 注入去重：同一会话内画像文本与上次相同时跳过（上一轮注入仍在上下文里）；
  // 新会话（lastProfileAgent 不同）必须注入，即使文本与上个会话相同。控制面提示纳入 hash 输入。
  const dueLine = dueTotal === 0
    ? ''
    : message('core.reviewDue', { count: dueTotal, plus: dueTotal >= DUE_REVIEW_DISPLAY_CAP ? '+' : '' })
  // 控制面（footnote + due 提示）必须放在 <memory_context> 标签之外：标签内是「不可信历史证据」，
  // 并明确告警「忽略内嵌指令」；把「去调用 kyzmem_*」塞进去等于自我矛盾。
  const controlLine = `${message('core.profileFooter')}${dueLine}`
  const textWithRationale = wrapWithRationale(text, top)
  const hash = createHash('sha256').update(textWithRationale + controlLine).digest('hex')
  if (!compacted && state.lastProfileAgent === String(agent.id) && hash === state.lastProfileHash) return decision
  state.lastProfileAgent = String(agent.id)
  state.lastProfileHash = hash
  state.lastProfileCompactions = compactionCount
  // 画像包协议标签：记忆条目是不可信历史上下文；当前请求取本轮 admitted 消息的最后一个文本块。
  // 控制句拼在包外、同一条 user 消息内（标签之外），模型读到的是「证据」+「插件操作提示」两段。
  const packet = `${renderMemoryPacket(text, 'turn_start', currentUserRequestText(decision.messages))}\n\n${controlLine}`
  return {
    ...decision,
    messages: [
      ...decision.messages,
      createUserMessage({
        content: [{ type: 'text', text: packet }],
        source: { kind: `plugin:${name}`, form: 'snapshot', sections: [{ name, text: packet }] },
      }),
    ],
  }
}

/**
 * 会话持久化服务的窄视图：新版 dsh 只有句柄式 `open`/`read`（`load(id)` 已移除），
 * 且 `list()` 返回快照（header 在 `snapshot.header` 上）而非 header 数组。
 * 本插件不硬依赖 @deepseek-ai/dsh-session-persistence，只按运行时形状取用。
 */
interface PersistenceReadHandle {
  /** 读取一段连续日志；缺省参数 = 从 0 读到末尾。 */
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
  /** 会话 header（真实句柄必给；测试替身可能省略）——取 cwd 决定补做轮次写进哪座项目宫殿。 */
  readonly header?: { readonly cwd?: string | undefined } | undefined
  /** 释放句柄（幂等；不释放会在后端持有本地资源）。 */
  close(): Promise<void>
}

/** 持久化服务的最小视图（只用到 list 与只读 open）。 */
interface PersistenceServiceView {
  /** 列出全部已持久化会话的快照（宿主接口不分页不过滤）。 */
  list(options?: { signal?: AbortSignal }): Promise<readonly { header: HistorySessionHeader }[]>
  /** 只读打开一个已持久化会话；不取写所有权，可与活跃写入者并存。 */
  open(id: string, access: 'read'): Promise<PersistenceReadHandle>
}

/**
 * 会话工作目录（决定它的记忆进哪座项目宫殿）。
 * 真实 `Session.header` 恒在；测试替身可能省略 header，故按可选形状读取。
 * @param session - 会话（或替身）对象。
 * @returns cwd；取不到时 undefined（该会话的回退口径是私人宫殿）。
 */
function sessionCwd(session: { readonly header?: { readonly cwd?: string | undefined } | undefined } | undefined): string | undefined {
  const cwd = session?.header?.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

/**
 * 只读打开会话日志 → 交给调用方读取 → 必关闭句柄。
 * close 失败不掩盖读取结果（读取成功而 close 失败时仍返回成功值）。
 * @param persistence - 持久化服务视图。
 * @param sessionId - 目标会话 id。
 * @param use - 句柄使用回调。
 * @returns 回调结果。
 */
async function withReadHandle<T>(
  persistence: PersistenceServiceView,
  sessionId: string,
  use: (handle: PersistenceReadHandle) => Promise<T>,
): Promise<T> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    return await use(handle)
  } finally {
    await handle.close().catch(() => { /* 关闭失败无补救动作 */ })
  }
}

/**
 * pending 重放的会话解析器：pending 属于当前会话时直接用其事件快照与 cwd；
 * 其余会话经可选的 sessionPersistence 服务（只读句柄）读持久化日志与 header.cwd
 * （服务缺席或读取失败返回 undefined，pending 保留到下次，不报错）。
 */
function makeSessionResolver(
  ctx: Context,
  agent: Agent,
): (sessionId: string) => Promise<{ events: readonly SessionEventLike[]; cwd?: string | undefined } | undefined> {
  return async sessionId => {
    if (sessionId === String(agent.id)) {
      return {
        events: agent.session.snapshotEvents() as unknown as readonly SessionEventLike[],
        cwd: sessionCwd(agent.session),
      }
    }
    // 可选服务，kyzmem 不硬依赖：缺席时跨会话 pending 保留到该会话被恢复。
    const persistence = ctx.get('sessionPersistence' as never) as PersistenceServiceView | undefined
    if (persistence === undefined) return undefined
    try {
      return await withReadHandle(persistence, sessionId, async handle => ({
        events: (await handle.read()).events as readonly SessionEventLike[],
        cwd: sessionCwd(handle),
      }))
    } catch {
      return undefined
    }
  }
}

/**
 * 插件体：预热分库与嵌入器，注册 10 个工具、画像注入、自动摄取与衰减调度。
 * @param ctx - host 上下文。
 * @param config - cordis.yml 传入的可选配置；非法值在加载时 loud 失败。
 */
export function apply(ctx: Context, config: KyzmemConfig = {}): void {
  const resolved = resolveConfig(config)
  // Язык служебных сообщений — один на процесс. Помощник message() зовут десятки
  // функций, и протаскивать язык в каждую было бы куда грубее, чем задать его здесь
  // один раз при сборке плагина (см. src/i18n/messages.ts).
  setMessageLanguage(resolved.language)
  // Слова пользователя для вычистки секретов. Действуют поверх языковых наборов и
  // независимо от языка: пользователь добавляет их как раз потому, что пакета не хватило
  // (см. src/i18n/patterns.ts, настройка redactWords).
  setExtraRedactWords(resolved.redactWords)
  mkdirSync(resolved.dbDir, { recursive: true, mode: 0o700 })

  // 老插件（@kenz1117/dsh-engram → ~/.dsh/engram）的历史数据一次性导入：
  // 只拷不搬、不覆盖、成功写标记；任何失败都只告警，绝不阻断插件启动。
  const legacy = importLegacyData(resolved.dbDir)
  if (legacy !== undefined && (legacy.databases.length > 0 || legacy.models)) {
    console.log('[dsh-kyzmem] imported legacy data:', JSON.stringify({ databases: legacy.databases, skipped: legacy.skipped, models: legacy.models }))
  }

  // 项目标识：git origin 归一化哈希 → 完整 cwd 哈希；按配置检查旧库迁移。
  const identity = resolveProjectIdentity(process.cwd())
  const migration = migrateProjectDb(resolved.dbDir, identity, resolved.legacyMigration)
  const warning = migrationWarning(resolved.dbDir, identity, migration)
  if (warning !== undefined) console.warn(warning)

  // 检索排序 boost 参数：显式 resolve 自配置，注入两个分库。
  const rankBoost = {
    recencyWeight: resolved.rankRecencyWeight,
    proofWeight: resolved.rankProofWeight,
    decayAfterDays: resolved.decayAfterDays,
  }

  // 分库懒打开：按分库文件名缓存连接（user / shared / project-<hash>；项目库按标识命名，同仓库跨会话共享）。
  const stores = new Map<string, Promise<KyzmemStore>>()

  /** 打开（或复用）一个分库文件；首次打开时幂等补齐存量排桩。 */
  const openDb = (dbName: string): Promise<KyzmemStore> => {
    const existing = stores.get(dbName)
    if (existing !== undefined) return existing
    const path = join(resolved.dbDir, dbName)
    const created = openKyzmemStore(path, rankBoost, {
      autoSlot: resolved.autoSlot,
      reviewScheduling: resolved.reviewScheduling,
      // 写入期自动折算 expires_at：TTL 按 kind 配置在插件层解析，store 只认天数；
      // 复习重学窗口同理（纯函数 nextSchedule 需要调用方注入）。
      ttlDaysByKind: resolved.ttlDaysByKind,
      reviewRelearnDays: resolved.reviewRelearnDays,
    })
      // 存量排桩：首次打开时幂等补齐（slot_room 为空的 active 条目按 kind 分房、创建时间定序）。
      .then(async store => {
        const assigned = await store.backfillSlots(room => {
          console.warn(message('core.warnRoomFull', { room }))
        })
        if (assigned > 0) console.warn(message('core.warnSlotsBackfilled', { count: assigned, path }))
        return store
      })
    // 审计 F17：打开失败（SCHEMA_INCOMPATIBLE / 迁移中断 / 文件损坏）不缓存 rejection——
    // 否则盘上修复后进程内也永远拿不到重试机会。
    created.catch(() => { stores.delete(dbName) })
    stores.set(dbName, created)
    return created
  }

  const openStore = (scope: KyzmemScope): Promise<KyzmemStore> => openDb(
    scope === 'user' ? 'user.db' : scope === 'shared' ? 'shared.db' : identity.dbName,
  )

  /**
   * 关闭并清空全部分库缓存。两个用途：
   *  - 卸载/重启时释放连接（不关会在 Windows 上锁住 .db 文件，目录删不掉）；
   *  - 审计 F16：restore 备份后 rename 换掉了 .db 的 inode，缓存连接仍指向旧文件——
   *    继续写入会落进 .before-restore-* 且重启后静默丢失。restore 成功后必须调用，
   *    让下一次访问按恢复后的文件重新打开。
   */
  const closeStores = async (): Promise<void> => {
    await Promise.allSettled([...stores.values()].map(async pending => {
      try {
        await (await pending).close()
      } catch {
        // 关闭失败无补救动作（连接会随进程退出释放）。
      }
    }))
    stores.clear()
  }

  ctx.effect(() => () => closeStores(), 'dsh-kyzmem: close stores')

  /** cwd → 分库文件名（历史回填会对每个历史 cwd 解析一次，避免重复读 git 元数据）。 */
  const cwdDbNames = new Map<string, string>()
  /**
   * 按任意 cwd 的项目标识打开分库（历史回填专用）：历史会话写进它自己项目的库，
   * 而不是当前工作目录的库——否则跨项目内容会串库。
   * @param cwd - 历史会话 header 里记录的 cwd。
   * @returns 该 cwd 对应项目分库的连接。
   */
  /** cwd → 分库文件名（缓存，避免重复读 git 元数据与重复迁移检查）。 */
  const dbNameForCwd = (cwd: string): string => {
    const cached = cwdDbNames.get(cwd)
    if (cached !== undefined) return cached
    const projectIdentity = resolveProjectIdentity(cwd)
    // 会话 cwd 同样应用旧库迁移策略；结果与告警按 cwd 缓存。
    const migration = migrateProjectDb(resolved.dbDir, projectIdentity, resolved.legacyMigration)
    const warning = migrationWarning(resolved.dbDir, projectIdentity, migration)
    if (warning !== undefined) console.warn(warning)
    cwdDbNames.set(cwd, projectIdentity.dbName)
    return projectIdentity.dbName
  }

  const openStoreForProjectCwd = (cwd: string): Promise<KyzmemStore> => openDb(dbNameForCwd(cwd))

  /**
   * 工具调用期的项目分库解析：按会话 cwd 归属（缺省回退插件进程目录）。
   * 面板「项目」scope、工具读写与自动摄取的 project 落点因此同一口径。
   */
  const resolveProjectStore = (cwd: string | undefined): Promise<KyzmemStore> =>
    cwd === undefined ? openStore('project') : openStoreForProjectCwd(cwd)

  // 嵌入器可选：下载/加载失败不阻塞插件加载，检索降级纯关键词并在结果中标记。
  const embedder: Promise<KyzmemEmbedder | undefined> = createLocalEmbedder(resolved.modelCacheDir, resolved.hfEndpoint)
    .catch((error: unknown) => {
      console.warn(message('core.warnEmbedderUnavailable'), error)
      return undefined
    })
  void embedder

  // 辅助请求写 kyzmem 自己的操作日志（下游插件禁止向会话日志写未知事件类型）。
  // 只记归因要用的四个标量：整段 userText 曾把 op_log 撑到平均 15.1KB/条、峰值 142KB，
  // user.db 97% 的体积被 op_log 吃掉（实测 72.7MB/月）。
  const logIngestRequest = (data: IngestRequestEventData): void => {
    const detail = JSON.stringify({
      round: data.round,
      provider: data.route.provider,
      model: data.route.model,
      chars: data.userText.length,
    })
    void openStore('user').then(store => store.audit('ingest-request', 'AUX', detail)).catch(() => { /* 审计失败不影响摄取 */ })
  }

  // preStep 的可变状态：route 记录当前会话在用的路由，历史回填优先复用它。
  const preStepState: {
    pendingReplayed: boolean
    lastProfileAgent: string | null
    lastProfileHash: string | null
    lastProfileCompactions: number | null
    lastAssessReminder: string | null
    lastRecallBatch: string | null
    route: LlmRoute | undefined
  } = {
    pendingReplayed: false,
    lastProfileAgent: null,
    lastProfileHash: null,
    lastProfileCompactions: null,
    lastAssessReminder: null,
    lastRecallBatch: null,
    route: undefined,
  }

  // ---- 历史会话回填：把 dsh 持久化的历史会话逐轮摄取进宫殿（面板「历史回填」tab / kyzmem_ingest_history）----
  /** 会话持久化服务（可选；缺席时历史回填不可用）。 */
  const persistenceService = (): HistoryLogSource | undefined => {
    const persistence = ctx.get('sessionPersistence' as never) as PersistenceServiceView | undefined
    if (persistence === undefined) return undefined
    return {
      // header 现在嵌在快照里，取消参数也从位置参数改为 { signal }（无信号时不传该键）。
      list: async signal => (await persistence.list(signal === undefined ? undefined : { signal })).map(snapshot => snapshot.header),
      // 日志经只读句柄读取（打开 → 读完 → 必关闭）；读取失败原样抛出，调用方计 unreadable。
      load: id => withReadHandle(persistence, id, async handle => ({ events: (await handle.read()).events })),
    }
  }

  /** user 分库若已存在则打开（估算用：不因估算产生空库文件）。 */
  const openUserStoreIfExists = (): Promise<KyzmemStore | undefined> =>
    existsSync(join(resolved.dbDir, 'user.db')) ? openStore('user') : Promise.resolve(undefined)

  // ---- 项目宫殿清单：面板「项目」scope 随 GUI 工作区切换与显示（host 半数据源）----
  /** 宿主机工作区注册表（可选服务：缺席时降级为「会话 cwd + 进程目录」两级清单）。 */
  const workspaceRefs = (): WorkspaceRef[] => {
    const registry = ctx.get('workspaceRegistry' as never) as
      | { list(): readonly { id: unknown; path: unknown; title: unknown }[] }
      | undefined
    if (registry === undefined) return []
    try {
      return registry.list()
        .filter(workspace => typeof workspace.path === 'string' && workspace.path !== '')
        .map(workspace => ({
          id: String(workspace.id),
          path: workspace.path as string,
          title: typeof workspace.title === 'string' ? workspace.title : '',
        }))
    } catch {
      // 注册表不可用（未初始化/实现变更）：按无注册表降级，不影响面板其余功能。
      return []
    }
  }

  /** 只按会话 cwd 认领的分库上限（按会话新旧取最近的若干，避免历史 cwd 把清单撑爆）。 */
  const SESSION_CWD_PALACE_LIMIT = 30

  /**
   * 会话 header 里出现过的 cwd：历史回填建的库也能在面板里被认领。
   * 按会话创建时间倒序取最近的 N 个（新的在前，去重后截断）。
   */
  const sessionCwds = async (): Promise<string[]> => {
    const source = persistenceService()
    if (source === undefined) return []
    try {
      const headers = await source.list()
      const ordered = [...headers].sort((a, b) => b.createdAt - a.createdAt)
      const cwds: string[] = []
      const seen = new Set<string>()
      for (const header of ordered) {
        const cwd = header.cwd
        if (cwd === undefined || cwd === '' || seen.has(cwd)) continue
        seen.add(cwd)
        cwds.push(cwd)
        if (cwds.length >= SESSION_CWD_PALACE_LIMIT) break
      }
      return cwds
    } catch {
      return []
    }
  }

  /** 项目宫殿清单（现算、零状态）：注册表工作区 → 会话 cwd → 进程目录兜底，按分库名去重。 */
  const projectPalaces = async (): Promise<ProjectPalace[]> =>
    listProjectPalaces({ workspaces: workspaceRefs(), sessionCwds: await sessionCwds(), processCwd: process.cwd() })

  /** 面板视图：补 exists 与 active 计数（库文件不存在时不打开，避免为工作区建空库）。 */
  const palaceView = async (palace: ProjectPalace): Promise<ProjectPalaceView> => {
    const exists = existsSync(join(resolved.dbDir, palace.dbName))
    let memories: number | null = null
    if (exists) {
      try {
        memories = (await (await openDb(palace.dbName)).stats()).active
      } catch {
        memories = null
      }
    }
    return {
      dbName: palace.dbName,
      title: palace.title,
      path: palace.path ?? null,
      kind: palace.kind,
      source: palace.source,
      workspaceId: palace.workspaceId ?? null,
      exists,
      memories,
    }
  }

  const projectsDeps: RouteDeps['projects'] = {
    list: async () => Promise.all((await projectPalaces()).map(async palace => palaceView(palace))),
    open: async selector => {
      const palaces = await projectPalaces()
      const palace = selector === undefined
        ? findProjectPalace(palaces, {})
        : palaces.find(candidate => candidate.dbName === selector)
      if (palace === undefined) return undefined
      return { store: await openDb(palace.dbName), project: await palaceView(palace) }
    },
  }

  /** 组装历史回填依赖；source 每次现取，兼容持久化服务在插件之后挂载的组合。 */
  const buildHistoryDeps = (): HistoryBackfillDeps => ({
    source: persistenceService(),
    resolveStore: openStoreForProjectCwd,
    openUserStore: () => openStore('user'),
    resolveExistingUserStore: openUserStoreIfExists,
    embedder,
    // 回填必须走提炼管线：ingest=off 的部署也允许手工回填，按最省的 light 档提炼。
    mode: resolved.ingest === 'off' ? 'light' : resolved.ingest,
    // 优先用当前可用路由（配置覆盖 > 当前会话在用的模型）——历史日志里的旧 provider/model 可能已不可用。
    routeOverride: resolved.routeOverride ?? preStepState.route,
    // 辅助调用归属：sessionId 由调用点带上被回填会话的 id（OpenCode 系 provider 缺这个头会被 400 拒绝），
    // 审计另经 logRequest 落 op_log。
    call: callParams => streamText(ctx, callParams),
    logRequest: logIngestRequest,
  })

  /** 回填任务（进程内单例；面板轮询它的进度，工具同步等待自己的那一次运行）。 */
  let backfillJob:
    | { controller: AbortController; progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string }
    | undefined

  /** 历史回填对外接口：面板路由（异步 job）与工具（同步运行）共用。 */
  const historyApi = {
    /** 已注册的 provider 与模型清单（面板「辅助模型」下拉的数据源）。 */
    models: async (): Promise<{
      providers: { id: string; name: string; models: { id: string; name: string }[] }[]
      failures: string[]
    }> => {
      const llm = ctx.get('llm' as never) as
        | {
            listProviders(): readonly { id: string; name: string }[]
            listModels(provider: string): Promise<readonly { id: string; name: string }[]>
          }
        | undefined
      if (llm === undefined) return { providers: [], failures: [] }
      const failures: string[] = []
      const providers = await Promise.all(llm.listProviders().map(async (provider) => {
        try {
          const models = await llm.listModels(provider.id)
          return { id: provider.id, name: provider.name, models: models.map(model => ({ id: model.id, name: model.name })) }
        } catch (error) {
          // 单个 provider 列举失败（如远端不可达）不影响其余分组。
          failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
          return { id: provider.id, name: provider.name, models: [] }
        }
      }))
      return { providers, failures }
    },
    estimate: (rules: HistoryBackfillRules): Promise<HistoryEstimate> =>
      estimateHistoryBackfill(buildHistoryDeps(), resolved.historyBackfill, rules),
    run: (rules: HistoryBackfillRules, signal: AbortSignal): Promise<HistoryRunResult> =>
      runHistoryBackfill(buildHistoryDeps(), resolved.historyBackfill, rules, () => { /* 同步运行不对外播报进度 */ }, signal),
    /** 启动后台回填；已有任务在跑时拒绝（面板按钮据此禁用）。 */
    start: (rules: HistoryBackfillRules): { ok: boolean; reason?: string } => {
      if (backfillJob !== undefined && backfillJob.progress.state === 'running') {
        return { ok: false, reason: message('core.backfillBusy') }
      }
      const controller = new AbortController()
      const job: NonNullable<typeof backfillJob> = {
        controller,
        failures: [],
        progress: {
          state: 'running', sessionsTotal: 0, sessionsDone: 0, turnsPlanned: 0,
          turnsDone: 0, memoriesWritten: 0, turnsSkipped: 0, turnsFailed: 0, skipReasons: {},
        },
      }
      backfillJob = job
      void runHistoryBackfill(
        buildHistoryDeps(), resolved.historyBackfill, rules,
        progress => { job.progress = progress },
        controller.signal,
      )
        .then((result) => { job.progress = result; job.failures = result.failures })
        .catch((error: unknown) => {
          // 整批失败（如枚举会话出错）：置 failed 并保留已累计进度，不抛给宿主。
          console.warn(message('core.warnHistoryBackfillFailed'), error)
          job.progress = { ...job.progress, state: 'failed' }
          job.error = error instanceof Error ? error.message : String(error)
        })
      return { ok: true }
    },
    cancel: (): void => { backfillJob?.controller.abort() },
    /** 当前任务快照；从未跑过时返回 idle 占位。 */
    status: (): { progress: HistoryRunProgress; failures: HistoryRunResult['failures']; error?: string } => ({
      progress: backfillJob?.progress ?? {
        state: 'done', sessionsTotal: 0, sessionsDone: 0, turnsPlanned: 0,
        turnsDone: 0, memoriesWritten: 0, turnsSkipped: 0, turnsFailed: 0, skipReasons: {},
      },
      failures: backfillJob?.failures ?? [],
      ...(backfillJob?.error === undefined ? {} : { error: backfillJob.error }),
    }),
  }

  // 工具注册（历史回填的估算/执行由 historyApi 提供；project scope 按会话 cwd 归属解析）。
  for (const tool of createKyzmemTools({
    openStore,
    resolveProjectStore,
    embedder,
    call: callParams => streamText(ctx, callParams),
    routeOverride: resolved.routeOverride,
    queryRewrite: resolved.queryRewrite,
    exportDir: `${resolved.dbDir}/exports`,
    language: resolved.language,
    // 召回输出预算：配置面在插件层解析（单条上限 / 总字符预算），工具层只接收数值。
    recallPerItem: resolved.recallPerItem,
    recallTotal: resolved.recallTotal,
    historyBackfill: { estimate: historyApi.estimate, run: historyApi.run },
  })) {
    ctx.tools.register(tool)
  }

  // 管理面板（可选）：webServer 就绪后注册管理页与 /api/kyzmem/* 接口。
  // 注入子 fiber 在无 webServer 的组合（headless）下保持等待，不阻塞主装载，
  // 工具/画像注入/摄取/衰减等其余能力不受影响。
  ctx.inject(['webServer'], (webCtx) => {
    // 必须用注入回调的子 ctx：ctx.webServer 属性代理拓扑敏感，
    // 外层 ctx 未依赖 webServer 时属性不可用。
    registerKyzmemRoutes(webCtx, {
      openStore,
      closeStores,
      projects: projectsDeps,
      exportDir: `${resolved.dbDir}/exports`,
      mirrorDir: `${resolved.dbDir}/palaces`,
      dbDir: resolved.dbDir,
      pluginVersion: VERSION,
      language: resolved.language,
      embedder,
      history: {
        estimate: historyApi.estimate,
        start: historyApi.start,
        cancel: historyApi.cancel,
        status: historyApi.status,
        models: historyApi.models,
        defaults: resolved.historyBackfill,
      },
    })
  })

  if (resolved.injectProfile || resolved.ingest !== 'off') {
    ctx.on('agent/pre-step', (payload, next) => preStep(ctx, openStore, openStoreForProjectCwd, resolved, embedder, preStepState, logIngestRequest, payload, next), { prepend: true })
  }

  // 会话结束即释放该会话的证据批次（进程内注册表，避免长驻进程累积）。
  ctx.on('session/disposed', (session) => {
    evidenceBatches.clear(String(session.id))
  })

  if (resolved.ingest !== 'off') {
    // 末轮摄取闭环：disposed 是 fire-and-forget 观察器（宿主不等待），5 秒超时；
    // 失败/超时由 ingestFinalTurn 落 pending 键，下次会话首次 pre-step 重放补做。
    // 必须挂 .catch：宿主把未处理的 rejection 当致命错误（installFailLoud → process.exit），
    // 而 dispose 时会话事件源可能已 detach——任何逃逸异常都会变成整个 DSH 进程退出。
    ctx.on('session/disposed', (session) => {
      const mode = resolved.ingest
      if (mode === 'off') return
      // dispose 后事件源可能 detach：事件快照与 cwd 在同步段取一次，摄取与摘要共用。
      const events = session.snapshotEvents() as unknown as readonly SessionEventLike[]
      const sessionId = String(session.id)
      const cwd = sessionCwd(session)
      void ingestFinalTurn({
        events,
        sessionId,
        turn: 0,
        slice: 'last',
        openStore: () => openStore('user'),
        openAuditStore: () => openStore('user'),
        // 末轮补做同样按该会话的 cwd 落项目宫殿并逐条判 scope。
        ...ingestWriteRouting(cwd, openStoreForProjectCwd, openStore),
        embedder,
        mode,
        routeOverride: resolved.routeOverride,
        call: params => streamText(ctx, { ...params, sessionId: session.id }),
        logRequest: logIngestRequest,
        signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
      })
        // 末轮摄取完成后收尾生成整场会话的一句话摘要：摄取失败（null）通常意味着
        // LLM 不可达，摘要同样会失败，不再起调用。摘要用独立 5 秒预算，不吃摄取的超时额度。
        .then(outcome => {
          if (outcome === null) return undefined
          return ensureSessionSummary({
            events,
            sessionId,
            // 摘要落会话主库（与历史回填口径一致）：有 cwd 落该项目库，无 cwd 落 user 库。
            openStore: () => (cwd === undefined ? openStore('user') : openStoreForProjectCwd(cwd)),
            call: params => streamText(ctx, { ...params, sessionId: session.id }),
            logRequest: logIngestRequest,
            mode,
            routeOverride: resolved.routeOverride,
            signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
            round: lastTurnNumber(events),
          })
        })
        .catch((error: unknown) => {
          console.warn(message('core.warnDisposeFinalFailed'), error)
        })
    })
  }

  if (resolved.reflect !== 'off') {
    // 信念巩固：disposed 是 fire-and-forget 观察器。auto 后台巩固（user 库 + cwd 已建库的项目库）；
    // suggest 只登记 reflect-pending（出口是 kyzmem_reflect 工具）。与末轮摄取相互独立——
    // reflect 取材幂等（已成为信念证据的记忆排除），并发漏抓由下次会话结束或手动调用补。
    // 必须就地吞掉所有异常：宿主把未处理 rejection 当致命错误（见上一个 disposed 监听）。
    ctx.on('session/disposed', (session) => {
      // dispose 后事件源可能 detach：事件快照与 cwd 在同步段取一次。
      const events = session.snapshotEvents() as unknown as readonly SessionEventLike[]
      const sessionId = String(session.id)
      const cwd = sessionCwd(session)
      const route = resolved.routeOverride ?? routeFromEvents(events)
      const targets: { scope: KyzmemScope; open: () => Promise<KyzmemStore> }[] = [
        { scope: 'user', open: () => openStore('user') },
      ]
      // 项目宫殿仅处理库文件已存在的，避免为一次性 cwd 建空库（与衰减调度同纪律）。
      if (cwd !== undefined && existsSync(join(resolved.dbDir, dbNameForCwd(cwd)))) {
        targets.push({ scope: 'project', open: () => openStoreForProjectCwd(cwd) })
      }
      void (async () => {
        for (const target of targets) {
          try {
            const store = await target.open()
            if (resolved.reflect === 'suggest') {
              const detail = JSON.stringify({ scope: target.scope, sessionId })
              if (!await store.hasAudit('reflect-pending', detail)) {
                await store.audit('reflect-pending', 'AUX', detail)
              }
              continue
            }
            // auto：会话没有模型请求时取不到路由，跳过本次（下次会话补）。
            if (route === undefined) continue
            const outcome = await reflectObservations({
              store,
              embedder: await embedder,
              scope: target.scope,
              call: params => streamText(ctx, { ...params, sessionId: session.id }),
              logRequest: data => {
                void store.audit('reflect-request', 'AUX', JSON.stringify(data)).catch(() => { /* 审计失败不影响巩固 */ })
              },
              route,
              signal: AbortSignal.timeout(FINAL_INGEST_TIMEOUT_MS),
            })
            if (outcome.formed + outcome.refined + outcome.confirmed + outcome.refuted > 0) {
              console.log(message('core.logReflectDone', {
                scope: target.scope,
                formed: outcome.formed,
                refined: outcome.refined,
                confirmed: outcome.confirmed,
                refuted: outcome.refuted,
              }))
            }
          } catch (error) {
            console.warn(message('core.warnReflectFailed', { scope: target.scope }), error)
          }
        }
      })()
    })
  }

  // ---- 后台整理调度（替代原先两个 24 小时 setInterval）----
  // 为什么删定时器：长驻进程 + 多次装载/恢复会叠加多个定时器（同一任务被重复跑），
  // 而且固定节拍不看欠账（没东西可做也照跑）。改为「事件驱动 + 欠账判定 + 任务轮转」：
  // 每次 kick 先算欠账，只跑确实欠账的任务的一个小轮，并受「≥1 天频率下限」与
  // 「5 分钟单飞租约」约束；久未活跃时自动进入减载档（更小的条目预算）。
  const maintenanceOptions: KickMaintenanceOptions = {
    openStore,
    budget: {
      ms: resolved.maintenance.budgetMs,
      items: resolved.maintenance.budgetItems,
      llmCalls: resolved.maintenance.budgetLlmCalls,
    },
    idleDays: resolved.maintenance.idleDays,
    enabled: resolved.maintenance.enabled,
    olderThanDays: resolved.decayAfterDays,
    language: resolved.language,
    embedder,
    // 合并任务要覆盖「本机上所有宫殿」：user.db + 全部 project-*.db。
    // 只整理 user.db 会让项目宫殿的重复记忆永远不被合并（多库逐个整理由 consolidation 层负责）。
    consolidate: async (_store, maxItems, deadline) => {
      const report = await consolidateDatabases({
        dbDir: resolved.dbDir,
        open: dbName => openDb(dbName),
        embedder,
        options: {
          olderThanDays: resolved.decayAfterDays,
          importanceBelow: 0.3,
          maxRecords: maxItems,
          deadline,
        },
      })
      if (report.failures.length > 0) {
        console.warn(message('core.warnConsolidationFailed'), report.failures.join(', '))
      }
      if (report.databases > 0) {
        console.log(message('core.logConsolidationDone', {
          archived: report.archived,
          merged: report.merged,
          skipped: report.skipped,
          ms: report.tookMs,
        }))
      }
      return report.merged
    },
  }
  // 模块级配置：路由（health 面板 /api/kyzmem/maintenance/kick）与 pre-step 都是零参调用，
  // 依赖面在这里一次性注入；重复 apply（测试/热重载）时以最后一次为准。
  configureMaintenance(maintenanceOptions)
  // 触发点一：装载完成后的下一个 tick（不阻塞 apply 返回；kick 内部幂等且自吞异常）。
  setImmediate(() => { kickMaintenance() })
  // 触发点二：会话关闭——末轮摄取/反思之后的自然整理时机（同样幂等）。
  ctx.on('session/disposed', () => { kickMaintenance() })
}
