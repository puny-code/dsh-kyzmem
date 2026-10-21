/**
 * dsh-kyzmem 词汇表：记忆条目、关系边、查询与错误。
 * @module dsh-kyzmem/types
 */

/** 品牌化记忆 id：跨工具与存储边界的 id 一律此类型，拒绝裸 string。 */
declare const memoryIdBrand: unique symbol
export type MemoryId = string & { readonly [memoryIdBrand]: true }

/** 从任意字符串铸造品牌化 id（存储层入库前调用）。 */
export function asMemoryId(raw: string): MemoryId {
  return raw as MemoryId
}

/** 品牌化实体 id：实体词典主键，跨工具与存储边界拒绝裸 string。 */
declare const entityIdBrand: unique symbol
export type EntityId = string & { readonly [entityIdBrand]: true }

/** 从任意字符串铸造品牌化实体 id（存储层入库前调用）。 */
export function asEntityId(raw: string): EntityId {
  return raw as EntityId
}

/** 品牌化事实 id：事实链主键，跨工具与存储边界拒绝裸 string。 */
declare const factIdBrand: unique symbol
export type FactId = string & { readonly [factIdBrand]: true }

/** 从任意字符串铸造品牌化事实 id（存储层入库前调用）。 */
export function asFactId(raw: string): FactId {
  return raw as FactId
}

/** 品牌化信念 id：自动巩固产物（observation）主键，跨工具与存储边界拒绝裸 string。 */
declare const observationIdBrand: unique symbol
export type ObservationId = string & { readonly [observationIdBrand]: true }

/** 从任意字符串铸造品牌化信念 id（存储层入库前调用）。 */
export function asObservationId(raw: string): ObservationId {
  return raw as ObservationId
}

/** 记忆作用域：user 私人宫殿；project 项目宫殿；shared 跨 agent 共享宫殿（公开可读）。 */
export type KyzmemScope = 'user' | 'project' | 'shared'

/** 是否为公开可读的 shared scope。 */
export function isSharedScope(scope: KyzmemScope): boolean {
  return scope === 'shared'
}

/** 记忆种类：fact 事实 / preference 偏好 / decision 决策 / episode 经历 / skill 方法。 */
export type KyzmemKind = 'fact' | 'preference' | 'decision' | 'episode' | 'skill'

/** 条目状态：active 参与检索；archived（衰减/被取代）不参与检索、可恢复；forgotten 软删、可恢复。 */
export type KyzmemStatus = 'active' | 'archived' | 'forgotten'

/**
 * 来源分级（schema v15，R4）：谁说的这条记忆。
 * user-confirmed = 用户明确确认（面板/工具显式确认）；agent-inferred = 模型从对话推断；
 * tool-output = 从工具输出/命令结果抄来的（易被伪造，默认不进画像）；web-content = 网页抓取（同前）。
 */
export type KyzmemSourceTier = 'user-confirmed' | 'agent-inferred' | 'tool-output' | 'web-content'

/** 全部合法来源分级（配置校验/面板过滤用）。 */
export const SOURCE_TIERS: readonly KyzmemSourceTier[] = ['user-confirmed', 'agent-inferred', 'tool-output', 'web-content']

/** 是否为默认参与画像注入的分级（用户确认 + 模型推断；工具输出/网页内容须显式确认）。 */
export function isTrustedTier(tier: KyzmemSourceTier | undefined): boolean {
  return tier === undefined || tier === 'user-confirmed' || tier === 'agent-inferred'
}

/** 关系边类型。supersedes 语义：from 取代 to。 */
export type KyzmemEdgeType = 'supports' | 'contradicts' | 'refines' | 'related' | 'supersedes'

/** 记忆使用效果（奖励信号）：success 用后有效提权，failure 用后无效降权；缺省未验证。 */
export type MemoryOutcome = 'success' | 'failure'

/** 感官印记五维：味/声/触/色/温。古典记忆术要求意象挂上感官钩以提高召回。 */
export type SensoryChannel = 'taste' | 'sound' | 'touch' | 'sight' | 'temperature'
/** 单个感官铭牌（如「海腥」「钟声回响」「粗麻布」「深绛红」「金属凉」）。 */
export type SensoryToken = string
/** 情绪强度：0-1，借鉴情绪记忆抗遗忘曲线——高强度优先参与巡游。 */
export type EmotionalValence = number

