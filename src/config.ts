/**
 * 插件 Config：所有部署可变项集中于此，禁止在实现里内嵌默认值。
 * @module dsh-kyzmem/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { isKyzmemLanguage, resolveLanguage, type KyzmemLanguage, type LanguageSetting } from './i18n/language.ts'
import { SOURCE_TIERS, type KyzmemKind, type KyzmemSourceTier } from './types.ts'

/** 旧库迁移策略：默认自动迁移，可选择保留待人工确认。 */
export type LegacyMigrationPolicy = 'eager' | 'conservative'

/** 自动摄取档位：off 关闭；light 只读用户消息（每轮≤2 条）；eager 用户+助手消息（每轮≤5 条）。 */
export type IngestModeConfig = 'off' | 'light' | 'eager'

/** 信念巩固档位：off 仅允许手动 kyzmem_reflect；suggest 会话结束只登记待巩固；auto 会话结束后自动巩固。 */
export type ReflectModeConfig = 'off' | 'suggest' | 'auto'

/**
 * 首问 keyed 召回档位：off 关闭；light 会话首问注入 3 条（默认，预算 640）；full 注入 5 条（预算下限 960）。
 * 档位决定「默认条数 + 默认预算」；`queryRecallBudget` 显式值在 light 下原样生效，在 full 下低于 960 会被抬到 960
 * （否则 full 的 5 条永远装不下，与 light 同效）。
 */
export type QueryRecallMode = 'off' | 'light' | 'full'

