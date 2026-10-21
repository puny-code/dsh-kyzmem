/**
 * KyzmemStore：存储 Provider 的可替换接口（capability seam 的 Provider 角色）。
 * scope 分库由调用方持有多个实例（user 与 project 各一）。
 * @module dsh-kyzmem/store/interface
 */

import type {
  ConflictAction, ConflictListResult, DecayOptions, KyzmemEdgeType, KyzmemScope, EntityDetail, EntityId,
  EntityListFilter, EntityListResult, EntityMention, EntityRecord, EpisodeTimelineQuery, EpisodeTimelineResult,
  ExportData, FactListFilter, FactListResult, FactRecord, FactWriteInput,
  ForgettingTombstone, ForgottenAuditRow, ImportOptions, ImportPreview, ImportResult, ListFilter, ListResult,
  MemoryId, MemoryOutcome, MemoryRecord, ObservationId, ObservationListFilter, ObservationRecord,
  ObservationWriteInput, OperationLogRow, ProfileBlock, ProfileBlockVersion,
  ReviewGrade, ReviewView, SearchQuery, SearchResult, Slot, StoreStats, TimelineQuery, UpdateInput, WriteInput,
} from '../types.ts'

/** 一个房间的占用状态（slotCountsByRoom 的行）。 */
export interface RoomState {
  /** 已占用桩位数（forgotten 除外——软删即刻腾位）。 */
  readonly count: number
  /** 当前最大桩位序号（含空桩，决定下一个分配的序号）。 */
  readonly maxIndex: number
}

/** 门牌快照行：房间名 + caption（门牌评分的唯一性/差异化上下文）。 */
export interface PlacardRow {
  readonly room: string | null
  readonly caption: string
}

/** 固定巡游路线的一站。 */
export interface RouteStop {
  readonly position: number
  readonly id: MemoryId
}