/** 意象铭牌：把抽象条目映射到一个具象挂念（「沾墨竹简」而非「用户偏好」）。古典记忆术核心：越具体越记得住。 */
export interface ImageryLabel {
  /** 一句具象描述（≤30 字），如「沾墨竹简」「落雨铜铃」。缺省 = null = 未铭刻。 */
  readonly caption: string | null
  /** 感官挂念列表（每条对应 SensoryChannel 之一，可选多维同感）。 */
  readonly sensoryTags: readonly SensoryToken[]
  /** 情感权重 0-1，0 表示中性陈述。 */
  readonly emotionalValence: EmotionalValence
  /** 是否由 LLM 推测生成（true = 候选铭牌，用户未确认）。 */
  readonly provisional: boolean
}

/** 桩位：记忆在宫殿中的固定位置（房间名 + 房内序号）。地点法核心——位置固定，巡游顺序才稳定。 */
export interface Slot {
  /** Идентификатор комнаты (по умолчанию по kind: fact/preference/decision/episode/skill; при заполнении открывается «<id>-2»). Имя для показа берётся из словаря языка — в данных языка нет. */
  readonly room: string
  /** 房内桩位序号（从 1 起）。 */
  readonly index: number
}

/** 回忆质量自评（SM-2）：0 完全遗忘 … 5 完美回忆；≥3 算通过。 */
export type ReviewGrade = 0 | 1 | 2 | 3 | 4 | 5

/** 间隔重复调度状态（SM-2 简版）。进入调度的条目不参与自动衰减，由复习结果决定命运。 */
export interface ReviewSchedule {
  /** 下次到期时间（epoch 毫秒）；null = 未排期（存量条目默认）。 */
  readonly nextReviewAt: number | null
  /** 难度系数（SM-2 ease，下限 1.3，初始 2.5）。 */
  readonly easeFactor: number
  /** 当前间隔天数。 */
  readonly intervalDays: number
  /** 连续通过次数（失败清零）。 */
  readonly reps: number
}

/** 一条记忆。来源链：v0.0.1 记 sourceSessionId；v0.2.0 起自动摄取补 sourceRound/sourceSeq。 */
export interface MemoryRecord {
  readonly id: MemoryId
  readonly scope: KyzmemScope
  readonly kind: KyzmemKind
  readonly content: string
  /** 0-1：重要性，影响注入排序与衰减调度。 */
  readonly importance: number
  /** 0-1：置信度，命中强化提升、蒸馏失败回退。 */
  readonly confidence: number
  readonly status: KyzmemStatus
  /** 最近一次使用效果回报（kyzmem_report 写入；未回报过为 undefined）。 */
  readonly outcome?: MemoryOutcome
  readonly createdAt: number
  readonly lastAccessedAt: number
  readonly accessCount: number
  readonly sourceSessionId: string | null
  /** 来源会话内轮次（自动摄取写入；显式保存为 null）。 */
  readonly sourceRound: number | null
  /** 来源事件 seq（自动摄取写入；显式保存为 null）。 */
  readonly sourceSeq: number | null
  /** 意象铭牌（schema v5 起；未铭刻时缺省）。 */
  readonly imagery?: ImageryLabel
  /** 桩位（schema v6 起；未排桩时缺省）。 */
  readonly slot?: Slot
  /** 意象质量分 0-1（schema v6 起，save 时启发式落库；未评分时缺省）。 */
  readonly imageryScore?: number
  /** 间隔重复调度（schema v6 起；未进入调度时缺省）。 */
  readonly review?: ReviewSchedule
  /** 失效时刻（schema v15 起）：被取代/更新时打点，检索默认过滤；缺省 = 仍有效。 */
  readonly invalidAt?: number
  /** 过期时刻（schema v15 起，TTL）：缺省 = 永不过期；过期条目降权不硬过滤。 */
  readonly expiresAt?: number
  /** 来源分级（schema v15 起）；缺省视为 agent-inferred。 */
  readonly sourceTier?: KyzmemSourceTier
  /** 最近一次被检索命中时刻（schema v15 拆时钟）；缺省回退 lastAccessedAt。 */
  readonly lastRetrievedAt?: number
  /** 最近一次复习/效果回报时刻（schema v15 拆时钟）；缺省回退 lastAccessedAt。 */
  readonly lastReviewedAt?: number
}