/** 插件配置。 */
export interface KyzmemConfig {
  /** 两个 SQLite 分库与嵌入模型缓存的根目录；默认 `~/.dsh/kyzmem`。 */
  dbDir?: string
  /** 旧库迁移策略：默认 eager 自动迁移；conservative 保留旧库待人工确认。 */
  legacyMigration?: LegacyMigrationPolicy
  /** 会话开始是否注入用户级画像摘要；默认 true。 */
  injectProfile?: boolean
  /** 画像注入的最大条数；默认 8。 */
  profileTopN?: number
  /** 嵌入模型缓存目录；默认 `<dbDir>/models`。 */
  modelCacheDir?: string
  /** 嵌入模型下载端点；默认 huggingface.co，网络受限环境配镜像（如 https://hf-mirror.com）。 */
  hfEndpoint?: string
  /** 自动摄取档位；默认 off（显式开启才写库）。 */
  ingest?: IngestModeConfig
  /** 信念自动巩固档位；默认 off。suggest/auto 会话结束后触发，复用 provider/model 辅助路由。 */
  reflect?: ReflectModeConfig
  /** 蒸馏/摄取覆盖路由的 provider；必须与 model 成对提供。 */
  provider?: string
  /** 蒸馏/摄取覆盖路由的 model；必须与 provider 成对提供。 */
  model?: string
  /** 衰减：从未被检索命中、且最近访问超过该天数才可能被归档；默认 90。 */
  decayAfterDays?: number
  /** TTL（schema v15）：各类记忆的有效天数，0 = 永不过期；默认 fact 180 / episode 90 / decision 365 / preference 0 / skill 0。 */
  ttlFactDays?: number
  ttlEpisodeDays?: number
  ttlDecisionDays?: number
  ttlPreferenceDays?: number
  ttlSkillDays?: number
  /** 画像注入参与的来源分级（schema v15 R4）；默认 ['user-confirmed','agent-inferred']。 */
  injectTiers?: KyzmemSourceTier[]
  /** kyzmem_search 单条回显正文字符上限（批二）；默认 160。 */
  recallPerItem?: number
  /** kyzmem_search 单次返回正文字符总预算（批二）；默认 4800。 */
  recallTotal?: number
  /** 后台整理（批三：欠账偿还，不绑钟点）开关；默认 true。 */
  maintenanceEnabled?: boolean
  /** 单次后台整理的时间预算（毫秒）；默认 1500。 */
  maintenanceBudgetMs?: number
  /** 单次后台整理的条目预算；默认 50。 */
  maintenanceBudgetItems?: number
  /** 单次后台整理允许的辅助 LLM 调用次数；默认 1。 */
  maintenanceBudgetLlmCalls?: number
  /** 空档期减载：距上次活跃超过该天数进入减载档（预算收紧）；默认 7。 */
  maintenanceIdleDays?: number
  /** SM-2 逾期间隔超过该天数后，答对也从 1 天重新开始（relearning）；默认 30。 */
  reviewRelearnDays?: number
  /** 摄取 pending 重放失败达到该次数进死信（schema v15 批三）；默认 3。 */
  ingestDeadLetterAttempts?: number
  /** 画像注入的 token 预算（估算 ceil(len/4)）；默认 1024。 */
  injectTokenBudget?: number
  /** 画像分级递减预算：首条正文字符数；默认 160。 */
  injectItemBudgetStart?: number
  /** 画像分级递减预算：逐条递减系数（0.5-1）；默认 0.9。 */
  injectItemBudgetDecay?: number
  /** 画像分级递减预算：单条正文字符下限；默认 24。 */
  injectItemBudgetFloor?: number
  /** 证据门收尾提醒：会话存在未判定检索批次时在下一步开始前注入提醒；默认 true。 */
  assessReminder?: boolean
  /** 会话首问 keyed 召回档位；默认 light（注入 3 条）。off 完全关闭。 */
  queryRecall?: QueryRecallMode
  /** 首问召回整块字符预算（标题 + 条目 + examine 提示 + 批次行）；默认 640（三语都装得下 3 条）；full 档下限 960。条数是上限，预算才是硬约束。 */
  queryRecallBudget?: number
  /** 首问召回条数上限；缺省 light 3 / full 5。 */
  queryRecallTop?: number
  /** 检索排序 recency 因子权重（0 关闭）；默认 0.2。 */
  rankRecencyWeight?: number
  /** 检索排序 proof 因子权重（0 关闭）；默认 0.05（实测 access_count 中位 0，旧 0.1 只会放大少数老条目）。 */
  rankProofWeight?: number
  /** kyzmem_search 是否用辅助 LLM 把查询改写为 ≤3 个互补查询再做 RRF 融合；默认 true。改写失败自动降级单查询。 */
  queryRewrite?: boolean
  /** 写入时自动排桩（房间 + 桩位号）并登记固定巡游路线；默认 true。false 时桩位/路线完全由调用方显式指定。 */
  autoSlot?: boolean
  /** 新记忆是否进入 SM-2 间隔重复调度（初始 1 天后到期）；默认 true。false 时复习队列恒空、decay 行为同旧版。 */
  reviewScheduling?: boolean
  /** 历史回填默认规则：时间窗天数，0 = 不限；默认 7。 */
  historyBackfillDays?: number
  /** 历史回填默认规则：单个会话最多摄取轮数；默认 20。 */
  historyBackfillMaxTurnsPerSession?: number
  /** 历史回填上限：单次运行的总轮数硬上限（面板/工具参数只能调低）；默认 200。 */
  historyBackfillMaxTotalTurns?: number
  /** 历史回填默认规则：是否包含子代理会话（origin=subagent）；默认 false。 */
  historyBackfillIncludeSubagents?: boolean
  /** 历史回填默认规则：是否包含种子会话（isSeeded）；默认 false。 */
  historyBackfillIncludeSeeded?: boolean
  /** 历史回填默认规则：是否包含无 cwd 的会话（无法归属项目分库）；默认 false。 */
  historyBackfillIncludeNoCwd?: boolean
  /**
   * Язык текстов, которые плагин формирует сам: имена комнат, сообщения инструментов.
   * «auto» (по умолчанию) — язык системы. Интерфейс панели настраивается отдельно,
   * средствами DSH: плагин отдаёт хосту словари, а выбор делает хост.
   */
  language?: LanguageSetting
  /**
   * Слова-метки секретов, добавленные пользователем. Дополняют наборы языкового пакета
   * и действуют **всегда**, независимо от языка: пользователь добавляет их как раз потому,
   * что пакета не хватило. Пробельные строки отбрасываются.
   */
  redactWords?: string[]
}

