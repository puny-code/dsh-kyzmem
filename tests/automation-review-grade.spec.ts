import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyAdoptionScheduling } from '../src/automation/review-grade.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyzmem-review-grade-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function writeFact(content: string): Promise<string> {
  const record = await store.write({ scope: 'user', kind: 'fact', content })
  return String(record.id)
}

async function seedRecall(op: 'recall-used' | 'recall-ignored', batch: string, ids: string[]): Promise<void> {
  await store.audit(op, 'BATCH', JSON.stringify({ batch, ids }))
}

async function autoGradeRows(): Promise<{ id: string; grade: number }[]> {
  const rows = await store.recentAudit('review-grade-auto', 200)
  return rows.map(row => {
    const parsed = JSON.parse(row.detail ?? '{}') as { id?: unknown; grade?: unknown }
    return { id: String(parsed.id), grade: Number(parsed.grade) }
  })
}

describe('applyAdoptionScheduling（Phase 6，只改 review）', () => {
  it('被采用的条目 grade 4 推进并记审计', async () => {
    const ids = [await writeFact('第一条被引用的记忆内容'), await writeFact('第二条被引用的记忆内容')]
    const result = await applyAdoptionScheduling(store, ids, true)
    expect(result).toEqual({ adjusted: 2, skippedCap: false })
    expect(await autoGradeRows()).toHaveLength(2)
    for (const id of ids) {
      expect((await store.get(id as never))?.review).toBeDefined()
    }
  })
  it('每日上限 20 条：超出的本次不动', async () => {
    for (let index = 0; index < 19; index++) {
      await store.audit('review-grade-auto', 'BATCH', JSON.stringify({ id: `seed-${index}`, grade: 4 }))
    }
    const ids = [await writeFact('上限测试一'), await writeFact('上限测试二'), await writeFact('上限测试三')]
    const result = await applyAdoptionScheduling(store, ids, true)
    expect(result.adjusted).toBe(1)
    expect(result.skippedCap).toBe(true)
    expect(await autoGradeRows()).toHaveLength(20)
  })
  it('连续 3 次注入未采用才 grade 2 后排', async () => {
    const id = await writeFact('长期没人引用的记忆内容条目')
    await seedRecall('recall-ignored', 'b1', [id])
    await seedRecall('recall-ignored', 'b2', [id])
    expect((await applyAdoptionScheduling(store, [id], false)).adjusted).toBe(0)
    await seedRecall('recall-ignored', 'b3', [id])
    const result = await applyAdoptionScheduling(store, [id], false)
    expect(result.adjusted).toBe(1)
    expect(await autoGradeRows()).toEqual([{ id, grade: 2 }])
  })
  it('中间被采用过一次就清零不断言', async () => {
    const id = await writeFact('中途被引用过的记忆内容条目')
    await seedRecall('recall-ignored', 'b1', [id])
    await seedRecall('recall-ignored', 'b2', [id])
    await seedRecall('recall-used', 'b3', [id])
    expect((await applyAdoptionScheduling(store, [id], false)).adjusted).toBe(0)
    expect(await autoGradeRows()).toHaveLength(0)
  })
  it('不碰 confidence：grade 4 不改变置信度', async () => {
    const id = await writeFact('置信度不应被采用信号改动的条目')
    const before = (await store.get(id as never))?.confidence
    await applyAdoptionScheduling(store, [id], true)
    expect((await store.get(id as never))?.confidence).toBe(before)
  })
})
