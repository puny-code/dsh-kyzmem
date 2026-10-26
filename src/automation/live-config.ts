/**
 * 热键按次读取（Phase 2.1）。
 *
 * 加载期快照（resolved）对检索/注入/衰减四族键会很快过期：用户在面板改了
 * decayAfterDays，下一轮摄取还读旧值。`liveHotConfig` 在每次调用时重读
 * settings.json 覆盖层，只取 RETRIEVAL_KEYS，resolveConfig 重校验后返回新快照。
 *
 * 失败语义（loud 读、静默 fallback 都不对）：
 * - 覆盖层文件损坏/非法值 → warn + 返回上一次成功快照（不抛错，不中断调用方）；
 * - 从未注冊过（测试直调/新库）→ 返回 undefined，调用方用加载期快照。
 *
 * @module dsh-kyzmem/live-config
 */
import { message } from '../i18n/messages.ts'
import type { KyzmemConfig, ResolvedKyzmemConfig } from '../config.ts'
import { RETRIEVAL_KEYS, resolveConfig } from '../config.ts'
import { mergeWithOverlay, readOverlay } from '../settings-overlay.ts'

interface HotSource {
  readonly host: KyzmemConfig
  lastGood: ResolvedKyzmemConfig
}

/** dbDir → 注冊时的全量 host 配置 + 上一次成功快照（进程内，多库隔离）。 */
const sources = new Map<string, HotSource>()

/**
 * 注册热键来源：apply() 里调一次。host 必须是全量 host 配置（不能只给热键，
 * 否则重校验时冷键会回退成缺省值——mergeWithOverlay 只覆盖传入的键）。
 */
export function primeHotConfig(
  dbDir: string,
  hostConfig: KyzmemConfig,
  resolved: ResolvedKyzmemConfig,
): void {
  sources.set(dbDir, { host: hostConfig, lastGood: resolved })
}

/** 只取覆盖层里的热键（冷键即使被用户写进去也忽略，由加载期快照提供）。 */
function pickHot(overlay: Partial<KyzmemConfig>): Partial<KyzmemConfig> {
  const hot: Partial<KyzmemConfig> = {}
  for (const key of RETRIEVAL_KEYS) {
    const value = overlay[key]
    if (value !== undefined) {
      // KyzmemConfig 全字段可选：逐键赋值需要绕开「联合键写入」的类型限制。
      (hot as Record<string, unknown>)[key as string] = value as unknown
    }
  }
  return hot
}

/**
 * 按次读热配置。成功返回新快照并更新 lastGood；覆盖层损坏/校验失败 warn 后
 * 返回上一次快照；未注冊返回 undefined（调用方：`liveHotConfig(dbDir) ?? resolved`）。
 */
export function liveHotConfig(dbDir: string): ResolvedKyzmemConfig | undefined {
  const source = sources.get(dbDir)
  if (source === undefined) return undefined
  let overlay: Partial<KyzmemConfig>
  try {
    overlay = readOverlay(dbDir)
  } catch (error) {
    console.warn(message('core.warnLiveConfigFallback'), error)
    return source.lastGood
  }
  const hot = pickHot(overlay)
  if (Object.keys(hot).length === 0) return source.lastGood
  try {
    const next = resolveConfig(mergeWithOverlay(source.host, hot))
    source.lastGood = next
    return next
  } catch (error) {
    console.warn(message('core.warnLiveConfigFallback'), error)
    return source.lastGood
  }
}
