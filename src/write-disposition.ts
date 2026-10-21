/**
 * 写入四态处置：kyzmem_save 与自动摄取共用的入库前判定（ACCEPT / MERGE / DROP / DEFER）。
 * 判定以嵌入余弦与 kind 的纯规则为基底，纯本地、毫秒级、不做任何网络请求。
 * 可选注入判断器（MemoryJudge）在 DEFER 模糊带做裁决、对矛盾候选做建边前确认；
 * 判断器不可用或判断失败时逐点静默降级回纯规则。
 *
 * 第四态 DROP 是补上的「看过了但决定不记」：低熵噪声（纯寒暄、逐字重复）不再落库，
 * 但必须留 op_log 痕迹，否则面板永远看不到「我拦了什么」。
 * 飞轮的负反馈环：复述并入强化既有条目；疑似矛盾落库建边待裁决（不静默丢弃）。
 * @module dsh-kyzmem/write-disposition
 */

import type { KyzmemKind, MemoryRecord, WriteInput } from './types.ts'
import type { KyzmemStore } from './store/interface.ts'
import { chitchatPatterns } from './i18n/patterns.ts'

/** 写入处置四态。 */
export type WriteDisposition = 'accept' | 'merge' | 'drop' | 'defer'

/** 并入阈值：余弦 ≥ 该值且同 kind 视为同一事实的复述（与闭馆整理 mergeThreshold 默认值对齐）。 */
export const MERGE_COSINE = 0.92
/** 待定阈值：余弦 ≥ 该值且不满足 MERGE（相似度不足或跨 kind）视为疑似矛盾/修正，落库但建 contradicts 边待裁决。 */
export const DEFER_COSINE = 0.88
/**
 * 近重复阈值：同 kind 且余弦 ≥ 该值 → 直接 drop。
 * 为什么在 MERGE 之上再设一档：0.92~0.98 是「同一事实的另一种说法」，并入还能保信息；
 * ≥0.98 基本是逐字改写（标点/顺序微调），并入只会把既有正文搅浑，不如留一条干净的。
 * 必须落 op_log，否则面板看不出「判过我拦下了什么」。
 */
export const NEAR_DUPLICATE_COSINE = 0.98

/** DROP 的原因（写进 op_log，面板可见）。 */
export type DropReason = 'chitchat' | 'exact-duplicate' | 'near-duplicate'

/** 处置判定结果。 */
export type WriteDecision =
  | { readonly disposition: 'accept' }
  | { readonly disposition: 'merge'; readonly into: MemoryRecord; readonly similarity: number }
  | { readonly disposition: 'defer'; readonly neighbor: MemoryRecord; readonly similarity: number }
  | { readonly disposition: 'drop'; readonly reason: DropReason }

/** 判断问题：对状态文本的一个是否判断。 */
export interface JudgeQuestion {
  /** 问题标识，判断器按此键回填概率。 */
  readonly id: string
  /** 问题的自然语言描述。 */
  readonly instructions: string
}

/** 判断结果：问题 id → 概率（0-1，数字即信念）。 */
export type JudgeAnswers = Readonly<Record<string, number>>

/**
 * 可选注入的记忆判断器（外部判断服务的适配层，默认不装配）。
 * 三阈值由装配方落地；ask 失败抛错，由调用方逐点降级回纯规则。
 */
export interface MemoryJudge {
  /** 模糊带裁决：概率高于该值判「同一条」→ merge。 */
  readonly deferMergeAbove: number
  /** 模糊带裁决：概率低于该值判「确属不同条」→ 放行 accept。 */
  readonly deferAcceptBelow: number
  /** 矛盾确认：概率达到该值才建 contradicts 边。 */
  readonly contradictMinProbability: number
  /** 对 state 并行提问。 */
  ask(state: string, questions: readonly JudgeQuestion[]): Promise<JudgeAnswers>
}

/** decideWrite 的可选注入项。 */
export interface DecideWriteOptions {
  /** 判断器；undefined = 纯规则判定。 */
  readonly judge?: MemoryJudge
  /** 新内容原文；DROP 规则与模糊带裁决都需要它。 */
  readonly content?: string
}

/** 归一化：折叠空白、去首尾，用于长度判定与逐字重复判定。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 模糊带的三路裁决。
 * @returns 高置信同 → merge；高置信异 → accept；低置信、答案缺失或判断器抛错 → undefined（保持 defer）。
 */
