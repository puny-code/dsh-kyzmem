import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoResolveBatch, askConsistent } from '../src/automation/orchestrator.ts'
import { logAutoAction } from '../src/automation/log.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { MemoryJudge } from '../src/write-disposition.ts'

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-auto-orch-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

function fakeJudge(answers: Record<string, number>): MemoryJudge {
  return {
    deferMergeAbove: 0.9,
    deferAcceptBelow: 0.15,
    contradictMinProbability: 0.9,
    ask: async () => ({ ...answers }),
  }
}

describe('askConsistent', () => {
  it('averages the two consistent answers and abstains nothing', async () => {
    const judge = fakeJudge({ same_memory: 0.9, different_memory: 0.12 })
    const result = await askConsistent(judge, 'state', [
      {
        id: 'same_memory',
        negatedId: 'different_memory',
        instructions: '是否为同一条记忆？',
        negatedInstructions: '是否为不同的记忆？',
      },
    ])
    expect(result.abstained).toEqual([])
    expect(result.answers['same_memory']).toBeCloseTo((0.9 + (1 - 0.12)) / 2, 5)
  })

  it('abstains the question when the two answers disagree beyond maxDiff', async () => {
    const judge = fakeJudge({ same_memory: 0.9, different_memory: 0.9 })
    const result = await askConsistent(
      judge,
      'state',
      [
        {
          id: 'same_memory',
          negatedId: 'different_memory',
          instructions: '是否为同一条记忆？',
          negatedInstructions: '是否为不同的记忆？',
        },
      ],
      0.3,
    )
    expect(result.abstained).toEqual(['same_memory'])
    expect(result.answers['same_memory']).toBeUndefined()
  })
})

describe('autoResolveBatch', () => {
  it('auto-resolves an r-tier pair and logs an undoable auto-action', async () => {
    const left = await store.write({ scope: 'user', kind: 'fact', content: '确认过的部署流程', sourceTier: 'user-confirmed' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '旧的部署流程记录' })
    await store.linkEdge(left.id, right.id, 'contradicts')

    const result = await autoResolveBatch(store, { version: '0.16.0-test' })

    expect(result).toEqual({ processed: 1, autoResolved: 1, proposed: 0, skippedCap: 0 })
    expect((await store.get(right.id))?.status).toBe('archived')
    expect((await store.listConflicts(['user'], 10)).items).toEqual([])
    const audits = await store.recentAudit('auto-action', 10)
    expect(audits.length).toBe(1)
    const detail = JSON.parse(audits[0]!.detail!) as { undo: { restoreIds: string[] } }
    expect(detail.undo.restoreIds).toEqual([String(right.id)])
  })

  it('leaves an r-abstain pair for humans and logs it as proposed', async () => {
    const left = await store.write({ scope: 'user', kind: 'fact', content: '甲说法' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '乙说法' })
    await store.linkEdge(left.id, right.id, 'contradicts')

    const result = await autoResolveBatch(store, { version: '0.16.0-test' })

    expect(result).toEqual({ processed: 1, autoResolved: 0, proposed: 1, skippedCap: 0 })
    expect((await store.get(left.id))?.status).toBe('active')
    expect((await store.listConflicts(['user'], 10)).items.length).toBe(1)
    expect(await store.recentAudit('auto-proposed', 10)).toHaveLength(1)
  })

  it('stops auto-resolving once the daily cap is reached', async () => {
    for (let index = 0; index < 20; index++) {
      await logAutoAction(store, {
        op: 'auto-action',
        ruleId: 'conflict-rule/r-tier',
        thresholds: { tierOnly: 1 },
        batchId: `auto-conflict-seed-${index}`,
        version: '0.16.0-test',
      })
    }
    const left = await store.write({ scope: 'user', kind: 'fact', content: '确认过的部署流程', sourceTier: 'user-confirmed' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '旧的部署流程记录' })
    await store.linkEdge(left.id, right.id, 'contradicts')

    const result = await autoResolveBatch(store, { version: '0.16.0-test' })

    expect(result).toEqual({ processed: 1, autoResolved: 0, proposed: 1, skippedCap: 1 })
    expect((await store.get(right.id))?.status).toBe('active')
    expect((await store.listConflicts(['user'], 10)).items.length).toBe(1)
  })
})
