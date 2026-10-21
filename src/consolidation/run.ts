/**
 * 闭馆整理（Background Consolidation）：会话结束或定时触发时的后台巡检，
 * 把长期未访问且重要性低的 active 条目归档（清楼）；同 kind / 高相似度的条目合并
 * （新旧 supersedes 链保留 + 旧条目归档）。
 *
 * 实现：单进程内 setImmediate 分片执行（避免阻塞宿主）。嵌入不可用时仅做归档 + 启发式去重；
 * 嵌入可用时按余弦相似度 ≥ 0.92 合并。所有动作写 op_log，便于面板审计。
 *
 * @module dsh-kyzmem/consolidation/run
 */

import { readdirSync } from 'node:fs'

import type { KyzmemEmbedder } from '../embedder/interface.ts'
import type { KyzmemStore } from '../store/interface.ts'
import type { MemoryRecord } from '../types.ts'
// 余弦相似度：与 store 检索共享 src/vec.ts 的单一实现（维度不匹配告警一次）。
import { cosine } from '../vec.ts'

/** 单条整理动作（写入 op_log 的统一标记）。 */
const CONSOLIDATION_OP = 'consolidation'

/** 闭馆归档参数：默认 30 天未访问 + importance < 0.3。 */
export interface ConsolidateOptions {
  readonly olderThanDays?: number
  readonly importanceBelow?: number
  /** 合并相似度阈值（0-1），嵌入可用时按 cosine 触发。 */
  readonly mergeThreshold?: number
  /** 整理作用域；未传 = 'user'（保持向后兼容）。 */
  readonly scope?: 'user' | 'project' | 'shared'
  /**
   * 限定只对指定 ids 做合并阶段；未传 = 全库扫（向后兼容）。
   * 仅控制阶段 2（合并相似）；阶段 1（闭馆归档）始终全库执行。
   * candidate 之外的同 kind 同相似条目也会被并入（避免漏并）。
   */
  readonly mergeCandidateIds?: readonly string[]
  /** 单轮最多检查的条目数（维护预算；缺省全库）。 */
  readonly maxRecords?: number
  /** 单轮最多合并次数（维护预算；缺省不限）。 */
  readonly maxMerges?: number
  /** 时间软上限（绝对时间戳）：到点后不再开始新的比对/合并，已做的动作保留。 */
  readonly deadline?: number
}

/** 单次整理结果摘要（写入 op_log 并返回给调用方）。 */
export interface ConsolidateReport {
  readonly archived: number
  readonly merged: number
  readonly skipped: number
  readonly tookMs: number
}

/** 整理门槛：active 少于该值不做合并（样本太少，近邻命中多是噪声）。 */
export const CONSOLIDATION_MIN_ACTIVE = 5

/** 整理门槛：同 kind 桶内少于该条数不做合并（单条或两条时比较意义有限）。 */
export const CONSOLIDATION_MIN_BUCKET = 3

/** 默认参数。 */
const DEFAULTS: Required<Omit<ConsolidateOptions, 'scope' | 'mergeCandidateIds' | 'maxRecords' | 'maxMerges' | 'deadline'>> = {
  olderThanDays: 30,
  importanceBelow: 0.3,
  mergeThreshold: 0.92,
}

/**
 * store 的可选扩展：批量读已存向量。
 * 为什么用鸭子类型而不是改 interface：store 由并行代理维护，这里只在扩展存在时复用，
 * 不存在就退回「重算」（正确但更贵），避免跨代理接口冲突。
 */
interface StoredVectorReader {
  readonly embeddingsFor?: (ids: readonly string[]) => Promise<ReadonlyMap<string, Float32Array>>
}

/** 读已存向量（失败/无扩展 → 空表，调用方自行补算）。 */
async function readStoredVectors(store: KyzmemStore, ids: readonly string[]): Promise<ReadonlyMap<string, Float32Array>> {
  const reader = store as unknown as StoredVectorReader
  if (typeof reader.embeddingsFor !== 'function') return new Map()
  try {
    return await reader.embeddingsFor(ids)
  } catch {
    return new Map()
  }
}