async function resolveBand(
  judge: MemoryJudge,
  neighbor: MemoryRecord,
  similarity: number,
  kind: KyzmemKind,
  content: string,
): Promise<WriteDecision | undefined> {
  try {
    const answers = await judge.ask(
      `Memory A:\n${neighbor.content}\n\nMemory B:\n${content}`,
      [{
        id: 'same_memory',
        instructions: `Are Memory A and Memory B the same fact, i.e. restatements of one identical statement (both are "${kind}" memories)? Answer true only for genuine restatements.`,
      }],
    )
    const p = answers['same_memory']
    if (p === undefined) return undefined
    if (p >= judge.deferMergeAbove) return { disposition: 'merge', into: neighbor, similarity }
    if (p <= judge.deferAcceptBelow) return { disposition: 'accept' }
    return undefined
  } catch {
    // 判断器不可用（网络/超时/解析失败）：静默降级回纯规则 defer，不中断写入链路。
    return undefined
  }
}

/**
 * 判定一条新内容的处置。
 * 规则顺序（先廉价后昂贵；MERGE 优先于近重复否定，见下）：
 * 1. 正文是纯寒暄 → DROP（chitchat）；
 * 2. 与最近邻逐字相同 → DROP（exact-duplicate）；
 * 3. 嵌入不可用 / 库内无向量条目 / 最近邻低于 DEFER_COSINE → ACCEPT；
 * 4. 最近邻同 kind 且 ≥ MERGE_COSINE → MERGE（强化既有条目，而不是再写一条）；
 * 5. 否则最近邻 ≥ NEAR_DUPLICATE_COSINE → DROP（near-duplicate，兜住跨 kind 的近重复）；
 * 6. 其余达到 DEFER_COSINE → 注入 judge 时裁决，否则 DEFER。
 * 为什么 MERGE 在前：0.98+ 的近重复若先判 drop，会把「同一事实的再次陈述」当成噪声丢掉，
 * 失去 access_count/confidence 的强化信号；drop 只该拦「换了个 kind 的同文近重复」。
 * @param store - 目标分库
 * @param kind - 新内容的记忆种类（MERGE 要求同 kind，跨 kind 高度相似按 drop/defer 处理）
 * @param embedding - 新内容的向量；undefined = 嵌入不可用，直接 accept
 * @param options - 可选 judge 注入与原文
 */
export async function decideWrite(
  store: KyzmemStore,
  kind: KyzmemKind,
  embedding: Float32Array | undefined,
  options: DecideWriteOptions = {},
): Promise<WriteDecision> {
  const { judge, content } = options
  const normalized = content === undefined ? undefined : normalize(content)
  if (normalized !== undefined && isPureChitchat(normalized)) {
    await auditDrop(store, 'chitchat', kind, normalized.length)
    return { disposition: 'drop', reason: 'chitchat' }
  }
  if (embedding === undefined) return { disposition: 'accept' }
  const nearest = await store.nearestNeighbor(embedding)
  if (nearest === undefined) return { disposition: 'accept' }
  if (normalized !== undefined && normalize(nearest.record.content) === normalized) {
    await auditDrop(store, 'exact-duplicate', kind, normalized.length)
    return { disposition: 'drop', reason: 'exact-duplicate' }
  }
  if (nearest.similarity < DEFER_COSINE) return { disposition: 'accept' }
  // MERGE 优先：同 kind 的高度相似就是「同一事实的再陈述」，应强化既有条目。
  if (nearest.similarity >= MERGE_COSINE && nearest.record.kind === kind) {
    return { disposition: 'merge', into: nearest.record, similarity: nearest.similarity }
  }
  // 第四态：跨 kind 的近乎同文（≥0.98）没有独立信息量，写入只会污染检索。
  if (nearest.similarity >= NEAR_DUPLICATE_COSINE) {
    await auditDrop(store, 'near-duplicate', kind, normalized?.length ?? content?.length ?? 0, nearest.similarity)
    return { disposition: 'drop', reason: 'near-duplicate' }
  }
  if (judge !== undefined && content !== undefined) {
    const verdict = await resolveBand(judge, nearest.record, nearest.similarity, kind, content)
    if (verdict !== undefined) return verdict
  }
  return { disposition: 'defer', neighbor: nearest.record, similarity: nearest.similarity }
}

/** 纯寒暄（"你好"/"继续"/"ok"）没有可复用信息：正则来自语言包，与摄取节流共用同一套。 */
function isPureChitchat(text: string): boolean {
  return chitchatPatterns().some(pattern => pattern.test(text))
}

/**
 * DROP 落 op_log：面板的「我拦了什么」数据源。审计失败不影响判定结果。
 * @param cosine - 近重复判定的余弦；其余原因不需要
 */
