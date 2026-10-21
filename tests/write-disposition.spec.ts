import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  MERGE_COSINE,
  NEAR_DUPLICATE_COSINE,
  applyWriteDefaults,
  decideWrite,
  resolveWriteExpiresAt,
} from '../src/write-disposition.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import type { MemoryRecord, WriteInput } from '../src/types.ts'

/**
 * 写入分流（第四态）+ 写入期 TTL/tier 缺省的单测。
 * 这里用最小假 store：只实现 decideWrite 会碰到的 nearestNeighbor / audit，其余方法不该被调用。
 */
function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'node-1' as unknown as MemoryRecord['id'],
    scope: 'user',
    kind: 'fact',
    content: '既有的条目内容',
    importance: 0.5,
    confidence: 0.7,
    status: 'active',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    sourceSessionId: null,
    sourceRound: null,
    sourceSeq: null,
    ...overrides,
  }
}

function fakeStore(nearest: { record: MemoryRecord; similarity: number } | undefined): {
  store: KyzmemStore
  audits: { op: string; targetId: string; detail: string | null }[]
} {
  const audits: { op: string; targetId: string; detail: string | null }[] = []
  const store = {
    nearestNeighbor: async () => nearest,
    audit: async (op: string, targetId: string, detail: string | null) => {
      audits.push({ op, targetId, detail })
    },
  } as unknown as KyzmemStore
  return { store, audits }
}

describe('decideWrite near-duplicate 第四态', () => {
  it('跨 kind 且余弦 ≥ 0.98 → drop(near-duplicate)，并写带 cosine 的 op_log', async () => {
    const { store, audits } = fakeStore({ record: makeRecord({ kind: 'decision' }), similarity: NEAR_DUPLICATE_COSINE })
    const decision = await decideWrite(store, 'fact', new Float32Array([1, 0]), { content: '另一条不同措辞的条目' })
    expect(decision).toEqual({ disposition: 'drop', reason: 'near-duplicate' })
    expect(audits).toHaveLength(1)
    expect(audits[0]!.op).toBe('drop')
    const detail = JSON.parse(audits[0]!.detail!) as { reason: string; kind: string; chars: number; cosine: number }
    expect(detail.reason).toBe('near-duplicate')
    expect(detail.kind).toBe('fact')
    expect(detail.cosine).toBeCloseTo(NEAR_DUPLICATE_COSINE, 4)
  })

  it('同 kind 且 ≥ MERGE → 先走 merge（复述强化既有条目，不判近重复丢弃）', async () => {
    const { store, audits } = fakeStore({ record: makeRecord({ kind: 'fact' }), similarity: MERGE_COSINE })
    const decision = await decideWrite(store, 'fact', new Float32Array([1, 0]), { content: '另一条不同措辞的条目' })
    expect(decision.disposition).toBe('merge')
    expect(audits).toHaveLength(0)
  })

  it('跨 kind 但余弦只有 0.95（低于 0.98）→ 不判近重复', async () => {
    const { store, audits } = fakeStore({ record: makeRecord({ kind: 'decision' }), similarity: 0.95 })
    const decision = await decideWrite(store, 'fact', new Float32Array([1, 0]), { content: '另一条不同措辞的条目' })
    expect(decision.disposition).not.toBe('drop')
    expect(audits).toHaveLength(0)
  })

  it('完全相同文本仍优先判 exact-duplicate', async () => {
    const { store } = fakeStore({ record: makeRecord({ content: ' 相同内容 ' }), similarity: 1 })
    const decision = await decideWrite(store, 'fact', new Float32Array([1, 0]), { content: '相同内容' })
    expect(decision).toEqual({ disposition: 'drop', reason: 'exact-duplicate' })
  })
})

describe('写入期 TTL 折算', () => {
  const ttlDaysByKind = { fact: 180, episode: 90, decision: 365, preference: 0, skill: 0 } as const

  it('按 kind 的天数折算 expiresAt', () => {
    const now = 1_700_000_000_000
    expect(resolveWriteExpiresAt('fact', ttlDaysByKind, now)).toBe(now + 180 * DAY_MS)
    expect(resolveWriteExpiresAt('episode', ttlDaysByKind, now)).toBe(now + 90 * DAY_MS)
  })

  it('0 天（偏好/技能）= 不过期，返回 undefined 而不是写入 0', () => {
    expect(resolveWriteExpiresAt('preference', ttlDaysByKind, Date.now())).toBeUndefined()
    expect(resolveWriteExpiresAt('skill', ttlDaysByKind, Date.now())).toBeUndefined()
  })
})

describe('applyWriteDefaults', () => {
  const ttlDaysByKind = { fact: 30, episode: 90, decision: 365, preference: 0, skill: 0 } as const
  const now = 1_700_000_000_000
  const base: WriteInput = { scope: 'user', kind: 'fact', content: '一条事实' }

  it('缺省 sourceTier 补 agent-inferred，expiresAt 按 TTL 折算', () => {
    const next = applyWriteDefaults(base, ttlDaysByKind, now)
    expect(next.sourceTier).toBe('agent-inferred')
    expect(next.expiresAt).toBe(now + 30 * DAY_MS)
  })

  it('显式 sourceTier / expiresAt 不被覆盖', () => {
    const next = applyWriteDefaults(
      { ...base, sourceTier: 'user-confirmed', expiresAt: 42 },
      ttlDaysByKind,
      now,
    )
    expect(next.sourceTier).toBe('user-confirmed')
    expect(next.expiresAt).toBe(42)
  })

  it('不写过期为 0 的 kind：expiresAt 仍为 undefined（不是显式 undefined）', () => {
    const next = applyWriteDefaults({ scope: 'user', kind: 'skill', content: '一条技能' }, ttlDaysByKind, now)
    expect(next.expiresAt).toBeUndefined()
    expect('expiresAt' in next).toBe(false)
  })
})
