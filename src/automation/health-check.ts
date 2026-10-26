/**
 * 启动自检（Phase 3，6A）。
 *
 * 四项只读检查，不修任何东西：
 * - embedder-deps：@huggingface/transformers 是否在解析路径上（`hasTransformers` 已有实现）；
 * - embedder-worker：apply 期创建的嵌入器 Promise 是否在时限内 settle 出非 undefined
 *  （factory await warmup，进 resolved 即真 ping；超时/拒绝/undefined 都算失败，
 *   race 挂 handler，不会留下未处理 rejection 惊动宿主 fail-loud）；
 * - schema-version：只读打开 `<dbDir>/user.db`（`readOnly: true`，不触发迁移），
 *   读 meta 表 `schema_version` 与期望版本比对；
 * - dbdir-writable：`accessSync(W_OK)` 探针，不写文件（目录缺失也算失败）。
 *
 * @module dsh-kyzmem/automation/health-check
 */
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hasTransformers } from '../embedder/local.ts'
import type { KyzmemEmbedder } from '../embedder/interface.ts'

/** 自检项：ok=false 时 detail 说明原因，面板/日志直接展示。 */
export interface HealthCheckItem {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface HealthCheckOptions {
  readonly dbDir: string
  readonly expectedSchemaVersion: number
  /** apply 期创建的嵌入器 Promise；不传 = worker 项直接失败（不现建，避免自检触发下载）。 */
  readonly embedder?: Promise<KyzmemEmbedder | undefined>
  /** worker 就绪等待上限（毫秒）；缺省 3000。 */
  readonly timeoutMs?: number
}

/** user 库文件名（与 index.ts 开库约定一致）。 */
export const HEALTH_CHECK_DB_FILE = 'user.db'

function fail(name: string, detail: string): HealthCheckItem {
  return { name, ok: false, detail }
}

function pass(name: string, detail: string): HealthCheckItem {
  return { name, ok: true, detail }
}

async function checkWorker(
  embedder: Promise<KyzmemEmbedder | undefined> | undefined,
  timeoutMs: number,
): Promise<HealthCheckItem> {
  if (embedder === undefined) return fail('embedder-worker', 'unavailable (keyword fallback)')
  const settled = embedder.then(
    (value) => value === undefined
      ? fail('embedder-worker', 'resolved undefined (keyword fallback)')
      : pass('embedder-worker', 'ready'),
    (error: unknown) => fail('embedder-worker', error instanceof Error ? error.message : String(error)),
  )
  const timeout = new Promise<HealthCheckItem>((resolve) => {
    setTimeout(() => resolve(fail('embedder-worker', `timeout after ${String(timeoutMs)}ms`)), timeoutMs)
  })
  // race 给两边都挂了 handler：超时的那条 settled Promise 不会变成未处理 rejection。
  return Promise.race([settled, timeout])
}

function checkSchema(dbDir: string, expected: number): HealthCheckItem {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(join(dbDir, HEALTH_CHECK_DB_FILE), { readOnly: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value?: unknown }
      | undefined
    const found = typeof row?.value === 'string' ? Number(row.value) : NaN
    if (!Number.isInteger(found)) return fail('schema-version', 'meta.schema_version missing or unreadable')
    if (found !== expected) return fail('schema-version', `found ${String(found)}, expected ${String(expected)}`)
    return pass('schema-version', `version ${String(found)}`)
  } catch (error) {
    return fail('schema-version', error instanceof Error ? error.message : String(error))
  } finally {
    try {
      db?.close()
    } catch {
      // 只读句柄关闭失败无碍：进程退出时 SQLite 自会回收。
    }
  }
}

function checkDbDir(dbDir: string): HealthCheckItem {
  try {
    accessSync(dbDir, constants.W_OK)
    return pass('dbdir-writable', dbDir)
  } catch (error) {
    return fail('dbdir-writable', error instanceof Error ? error.message : String(error))
  }
}

/** 跑完四项自检。永远 resolve（失败体现在 ok=false），绝不抛错。 */
export async function runHealthChecks(options: HealthCheckOptions): Promise<{ checks: HealthCheckItem[] }> {
  const timeoutMs = options.timeoutMs ?? 3000
  const checks: HealthCheckItem[] = [
    hasTransformers()
      ? pass('embedder-deps', '@huggingface/transformers resolvable')
      : fail('embedder-deps', 'missing (keyword fallback)'),
    await checkWorker(options.embedder, timeoutMs),
    checkSchema(options.dbDir, options.expectedSchemaVersion),
    checkDbDir(options.dbDir),
  ]
  return { checks }
}