async function auditDrop(
  store: KyzmemStore,
  reason: DropReason,
  kind: KyzmemKind,
  chars: number,
  cosine?: number,
): Promise<void> {
  try {
    const detail = cosine === undefined
      ? { reason, kind, chars }
      : { reason, kind, chars, cosine: Number(cosine.toFixed(4)) }
    await store.audit('drop', 'AUX', JSON.stringify(detail))
  } catch {
    // 审计是旁路，失败不阻断写入链路。
  }
}

/** 一天毫秒数（写入期 TTL 计算与维护调度共用）。 */
export const DAY_MS = 86_400_000

/**
 * 按 kind 的 TTL 算出写入期过期时间。
 * 为什么返回 undefined 而不是 0：0 表示「永不写 expires_at」，写 0 会被检索层判成「已过期」。
 * ttlDays 非法（负/NaN）同样按不过期处理，宁缺毋滥。
 */
export function resolveWriteExpiresAt(
  kind: KyzmemKind,
  ttlDaysByKind: Readonly<Record<KyzmemKind, number>>,
  now: number,
): number | undefined {
  const days = ttlDaysByKind[kind]
  if (!Number.isFinite(days) || days <= 0) return undefined
  return now + Math.floor(days) * DAY_MS
}

/**
 * 补齐写入缺省值：expiresAt 按 kind 的 TTL 计算，sourceTier 缺省 agent-inferred。
 * 为什么集中在这里：save / 批量 / 摄取 / import 四条写入路径必须用同一套 TTL 语义，
 * 分散实现迟早出现「工具写入不过期、摄取写入会过期」的不一致。
 * 显式传了 expiresAt/sourceTier 的调用方优先（摄取强制 tool-output 即走显式覆盖）。
 */
export function applyWriteDefaults(
  input: WriteInput,
  ttlDaysByKind: Readonly<Record<KyzmemKind, number>>,
  now: number,
): WriteInput {
  const expiresAt = input.expiresAt ?? resolveWriteExpiresAt(input.kind, ttlDaysByKind, now)
  const sourceTier = input.sourceTier ?? 'agent-inferred'
  return {
    ...input,
    sourceTier,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * 矛盾确认：对候选逐个问「真矛盾吗」，只保留概率达标的候选。
 * @param judge - 判断器
 * @param incoming - 新写入内容原文
 * @param candidates - 矛盾候选（摄取链路的 defer 最近邻 / 工具链路的 findContradictions 结果）
 * @returns 达标候选数组；判断器抛错时返回 undefined，调用方按旧行为（全量建边）降级。
 */
export async function confirmContradictions(
  judge: MemoryJudge,
  incoming: string,
  candidates: readonly MemoryRecord[],
): Promise<readonly MemoryRecord[] | undefined> {
  try {
    const verdicts = await Promise.all(candidates.map(async candidate => {
      const answers = await judge.ask(
        `Memory A:\n${candidate.content}\n\nMemory B:\n${incoming}`,
        [{
          id: 'contradicts',
          instructions: 'Do Memory A and Memory B state facts that cannot both be true at the same time (a genuine contradiction)?',
        }],
      )
      const p = answers['contradicts']
      return p !== undefined && p >= judge.contradictMinProbability ? candidate : undefined
    }))
    return verdicts.filter(c => c !== undefined)
  } catch {
    // 按原契约整体降级（全量建边）。
    return undefined
  }
}

/**
 * MERGE 落地：强化既有条目（accessCount+1 / confidence+0.05）并记 write-merge 审计行。
 * 目标在并发窗口内被物理清除时，用新内容向量重算一次最近邻再试；仍失败返回 undefined——
 * 调用方降级为 accept（宁可多一条，不能丢一条）。
 */
export async function applyMerge(
  store: KyzmemStore,
  decision: WriteDecision & { readonly disposition: 'merge' },
  content: string,
  embedding?: Float32Array,
): Promise<MemoryRecord | undefined> {
  const note = JSON.stringify({ content: content.slice(0, 40), similarity: Number(decision.similarity.toFixed(4)) })
  const first = await tryReinforce(store, decision.into.id, note)
  if (first !== undefined) return first
  if (embedding === undefined) return undefined
  // 重算最近邻再试一次（首次的目标已不存在）。
  try {
    const nearest = await store.nearestNeighbor(embedding)
    if (nearest === undefined || nearest.record.id === decision.into.id) return undefined
    if (nearest.record.kind !== decision.into.kind) return undefined
    return await tryReinforce(store, nearest.record.id, note)
  } catch {
    return undefined
  }
}

/** 强化一次；目标不存在或库忙时返回 undefined（调用方降级 accept）。 */
async function tryReinforce(store: KyzmemStore, id: MemoryRecord['id'], note: string): Promise<MemoryRecord | undefined> {
  try {
    return await store.reinforce(id, note)
  } catch {
    return undefined
  }
}
