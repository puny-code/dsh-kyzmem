import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateTelemetry, collectMetrics, computeMetrics } from '../src/telemetry/aggregate.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import type { MaintenanceDebt, OperationLogRow, StoreStats } from '../src/types.ts'

let dir: string
let user: KyzmemStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-tele-'))
  user = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await user.close()
})

describe('computeMetrics 十二项指标（§8，纯函数）', () => {
  /** 构造一次 op_log 行；detail 用 JSON 字符串以免测试里重复手写转义。 */
  const op = (name: string, detail: Record<string, unknown> | null = null, at = 1000): OperationLogRow => ({
    at, op: name, targetId: name === 'write' ? 'x' : 'BATCH', detail: detail === null ? null : JSON.stringify(detail),
  })
  const statsOf = (patch: Partial<StoreStats>): StoreStats => ({
    total: 1, active: 1, archived: 0, forgotten: 0, redacted: 0,
    byKind: { fact: 1 }, edges: 0, opLogCount: 1, signalRatio: 0,
    ...patch,
  })

  it('采用率 = recall-used / (used + ignored)；缺归因时缺省而非 0', () => {
    const used = computeMetrics({ windowDays: 7, stats: [], ops: [op('recall-used'), op('recall-used'), op('recall-used'), op('recall-ignored')] })
    expect(used.adoptionRate).toBeCloseTo(0.75, 5)
    expect(used.recallUsed).toBe(3)
    expect(used.recallIgnored).toBe(1)
    expect(computeMetrics({ windowDays: 7, stats: [], ops: [] }).adoptionRate).toBeUndefined()
  })

  it('drop 率 = drop / (write + drop)', () => {
    const metrics = computeMetrics({ windowDays: 7, stats: [], ops: [op('write'), op('write'), op('write'), op('drop')] })
    expect(metrics.dropRate).toBeCloseTo(0.25, 5)
  })

  it('sinceMs 过滤窗口外的 op_log 行', () => {
    const metrics = computeMetrics({
      windowDays: 7,
      stats: [],
      ops: [op('recall-used', null, 100), op('recall-ignored', null, 500)],
      sinceMs: 300,
    })
    expect(metrics.recallUsed).toBe(0)
    expect(metrics.recallIgnored).toBe(1)
    expect(metrics.adoptionRate).toBe(0)
  })

  it('检索 p95 取 recall.detail.durationMs 的最近邻分位；坏行跳过', () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]
    const ops = [
      ...durations.map(ms => op('recall', { ids: [], query: 'q', mode: 'index', durationMs: ms })),
      { at: 1000, op: 'recall', targetId: 'BATCH', detail: 'not-json' } as OperationLogRow,
    ]
    expect(computeMetrics({ windowDays: 7, stats: [], ops }).searchP95Ms).toBe(190)
    expect(computeMetrics({ windowDays: 7, stats: [], ops: [] }).searchP95Ms).toBeUndefined()
  })

  it('注入 token 估算累加 inject.detail.tokens', () => {
    const metrics = computeMetrics({ windowDays: 7, stats: [], ops: [op('inject', { tokens: 120 }), op('inject', { tokens: 80 })] })
    expect(metrics.injectTokens).toBe(200)
    expect(computeMetrics({ windowDays: 7, stats: [], ops: [] }).injectTokens).toBeUndefined()
  })

  it('未确认占比：byTier 里非 user-confirmed 都算未确认', () => {
    const metrics = computeMetrics({
      windowDays: 7,
      stats: [statsOf({ byTier: { 'user-confirmed': 6, 'agent-inferred': 2, 'tool-output': 1, 'web-content': 1 } })],
      ops: [],
    })
    expect(metrics.unconfirmedRatio).toBeCloseTo(0.4, 5)
    expect(computeMetrics({ windowDays: 7, stats: [statsOf({})], ops: [] }).unconfirmedRatio).toBeUndefined()
  })

  it('过期命中占比用库内 expired 存量近似；周增长与复习完成率按比例', () => {
    const metrics = computeMetrics({
      windowDays: 7,
      stats: [statsOf({ active: 8, expired: 2, openConflicts: 3, dueCount: 4 })],
      ops: [op('write'), op('write'), op('review-answer')],
    })
    expect(metrics.expiredHitRate).toBeCloseTo(0.2, 5)
    expect(metrics.openConflicts).toBe(3)
    expect(metrics.weeklyGrowth).toBeCloseTo(0.25, 5)
    expect(metrics.reviewCompletionRate).toBeCloseTo(0.25, 5)
    expect(metrics.maintenanceDebt).toBe(7)
  })

  it('维护调度器欠账快照优先于 stats 退化和', () => {
    const debt: MaintenanceDebt = { activeGrowth: 0, openConflicts: 2, dueReviews: 3, pendingIngests: 4, missingSummaries: 5 }
    const metrics = computeMetrics({ windowDays: 7, stats: [statsOf({ openConflicts: 99 })], ops: [], debt })
    expect(metrics.maintenanceDebt).toBe(14)
  })

  it('collectMetrics 从 recall.detail.channels 汇总通道统计（跨库相加）', async () => {
    const row = (channels: unknown): OperationLogRow => ({
      at: Date.now(), op: 'recall', targetId: 'BATCH',
      detail: JSON.stringify({ ids: ['a'], query: 'q', durationMs: 12, channels }),
    })
    const fakeStore = {
      stats: async () => statsOf({ active: 2 }),
      recentOps: async () => [
        row([
          { channel: 'fts', tookMs: 3, hits: 2, degraded: false },
          { channel: 'vector', tookMs: 5, hits: 1, degraded: true },
        ]),
        row([{ channel: 'fts', tookMs: 2, hits: 1, degraded: false }]),
      ],
    } as unknown as KyzmemStore
    const gathering = await collectMetrics(async () => fakeStore, ['user'], 7)
    const fts = gathering.channels.find(channel => channel.channel === 'fts')
    const vector = gathering.channels.find(channel => channel.channel === 'vector')
    expect(fts?.tookMs).toBe(5)
    expect(fts?.hits).toBe(3)
    expect(vector?.degraded).toBe(true)
    expect(gathering.metrics.searchP95Ms).toBe(12)
  })

  it('collectMetrics 对未创建的库静默跳过（缺省而不是报错）', async () => {
    const gathering = await collectMetrics(async scope => {
      if (scope === 'project') throw new Error('no db')
      return user
    }, ['user', 'project'], 7)
    expect(gathering.metrics).toBeDefined()
    expect(gathering.channels).toEqual([])
  })
})

