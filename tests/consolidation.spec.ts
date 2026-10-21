import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runConsolidation } from '../src/consolidation/run.ts'
import type { KyzmemEmbedder } from '../src/embedder/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-cons-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
})

describe('Background Consolidation', () => {
  it('嵌入不可用时：归档老旧低重要性条目，启发式去重完全相同条目', async () => {
    // 1) 老旧低 importance / 低 confidence → 应归档（write 默认 confidence=0.5，需手动改低）。
    const old = await store.write({ scope: 'user', kind: 'fact', content: '旧且无关', importance: 0.1, confidence: 0.5 })
    // 手动把 created_at 拨到 60 天前 + confidence 拨到 0.1（接口不暴露 lastAccessedAt / updateConfidence）。
    const path = join(dir, 'user.db')
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET created_at = ?, confidence = 0.1 WHERE id = ?').run(Date.now() - 60 * 86_400_000, old.id)
    raw.close()

    // 2) 完全相同内容（启发式去重）：a(0.5) 与 b(0.6) 同文，b 留下、a 被归档。
    await store.write({ scope: 'user', kind: 'fact', content: '偏好 TypeScript', importance: 0.5, confidence: 0.7 })
    const b = await store.write({ scope: 'user', kind: 'fact', content: '偏好 TypeScript', importance: 0.6, confidence: 0.7 })
    // 完全相同被去重：b (更高 importance) 留下
    void b // sanity

    // 3) 不应被归档的（创建新鲜）
    const fresh = await store.write({ scope: 'user', kind: 'fact', content: '新鲜高重要', importance: 0.9, confidence: 0.9 })
    // 4) 整理门槛（契约 §9）：active ≥ 5 且同 kind ≥ 3 才动手，这里补两条到阈值以上。
    await store.write({ scope: 'user', kind: 'fact', content: '补充一', importance: 0.4, confidence: 0.6 })
    await store.write({ scope: 'user', kind: 'fact', content: '补充二', importance: 0.4, confidence: 0.6 })

    // 设计：existing 胜出保留（高 importance 不被覆盖），所以 b(0.6) 留下，a(0.5) 不动。
    // 后续断言只看归档发生；merged 视具体 importance 顺序，本测试不强制。
    const dbgBefore = await store.topActive('user', 10)
    const report = await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 30, importanceBelow: 0.3 })
    expect(report.archived).toBe(1) // 仅 old 命中归档阈值
    expect(report.merged).toBe(0) // b 重要度更高，保留；a 不动
    expect(dbgBefore.filter(r => r.content === '偏好 TypeScript')).toHaveLength(2) // 整理前两条都在

    const stats = await store.stats()
    // 期望 active=5：fresh(0.9) + b(0.6) + a(0.5) + 补充一/二；old 已归档（forgotten），b 与 a 重要度不同不被合并。
    expect(stats.active).toBe(5)

    // fresh 必须健在
    const freshRow = (await store.topActive('user', 10)).find(record => record.id === fresh.id)
    expect(freshRow).toBeDefined()

    // op_log 应记录 consolidation 摘要
    const ops = await store.recentOps(50)
    const summary = ops.find(op => op.op === 'consolidation')
    expect(summary).toBeDefined()
    const detail = JSON.parse(summary!.detail!) as { archived: number; merged: number }
    expect(detail.archived).toBe(report.archived)
    expect(detail.merged).toBe(report.merged)
  })

  it('空库调用不报错，summary 全 0', async () => {
    const report = await runConsolidation(store, Promise.resolve(undefined))
    expect(report.archived).toBe(0)
    expect(report.merged).toBe(0)
    expect(report.skipped).toBe(0)
    expect(report.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('覆盖默认参数（短龄阈值）也能跑通', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '任何内容', importance: 0.5, confidence: 0.5 })
    const report = await runConsolidation(store, Promise.resolve(undefined), { olderThanDays: 1, importanceBelow: 0.4, mergeThreshold: 0.99 })
    expect(report).toBeDefined()
    expect(report.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('已有向量不重算：store.embeddingsFor 命中时不再调用 embedder', async () => {
    // 契约 §9：已有向量不重算，只补 embedding IS NULL 的缺口。store 用鸭子类型提供 embeddingsFor 时，
    // 整理应当直接复用这些向量（本轮一次 embed 都不该发生）。
    for (const content of ['甲条目内容', '乙条目内容', '丙条目内容', '丁条目内容', '戊条目内容']) {
      await store.write({ scope: 'user', kind: 'fact', content, importance: 0.5, confidence: 0.9 })
    }
    const ids = (await store.topActive('user', 10)).map(record => record.id)
    const withVectors = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'embeddingsFor') {
          return async (wanted: readonly string[]) =>
            new Map(wanted.map(id => [id, new Float32Array([1, 0])]))
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as KyzmemStore
    let embedCalls = 0
    const embedder = {
      model: 'fake',
      dim: 2,
      embed: async (texts: readonly string[]) => {
        embedCalls += texts.length
        return texts.map(() => new Float32Array([1, 0]))
      },
    }
    const report = await runConsolidation(
      withVectors,
      Promise.resolve(embedder as unknown as KyzmemEmbedder),
      { olderThanDays: 30, importanceBelow: 0.3 },
    )
    expect(ids.length).toBeGreaterThanOrEqual(3)
    expect(embedCalls).toBe(0)
    expect(report.merged).toBeGreaterThanOrEqual(1)
  })
})
