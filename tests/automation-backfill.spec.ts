import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedHistoryRules } from '../src/config.ts'
import { runHistoryBackfill } from '../src/ingest/history.ts'
import type { HistoryBackfillDeps, HistoryBackfillRules, HistoryLogSource, HistoryRunResult } from '../src/ingest/history.ts'
import { maybeRunIncrementalBackfill } from '../src/maintenance/scheduler.ts'
import type { MaintenanceBudget } from '../src/maintenance/scheduler.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'

const DEFAULTS: ResolvedHistoryRules = {
  days: 7,
  maxTurnsPerSession: 20,
  maxTotalTurns: 200,
  includeSubagents: false,
  includeSeeded: false,
  includeNoCwd: false,
}

let dir: string
const stores = new Map<string, KyzmemStore>()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-auto-backfill-'))
  stores.clear()
})

afterEach(async () => {
  for (const store of stores.values()) await store.close()
  stores.clear()
})

async function storeFor(key: string): Promise<KyzmemStore> {
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  const created = await openKyzmemStore(join(dir, `${key}.db`))
  stores.set(key, created)
  return created
}

const PAD = '这是一段足够长的具体描述，用来让活动评分达到节流阈值。'.repeat(12)

const turnEvents = (turn: number): unknown[] => [
  { type: 'turn/start', data: { turn }, seq: turn * 100, time: Date.now() },
  { type: 'user/message', data: { content: [{ type: 'text', text: `第 ${turn} 轮：${PAD}` }] }, seq: turn * 100 + 1, time: Date.now() },
  { type: 'assistant/message', data: { content: [{ type: 'text', text: '回答一' }] }, seq: turn * 100 + 2, time: Date.now() },
]

function makeSource(): HistoryLogSource {
  const header = { id: 's1', createdAt: Date.now() - 1000, cwd: '/repo/a' }
  return {
    list: async () => [header],
    load: async () => ({ events: [1, 2, 3, 4, 5].flatMap(turnEvents) }),
  }
}

/** 依赖装配：call 恒抛错，模拟辅助模型持续不可用。 */
function makeDeps(source: HistoryLogSource): HistoryBackfillDeps {
  return {
    source,
    resolveStore: key => storeFor(key),
    openUserStore: () => storeFor('user'),
    resolveExistingUserStore: async () => stores.get('user'),
    embedder: Promise.resolve(undefined),
    mode: 'light',
    routeOverride: { provider: 'deepseek', model: 'deepseek-v4' },
    call: async () => { throw new Error('llm down') },
    logRequest: () => undefined,
  }
}

const BUDGET: MaintenanceBudget = { ms: 1500, items: 50, llmCalls: 1 }

function doneResult(overrides: Partial<HistoryRunResult> = {}): HistoryRunResult {
  return {
    state: 'done', sessionsTotal: 1, sessionsDone: 1, turnsPlanned: 1, turnsDone: 1,
    memoriesWritten: 0, turnsSkipped: 0, turnsFailed: 0, skipReasons: {}, failures: [],
    ...overrides,
  }
}

describe('runHistoryBackfill 连败熔断（Phase 4）', () => {
  it('不传熔断选项时跑完全部轮次（行为不变）', async () => {
    const result = await runHistoryBackfill(makeDeps(makeSource()), DEFAULTS, {}, () => undefined, new AbortController().signal)
    expect(result.state).toBe('done')
    expect(result.turnsDone).toBe(5)
    expect(result.turnsFailed).toBe(5)
  })
  it('连败 3 次即停，state=failed', async () => {
    const result = await runHistoryBackfill(
      makeDeps(makeSource()), DEFAULTS, {}, () => undefined, new AbortController().signal,
      { maxConsecutiveFailures: 3 },
    )
    expect(result.state).toBe('failed')
    expect(result.turnsDone).toBe(3)
    expect(result.turnsFailed).toBe(3)
  })
})

describe('maybeRunIncrementalBackfill（Phase 4，每日/配额/暂停/减载）', () => {
  it('减载档与零 LLM 预算直接跳过，不调 runner', async () => {
    const store = await storeFor('user')
    let calls = 0
    const backfill = { run: async () => { calls += 1; return doneResult() }, defaults: DEFAULTS }
    expect((await maybeRunIncrementalBackfill(store, backfill, BUDGET, { idle: true })).outcome).toBe('skipped-idle')
    expect((await maybeRunIncrementalBackfill(store, backfill, { ...BUDGET, llmCalls: 0 })).outcome).toBe('skipped-no-budget')
    expect(calls).toBe(0)
  })
  it('每日只跑一次：配额取 min(budget.items, 配置 maxTotalTurns)', async () => {
    const store = await storeFor('user')
    const seen: HistoryBackfillRules[] = []
    const backfill = {
      run: async (rules: HistoryBackfillRules) => { seen.push(rules); return doneResult({ turnsDone: 2, memoriesWritten: 1 }) },
      defaults: DEFAULTS,
    }
    const first = await maybeRunIncrementalBackfill(store, backfill, BUDGET)
    expect(first.outcome).toBe('ran')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.days).toBe(7)
    expect(seen[0]?.maxTotalTurns).toBe(50)
    const second = await maybeRunIncrementalBackfill(store, backfill, BUDGET)
    expect(second.outcome).toBe('skipped-today')
    expect(seen).toHaveLength(1)
  })
  it('breaker 熔断后记暂停，同日内不再跑；新的完成记录清除暂停', async () => {
    const store = await storeFor('user')
    let calls = 0
    const backfill = {
      run: async () => { calls += 1; return doneResult({ state: 'failed', turnsFailed: 3 }) },
      defaults: DEFAULTS,
    }
    expect((await maybeRunIncrementalBackfill(store, backfill, BUDGET)).outcome).toBe('ran')
    expect((await maybeRunIncrementalBackfill(store, backfill, BUDGET)).outcome).toBe('skipped-paused')
    expect(calls).toBe(1)
    // 手动跑通一次（同样记 backfill-run）→ 暂停清除。
    const manual = { run: async () => { calls += 1; return doneResult() }, defaults: DEFAULTS }
    await store.audit('backfill-run', 'BATCH', JSON.stringify({ date: new Date().toISOString().slice(0, 10), manual: true, state: 'done' }))
    expect((await maybeRunIncrementalBackfill(store, manual, BUDGET)).outcome).toBe('skipped-today')
    expect(calls).toBe(1)
  })
})