/** 记忆关系边。 */
export interface MemoryEdge {
  readonly from: MemoryId
  readonly to: MemoryId
  readonly type: KyzmemEdgeType
  readonly createdAt: number
}

/** 实体类别：LLM 从记忆内容中抽取的提及对象归类。 */
export type KyzmemEntityKind = 'person' | 'project' | 'tool' | 'concept' | 'other'

/** 归一化比较键：trim + 合并连续空白 + 小写（消解第一版只做精确归一匹配，不做相似合并）。 */
export function normalizeEntityName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 一条实体：从记忆中抽取的命名对象（人/项目/工具/概念），随来源记忆所在 scope 分库。 */
export interface EntityRecord {
  readonly id: EntityId
  /** 规范名（首次创建时的写法）。 */
  readonly name: string
  readonly kind: KyzmemEntityKind
  /** 别名列表（含规范名变体；消解时与 name 同权参与归一匹配）。 */
  readonly aliases: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** 实体提及：LLM 抽取输出中的单个候选（写入路径消解为既有实体或新建）。 */
export interface EntityMention {
  readonly name: string
  readonly kind: KyzmemEntityKind
  /** 提及的别名（缺省无别名）。 */
  readonly aliases?: readonly string[]
}

/** 事实提及：LLM 抽取输出中的单条事实候选（entity 须为同批实体提及出现过的实体名）。 */
export interface FactMention {
  readonly entity: string
  readonly content: string
}

/** 管理列表过滤条件（实体词典面板用）。 */
export interface EntityListFilter {
  readonly kind?: KyzmemEntityKind
  /** name 与 aliases_json 的子串匹配（大小写不敏感）。 */
  readonly q?: string
  readonly limit: number
  readonly offset: number
}

/** 实体列表行：实体 + 关联 active 记忆数（排序与规模展示用）。 */
export interface EntityListItem {
  readonly entity: EntityRecord
  readonly memoryCount: number
}

/** 实体列表结果（updated_at 倒序，附总数）。 */
export interface EntityListResult {
  readonly items: readonly EntityListItem[]
  readonly total: number
}

/** 实体详情：实体自身 + 关联的 active 记忆（创建时间倒序）。 */
export interface EntityDetail {
  readonly entity: EntityRecord
  readonly memories: readonly MemoryRecord[]
}

/** 一条事实：挂在实体上的一句话陈述，带有效时间窗与软失效链（schema v11）。 */
export interface FactRecord {
  readonly id: FactId
  readonly entityId: EntityId
  /** 事实陈述（一句话）。 */
  readonly content: string
  /** 事实开始有效的时刻（ms）。 */
  readonly validAt: number
  /** 被取代时刻（ms）；null = 仍有效。 */
  readonly invalidAt: number | null
  /** 取代本事实的后继事实 id；未被取代时 null。 */
  readonly replacedBy: FactId | null
  /** 抽出该事实的来源记忆 id；工具直写时缺省 null。 */
  readonly sourceNodeId: MemoryId | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** 事实写入请求：entityId 须为同库实体；replaces 声明取代的既有事实（目标不存在则按无取代写入）。 */
export interface FactWriteInput {
  readonly entityId: EntityId
  readonly content: string
  readonly replaces?: FactId
  readonly sourceNodeId?: MemoryId
  /** 事实开始有效时刻（ms）；缺省取当前时间。 */
  readonly validAt?: number
}

/** 事实链查询：按实体过滤；asOf 限定时间点视角，includeInvalid 展开全链。 */
export interface FactListFilter {
  readonly entityId: EntityId
  /** 时点查询：返回该时刻仍有效的事实（valid_at <= asOf 且 invalid_at 为 null 或 > asOf）。 */
  readonly asOf?: number
  /** true 时不过滤失效，返回全部历史链（含失效事实及其 replacedBy 回指）。 */
  readonly includeInvalid?: boolean
  readonly limit: number
  readonly offset: number
}

/** 事实链结果（valid_at 倒序，附总数）。 */
export interface FactListResult {
  readonly items: readonly FactRecord[]
  readonly total: number
}

/** 写入请求。可选数值字段缺省时由存储层取默认（不显式传 undefined）。 */
export interface WriteInput {
  readonly scope: KyzmemScope
  readonly kind: KyzmemKind
  readonly content: string
  readonly importance?: number
  readonly confidence?: number
  readonly sourceSessionId?: string | null
  readonly sourceRound?: number
  readonly sourceSeq?: number
  /** 内容向量（调用方经嵌入器算好）；缺省时该条目不参与向量检索。 */
  readonly embedding?: Float32Array
  /** 意象铭牌（schema v5 起；缺省表示未铭刻）。 */
  readonly imagery?: ImageryLabel
  /** 意象质量分（调用方经 scoreImagery 算好落库；缺省不写入）。 */
  readonly imageryScore?: number
  /** 桩位（调用方经排桩逻辑分配；缺省表示未排桩）。 */
  readonly slot?: Slot
  /** 初始复习排期：毫秒时间戳 = 指定首次到期；null = 明确不进入复习调度（历史回填用，
   *  避免一次性回填的条目同时涌入今日复习队列）；缺省 = 由写入期自动化决定。 */
  readonly initialReviewAt?: number | null
  /** 过期时刻（schema v15 TTL）；缺省 = 由写入期按 kind 的 TTL 自动计算（0 天 = 不过期）。 */
  readonly expiresAt?: number
  /** 来源分级（schema v15）；缺省 = agent-inferred。 */
  readonly sourceTier?: KyzmemSourceTier
}

/** 检索请求。 */
export interface SearchQuery {
  readonly text: string
  readonly scopes: readonly KyzmemScope[]
  readonly limit?: number
  /**
   * 房间路由（schema v6 起）：只在指定房间内检索（走廊索引——先决定进哪个房间）。
   * 缺省全库检索；未排桩（slot_room 为空）的条目不属于任何房间，指定 rooms 时不出现。
   */
  readonly rooms?: readonly string[]
  /** 时点检索（schema v15）：只看该时刻仍有效的条目（created_at <= asOf 且未失效）。 */
  readonly asOf?: number
  /**
   * 命中强化开关（默认 true）：false 时只检索、不写 access_count/confidence/last_retrieved_at。
   * 首问自动召回、预检这类「可能不注入」的检索必须传 false——否则没被用到的候选也会被
   * 记成「用过」，既污染 proof 因子又让它们永久逃过衰减（评审 M6）。
   */
  readonly touch?: boolean
  /**
   * 写入 op_log 的 recall 审计 mode（默认 'search'）。自动召回用独立值（如 'query-recall'），
   * 面板指标才能把「工具检索」与「首问推送」分开统计（评审 M4）。
   */
  readonly auditMode?: string
  /**
   * recall 审计里查询文本的记录方式（默认 'raw'，保持既有行为）：
   * 'hash' 只存 sha256 的 16 位前缀（隐私：首问原文可能是密钥/隐私文本，评审 M5）；
   * 'none' 完全不记查询文本。
   */
  readonly auditQuery?: 'raw' | 'hash' | 'none'
}

/** 一条检索命中。 */
export interface SearchHit {
  readonly record: MemoryRecord
  /** 融合得分（RRF），越高越相关。 */
  readonly score: number
  /** 该条命中的贡献道：fts 关键词 / vec 语义 / both / graph 经关系边一跳扩展引入。 */
  readonly via: 'fts' | 'vec' | 'both' | 'graph'
  /** 经关系边一跳扩展引入时，来源条目 id 与边类型。 */
  readonly viaEdge?: { readonly from: MemoryId; readonly type: KyzmemEdgeType }
  /** 编码特异性线索（schema v6 起）：同房间相邻桩位的条目 id——提取时重建编码情境。 */
  readonly cues?: {
    readonly neighbors: readonly MemoryId[]
    /** 与该条目存在 contradicts 边的条目 id（schema v15 起）：只提示不计分，供模型自行判断。 */
    readonly contradicts?: readonly MemoryId[]
  }
  /** 命中条目关联的实体（schema v10 起；无关联时缺省）。 */
  readonly entities?: readonly { readonly id: EntityId; readonly name: string }[]
  /** TTL 已过期（schema v15 起）：仍可命中但已降权，渲染时标 [已过期]。 */
  readonly expired?: boolean
}

/** 单条检索通道的统计（schema v15，批四）：面板"检索通道"表数据源。 */
export interface SearchChannelStat {
  readonly channel: 'fts' | 'vector' | 'graph'
  readonly tookMs: number
  readonly hits: number
  /** 该道降级（如无查询向量时的向量道）。 */
  readonly degraded: boolean
}

/** 检索结果：degraded=true 表示嵌入缺失/失败，仅关键词道参与排序。 */
export interface SearchResult {
  readonly hits: readonly SearchHit[]
  readonly degraded: boolean
  /** 各检索道统计（schema v15 起；旧调用方缺省不读）。 */
  readonly channels?: readonly SearchChannelStat[]
}

/** 时间线查询。since/until 为 epoch 毫秒；topic 为子串匹配。 */
export interface TimelineQuery {
  readonly since?: number
  readonly until?: number
  readonly topic?: string
  readonly scopes: readonly KyzmemScope[]
  /** 排序：缺省 'time' 按创建时间倒序；'tour' 按固定巡游路线桩位顺序（未上路线者按创建时间排末尾）。 */
  readonly order?: 'time' | 'tour'
  readonly limit?: number
}

/** episode 情景时间线的时间邻近扩展缺省窗口：锚点 createdAt ± 60 分钟。 */
export const EPISODE_PROXIMITY_MS_DEFAULT = 60 * 60 * 1000
/** episode 情景时间线缺省返回条数上限。 */
export const EPISODE_TIMELINE_LIMIT_DEFAULT = 100

/** episode 情景记忆时间线查询：独立于通用 TimelineQuery 的情景线索。
 *  缺省模式按 since/until/sessionId 过滤 episode 条目并按来源会话分组；
 *  around 指定时切换为时间邻近扩展模式（以锚点 createdAt 为中心开窗，
 *  忽略 since/until/sessionId——窗口语义下日期过滤只会截断扩展结果）。 */
export interface EpisodeTimelineQuery {
  readonly scopes: readonly KyzmemScope[]
  /** 起始时间（epoch 毫秒，含）；缺省不限。 */
  readonly since?: number
  /** 结束时间（epoch 毫秒，含）；缺省不限。 */
  readonly until?: number
  /** 只看该来源会话（source_session_id 精确匹配）的情景。 */
  readonly sessionId?: string
  /** 时间邻近扩展锚点（任意 active 记忆 id，不限于 episode）；该库中不存在时 loud 失败。 */
  readonly around?: MemoryId
  /** 邻近窗口毫秒数（around 模式）；缺省 EPISODE_PROXIMITY_MS_DEFAULT。 */
  readonly proximityMs?: number
  /** 返回条数上限（组模式按条数、around 模式按邻居数）；缺省 EPISODE_TIMELINE_LIMIT_DEFAULT。 */
  readonly limit?: number
}

/** 按来源会话分组的一组情景（组内条目按创建时间升序）。 */
export interface EpisodeSessionGroup {
  /** 来源会话 id；null = 无会话来源（显式保存或来源链缺失）。 */
  readonly sessionId: string | null
  readonly episodes: readonly MemoryRecord[]
  /** 组内最早创建时间（组的排序键，会话起点）。 */
  readonly startedAt: number
  /** 组内最晚创建时间（会话跨度展示用）。 */
  readonly endedAt: number
  /** 摄取期生成的一句话会话摘要（组头展示）；未生成过或缺省不携带。 */
  readonly summary?: string
}

/** episode 情景时间线结果。 */
export interface EpisodeTimelineResult {
  /** 按会话分组的情景（组按 startedAt 倒序，最新会话在前）；around 模式下为空数组。 */
  readonly groups: readonly EpisodeSessionGroup[]
  /** 时间邻近扩展（query.around 指定时返回）：锚点条目 + 窗口内的 episode 邻居
   *  （排除锚点自身，按创建时间升序；limit 约束邻居数）。 */
  readonly around?: { readonly anchor: MemoryRecord; readonly neighbors: readonly MemoryRecord[] }
}

/** 更新请求：旧条目转 archived 并建立 supersedes 边（from=新，to=旧）。 */
export interface UpdateInput {
  readonly id: MemoryId
  readonly scope: KyzmemScope
  readonly kind: KyzmemKind
  readonly content: string
  readonly importance?: number
  /** 新内容向量；缺省时继承旧条目向量。 */
  readonly embedding?: Float32Array
  /** 意象铭牌替换；缺省继承旧条目。 */
  readonly imagery?: ImageryLabel
}

/** 画像 curated block 的单条版本记录（追加式版本链，rollback 数据源）。 */
export interface ProfileBlockVersion {
  readonly scope: KyzmemScope
  /** 版本号：从 1 起单调递增，回滚也产生新版本（历史永不改写）。 */
  readonly version: number
  readonly content: string
  /** 产生方式：edit 人工/模型编辑；rollback 回滚到历史版本的内容。 */
  readonly source: 'edit' | 'rollback'
  readonly at: number
}

/** 画像 curated block 当前态：会话开始注入时优先于自动派生画像。 */
export interface ProfileBlock {
  readonly scope: KyzmemScope
  readonly content: string
  /** 当前版本号（乐观锁基准：编辑时必须携带此值）。 */
  readonly version: number
  readonly updatedAt: number
}

/** 一条操作日志（审计视图行）。 */
export interface OperationLogRow {
  readonly at: number
  readonly op: string
  /** 操作对象（条目 id 或 AUX）；全库活动视图按此展示归属。 */
  readonly targetId: string
  readonly detail: string | null
}

/** 一条修订历史：update 归档旧条目时的旧内容快照（内容不变性审计）。 */
export interface MemoryRevision {
  readonly content: string
  readonly kind: string
  readonly importance: number
  readonly supersededAt: number
}

/** 审计视图：条目 + 来源链 + 关系邻居 + 操作日志。 */
export interface ReviewView {
  readonly record: MemoryRecord
  /** 谁取代了此条目（supersedes 边 from → 此条目）。 */
  readonly supersededBy: readonly MemoryId[]
  /** 此条目取代了谁（supersedes 边 此条目 → to）。 */
  readonly supersedes: readonly MemoryId[]
  readonly contradicts: readonly MemoryId[]
  readonly related: readonly MemoryId[]
  /** 修订历史（旧内容快照，按被取代时间倒序）。 */
  readonly revisions: readonly MemoryRevision[]
  /** 最近 20 条涉及此条目的操作日志（时间倒序）。 */
  readonly operations: readonly OperationLogRow[]
}

/** 信念生命周期状态：active 可注入；stale 有未纳入的新证据待复核；refuted 被证据否定，只留审计。 */
export type ObservationStatus = 'active' | 'stale' | 'refuted'

/**
 * 巩固信念（observation）：由辅助 LLM 从多条原始记忆巩固出的一句话结论。
 * 与普通记忆的区别：持续细化（近邻归并到同一条而非重复新增）、带证据链
 * （sourceIds + proofCount）、新鲜度可复核（stale/refuted）。schema v12 起。
 */
export interface ObservationRecord {
  readonly id: ObservationId
  readonly scope: KyzmemScope
  /** 巩固后的一句话信念。 */
  readonly belief: string
  readonly status: ObservationStatus
  /** 支撑该信念的原始记忆 id（去重并集，持续累积）。 */
  readonly sourceIds: readonly MemoryId[]
  /** 证据条数（= sourceIds 去重后长度，冗余落库便于排序）。 */
  readonly proofCount: number
  readonly createdAt: number
  readonly updatedAt: number
  /** 最近一次经证据复核为成立的时间（form/refine/still 都会刷新）。 */
  readonly lastValidatedAt: number
}

/** 新建信念的写入输入（sourceIds 至少 1 条，且应为同库 active 记忆）。 */
export interface ObservationWriteInput {
  readonly scope: KyzmemScope
  readonly belief: string
  readonly sourceIds: readonly MemoryId[]
  /** 信念向量（调用方经嵌入器算好）；缺省时该信念不参与近邻归并。 */
  readonly embedding?: Float32Array
}

/** 信念列表过滤条件。 */
export interface ObservationListFilter {
  /** 缺省不过滤状态。 */
  readonly status?: ObservationStatus
  readonly limit: number
  readonly offset?: number
}

/** 全库统计（信噪比 = active / max(1, total)）。 */
export interface StoreStats {
  readonly total: number
  readonly active: number
  readonly archived: number
  readonly forgotten: number
  /** 含 `[REDACTED:` 脱敏标记的条目数（管理面板脱敏覆盖指标）。 */
  readonly redacted: number
  readonly byKind: Readonly<Record<string, number>>
  readonly edges: number
  readonly opLogCount: number
  readonly signalRatio: number
  /** TTL 已过期但仍 active 的条目数（schema v15）。 */
  readonly expired?: number
  /** 已失效（invalid_at 非空）的条目数（schema v15）。 */
  readonly invalidated?: number
  /** 按来源分级的计数（schema v15，R4）。 */
  readonly byTier?: Readonly<Record<string, number>>
  /** 待裁决冲突对数量（contradicts 边去重后的端点数，schema v15）。 */
  readonly openConflicts?: number
  /** 今日到期复习条目数（schema v15）。 */
  readonly dueCount?: number
}

/** 全库导出（数据可携带：任意状态条目 + 全部边）。 */
export interface ExportData {
  readonly exportedAt: number
  readonly records: readonly MemoryRecord[]
  readonly edges: readonly MemoryEdge[]
  /** 实体词典（schema v10 起；旧版本导出缺省）。 */
  readonly entities?: readonly EntityRecord[]
}

/** 导入预览行的分类：new=将导入；duplicate=与库内某条内容全等（默认跳过）；conflict=id 已被占用且内容不同（跳过并报告）。 */
export type ImportEntryClass = 'new' | 'duplicate' | 'conflict'

/** 导入预览的单行（面板勾选列表与 kyzmem_import dryRun 的数据源）。 */
export interface ImportPreviewEntry {
  readonly id: MemoryId
  readonly kind: MemoryRecord['kind']
  readonly status: MemoryRecord['status']
  readonly content: string
  readonly classification: ImportEntryClass
  /** duplicate 时：与之内容全等的既有条目 id（conflict 时为被占用的 id 本身）。 */
  readonly duplicateOf?: MemoryId
}

/** 导入预览：逐条分类 + 边/实体层面汇总（不写库）。 */
export interface ImportPreview {
  readonly entries: readonly ImportPreviewEntry[]
  readonly edgesTotal: number
  /** 双端都无法落地的边数（端点既不在导入集也不在库内；导入时将被丢弃）。 */
  readonly edgesDangling: number
  readonly entitiesNew: number
  readonly entitiesMerged: number
}

/** 导入选项。 */
export interface ImportOptions {
  /** 只导入这些 id（缺省 = 全部按分类规则放行的条目）。 */
  readonly selectedIds?: readonly MemoryId[]
  /** 内容全等的重复也强制导入（沿用导出侧 id；仅当该 id 未被占用时生效）。默认跳过。 */
  readonly keepDuplicates?: boolean
}

/** 导入结果。 */
export interface ImportResult {
  readonly imported: number
  /** 实际写入的条目 id（调用方据此批量补嵌入）。 */
  readonly importedIds: readonly MemoryId[]
  readonly skippedDuplicates: number
  readonly conflicts: number
  readonly edgesLinked: number
  readonly edgesDangling: number
  readonly entitiesNew: number
  readonly entitiesMerged: number
}

/** 衰减参数：从未被检索命中、且 lastAccessedAt 早于 olderThanDays 的 active 条目归档。
 * 复习保护期（reviewGraceDays）：已排期的条目要等复习逾期超过该天数才失去保护；
 * 未排期条目不受此保护。importance 不再参与衰减判据（旧判据实测命中恒 0，见批零 0.3）。 */
export interface DecayOptions {
  readonly olderThanDays: number
  readonly reviewGraceDays?: number
  /** 单次最多归档条数（减载档用，schema v15）；缺省不限。 */
  readonly limit?: number
}

/** 冲突的处置动作（schema v15 批一：defer 产生的 contradicts 边终于有了裁决出口）。 */
export type ConflictAction = 'keep-left' | 'keep-right' | 'keep-both' | 'drop-both'

/** 一对待裁决冲突：left/right 为 contradicts 边两端。 */
export interface ConflictPair {
  readonly left: MemoryRecord
  readonly right: MemoryRecord
  /** 冲突边建立时刻。 */
  readonly createdAt: number
}

/** 待裁决冲突列表。 */
export interface ConflictListResult {
  readonly items: readonly ConflictPair[]
  readonly total: number
}

/** 后台整理任务种类（批三：欠账偿还状态机，取代夜间定时）。 */
export type MaintenanceJob = 'decay' | 'merge' | 'refurb'

/** 后台整理欠账快照：决定"该不该跑"，不依赖钟点。 */
export interface MaintenanceDebt {
  /** 近 7 天新增条目 / 当前 active 总量（0-1，缺分母时为 0）。 */
  readonly activeGrowth: number
  /** 待裁决冲突对数量。 */
  readonly openConflicts: number
  /** 已到期复习条目数。 */
  readonly dueReviews: number
  /** 未清 pending 摄取轮数。 */
  readonly pendingIngests: number
  /** 缺失的会话摘要数（暂以 0 表示未接）。 */
  readonly missingSummaries: number
}

/** 一次后台整理运行的结果（写 op_log 'maintenance-run'）。 */
export interface MaintenanceRunResult {
  readonly job: MaintenanceJob
  readonly items: number
  readonly ms: number
  readonly debt: MaintenanceDebt
}

/** 闭馆三问的答案（墓志铭）。写入 op_log 的 forget 详情，方便 kyzmem_audit_forgotten 考古。 */
export interface ForgettingTombstone {
  /** 为什么关：可能是被取代、过期、与现实不符、隐私等。 */
  readonly reason: string
  /** 影响谁：影响哪些条目/人/项目；空串 = 不适用。 */
  readonly affects: string
  /** 还有用吗：明确遗留价值（可考古、可复习、可回滚时的语义）。 */
  readonly stillUseful: string
}

/** 闭馆考古视图：forgotten 条目 + 墓志铭（来自 op_log）。 */
export interface ForgottenAuditRow {
  readonly id: MemoryId
  readonly scope: KyzmemScope
  readonly kind: KyzmemKind
  readonly content: string
  readonly importance: number
  readonly lastAccessedAt: number
  readonly tombstone: ForgettingTombstone | null
  /** op_log 时间戳（闭馆瞬间）。 */
  readonly forgottenAt: number
}

/** 管理列表过滤条件（管理面板用；可看全部状态）。 */
export interface ListFilter {
  readonly scope: KyzmemScope
  readonly status?: KyzmemStatus
  readonly kind?: KyzmemKind
  /** content 子串匹配。 */
  readonly q?: string
  /** 脱敏标记过滤：true 只看含 `[REDACTED:` 的条目，false 只看不含的；缺省不过滤。 */
  readonly redacted?: boolean
  /** 只看受信来源（user-confirmed + agent-inferred，schema v15 R4）。 */
  readonly confirmedOnly?: boolean
  /** 排序：缺省 created_at 倒序；'tour' = 按固定巡游路线桩位顺序（未上路线者按创建时间排末尾）。 */
  readonly sort?: 'tour'
  readonly limit: number
  readonly offset: number
}

/** 分页列表结果。 */
export interface ListResult {
  readonly records: readonly MemoryRecord[]
  readonly total: number
}

/** dsh-kyzmem 统一错误：加载/使用期的可诊断失败都抛此类型。 */
export class KyzmemError extends Error {
  /** 机器可读原因码，如 EMBEDDER_DOWNLOAD_FAILED / SCHEMA_INCOMPATIBLE。 */
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'KyzmemError'
    this.code = code
  }
}