/** 历史回填规则（面板/工具可在默认值之上按次调整；总轮数受硬上限约束）。 */
export interface ResolvedHistoryRules {
  /** 时间窗天数；0 = 不限。 */
  readonly days: number
  /** 单个会话最多摄取轮数。 */
  readonly maxTurnsPerSession: number
  /** 单次运行总轮数硬上限。 */
  readonly maxTotalTurns: number
  /** 是否包含子代理会话。 */
  readonly includeSubagents: boolean
  /** 是否包含种子会话。 */
  readonly includeSeeded: boolean
  /** 是否包含无 cwd 会话。 */
  readonly includeNoCwd: boolean
}

/** 后台整理（批三：欠账偿还状态机）解析后的预算与阈值。 */
export interface ResolvedMaintenance {
  readonly enabled: boolean
  readonly budgetMs: number
  readonly budgetItems: number
  readonly budgetLlmCalls: number
  readonly idleDays: number
}

/** 解析后的完整配置（显式默认值集中在此一步，实现不再 `?? 默认`）。 */
export interface ResolvedKyzmemConfig {
  readonly dbDir: string
  readonly legacyMigration: LegacyMigrationPolicy
  readonly injectProfile: boolean
  readonly profileTopN: number
  readonly modelCacheDir: string
  readonly hfEndpoint: string | undefined
  readonly ingest: IngestModeConfig
  readonly reflect: ReflectModeConfig
  /** 成对校验后的路由覆盖；undefined = 从会话日志解析路由。 */
  readonly routeOverride: { readonly provider: string; readonly model: string } | undefined
  readonly decayAfterDays: number
  /** 各类记忆的 TTL 天数（0 = 永不过期，schema v15）。 */
  readonly ttlDaysByKind: Readonly<Record<KyzmemKind, number>>
  /** 参与画像注入的来源分级（schema v15 R4）。 */
  readonly injectTiers: readonly KyzmemSourceTier[]
  /** kyzmem_search 单条正文上限（批二）。 */
  readonly recallPerItem: number
  /** kyzmem_search 单次正文总预算（批二）。 */
  readonly recallTotal: number
  /** 后台整理（批三）预算与阈值。 */
  readonly maintenance: ResolvedMaintenance
  /** SM-2 逾期重学阈值（天）。 */
  readonly reviewRelearnDays: number
  /** 摄取 pending 重放失败进死信的次数阈值。 */
  readonly ingestDeadLetterAttempts: number
  readonly injectTokenBudget: number
  readonly injectItemBudgetStart: number
  readonly injectItemBudgetDecay: number
  readonly injectItemBudgetFloor: number
  readonly assessReminder: boolean
  /** 会话首问 keyed 召回档位。 */
  readonly queryRecall: QueryRecallMode
  /** 首问召回整块字符预算。 */
  readonly queryRecallBudget: number
  /** 首问召回条数上限（light 3 / full 5 的缺省已在 resolve 落地）。 */
  readonly queryRecallTop: number
  readonly rankRecencyWeight: number
  readonly rankProofWeight: number
  readonly queryRewrite: boolean
  readonly autoSlot: boolean
  readonly reviewScheduling: boolean
  /** 历史回填默认规则（历史会话 → 学习核心的一次性/按需回填）。 */
  readonly historyBackfill: ResolvedHistoryRules
  /** Язык вывода серверной половины (после разворачивания «auto» в язык системы). */
  readonly language: KyzmemLanguage
  /** Слова пользователя для вычистки секретов (действуют поверх языковых наборов). */
  readonly redactWords: readonly string[]
}

