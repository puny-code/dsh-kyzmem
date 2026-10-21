import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADOPTION_BOOST_CAP, ADOPTION_CACHE_MS, adoptionFactor, openKyzmemStore } from '../src/store/sqlite.ts'
import type { RankBoostOptions } from '../src/store/sqlite.ts'
import type { MemoryId } from '../src/types.ts'

/**
 * E（v0.12 第三批）：adoption 进排序。
 *
 * 夹具沿用 rank.spec.ts：A 词频更高（纯 RRF 排前），B 词频低。两者的 RRF 分只差 1/61 : 1/62
 * （≈0.984），所以 ±4% 以内的因子就足以翻转顺序——这正好是 adoption 默认权重能产生的量级。
 *
 * 用 {recencyWeight: 0, proofWeight: 0} 把另外两个因子关掉：本 spec 只测 adoption，
 * 混进 recency/proof 会让失败原因变得不可读。
 */
let dir: string
let path: string
let a: MemoryId
let b: MemoryId

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-adoption-'))
  path = join(dir, 'user.db')
  const store = await openKyzmemStore(path)
  a = (await store.write({ scope: 'user', kind: 'fact', content: '端口 端口 配置' })).id
  b = (await store.write({ scope: 'user', kind: 'fact', content: '端口 改动' })).id
  await store.close()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 只开 adoption 因子的 boost 参数（其余权重为 0，权重 0 的因子恒 1）。 */
const adoptionBoost = (weight: number | undefined): RankBoostOptions => ({
  recencyWeight: 0,
  proofWeight: 0,
  decayAfterDays: 30,
  ...(weight === undefined ? {} : { adoptionWeight: weight }),
})

/** 每次开一个新实例检索：adoption 缓存按实例隔离，测试之间互不干扰。 */
const searchOrder = async (boost: RankBoostOptions): Promise<MemoryId[]> => {
  const store = await openKyzmemStore(path, boost)
  try {
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    return result.hits.map(hit => hit.record.id)
  } finally {
    await store.close()
  }
}

/** 直接写采纳审计（与 index.ts 的 auditRecallAdoption 同形状：批次级 {batch, ids}）。 */
const auditAdoption = async (rows: readonly { readonly op: 'recall-used' | 'recall-ignored'; readonly ids: readonly string[] }[]): Promise<void> => {
  const store = await openKyzmemStore(path)
  try {
    for (const [index, row] of rows.entries()) {
      await store.audit(row.op, 'BATCH', JSON.stringify({ batch: `t-${String(index)}`, ids: row.ids }))
    }
  } finally {
    await store.close()
  }
}

describe('adoption 因子（纯函数）', () => {
  it('只对 used 计分：used=0 时恒 1（被忽略不降权、未被展示也不白拿加分）', () => {
    expect(adoptionFactor(undefined, 0.05)).toBe(1)
    expect(adoptionFactor({ used: 0, ignored: 0 }, 0.05)).toBe(1)
    expect(adoptionFactor({ used: 0, ignored: 100 }, 0.05)).toBe(1)
  })

  it('权重 ≤0 关闭；贡献封顶 +10%', () => {
    expect(adoptionFactor({ used: 100, ignored: 0 }, 0)).toBe(1)
    expect(adoptionFactor({ used: 100, ignored: 0 }, -1)).toBe(1)
    // 权重给到 1（远大于封顶）时也只到 +10%。
    expect(adoptionFactor({ used: 1000, ignored: 0 }, 1)).toBeCloseTo(1 + ADOPTION_BOOST_CAP, 10)
  })

  it('ignored 只压低增益斜率，不产生负分', () => {
    const clean = adoptionFactor({ used: 3, ignored: 0 }, 0.05)
    const noisy = adoptionFactor({ used: 3, ignored: 100 }, 0.05)
    expect(clean).toBeGreaterThan(noisy)
    expect(noisy).toBeGreaterThan(1)
  })
})