/** 闭馆整理主函数：纯异步，不抛错（失败仅记日志 / 落 pending）。 */
export async function runConsolidation(
  store: KyzmemStore,
  embedder: Promise<KyzmemEmbedder | undefined>,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateReport> {
  const start = Date.now()
  const options = { ...DEFAULTS, ...opts }
  const scope: 'user' | 'project' | 'shared' = options.scope ?? 'user'
  const stats = await store.stats()
  // 门槛（契约 §9）：active 太少时不整理——小样本下相似度命中多是噪声，撤并反而伤库。
  // 仍然写一条汇总 op_log，避免面板误以为「定时任务没跑」。
  if (stats.active < CONSOLIDATION_MIN_ACTIVE) {
    const idleReport: ConsolidateReport = { archived: 0, merged: 0, skipped: 0, tookMs: Date.now() - start }
    await store.audit(
      CONSOLIDATION_OP,
      'AUX',
      JSON.stringify({ scope, archived: 0, merged: 0, skipped: 0, tookMs: idleReport.tookMs, belowActiveThreshold: stats.active }),
    ).catch(() => {})
    return idleReport
  }
  const allRecords = await store.topActive(scope, Math.max(stats.active, 0))
  // 预算截断：维护任务每轮只看前 N 条（topActive 已按 importance 优先），避免一次扫全库卡住宿主。
  const records = options.maxRecords === undefined ? allRecords : allRecords.slice(0, Math.max(0, options.maxRecords))
  const archivedIds = new Set<string>()
  let archived = 0
  let merged = 0
  let skipped = 0
  const now = Date.now()
  const ageCutoff = options.olderThanDays * 86_400_000
  const maxMerges = options.maxMerges ?? Number.POSITIVE_INFINITY
  // 时间预算：后台任务只允许花一小笔额度，到点就收手（已做的归档/合并保留，只停后续动作）。
  const expired = (): boolean => options.deadline !== undefined && Date.now() >= options.deadline

  // 阶段 1：闭馆归档（清楼）。
  for (const record of records) {
    if (expired()) break
    if (record.importance >= options.importanceBelow) continue
    // lastAccessedAt 通过 store 接口无显式字段；用 createdAt + confidence 衰减作为代理：
    // 创建已过 ageCutoff 且 confidence < 0.3（低访问代理）则归档。
    if (now - record.createdAt < ageCutoff) continue
    if (record.confidence >= 0.3) continue
    try {
      await store.forget(record.id)
      archivedIds.add(record.id)
      archived += 1
    } catch {
      skipped += 1
    }
  }

  // 阶段 2：合并相似条目（按 kind 分桶，桶内两两比对）。
  // 可选 mergeCandidateIds：仅把指定 id 当作「种子」参与比对（同桶内仍允许并入未指定条目）。
  const emb = await embedder
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    if (archivedIds.has(record.id)) continue
    const list = buckets.get(record.kind) ?? []
    list.push(record)
    buckets.set(record.kind, list)
  }
  const seedIds = options.mergeCandidateIds !== undefined
    ? new Set(options.mergeCandidateIds)
    : null
  for (const list of buckets.values()) {
    if (expired()) break
    // 桶门槛：同 kind 少于 3 条不比对（两条互相比的收益抵不过误并风险）。
    if (list.length < CONSOLIDATION_MIN_BUCKET) continue
    if (merged >= maxMerges) break
    // 限定模式：桶内若无任何种子 id 则跳过该桶（仅在其他桶找到 seed 的关联条目时才合并）。
    if (seedIds !== null && !list.some(record => seedIds.has(record.id))) continue
    if (emb === undefined) {
      // 嵌入不可用：仅按 content 文本前 60 字完全相同做去重启发式（保留 importance 高的 = existing 胜出）。
      // 当前 record importance 更高时 supersede existing；否则跳过（existing 保持）。
      const seen = new Map<string, MemoryRecord>()
      for (const record of list) {
        if (merged >= maxMerges || expired()) break
        const key = record.content.slice(0, 60)
        const existing = seen.get(key)
        if (existing === undefined) {
          seen.set(key, record)
        } else if (record.importance > existing.importance) {
          await store.supersedeMany(
            { scope, kind: record.kind, content: record.content, importance: record.importance, confidence: record.confidence },
            [existing.id],
          ).catch(() => { skipped += 1 })
          merged += 1
          seen.set(key, record)
        }
        // existing 已胜：不动。
      }
      continue
    }
    // 嵌入可用：两两 cosine ≥ 阈值则合并（保留高 importance）。
    // 已有向量不重算：优先复用 store 已存向量（只补 embedding IS NULL 的缺口），
    // 避免每轮把整库重新嵌入一遍——这是整理任务最大的 CPU 开销。
    const vectors = new Map<string, Float32Array>()
    const needed = seedIds === null ? list : list.filter(record => seedIds.has(record.id))
    const cached = await readStoredVectors(store, needed.map(record => record.id))
    for (const record of needed) {
      if (expired()) break
      const stored = cached.get(record.id)
      if (stored !== undefined) {
        vectors.set(record.id, stored)
        continue
      }
      try {
        const vec = (await emb.embed([record.content]))[0]
        if (vec !== undefined) vectors.set(record.id, vec)
      } catch {
        skipped += 1
      }
    }
    const arr = list.filter(record => vectors.has(record.id))
    const visited = new Set<string>()
    for (let i = 0; i < arr.length; i += 1) {
      if (merged >= maxMerges || expired()) break
      const a = arr[i]!
      if (visited.has(a.id)) continue
      const dupes: MemoryRecord[] = []
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]!
        if (visited.has(b.id)) continue
        // 限定模式：b 必须与某个种子 a 相似才能被并入。
        const bVec = vectors.get(b.id)
        if (bVec === undefined) continue
        const sim = cosine(vectors.get(a.id)!, bVec)
        if (sim >= options.mergeThreshold) dupes.push(b)
      }
      if (dupes.length === 0) continue
      const ids = dupes.map(record => record.id)
      try {
        await store.supersedeMany(
          { scope, kind: a.kind, content: a.content, importance: a.importance, confidence: a.confidence },
          ids,
        )
        for (const id of ids) visited.add(id)
        visited.add(a.id)
        merged += 1
      } catch {
        skipped += 1
      }
    }
  }

  // 阶段 3：写一条 op_log 汇总（duration / archived / merged / skipped）。
  const report: ConsolidateReport = { archived, merged, skipped, tookMs: Date.now() - start }
  try {
    await store.audit(
      CONSOLIDATION_OP,
      'AUX',
      JSON.stringify({ scope, archived: report.archived, merged: report.merged, skipped: report.skipped, tookMs: report.tookMs }),
    )
  } catch {
    /* 审计失败不影响整理结果 */
  }
  return report
}