/** 合法配置键集合（未知键 loud 失败）。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'legacyMigration', 'dbDir', 'injectProfile', 'profileTopN', 'modelCacheDir', 'hfEndpoint',
  'ingest', 'reflect', 'provider', 'model', 'decayAfterDays',
  'ttlFactDays', 'ttlEpisodeDays', 'ttlDecisionDays', 'ttlPreferenceDays', 'ttlSkillDays',
  'injectTiers', 'recallPerItem', 'recallTotal',
  'maintenanceEnabled', 'maintenanceBudgetMs', 'maintenanceBudgetItems', 'maintenanceBudgetLlmCalls', 'maintenanceIdleDays',
  'reviewRelearnDays', 'ingestDeadLetterAttempts',
  'injectTokenBudget', 'injectItemBudgetStart', 'injectItemBudgetDecay', 'injectItemBudgetFloor',
  'rankRecencyWeight', 'rankProofWeight', 'queryRewrite',
  'autoSlot', 'reviewScheduling', 'assessReminder',
  'queryRecall', 'queryRecallBudget', 'queryRecallTop',
  'historyBackfillDays', 'historyBackfillMaxTurnsPerSession', 'historyBackfillMaxTotalTurns',
  'historyBackfillIncludeSubagents', 'historyBackfillIncludeSeeded', 'historyBackfillIncludeNoCwd',
  'language', 'redactWords',
])

const INGEST_MODES: ReadonlySet<string> = new Set(['off', 'light', 'eager'])
const REFLECT_MODES: ReadonlySet<string> = new Set(['off', 'suggest', 'auto'])
const QUERY_RECALL_MODES: ReadonlySet<string> = new Set(['off', 'light', 'full'])
/**
 * 首问召回整块字符预算缺省值。实测（80 字正文截断后 81 + 标题 + examine 提示 + 批次行）：
 * zh 3 条 = 409 / en 3 条 = 581 / ru 3 条 = 601，取 640 让三语都稳定放得下 3 条。
 */
const QUERY_RECALL_BUDGET_DEFAULT = 640
/**
 * full 档预算下限 = 960：5 条 × 81 + 标题 + examine 提示 + 批次行在三语下都装得下
 * （实测 zh 5 条 662 / en 5 条 835 / ru 5 条 855）。
 * full 是「多给」档，显式调小的预算会被抬到这个下限——这是有意为之（否则 full 的 top=5
 * 永远兑现不了，等于与 light 同效），调整后的生效值可在 ResolvedKyzmemConfig 里读到。
 */
const QUERY_RECALL_FULL_BUDGET_FLOOR = 960

/** Schemastery 校验面（cordis.yml 读取时校验）。 */
export const Config: z<KyzmemConfig> = z.object({
  dbDir: z.string(),
  legacyMigration: z.string() as unknown as z<LegacyMigrationPolicy>,
  injectProfile: z.boolean(),
  profileTopN: z.number().step(1).min(1).max(64),
  modelCacheDir: z.string(),
  hfEndpoint: z.string(),
  ingest: z.string() as unknown as z<IngestModeConfig>,
  reflect: z.string() as unknown as z<ReflectModeConfig>,
  provider: z.string(),
  model: z.string(),
  decayAfterDays: z.number().step(1).min(1).max(3650),
  ttlFactDays: z.number().step(1).min(0).max(3650),
  ttlEpisodeDays: z.number().step(1).min(0).max(3650),
  ttlDecisionDays: z.number().step(1).min(0).max(3650),
  ttlPreferenceDays: z.number().step(1).min(0).max(3650),
  ttlSkillDays: z.number().step(1).min(0).max(3650),
  injectTiers: z.array(z.string()),
  recallPerItem: z.number().step(1).min(40).max(2000),
  recallTotal: z.number().step(1).min(200).max(20000),
  maintenanceEnabled: z.boolean(),
  maintenanceBudgetMs: z.number().step(1).min(200).max(30000),
  maintenanceBudgetItems: z.number().step(1).min(1).max(500),
  maintenanceBudgetLlmCalls: z.number().step(1).min(0).max(5),
  maintenanceIdleDays: z.number().step(1).min(1).max(365),
  reviewRelearnDays: z.number().step(1).min(1).max(3650),
  ingestDeadLetterAttempts: z.number().step(1).min(1).max(20),
  injectTokenBudget: z.number().step(1).min(128).max(8192),
  injectItemBudgetStart: z.number().step(1).min(40).max(2000),
  injectItemBudgetDecay: z.number().min(0.5).max(1),
  injectItemBudgetFloor: z.number().step(1).min(8).max(200),
  rankRecencyWeight: z.number().min(0).max(2),
  rankProofWeight: z.number().min(0).max(2),
  queryRewrite: z.boolean(),
  autoSlot: z.boolean(),
  reviewScheduling: z.boolean(),
  assessReminder: z.boolean(),
  queryRecall: z.string() as unknown as z<QueryRecallMode>,
  queryRecallBudget: z.number().step(1).min(240).max(4000),
  queryRecallTop: z.number().step(1).min(1).max(10),
  historyBackfillDays: z.number().step(1).min(0).max(3650),
  historyBackfillMaxTurnsPerSession: z.number().step(1).min(1).max(500),
  historyBackfillMaxTotalTurns: z.number().step(1).min(1).max(5000),
  historyBackfillIncludeSubagents: z.boolean(),
  historyBackfillIncludeSeeded: z.boolean(),
  historyBackfillIncludeNoCwd: z.boolean(),
  language: z.string() as unknown as z<LanguageSetting>,
  redactWords: z.array(z.string()),
})

