import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { logAutoAction } from '../src/automation/log.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-auto-log-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('logAutoAction', () => {
  it('writes an entry queryable by batch id with all required detail keys', async () => {
    await logAutoAction(store, {
      op: 'auto-action',
      ruleId: 'r-tier',
      thresholds: { contradictMin: 0.88 },
      similarity: 0.91,
      leftId: 'node-a',
      rightId: 'node-b',
      batchId: 'auto-conflict-20261026-001',
      version: '0.16.0',
    })
    const rows = await store.recentAudit('auto-action', 10)
    expect(rows).toHaveLength(1)
    const first = rows[0]
    expect(first).toBeDefined()
    expect(first!.targetId).toBe('BATCH')
    const detail = JSON.parse(first!.detail ?? '{}') as Record<string, unknown>
    expect(detail).toMatchObject({
      ruleId: 'r-tier',
      similarity: 0.91,
      leftId: 'node-a',
      rightId: 'node-b',
      batchId: 'auto-conflict-20261026-001',
      version: '0.16.0',
    })
    expect(detail.thresholds).toEqual({ contradictMin: 0.88 })
  })

  it('supports the shadow op name without executing anything', async () => {
    await logAutoAction(store, {
      op: 'auto-proposed',
      ruleId: 'r-newer',
      thresholds: {},
      batchId: 'auto-conflict-20261026-002',
      version: '0.16.0',
      note: 'shadow only',
    })
    const rows = await store.recentAudit('auto-proposed', 10)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.detail ?? '{}')).toMatchObject({ ruleId: 'r-newer', note: 'shadow only' })
    // 影子记录不产生 auto-action 执行记录。
    expect(await store.recentAudit('auto-action', 10)).toHaveLength(0)
  })
})
