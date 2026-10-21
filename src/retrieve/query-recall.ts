/**
 * 会话首问 keyed 召回（方案 §4 采纳项 A：push 取代 pull）。
 *
 * 现状问题：画像按 importance 选条（`store.topActive`），和本次会话问什么无关；检索能力
 * 只挂在自己的工具上，模型自愿调用的比例很低（评审对象实测 9.1%）。于是「库里有」和
 * 「模型已经看到」之间隔着一层自觉性。
 *
 * 这里在会话第一次注入（pre-step step===1，或压缩后的重注入）时，用首问原文做一次
 * **轻检索**，把最相关的几条并进同一个 `<memory_context>` 包——不开新检索通道，也不改
 * 检索算法本身，只是把已有的检索在正确时机调一次。
 *
 * 取舍（为什么这么轻，以及为什么要守这些门）：
 *  - **只走 FTS 道**（queryVector 传 undefined）：首轮关键路径上只有 QUERY_RECALL_TIMEOUT_MS
 *    的预算，而嵌入器的冷启动（模型加载/下载）是秒级；方案 §4 已明确「无 embedder 时走 FTS
 *    通道即可」。向量道留给 kyzmem_search 的完整检索。
 *  - **检索词截到 QUERY_RECALL_MAX_QUERY_CHARS**：首问可能是一整段贴进来的日志或报错，
 *    2-gram 切词会变成几百个 OR 词元（SQLite 侧逐词元扫 FTS 索引，成本随长度线性涨），
 *    噪声词还会稀释分数。80 字覆盖「一句话问题」的绝大多数。
 *  - **不强化、不落原文**：检索走 `touch: false`（命中不涨 access_count/confidence——
 *    召回只是「展示候选」，不该改变记忆的存储强度；强化只给真正被注入的那些），
 *    `auditQuery: 'hash'`（op_log 只存 queryHash，首问里的 key/token 不进库），
 *    `auditMode: 'query-recall'`（与工具检索的 `mode:'search'` 区分，采用率统计只认后者）。
 *  - **信任/过期门与画像同口径**：`expiresAt ≤ now` 丢弃、`sourceTier ∉ injectTiers` 丢弃。
 *    网页/工具输出这类可伪造来源默认不进画像，首问召回也不能成为它的绕过后门。
 *  - **条数是上限、预算才是硬约束**：整块（标题 + 条目 + examine 提示 + batch 行）必须
 *    ≤ `queryRecallBudget`；装不下就少放几条，一条都装不下就整块放弃。
 *  - **超时/失败要静默且可归因**：检索超时不抛（返回 outcome=timeout），两库用
 *    Promise.allSettled——单库失败只丢那一库；所有分支都由调用方写 op_log 审计。
 *
 * @module dsh-kyzmem/retrieve/query-recall
 */

import type { QueryRecallMode } from '../config.ts'
import type { KyzmemLanguage } from '../i18n/language.ts'
import { messageIn } from '../i18n/messages.ts'
import { chitchatPatterns } from '../i18n/patterns.ts'
import type { KyzmemScope, MemoryRecord, SearchHit, SearchQuery } from '../types.ts'
import type { KyzmemStore } from '../store/interface.ts'
import { truncateItem } from './budget.ts'
import { evidenceRefOf } from './evidence.ts'

/** 整个召回（两库检索 + 渲染）的延迟预算：超过就放弃本次注入，绝不拖住首轮请求。 */
export const QUERY_RECALL_TIMEOUT_MS = 80

/** 项目分库打开的时间预算：打不开就只查 user 库（冷启动/迁移中的项目库不值得等）。 */
export const QUERY_RECALL_PROJECT_OPEN_MS = 30

/** 单条召回正文字符数上限（首问召回只要「一句话够不够想起它」，不要整段原文）。 */
export const QUERY_RECALL_ITEM_CHARS = 80

/** 每个分库取的候选条数：两库合并按分数排序后再截到 top。 */
export const QUERY_RECALL_CANDIDATES = 5

/** 首问的 CJK 字数下限（中文一个字顶西文约三个字符的信息量）。 */
export const QUERY_RECALL_MIN_CJK_CHARS = 6

/** 首问的其它语言字符数下限（按去空白后的非 CJK 字符数算）。 */
export const QUERY_RECALL_MIN_TEXT_CHARS = 20