/**
 * 显式 resolve 步骤：默认值只在唯一的此处落地，非法值 loud 失败。
 * @param config - cordis.yml 传入的未校验配置。
 * @returns 完整解析配置。
 * @throws 未知键、ingest/queryRecall 档位非法、provider/model 只给其一、decay/预算/排序权重/历史回填规则越界时抛错。
 */
export function resolveConfig(config: KyzmemConfig = {}): ResolvedKyzmemConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-kyzmem: unknown config key "${key}"`)
  }
  if (config.legacyMigration !== undefined && config.legacyMigration !== 'eager' && config.legacyMigration !== 'conservative') {
    throw new Error('dsh-kyzmem: legacyMigration must be one of eager|conservative')
  }
  if (config.ingest !== undefined && !INGEST_MODES.has(config.ingest)) {
    throw new Error(`dsh-kyzmem: ingest must be one of off|light|eager, got "${String(config.ingest)}"`)
  }
  if (config.reflect !== undefined && !REFLECT_MODES.has(config.reflect)) {
    throw new Error(`dsh-kyzmem: reflect must be one of off|suggest|auto, got "${String(config.reflect)}"`)
  }
  if (config.language !== undefined && config.language !== 'auto' && !isKyzmemLanguage(config.language)) {
    throw new Error(`dsh-kyzmem: language must be one of auto|zh|en|ru, got "${String(config.language)}"`)
  }
  if (config.profileTopN !== undefined && (!Number.isInteger(config.profileTopN) || config.profileTopN < 1 || config.profileTopN > 64)) {
    throw new Error('dsh-kyzmem: profileTopN must be an integer in [1, 64]')
  }
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('dsh-kyzmem: provider and model must be supplied together')
  }
  if (config.decayAfterDays !== undefined && (!Number.isInteger(config.decayAfterDays) || config.decayAfterDays < 1 || config.decayAfterDays > 3650)) {
    throw new Error('dsh-kyzmem: decayAfterDays must be an integer in [1, 3650]')
  }
  const ttlKeys: readonly (keyof KyzmemConfig)[] = ['ttlFactDays', 'ttlEpisodeDays', 'ttlDecisionDays', 'ttlPreferenceDays', 'ttlSkillDays']
  for (const key of ttlKeys) {
    const value = config[key]
    if (value !== undefined && (!Number.isInteger(value as number) || (value as number) < 0 || (value as number) > 3650)) {
      throw new Error(`dsh-kyzmem: ${key} must be an integer in [0, 3650] (0 = never expires)`)
    }
  }
  if (config.injectTiers !== undefined) {
    for (const tier of config.injectTiers) {
      if (!SOURCE_TIERS.includes(tier)) {
        throw new Error(`dsh-kyzmem: injectTiers must be a subset of ${SOURCE_TIERS.join('|')}, got "${String(tier)}"`)
      }
    }
  }
  const intKeys: readonly (keyof KyzmemConfig)[] = [
    'recallPerItem', 'recallTotal', 'maintenanceBudgetMs', 'maintenanceBudgetItems',
    'maintenanceBudgetLlmCalls', 'maintenanceIdleDays', 'reviewRelearnDays', 'ingestDeadLetterAttempts',
  ]
  for (const key of intKeys) {
    const value = config[key]
    if (value !== undefined && (!Number.isInteger(value as number) || (value as number) < 0)) {
      throw new Error(`dsh-kyzmem: ${key} must be a non-negative integer`)
    }
  }
  if (config.maintenanceEnabled !== undefined && typeof config.maintenanceEnabled !== 'boolean') {
    throw new Error('dsh-kyzmem: maintenanceEnabled must be a boolean')
  }
  if (config.injectTokenBudget !== undefined && (!Number.isInteger(config.injectTokenBudget) || config.injectTokenBudget < 128 || config.injectTokenBudget > 8192)) {
    throw new Error('dsh-kyzmem: injectTokenBudget must be an integer in [128, 8192]')
  }
  if (config.injectItemBudgetStart !== undefined
    && (!Number.isInteger(config.injectItemBudgetStart) || config.injectItemBudgetStart < 40 || config.injectItemBudgetStart > 2000)) {
    throw new Error('dsh-kyzmem: injectItemBudgetStart must be an integer in [40, 2000]')
  }
  if (config.injectItemBudgetDecay !== undefined && (config.injectItemBudgetDecay < 0.5 || config.injectItemBudgetDecay > 1)) {
    throw new Error('dsh-kyzmem: injectItemBudgetDecay must be in [0.5, 1]')
  }
  if (config.injectItemBudgetFloor !== undefined
    && (!Number.isInteger(config.injectItemBudgetFloor) || config.injectItemBudgetFloor < 8 || config.injectItemBudgetFloor > 200)) {
    throw new Error('dsh-kyzmem: injectItemBudgetFloor must be an integer in [8, 200]')
  }
  if (config.injectItemBudgetStart !== undefined && config.injectItemBudgetFloor !== undefined
    && config.injectItemBudgetFloor > config.injectItemBudgetStart) {
    throw new Error('dsh-kyzmem: injectItemBudgetFloor must not exceed injectItemBudgetStart')
  }
  if (config.assessReminder !== undefined && typeof config.assessReminder !== 'boolean') {
    throw new Error('dsh-kyzmem: assessReminder must be a boolean')
  }
  if (config.queryRecall !== undefined && !QUERY_RECALL_MODES.has(config.queryRecall)) {
    throw new Error(`dsh-kyzmem: queryRecall must be one of off|light|full, got "${String(config.queryRecall)}"`)
  }
  if (config.queryRecallBudget !== undefined
    && (!Number.isInteger(config.queryRecallBudget) || config.queryRecallBudget < 240 || config.queryRecallBudget > 4000)) {
    throw new Error('dsh-kyzmem: queryRecallBudget must be an integer in [240, 4000]')
  }
  if (config.queryRecallTop !== undefined
    && (!Number.isInteger(config.queryRecallTop) || config.queryRecallTop < 1 || config.queryRecallTop > 10)) {
    throw new Error('dsh-kyzmem: queryRecallTop must be an integer in [1, 10]')
  }
  if (config.rankRecencyWeight !== undefined && (config.rankRecencyWeight < 0 || config.rankRecencyWeight > 2)) {
    throw new Error('dsh-kyzmem: rankRecencyWeight must be in [0, 2]')
  }
  if (config.rankProofWeight !== undefined && (config.rankProofWeight < 0 || config.rankProofWeight > 2)) {
    throw new Error('dsh-kyzmem: rankProofWeight must be in [0, 2]')
  }
  if (config.historyBackfillDays !== undefined && (!Number.isInteger(config.historyBackfillDays) || config.historyBackfillDays < 0 || config.historyBackfillDays > 3650)) {
    throw new Error('dsh-kyzmem: historyBackfillDays must be an integer in [0, 3650] (0 = unlimited)')
  }
  if (config.historyBackfillMaxTurnsPerSession !== undefined
    && (!Number.isInteger(config.historyBackfillMaxTurnsPerSession) || config.historyBackfillMaxTurnsPerSession < 1 || config.historyBackfillMaxTurnsPerSession > 500)) {
    throw new Error('dsh-kyzmem: historyBackfillMaxTurnsPerSession must be an integer in [1, 500]')
  }
  if (config.historyBackfillMaxTotalTurns !== undefined
    && (!Number.isInteger(config.historyBackfillMaxTotalTurns) || config.historyBackfillMaxTotalTurns < 1 || config.historyBackfillMaxTotalTurns > 5000)) {
    throw new Error('dsh-kyzmem: historyBackfillMaxTotalTurns must be an integer in [1, 5000]')
  }
  const dbDir = config.dbDir ?? join(homedir(), '.dsh', 'kyzmem')
  // 首问召回：档位同时决定默认条数（light 3 / full 5）与整块预算。
  // full 是「多给」档：预算有 960 的下限（见 QUERY_RECALL_FULL_BUDGET_FLOOR），显式调小也会被抬上来——
  // 否则 top=5 永远兑现不了，full 与 light 等效（风险报告 M3 / 复审 N2）。抬升后的生效值
  // 就是 ResolvedKyzmemConfig.queryRecallBudget，调用方无需再自己算。
  const queryRecallMode: QueryRecallMode = config.queryRecall ?? 'light'
  const queryRecallBudget = config.queryRecallBudget ?? QUERY_RECALL_BUDGET_DEFAULT
  const resolvedQueryRecallBudget = queryRecallMode === 'full'
    ? Math.max(queryRecallBudget, QUERY_RECALL_FULL_BUDGET_FLOOR)
    : queryRecallBudget
  return {
    dbDir,
    legacyMigration: config.legacyMigration ?? 'eager',
    injectProfile: config.injectProfile ?? true,
    profileTopN: config.profileTopN ?? 8,
    modelCacheDir: config.modelCacheDir ?? join(dbDir, 'models'),
    hfEndpoint: config.hfEndpoint,
    ingest: config.ingest ?? 'off',
    reflect: config.reflect ?? 'off',
    language: resolveLanguage(config.language ?? 'auto'),
    redactWords: config.redactWords ?? [],
    routeOverride: hasProvider && hasModel ? { provider: config.provider!, model: config.model! } : undefined,
    decayAfterDays: config.decayAfterDays ?? 90,
    ttlDaysByKind: {
      fact: config.ttlFactDays ?? 180,
      episode: config.ttlEpisodeDays ?? 90,
      decision: config.ttlDecisionDays ?? 365,
      preference: config.ttlPreferenceDays ?? 0,
      skill: config.ttlSkillDays ?? 0,
    },
    injectTiers: config.injectTiers ?? ['user-confirmed', 'agent-inferred'],
    recallPerItem: config.recallPerItem ?? 160,
    recallTotal: config.recallTotal ?? 4800,
    maintenance: {
      enabled: config.maintenanceEnabled ?? true,
      budgetMs: config.maintenanceBudgetMs ?? 1500,
      budgetItems: config.maintenanceBudgetItems ?? 50,
      budgetLlmCalls: config.maintenanceBudgetLlmCalls ?? 1,
      idleDays: config.maintenanceIdleDays ?? 7,
    },
    reviewRelearnDays: config.reviewRelearnDays ?? 30,
    ingestDeadLetterAttempts: config.ingestDeadLetterAttempts ?? 3,
    injectTokenBudget: config.injectTokenBudget ?? 1024,
    injectItemBudgetStart: config.injectItemBudgetStart ?? 160,
    injectItemBudgetDecay: config.injectItemBudgetDecay ?? 0.9,
    injectItemBudgetFloor: config.injectItemBudgetFloor ?? 24,
    assessReminder: config.assessReminder ?? true,
    queryRecall: queryRecallMode,
    queryRecallBudget: resolvedQueryRecallBudget,
    queryRecallTop: config.queryRecallTop ?? (queryRecallMode === 'full' ? 5 : 3),
    rankRecencyWeight: config.rankRecencyWeight ?? 0.2,
    rankProofWeight: config.rankProofWeight ?? 0.05,
    queryRewrite: config.queryRewrite ?? true,
    autoSlot: config.autoSlot ?? true,
    reviewScheduling: config.reviewScheduling ?? true,
    historyBackfill: {
      days: config.historyBackfillDays ?? 7,
      maxTurnsPerSession: config.historyBackfillMaxTurnsPerSession ?? 20,
      maxTotalTurns: config.historyBackfillMaxTotalTurns ?? 200,
      includeSubagents: config.historyBackfillIncludeSubagents ?? false,
      includeSeeded: config.historyBackfillIncludeSeeded ?? false,
      includeNoCwd: config.historyBackfillIncludeNoCwd ?? false,
    },
  }
}