/** 存储接口。所有方法在库不可用时抛 KyzmemError。 */
export interface KyzmemStore {
  /** 追加一条 active 记忆，content 非空。 */
  write(input: WriteInput): Promise<MemoryRecord>
  /** 按 id 取条目（任意状态）；不存在返回 undefined。 */
  get(id: MemoryId): Promise<MemoryRecord | undefined>
  /**
   * 渐进式披露：按 id 批量拉取条目，保留输入顺序，去重；缺 id 静默跳过。
   * 用于 kyzmem_examine 等「先看门牌号再选进几间」场景。
   */
  getMany(ids: readonly MemoryId[]): Promise<MemoryRecord[]>
  /**
   * 走廊：从 id 出发走 related/supersedes/contradicts 走廊边，depth 跳内返回
   * 全部可到的邻居记忆（不含起点本身，去重）。无邻居返回空数组。
   */
  neighbors(id: MemoryId, depth: number): Promise<MemoryRecord[]>
  /**
   * 混合检索（向量 + FTS5 + 一跳扩展）。命中强化：accessCount+1、confidence+0.05（封顶 1）。
   * @param queryVector - 查询向量；undefined 表示嵌入不可用（结果 degraded）。
   */
  search(query: SearchQuery, queryVector: Float32Array | undefined): Promise<SearchResult>
  /** 时间线查询：缺省按 createdAt 倒序，order='tour' 时按固定巡游路线桩位顺序。 */
  timeline(query: TimelineQuery): Promise<MemoryRecord[]>
  /**
   * episode 情景记忆独立时间线：按日期范围/来源会话过滤 episode 条目并按会话分组；
   * query.around 指定时切换为时间邻近扩展（锚点不存在抛 KyzmemError(NOT_FOUND)）。
   */
  episodeTimeline(query: EpisodeTimelineQuery): Promise<EpisodeTimelineResult>
  /** 写入会话一句话摘要（upsert，摄取期会话循环结束处调用；op_log 记 'session-summary'）。 */
  setSessionSummary(sessionId: string, summary: string): Promise<void>
  /** 读取会话摘要；未生成过返回 undefined。 */
  getSessionSummary(sessionId: string): Promise<string | undefined>
  /** 修正：旧条目转 archived，建立 supersedes 边（from=新，to=旧），返回新条目。 */
  update(input: UpdateInput): Promise<MemoryRecord>
  /** 软删（可恢复）。 */
  forget(id: MemoryId): Promise<MemoryRecord>
  /**
   * 闭馆仪式：与 forget 等价的软删，但要求留下墓志铭（闭馆三问答案）写入 op_log。
   * 墓志铭用于 kyzmem_audit_forgotten 考古：事后能说清「为什么关 / 影响谁 / 还有用吗」。
   */
  forgetWithTombstone(id: MemoryId, tombstone: ForgettingTombstone): Promise<MemoryRecord>
  /** 闭馆考古视图：forgotten 条目 + 墓志铭（来自 op_log），按闭馆时间倒序。 */
  listForgottenWithTombs(limit: number): Promise<readonly ForgottenAuditRow[]>
  /** 回报使用效果（奖励信号）：success 提权 confidence+0.05，failure 降权 confidence-0.1（夹逼 0-1）；返回更新后条目，id 不存在返回 undefined。 */
  reportOutcome(id: MemoryId, outcome: MemoryOutcome): Promise<MemoryRecord | undefined>
  /** SM-2 复习答题：按回忆质量推进调度（间隔/ease/reps），返回更新后条目，id 不存在返回 undefined。 */
  scheduleReview(id: MemoryId, grade: ReviewGrade): Promise<MemoryRecord | undefined>
  /** 今日待回忆队列：active 且已到期的条目，按到期时间升序（最逾期在前）。 */
  dueReviews(now: number, limit: number): Promise<MemoryRecord[]>
  /** 各房间占用状态快照（排桩分配的输入）。 */
  slotCountsByRoom(): Promise<Record<string, RoomState>>
  /** 给条目钉桩位（房间 + 序号），记 op_log。 */
  assignSlot(id: MemoryId, slot: Slot): Promise<void>
  /**
   * 存量排桩：为全部 active 且未排桩的条目按 kind 分房、created_at 定序钉桩，
   * 并补登记巡游路线；幂等（只处理 slot_room 为空的行），返回排桩条数。
   * @param capacityNote - 开新房时的回调（调用方记 op_log 提醒人工命名）。
   */
  backfillSlots(capacityNote: (room: string) => void): Promise<number>
  /** 把条目追加到固定巡游路线末尾（位置只增，骨架长期复用）。 */
  routeAppend(id: MemoryId): Promise<void>
  /** 条目是否已在巡游路线上。 */
  routeHas(id: MemoryId): Promise<boolean>
  /** 固定巡游路线全程（按位置升序；已归档/遗忘的站点由渲染层跳过）。 */
  routeList(): Promise<RouteStop[]>
  /** 门牌快照：全库 active 条目的 (房间, caption) 列表（门牌评分上下文）。 */
  listPlacards(): Promise<PlacardRow[]>
  /** 画像 curated block 当前态；该 scope 从未编辑过返回 undefined。 */
  getProfileBlock(scope: KyzmemScope): Promise<ProfileBlock | undefined>
  /**
   * 写入画像 curated block（乐观锁）：expectedVersion 与当前版本一致才写入并产生
   * 新版本（版本链追加，回滚与编辑同构）；expectedVersion 为 undefined 仅允许首次创建。
   * @throws KyzmemError(code=VERSION_CONFLICT) 版本不匹配（并发编辑）或库已有 block 而未带版本。
   */
  saveProfileBlock(scope: KyzmemScope, expectedVersion: number | undefined, content: string, source: ProfileBlockVersion['source']): Promise<ProfileBlock>
  /** 画像 block 版本历史（按版本号倒序，最多 limit 条）。 */
  listProfileBlockVersions(scope: KyzmemScope, limit: number): Promise<ProfileBlockVersion[]>
  /** 取某一版本的画像 block 内容（rollback 数据源）；不存在返回 undefined。 */
  getProfileBlockVersion(scope: KyzmemScope, version: number): Promise<ProfileBlockVersion | undefined>
  /** 从 archived/forgotten 恢复为 active。 */
  restore(id: MemoryId): Promise<MemoryRecord>
  /** 画像注入/蒸馏取材：指定 scope 的 active 条目按 importance、confidence 倒序取前 n。 */
  topActive(scope: KyzmemScope, n: number): Promise<MemoryRecord[]>
  /** 管理列表：按 scope/status/kind/子串过滤的分页视图（含全部状态），附总数。 */
  list(filter: ListFilter): Promise<ListResult>
  /** 审计视图：条目 + supersedes/contradicts/related 邻居 + 修订历史 + 最近操作日志。 */
  review(id: MemoryId): Promise<ReviewView | undefined>
  /** 最近操作日志（全库，时间倒序；管理面板活动视图用）。 */
  recentOps(limit: number): Promise<OperationLogRow[]>
  /** 全库统计。 */
  stats(): Promise<StoreStats>
  /** 全库导出（任意状态条目 + 全部边），数据可携带。 */
  exportAll(): Promise<ExportData>
  /**
   * 导入预览：对导出数据逐条分类（不写库）。分类规则：id 已存在且内容全等 → duplicate；
   * id 已存在但内容不同 → conflict；id 空闲但内容与库内某条全等 → duplicate；
   * 其余 → new。边按「端点 ∈ 库内 ∪ 导入集」计悬挂数；实体按 id 计新建/合并数。
   */
  importPreview(data: ExportData): Promise<ImportPreview>
  /**
   * 导入：写库版 importPreview 的分类规则。new 直接导入（保留导出侧 id 与全部字段，向量置空）；
   * duplicate 默认跳过（keepDuplicates=true 且 id 空闲时放行）；conflict 一律跳过并计数。
   * 边只连双端可落地的（幂等 upsert），悬挂边丢弃计数；实体按 id 合并（别名并集）。
   * 全程单事务，op_log 记一条 'import' BATCH。
   */
  importData(data: ExportData, options?: ImportOptions): Promise<ImportResult>
  /**
   * 批量回填既有条目的向量（导入后补嵌入、存量修复共用原语）。
   * 只更新已存在行；返回实际更新条数。
   */
  attachEmbeddings(entries: readonly { readonly id: MemoryId; readonly embedding: Float32Array }[]): Promise<number>
  /**
   * 批量读已有向量（维护/整理复用）：只回 embedding 非空的条目，调用方对缺口再算。
   * 没有这个方法时整理会退化成整批重算——成本差几十倍。
   */
  embeddingsFor(ids: readonly string[]): Promise<ReadonlyMap<string, Float32Array>>
  /** 衰减：满足条件的 active 条目转 archived，返回归档数量。 */
  decay(options: DecayOptions): Promise<number>
  /** 矛盾候选：与给定向量余弦 ≥ 0.88 的同库 active 条目（调用方裁决后用 linkEdge 建边）。 */
  findContradictions(embedding: Float32Array, limit?: number): Promise<MemoryRecord[]>
  /** 建立一条关系边（幂等）。 */
  linkEdge(from: MemoryId, to: MemoryId, type: KyzmemEdgeType): Promise<void>
  /**
   * 待裁决冲突列表（schema v15 批一）：contradicts 边两端记录，两端任为 active/archived 均可
   * （归档条目可能正是上一轮裁决留下的输家，仍要给面板看）。created_at 倒序，total 为过滤后总数。
   */
  listConflicts(scopes: readonly KyzmemScope[], limit: number): Promise<ConflictListResult>
  /**
   * 裁决一对冲突：删掉两端之间的 contradicts 边（双向）；keep-left/keep-right 额外把另一端
   * 置 archived，drop-both 两端都 archived，keep-both 只解除冲突标记。写一条 op_log
   * 'conflict-resolve'（target=BATCH，detail={left,right,action}）供面板回看裁决历史。
   */
  resolveConflict(left: MemoryId, right: MemoryId, action: ConflictAction): Promise<void>
  /** 最近邻：同库 active（user/project 行）中与给定向量余弦最高的条目及相似度；空库或无向量条目返回 undefined。 */
  nearestNeighbor(embedding: Float32Array): Promise<{ record: MemoryRecord; similarity: number } | undefined>
  /**
   * 并入强化：新内容被判为既有条目的复述（写入四态的 MERGE）时调用——accessCount+1、
   * confidence+0.05（与检索命中强化同幅），并记一条 write-merge 审计行（detail 为调用方给的 JSON 说明）。
   * @returns 强化后的条目；id 不存在返回 undefined。
   */
  reinforce(id: MemoryId, note: string): Promise<MemoryRecord | undefined>
  /**
   * 证据引用强化（schema v15）：被下游当作证据引用过的条目，confidence 提升 delta（缺省 0.02）。
   * 只动 confidence——access_count/last_retrieved_at 属于「被检索命中」的语义，混入会让
   * proof 因子与衰减判据同时失真。id 不存在时静默（引用可能来自并发删除）。
   */
  reinforceCitation(id: MemoryId, delta?: number): Promise<void>
  /** 蒸馏写入原语：单事务内写新条目、归档全部旧条目并逐条建立 supersedes 边。 */
  supersedeMany(input: WriteInput, oldIds: readonly MemoryId[]): Promise<MemoryRecord>
  /**
   * 实体消解：提及按归一化名（trim + 压缩空白 + 小写）与既有实体的 name/aliases 精确
   * 匹配，未命中新建；返回与提及同序的实体列表。第一版不做相似度合并。
   */
  resolveEntities(mentions: readonly EntityMention[]): Promise<readonly EntityRecord[]>
  /** 关联记忆与实体（幂等；id 不校验存在性——调用方只传 resolveEntities 的产出）。 */
  linkNodeEntities(nodeId: MemoryId, entityIds: readonly EntityId[]): Promise<void>
  /** 批量取各记忆关联的实体；无关联的记忆不出现在结果 Map 中。 */
  entitiesOfNodes(nodeIds: readonly MemoryId[]): Promise<ReadonlyMap<MemoryId, readonly EntityRecord[]>>
  /** 实体词典分页列表（updated_at 倒序），memoryCount 只统计 active 关联。 */
  listEntities(filter: EntityListFilter): Promise<EntityListResult>
  /** 实体详情：实体 + 关联 active 记忆（创建时间倒序，至多 memoryLimit 条）；id 不存在返回 undefined。 */
  entityDetail(id: EntityId, memoryLimit: number): Promise<EntityDetail | undefined>
  /**
   * 批量写入事实（schema v11）：每条独立落库。输入声明 replaces 且目标事实存在时，
   * 目标置 invalid_at = now 并回指 replaced_by = 新事实 id（软失效，历史链保留）；
   * replaces 指向不存在的 id 时按无取代写入（不失败——摄取/工具路径的引用可能过期）。
   * 不校验 entityId 存在性（调用方只传 resolveEntities 的产出）。
   */
  writeFacts(inputs: readonly FactWriteInput[]): Promise<readonly FactRecord[]>
  /** 事实链查询：按实体取事实；asOf 时点过滤，includeInvalid 展开全链（valid_at 倒序，附总数）。 */
  factsOfEntity(filter: FactListFilter): Promise<FactListResult>
  /**
   * 新建巩固信念（observation，schema v12）：sourceIds 至少 1 条；初始 status=active，
   * proofCount=源去重数，created/updated/lastValidated 均取当前时刻。不校验源记忆存在性
   * （调用方只传取材集产出的 id）。
   */
  createObservation(input: ObservationWriteInput): Promise<ObservationRecord>
  /**
   * 细化既有信念：belief 替换为新表述，sourceIds 与旧证据并集去重、proofCount 重算，
   * status 回 active、updated/lastValidated 刷新；embedding 给定时替换。
   * id 不存在返回 undefined。
   */
  refineObservation(id: ObservationId, belief: string, addSourceIds: readonly MemoryId[], embedding?: Float32Array): Promise<ObservationRecord | undefined>
  /** 标记待复核：status 置 stale（有未纳入的近邻新证据），时间戳不动；id 不存在返回 undefined。 */
  markObservationStale(id: ObservationId): Promise<ObservationRecord | undefined>
  /** 复核维持：status 回 active 并刷新 lastValidated（证据仍成立、表述不变）；id 不存在返回 undefined。 */
  confirmObservation(id: ObservationId): Promise<ObservationRecord | undefined>
  /** 复核否定：status 置 refuted（不再注入，保留证据链供审计）；id 不存在返回 undefined。 */
  refuteObservation(id: ObservationId): Promise<ObservationRecord | undefined>
  /** 信念列表：可按状态过滤；排序 proof_count 倒序、updated_at 倒序（强证据、新近巩固在前）。 */
  listObservations(filter: ObservationListFilter): Promise<readonly ObservationRecord[]>
  /**
   * 信念近邻：同库 active/stale 信念中与给定向量余弦最高者及相似度；空库、无向量信念
   * 或嵌入不可用返回 undefined。refuted 信念不参与归并。
   */
  nearestObservation(embedding: Float32Array): Promise<{ record: ObservationRecord; similarity: number } | undefined>
  /** 写入一条结构化审计记录（辅助 LLM 请求等，不进会话日志——下游插件禁止写未知事件类型）。 */
  audit(op: string, targetId: string, detail: string | null): Promise<void>
  /** 幂等键查重：op_log 中是否已存在指定 op+detail 的记录。 */
  hasAudit(op: string, detail: string): Promise<boolean>
  /** 列出指定 op 的全部 detail（按写入顺序；pending 队列枚举用）。 */
  listAuditDetails(op: string): Promise<string[]>
  /** 清除指定 op+detail 的全部记录（pending 队列出队）。 */
  clearAudit(op: string, detail: string): Promise<void>
  /** 统计某 op 在 since（epoch 毫秒，含）之后的条数（schema v15 减载档的欠账计量）。 */
  countAudit(op: string, since: number): Promise<number>
  /** 某 op 的最近记录（时间倒序至多 limit 条）；targetId 给定时只取该目标的记录。 */
  recentAudit(op: string, limit: number, targetId?: string): Promise<OperationLogRow[]>
  /** 某 op 最近一次写入时刻（epoch 毫秒）；从未写过返回 undefined（欠账「上次跑过没」）。 */
  lastAuditAt(op: string): Promise<number | undefined>
  /**
   * 单条硬删（schema v15 面板「彻底删除」）：nodes + nodes_fts + nodes_revisions + 全部边
   * （两个方向）+ 实体关联 + 巡游路线站点，单事务内完成；删前写一条 op_log 'tombstone'
   * （只记 kind/scope/chars，不记正文——硬删的语义就是连内容都不留）。
   * @returns 该 id 原本存在并被删除返回 true；不存在返回 false。
   */
  purgeOne(id: MemoryId): Promise<boolean>
  /** 物理清除本库全部数据（节点、边、FTS、修订、操作日志）。 */
  purge(): Promise<void>
  /** 关闭数据库句柄。 */
  close(): Promise<void>
}