/** 检索词最大字符数（见模块头：贴进来的长日志不能整段变成 FTS 表达式）。 */
export const QUERY_RECALL_MAX_QUERY_CHARS = 80

/** 渲染预算试算时的批次 id 占位：取「真实 id 不可能更长」的长度，真实替换后只会变短。 */
const BATCH_ID_PLACEHOLDER = 'batch-000000000'

/** 本段召回的分类结果（每个分支都要落一条 op_log，见调用方）。 */
export type QueryRecallOutcome = 'injected' | 'no-hit' | 'timeout' | 'budget-skip' | 'error'

/**
 * 是否该在本步做首问召回。
 * 同一 agent 每次会话只做一次（`recallAgent`）；压缩（compaction）会把注入的快照摘要掉，
 * 出现新的压缩事件时允许重做一次——与画像重注入同一判据。
 */
export interface QueryRecallGate {
  /** 当前 agent（= 会话）标识。 */
  readonly agentId: string
  /** 配置档位；off 直接不跑。 */
  readonly mode: QueryRecallMode
  /** 上次召回时的 agent id；null = 本会话还没跑过。 */
  readonly recallAgent: string | null
  /** 上次召回时观察到的压缩计数；null = 还没跑过。 */
  readonly recallCompactions: number | null
  /** 本步观察到的压缩计数。 */
  readonly compactionCount: number
}

/**
 * 判断本步是否该跑首问召回。
 * @param gate - 会话/配置状态。
 * @returns 该跑返回 true。
 */
export function shouldRunQueryRecall(gate: QueryRecallGate): boolean {
  if (gate.mode === 'off') return false
  if (gate.recallAgent !== gate.agentId) return true
  return gate.recallCompactions !== null && gate.compactionCount > gate.recallCompactions
}

/** 无用户文本时 `currentUserRequestText` 的占位句（三种语言都可能出现在运行语言下）。 */
export function isPlaceholderRequest(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  return (['zh', 'en', 'ru'] as const).some(language => messageIn(language, 'store.conversationContinues') === trimmed)
}

/** CJK 码点（汉字、假名、谚文）：中文一个字的信息量接近西文一个词，长度门槛要分开算。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
const CJK_CHAR_GLOBAL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu

/**
 * 首问文本是否值得检索：占位句、太短、整条寒暄都不查库。
 *
 * 为什么这里重写而不是复用 `write-disposition.ts` 的 `isPureChitchat`：那是写入链路的
 * 模块私有判断，把它导出会把写入内部实现变成公共 API；这里用**同一数据源**
 * （`chitchatPatterns`，语言包里的同一套正则）重新拼一次，语义等价。
 * 阈值分语言是因为「这个项目怎么构建？」只有 9 个字符却信息充分，而英文 9 个字符
 * （"hi there"）通常没有检索意图：CJK 按 6 字、其余按 20 字符。
 * @param text - 首问原文。
 * @param language - 语言包选择（决定哪些寒暄正则生效）。
 */
export function shouldQueryRecallText(text: string, language: KyzmemLanguage): boolean {
  const trimmed = text.trim()
  if (isPlaceholderRequest(trimmed)) return false
  if (chitchatPatterns(language).some(pattern => pattern.test(trimmed))) return false
  let cjk = 0
  for (const char of trimmed) if (CJK_CHAR.test(char)) cjk += 1
  if (cjk >= QUERY_RECALL_MIN_CJK_CHARS) return true
  const otherChars = trimmed.replace(CJK_CHAR_GLOBAL, '').replace(/\s+/gu, '').length
  return otherChars >= QUERY_RECALL_MIN_TEXT_CHARS
}

/** 检索所需的最小 store 视图（两库并行；测试可注入替身）。 */
export type QueryRecallStore = Pick<KyzmemStore, 'search'>

/** 召回依赖：按 scope 打开分库 + 证据批次登记。 */
export interface QueryRecallDeps {
  /** 打开一个分库（user / project）。 */
  readonly open: (scope: KyzmemScope) => Promise<QueryRecallStore>
  /** 把行里给出的 ref 登记成证据批次，返回 batchId（由调用方接 evidenceBatches）。 */
  readonly registerBatch: (refs: readonly string[]) => string
}

