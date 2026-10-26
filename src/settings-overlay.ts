/**
 * 插件自有的配置覆盖层（运维页设置卡片的写入目标）。
 *
 * 宿主 cordis 配置写回走内部 loader 钩子，插件不直接调用。这里改用插件自己的
 * `<dbDir>/settings.json`：apply() 加载时把它与宿主 config 合并（覆盖层优先），再交给
 * resolveConfig 统一校验。覆盖层只影响下一次加载，卡片需提示用户重启插件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_KEYS, resolveConfig } from './config.ts'
import type { KyzmemConfig, ResolvedKyzmemConfig } from './config.ts'

export const SETTINGS_FILE = 'settings.json'

/** 覆盖层文件路径。 */
export function settingsPath(dbDir: string): string {
  return join(dbDir, SETTINGS_FILE)
}

/**
 * 读取覆盖层。文件缺失返回空对象；内容损坏或不是对象时抛错，由调用方决定降级策略，
 * 避免静默丢弃用户已保存的设置。
 */
export function readOverlay(dbDir: string): Partial<KyzmemConfig> {
  const file = settingsPath(dbDir)
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-kyzmem: ${SETTINGS_FILE} must contain a JSON object`)
  }
  return parsed as Partial<KyzmemConfig>
}

/**
 * 宿主配置 + 覆盖层合并，覆盖层优先。`dbDir` 决定覆盖层位置，所以它本身不能被覆盖层改写
 * （否则下次加载会去另一个目录找覆盖层）。
 */
export function mergeWithOverlay(hostConfig: KyzmemConfig, overlay: Partial<KyzmemConfig>): KyzmemConfig {
  const { dbDir: _ignored, ...safeOverlay } = overlay
  return { ...hostConfig, ...safeOverlay }
}

/**
 * 校验并把一次修改写入覆盖层。只接受 CONFIG_KEYS 内的键，值必须通过 resolveConfig；
 * 写入采用「临时文件 + rename」，中途崩溃不会留下半截 JSON。
 * @returns 合并后的覆盖层快照（已通过校验）。
 */
export function saveOverlay(dbDir: string, patch: Record<string, unknown>, hostConfig: KyzmemConfig): Partial<KyzmemConfig> {
  for (const key of Object.keys(patch)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-kyzmem: unknown config key "${key}"`)
    if (key === 'dbDir') throw new Error('dsh-kyzmem: dbDir cannot be changed from the settings card')
  }
  // 值为 null 表示「清除覆盖、回到宿主配置」，而不是写入 null。
  const next: Record<string, unknown> = { ...readOverlay(dbDir) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  // 先用合并结果试算一遍：任何非法值都在落盘前被 resolveConfig 拒绝。
  resolveConfig(mergeWithOverlay(hostConfig, next))
  mkdirSync(dbDir, { recursive: true, mode: 0o700 })
  const file = settingsPath(dbDir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return next
}

/** 卡片可编辑的键（同时也是卡片表单的字段集合）。 */
export const EDITABLE_KEYS = [
  'ingest',
  'ingestDeadLetterAttempts',
  'queryRecall',
  'recallTotal',
  'maintenanceEnabled',
  'maintenanceBudgetLlmCalls',
] as const

/**
 * 卡片表单的扁平视图。解析后的配置里 maintenance 是嵌套对象，直接摊给前端会让表单读不到
 * `maintenanceEnabled` 这类键，所以在这里统一压平。
 */
export function editableValues(effective: ResolvedKyzmemConfig): Record<string, unknown> {
  return {
    ingest: effective.ingest,
    ingestDeadLetterAttempts: effective.ingestDeadLetterAttempts,
    queryRecall: effective.queryRecall,
    recallTotal: effective.recallTotal,
    maintenanceEnabled: effective.maintenance.enabled,
    maintenanceBudgetLlmCalls: effective.maintenance.budgetLlmCalls,
  }
}

/**
 * 只读快照：把解析后的标量字段摊平成一个可以直接渲染的表。嵌套对象（maintenance、
 * ttlDaysByKind 等）由表单或各自面板负责，这里跳过，避免卡片里出现 `[object Object]`。
 */
export function flattenResolved(effective: ResolvedKyzmemConfig): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(effective as unknown as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  // maintenance 是卡片表单直接管的字段，单独摊平，让快照和表单看到同一组值。
  out['maintenanceEnabled'] = effective.maintenance.enabled
  out['maintenanceBudgetLlmCalls'] = effective.maintenance.budgetLlmCalls
  out['maintenanceBudgetMs'] = effective.maintenance.budgetMs
  return out
}

/** 每个配置键的来源：`overlay` = 设置卡片覆盖，`host` = 宿主配置文件，其余为默认值。 */
export function sourcesFor(hostConfig: KyzmemConfig, overlay: Partial<KyzmemConfig>): Record<string, 'host' | 'overlay' | 'default'> {
  const out: Record<string, 'host' | 'overlay' | 'default'> = {}
  for (const key of Object.keys(hostConfig)) {
    if (key !== 'dbDir' && hostConfig[key as keyof KyzmemConfig] !== undefined) out[key] = 'host'
  }
  for (const key of Object.keys(overlay)) out[key] = 'overlay'
  return out
}

/**
 * 当前生效配置 + 每个键是否来自覆盖层。供卡片展示「已覆盖」标记与保存后的生效值。
 */
export function describeEffective(
  hostConfig: KyzmemConfig,
  overlay: Partial<KyzmemConfig>,
): {
  effective: ResolvedKyzmemConfig
  values: Record<string, unknown>
  snapshot: Record<string, string | number | boolean>
  sources: Record<string, 'host' | 'overlay' | 'default'>
  overridden: string[]
} {
  const merged = mergeWithOverlay(hostConfig, overlay)
  const overridden = Object.keys(overlay).filter((key) => key !== 'dbDir')
  const effective = resolveConfig(merged)
  return {
    effective,
    values: editableValues(effective),
    snapshot: flattenResolved(effective),
    sources: sourcesFor(hostConfig, overlay),
    overridden,
  }
}
