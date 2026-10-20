/**
 * 老数据导入：把 `@kenz1117/dsh-engram`（含其前身 engram 布局）留在
 * `~/.dsh/engram` 下的分库与本地向量模型拷进本插件的 `~/.dsh/kyzmem`。
 *
 * 设计取舍：
 * - **只拷不搬**：老目录原样保留（用户的旧插件仍可能被装回去跑），本插件只读它。
 * - **只跑一次**：成功后写 `.legacy-import.json` 标记；之后无论老目录是否还在都不再动作
 *   （用户可能又用回了旧插件，反复覆盖会丢新数据）。
 * - **从不覆盖**：目标分库已存在就跳过——本插件优先，绝不拿旧库盖掉正在用的库。
 * - **VACUUM INTO 而不是文件复制**：老库可能开着 WAL，直接复制 `.db` 会缺 `-wal` 里的
 *   最新事务；VACUUM INTO 从一个只读连接导出干净的整库快照。
 * - **失败不阻断启动**：任何异常都只 console.warn（插件启动不能因为历史数据而失败），
 *   下次启动会重试（标记文件只在全部成功后写）。
 * - 旧库 `schema 13` 由本插件开库时的 MIGRATIONS 自动升到当前版本。
 * @module dsh-kyzmem/legacy/import
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 标记文件名：写在目标 dbDir 下，内容是本次导入的清单与时间戳。 */
export const LEGACY_IMPORT_MARKER = '.legacy-import.json'

/** 老插件默认数据目录（`@kenz1117/dsh-engram` 及其前身共用）。 */
export function legacyDir(): string {
  return join(homedir(), '.dsh', 'engram')
}

/** 单次导入的结果（也原样落进标记文件，便于面板/日志复盘）。 */
export interface LegacyImportResult {
  /** 老目录路径。 */
  readonly source: string
  /** 目标目录路径。 */
  readonly target: string
  /** 已导出的分库文件（`user.db` / `project-<hash>.db` / `shared.db`）。 */
  readonly databases: readonly string[]
  /** 目标已存在而跳过的分库。 */
  readonly skipped: readonly string[]
  /** 是否导出了本地向量模型目录。 */
  readonly models: boolean
  /** 导入完成时间（毫秒时间戳）。 */
  readonly at: number
}

/** 老目录里值得导出的分库：`*.db`（跳过 WAL 旁的 -wal/-shm 与临时文件）。 */
function listDatabases(source: string): string[] {
  return readdirSync(source)
    .filter(name => name.endsWith('.db') && !name.startsWith('.'))
    .filter(name => {
      try {
        return statSync(join(source, name)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** 用只读连接把老库整库导出到目标路径（不复制 WAL，不修改源库）。 */
function vacuumInto(source: string, target: string): void {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    // VACUUM INTO 的目标不接受绑定参数，只能内联；路径里的单引号按 SQL 字面量转义。
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

/** 读标记文件；不存在或损坏返回 undefined（损坏即视为未导入，允许重试）。 */
export function readLegacyMarker(dbDir: string): LegacyImportResult | undefined {
  const path = join(dbDir, LEGACY_IMPORT_MARKER)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LegacyImportResult
  } catch {
    return undefined
  }
}

/**
 * 检测并导入老数据（幂等：已导入过、目标库已存在、或老目录不存在时静默跳过）。
 * @param dbDir - 本插件数据目录（`~/.dsh/kyzmem`）
 * @param options.source - 老数据目录，默认 `~/.dsh/engram`（测试可注入）
 * @param options.enabled - false 时完全不动（`KYZMEM_LEGACY_IMPORT=off`）
 * 同步执行：只在上首次启动跑一次，几十毫秒量级（VACUUM INTO + 模型目录复制）。
 * @returns 本次导入结果；没做事时返回 undefined
 */
export function importLegacyData(
  dbDir: string,
  options: { source?: string; enabled?: boolean } = {},
): LegacyImportResult | undefined {
  const enabled = options.enabled ?? process.env['KYZMEM_LEGACY_IMPORT'] !== 'off'
  if (!enabled) return undefined
  const source = options.source ?? legacyDir()
  if (!existsSync(source)) return undefined
  if (readLegacyMarker(dbDir) !== undefined) return undefined
  const target = dbDir
  if (source === target) return undefined
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const databases: string[] = []
    const skipped: string[] = []
    for (const name of listDatabases(source)) {
      const to = join(target, name)
      if (existsSync(to)) { skipped.push(name); continue }
      vacuumInto(join(source, name), to)
      databases.push(name)
    }
    // 本地向量模型体积大（~23MB）但缺了就只能联网重下：一并拷过去，让检索第一秒就能用。
    let models = false
    const sourceModels = join(source, 'models')
    const targetModels = join(target, 'models')
    if (existsSync(sourceModels) && !existsSync(targetModels)) {
      cpSync(sourceModels, targetModels, { recursive: true, force: false, errorOnExist: false })
      models = true
    }
    const result: LegacyImportResult = { source, target, databases, skipped, models, at: Date.now() }
    writeFileSync(join(target, LEGACY_IMPORT_MARKER), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    // 启动路径不能因为历史数据失败：留个警告，下次启动重试（不写标记）。
    console.warn('[dsh-kyzmem] legacy import skipped:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}
