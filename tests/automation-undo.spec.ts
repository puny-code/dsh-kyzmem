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
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-auto-undo-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('undoAutoBatch', () => {
  it('restores archived losers and removes the batch supersedes edges', async () => {
    const left = await store.write({ scope: 'user', kind: 'fact', content: '左条目有效' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '右条目被自动归档' })
    // 用人工裁决语义先把 right 归档（模拟自动归档后的状态），再补一条本批次的 supersedes 边。
    await store.resolveConflict(left.id, right.id, 'keep-left')
    await store.linkEdge(left.id, right.id, 'supersedes')
    await logAutoAction(store, {
      op: 'auto-action',
      ruleId: 'r-tier',
      thresholds: { contradictMin: 0.88 },
      leftId: String(left.id),
      rightId: String(right.id),
      batchId: 'auto-conflict-20261026-001',
      version: '0.16.0',
      undo: {
        restoreIds: [String(right.id)],
        removeEdges: [{ from: String(left.id), to: String(right.id), type: 'supersedes' }],
      },
    })

    const result = await store.undoAutoBatch('auto-conflict-20261026-001')
    expect(result.restored).toEqual([String(right.id)])
    expect(result.edgesRemoved).toBe(1)
    expect((await store.get(right.id))?.status).toBe('active')
    // 同一条 supersedes 边已被删：审计视图里胜者不再「取代」输家。
    const winnerView = await store.review(left.id)
    expect(winnerView?.supersedes.map(String)).not.toContain(String(right.id))
  })

  it('restores the previous review schedule', async () => {
    const node = await store.write({ scope: 'user', kind: 'fact', content: '需要复习的条目' })
    await store.scheduleReview(node.id, 5)
    const before = (await store.get(node.id))?.review
    expect(before).toBeDefined()
    await store.scheduleReview(node.id, 1)
    const changed = (await store.get(node.id))?.review
    expect(changed).not.toEqual(before)
    await logAutoAction(store, {
      op: 'auto-action',
      ruleId: 'review-adopt',
      thresholds: {},
      batchId: 'auto-review-20261026-001',
      version: '0.16.0',
      undo: { restoreSchedule: [{ id: String(node.id), review: before! }] },
    })

    const result = await store.undoAutoBatch('auto-review-20261026-001')
    expect(result.schedulesRestored).toEqual([String(node.id)])
    expect((await store.get(node.id))?.review).toEqual(before)
  })

  it('returns zeros for an unknown batch id and changes nothing', async () => {
    const node = await store.write({ scope: 'user', kind: 'fact', content: '保持原样' })
    const result = await store.undoAutoBatch('auto-nope-000')
    expect(result).toEqual({ restored: [], edgesRemoved: 0, schedulesRestored: [] })
    expect((await store.get(node.id))?.status).toBe('active')
  })
})