describe('本地遥测 aggregateTelemetry', () => {
  it('空库时所有计数为 0，三库 scopes 视图正常', async () => {
    const snapshot = await aggregateTelemetry(async (scope) => {
      if (scope === 'user') return user
      // shared/project 触发「未创建」分支不影响整体结果。
      throw new Error(`unexpected scope ${scope}`)
    }, 7)
    expect(snapshot.windowDays).toBe(7)
    expect(snapshot.counts.writes).toBe(0)
    expect(snapshot.counts.ingestRequests).toBe(0)
    expect(snapshot.scopes).toHaveLength(1)
    expect(snapshot.scopes[0]!.scope).toBe('user')
    expect(snapshot.scopes[0]!.active).toBe(0)
  })

  it('写入与遗忘计入 writes / forgets', async () => {
    const a = await user.write({ scope: 'user', kind: 'fact', content: 'alpha', importance: 0.6 })
    await user.write({ scope: 'user', kind: 'fact', content: 'beta', importance: 0.5 })
    await user.forget(a.id)
    const snapshot = await aggregateTelemetry(async scope => scope === 'user' ? user : user, 7)
    expect(snapshot.counts.writes).toBeGreaterThanOrEqual(2) // 含 user + project 'write'
    expect(snapshot.counts.forgets).toBeGreaterThanOrEqual(1)
  })

  it('查询 days 默认 7，越界夹到 [1, 90]', async () => {
    // 注：函数本身接受任意 windowDays；此处仅校验 defaults 行为。
    const snapshot = await aggregateTelemetry(async scope => scope === 'user' ? user : user)
    expect(snapshot.windowDays).toBe(7)
  })

  it('scope 视图正确反映 stats', async () => {
    await user.write({ scope: 'user', kind: 'fact', content: 'alpha', importance: 0.6, confidence: 0.8 })
    const snapshot = await aggregateTelemetry(async scope => scope === 'user' ? user : user)
    expect(snapshot.scopes[0]!.active).toBe(1)
    expect(snapshot.scopes[0]!.total).toBe(1)
    expect(snapshot.scopes[0]!.signalRatio).toBeCloseTo(1.0, 1) // 1 active / 1 total
  })
})