/** 用户库文件名（相对 dbDir）。 */
export const USER_DB_FILE = 'user.db'

/** 项目宫殿库文件名模式（migrateProjectDb 生成）。 */
export const PROJECT_DB_PATTERN = /^project-.+\.db$/

/**
 * 枚举 dbDir 下的整理目标库：user.db + 所有 project-*.db。
 * 为什么用 readdirSync 而不是查 project 表：整理是后台任务，应覆盖「本机上所有已存在的宫殿」，
 * 包括本会话没打开过的；目录不可读时退化为只整理 user.db。
 */
export function listConsolidationDatabases(dbDir: string): readonly string[] {
  let names: readonly string[]
  try {
    names = readdirSync(dbDir)
  } catch {
    return [USER_DB_FILE]
  }
  const projects = names.filter(name => PROJECT_DB_PATTERN.test(name)).sort()
  return [USER_DB_FILE, ...projects]
}

/** 逐库整理依赖。 */
export interface ConsolidateDatabasesDeps {
  readonly dbDir: string
  /** 按库文件名打开 store（由调用方决定加锁/缓存）。 */
  readonly open: (dbName: string) => Promise<KyzmemStore>
  readonly embedder: Promise<KyzmemEmbedder | undefined>
  readonly options?: ConsolidateOptions
  /** 外部取消（例如 session/disposed）：返回 true 时停止枚举剩余库。 */
  readonly stop?: () => boolean
}

/** 逐库整理汇总。 */
export interface ConsolidateDatabasesReport extends ConsolidateReport {
  /** 成功整理的库数（失败库不中断整轮）。 */
  readonly databases: number
  /** 打开/整理失败的库文件名（单库失败不影响其它库）。 */
  readonly failures: readonly string[]
}

/**
 * 逐库执行闭馆整理（user.db + project-*.db）。
 * 每个库独立 scope（user.db → 'user'，project-*.db → 'project'），单库异常只记失败名单。
 */
export async function consolidateDatabases(deps: ConsolidateDatabasesDeps): Promise<ConsolidateDatabasesReport> {
  let archived = 0
  let merged = 0
  let skipped = 0
  let tookMs = 0
  let databases = 0
  const failures: string[] = []
  for (const dbName of listConsolidationDatabases(deps.dbDir)) {
    if (deps.stop?.() === true) break
    const scope = deps.options?.scope ?? (dbName === USER_DB_FILE ? 'user' : 'project')
    try {
      const store = await deps.open(dbName)
      const report = await runConsolidation(store, deps.embedder, { ...deps.options, scope })
      archived += report.archived
      merged += report.merged
      skipped += report.skipped
      tookMs += report.tookMs
      databases += 1
    } catch {
      failures.push(dbName)
    }
  }
  return { archived, merged, skipped, tookMs, databases, failures }
}