/** 一次首问召回的参数。 */
export interface QueryRecallOptions {
  /** 首问原文。 */
  readonly text: string
  /** 要查的分库（user 恒在；有 cwd 且项目库已存在时加 project）。 */
  readonly scopes: readonly KyzmemScope[]
  /** 最终条数上限（配置 `queryRecallTop`）。 */
  readonly top: number
  /** 整块字符预算（配置 `queryRecallBudget`）。 */
  readonly budget: number
  /** 渲染语言。 */
  readonly language: KyzmemLanguage
  /** 当前时刻（TTL 判定基准；测试可注入）。 */
  readonly now: number
  /** 参与注入的来源分级（与画像同一口径）。 */
  readonly injectTiers: readonly string[]
  /** 已在本次注入里的画像条目 id：同一段话不能在一个包里出现两次。 */
  readonly excludeIds?: ReadonlySet<string>
  /** 延迟预算（缺省 QUERY_RECALL_TIMEOUT_MS，测试可注入）。 */
  readonly timeoutMs?: number
}

/** 被选中的一条：ref 是行里显示的短码，record 供引用强化登记用。 */
export interface QueryRecallEntry {
  readonly ref: string
  readonly record: MemoryRecord
}

/** 一次召回的结果：outcome 之外的字段在非 injected 分支为空/零。 */
export interface QueryRecallRun {
  readonly outcome: QueryRecallOutcome
  /** 渲染好的小节（outcome=injected 时非空）。 */
  readonly block: string
  /** 最终注入条目的真实 id（供 markRetrieved 与审计）。 */
  readonly ids: readonly string[]
  /** 最终注入条目的证据 ref（已登记进批次）。 */
  readonly refs: readonly string[]
  /** 最终注入条目的 {ref, record}（交给 rememberCitationRefs）。 */
  readonly entries: readonly QueryRecallEntry[]
  /** 整块字符数。 */
  readonly chars: number
  /** 检索 + 渲染耗时（毫秒）。 */
  readonly tookMs: number
  /** 证据批次 id；injected 时必有。 */
  readonly batchId: string | undefined
}

/** 候选：命中 + 该命中在证据门里的 ref。 */
interface RecallItem {
  readonly hit: SearchHit
  readonly ref: string
}

/** 超时哨兵（区分「超时」与「结果恰好是 undefined」）。 */
const TIMED_OUT = Symbol('query-recall-timeout')

/**
 * 给一个异步任务套时间预算：超时返回 undefined。
 * 为什么这里要清定时器：留着会拖住事件循环（测试里表现为进程不退出）。
 * 注意：`node:sqlite` 是同步 API，定时器在同步 SQL 执行期间无法触发——这个预算是
 * **advice**，不是硬上限（真正的硬上限要把检索放进 worker，见风险报告 M1）。
 * @param work - 待等待的 Promise。
 * @param timeoutMs - 预算毫秒。
 * @returns 任务结果；超时返回 undefined。
 */
export async function withTimeBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raced = await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => { resolve(TIMED_OUT) }, timeoutMs)
      }),
    ])
    return raced === TIMED_OUT ? undefined : raced
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 非注入分支的结果骨架。 */
function emptyRun(outcome: QueryRecallOutcome, tookMs: number): QueryRecallRun {
  return { outcome, block: '', ids: [], refs: [], entries: [], chars: 0, tookMs, batchId: undefined }
}

/** 单行渲染（正文归一为单行：多行正文会打散「一行一条」的版式并让预算失真）。 */
function itemLine(item: RecallItem, language: KyzmemLanguage): string {
  return messageIn(language, 'core.recallItem', {
    kind: item.hit.record.kind,
    content: truncateItem(item.hit.record.content.replace(/\s+/gu, ' ').trim(), QUERY_RECALL_ITEM_CHARS),
    ref: item.ref,
  })
}

/** 整块渲染：标题 + 条目 + 用途说明 + 批次行。 */
function renderSection(items: readonly RecallItem[], batchId: string, options: QueryRecallOptions): string {
  return [
    messageIn(options.language, 'core.recallHeader'),
    ...items.map(item => itemLine(item, options.language)),
    messageIn(options.language, 'core.recallExamineHint', { ids: items.map(item => item.ref).join(', ') }),
    messageIn(options.language, 'core.recallBatchNote', { batchId }),
  ].join('\n')
}