describe('adoption 进排序（search）', () => {
  it('基线：没有采纳记录时仍是纯 RRF 顺序（A 词频高在前）', async () => {
    expect(await searchOrder(adoptionBoost(0.05))).toEqual([a, b])
  })

  it('used 高条目反超同分条目', async () => {
    await auditAdoption([
      { op: 'recall-used', ids: [String(b)] },
      { op: 'recall-used', ids: [String(b)] },
      { op: 'recall-used', ids: [String(b)] },
    ])
    expect(await searchOrder(adoptionBoost(0.05))).toEqual([b, a])
  })

  it('ignored 只不加分：被忽略的条目不会因此掉到后面，也不会顶到前面', async () => {
    await auditAdoption([
      { op: 'recall-ignored', ids: [String(b)] },
      { op: 'recall-ignored', ids: [String(b)] },
      { op: 'recall-ignored', ids: [String(b)] },
      { op: 'recall-ignored', ids: [String(b)] },
      { op: 'recall-ignored', ids: [String(b)] },
    ])
    expect(await searchOrder(adoptionBoost(0.05))).toEqual([a, b])
  })

  it('权重 0 / 缺省时退化为原排序（即使 used 很高）', async () => {
    await auditAdoption([{ op: 'recall-used', ids: [String(b)] }])
    expect(await searchOrder(adoptionBoost(0))).toEqual([a, b])
    expect(await searchOrder(adoptionBoost(undefined))).toEqual([a, b])
  })

  it('同一 id 的 used 与 ignored 合并计数（互不覆盖）', async () => {
    await auditAdoption([
      { op: 'recall-used', ids: [String(a), String(b)] },
      { op: 'recall-ignored', ids: [String(b)] },
    ])
    const store = await openKyzmemStore(path)
    try {
      const stats = await store.adoptionStats()
      expect(stats.get(String(a))).toEqual({ used: 1, ignored: 0 })
      expect(stats.get(String(b))).toEqual({ used: 1, ignored: 1 })
    } finally {
      await store.close()
    }
  })

  it('坏 detail 行跳过，不影响其余统计', async () => {
    const store = await openKyzmemStore(path)
    try {
      await store.audit('recall-used', 'BATCH', 'not-json')
      await store.audit('recall-used', 'BATCH', JSON.stringify({ batch: 'ok', ids: [String(a)] }))
      const stats = await store.adoptionStats()
      expect(stats.get(String(a))).toEqual({ used: 1, ignored: 0 })
      expect(stats.size).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('adoptionStats 60 秒内复用缓存，过期后重扫', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const store = await openKyzmemStore(path)
    try {
      await store.audit('recall-used', 'BATCH', JSON.stringify({ batch: 'first', ids: [String(b)] }))
      expect((await store.adoptionStats()).get(String(b))?.used).toBe(1)
      // 缓存期内再写一条：仍然只看到 1——说明没有每次重扫（重扫会立刻看到 2）。
      await store.audit('recall-used', 'BATCH', JSON.stringify({ batch: 'second', ids: [String(b)] }))
      expect((await store.adoptionStats()).get(String(b))?.used).toBe(1)
      // 越过 60 秒窗口后重扫，看到 2。
      vi.setSystemTime(new Date(Date.now() + ADOPTION_CACHE_MS + 1000))
      expect((await store.adoptionStats()).get(String(b))?.used).toBe(2)
    } finally {
      await store.close()
    }
  })

  it('缓存按实例隔离：另一个库的连接不会串用本库的采纳计数', async () => {
    await auditAdoption([{ op: 'recall-used', ids: [String(b)] }])
    const first = await openKyzmemStore(path)
    const secondPath = join(dir, 'other.db')
    const second = await openKyzmemStore(secondPath)
    try {
      expect((await first.adoptionStats()).get(String(b))?.used).toBe(1)
      // 另一个库没有任何采纳审计：不能因为同进程里 first 已经扫过就返回同一份 Map。
      expect(await second.adoptionStats()).toEqual(new Map())
    } finally {
      await first.close()
      await second.close()
    }
  })
})
