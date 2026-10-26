/**
 * KyzmemStore 的 node:sqlite 实现：节点表 + 边表 + FTS5（unicode61 + 中文 2-gram 预切词）
 * + 操作日志，单调 SCHEMA_VERSION，打开时校验、不兼容拒绝加载（不写兼容 shim）。
 * 事务用手工 BEGIN/COMMIT——DatabaseSync.prototype.transaction 仅新引擎可用，
 * 本包声明兼容 node ^22.19。
 * @module dsh-kyzmem/store/sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { KyzmemError, EPISODE_PROXIMITY_MS_DEFAULT, EPISODE_TIMELINE_LIMIT_DEFAULT, asEntityId, asFactId, asMemoryId, asObservationId, normalizeEntityName } from '../types.ts'
import { assignSlot } from '../palace/slots.ts'
import { createBackup } from '../backup/tar.ts'
import { nextSchedule } from '../review/sm2.ts'
import { scorePlacard } from '../imagery/score.ts'
import { message } from '../i18n/messages.ts'
// 余弦相似度：store 检索与巩固聚类共享 src/vec.ts 的单一实现（维度不匹配告警一次）。
import { cosine } from '../vec.ts'
import type {
  AdoptionStat, DecayOptions, KyzmemEdgeType, KyzmemScope, EntityDetail, EntityId, EntityListFilter,
  EntityListResult, EntityMention, EntityRecord, ExportData, FactListFilter, FactListResult,
  FactRecord, FactWriteInput, ForgettingTombstone, ForgottenAuditRow, ImageryLabel,
  ImportEntryClass, ImportOptions, ImportPreview, ImportResult,
  ListFilter, ListResult, MemoryEdge, MemoryId, MemoryOutcome,
  MemoryRecord, ObservationId, ObservationListFilter, ObservationRecord, ObservationWriteInput,
  ProfileBlock, ProfileBlockVersion, ReviewGrade, ReviewView, SearchHit, SearchResult, SearchChannelStat,
  Slot, StoreStats, ConflictAction, ConflictListResult, ConflictPair, KyzmemSourceTier, OperationLogRow,
  TimelineQuery, UpdateInput, WriteInput, MemoryAnchor, SessionSummaryRecord,
  EpisodeTimelineQuery, EpisodeTimelineResult,
} from '../types.ts'
import type { KyzmemStore, RoomState, UndoAutoBatchResult } from './interface.ts'

/** 当前 schema 版本；结构性变更必须 +1。可空列与伴随表走增量迁移（见 openKyzmemStore 的迁移段）。
 *  v12→v13 是纯数据迁移（历史房名归一化），但同样借版本号作为「只跑一次」的开关。 */
const SCHEMA_VERSION = 16
/** 增量迁移表：key 为起始版本，value 为升到下一版本的 SQL（可多语句）。
 *  v2 → v3：nodes 补可空列 outcome（使用效果回报）。
 *  v3 → v4：新增 nodes_revisions 修订表（update 归档旧条目时的内容快照）。
 *  v4 → v5：nodes 补 imagery_json 列（意象铭牌：caption + sensoryTags + emotionalValence + provisional）。
 *  v5 → v6：桩位（slot_room/slot_index）、意象质量分（imagery_score）、SM-2 调度
 *   （next_review_at/ease_factor/interval_days/review_reps）+ 固定巡游路线表 tour_routes。
 *   全部可空或带默认值，存量条目零搬运；排桩由 backfillSlots 幂等补齐。
 *  v6 → v7：画像 curated block 两表（profile_blocks 当前态 + profile_block_versions
 *   追加式版本链）。scope 作主键，每 scope 至多一个 block；版本链只增不改，rollback 数据源。
 *  v7 → v8：episode 情景时间线两个专用索引（kind+created_at 日期范围扫描、
 *   source_session_id+created_at 会话过滤）。列自 v1 就存在，纯索引迁移，零数据搬运。
 *  v8 → v9：会话摘要表 session_summaries（摄取期 LLM 生成的一句话会话摘要，
 *   组头展示用；与 nodes 无外键，会话 id 仅作逻辑关联）。
 *  v9 → v10：实体层两表——entities 实体词典（name/kind/aliases）与 node_entities
 *   记忆↔实体关联。实体随来源记忆所在 scope 分库；两表均无外键，删除记忆不级联
 *   （关联残留由查询侧 join status 过滤，见 listEntities 的 orphan 统计）。
 *  v10 → v11：facts 事实表——摄取/工具期抽取的一句话事实，挂在实体上（entity_id
 *   引用同库 entities.id，无外键）。valid_at/invalid_at 时间窗 + replaced_by 软失效
 *   链：新事实可声明取代旧事实（旧事实置 invalid_at 并回指 replaced_by），历史链
 *   保留可审计；asOf 查询按时间窗过滤（见 factsOfEntity）。
 *  v11 → v12：observations 巩固信念表——辅助 LLM 从多条原始记忆巩固出的一句话信念，
 *   sources_json 证据 id 列表 + proof_count 证据数（去重并集持续累积），status 三态
 *   active/stale/refuted 支持新鲜度复核；embedding 支持近邻归并（同主题并入同一条而非
 *   重复新增）。与 nodes 无外键（源记忆可被归档/遗忘，证据链只保留 id 引用）。
 *  v12 → v13：历史房名归一化——0.8.12 及更早把**显示名**写进 slot_room（「事实厅」），
 *   语言中立 id 启用后同一逻辑房会裂成两间（容量 9 变 18、tour_routes 按 room 断开）。
 *   升级时一次性改写为 id，含扩建房（「事实厅-2」→「fact-2」）；已经是 id 的库零行改动，
 *   SQL 自身幂等。手动脚本 scripts/migrate-room-ids.mjs 保留为兜底。 */
