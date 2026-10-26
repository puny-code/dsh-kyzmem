import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMaintenance } from '../src/maintenance/scheduler.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { MemoryJudge } from '../src/write-disposition.ts'

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-auto-sched-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 播 6 对 r-tier 冲突（欠账阈值 5，6 对才超线）。 */
async function seedTierConflicts(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    const left = await store.write({ scope: 'user', kind: 'fact', content: `确认过的流程${index}`, sourceTier: 'user-confirmed' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: `旧的流程记录${index}` })
    await store.linkEdge(left.id, right.id, 'contradicts')
  }
}

/** 播 6 对规则弃权冲突（同为 agent-inferred、kind 不同，R1/R2 都不命中）。 */
async function seedAbstainConflicts(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    const left = await store.write({ scope: 'user', kind: 'fact', content: `甲说法${index}` })
    const right = await store.write({ scope: 'user', kind: 'decision', content: `乙决定${index}` })
    await store.linkEdge(left.id, right.id, 'contradicts')
  }
}

describe('runMaintenance 自动裁决联动（P2，只在欠账+预算双就绪时跑）', () => {
  it('冲突欠账超阈时跑 autoResolveBatch，结果与审计都带 autoResolve', async () => {
    await seedTierConflicts()
    const result = await runMaintenance(
      store,
      'merge',
      { ms: 10_000, items: 10, llmCalls: 0 },
      { autoResolve: { version: 'test', maxAuto: 10 } },
    )
    expect(result.autoResolve).toBeDefined()
    // 默认 limit=5：6 对里只处理 5 对，全部 r-tier 自动解决。
    expect(result.autoResolve!.autoResolved).toBe(5)
    expect(result.autoResolve!.proposed).toBe(0)
    const [row] = await store.recentAudit('maintenance-run', 1)
    const detail = JSON.parse(String(row?.detail)) as { autoResolve?: { autoResolved?: unknown } }
    expect(detail.autoResolve?.autoResolved).toBe(5)
  })

  it('无冲突欠账时不跑自动裁决（结果无 autoResolve，不写多余审计）', async () => {
    const result = await runMaintenance(
      store,
      'merge',
      { ms: 10_000, items: 10, llmCalls: 0 },
      { autoResolve: { version: 'test' } },
    )
    expect(result.autoResolve).toBeUndefined()
  })

  it('预算 llmCalls=0 时不调用 judge：规则弃权对只记 proposed', async () => {
    await seedAbstainConflicts()
    const ask = vi.fn(async () => ({ left_outdated: 0.99, right_outdated: 0.01 }))
    const judge = {
      deferMergeAbove: 0.9, deferAcceptBelow: 0.15, contradictMinProbability: 0.9, ask,
    } as unknown as MemoryJudge
    const result = await runMaintenance(
      store,
      'merge',
      { ms: 10_000, items: 10, llmCalls: 0 },
      { autoResolve: { version: 'test', maxAuto: 10, judge } },
    )
    expect(ask).not.toHaveBeenCalled()
    expect(result.autoResolve!.autoResolved).toBe(0)
    expect(result.autoResolve!.proposed).toBe(5)
  })

  it('预算允许时 judge 双轨生效：一致且过线才执行', async () => {
    await seedAbstainConflicts()
    const ask = vi.fn(async () => ({ left_outdated: 0.99, right_outdated: 0.01 }))
    const judge = {
      deferMergeAbove: 0.9, deferAcceptBelow: 0.15, contradictMinProbability: 0.9, ask,
    } as unknown as MemoryJudge
    const result = await runMaintenance(
      store,
      'merge',
      { ms: 10_000, items: 10, llmCalls: 1 },
      { autoResolve: { version: 'test', maxAuto: 10, judge } },
    )
    expect(ask).toHaveBeenCalledTimes(10)
    expect(result.autoResolve!.autoResolved).toBe(5)
  })
})