/**
 * 跑一次首问召回：两库并行 FTS 检索 → 信任/过期门 → 按分数合并、按 id 去重（含画像条目）→
 * 取前 top 条 → 登记证据批次 → 按预算渲染成 `<memory_context>` 内的小节。
 * @param deps - 分库打开函数与批次登记函数。
 * @param options - 首问文本、分库、条数/预算上限、信任门参数。
 * @returns 分类结果（不抛错；检索失败/超时都折算成 outcome）。
 */
export async function runQueryRecall(
  deps: QueryRecallDeps,
  options: QueryRecallOptions,
): Promise<QueryRecallRun> {
  const started = performance.now()
  const query = options.text.trim().replace(/\s+/gu, ' ').slice(0, QUERY_RECALL_MAX_QUERY_CHARS)
  if (query === '') return emptyRun('no-hit', 0)
  const settled = await withTimeBudget(
    Promise.allSettled(options.scopes.map(async (scope) => {
      // touch/audit 三个参数是「展示而非强化」的契约：召回不写原文、不改变存储强度。
      const queryShape: SearchQuery = {
        text: query,
        limit: QUERY_RECALL_CANDIDATES,
        scopes: [scope],
        touch: false,
        auditMode: 'query-recall',
        auditQuery: 'hash',
      }
      return (await deps.open(scope)).search(queryShape, undefined)
    })),
    options.timeoutMs ?? QUERY_RECALL_TIMEOUT_MS,
  )
  if (settled === undefined) return emptyRun('timeout', Math.round(performance.now() - started))
  const results = settled.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
  // 两库全失败才算 error；一库失败只丢那一库（另一个库可能正在迁移/被独占）。
  if (results.length === 0) return emptyRun('error', Math.round(performance.now() - started))

  const injectTiers = new Set<string>(options.injectTiers)
  const excluded = options.excludeIds
  const seen = new Set<string>()
  const items: RecallItem[] = []
  // 两库分数是同口径的 RRF 融合分（每个分库内部独立排名），合并后按分数降序即可。
  for (const hit of results.flatMap(result => result.hits).sort((left, right) => right.score - left.score)) {
    const record = hit.record
    const id = String(record.id)
    if (seen.has(id) || excluded?.has(id) === true) continue
    // 信任/过期门：与画像同一口径。网页/工具输出这类可伪造来源默认不进画像，
    // 首问召回若不过这道门，就成了绕过 injectTiers 的注入后门。
    if (record.expiresAt !== undefined && record.expiresAt <= options.now) continue
    if (!injectTiers.has(record.sourceTier ?? 'agent-inferred')) continue
    seen.add(id)
    // ref 同时承担两个职责：行里给模型看的「id 短码」，以及 kyzmem_assess 可引用的 ref。
    // 因此显式传 slot=undefined（→ `scope/#前8位`）：examine 接受这个形状（F3），
    // 也省下尾部提示里 36 位 UUID 的预算。
    items.push({ hit, ref: evidenceRefOf(record.scope, id, undefined, options.language) })
    if (items.length >= Math.max(1, options.top)) break
  }
  if (items.length === 0) return emptyRun('no-hit', Math.round(performance.now() - started))

  // 预算试算：条数从多到少试（尾部两行还会随条数变长，不能先定条目再补提示）。
  // 用占位 batchId 试算，真实 id 只会更短，所以试算通过后真渲染一定仍装得下。
  let fit: readonly RecallItem[] | undefined
  for (let count = items.length; count >= 1; count -= 1) {
    const candidate = items.slice(0, count)
    if (renderSection(candidate, BATCH_ID_PLACEHOLDER, options).length <= options.budget) {
      fit = candidate
      break
    }
  }
  if (fit === undefined) return emptyRun('budget-skip', Math.round(performance.now() - started))

  // 登记批次放在「确认有内容能注入」之后：零注入分支不留悬空批次（否则下一步会收到
  // 「去 assess 一个你从没见过的 batch」的收尾提醒）。
  const refs = fit.map(item => item.ref)
  const batchId = deps.registerBatch(refs)
  const block = renderSection(fit, batchId, options)
  return {
    outcome: 'injected',
    block,
    ids: fit.map(item => String(item.hit.record.id)),
    refs,
    entries: fit.map(item => ({ ref: item.ref, record: item.hit.record })),
    chars: block.length,
    tookMs: Math.round(performance.now() - started),
    batchId,
  }
}