const MIGRATIONS: Readonly<Record<string, string>> = {
  '2': 'ALTER TABLE nodes ADD COLUMN outcome TEXT',
  '3': `CREATE TABLE IF NOT EXISTS nodes_revisions (
    node_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
    importance REAL NOT NULL, superseded_at INTEGER NOT NULL);`,
  '4': 'ALTER TABLE nodes ADD COLUMN imagery_json TEXT',
  '5': `ALTER TABLE nodes ADD COLUMN slot_room TEXT;
    ALTER TABLE nodes ADD COLUMN slot_index INTEGER;
    ALTER TABLE nodes ADD COLUMN imagery_score REAL;
    ALTER TABLE nodes ADD COLUMN next_review_at INTEGER;
    ALTER TABLE nodes ADD COLUMN ease_factor REAL;
    ALTER TABLE nodes ADD COLUMN interval_days REAL;
    ALTER TABLE nodes ADD COLUMN review_reps INTEGER DEFAULT 0;
    CREATE TABLE IF NOT EXISTS tour_routes (
      position INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS nodes_slot ON nodes (slot_room, slot_index);
    CREATE INDEX IF NOT EXISTS nodes_review_due ON nodes (next_review_at);`,
  '6': `CREATE TABLE IF NOT EXISTS profile_blocks (
    scope TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_block_versions (
      scope TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
      source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, version));`,
  '7': `CREATE INDEX IF NOT EXISTS nodes_kind_created ON nodes (kind, created_at);
    CREATE INDEX IF NOT EXISTS nodes_session_created ON nodes (source_session_id, created_at);`,
  '8': `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  '9': `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS node_entities (
      node_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      PRIMARY KEY (node_id, entity_id));
    CREATE INDEX IF NOT EXISTS entities_name ON entities (name);
    CREATE INDEX IF NOT EXISTS node_entities_entity ON node_entities (entity_id);`,
  '10': `CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, content TEXT NOT NULL,
    valid_at INTEGER NOT NULL, invalid_at INTEGER, replaced_by TEXT,
    source_node_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS facts_entity ON facts (entity_id);`,
  '11': `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, belief TEXT NOT NULL, status TEXT NOT NULL,
    sources_json TEXT NOT NULL, proof_count INTEGER NOT NULL, embedding BLOB,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_validated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS observations_status ON observations (status, proof_count, updated_at);`,
  // 数据迁移而非结构迁移：只改已有行，列与索引早在 v6 就位。前缀替换即可——
  // 房名只会出现在 slot_room 开头，扩建后缀是「-<n>」，不会在串内二次命中。
  '12': `UPDATE nodes SET slot_room = replace(slot_room, '事实厅', 'fact') WHERE slot_room LIKE '事实厅%';
    UPDATE nodes SET slot_room = replace(slot_room, '偏好阁', 'preference') WHERE slot_room LIKE '偏好阁%';
    UPDATE nodes SET slot_room = replace(slot_room, '决策堂', 'decision') WHERE slot_room LIKE '决策堂%';
    UPDATE nodes SET slot_room = replace(slot_room, '往事廊', 'episode') WHERE slot_room LIKE '往事廊%';
    UPDATE nodes SET slot_room = replace(slot_room, '技法坊', 'skill') WHERE slot_room LIKE '技法坊%';`,
  // v13：op_log 此前一个索引都没有，而 hasAudit 是 "WHERE op = ? AND detail = ?" 全表扫
  // 且被 pending 重放 N+1 调用 → 启动随使用时长单调变慢。补两条：查重与按时间清理。
  '13': `CREATE INDEX IF NOT EXISTS op_log_op_detail ON op_log (op, detail);
    CREATE INDEX IF NOT EXISTS op_log_at ON op_log (at);`,
  // v14 → v15（批四「时点记忆 + 来源分级 + TTL」）：五列全部可空/带默认值，存量条目零搬运。
  // invalid_at：被 update/supersedeMany 取代时打点，检索默认只搜 invalid_at IS NULL；asOf 时点
  //   检索用 created_at <= asOf AND (invalid_at IS NULL OR invalid_at > asOf) 还原「当时」的库。
  // expires_at：TTL 过期时刻（缺省 NULL = 永不过期），命中时降权 0.5 不硬过滤。
  // source_tier：来源分级（缺省 agent-inferred——存量条目都是模型推断的，缺省即真实情况）。
  // last_retrieved_at / last_reviewed_at：把「被检索命中」与「被复习/回报」拆成两个时钟——
  //   旧实现两者共用 last_accessed_at，衰减判据因此无法区分「常被检索」与「刚复习过」。
  // 两条 UPDATE 回填存量：检索时钟回填 created_at，复习时钟回填 last_accessed_at（旧语义的值）。
  // 索引：invalid_at 是检索的默认过滤列、expires_at 是 TTL 扫描列，全表扫会成为新热点。
  '14': `ALTER TABLE nodes ADD COLUMN invalid_at INTEGER;
    ALTER TABLE nodes ADD COLUMN expires_at INTEGER;
    ALTER TABLE nodes ADD COLUMN source_tier TEXT NOT NULL DEFAULT 'agent-inferred';
    ALTER TABLE nodes ADD COLUMN last_retrieved_at INTEGER;
    ALTER TABLE nodes ADD COLUMN last_reviewed_at INTEGER;
    UPDATE nodes SET last_retrieved_at = created_at WHERE last_retrieved_at IS NULL;
    UPDATE nodes SET last_reviewed_at = last_accessed_at WHERE last_reviewed_at IS NULL;
    CREATE INDEX IF NOT EXISTS nodes_invalid ON nodes (invalid_at);
    CREATE INDEX IF NOT EXISTS nodes_expires ON nodes (expires_at);`,
  // v15 → v16（文件锚）：三列全可空，存量条目零搬运——没有锚点的条目渲染行为与 v15 完全一致。
  // anchor_path 存工作区相对路径（`/` 分隔；绝对路径与 `..` 逃逸在写入端就被拒），
  // anchor_hash 是 `sha256(mtimeMs + ':' + size)` 的前 16 位（不读文件内容），
  // anchor_checked_at 是最后一次计算/校验该指纹的时刻（渲染期复验只读不写，留给后续批量任务）。
  // 索引：渲染/复验按「有锚点的条目」扫描是新热点，所以按 anchor_path 建索引。
  '15': `ALTER TABLE nodes ADD COLUMN anchor_path TEXT;
    ALTER TABLE nodes ADD COLUMN anchor_hash TEXT;
    ALTER TABLE nodes ADD COLUMN anchor_checked_at INTEGER;
    CREATE INDEX IF NOT EXISTS nodes_anchor ON nodes (anchor_path);`,
}
/** RRF 融合常数：score = Σ 1/(K + rank)。 */
const RRF_K = 60
/** 向量道的语义门槛：低于该余弦的条目不参与排序。
 *  v15 起由 0.2 抬到 0.35——向量道不再对全池算余弦、只在 FTS 候选内重排，
 *  门槛太低时 embedding 的普遍基线相似度（中文短句常有 0.2-0.3）会把无关条目顶进候选。 */
const MIN_COSINE = 0.35
/** 矛盾候选门槛：近邻余弦达到该值即报告（由模型/用户裁决）。 */
const CONTRADICTION_COSINE = 0.88
/** FTS 道候选池上限（v15）：原先把每道候选都截到 64，而中文 2-gram 的 OR 匹配面很宽，
 *  64 条经常把真正相关的条目挤在门外；256 条的 bm25 排序开销可忽略（一次查询 + 至多 256 行）。 */
const MAX_CANDIDATES = 256
/** 向量道参与融合的候选上限：v15 起只在 FTS 候选内截断到该值（保留既有 RRF 名次语义）。 */
const RANK_POOL = 64
/** 一跳扩展引入的邻居上限。 */
const EXPANSION_LIMIT = 32
/** 命中强化：每次检索命中的置信度增量。 */
const CONFIDENCE_BUMP = 0.05
/** 只看不取用（markRetrieved）的置信度增量：比命中强化小一个量级，且不动 access_count——
 *  避免「被召回一次就免疫衰减」（评审 M6）。 */
const RETRIEVAL_CONFIDENCE_BUMP = 0.02
/** 效果回报降权：failure 回报的置信度扣减（success 复用 CONFIDENCE_BUMP）。 */
const OUTCOME_PENALTY = 0.1
/** 审计视图返回的操作日志条数上限。 */
const REVIEW_LOG_LIMIT = 20
/** op_log.detail 的字符上限：写入端曾把整段请求体塞进来（实测平均 15.1KB、峰值 142KB），
 * user.db 97% 体积被 op_log 吃掉（72.7MB/月）。超限一律截断。 */
const OP_LOG_DETAIL_MAX = 512
/** 已排期条目的复习保护期（天）：复习逾期超过该天数才允许被衰减归档。 */
const DECAY_REVIEW_GRACE_DAYS = 30
/** 复习重学窗口默认值（天）：逾期超过该天数后答对，按「遗忘重学」处理（reps 清零、间隔回 1 天）。 */
const DEFAULT_RELEARN_DAYS = 30

/** op_log.detail 的长度截断（写入端曾把整段请求体塞进来：实测平均 15.1KB、峰值 142KB）。
 *  统一在这里收口，任何新增的审计写入点都不会再把 op_log 撑大。 */
function capDetail(detail: string | null): string | null {
  if (detail === null || detail.length <= OP_LOG_DETAIL_MAX) return detail
  return `${detail.slice(0, OP_LOG_DETAIL_MAX)}…`
}

/** 节点表的行结构（snake_case 对应列名）。 */
interface NodeRow {
  id: string
  scope: string
  kind: string
  content: string
  importance: number
  confidence: number
  status: string
  created_at: number
  last_accessed_at: number
  access_count: number
  source_session_id: string | null
  source_round: number | null
  source_seq: number | null
  embedding: Uint8Array | null
  outcome: string | null
  imagery_json: string | null
  slot_room: string | null
  slot_index: number | null
  imagery_score: number | null
  next_review_at: number | null
  ease_factor: number | null
  interval_days: number | null
  review_reps: number | null
  invalid_at: number | null
  expires_at: number | null
  source_tier: string
  last_retrieved_at: number | null
  last_reviewed_at: number | null
  anchor_path: string | null
  anchor_hash: string | null
  anchor_checked_at: number | null
}

/** 把意象铭牌序列化为 JSON（缺省序列化为 null，落库）。 */
function imageryToJson(imagery: ImageryLabel | undefined): string | null {
  if (imagery === undefined) return null
  return JSON.stringify({
    caption: imagery.caption,
    sensoryTags: [...imagery.sensoryTags],
    emotionalValence: imagery.emotionalValence,
    provisional: imagery.provisional,
  })
}

/** 从 JSON 反序列化意象铭牌；空串或解析失败返回 undefined（视作未铭刻）。 */
function jsonToImagery(raw: string | null): ImageryLabel | undefined {
  if (raw === null || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as { caption?: unknown; sensoryTags?: unknown; emotionalValence?: unknown; provisional?: unknown }
    const caption = typeof parsed.caption === 'string' ? parsed.caption : null
    const sensory = Array.isArray(parsed.sensoryTags) ? parsed.sensoryTags.filter((s): s is string => typeof s === 'string') : []
    const emotionalValence = typeof parsed.emotionalValence === 'number' && Number.isFinite(parsed.emotionalValence)
      ? Math.min(1, Math.max(0, parsed.emotionalValence)) : 0
    const provisional = parsed.provisional === true
    return { caption, sensoryTags: sensory, emotionalValence, provisional }
  } catch {
    return undefined
  }
}

function rowToRecord(row: NodeRow): MemoryRecord {
  const imagery = jsonToImagery(row.imagery_json)
  const hasReviewState = row.next_review_at !== null || row.ease_factor !== null || row.interval_days !== null
  return {
    id: asMemoryId(row.id),
    scope: row.scope as KyzmemScope,
    kind: row.kind as MemoryRecord['kind'],
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status as MemoryRecord['status'],
    ...(row.outcome === 'success' || row.outcome === 'failure' ? { outcome: row.outcome } : {}),
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    sourceSessionId: row.source_session_id,
    sourceRound: row.source_round,
    sourceSeq: row.source_seq,
    ...(imagery === undefined ? {} : { imagery }),
    ...(row.slot_room === null || row.slot_index === null ? {} : { slot: { room: row.slot_room, index: row.slot_index } }),
    ...(row.imagery_score === null ? {} : { imageryScore: row.imagery_score }),
    ...(hasReviewState ? {
      review: {
        nextReviewAt: row.next_review_at,
        easeFactor: row.ease_factor ?? 2.5,
        intervalDays: row.interval_days ?? 0,
        reps: row.review_reps ?? 0,
      },
    } : {}),
    // v15 五列：可空列缺省不写对象键（exactOptionalPropertyTypes 下「有键但 undefined」
    // 与「无键」是两种类型）。source_tier 是 NOT NULL DEFAULT，迁移后恒有值，直接映射。
    ...(row.invalid_at === null ? {} : { invalidAt: row.invalid_at }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    sourceTier: row.source_tier as KyzmemSourceTier,
    ...(row.last_retrieved_at === null ? {} : { lastRetrievedAt: row.last_retrieved_at }),
    ...(row.last_reviewed_at === null ? {} : { lastReviewedAt: row.last_reviewed_at }),
    // v16 文件锚：三列同生同灭（写入端要么全写要么全不写），缺 path/hash 就不带对象键。
    ...(row.anchor_path === null || row.anchor_hash === null
      ? {}
      : { anchor: { path: row.anchor_path, hash: row.anchor_hash, checkedAt: row.anchor_checked_at ?? 0 } }),
  }
}

function blobToVec(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

/** 实体表的行结构（snake_case 对应列名）。 */
interface EntityRow {
  id: string
  name: string
  kind: string
  aliases_json: string
  created_at: number
  updated_at: number
}

function entityRowToRecord(row: EntityRow): EntityRecord {
  let aliases: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.aliases_json)
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === 'string')
  } catch {
    // aliases_json 由本模块写入（JSON.stringify 产物），损坏时按空别名处理即可继续检索。
  }
  return {
    id: asEntityId(row.id),
    name: row.name,
    kind: row.kind as EntityRecord['kind'],
    aliases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 事实表的行结构（snake_case 对应列名）。 */
interface FactRow {
  id: string
  entity_id: string
  content: string
  valid_at: number
  invalid_at: number | null
  replaced_by: string | null
  source_node_id: string | null
  created_at: number
  updated_at: number
}

function factRowToRecord(row: FactRow): FactRecord {
  return {
    id: asFactId(row.id),
    entityId: asEntityId(row.entity_id),
    content: row.content,
    validAt: row.valid_at,
    invalidAt: row.invalid_at,
    replacedBy: row.replaced_by === null ? null : asFactId(row.replaced_by),
    sourceNodeId: row.source_node_id === null ? null : asMemoryId(row.source_node_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function vecToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** observations 表行结构（snake_case 对应列名）。 */
interface ObservationRow {
  id: string
  scope: string
  belief: string
  status: string
  sources_json: string
  proof_count: number
  embedding: Uint8Array | null
  created_at: number
  updated_at: number
  last_validated_at: number
}

/** 行 → ObservationRecord；sources_json 由本插件自写，解析失败按空证据兜底（不炸读侧）。 */
function observationRowToRecord(row: ObservationRow): ObservationRecord {
  let sourceIds: MemoryId[] = []
  try {
    const parsed: unknown = JSON.parse(row.sources_json)
    if (Array.isArray(parsed)) sourceIds = parsed.filter((item): item is string => typeof item === 'string').map(asMemoryId)
  } catch {
    sourceIds = []
  }
  return {
    id: asObservationId(row.id),
    scope: row.scope as ObservationRecord['scope'],
    belief: row.belief,
    status: row.status as ObservationRecord['status'],
    sourceIds,
    proofCount: row.proof_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
  }
}

/**
 * 中文 2-gram + 西文词元切词：unicode61 把连续汉字当作单个 token，无法支撑短语检索，
 * 因此入库与查询前都把中文按两字窗口切开、西文按词保留，用空格分隔交给 FTS5。
 */
export function tokenizeForFts(text: string): string {
  const tokens: string[] = []
  for (const segment of text.split(/([a-zA-Z0-9_]+)/)) {
    if (segment === '') continue
    if (/^[a-zA-Z0-9_]+$/.test(segment)) {
      tokens.push(segment.toLowerCase())
      continue
    }
    const cjk = segment.replace(/\s+/gu, '')
    if (cjk.length === 1) {
      tokens.push(cjk)
    } else {
      for (let i = 0; i + 2 <= cjk.length; i++) tokens.push(cjk.slice(i, i + 2))
    }
  }
  return tokens.join(' ')
}

/** 把切词结果转成 FTS5 MATCH 表达式（每个词元双引号包裹，OR 连接）；无有效词元返回 undefined。 */
export function ftsMatchExpression(text: string): string | undefined {
  const tokens = tokenizeForFts(text).split(' ').filter(token => token !== '')
  if (tokens.length === 0) return undefined
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * 解析 recall 采纳审计（`recall-used` / `recall-ignored`）的 detail.ids。
 * detail 形如 `{batch, ids: [...]}`；坏行/缺字段返回 undefined——一条脏审计不该让
 * 整个 adoption 统计（以及依赖它的排序）失效。
 */
function parseAuditIds(detail: string | null): readonly string[] | undefined {
  if (detail === null || detail === '') return undefined
  try {
    const parsed: unknown = JSON.parse(detail)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const ids = (parsed as { ids?: unknown }).ids
    if (!Array.isArray(ids)) return undefined
    return ids.filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return undefined
  }
}

/** 检索排序乘性 boost 参数（RRF 融合分之上逐条乘因子；权重 0 即该因子恒 1）。 */
export interface RankBoostOptions {
  /** recency 因子权重：`1 + w * max(0, 1 - daysSince(createdAt) / decayAfterDays)`。 */
  readonly recencyWeight: number
  /** proof 因子权重：`1 + w * log2(1 + accessCount)`。 */
  readonly proofWeight: number
  /**
   * adoption 因子权重（E）：`1 + min(ADOPTION_BOOST_CAP, w * smoothed(used, ignored))`。
   * 缺省 0 = 不乘该因子——直接开库的脚本/测试保持旧排序语义；插件侧由
   * `rankAdoptionWeight` 配置注入（默认 0.05）。
   */
  readonly adoptionWeight?: number
  /** recency 因子的衰减窗口天数（与衰减调度共用同一配置值）。 */
  readonly decayAfterDays: number
}

/** adoption 因子的贡献上限（+10%）：反馈回路的安全阀——「越召回越被召回」必须封顶。 */
export const ADOPTION_BOOST_CAP = 0.1

/** adoption 统计扫描窗口：最近 N 条 recall-used/recall-ignored 审计。 */
export const ADOPTION_SCAN_LIMIT = 500

/** adoption 统计的缓存时长（ms）：检索热路径上每 60 秒最多扫一次 op_log。 */
export const ADOPTION_CACHE_MS = 60_000

/**
 * adoption 因子：`1 + min(ADOPTION_BOOST_CAP, weight * smoothed)`，`smoothed = (used + 1) / (used + ignored + 2)`。
 *
 * 为什么只认 used：`ignored` 只是平滑分母——它压低「被展示很多次却没人用」的条目继续拿加分的
 * 斜率，但**不产生负分**（不降权）。从未被采纳（used=0）的条目一律回 1：贝叶斯先验在 used=0 时
 * 给的是 0.5，若照乘等于给所有「没被展示过」的条目统一 +2.5%（权重 0.05 时），对排序是常量平移、
 * 对指标却是噪声——「只统计被引用」这条设计约束要求它严格为零。
 *
 * @param stat - 该条目的采纳计数；undefined = 没有采纳记录（回 1）。
 * @param weight - 配置权重；≤0 关闭。
 */
export function adoptionFactor(stat: AdoptionStat | undefined, weight: number): number {
  if (!(weight > 0) || stat === undefined || stat.used <= 0) return 1
  const smoothed = (stat.used + 1) / (stat.used + stat.ignored + 2)
  return 1 + Math.min(ADOPTION_BOOST_CAP, weight * smoothed)
}

/** 缺省不加 boost（测试与脚本直开库时保持旧排序行为）。 */
const NO_BOOST: RankBoostOptions = { recencyWeight: 0, proofWeight: 0, decayAfterDays: 30 }

/** 写入期自动化开关（产品决策在存储层落地，保证 save/批量/摄取/蒸馏四条写入路径行为一致）。 */
export interface StoreAutomation {
  /** 写入时自动排桩 + 登记巡游路线；缺省 true。 */
  readonly autoSlot: boolean
  /** 新记忆自动进入 SM-2 复习调度（初始 1 天后到期）；缺省 true。 */
  readonly reviewScheduling: boolean
  /** 复习重学窗口（天）：逾期超过该天数后答对，按「遗忘重学」处理（reps 清零、间隔回 1 天）。
   *  缺省 30（config.reviewRelearnDays 的默认值）。纯函数 nextSchedule 本身不认识配置，
   *  由 store 在调用时把该值传进去。 */
  readonly reviewRelearnDays?: number
  /** 按 kind 的 TTL（天，0 = 不过期）：WriteInput 未显式给 expiresAt 时由写入期自动折算。
   *  缺省不设置 = 不自动过期（保持旧库/脚本直开库的既有行为）。 */
  readonly ttlDaysByKind?: Readonly<Record<string, number>>
  /**
   * 迁移前自动备份（前置工作 4/方案 6D）：打开时发现版本落后，先对整个 dbDir 做一次
   * tar 备份再迁移。备份失败 loud 中断（关库抛错），绝不带着没备份的库往新 schema 走。
   * 缺省不备份（脚本直开库、单测保持旧行为）。
   */
  readonly backupBeforeMigrate?: { readonly dbDir: string; readonly pluginVersion: string }
}
/** 缺省全开（config 的默认值也在此处对齐）。 */
const DEFAULT_AUTOMATION: StoreAutomation = { autoSlot: true, reviewScheduling: true }

/**
 * 打开（必要时创建）一个 scope 分库。
 * @param path - SQLite 文件路径；目录不存在会自动创建（0o700）。
 * @param rankBoost - 排序 boost 参数；缺省不乘任何因子。
 * @param automation - 写入期自动化开关（自动排桩/初始排期）；缺省全开。
 * @returns 就绪的 KyzmemStore。
 * @throws KyzmemError(code=SCHEMA_INCOMPATIBLE) 当库的 schema 版本高于当前实现。
 */
export async function openKyzmemStore(path: string, rankBoost: RankBoostOptions = NO_BOOST, automation: StoreAutomation = DEFAULT_AUTOMATION): Promise<KyzmemStore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  // 审计 F15：全局 dbDir 被所有 DSH 进程共用，默认 rollback journal + 无 busy 等待时，
  // 并发写直接 SQLITE_BUSY（摄取/衰减/面板路由全可触发，24h 定时任务必然周期撞车）。
  // WAL 让读写不互斥；busy_timeout 给 5s 撞车缓冲；NORMAL 配 WAL 是官方推荐档。
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA synchronous = NORMAL;')
  /** 手工事务：BEGIN/COMMIT/ROLLBACK（兼容 ^22.19 引擎范围）。 */
  const withTransaction = (fn: () => void): void => {
    db.exec('BEGIN')
    try {
      fn()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL,
      source_session_id TEXT, source_round INTEGER, source_seq INTEGER, embedding BLOB, outcome TEXT,
      imagery_json TEXT,
      slot_room TEXT, slot_index INTEGER, imagery_score REAL,
      next_review_at INTEGER, ease_factor REAL, interval_days REAL,
      review_reps INTEGER DEFAULT 0,
      invalid_at INTEGER, expires_at INTEGER,
      source_tier TEXT NOT NULL DEFAULT 'agent-inferred',
      last_retrieved_at INTEGER, last_reviewed_at INTEGER,
      anchor_path TEXT, anchor_hash TEXT, anchor_checked_at INTEGER);
    CREATE TABLE IF NOT EXISTS edges (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type));
    CREATE TABLE IF NOT EXISTS op_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL,
      target_id TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS nodes_revisions (
      node_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
      importance REAL NOT NULL, superseded_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tour_routes (
      position INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_blocks (
      scope TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_block_versions (
      scope TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
      source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, version));
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS node_entities (
      node_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      PRIMARY KEY (node_id, entity_id));
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, content TEXT NOT NULL,
      valid_at INTEGER NOT NULL, invalid_at INTEGER, replaced_by TEXT,
      source_node_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, belief TEXT NOT NULL, status TEXT NOT NULL,
      sources_json TEXT NOT NULL, proof_count INTEGER NOT NULL, embedding BLOB,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_validated_at INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, content, tokenize='unicode61');
    CREATE INDEX IF NOT EXISTS nodes_scope_status ON nodes (scope, status);
    CREATE INDEX IF NOT EXISTS nodes_kind_created ON nodes (kind, created_at);
    CREATE INDEX IF NOT EXISTS nodes_session_created ON nodes (source_session_id, created_at);
    CREATE INDEX IF NOT EXISTS entities_name ON entities (name);
    CREATE INDEX IF NOT EXISTS node_entities_entity ON node_entities (entity_id);
    CREATE INDEX IF NOT EXISTS facts_entity ON facts (entity_id);
    CREATE INDEX IF NOT EXISTS observations_status ON observations (status, proof_count, updated_at);
    CREATE INDEX IF NOT EXISTS op_log_op_detail ON op_log (op, detail);
    CREATE INDEX IF NOT EXISTS op_log_at ON op_log (at);
  `)
  // v6/v15/v16 索引不在此处建：旧库此刻还没有 slot_room / next_review_at / invalid_at / anchor_path 等列
  // （迁移在后面才跑），对已存在的表建这些索引会抛 no such column。
  // 新建库走下方补建，旧库由 MIGRATIONS['5'] / MIGRATIONS['14'] / MIGRATIONS['15'] 建。
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined
  if (versionRow === undefined) {
    db.exec(`CREATE INDEX IF NOT EXISTS nodes_slot ON nodes (slot_room, slot_index);
      CREATE INDEX IF NOT EXISTS nodes_review_due ON nodes (next_review_at);
      CREATE INDEX IF NOT EXISTS nodes_invalid ON nodes (invalid_at);
      CREATE INDEX IF NOT EXISTS nodes_expires ON nodes (expires_at);
      CREATE INDEX IF NOT EXISTS nodes_anchor ON nodes (anchor_path);`)
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
  } else {
    // 顺序增量迁移：按 MIGRATIONS 逐版升到当前版本（保数据）；更高版本或断链（缺迁移）拒绝加载。
    let version = Number(versionRow.value)
    if (!Number.isInteger(version) || version > SCHEMA_VERSION) {
      db.close()
      throw new KyzmemError('SCHEMA_INCOMPATIBLE', message('store.schemaVersionTooNew', { found: versionRow.value, supported: SCHEMA_VERSION, path }))
    }
    if (version < SCHEMA_VERSION) {
      // 审计 F17：升版前做一次文件级快照（迁移有 bug 时可整文件回退）。
      // 尽力而为：失败只警告不阻断升级；固定名字覆盖上次快照，避免无限累积（审计 F23）。
      try {
        await copyFile(path, `${path}.pre-migration`)
      } catch (error) {
        console.warn(message('store.preMigrationSnapshotFailed', { path, msg: error instanceof Error ? error.message : String(error) }))
      }
      // 前置工作 4（方案 6D）：整库 tar 备份先行——备份写不出来就关库 loud 失败，
      // 迁移一步也不跑；恢复走既有的 restore-backup 路由。
      if (automation.backupBeforeMigrate !== undefined) {
        try {
          await createBackup(automation.backupBeforeMigrate.dbDir, automation.backupBeforeMigrate.pluginVersion)
        } catch (error) {
          db.close()
          throw new KyzmemError('BACKUP_FAILED', `dsh-kyzmem: pre-migration backup failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    while (version < SCHEMA_VERSION) {
      const migration = MIGRATIONS[String(version)]
      if (migration === undefined) {
        db.close()
        throw new KyzmemError('SCHEMA_INCOMPATIBLE', message('store.schemaMigrationMissing', { found: version, supported: SCHEMA_VERSION, path }))
      }
      withTransaction(() => {
        // ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；逐条 ALTER 在执行前探测列存在性
        // （schema_version 已 ≤ 当前版本，但用户手工降级 + 部分列已存在时仍需幂等）。
        const safe = migration
          .split(';')
          .map(stmt => stmt.trim())
          .filter(stmt => stmt !== '')
          .filter(stmt => {
            const match = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(stmt)
            if (match === null) return true
            const table = match[1]
            const column = match[2]
            const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
            return !cols.some(c => c.name === column)
          })
        for (const stmt of safe) db.exec(stmt)
        version += 1
        db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version))
      })
    }
  }

  const sqlGet = db.prepare('SELECT * FROM nodes WHERE id = ?')
  const sqlInsert = db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding, imagery_json,
     slot_room, slot_index, imagery_score, next_review_at, ease_factor, interval_days,
     expires_at, source_tier, last_retrieved_at, last_reviewed_at,
     anchor_path, anchor_hash, anchor_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const sqlFtsInsert = db.prepare('INSERT INTO nodes_fts (node_id, content) VALUES (?, ?)')
  // v15：状态流转不再伪装成「访问」。旧实现把 last_accessed_at 当万能时间戳，forget/restore/
  // archive 都刷新它，于是「久未访问」这个衰减判据被自己的维护动作写坏（永远新鲜）。
  const sqlSetStatus = db.prepare('UPDATE nodes SET status = ? WHERE id = ?')
  // 恢复 = 重新有效：除 status 外还要清掉 invalid_at——否则 restore 回来的条目仍被检索的
  // 默认过滤（invalid_at IS NULL）挡在门外，恢复动作形同虚设。时间戳一律不动。
  const sqlRestore = db.prepare("UPDATE nodes SET status = 'active', invalid_at = NULL WHERE id = ?")
  // 失效标记（update/supersedeMany 的内部原语）：取代式失效 = 置 archived 并打 invalid_at
  // （时点检索靠它还原「当时有效」的库）。COALESCE 保证只记第一次失效时刻——重复 update
  // 不会把历史失效点往后推。
  const sqlMarkInvalid = db.prepare(`UPDATE nodes SET status = 'archived',
    invalid_at = COALESCE(invalid_at, ?) WHERE id = ?`)
  const sqlSetOutcome = db.prepare(`UPDATE nodes
    SET outcome = ?,
        confidence = CASE WHEN ? = 'success' THEN min(1.0, confidence + ${CONFIDENCE_BUMP}) ELSE max(0.0, confidence - ${OUTCOME_PENALTY}) END
    WHERE id = ?`)
  // v15：检索命中只推进「检索时钟」——last_accessed_at 保留为旧语义字段（可选字段的缺省回退源），
  // 不再被检索写脏；proof 因子读 access_count，衰减判据读 last_reviewed_at。
  // 批量形态（json_each）：一次检索命中几十条也只发一条 UPDATE，避免 N 次 prepare/step。
  const sqlTouch = db.prepare(`UPDATE nodes SET access_count = access_count + 1, last_retrieved_at = ?,
    confidence = MIN(1, confidence + ${CONFIDENCE_BUMP}) WHERE id IN (SELECT value FROM json_each(?))`)
  // 只记「被看过」不记「被取用」：markRetrieved 只推进检索时钟 + 小幅提 confidence，
  // access_count 保持不动——否则一条召回即被算作「用过一次」，decay 的 access_count=0 判据
  // 会把它永久排除（评审 M6）。批量形态同 sqlTouch。
  const sqlMarkRetrieved = db.prepare(`UPDATE nodes SET last_retrieved_at = ?,
    confidence = MIN(1, confidence + ${RETRIEVAL_CONFIDENCE_BUMP}) WHERE id IN (SELECT value FROM json_each(?))`)
  // 文件锚取样（R5 stale 命中率）：只回 id + 三列锚字段，不读正文；状态过滤在 SQL 侧，
  // 避免把「没锚点」的绝大多数条目搬进内存。
  const sqlListAnchors = db.prepare(`SELECT id, anchor_path, anchor_hash, anchor_checked_at FROM nodes
    WHERE status = 'active' AND anchor_path IS NOT NULL ORDER BY created_at DESC LIMIT ?`)
  const sqlLog = db.prepare('INSERT INTO op_log (at, op, target_id, detail) VALUES (?, ?, ?, ?)')
  const sqlHasAudit = db.prepare('SELECT 1 AS x FROM op_log WHERE op = ? AND detail = ? LIMIT 1')
  const sqlListAudit = db.prepare('SELECT detail FROM op_log WHERE op = ? AND detail IS NOT NULL ORDER BY seq')
  const sqlClearAudit = db.prepare('DELETE FROM op_log WHERE op = ? AND detail = ?')
  // R1 采用率 / 维护调度用的聚合读：countAudit 供「近 7 天 drop 数」这类比例指标；
  // lastAuditAt 供「距上次维护多久」判断；recentAudit 供「上一轮 recall 批次」回读。
  const sqlCountAudit = db.prepare('SELECT COUNT(*) AS n FROM op_log WHERE op = ? AND at >= ?')
  const sqlAuditLastAt = db.prepare('SELECT MAX(at) AS at FROM op_log WHERE op = ?')
  const sqlAuditRecent = db.prepare('SELECT at, op, target_id, detail FROM op_log WHERE op = ? ORDER BY seq DESC LIMIT ?')
  const sqlAuditRecentByTarget = db.prepare('SELECT at, op, target_id, detail FROM op_log WHERE op = ? AND target_id = ? ORDER BY seq DESC LIMIT ?')
  // E adoption：只扫两类采纳审计（seq 倒序取最近 ADOPTION_SCAN_LIMIT 条），比走
  // recentOps 全量扫小两个数量级；op 前缀命中既有 op_log_op_detail 索引。
  const sqlAdoptionAudit = db.prepare(`SELECT op, detail FROM op_log
    WHERE op IN ('recall-used','recall-ignored') ORDER BY seq DESC LIMIT ?`)
  const sqlOpLogById = db.prepare('SELECT at, op, target_id, detail FROM op_log WHERE target_id = ? ORDER BY seq DESC LIMIT ?')
  const sqlGetManyByIds = db.prepare('SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(?))')
  const sqlNeighborsBounded = db.prepare(`SELECT * FROM nodes WHERE id IN (
    WITH RECURSIVE walk(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT CASE WHEN e.from_id = walk.id THEN e.to_id ELSE e.from_id END, walk.depth + 1
      FROM edges e JOIN walk ON (e.from_id = walk.id OR e.to_id = walk.id)
      WHERE walk.depth < ? AND e.type IN ('supports','refines','related','supersedes','contradicts')
    )
    SELECT id FROM walk WHERE depth > 0
  )`)
  const sqlRecentOps = db.prepare('SELECT at, op, target_id, detail FROM op_log ORDER BY seq DESC LIMIT ?')
  const sqlRevisionInsert = db.prepare('INSERT INTO nodes_revisions (node_id, content, kind, importance, superseded_at) VALUES (?, ?, ?, ?, ?)')
  const sqlRevisionsById = db.prepare('SELECT content, kind, importance, superseded_at FROM nodes_revisions WHERE node_id = ? ORDER BY superseded_at DESC')
  const sqlTopActive = db.prepare("SELECT * FROM nodes WHERE scope = ? AND status = 'active' ORDER BY importance DESC, confidence DESC LIMIT ?")
  const sqlEdgeUpsert = db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)')
  // 边表列名是 snake_case，MemoryEdge 是 camelCase：必须显式取别名，否则下方一跳扩展读到的
  // `edge.from` / `edge.to` 恒为 undefined，扩展永远不会发生（P0 级静默失效）。
  const sqlNeighbors = db.prepare(`SELECT from_id AS "from", to_id AS "to", type FROM edges
    WHERE from_id IN (SELECT value FROM json_each(?))
    AND type IN ('supports','refines','related','supersedes') LIMIT ?`)
  const sqlEdgesTouching = db.prepare('SELECT from_id, to_id, type FROM edges WHERE from_id = ? OR to_id = ?')
  // 冲突裁决（批二）：contradicts 边 + 两端记录。任一端 active/archived 都要能进待裁决列表——
  // 裁决前用户可能已手动归档了一端。scope 过滤要求两端都在查询 scope 集合内：跨 scope 冲突
  // （user ↔ project）不属于单库面板的默认视图。
  const sqlConflictEdges = db.prepare(`SELECT e.from_id, e.to_id, e.created_at FROM edges e
    JOIN nodes l ON l.id = e.from_id JOIN nodes r ON r.id = e.to_id
    WHERE e.type = 'contradicts'
      AND l.scope IN (SELECT value FROM json_each(?)) AND r.scope IN (SELECT value FROM json_each(?))
    ORDER BY e.created_at DESC LIMIT ?`)
  const sqlConflictCount = db.prepare(`SELECT COUNT(*) AS n FROM edges e
    JOIN nodes l ON l.id = e.from_id JOIN nodes r ON r.id = e.to_id
    WHERE e.type = 'contradicts'
      AND l.scope IN (SELECT value FROM json_each(?)) AND r.scope IN (SELECT value FROM json_each(?))`)
  const sqlDeleteConflictEdge = db.prepare(`DELETE FROM edges WHERE type = 'contradicts'
    AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`)
  // 批次撤销（undoAutoBatch）：按调用方指定的边类型双向删除。
  const sqlDeleteEdge = db.prepare(`DELETE FROM edges WHERE type = ?
    AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`)
  // 批次撤销（undoAutoBatch）：把 SM-2 四元组写回动作前快照。
  const sqlRestoreSchedule = db.prepare(`UPDATE nodes
    SET next_review_at = ?, ease_factor = ?, interval_days = ?, review_reps = ? WHERE id = ?`)
  // 命中详情里的 contradicts 提示（只进 cues 不计分）：只对最终 top-N 命中逐条查，
  // N ≤ limit（通常 8），比每次检索都做一次全边 join 划算。
  const sqlContradictsByNode = db.prepare(`SELECT from_id, to_id FROM edges
    WHERE type = 'contradicts' AND (from_id = ? OR to_id = ?)`)
  const sqlCountBy = db.prepare('SELECT status, COUNT(*) AS n FROM nodes GROUP BY status')
  const sqlCountKind = db.prepare('SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind')
  const sqlCountEdges = db.prepare('SELECT COUNT(*) AS n FROM edges')
  const sqlCountOpLog = db.prepare('SELECT COUNT(*) AS n FROM op_log')
  const sqlCountRedacted = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%[REDACTED:%'")
  // v15 指标（面板 12 指标表的直接数据源）：过期命中面、已失效存量、来源分级占比、
  // 待裁决冲突、今日到期量。全部走各自新索引，避免面板轮询把全表扫成热点。
  const sqlCountExpired = db.prepare(`SELECT COUNT(*) AS n FROM nodes
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`)
  const sqlCountInvalidated = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE invalid_at IS NOT NULL')
  const sqlCountByTier = db.prepare('SELECT source_tier AS tier, COUNT(*) AS n FROM nodes GROUP BY source_tier')
  const sqlCountConflicts = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'contradicts'")
  const sqlCountDue = db.prepare(`SELECT COUNT(*) AS n FROM nodes
    WHERE status = 'active' AND next_review_at IS NOT NULL AND next_review_at <= ?`)
  const sqlAllNodes = db.prepare('SELECT * FROM nodes ORDER BY created_at')
  const sqlAllEdges = db.prepare('SELECT * FROM edges')
  // 导入路径：全字段插入（不经 write 的写入期自动化——导入条目保留导出侧的桩位/复习调度/时间戳），
  // 内容全等查重（nodes 无内容哈希列，个人库量级逐条 LIMIT 1 查询够用），实体别名并集回写。
  const sqlImportInsert = db.prepare(`INSERT INTO nodes
    (id, scope, kind, content, importance, confidence, status, created_at, last_accessed_at, access_count,
     source_session_id, source_round, source_seq, embedding, outcome, imagery_json,
     slot_room, slot_index, imagery_score, next_review_at, ease_factor, interval_days, review_reps,
     invalid_at, expires_at, source_tier, last_retrieved_at, last_reviewed_at,
     anchor_path, anchor_hash, anchor_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const sqlImportContentMatch = db.prepare('SELECT id FROM nodes WHERE content = ? LIMIT 1')
  const sqlImportAttachEmbedding = db.prepare('UPDATE nodes SET embedding = ? WHERE id = ?')
  // 已有向量的批量读取（维护/整理复用）：只回 embedding 非空的条目，调用方对缺口再算。
  const sqlEmbeddingsFor = db.prepare(
    'SELECT id, embedding FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND embedding IS NOT NULL',
  )
  const sqlImportEntityAliases = db.prepare('UPDATE entities SET aliases_json = ?, updated_at = ? WHERE id = ?')
  // 衰减（v15 再修）：判据从 last_accessed_at 改 last_reviewed_at——前者在 v15 被拆成
  // 「检索时钟」（last_retrieved_at），继续读它会让「常被命中但从不复习」的条目永不衰减。
  // 缺省回退 last_accessed_at：老库或未走新写入路径的行仍有该值，COALESCE 保证判据可用。
  // 两层查询（先取候选、再 json_each 批量归档）是为了支持维护预算的 limit——单条
  // UPDATE ... LIMIT 需要 SQLite 编译开关，这种写法不依赖它且归档集合精确可控。
  const sqlDecayCandidates = db.prepare(`SELECT id FROM nodes
    WHERE status = 'active' AND access_count = 0
      AND COALESCE(last_reviewed_at, last_accessed_at) < ?
      AND (next_review_at IS NULL OR next_review_at < ?)
    LIMIT ?`)
  const sqlArchiveIds = db.prepare("UPDATE nodes SET status = 'archived' WHERE id IN (SELECT value FROM json_each(?))")
  // 复习答题：推进「复习时钟」（衰减的新判据），不碰检索时钟。
  const sqlScheduleReview = db.prepare(`UPDATE nodes
    SET next_review_at = ?, ease_factor = ?, interval_days = ?, review_reps = ?, last_reviewed_at = ?
    WHERE id = ?`)
  const sqlDueReviews = db.prepare(`SELECT * FROM nodes
    WHERE status = 'active' AND next_review_at IS NOT NULL AND next_review_at <= ?
    ORDER BY next_review_at ASC LIMIT ?`)
  const sqlSlotCounts = db.prepare(`SELECT slot_room AS room, MAX(slot_index) AS maxIndex, COUNT(*) AS n
    FROM nodes WHERE slot_room IS NOT NULL AND status != 'forgotten' GROUP BY slot_room`)
  const sqlSetSlot = db.prepare('UPDATE nodes SET slot_room = ?, slot_index = ? WHERE id = ?')
  const sqlUnslotted = db.prepare(`SELECT * FROM nodes WHERE slot_room IS NULL AND status = 'active'
    ORDER BY kind, created_at`)
  const sqlRouteAppend = db.prepare(`INSERT INTO tour_routes (position, node_id)
    VALUES ((SELECT COALESCE(MAX(position), -1) + 1 FROM tour_routes), ?)`)
  const sqlRouteList = db.prepare('SELECT position, node_id FROM tour_routes ORDER BY position')
  const sqlRouteHas = db.prepare('SELECT 1 AS x FROM tour_routes WHERE node_id = ? LIMIT 1')
  const sqlSlotNeighbors = db.prepare(`SELECT id FROM nodes
    WHERE slot_room = ? AND slot_index IN (?, ?) AND status = 'active' AND id != ?`)
  const sqlListPlacards = db.prepare(`SELECT slot_room AS room, json_extract(imagery_json, '$.caption') AS caption
    FROM nodes WHERE imagery_json IS NOT NULL AND status = 'active'`)
  const sqlPurgeNodes = db.prepare('DELETE FROM nodes')
  const sqlPurgeEdges = db.prepare('DELETE FROM edges')
  const sqlPurgeFts = db.prepare('DELETE FROM nodes_fts')
  const sqlPurgeLog = db.prepare('DELETE FROM op_log')
  const sqlPurgeRoutes = db.prepare('DELETE FROM tour_routes')
  const sqlPurgeProfileBlocks = db.prepare('DELETE FROM profile_blocks')
  const sqlPurgeProfileVersions = db.prepare('DELETE FROM profile_block_versions')
  const sqlPurgeSessionSummaries = db.prepare('DELETE FROM session_summaries')
  // 画像 curated block：当前态读写 + 版本链追加/查询。
  const sqlProfileBlockGet = db.prepare('SELECT scope, content, version, updated_at FROM profile_blocks WHERE scope = ?')
  const sqlProfileBlockUpsert = db.prepare(`INSERT INTO profile_blocks (scope, content, version, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at`)
  const sqlProfileVersionInsert = db.prepare('INSERT INTO profile_block_versions (scope, version, content, source, at) VALUES (?, ?, ?, ?, ?)')
  const sqlProfileVersionsList = db.prepare('SELECT scope, version, content, source, at FROM profile_block_versions WHERE scope = ? ORDER BY version DESC LIMIT ?')
  const sqlProfileVersionGet = db.prepare('SELECT scope, version, content, source, at FROM profile_block_versions WHERE scope = ? AND version = ?')
  // 会话摘要：upsert（每会话一条，重跑覆盖）+ 单查 + 按会话 id 批量查（episodeTimeline 组头）。
  const sqlSessionSummaryUpsert = db.prepare(`INSERT INTO session_summaries (session_id, summary, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`)
  const sqlSessionSummaryGet = db.prepare('SELECT session_id, summary FROM session_summaries WHERE session_id = ?')
  const sqlSessionSummaryMany = db.prepare('SELECT session_id, summary FROM session_summaries WHERE session_id IN (SELECT value FROM json_each(?))')
  // 最近一条摘要：`[RESUME]` 恢复简报的开场素材（`rowid` 做同毫秒写入的定序兜底）。
  const sqlSessionSummaryLatest = db.prepare(
    'SELECT session_id, summary, updated_at FROM session_summaries ORDER BY updated_at DESC, rowid DESC LIMIT 1',
  )
  const sqlEntityAll = db.prepare('SELECT * FROM entities')
  const sqlEntityGet = db.prepare('SELECT * FROM entities WHERE id = ?')
  const sqlEntityInsert = db.prepare('INSERT INTO entities (id, name, kind, aliases_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const sqlEntityTouch = db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?')
  const sqlNodeEntityInsert = db.prepare('INSERT OR IGNORE INTO node_entities (node_id, entity_id) VALUES (?, ?)')
  const sqlEntityByNode = db.prepare(`SELECT e.* FROM node_entities ne JOIN entities e ON e.id = ne.entity_id
    WHERE ne.node_id = ? ORDER BY e.name`)
  const sqlEntityMemoryCounts = db.prepare(`SELECT ne.entity_id AS id, COUNT(*) AS n FROM node_entities ne
    JOIN nodes n ON n.id = ne.node_id WHERE n.status = 'active' GROUP BY ne.entity_id`)
  const sqlEntityMemories = db.prepare(`SELECT n.* FROM node_entities ne JOIN nodes n ON n.id = ne.node_id
    WHERE ne.entity_id = ? AND n.status = 'active' ORDER BY n.created_at DESC LIMIT ?`)
  const sqlPurgeEntities = db.prepare('DELETE FROM entities')
  const sqlPurgeNodeEntities = db.prepare('DELETE FROM node_entities')
  const sqlFactInsert = db.prepare(`INSERT INTO facts
    (id, entity_id, content, valid_at, invalid_at, replaced_by, source_node_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
  const sqlFactInvalidate = db.prepare('UPDATE facts SET invalid_at = ?, replaced_by = ?, updated_at = ? WHERE id = ?')
  const sqlFactGet = db.prepare('SELECT * FROM facts WHERE id = ?')
  const sqlPurgeFacts = db.prepare('DELETE FROM facts')
  // 巩固信念（schema v12）：embedding 为可空 BLOB，更新时按需替换。
  const sqlObservationInsert = db.prepare(`INSERT INTO observations
    (id, scope, belief, status, sources_json, proof_count, embedding, created_at, updated_at, last_validated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
  const sqlObservationGet = db.prepare('SELECT * FROM observations WHERE id = ?')
  const sqlObservationUpdate = db.prepare(`UPDATE observations
    SET belief = ?, status = ?, sources_json = ?, proof_count = ?,
      embedding = COALESCE(?, embedding), updated_at = ?, last_validated_at = ? WHERE id = ?`)
  const sqlObservationSetStatus = db.prepare('UPDATE observations SET status = ?, updated_at = ?, last_validated_at = ? WHERE id = ?')
  const sqlObservationMarkStale = db.prepare('UPDATE observations SET status = \'stale\' WHERE id = ?')
  const sqlObservationRefute = db.prepare('UPDATE observations SET status = \'refuted\', updated_at = ? WHERE id = ?')
  const sqlObservationActiveVectors = db.prepare('SELECT * FROM observations WHERE status != \'refuted\' AND embedding IS NOT NULL')
  const sqlPurgeObservations = db.prepare('DELETE FROM observations')
  // 批零遗留 bug：purge 漏了修订表——purge 后 nodes_revisions 里仍留着被取代条目的正文，
  // 「清空」之后还能从修订历史读出内容。补齐。
  const sqlPurgeRevisions = db.prepare('DELETE FROM nodes_revisions')
  // 单条硬删（purgeOne）：nodes / fts / 修订 / 全部边 / 实体关联 / 巡游路线 一次清干净。
  // 与 forget 的区别：不留 tombstone 行（forget 是软删可恢复），只在 op_log 留审计记录。
  const sqlPurgeOneNode = db.prepare('DELETE FROM nodes WHERE id = ?')
  const sqlPurgeOneFts = db.prepare('DELETE FROM nodes_fts WHERE node_id = ?')
  const sqlPurgeOneRevisions = db.prepare('DELETE FROM nodes_revisions WHERE node_id = ?')
  const sqlPurgeOneEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?')
  const sqlPurgeOneNodeEntities = db.prepare('DELETE FROM node_entities WHERE node_id = ?')
  const sqlPurgeOneRoute = db.prepare('DELETE FROM tour_routes WHERE node_id = ?')
  // 引用强化（kyzmem_assess 的 sufficient 证据）：只提 confidence，不动访问计数与时间戳——
  // 「被当作证据引用」与「被检索命中」是两种信号，混用会把 proof 因子与衰减判据一起弄脏。
  const sqlReinforceCitation = db.prepare('UPDATE nodes SET confidence = MIN(1, confidence + ?) WHERE id = ?')

  /** 时点/失效过滤（v15）：默认只认「当前有效」的行；asOf 给定时还原该时刻的库快照。
   *  注意 asOf 下不能再用 `status = 'active'` 做过滤：status 是「现在」的状态，被 update/
   *  supersede 归档的条目在 asOf 时刻恰恰是有效的；判断那时是否有效只能靠 created_at/invalid_at。
   *  forgotten 例外——闭馆是用户的删除意图（且不打 invalid_at），时点视图也不该把它翻出来。
   *  prefix 是列前缀（'n.' 或 ''）。 */
  const validityCond = (asOf: number | undefined, prefix: string): { cond: string; params: number[] } => {
    if (asOf === undefined) return { cond: ` AND ${prefix}status = 'active' AND ${prefix}invalid_at IS NULL`, params: [] }
    return {
      cond: ` AND ${prefix}status != 'forgotten' AND ${prefix}created_at <= ? AND (${prefix}invalid_at IS NULL OR ${prefix}invalid_at > ?)`,
      params: [asOf, asOf],
    }
  }

  /** FTS 道：按 scope 集合检索（占位符动态生成，scope 集合由调用方去重）；rooms 非空时只查指定房间。
   *  v15：候选上限抬到 MAX_CANDIDATES（bm25 排序保留），并把 validity（默认 invalid_at IS NULL）下沉到 SQL——
   *  在候选截断之前过滤，才不会出现「前 256 条全是已失效条目」导致真正有效的条目进不了向量道。 */
  const ftsSearch = (match: string, scopes: readonly KyzmemScope[], rooms: readonly string[] | undefined, asOf: number | undefined): NodeRow[] => {
    const placeholders = scopes.map(() => '?').join(',')
    const roomCond = rooms === undefined || rooms.length === 0
      ? ''
      : ` AND n.slot_room IN (${rooms.map(() => '?').join(',')})`
    const validity = validityCond(asOf, 'n.')
    return db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.node_id
      WHERE nodes_fts MATCH ? AND n.scope IN (${placeholders})${roomCond}${validity.cond}
      ORDER BY bm25(nodes_fts) LIMIT ${MAX_CANDIDATES}`).all(match, ...scopes, ...(rooms ?? []), ...validity.params) as unknown as NodeRow[]
  }

  /** 向量候选池：active 且带向量的条目，按 scope 集合过滤（占位符动态生成）；rooms 非空时只查指定房间。
   *  v15 起只在 FTS 零命中时作为回退（否则向量道只在 FTS 候选内重排，见 search）。 */
  const vectorPool = (scopes: readonly KyzmemScope[], rooms: readonly string[] | undefined, asOf: number | undefined): NodeRow[] => {
    const placeholders = scopes.map(() => '?').join(',')
    const roomCond = rooms === undefined || rooms.length === 0
      ? ''
      : ` AND slot_room IN (${rooms.map(() => '?').join(',')})`
    const validity = validityCond(asOf, '')
    return db.prepare(`SELECT * FROM nodes WHERE embedding IS NOT NULL AND scope IN (${placeholders})${roomCond}${validity.cond}`)
      .all(...scopes, ...(rooms ?? []), ...validity.params) as unknown as NodeRow[]
  }

  const getRow = (id: string): NodeRow | undefined => sqlGet.get(id) as unknown as NodeRow | undefined

  /**
   * 写入公共体：插入节点 + FTS + 操作日志（不建边、不开事务）。
   * 事务由调用方持有（withTransaction）。
   */
  const insertRecord = (
    id: MemoryId, input: WriteInput, content: string,
    importance: number, confidence: number, at: number,
    sourceSessionId: string | null, embedding: Float32Array | Uint8Array | null,
    imagery: ImageryLabel | undefined, op: string,
  ): void => {
    // Float32Array 不是合法 BLOB 参数，落库前转字节视图；Uint8Array 直传。
    const stored = embedding === null
      ? null
      : embedding instanceof Float32Array ? vecToBlob(embedding) : embedding
    // 初始排期：进入复习调度的条目 ease 从 SM-2 默认 2.5、间隔 0（等首次答题推进）起。
    const initialReview = input.initialReviewAt ?? null
    // TTL（v15）：显式 expiresAt 优先；否则按 kind 的天数折算（0 天 = 不过期，列留 NULL）。
    // 折算放在插入公共体里，保证 save/批量/摄取/蒸馏四条写入路径口径一致（调用方不必各自算）。
    const ttlDays = automation.ttlDaysByKind?.[input.kind] ?? 0
    const expiresAt = input.expiresAt ?? (ttlDays > 0 ? at + ttlDays * 86_400_000 : null)
    // 两个时间戳时钟起点都是写入时刻：检索时钟给 recency/衰减一个确定起点，
    // 复习时钟让「新写入的条目」不会在当天就满足「久未复习」的衰减条件。
    sqlInsert.run(
      id, input.scope, input.kind, content, importance, confidence, at, at,
      sourceSessionId, input.sourceRound ?? null, input.sourceSeq ?? null, stored,
      imageryToJson(imagery),
      input.slot?.room ?? null, input.slot?.index ?? null, input.imageryScore ?? null,
      initialReview, initialReview === null ? null : 2.5, initialReview === null ? null : 0,
      expiresAt, input.sourceTier ?? 'agent-inferred', at, at,
      // v16 文件锚：指纹由调用方算好（store 不做文件 I/O）；缺省三列同写 NULL。
      input.anchor?.path ?? null, input.anchor?.hash ?? null, input.anchor?.checkedAt ?? null,
    )
    sqlFtsInsert.run(id, tokenizeForFts(content))
    sqlLog.run(at, op, id, JSON.stringify({ kind: input.kind, scope: input.scope }))
  }

  /** 邻居收集：该 id 触及的全部边按类型分组（supersedes 分方向）。 */
  const edgeGroups = (id: MemoryId): Pick<ReviewView, 'supersededBy' | 'supersedes' | 'contradicts' | 'related'> => {
    const rows = sqlEdgesTouching.all(id, id) as unknown as { from_id: string; to_id: string; type: string }[]
    const supersededBy: string[] = []
    const supersedes: string[] = []
    const contradicts: string[] = []
    const related: string[] = []
    for (const edge of rows) {
      if (edge.type === 'supersedes') {
        if (edge.to_id === id) supersededBy.push(edge.from_id)
        else supersedes.push(edge.to_id)
      } else if (edge.type === 'contradicts') {
        contradicts.push(edge.from_id === id ? edge.to_id : edge.from_id)
      } else if (edge.type === 'related' || edge.type === 'supports' || edge.type === 'refines') {
        related.push(edge.from_id === id ? edge.to_id : edge.from_id)
      }
    }
    return {
      supersededBy: supersededBy.map(asMemoryId),
      supersedes: supersedes.map(asMemoryId),
      contradicts: contradicts.map(asMemoryId),
      related: related.map(asMemoryId),
    }
  }

  /**
   * 写入期自动化（save/批量/摄取/update/蒸馏全部写入路径统一在此落地；调用方须已持事务）：
   * 1) 排桩——显式 slot 优先，否则按 kind 分房自动分配（满员开新房并记 op_log）；
   * 2) 门牌评分——有铭牌时按「唯一/差异化/带日期」启发式落库；
   * 3) 初始排期——reviewScheduling 开启且未显式指定时，1 天后首次到期（显式 null = 明确不排期）；
   * 4) 巡游路线——有桩位的条目登记到固定路线末尾。
   * @returns 合入 WriteInput 的自动化字段。
   */
  const applyWriteAutomation = (input: WriteInput, id: MemoryId, at: number, imagery: ImageryLabel | undefined): Pick<WriteInput, 'slot' | 'imageryScore' | 'initialReviewAt'> => {
    let slot = input.slot
    if (slot === undefined && automation.autoSlot) {
      const occupancy: Record<string, RoomState> = {}
      for (const row of sqlSlotCounts.all() as unknown as { room: string; maxIndex: number; n: number }[]) {
        occupancy[row.room] = { count: row.n, maxIndex: row.maxIndex }
      }
      const assigned = assignSlot(input.kind, occupancy)
      slot = assigned.slot
      if (assigned.openedNewRoom) {
        sqlLog.run(at, 'room-open', 'BATCH', JSON.stringify({ room: slot.room, kind: input.kind }))
      }
    }
    let imageryScore = input.imageryScore
    if (imageryScore === undefined && imagery !== undefined) {
      const placards = (sqlListPlacards.all() as unknown as { room: string | null; caption: string | null }[])
        .filter((row): row is { room: string | null; caption: string } => typeof row.caption === 'string' && row.caption !== '')
      imageryScore = scorePlacard(imagery.caption, {
        existingCaptions: placards.map(row => row.caption),
        roomCaptions: slot === undefined ? [] : placards.filter(row => row.room === slot.room).map(row => row.caption),
      })
    }
    // initialReviewAt 显式给 null = 调用方明确不排期（历史回填：不让回填条目涌入复习队列）；
    // undefined 才走自动化默认（reviewScheduling 开启时 1 天后首次到期）。
    const initialReviewAt = input.initialReviewAt === undefined
      ? (automation.reviewScheduling ? at + 86_400_000 : undefined)
      : input.initialReviewAt ?? undefined
    if (slot !== undefined && sqlRouteHas.get(id) === undefined) sqlRouteAppend.run(id)
    return {
      ...(slot === undefined ? {} : { slot }),
      ...(imageryScore === undefined ? {} : { imageryScore }),
      ...(initialReviewAt === undefined ? {} : { initialReviewAt }),
    }
  }

  /** 导入分类（importPreview 与 importData 共用）：id 占用时比内容全等，否则查内容是否与库内他条全等。 */
  const classifyForImport = (records: readonly MemoryRecord[]): {
    record: MemoryRecord
    content: string
    classification: ImportEntryClass
    duplicateOf?: MemoryId
  }[] =>
    records.map(record => {
      const content = String(record.content ?? '').trim()
      const occupied = getRow(record.id)
      if (occupied !== undefined) {
        if (occupied.content === content) {
          return { record, content, classification: 'duplicate' as const, duplicateOf: asMemoryId(occupied.id) }
        }
        return { record, content, classification: 'conflict' as const, duplicateOf: asMemoryId(occupied.id) }
      }
      const hit = sqlImportContentMatch.get(content) as unknown as { id: string } | undefined
      if (hit !== undefined) {
        return { record, content, classification: 'duplicate' as const, duplicateOf: asMemoryId(hit.id) }
      }
      return { record, content, classification: 'new' as const }
    })

  /**
   * adoption 统计（E）：实例级缓存 60 秒。缓存放在闭包里而不是模块级，是因为一个进程里
   * 同时开着 user / project-* / shared 多个库——共享缓存会让 A 库的采纳计数污染 B 库的排序。
   */
  let adoptionCache: { readonly at: number; readonly stats: ReadonlyMap<string, AdoptionStat> } | undefined
  const adoptionStatsImpl = async (): Promise<ReadonlyMap<string, AdoptionStat>> => {
    const now = Date.now()
    if (adoptionCache !== undefined && now - adoptionCache.at < ADOPTION_CACHE_MS) return adoptionCache.stats
    const rows = sqlAdoptionAudit.all(ADOPTION_SCAN_LIMIT) as unknown as { op: string; detail: string | null }[]
    const used = new Map<string, number>()
    const ignored = new Map<string, number>()
    for (const row of rows) {
      const ids = parseAuditIds(row.detail)
      if (ids === undefined) continue
      const bucket = row.op === 'recall-used' ? used : ignored
      for (const id of ids) bucket.set(id, (bucket.get(id) ?? 0) + 1)
    }
    const stats = new Map<string, AdoptionStat>()
    for (const [id, count] of used) stats.set(id, { used: count, ignored: ignored.get(id) ?? 0 })
    for (const [id, count] of ignored) if (!stats.has(id)) stats.set(id, { used: 0, ignored: count })
    adoptionCache = { at: now, stats }
    return stats
  }

  return {
    async write(input: WriteInput) {
      const content = input.content.trim()
      if (content === '') throw new KyzmemError('EMPTY_CONTENT', message('store.contentEmpty'))
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        const automationFields = applyWriteAutomation(input, id, at, input.imagery)
        insertRecord(id, { ...input, ...automationFields }, content, input.importance ?? 0.5, input.confidence ?? 0.5, at, input.sourceSessionId ?? null, input.embedding ?? null, input.imagery, 'write')
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async get(id: MemoryId) {
      const row = getRow(id)
      return row === undefined ? undefined : rowToRecord(row)
    },

    async getMany(ids: readonly MemoryId[]): Promise<MemoryRecord[]> {
      if (ids.length === 0) return []
      const seen = new Set<string>()
      const unique: MemoryId[] = []
      for (const id of ids) if (!seen.has(id)) { seen.add(id); unique.push(id) }
      const rows = sqlGetManyByIds.all(JSON.stringify(unique.map(id => String(id)))) as unknown as NodeRow[]
      const map = new Map<string, MemoryRecord>()
      for (const row of rows) map.set(row.id, rowToRecord(row))
      // 保留入参顺序，缺失静默跳过。
      return unique.map(id => map.get(id)).filter((r): r is MemoryRecord => r !== undefined)
    },

    async neighbors(id: MemoryId, depth: number): Promise<MemoryRecord[]> {
      const boundedDepth = Math.min(Math.max(1, Math.floor(depth)), 3)
      const rows = sqlNeighborsBounded.all(String(id), boundedDepth) as unknown as NodeRow[]
      const seen = new Set<string>([String(id)])
      const result: MemoryRecord[] = []
      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        result.push(rowToRecord(row))
      }
      return result
    },

    async search(query, queryVector): Promise<SearchResult> {
      const limit = query.limit ?? 8
      const asOf = query.asOf
      type Scored = { score: number; via: SearchHit['via'] }
      const scores = new Map<string, Scored>()
      const channels: SearchChannelStat[] = []
      const now = Date.now()

      // 道 1：FTS5 关键词（2-gram OR），候选上限 MAX_CANDIDATES。
      // 键错误/空查询时 match 为 undefined——仍上报一条 0 命中的通道统计，面板才能区分
      // 「这道没跑」与「这道跑了没结果」。
      const ftsStarted = performance.now()
      const match = ftsMatchExpression(query.text)
      const ftsRows = match === undefined ? [] : ftsSearch(match, query.scopes, query.rooms, asOf)
      ftsRows.forEach((row, index) => {
        scores.set(row.id, { score: 1 / (RRF_K + index + 1), via: 'fts' })
      })
      channels.push({ channel: 'fts', tookMs: Math.round(performance.now() - ftsStarted), hits: ftsRows.length, degraded: false })

      // 道 2：向量余弦。v15 起只在 FTS 候选内重排——同一批候选上算余弦，语义道只负责
      // 「在关键词命中里挑更相关的」，不再用全池向量把大量弱相关条目顶进融合。
      // FTS 零命中时回退全池：纯语义查询（措辞完全不同的同义表述）没有关键词交集，
      // 若也走候选内，向量道就永远救不回来，这违背了保留向量道的初衷。
      const vectorStarted = performance.now()
      let vectorHits = 0
      let degraded = queryVector === undefined
      if (queryVector !== undefined) {
        const candidates = ftsRows.length > 0
          ? ftsRows.filter(row => row.embedding !== null)
          : vectorPool(query.scopes, query.rooms, asOf)
        const ranked = candidates
          .map(row => ({ row, sim: cosine(queryVector, blobToVec(row.embedding!)) }))
          .filter(entry => entry.sim >= MIN_COSINE)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, RANK_POOL)
        vectorHits = ranked.length
        ranked.forEach((entry, index) => {
          const add = 1 / (RRF_K + index + 1)
          const existing = scores.get(entry.row.id)
          if (existing === undefined) {
            scores.set(entry.row.id, { score: add, via: 'vec' })
          } else {
            scores.set(entry.row.id, { score: existing.score + add, via: 'both' })
          }
        })
      }
      channels.push({ channel: 'vector', tookMs: Math.round(performance.now() - vectorStarted), hits: vectorHits, degraded })

      // 排序 boost：RRF 融合分之上乘 recency 与 proof 因子（权重 0 时因子恒 1，退化为纯 RRF）。
      // v15：recency 基准从 last_accessed_at 改 created_at——前者在旧实现里被 forget/restore/
      // scheduleReview 反复刷新，早已不代表「新近程度」；created_at 不可变，语义唯一。
      // proof 仍读 access_count（「被用过几次」的代理指标）。
      if (rankBoost.recencyWeight !== 0 || rankBoost.proofWeight !== 0) {
        for (const [id, info] of scores) {
          const row = getRow(id)
          if (row === undefined) continue
          const daysSince = Math.max(0, (now - row.created_at) / 86_400_000)
          const recency = 1 + rankBoost.recencyWeight * Math.max(0, 1 - daysSince / rankBoost.decayAfterDays)
          const proof = 1 + rankBoost.proofWeight * Math.log2(1 + row.access_count)
          info.score *= recency * proof
        }
      }

      // E. adoption 因子：接在 recency/proof 之后，只加不减（见 adoptionFactor）。
      // 权重 0 时整段跳过——连一次 op_log 扫描都不做，旧部署的检索路径与 v0.12 完全一致。
      // 为什么用本库的审计：采纳归因写在「检索实际落到的库」（index.ts 的 auditRecallAdoption），
      // 所以 project 库的条目只吃 project 库的 used/ignored，不会跨库串味。
      const adoptionWeight = rankBoost.adoptionWeight ?? 0
      if (adoptionWeight > 0) {
        const adoption = await adoptionStatsImpl()
        for (const [id, info] of scores) {
          const factor = adoptionFactor(adoption.get(id), adoptionWeight)
          if (factor !== 1) info.score *= factor
        }
      }

      // TTL 降权（v15）：过期条目不硬过滤（历史事实仍有价值，用户可能正好在回忆旧状态），
      // 命中时分数 ×0.5 并在命中上标 expired，由渲染侧标 [已过期] 让模型自己决定信不信。
      const expiredIds = new Set<string>()
      for (const [id, info] of scores) {
        const row = getRow(id)
        if (row === undefined || row.expires_at === null || row.expires_at > now) continue
        info.score *= 0.5
        expiredIds.add(id)
      }

      // 关系一跳扩展：top 结果的 supports/refines/related/supersedes 邻居低权重（0.5*父分）引入。
      // contradicts 不入分（只进 cues.contradicts）：冲突是「需要裁决」的提示，不是相关性证据，
      // 计分会把互相矛盾的条目一起顶进注入结果——那正是最该避免的「记忆自相矛盾」场景。
      const topIds = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([id]) => id)
      const viaEdgeOf = new Map<string, { from: MemoryId; type: MemoryEdge['type'] }>()
      const graphStarted = performance.now()
      let graphHits = 0
      if (topIds.length > 0) {
        const edges = sqlNeighbors.all(JSON.stringify(topIds), EXPANSION_LIMIT) as unknown as MemoryEdge[]
        for (const edge of edges) {
          if (scores.has(edge.to) || !topIds.includes(edge.from)) continue
          const row = getRow(edge.to)
          if (row === undefined) continue
          // 时点检索下 status 是「现在」的状态，不能拿它当判据（见 validityCond 的注释）；
          // 默认视图仍只扩展 active 邻居。
          if (asOf === undefined ? row.status !== 'active' : row.status === 'forgotten') continue
          if (!query.scopes.includes(row.scope as KyzmemScope)) continue
          // 时点检索下不得引入「当时还不存在 / 当时已失效」的邻居。
          if (asOf !== undefined && (row.created_at > asOf || (row.invalid_at !== null && row.invalid_at <= asOf))) continue
          const baseScore = scores.get(edge.from)?.score
          if (baseScore === undefined) continue
          scores.set(edge.to, { score: baseScore * 0.5, via: 'graph' })
          viaEdgeOf.set(edge.to, { from: asMemoryId(edge.from), type: edge.type })
          graphHits++
        }
      }
      channels.push({ channel: 'graph', tookMs: Math.round(performance.now() - graphStarted), hits: graphHits, degraded: false })

      // 排序截断 + 命中详情（线索/实体/冲突提示）。
      const finalRows = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
      const hits: SearchHit[] = []
      const touchedIds: string[] = []
      for (const [id, info] of finalRows) {
        const row = getRow(id)
        if (row === undefined) continue
        const viaEdge = viaEdgeOf.get(id)
        // 编码特异性线索（top5）：同房间相邻桩位——提取时重建编码情境（“它旁边挂着什么”）。
        const cueNeighbors = hits.length < 5 && row.slot_room !== null && row.slot_index !== null
          ? (sqlSlotNeighbors.all(row.slot_room, row.slot_index - 1, row.slot_index + 1, id) as unknown as { id: string }[])
              .map(neighbor => asMemoryId(neighbor.id))
          : []
        // 冲突线索（v15）：只提示不计分（见上方一跳扩展的注释）。
        const conflictRows = sqlContradictsByNode.all(id, id) as unknown as { from_id: string; to_id: string }[]
        const contradicts = conflictRows.map(edge => asMemoryId(edge.from_id === id ? edge.to_id : edge.from_id))
        const hasCues = cueNeighbors.length > 0 || contradicts.length > 0
        // 实体标签（schema v10）：命中的记忆附上关联实体（id + 规范名），提取路径可沿实体展开。
        const entityRows = sqlEntityByNode.all(id) as unknown as EntityRow[]
        hits.push({
          record: rowToRecord(row),
          score: info.score,
          via: info.via,
          ...(viaEdge === undefined ? {} : { viaEdge }),
          ...(hasCues
            ? { cues: { neighbors: cueNeighbors, ...(contradicts.length === 0 ? {} : { contradicts }) } }
            : {}),
          ...(entityRows.length === 0
            ? {}
            : { entities: entityRows.map(r => ({ id: asEntityId(r.id), name: r.name })) }),
          ...(expiredIds.has(id) ? { expired: true } : {}),
        })
        touchedIds.push(id)
      }
      // 命中强化 + 召回审计同事务落库：要么「强化+留痕」一起成功，要么都不写（避免出现
      // 强化了却没有审计、或审计指向未强化条目的半成品状态）。
      if (touchedIds.length > 0) {
        // touch === false（首问自动召回/预检）跳过强化：这些候选不一定被注入，给它们加
        // access_count 会让「被召回过一次」的条目永久逃过衰减（评审 M6）；留痕用 markRetrieved。
        const touchEnabled = query.touch !== false
        // 召回审计（契约 §6）：与 touch 解耦——即便不强化也要留下「召回过什么」，
        // 否则自动召回完全不可观测（评审 M4）。detail 形状 {ids, mode, query|queryHash}；
        // 默认 mode='search'/auditQuery='raw' 保持旧行为，隐私路径可传 'hash'（只存 16 位
        // sha256 前缀）或 'none'（不记原文，评审 M5）。
        const mode = query.auditMode ?? 'search'
        const auditQuery = query.auditQuery ?? 'raw'
        const detail: { ids: string[]; mode: string; query?: string; queryHash?: string } = { ids: touchedIds, mode }
        if (auditQuery === 'hash') {
          detail.queryHash = createHash('sha256').update(query.text).digest('hex').slice(0, 16)
        } else if (auditQuery === 'raw') {
          detail.query = query.text
        }
        withTransaction(() => {
          if (touchEnabled) sqlTouch.run(now, JSON.stringify(touchedIds))
          sqlLog.run(now, 'recall', 'BATCH', capDetail(JSON.stringify(detail)))
        })
      }
      return { hits, degraded, channels }
    },

    adoptionStats: adoptionStatsImpl,

    async timeline(query: TimelineQuery) {
      const limit = query.limit ?? 20
      const placeholders = query.scopes.map(() => '?').join(',')
      const where = `nodes.status = 'active' AND nodes.scope IN (${placeholders})
        AND (? IS NULL OR nodes.created_at >= ?) AND (? IS NULL OR nodes.created_at <= ?)
        AND (? IS NULL OR instr(nodes.content, ?) > 0)`
      const params: (string | number | null)[] = [
        ...query.scopes,
        query.since ?? null, query.since ?? null,
        query.until ?? null, query.until ?? null,
        query.topic ?? null, query.topic ?? null,
        limit,
      ]
      // order=tour：LEFT JOIN 巡游路线，按桩位顺序排（未上路线者 IS NULL 置后，按创建时间收尾）。
      const rows = query.order === 'tour'
        ? db.prepare(`SELECT nodes.* FROM nodes LEFT JOIN tour_routes ON tour_routes.node_id = nodes.id
            WHERE ${where} ORDER BY tour_routes.position IS NULL, tour_routes.position ASC, nodes.created_at DESC LIMIT ?`)
          .all(...params) as unknown as NodeRow[]
        : db.prepare(`SELECT nodes.* FROM nodes WHERE ${where} ORDER BY nodes.created_at DESC LIMIT ?`)
          .all(...params) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async episodeTimeline(query: EpisodeTimelineQuery): Promise<EpisodeTimelineResult> {
      const limit = Math.max(1, Math.floor(query.limit ?? EPISODE_TIMELINE_LIMIT_DEFAULT))
      const placeholders = query.scopes.map(() => '?').join(',')
      // 时间邻近扩展模式：锚点不限 kind（事实/决策也可作锚），邻居只取 episode；
      // 窗口覆盖日期过滤（窗口语义下日期过滤只会截断扩展结果）。
      if (query.around !== undefined) {
        const anchorRow = getRow(query.around)
        if (anchorRow === undefined) throw new KyzmemError('NOT_FOUND', message('store.anchorNotFound', { id: query.around }))
        const window = Math.max(0, Math.floor(query.proximityMs ?? EPISODE_PROXIMITY_MS_DEFAULT))
        const rows = db.prepare(`SELECT * FROM nodes
            WHERE kind = 'episode' AND status = 'active' AND scope IN (${placeholders})
              AND id != ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at ASC LIMIT ?`)
          .all(...query.scopes, query.around, anchorRow.created_at - window, anchorRow.created_at + window, limit) as unknown as NodeRow[]
        return { groups: [], around: { anchor: rowToRecord(anchorRow), neighbors: rows.map(rowToRecord) } }
      }
      const params: (string | number | null)[] = [
        ...query.scopes,
        query.since ?? null, query.since ?? null,
        query.until ?? null, query.until ?? null,
        query.sessionId ?? null, query.sessionId ?? null,
        limit,
      ]
      const rows = db.prepare(`SELECT * FROM nodes
          WHERE kind = 'episode' AND status = 'active' AND scope IN (${placeholders})
            AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
            AND (? IS NULL OR source_session_id = ?)
          ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as unknown as NodeRow[]
      // 按来源会话分组：DESC 遍历后组内反转成升序；组按会话起点倒序（最新会话在前）。
      const bySession = new Map<string | null, MemoryRecord[]>()
      for (const row of rows) {
        const record = rowToRecord(row)
        const bucket = bySession.get(record.sourceSessionId)
        if (bucket === undefined) bySession.set(record.sourceSessionId, [record])
        else bucket.push(record)
      }
      const groups = [...bySession.entries()].map(([sessionId, episodesDesc]) => {
        const episodes = [...episodesDesc].reverse()
        return {
          sessionId,
          episodes,
          startedAt: episodes[0]!.createdAt,
          endedAt: episodes[episodes.length - 1]!.createdAt,
        }
      })
      groups.sort((a, b) => b.startedAt - a.startedAt)
      // 组头摘要：按会话 id 批量取（一次查询），命中的组带 summary（可选字段条件展开）。
      const sessionIds = groups.map(g => g.sessionId).filter((id): id is string => id !== null)
      const summaries = new Map<string, string>()
      if (sessionIds.length > 0) {
        const rows = sqlSessionSummaryMany.all(JSON.stringify(sessionIds)) as unknown as { session_id: string; summary: string }[]
        for (const row of rows) summaries.set(row.session_id, row.summary)
      }
      return {
        groups: groups.map(group => {
          const summary = group.sessionId === null ? undefined : summaries.get(group.sessionId)
          return { ...group, ...(summary === undefined ? {} : { summary }) }
        }),
      }
    },

    async setSessionSummary(sessionId: string, summary: string): Promise<void> {
      sqlSessionSummaryUpsert.run(sessionId, summary, Date.now())
      sqlLog.run(Date.now(), 'session-summary', sessionId, JSON.stringify({ length: summary.length }))
    },

    async getSessionSummary(sessionId: string): Promise<string | undefined> {
      const row = sqlSessionSummaryGet.get(sessionId) as unknown as { session_id: string; summary: string } | undefined
      return row?.summary
    },

    async latestSessionSummary(): Promise<SessionSummaryRecord | undefined> {
      const row = sqlSessionSummaryLatest.get() as unknown as
        | { session_id: string; summary: string; updated_at: number }
        | undefined
      if (row === undefined) return undefined
      return { sessionId: row.session_id, summary: row.summary, updatedAt: row.updated_at }
    },

    async update(input: UpdateInput) {
      const old = getRow(input.id)
      if (old === undefined) throw new KyzmemError('NOT_FOUND', message('store.entryNotFound', { id: input.id }))
      const content = input.content.trim()
      if (content === '') throw new KyzmemError('EMPTY_CONTENT', message('store.contentEmpty'))
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        // 修订历史先行：归档旧条目前快照其内容（内容不变性审计，schema v4）。
        sqlRevisionInsert.run(input.id, old.content, old.kind, old.importance, at)
        // v15：旧条目同时打 invalid_at——时点检索靠它还原「当时还是旧值」的库。
        sqlMarkInvalid.run(at, input.id)
        sqlLog.run(at, 'superseded', input.id, JSON.stringify({ supersededBy: id }))
        // 新条目是新物品：重新排桩/评分/排期（宫殿里修正一件物品 = 在新桩位放新版）。
        const imagery = input.imagery ?? jsonToImagery(old.imagery_json)
        // 文件锚（v16）：显式给 = 按调用方算好的新指纹写；null = 明确清空；缺省 = 继承旧锚点，
        // 且 checkedAt 原样带过来——「写入」不等于「复验过」，刷新它会让面板的 stale 统计失真。
        const inheritedAnchor: MemoryAnchor | undefined = old.anchor_path === null || old.anchor_hash === null
          ? undefined
          : { path: old.anchor_path, hash: old.anchor_hash, checkedAt: old.anchor_checked_at ?? 0 }
        const anchor = input.anchor === undefined ? inheritedAnchor : input.anchor ?? undefined
        const updateInput: WriteInput = {
          scope: input.scope, kind: input.kind, content,
          ...(anchor === undefined ? {} : { anchor }),
        }
        const automationFields = applyWriteAutomation(updateInput, id, at, imagery)
        insertRecord(
          id,
          { ...updateInput, ...automationFields },
          content,
          input.importance ?? old.importance,
          old.confidence,
          at,
          old.source_session_id,
          input.embedding ?? old.embedding,
          imagery,
          'update',
        )
        sqlEdgeUpsert.run(id, input.id, 'supersedes', at)
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async forget(id: MemoryId) {
      const row = getRow(id)
      if (row === undefined) throw new KyzmemError('NOT_FOUND', message('store.entryNotFound', { id }))
      sqlSetStatus.run('forgotten', id)
      sqlLog.run(Date.now(), 'forget', id, null)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async forgetWithTombstone(id: MemoryId, tombstone: ForgettingTombstone) {
      const row = getRow(id)
      if (row === undefined) throw new KyzmemError('NOT_FOUND', message('store.entryNotFound', { id }))
      const at = Date.now()
      // 墓志铭三问脱敏清洗（避免闭馆时把会话密钥一并封进 op_log）。
      const cleaned = {
        reason: tombstone.reason.trim().slice(0, 200),
        affects: tombstone.affects.trim().slice(0, 200),
        stillUseful: tombstone.stillUseful.trim().slice(0, 200),
      }
      sqlSetStatus.run('forgotten', id)
      sqlLog.run(at, 'forget', id, JSON.stringify({ tombstone: cleaned }))
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async listForgottenWithTombs(limit: number): Promise<readonly ForgottenAuditRow[]> {
      const boundedLimit = Math.max(1, Math.min(limit, 200))
      const rows = db.prepare(`SELECT n.*, o.at AS forgotten_at, o.detail AS tombstone_json
        FROM nodes n
        INNER JOIN op_log o ON o.target_id = n.id AND o.op = 'forget'
        WHERE n.status = 'forgotten'
        ORDER BY o.seq DESC
        LIMIT ?`).all(boundedLimit) as unknown as (NodeRow & { forgotten_at: number; tombstone_json: string | null })[]
      return rows.map((row) => {
        let tombstone: ForgettingTombstone | null = null
        if (row.tombstone_json !== null) {
          try {
            const parsed = JSON.parse(row.tombstone_json) as { tombstone?: { reason?: unknown; affects?: unknown; stillUseful?: unknown } }
            const inner = parsed.tombstone
            if (inner !== undefined && typeof inner.reason === 'string') {
              tombstone = {
                reason: inner.reason,
                affects: typeof inner.affects === 'string' ? inner.affects : '',
                stillUseful: typeof inner.stillUseful === 'string' ? inner.stillUseful : '',
              }
            }
          } catch {
            tombstone = null
          }
        }
        const base = rowToRecord(row)
        return {
          id: base.id,
          scope: base.scope,
          kind: base.kind,
          content: base.content,
          importance: base.importance,
          lastAccessedAt: base.lastAccessedAt,
          tombstone,
          forgottenAt: row.forgotten_at,
        }
      })
    },

    async reportOutcome(id: MemoryId, outcome: MemoryOutcome) {
      // 奖励信号：success 提权 +0.05、failure 降权 -0.1（夹逼 0-1），软删/归档条目也接受回报（效果事实不因状态改变）。
      const row = getRow(id)
      if (row === undefined) return undefined
      // 参数依次：SET outcome、CASE 效果判断、WHERE id（CASE 与 SET 用同一 outcome 值）。
      sqlSetOutcome.run(outcome, outcome, id)
      sqlLog.run(Date.now(), 'outcome-report', id, outcome)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async scheduleReview(id: MemoryId, grade: ReviewGrade) {
      const row = getRow(id)
      if (row === undefined) return undefined
      const now = Date.now()
      // 未排期过的条目从 SM-2 初始态起步（ease 2.5 / 间隔 0 / reps 0）。
      const current = rowToRecord(row).review ?? {
        nextReviewAt: null, easeFactor: 2.5, intervalDays: 0, reps: row.review_reps ?? 0,
      }
      // 重学窗口由调用方（插件层 resolved.reviewRelearnDays）注入，函数本身保持纯：
      // 逾期超过该天数后答对，按「遗忘重学」处理（reps 清零、间隔回到 1 天）。
      const next = nextSchedule(grade, current, now, automation.reviewRelearnDays ?? DEFAULT_RELEARN_DAYS)
      sqlScheduleReview.run(next.nextReviewAt, next.easeFactor, next.intervalDays, next.reps, now, id)
      sqlLog.run(now, 'review-answer', id, JSON.stringify({ grade, nextIntervalDays: next.intervalDays }))
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async dueReviews(now: number, limit: number) {
      const rows = sqlDueReviews.all(now, Math.max(1, limit)) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async slotCountsByRoom() {
      const rows = sqlSlotCounts.all() as unknown as { room: string; maxIndex: number; n: number }[]
      const result: Record<string, RoomState> = {}
      for (const row of rows) result[row.room] = { count: row.n, maxIndex: row.maxIndex }
      return result
    },

    async assignSlot(id: MemoryId, slot: Slot) {
      sqlSetSlot.run(slot.room, slot.index, id)
      sqlLog.run(Date.now(), 'slot-assign', id, JSON.stringify(slot))
    },

    async backfillSlots(capacityNote: (room: string) => void) {
      // 存量排桩：只处理 active 且未排桩的条目（幂等，可重跑）；
      // 按 kind 分房、created_at 定序，与 save 时的实时排桩共用 assignSlot 规则。
      const rows = sqlUnslotted.all() as unknown as NodeRow[]
      if (rows.length === 0) return 0
      const now = Date.now()
      withTransaction(() => {
        const occupancy: Record<string, RoomState> = {}
        for (const row of sqlSlotCounts.all() as unknown as { room: string; maxIndex: number; n: number }[]) {
          occupancy[row.room] = { count: row.n, maxIndex: row.maxIndex }
        }
        for (const row of rows) {
          const { slot, openedNewRoom } = assignSlot(row.kind as MemoryRecord['kind'], occupancy)
          sqlSetSlot.run(slot.room, slot.index, row.id)
          // 巡游路线补登记：已在路线上的（重复跑）跳过。
          if (sqlRouteHas.get(row.id) === undefined) sqlRouteAppend.run(row.id)
          const state = occupancy[slot.room] ?? { count: 0, maxIndex: 0 }
          occupancy[slot.room] = { count: state.count + 1, maxIndex: Math.max(state.maxIndex, slot.index) }
          if (openedNewRoom) capacityNote(slot.room)
        }
        sqlLog.run(now, 'slot-backfill', 'BATCH', JSON.stringify({ assigned: rows.length }))
      })
      return rows.length
    },

    async routeAppend(id: MemoryId) {
      sqlRouteAppend.run(id)
    },

    async routeHas(id: MemoryId) {
      return sqlRouteHas.get(id) !== undefined
    },

    async routeList() {
      const rows = sqlRouteList.all() as unknown as { position: number; node_id: string }[]
      return rows.map(row => ({ position: row.position, id: asMemoryId(row.node_id) }))
    },

    async listPlacards() {
      const rows = sqlListPlacards.all() as unknown as { room: string | null; caption: string | null }[]
      // caption 为 null 的铭牌（json 里 caption 字段为 null）不参与唯一性/差异化比较。
      return rows.filter((row): row is { room: string | null; caption: string } => typeof row.caption === 'string' && row.caption !== '')
    },

    async getProfileBlock(scope: KyzmemScope): Promise<ProfileBlock | undefined> {
      const row = sqlProfileBlockGet.get(scope) as unknown as { scope: string; content: string; version: number; updated_at: number } | undefined
      if (row === undefined) return undefined
      return { scope: row.scope as KyzmemScope, content: row.content, version: row.version, updatedAt: row.updated_at }
    },

    async saveProfileBlock(scope: KyzmemScope, expectedVersion: number | undefined, content: string, source: ProfileBlockVersion['source']): Promise<ProfileBlock> {
      if (content.trim() === '') throw new KyzmemError('EMPTY_CONTENT', message('store.profileContentEmpty'))
      const current = sqlProfileBlockGet.get(scope) as unknown as { version: number } | undefined
      // 乐观锁：未带版本仅允许首次创建；带版本必须与当前一致（并发编辑 loud 失败）。
      if (current === undefined && expectedVersion !== undefined) {
        throw new KyzmemError('VERSION_CONFLICT', message('store.profileBlockMissing', { scope, expected: String(expectedVersion) }))
      }
      if (current !== undefined && expectedVersion !== current.version) {
        throw new KyzmemError('VERSION_CONFLICT', message('store.profileVersionConflict', { scope, current: String(current.version), expected: String(expectedVersion) }))
      }
      const nextVersion = current === undefined ? 1 : current.version + 1
      const now = Date.now()
      // 版本行先落（rollback 数据源），再更新当前态；同一事务保证两表一致。
      withTransaction(() => {
        sqlProfileVersionInsert.run(scope, nextVersion, content, source, now)
        sqlProfileBlockUpsert.run(scope, content, nextVersion, now)
      })
      return { scope, content, version: nextVersion, updatedAt: now }
    },

    async listProfileBlockVersions(scope: KyzmemScope, limit: number): Promise<ProfileBlockVersion[]> {
      const rows = sqlProfileVersionsList.all(scope, Math.max(1, limit)) as unknown as
        { scope: string; version: number; content: string; source: string; at: number }[]
      return rows.map(row => ({
        scope: row.scope as KyzmemScope,
        version: row.version,
        content: row.content,
        source: row.source === 'rollback' ? 'rollback' : 'edit',
        at: row.at,
      }))
    },

    async getProfileBlockVersion(scope: KyzmemScope, version: number): Promise<ProfileBlockVersion | undefined> {
      const row = sqlProfileVersionGet.get(scope, version) as unknown as
        { scope: string; version: number; content: string; source: string; at: number } | undefined
      if (row === undefined) return undefined
      return {
        scope: row.scope as KyzmemScope,
        version: row.version,
        content: row.content,
        source: row.source === 'rollback' ? 'rollback' : 'edit',
        at: row.at,
      }
    },

    async restore(id: MemoryId) {
      const row = getRow(id)
      if (row === undefined) throw new KyzmemError('NOT_FOUND', message('store.entryNotFound', { id }))
      // 只回状态、不碰时间戳：restore 不是「访问」，也不是「复习」——旧实现把它当最后一次访问，
      // 直接让衰减判据（久未复习）失效。
      sqlRestore.run(id)
      sqlLog.run(Date.now(), 'restore', id, null)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async topActive(scope: KyzmemScope, n: number) {
      const rows = sqlTopActive.all(scope, n) as unknown as NodeRow[]
      return rows.map(rowToRecord)
    },

    async list(filter: ListFilter): Promise<ListResult> {
      const conds: string[] = ['scope = ?']
      const params: (string | number)[] = [filter.scope]
      if (filter.status !== undefined) { conds.push('status = ?'); params.push(filter.status) }
      if (filter.kind !== undefined) { conds.push('kind = ?'); params.push(filter.kind) }
      // 来源分级过滤（v15）：confirmedOnly 是「显式确认」的严格口径——只有用户亲手确认过的条目
      // （kyzmem_save / kyzmem_facts 等显式保存路径写入 sourceTier='user-confirmed'）才进这个视图。
      // 注意与 isTrustedTier / injectTiers 区分：那两个管「注入上下文时信不信这条」，范围更宽
      // （user-confirmed + agent-inferred）；这里管「用户是否点名确认过」，两者不是一回事，
      // 混用会让面板「仅看已确认」chip 恒空（没有任何路径写 user-confirmed 之外的差异）。
      if (filter.confirmedOnly === true) conds.push("source_tier = 'user-confirmed'")
      if (filter.q !== undefined && filter.q !== '') { conds.push('instr(content, ?) > 0'); params.push(filter.q) }
      // 脱敏标记过滤：标记格式由 redact.ts 固定（[REDACTED:<类型>]），LIKE 字面匹配。
      if (filter.redacted !== undefined) {
        conds.push(filter.redacted ? "content LIKE '%[REDACTED:%'" : "content NOT LIKE '%[REDACTED:%'")
      }
      const where = conds.join(' AND ')
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(...params) as unknown as { n: number }).n
      // sort=tour：LEFT JOIN 巡游路线，按桩位顺序排（未上路线者 IS NULL 置后，按创建时间收尾）。
      const rows = filter.sort === 'tour'
        ? db.prepare(`SELECT nodes.* FROM nodes LEFT JOIN tour_routes ON tour_routes.node_id = nodes.id
            WHERE ${where} ORDER BY tour_routes.position IS NULL, tour_routes.position ASC, created_at DESC LIMIT ? OFFSET ?`)
          .all(...params, filter.limit, filter.offset) as unknown as NodeRow[]
        : db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
          .all(...params, filter.limit, filter.offset) as unknown as NodeRow[]
      return { records: rows.map(rowToRecord), total }
    },

    async review(id: MemoryId): Promise<ReviewView | undefined> {
      const row = getRow(id)
      if (row === undefined) return undefined
      const operations = sqlOpLogById.all(id, REVIEW_LOG_LIMIT) as unknown as { at: number; op: string; target_id: string; detail: string | null }[]
      const revisions = sqlRevisionsById.all(id) as unknown as { content: string; kind: string; importance: number; superseded_at: number }[]
      return {
        record: rowToRecord(row),
        ...edgeGroups(id),
        revisions: revisions.map(rev => ({ content: rev.content, kind: rev.kind, importance: rev.importance, supersededAt: rev.superseded_at })),
        operations: operations.map(op => ({ at: op.at, op: op.op, targetId: op.target_id, detail: op.detail })),
      }
    },

    async recentOps(limit: number) {
      const rows = sqlRecentOps.all(Math.max(1, limit)) as unknown as { at: number; op: string; target_id: string; detail: string | null }[]
      return rows.map(op => ({ at: op.at, op: op.op, targetId: op.target_id, detail: op.detail }))
    },

    async stats(): Promise<StoreStats> {
      const statusRows = sqlCountBy.all() as unknown as { status: string; n: number }[]
      const kindRows = sqlCountKind.all() as unknown as { kind: string; n: number }[]
      const edgeCount = (sqlCountEdges.get() as unknown as { n: number }).n
      const opCount = (sqlCountOpLog.get() as unknown as { n: number }).n
      const byStatus: Record<string, number> = { active: 0, archived: 0, forgotten: 0 }
      for (const row of statusRows) byStatus[row.status] = row.n
      const byKind: Record<string, number> = {}
      for (const row of kindRows) byKind[row.kind] = row.n
      const active = byStatus['active'] ?? 0
      const archived = byStatus['archived'] ?? 0
      const forgotten = byStatus['forgotten'] ?? 0
      const total = active + archived + forgotten
      // v15 扩展指标：过期命中面（TTL）、已失效存量（被取代）、来源分级占比、待裁决冲突、
      // 当前到期量。全部是面板 12 指标表的直接数据源，调用方不必各自拼 SQL。
      const now = Date.now()
      const byTier: Record<string, number> = {}
      for (const row of sqlCountByTier.all() as unknown as { tier: string; n: number }[]) byTier[row.tier] = row.n
      return {
        total,
        active,
        archived,
        forgotten,
        redacted: (sqlCountRedacted.get() as unknown as { n: number }).n,
        byKind,
        edges: edgeCount,
        opLogCount: opCount,
        signalRatio: total === 0 ? 0 : active / total,
        expired: (sqlCountExpired.get(now) as unknown as { n: number }).n,
        invalidated: (sqlCountInvalidated.get() as unknown as { n: number }).n,
        byTier,
        openConflicts: (sqlCountConflicts.get() as unknown as { n: number }).n,
        dueCount: (sqlCountDue.get(now) as unknown as { n: number }).n,
      }
    },

    async exportAll(): Promise<ExportData> {
      const records = (sqlAllNodes.all() as unknown as NodeRow[]).map(rowToRecord)
      const edgeRows = sqlAllEdges.all() as unknown as { from_id: string; to_id: string; type: string; created_at: number }[]
      const entities = (sqlEntityAll.all() as unknown as EntityRow[]).map(entityRowToRecord)
      return {
        exportedAt: Date.now(),
        records,
        edges: edgeRows.map(edge => ({ from: asMemoryId(edge.from_id), to: asMemoryId(edge.to_id), type: edge.type as MemoryEdge['type'], createdAt: edge.created_at })),
        entities,
      }
    },

    async importPreview(data: ExportData): Promise<ImportPreview> {
      const classified = classifyForImport(data.records ?? [])
      const storeIds = new Set((sqlAllNodes.all() as unknown as NodeRow[]).map(row => row.id))
      const importable = new Set(classified.filter(c => c.classification === 'new').map(c => c.record.id))
      let edgesDangling = 0
      for (const edge of data.edges ?? []) {
        if (!(storeIds.has(edge.from) || importable.has(edge.from))) { edgesDangling++; continue }
        if (!(storeIds.has(edge.to) || importable.has(edge.to))) edgesDangling++
      }
      let entitiesNew = 0
      let entitiesMerged = 0
      for (const entity of data.entities ?? []) {
        if (sqlEntityGet.get(entity.id) === undefined) entitiesNew++
        else entitiesMerged++
      }
      return {
        entries: classified.map(c => ({
          id: c.record.id,
          kind: c.record.kind,
          status: c.record.status,
          content: c.content,
          classification: c.classification,
          ...(c.duplicateOf === undefined ? {} : { duplicateOf: c.duplicateOf }),
        })),
        edgesTotal: (data.edges ?? []).length,
        edgesDangling,
        entitiesNew,
        entitiesMerged,
      }
    },

    async importData(data: ExportData, options: ImportOptions = {}): Promise<ImportResult> {
      const classified = classifyForImport(data.records ?? [])
      const selected = options.selectedIds === undefined ? undefined : new Set(options.selectedIds)
      const eligible = classified.filter(c => {
        if (selected !== undefined && !selected.has(c.record.id)) return false
        if (c.classification === 'new') return true
        if (c.classification !== 'duplicate') return false
        // 内容全等且 id 空闲的重复在 keepDuplicates 下放行；id 被占用的重复是同一备份回灌，永不重复插入。
        return options.keepDuplicates === true && getRow(c.record.id) === undefined
      })
      const importedIds = new Set(eligible.map(c => c.record.id))
      const storeIds = new Set((sqlAllNodes.all() as unknown as NodeRow[]).map(row => row.id))
      const entityRows = data.entities ?? []
      let edgesLinked = 0
      let edgesDangling = 0
      let entitiesNew = 0
      let entitiesMerged = 0
      const at = Date.now()
      withTransaction(() => {
        for (const c of eligible) {
          const r = c.record
          const review = r.review
          sqlImportInsert.run(
            r.id, r.scope, r.kind, c.content, r.importance, r.confidence, r.status,
            r.createdAt, r.lastAccessedAt, r.accessCount,
            r.sourceSessionId ?? null, r.sourceRound ?? null, r.sourceSeq ?? null,
            null, r.outcome ?? null, imageryToJson(r.imagery),
            r.slot?.room ?? null, r.slot?.index ?? null, r.imageryScore ?? null,
            review?.nextReviewAt ?? null, review?.easeFactor ?? null, review?.intervalDays ?? null, review?.reps ?? null,
            // v15 五列：导入保留导出侧的时间线（含失效点与 TTL）；老备份没有这些字段时
            // 用 createdAt/lastAccessedAt 兜底，保证 recency 与衰减判据仍有值可读。
            r.invalidAt ?? null, r.expiresAt ?? null, r.sourceTier ?? 'agent-inferred',
            r.lastRetrievedAt ?? r.createdAt, r.lastReviewedAt ?? r.lastAccessedAt,
            // v16 文件锚：老备份没有该字段时按无锚点导入（三列同 NULL），不影响既有条目。
            r.anchor?.path ?? null, r.anchor?.hash ?? null, r.anchor?.checkedAt ?? null,
          )
          sqlFtsInsert.run(r.id, tokenizeForFts(c.content))
        }
        for (const edge of data.edges ?? []) {
          if (!(storeIds.has(edge.from) || importedIds.has(edge.from))) { edgesDangling++; continue }
          if (!(storeIds.has(edge.to) || importedIds.has(edge.to))) { edgesDangling++; continue }
          sqlEdgeUpsert.run(edge.from, edge.to, edge.type, edge.createdAt)
          edgesLinked++
        }
        for (const entity of entityRows) {
          const row = sqlEntityGet.get(entity.id) as unknown as EntityRow | undefined
          if (row === undefined) {
            const aliases = [...new Set(entity.aliases)].map(a => a.trim()).filter(a => a !== '')
            sqlEntityInsert.run(entity.id, entity.name, entity.kind, JSON.stringify(aliases), entity.createdAt, entity.updatedAt)
            entitiesNew++
            continue
          }
          const merged = [...new Set([...entityRowToRecord(row).aliases, ...entity.aliases])]
            .map(a => a.trim()).filter(a => a !== '')
          sqlImportEntityAliases.run(JSON.stringify(merged), at, entity.id)
          entitiesMerged++
        }
        if (eligible.length > 0 || (data.edges ?? []).length > 0) {
          sqlLog.run(at, 'import', 'BATCH', JSON.stringify({
            imported: eligible.length, edges: edgesLinked, dangling: edgesDangling, exportedAt: data.exportedAt,
          }))
        }
      })
      return {
        imported: eligible.length,
        importedIds: eligible.map(c => c.record.id),
        skippedDuplicates: classified.filter(c => c.classification === 'duplicate').length
          - eligible.filter(c => c.classification === 'duplicate').length,
        conflicts: classified.filter(c => c.classification === 'conflict').length,
        edgesLinked,
        edgesDangling,
        entitiesNew,
        entitiesMerged,
      }
    },

    async attachEmbeddings(entries: readonly { readonly id: MemoryId; readonly embedding: Float32Array }[]): Promise<number> {
      let attached = 0
      withTransaction(() => {
        for (const entry of entries) {
          const result = sqlImportAttachEmbedding.run(vecToBlob(entry.embedding), entry.id)
          attached += Number(result.changes)
        }
      })
      return attached
    },

    async embeddingsFor(ids: readonly string[]): Promise<ReadonlyMap<string, Float32Array>> {
      const found = new Map<string, Float32Array>()
      if (ids.length === 0) return found
      const rows = sqlEmbeddingsFor.all(JSON.stringify(ids)) as unknown as { id: string; embedding: Uint8Array }[]
      for (const row of rows) found.set(row.id, blobToVec(row.embedding))
      return found
    },

    async decay(options: DecayOptions) {
      const now = Date.now()
      // 判据（v15）：零访问 + 久未「复习/回报」+ 复习已逾期（或本就未排期）。
      // 读 last_reviewed_at 而不是 last_accessed_at：后者在 v15 已拆成检索时钟，
      // 「常被检索命中」不该阻止衰减——那正是 access_count 要表达的信号。
      // COALESCE 回退 last_accessed_at：同一构造的旧库行（迁移前写入）仍有该值。
      const cutoff = now - options.olderThanDays * 86_400_000
      const reviewCutoff = now - (options.reviewGraceDays ?? DECAY_REVIEW_GRACE_DAYS) * 86_400_000
      // limit 缺省 = 全量（LIMIT -1 在 SQLite 表示不限制）。
      const limit = options.limit === undefined ? -1 : Math.max(1, Math.floor(options.limit))
      const candidates = sqlDecayCandidates.all(cutoff, reviewCutoff, limit) as unknown as { id: string }[]
      if (candidates.length === 0) return 0
      const ids = candidates.map(row => row.id)
      withTransaction(() => {
        sqlArchiveIds.run(JSON.stringify(ids))
        // 统一记一条 BATCH：逐条写 op_log 会让每日维护把日志灌爆（旧实现已是这个口径）。
        sqlLog.run(now, 'decay', 'BATCH', JSON.stringify({ archived: ids.length }))
      })
      return ids.length
    },

    async findContradictions(embedding: Float32Array, limit = 3) {
      const pool = db.prepare("SELECT * FROM nodes WHERE status = 'active' AND embedding IS NOT NULL AND scope IN ('user','project')").all() as unknown as NodeRow[]
      return pool
        .map(row => ({ row, sim: cosine(embedding, blobToVec(row.embedding!)) }))
        .filter(entry => entry.sim >= CONTRADICTION_COSINE)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit)
        .map(entry => rowToRecord(entry.row))
    },

    async listConflicts(scopes: readonly KyzmemScope[], limit: number): Promise<ConflictListResult> {
      const boundedLimit = Math.max(1, Math.floor(limit))
      // scope 集合以 JSON 数组传进 two json_each：动态占位符在这里没用，两端各要一次 IN 子查询。
      const scopeJson = JSON.stringify([...scopes])
      const total = (sqlConflictCount.get(scopeJson, scopeJson) as unknown as { n: number }).n
      const rows = sqlConflictEdges.all(scopeJson, scopeJson, boundedLimit) as unknown as
        { from_id: string; to_id: string; created_at: number }[]
      const items: ConflictPair[] = []
      for (const row of rows) {
        const leftRow = getRow(row.from_id)
        const rightRow = getRow(row.to_id)
        // 任一端缺失（手工删过节点/导入残留边）的冲突无从裁决，跳过而不是报错——
        // 面板轮询不该因为一条脏边整页失败。
        if (leftRow === undefined || rightRow === undefined) continue
        items.push({ left: rowToRecord(leftRow), right: rowToRecord(rightRow), createdAt: row.created_at })
      }
      return { items, total }
    },

    async resolveConflict(left: MemoryId, right: MemoryId, action: ConflictAction): Promise<void> {
      const at = Date.now()
      withTransaction(() => {
        // 两个方向都删：contradicts 语义上无向，写入侧可能任一方向建过边。
        sqlDeleteConflictEdge.run(String(left), String(right), String(right), String(left))
        // keep-*：输家归档（保留可审计）；drop-both：两端都归档；keep-both：只解除冲突标记。
        // 注意这里只置 status，不打 invalid_at——裁决不是「被取代」，历史条目在 asOf 视图中仍应可见。
        if (action === 'keep-left' || action === 'drop-both') sqlSetStatus.run('archived', String(right))
        if (action === 'keep-right' || action === 'drop-both') sqlSetStatus.run('archived', String(left))
        // 契约 §6：target=BATCH、detail={left,right,action}——面板「冲突裁决历史」的数据源。
        sqlLog.run(at, 'conflict-resolve', 'BATCH', JSON.stringify({ left: String(left), right: String(right), action }))
      })
    },

    async undoAutoBatch(batchId: string): Promise<UndoAutoBatchResult> {
      // 批次可能很旧：recentAudit 按 seq 倒序取，个人库量级下 10000 行足够覆盖自动动作全史。
      const rows = sqlAuditRecent.all('auto-action', 10000) as unknown as { detail: string | null }[]
      const restored: string[] = []
      const schedulesRestored: string[] = []
      const seenRestore = new Set<string>()
      let edgesRemoved = 0
      const at = Date.now()
      withTransaction(() => {
        for (const row of rows) {
          if (row.detail === null) continue
          let detail: {
            batchId?: unknown
            undo?: {
              restoreIds?: readonly unknown[]
              removeEdges?: readonly { from?: unknown; to?: unknown; type?: unknown }[]
              restoreSchedule?: readonly { id?: unknown; review?: {
                nextReviewAt?: unknown; easeFactor?: unknown; intervalDays?: unknown; reps?: unknown } }[]
            }
          }
          try {
            detail = JSON.parse(row.detail) as typeof detail
          } catch {
            continue
          }
          // 损坏的 detail 跳过：审计行是只写的历史，不能因为一条坏 JSON 让整个撤销失败。
          if (detail.batchId !== batchId || detail.undo === undefined) continue
          for (const rawId of detail.undo.restoreIds ?? []) {
            if (typeof rawId !== 'string' || seenRestore.has(rawId)) continue
            // 条目已被物理删除（purge）时跳过：撤销保证「回到动作前」，但保证不了「复活已删数据」。
            if (getRow(rawId) === undefined) continue
            sqlRestore.run(rawId)
            seenRestore.add(rawId)
            restored.push(rawId)
          }
          for (const edge of detail.undo.removeEdges ?? []) {
            if (typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.type !== 'string') continue
            const info = sqlDeleteEdge.run(edge.type, edge.from, edge.to, edge.to, edge.from)
            edgesRemoved += Number(info.changes)
          }
          for (const item of detail.undo.restoreSchedule ?? []) {
            if (typeof item.id !== 'string' || item.review === undefined) continue
            if (getRow(item.id) === undefined) continue
            const review = item.review
            // JSON 里 age 过的值只认数字：字符串/布尔一律回退缺省，避免把脏数写进排期。
            const nextReviewAt = typeof review.nextReviewAt === 'number' ? review.nextReviewAt : null
            const easeFactor = typeof review.easeFactor === 'number' ? review.easeFactor : 2.5
            const intervalDays = typeof review.intervalDays === 'number' ? review.intervalDays : 0
            const reps = typeof review.reps === 'number' ? review.reps : 0
            sqlRestoreSchedule.run(nextReviewAt, easeFactor, intervalDays, reps, item.id)
            schedulesRestored.push(item.id)
          }
        }
        sqlLog.run(at, 'auto-undo', 'BATCH', JSON.stringify({
          batchId, restored: restored.length, edgesRemoved, schedulesRestored: schedulesRestored.length,
        }))
      })
      return { restored, edgesRemoved, schedulesRestored }
    },

    async linkEdge(from: MemoryId, to: MemoryId, type: KyzmemEdgeType) {
      sqlEdgeUpsert.run(from, to, type, Date.now())
    },

    async nearestNeighbor(embedding: Float32Array) {
      // 与 findContradictions 同一池口径（active 且有向量的 user/project 行），不夹阈值、保留相似度。
      const pool = db.prepare("SELECT * FROM nodes WHERE status = 'active' AND embedding IS NOT NULL AND scope IN ('user','project')").all() as unknown as NodeRow[]
      let best: { row: NodeRow; sim: number } | undefined
      for (const row of pool) {
        const sim = cosine(embedding, blobToVec(row.embedding!))
        if (best === undefined || sim > best.sim) best = { row, sim }
      }
      return best === undefined ? undefined : { record: rowToRecord(best.row), similarity: best.sim }
    },

    async reinforce(id: MemoryId, note: string) {
      if (sqlGet.get(id) === undefined) return undefined
      sqlTouch.run(Date.now(), JSON.stringify([String(id)]))
      sqlLog.run(Date.now(), 'write-merge', id, note)
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async reinforceCitation(id: MemoryId, delta = 0.02): Promise<void> {
      // 证据引用强化：被 kyzmem_assess 当作 sufficient 证据引用过的条目，置信度小幅提升。
      // 只动 confidence——access_count/last_retrieved_at 是「被检索命中」的计数，
      // 把引用混进去会让 proof 因子与 recency 同时失真。id 缺失时静默（可能被并发删除）。
      sqlReinforceCitation.run(delta, id)
    },

    async markRetrieved(ids: readonly MemoryId[]): Promise<void> {
      if (ids.length === 0) return
      // 去重后一条批量 UPDATE（json_each）：只推进检索时钟 + 提 confidence，不动 access_count。
      // 场景：首问召回这类「只展示、未必被用」的路径——要留下 recency 痕迹，但不能让条目
      // 因为被展示过一次就逃出衰减候选（评审 M6）；真正被使用的强化走 search 的 touch。
      const unique = [...new Set(ids.map(String))]
      sqlMarkRetrieved.run(Date.now(), JSON.stringify(unique))
    },

    async listAnchors(limit: number) {
      const boundedLimit = Math.max(1, Math.floor(limit))
      const rows = sqlListAnchors.all(boundedLimit) as unknown as {
        id: string
        anchor_path: string
        anchor_hash: string
        anchor_checked_at: number | null
      }[]
      return rows.map(row => ({
        id: asMemoryId(row.id),
        // checked_at 理论上非空（写锚点与写路径同一条 INSERT）；老库/手工改库可能留空，
        // 用 0 表示「不知道上次何时校验」而不是把它当成 1970 年的时间戳去参与判断。
        anchor: { path: row.anchor_path, hash: row.anchor_hash, checkedAt: row.anchor_checked_at ?? 0 },
      }))
    },

    async supersedeMany(input: WriteInput, oldIds: readonly MemoryId[]) {
      // oldIds 为空时与 write 等价（insertRecord + 0 次归档循环），不走 this 引用。
      const content = input.content.trim()
      if (content === '') throw new KyzmemError('EMPTY_CONTENT', message('store.contentEmpty'))
      const id = asMemoryId(randomUUID())
      const at = Date.now()
      withTransaction(() => {
        // 蒸馏产物是新高层规律：与 write 同一套排桩/评分/排期自动化。
        const automationFields = applyWriteAutomation(input, id, at, input.imagery)
        insertRecord(id, { ...input, ...automationFields }, content, input.importance ?? 0.5, input.confidence ?? 0.5, at, input.sourceSessionId ?? null, input.embedding ?? null, input.imagery, 'distill')
        for (const oldId of oldIds) {
          // 蒸馏取代也是「失效」：置 archived + 打 invalid_at，时点检索才能还原蒸馏前的碎片态。
          sqlMarkInvalid.run(at, oldId)
          sqlEdgeUpsert.run(id, oldId, 'supersedes', at)
        }
      })
      return rowToRecord(sqlGet.get(id) as unknown as NodeRow)
    },

    async resolveEntities(mentions: readonly EntityMention[]): Promise<readonly EntityRecord[]> {
      if (mentions.length === 0) return []
      const at = Date.now()
      const result: EntityRecord[] = []
      withTransaction(() => {
        // 全量加载建归一化索引：实体词典量级为个人记忆库规模（百级），全表扫比逐名查询简单且够快。
        const byKey = new Map<string, EntityRecord>()
        for (const row of sqlEntityAll.all() as unknown as EntityRow[]) {
          const entity = entityRowToRecord(row)
          byKey.set(normalizeEntityName(entity.name), entity)
          for (const alias of entity.aliases) {
            const aliasKey = normalizeEntityName(alias)
            if (aliasKey !== '' && !byKey.has(aliasKey)) byKey.set(aliasKey, entity)
          }
        }
        for (const mention of mentions) {
          const name = mention.name.trim()
          if (name === '') throw new KyzmemError('EMPTY_ENTITY_NAME', message('store.entityNameEmpty'))
          const key = normalizeEntityName(name)
          const hit = byKey.get(key)
          if (hit !== undefined) {
            // 复用既有实体并刷新 updated_at：词典列表按「最近提及」倒序展示。
            sqlEntityTouch.run(at, hit.id)
            result.push(hit)
            continue
          }
          // 新建：别名去空去重；别名键若已被其他实体占用则不登记（first wins，不做合并）。
          const aliases = [...new Set((mention.aliases ?? []).map(a => a.trim()).filter(a => a !== ''))]
          const entity: EntityRecord = {
            id: asEntityId(randomUUID()),
            name,
            kind: mention.kind,
            aliases,
            createdAt: at,
            updatedAt: at,
          }
          sqlEntityInsert.run(entity.id, entity.name, entity.kind, JSON.stringify(aliases), at, at)
          byKey.set(key, entity)
          for (const alias of aliases) {
            const aliasKey = normalizeEntityName(alias)
            if (aliasKey !== '' && !byKey.has(aliasKey)) byKey.set(aliasKey, entity)
          }
          result.push(entity)
        }
      })
      return result
    },

    async linkNodeEntities(nodeId: MemoryId, entityIds: readonly EntityId[]) {
      withTransaction(() => {
        for (const entityId of entityIds) sqlNodeEntityInsert.run(String(nodeId), String(entityId))
      })
    },

    async entitiesOfNodes(nodeIds: readonly MemoryId[]): Promise<ReadonlyMap<MemoryId, readonly EntityRecord[]>> {
      const map = new Map<MemoryId, EntityRecord[]>()
      for (const nodeId of nodeIds) {
        const rows = sqlEntityByNode.all(String(nodeId)) as unknown as EntityRow[]
        if (rows.length > 0) map.set(nodeId, rows.map(entityRowToRecord))
      }
      return map
    },

    async listEntities(filter: EntityListFilter): Promise<EntityListResult> {
      const conditions: string[] = []
      const params: (string | number)[] = []
      if (filter.kind !== undefined) {
        conditions.push('kind = ?')
        params.push(filter.kind)
      }
      if (filter.q !== undefined && filter.q !== '') {
        // q 对 name 与 aliases_json（JSON 数组文本）做 LIKE 子串匹配；转义 LIKE 通配符。
        conditions.push("name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\'")
        const pattern = `%${filter.q.replace(/[\\%_]/g, c => `\\${c}`)}%`
        params.push(pattern, pattern)
      }
      const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM entities${where}`).get(...params) as unknown as { n: number }).n
      const rows = db.prepare(`SELECT * FROM entities${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, filter.limit, filter.offset) as unknown as EntityRow[]
      const counts = new Map<string, number>(
        (sqlEntityMemoryCounts.all() as unknown as { id: string; n: number }[]).map(r => [r.id, r.n]),
      )
      return {
        items: rows.map(row => ({ entity: entityRowToRecord(row), memoryCount: counts.get(row.id) ?? 0 })),
        total,
      }
    },

    async entityDetail(id: EntityId, memoryLimit: number): Promise<EntityDetail | undefined> {
      const row = sqlEntityGet.get(String(id)) as unknown as EntityRow | undefined
      if (row === undefined) return undefined
      const memories = (sqlEntityMemories.all(String(id), memoryLimit) as unknown as NodeRow[]).map(rowToRecord)
      return { entity: entityRowToRecord(row), memories }
    },

    async writeFacts(inputs: readonly FactWriteInput[]): Promise<readonly FactRecord[]> {
      const now = Date.now()
      return inputs.map(input => {
        const id = asFactId(randomUUID())
        const validAt = input.validAt ?? now
        withTransaction(() => {
          // 软失效链：replaces 指向存在的事实时才失效它（引用可能过期，过期按无取代写入）。
          if (input.replaces !== undefined
            && (sqlFactGet.get(String(input.replaces)) as unknown as FactRow | undefined) !== undefined) {
            sqlFactInvalidate.run(now, id, now, String(input.replaces))
          }
          sqlFactInsert.run(id, String(input.entityId), input.content, validAt,
            input.sourceNodeId === undefined ? null : String(input.sourceNodeId), now, now)
        })
        return {
          id,
          entityId: input.entityId,
          content: input.content,
          validAt,
          invalidAt: null,
          replacedBy: null,
          sourceNodeId: input.sourceNodeId ?? null,
          createdAt: now,
          updatedAt: now,
        }
      })
    },

    async factsOfEntity(filter: FactListFilter): Promise<FactListResult> {
      const conditions = ['entity_id = ?']
      const params: (string | number)[] = [String(filter.entityId)]
      // includeInvalid 优先于 asOf：全链视图本意就是展示完整历史（含失效链）。
      if (!filter.includeInvalid) {
        if (filter.asOf !== undefined) {
          conditions.push('valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)')
          params.push(filter.asOf, filter.asOf)
        } else {
          conditions.push('invalid_at IS NULL')
        }
      }
      const where = ` WHERE ${conditions.join(' AND ')}`
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM facts${where}`).get(...params) as unknown as { n: number }).n
      const rows = db.prepare(`SELECT * FROM facts${where} ORDER BY valid_at DESC LIMIT ? OFFSET ?`)
        .all(...params, filter.limit, filter.offset) as unknown as FactRow[]
      return { items: rows.map(factRowToRecord), total }
    },

    async createObservation(input: ObservationWriteInput): Promise<ObservationRecord> {
      const id = asObservationId(randomUUID())
      const now = Date.now()
      // 证据 id 去重（保留首次出现顺序）；空证据不允许建信念（调用方也应拦截，此处兜底 loud）。
      const sourceIds = [...new Set(input.sourceIds.map(String))].map(asMemoryId)
      if (sourceIds.length === 0) throw new KyzmemError('BAD_INPUT', message('store.observationEvidenceRequired'))
      const stored = input.embedding === undefined ? null : vecToBlob(input.embedding)
      withTransaction(() => {
        sqlObservationInsert.run(
          id, input.scope, input.belief, JSON.stringify(sourceIds.map(String)), sourceIds.length,
          stored, now, now, now,
        )
      })
      return {
        id,
        scope: input.scope,
        belief: input.belief,
        status: 'active',
        sourceIds,
        proofCount: sourceIds.length,
        createdAt: now,
        updatedAt: now,
        lastValidatedAt: now,
      }
    },

    async refineObservation(id: ObservationId, belief: string, addSourceIds: readonly MemoryId[], embedding?: Float32Array) {
      const existing = sqlObservationGet.get(String(id)) as unknown as ObservationRow | undefined
      if (existing === undefined) return undefined
      const merged = [...new Set([
        ...observationRowToRecord(existing).sourceIds.map(String),
        ...addSourceIds.map(String),
      ])].map(asMemoryId)
      const now = Date.now()
      const stored = embedding === undefined ? null : vecToBlob(embedding)
      withTransaction(() => {
        sqlObservationUpdate.run(
          belief, 'active', JSON.stringify(merged.map(String)), merged.length,
          stored, now, now, String(id),
        )
      })
      return observationRowToRecord(sqlObservationGet.get(String(id)) as unknown as ObservationRow)
    },

    async markObservationStale(id: ObservationId) {
      const existing = sqlObservationGet.get(String(id)) as unknown as ObservationRow | undefined
      if (existing === undefined) return undefined
      sqlObservationMarkStale.run(String(id))
      return observationRowToRecord(sqlObservationGet.get(String(id)) as unknown as ObservationRow)
    },

    async confirmObservation(id: ObservationId) {
      const existing = sqlObservationGet.get(String(id)) as unknown as ObservationRow | undefined
      if (existing === undefined) return undefined
      const now = Date.now()
      sqlObservationSetStatus.run('active', now, now, String(id))
      return observationRowToRecord(sqlObservationGet.get(String(id)) as unknown as ObservationRow)
    },

    async refuteObservation(id: ObservationId) {
      const existing = sqlObservationGet.get(String(id)) as unknown as ObservationRow | undefined
      if (existing === undefined) return undefined
      const now = Date.now()
      // refuted 是终态审计标记：updated_at 刷新（列表排序可察），last_validated_at 保留为上次成立时间。
      withTransaction(() => {
        sqlObservationRefute.run(now, String(id))
      })
      return observationRowToRecord(sqlObservationGet.get(String(id)) as unknown as ObservationRow)
    },

    async listObservations(filter: ObservationListFilter): Promise<readonly ObservationRecord[]> {
      const offset = Math.max(0, filter.offset ?? 0)
      if (filter.status === undefined) {
        const rows = db.prepare('SELECT * FROM observations ORDER BY proof_count DESC, updated_at DESC LIMIT ? OFFSET ?')
          .all(filter.limit, offset) as unknown as ObservationRow[]
        return rows.map(observationRowToRecord)
      }
      const rows = db.prepare('SELECT * FROM observations WHERE status = ? ORDER BY proof_count DESC, updated_at DESC LIMIT ? OFFSET ?')
        .all(filter.status, filter.limit, offset) as unknown as ObservationRow[]
      return rows.map(observationRowToRecord)
    },

    async nearestObservation(embedding: Float32Array) {
      const rows = sqlObservationActiveVectors.all() as unknown as ObservationRow[]
      let best: ObservationRow | undefined
      let bestSim = 0
      for (const row of rows) {
        if (row.embedding === null) continue
        const sim = cosine(embedding, blobToVec(row.embedding))
        if (sim > bestSim) {
          bestSim = sim
          best = row
        }
      }
      return best === undefined ? undefined : { record: observationRowToRecord(best), similarity: bestSim }
    },

    async audit(op: string, targetId: string, detail: string | null) {
      sqlLog.run(Date.now(), op, targetId, capDetail(detail))
    },

    async hasAudit(op: string, detail: string) {
      return sqlHasAudit.get(op, detail) !== undefined
    },

    async listAuditDetails(op: string) {
      return (sqlListAudit.all(op) as unknown as { detail: string }[]).map(row => row.detail)
    },

    async clearAudit(op: string, detail: string) {
      sqlClearAudit.run(op, detail)
    },

    async countAudit(op: string, since: number): Promise<number> {
      return (sqlCountAudit.get(op, since) as unknown as { n: number }).n
    },

    async recentAudit(op: string, limit: number, targetId?: string): Promise<OperationLogRow[]> {
      const boundedLimit = Math.max(1, Math.floor(limit))
      const rows = (targetId === undefined
        ? sqlAuditRecent.all(op, boundedLimit)
        : sqlAuditRecentByTarget.all(op, targetId, boundedLimit)) as unknown as
        { at: number; op: string; target_id: string; detail: string | null }[]
      return rows.map(row => ({ at: row.at, op: row.op, targetId: row.target_id, detail: row.detail }))
    },

    async lastAuditAt(op: string): Promise<number | undefined> {
      const row = sqlAuditLastAt.get(op) as unknown as { at: number | null } | undefined
      // MAX(at) 对空集合返回「一行 NULL」而不是「无行」，两种形态都要当成「没有记录」。
      return row === undefined || row.at === null ? undefined : row.at
    },

    async purgeOne(id: MemoryId): Promise<boolean> {
      const row = getRow(id)
      if (row === undefined) return false
      const at = Date.now()
      withTransaction(() => {
        // 先留审计再删行：op_log 不引用 nodes（无外键），删完仍可追溯「删过什么」。
        // 只记元信息不记正文——硬删的语义就是连内容都不留（与 forget 的 tombstone 相反）。
        sqlLog.run(at, 'tombstone', String(id), JSON.stringify({ kind: row.kind, scope: row.scope, chars: row.content.length }))
        sqlPurgeOneEdges.run(String(id), String(id))
        sqlPurgeOneNodeEntities.run(String(id))
        sqlPurgeOneRoute.run(String(id))
        sqlPurgeOneRevisions.run(String(id))
        sqlPurgeOneFts.run(String(id))
        sqlPurgeOneNode.run(String(id))
      })
      return true
    },

    async purge() {
      withTransaction(() => {
        sqlPurgeNodes.run()
        sqlPurgeEdges.run()
        sqlPurgeFts.run()
        sqlPurgeLog.run()
        sqlPurgeRoutes.run()
        sqlPurgeProfileBlocks.run()
        sqlPurgeProfileVersions.run()
        sqlPurgeSessionSummaries.run()
        sqlPurgeNodeEntities.run()
        sqlPurgeEntities.run()
        sqlPurgeFacts.run()
        sqlPurgeObservations.run()
        // 批零遗留漏项：修订表不清会让「清空后仍能从修订历史读出正文」。
        sqlPurgeRevisions.run()
      })
    },

    async close() {
      db.close()
    },
  }
}
