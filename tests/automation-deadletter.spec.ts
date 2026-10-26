import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INGEST_DONE_OP, INGEST_PENDING_OP, encodeTurnKey, retryDeadLetters,
} from '../src/ingest/hook.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-deadletter-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function seedDead(key: string, reason = 'max-attempts'): Promise<void> {
  await store.audit('ingest-dead-letter', 'BATCH', JSON.stringify({ key, attempts: 3, reason }))
}

async function deadReasons(key: string): Promise<string[]> {
  const rows = await store.recentAudit('ingest-dead-letter', 100)
  return rows
    .map(row => { try { return JSON.parse(row.detail ?? '{}') as { key?: unknown; reason?: unknown } } catch { return {} } })
    .filter(parsed => parsed.key === key)
    .map(parsed => String(parsed.reason))
}

async function pendingKeys(): Promise<string[]> {
  const { parsePendingValue } = await import('../src/ingest/hook.ts')
  const out: string[] = []
  for (const detail of await store.listAuditDetails(INGEST_PENDING_OP)) {
    const value = parsePendingValue(detail)
    if (value !== undefined) out.push(value.key)
  }
  return out
}

describe('retryDeadLetters（Phase 5，每日 ≤10、终身 ≤3、超限仍记）', () => {
  it('死信被捞回 pending 并记 retry 标记', async () => {
    const key = encodeTurnKey('sess-1', 2)
    await seedDead(key)
    const result = await retryDeadLetters(store, { now: Date.parse('2026-10-26T00:00:00Z') })
    expect(result).toEqual({ retried: 1, exhausted: 0, skipped: 0 })
    expect(await pendingKeys()).toEqual([key])
    expect(await deadReasons(key)).toEqual(['retry', 'max-attempts'])
  })
  it('每日只跑一次：同日第二次直接返回零', async () => {
    await seedDead(encodeTurnKey('sess-1', 2))
    const now = Date.parse('2026-10-26T00:00:00Z')
    expect(await retryDeadLetters(store, { now })).toEqual({ retried: 1, exhausted: 0, skipped: 0 })
    expect(await retryDeadLetters(store, { now })).toEqual({ retried: 0, exhausted: 0, skipped: 0 })
  })
  it('单条终身 3 次：超限记 retry-exhausted 且只记一次', async () => {
    const key = encodeTurnKey('sess-1', 2)
    await seedDead(key, 'retry')
    await seedDead(key, 'retry')
    await seedDead(key, 'retry')
    const now = Date.parse('2026-10-26T00:00:00Z')
    expect(await retryDeadLetters(store, { now })).toEqual({ retried: 0, exhausted: 1, skipped: 0 })
    expect(await pendingKeys()).toEqual([])
    expect(await retryDeadLetters(store, { now: now + 86_400_000 })).toEqual({ retried: 0, exhausted: 0, skipped: 1 })
  })
  it('已完成或仍在 pending 的键跳过', async () => {
    const doneKey = encodeTurnKey('sess-done', 1)
    await store.audit(INGEST_DONE_OP, 'sess-done', doneKey)
    await seedDead(doneKey)
    const pendingKey = encodeTurnKey('sess-pend', 1)
    await store.audit(INGEST_PENDING_OP, 'sess-pend', JSON.stringify({ key: pendingKey, attempts: 1, firstAt: 1 }))
    await seedDead(pendingKey)
    const key = encodeTurnKey('sess-1', 2)
    await seedDead(key)
    const result = await retryDeadLetters(store, { now: Date.parse('2026-10-26T00:00:00Z') })
    expect(result).toEqual({ retried: 1, exhausted: 0, skipped: 2 })
  })
  it('每日配额 10 条：超出的留到明天', async () => {
    for (let turn = 1; turn <= 12; turn++) await seedDead(encodeTurnKey('sess-q', turn))
    const now = Date.parse('2026-10-26T00:00:00Z')
    const result = await retryDeadLetters(store, { now })
    expect(result.retried).toBe(10)
    expect(await pendingKeys()).toHaveLength(10)
  })
})
