import { describe, expect, it } from 'vitest'
import { ruleVerdict } from '../src/automation/conflict-rules.ts'
import { asMemoryId } from '../src/types.ts'
import type { ConflictPair, KyzmemKind, KyzmemScope, MemoryRecord } from '../src/types.ts'

const DAY_MS = 24 * 3600 * 1000

function record(overrides: Partial<Omit<MemoryRecord, 'id'>> & { id: string }): MemoryRecord {
  return {
    scope: 'user',
    kind: 'fact',
    content: 'x',
    importance: 0.5,
    confidence: 0.5,
    status: 'active',
    createdAt: 1_000,
    lastAccessedAt: 1_000,
    accessCount: 0,
    sourceSessionId: null,
    sourceRound: null,
    sourceSeq: null,
    ...overrides,
    id: asMemoryId(overrides.id),
  } as MemoryRecord
}

function pair(left: MemoryRecord, right: MemoryRecord): ConflictPair {
  return { left, right, createdAt: 2_000 } as ConflictPair
}

describe('ruleVerdict', () => {
  it('r-tier: archives the non-confirmed side', () => {
    const left = record({ id: 'a', sourceTier: 'user-confirmed' })
    const right = record({ id: 'b', sourceTier: 'agent-inferred' })
    expect(ruleVerdict(pair(left, right))).toEqual({ action: 'archive-right', ruleId: 'r-tier' })
    expect(ruleVerdict(pair(right, left))).toEqual({ action: 'archive-left', ruleId: 'r-tier' })
  })

  it('r-tier: abstains when both sides are user-confirmed', () => {
    const left = record({ id: 'a', sourceTier: 'user-confirmed' })
    const right = record({ id: 'b', sourceTier: 'user-confirmed' })
    expect(ruleVerdict(pair(left, right)).action).toBe('none')
  })

  it('r-newer: newer wins on same scope/kind with shared entity and clear gaps', () => {
    const scope: KyzmemScope = 'project'
    const kind: KyzmemKind = 'preference'
    const old = record({ id: 'old', scope, kind, createdAt: 1_000, importance: 0.6, confidence: 0.5 })
    const young = record({ id: 'new', scope, kind, createdAt: 1_000 + 40 * DAY_MS, importance: 0.9, confidence: 0.8 })
    const entities = { left: ['  部署流程  '], right: ['部署流程'] }
    expect(ruleVerdict(pair(old, young), entities)).toEqual({ action: 'archive-left', ruleId: 'r-newer' })
  })

  it('r-newer: abstains without shared entities', () => {
    const scope: KyzmemScope = 'project'
    const kind: KyzmemKind = 'decision'
    const old = record({ id: 'old', scope, kind, createdAt: 1_000, importance: 0.5, confidence: 0.5 })
    const young = record({ id: 'new', scope, kind, createdAt: 1_000 + 40 * DAY_MS, importance: 0.9, confidence: 0.9 })
    expect(ruleVerdict(pair(old, young), { left: ['A'], right: ['B'] }).action).toBe('none')
  })

  it('r-newer: abstains when the gaps are too small or the age gap is short', () => {
    const scope: KyzmemScope = 'project'
    const kind: KyzmemKind = 'preference'
    const entities = { left: ['A'], right: ['a'] }
    const old = record({ id: 'old', scope, kind, createdAt: 1_000, importance: 0.7, confidence: 0.7 })
    // 差值不足 0.15。
    const youngClose = record({ id: 'new', scope, kind, createdAt: 1_000 + 40 * DAY_MS, importance: 0.8, confidence: 0.8 })
    expect(ruleVerdict(pair(old, youngClose), entities).action).toBe('none')
    // 年龄差不足 30 天。
    const youngFresh = record({ id: 'new', scope, kind, createdAt: 1_000 + 10 * DAY_MS, importance: 0.9, confidence: 0.9 })
    expect(ruleVerdict(pair(old, youngFresh), entities).action).toBe('none')
  })

  it('abstains across kinds even with everything else matching', () => {
    const old = record({ id: 'old', kind: 'preference', createdAt: 1_000, importance: 0.5, confidence: 0.5 })
    const young = record({ id: 'new', kind: 'fact', createdAt: 1_000 + 40 * DAY_MS, importance: 0.9, confidence: 0.9 })
    expect(ruleVerdict(pair(old, young), { left: ['A'], right: ['A'] }).ruleId).toBe('r-abstain')
  })
})
