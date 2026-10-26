import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHealthChecks } from '../src/automation/health-check.ts'
import type { KyzmemEmbedder } from '../src/embedder/interface.ts'
import { SCHEMA_VERSION, openKyzmemStore } from '../src/store/sqlite.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-health-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function names(result: { checks: readonly { name: string }[] }): string[] {
  return result.checks.map(check => check.name)
}

describe('runHealthChecks（Phase 3，只读不修）', () => {
  it('缺失目录四项全失败且不抛错', async () => {
    const result = await runHealthChecks({
      dbDir: join(dir, 'nope'),
      expectedSchemaVersion: SCHEMA_VERSION,
      embedder: Promise.resolve(undefined),
    })
    expect(names(result)).toEqual(['embedder-deps', 'embedder-worker', 'schema-version', 'dbdir-writable'])
    // embedder-deps 取决于运行环境（仓库 dev 下 transformers 本来就装着），只断言
    // 与环境无关的三项：worker 未给、库文件缺失、目录不可写。
    for (const name of ['embedder-worker', 'schema-version', 'dbdir-writable'] as const) {
      expect(result.checks.find(check => check.name === name)?.ok).toBe(false)
    }
  })
  it('真实库 schema 版本一致即通过，不一致即失败', async () => {
    const store = await openKyzmemStore(join(dir, 'user.db'))
    try {
      const ok = await runHealthChecks({
        dbDir: dir,
        expectedSchemaVersion: SCHEMA_VERSION,
        embedder: Promise.resolve(undefined),
      })
      expect(ok.checks.find(check => check.name === 'schema-version')?.ok).toBe(true)
      expect(ok.checks.find(check => check.name === 'dbdir-writable')?.ok).toBe(true)
      const mismatch = await runHealthChecks({
        dbDir: dir,
        expectedSchemaVersion: SCHEMA_VERSION + 1,
        embedder: Promise.resolve(undefined),
      })
      expect(mismatch.checks.find(check => check.name === 'schema-version')?.ok).toBe(false)
    } finally {
      await store.close()
    }
  })
  it('embedder：undefined 失败、已就绪通过、 hanging 按超时失败', async () => {
    const base = { dbDir: dir, expectedSchemaVersion: SCHEMA_VERSION }
    const unavailable = await runHealthChecks({ ...base, embedder: Promise.resolve(undefined) })
    expect(unavailable.checks.find(check => check.name === 'embedder-worker')?.ok).toBe(false)
    const fake = { embed: async () => [] } as unknown as KyzmemEmbedder
    const ready = await runHealthChecks({ ...base, embedder: Promise.resolve(fake) })
    expect(ready.checks.find(check => check.name === 'embedder-worker')?.ok).toBe(true)
    const hanging = await runHealthChecks({
      ...base,
      embedder: new Promise<KyzmemEmbedder | undefined>(() => undefined),
      timeoutMs: 20,
    })
    expect(hanging.checks.find(check => check.name === 'embedder-worker')?.ok).toBe(false)
  })
})
