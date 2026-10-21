import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { RankBoostOptions } from '../src/store/sqlite.ts'
import type { MemoryId } from '../src/types.ts'

/**
 * 夹具：A 词频更高（纯 RRF 排前）但创建于 40 天前、访问计数 0；
 * B 词频低但刚创建、访问计数 30。boost 生效时 B 应反超。
 *
 * v15 起 recency 基准是 created_at（不可变），不再是 last_accessed_at（旧实现里被
 * forget/restore/scheduleReview 反复刷新，早就不代表「新近程度」）。所以这里拨的是
 * created_at：A 的 last_accessed_at 仍是刚写入的时刻，若实现退回读 last_accessed_at，
 * 「recency 因子」用例会失败——这正是本夹具要守住的回归点。
 */
let path: string
let a: MemoryId
let b: MemoryId

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kyzmem-rank-'))
  path = join(dir, 'user.db')
  const store = await openKyzmemStore(path)
  a = (await store.write({ scope: 'user', kind: 'fact', content: '端口 端口 配置' })).id
  b = (await store.write({ scope: 'user', kind: 'fact', content: '端口 改动' })).id
  await store.close()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 40 * 86_400_000, a)
  db.prepare('UPDATE nodes SET access_count = 30 WHERE id = ?').run(b)
  db.close()
})

const searchOrder = async (boost: RankBoostOptions): Promise<MemoryId[]> => {
  const store = await openKyzmemStore(path, boost)
  const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
  await store.close()
  return result.hits.map(hit => hit.record.id)
}

describe('检索排序 boost', () => {
  it('系数为 0 退化为纯 RRF 现状排序', async () => {
    const expected = [a, b]
    expect(await searchOrder({ recencyWeight: 0, proofWeight: 0, decayAfterDays: 30 })).toEqual(expected)
    // 再查一次：boost 关闭时不得因上次检索的 touch 副作用改变排序（access_count 变了但权重为 0）。
    expect(await searchOrder({ recencyWeight: 0, proofWeight: 0, decayAfterDays: 30 })).toEqual(expected)
  })

  it('recency 因子：新鲜条目反超（基准为 created_at）', async () => {
    expect(await searchOrder({ recencyWeight: 1, proofWeight: 0, decayAfterDays: 30 })).toEqual([b, a])
  })

  it('recency 因子：陈旧条目不得因 last_accessed_at 新而被抬高', async () => {
    // A 的 last_accessed_at 是刚写入的（夹具没动它），created_at 是 40 天前；
    // decayAfterDays=30 时它的 recency 因子应被钳到 1（不再加分），因此仍排在 B 之后。
    const order = await searchOrder({ recencyWeight: 1, proofWeight: 0, decayAfterDays: 30 })
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(a))
  })

  it('proof 因子：高访问计数反超', async () => {
    expect(await searchOrder({ recencyWeight: 0, proofWeight: 1, decayAfterDays: 30 })).toEqual([b, a])
  })

  it('缺省不加 boost（openKyzmemStore 不传选项时保持旧排序）', async () => {
    const store = await openKyzmemStore(path)
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    await store.close()
    expect(result.hits.map(hit => hit.record.id)).toEqual([a, b])
  })
})
