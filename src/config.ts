/**
 * 插件 Config：所有部署可变项集中于此，禁止在实现里内嵌默认值。
 * @module dsh-kyzmem/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { isKyzmemLanguage, resolveLanguage, type KyzmemLanguage, type LanguageSetting } from './i18n/language.ts'

/** 旧库迁移策略：默认自动迁移，可选择保留待人工确认。 */
export type LegacyMigrationPolicy = 'eager' | 'conservative'

/** 自动摄取档位：off 关闭；light 只读用户消息（每轮≤2 条）；eager 用户+助手消息（每轮≤5 条）。 */
export type IngestModeConfig = 'off' | 'light' | 'eager'

/** 信念巩固档位：off 仅允许手动 kyzmem_reflect；suggest 会话结束只登记待巩固；auto 会话结束后自动巩固。 */
export type ReflectModeConfig = 'off' | 'suggest' | 'auto'

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
  /** 检索排序 recency 因子权重（0 关闭）；默认 0.2。 */
  rankRecencyWeight?: number
  /** 检索排序 proof 因子权重（0 关闭）；默认 0.1。 */
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
  readonly injectTokenBudget: number
  readonly injectItemBudgetStart: number
  readonly injectItemBudgetDecay: number
  readonly injectItemBudgetFloor: number
  readonly assessReminder: boolean
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
  'injectTokenBudget', 'injectItemBudgetStart', 'injectItemBudgetDecay', 'injectItemBudgetFloor',
  'rankRecencyWeight', 'rankProofWeight', 'queryRewrite',
  'autoSlot', 'reviewScheduling', 'assessReminder',
  'historyBackfillDays', 'historyBackfillMaxTurnsPerSession', 'historyBackfillMaxTotalTurns',
  'historyBackfillIncludeSubagents', 'historyBackfillIncludeSeeded', 'historyBackfillIncludeNoCwd',
  'language', 'redactWords',
])

const INGEST_MODES: ReadonlySet<string> = new Set(['off', 'light', 'eager'])
const REFLECT_MODES: ReadonlySet<string> = new Set(['off', 'suggest', 'auto'])

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
 * @throws 未知键、ingest 档位非法、provider/model 只给其一、decay/预算/排序权重/历史回填规则越界时抛错。
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
    injectTokenBudget: config.injectTokenBudget ?? 1024,
    injectItemBudgetStart: config.injectItemBudgetStart ?? 160,
    injectItemBudgetDecay: config.injectItemBudgetDecay ?? 0.9,
    injectItemBudgetFloor: config.injectItemBudgetFloor ?? 24,
    assessReminder: config.assessReminder ?? true,
    rankRecencyWeight: config.rankRecencyWeight ?? 0.2,
    rankProofWeight: config.rankProofWeight ?? 0.1,
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
