import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { StoreAutomation } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { asMemoryId } from '../src/types.ts'
import {
  initialSchedule,
  nextSchedule,
  RELEARN_AFTER_DAYS_DEFAULT,
} from '../src/review/sm2.ts'

/**
 * schema v15 能力测试：时点检索 / TTL 过期 / 来源分级 / 冲突裁决 / 单条硬删 /
 * 审计读数 / 证据引用强化 / decay 减载 / stats 扩展 / SM-2 重学。
 * 这些能力是「面板 12 指标 + 减载档 + 冲突裁决」的数据基础，单测按能力而不是按方法组织。
 */

const DAY = 86_400_000
let dir: string
let path: string
let store: KyzmemStore

const open = (automation?: StoreAutomation): Promise<KyzmemStore> =>
  automation === undefined ? openKyzmemStore(path) : openKyzmemStore(path, undefined, automation)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-v15-'))
  path = join(dir, 'user.db')
  store = await openKyzmemStore(path)
})

afterEach(async () => {
  await store.close()
})

describe('schema v15', () => {
  it('新库版本号 16，nodes 含 5 个新列与 2 个新索引', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    const columns = (db.prepare('PRAGMA table_info(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    const indexes = (db.prepare('PRAGMA index_list(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    db.close()
    expect(version).toBe('16')
    for (const column of ['invalid_at', 'expires_at', 'source_tier', 'last_retrieved_at', 'last_reviewed_at']) {
      expect(columns).toContain(column)
    }
    expect(indexes).toContain('nodes_invalid')
    expect(indexes).toContain('nodes_expires')
  })

  it('v14 旧库重开时 MIGRATIONS[14] 补列建索引，并把两个时钟回填到历史值', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: 'v14 时代条目' })
    await store.close()
    const { DatabaseSync } = await import('node:sqlite')
    // 手工把库退回 v14 形态：先删索引（列被索引引用时 DROP COLUMN 会失败），再删列，最后降版本号。
    const raw = new DatabaseSync(path)
    raw.exec('DROP INDEX IF EXISTS nodes_invalid')
    raw.exec('DROP INDEX IF EXISTS nodes_expires')
    for (const column of ['invalid_at', 'expires_at', 'source_tier', 'last_retrieved_at', 'last_reviewed_at']) {
      raw.exec(`ALTER TABLE nodes DROP COLUMN ${column}`)
    }
    raw.prepare("UPDATE meta SET value = '14' WHERE key = 'schema_version'").run()
    raw.close()

    store = await openKyzmemStore(path)
    const migrated = await store.get(record.id)
    // 两个时钟的回填口径：检索时钟 = created_at，复习时钟 = last_accessed_at（迁移前的「最后访问」）。
    expect(migrated?.sourceTier).toBe('agent-inferred')
    expect(migrated?.lastRetrievedAt).toBe(record.createdAt)
    expect(migrated?.lastReviewedAt).toBe(record.lastAccessedAt)
    expect(migrated?.invalidAt).toBeUndefined()
    expect(migrated?.expiresAt).toBeUndefined()

    const check = new DatabaseSync(path)
    const version = (check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }).value
    const indexes = (check.prepare('PRAGMA index_list(nodes)').all() as unknown as { name: string }[]).map(row => row.name)
    check.close()
    expect(version).toBe('16')
    expect(indexes).toContain('nodes_invalid')
    expect(indexes).toContain('nodes_expires')
  })

  it('sourceTier 缺省为 agent-inferred；显式 sourceTier 原样落库', async () => {
    const inferred = await store.write({ scope: 'user', kind: 'fact', content: '推断出来的事实' })
    const confirmed = await store.write({ scope: 'user', kind: 'fact', content: '用户亲口确认', sourceTier: 'user-confirmed' })
    const tool = await store.write({ scope: 'user', kind: 'fact', content: '工具输出', sourceTier: 'tool-output' })
    expect(inferred.sourceTier).toBe('agent-inferred')
    expect(confirmed.sourceTier).toBe('user-confirmed')
    // 缺省语义（契约 §2）：未给 sourceTier 的写入必须是 agent-inferred，不能是 undefined，
    // 否则下游「是否可信」判断会拿到空洞。
    expect((await store.get(tool.id))?.sourceTier).toBe('tool-output')
    // 不过滤时三条都在。
    expect((await store.list({ scope: 'user', limit: 50, offset: 0 })).records).toHaveLength(3)
  })

  it('confirmedOnly 是严格口径：只回 user-confirmed，agent-inferred 不计入', async () => {
    const inferred = await store.write({ scope: 'user', kind: 'fact', content: '推断出来的事实' })
    const confirmed = await store.write({ scope: 'user', kind: 'fact', content: '用户亲口确认', sourceTier: 'user-confirmed' })

    // 面板「仅看已确认」chip 的语义 = 用户显式确认过（kyzmem_save/kyzmem_facts 显式保存写入
    // user-confirmed），不是 injectTiers/isTrustedTier 的「注入时可信」宽口径。
    const listed = await store.list({ scope: 'user', confirmedOnly: true, limit: 50, offset: 0 })
    expect(listed.records.map(record => record.id)).toEqual([confirmed.id])
    expect(listed.total).toBe(1)
    expect(listed.records.map(record => record.id)).not.toContain(inferred.id)

    // stats().byTier 各 tier 独立计数，不做「受信/非受信」合并。
    const byTier = (await store.stats()).byTier ?? {}
    expect(byTier['user-confirmed']).toBe(1)
    expect(byTier['agent-inferred']).toBe(1)
  })

  it('TTL：显式 expiresAt 过期后仍可命中但标 expired 并降权；ttlDaysByKind 自动折算', async () => {
    const expiredAt = Date.now() - 1000
    const stale = await store.write({ scope: 'user', kind: 'fact', content: '过期条目海港', expiresAt: expiredAt })
    expect(stale.expiresAt).toBe(expiredAt)
    const result = await store.search({ text: '海港', scopes: ['user'] }, undefined)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.expired).toBe(true)
    const stats = await store.stats()
    expect(stats.expired).toBe(1)
    // 显式 expiresAt 覆盖 ttlDaysByKind：同一 kind 下显式优先。
    await store.close()
    store = await open({ autoSlot: true, reviewScheduling: false, ttlDaysByKind: { fact: 2 } })
    const auto = await store.write({ scope: 'user', kind: 'fact', content: '按 kind 折算 TTL' })
    expect(auto.expiresAt).toBeDefined()
    expect(auto.expiresAt! - auto.createdAt).toBe(2 * DAY)
    // kind 不在 TTL 表里 = 永不过期（列留 NULL，record 上缺省）。
    const forever = await store.write({ scope: 'user', kind: 'skill', content: '不过期技能' })
    expect(forever.expiresAt).toBeUndefined()
  })
})

describe('时点检索（asOf）', () => {
  it('update 后旧条目被打上 invalid_at；asOf 还原当时快照，默认视图只看新版', async () => {
    const first = await store.write({ scope: 'user', kind: 'fact', content: '端口是 4000 甲' })
    const snapshotAt = first.createdAt
    // 让新旧条目至少差 1ms，避免同毫秒创建导致 asOf 边界不稳。
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = await store.update({ id: first.id, scope: 'user', kind: 'fact', content: '端口是 5000 乙' })

    const old = await store.get(first.id)
    expect(old?.status).toBe('archived')
    expect(old?.invalidAt).toBeDefined()
    expect(old!.invalidAt!).toBeGreaterThan(snapshotAt)

    // 当时：新版还不存在，旧版仍有效。
    const then = await store.search({ text: '端口', scopes: ['user'], asOf: snapshotAt }, undefined)
    expect(then.hits.map(hit => hit.record.id)).toEqual([first.id])
    // 现在：旧版已失效，只剩新版。
    const now = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    expect(now.hits.map(hit => hit.record.id)).toEqual([second.id])
  })

  it('supersedeMany 给全部旧条打 invalid_at（不是只改 status）', async () => {
    const older = await store.write({ scope: 'user', kind: 'fact', content: '旧结论甲' })
    const newer = await store.supersedeMany(
      { scope: 'user', kind: 'fact', content: '新结论乙' },
      [older.id],
    )
    expect((await store.get(older.id))?.invalidAt).toBeDefined()
    expect((await store.get(older.id))?.status).toBe('archived')
    // 新条不打 invalid_at。
    expect(newer.invalidAt).toBeUndefined()
    expect((await store.stats()).invalidated).toBe(1)
  })
})

describe('检索通道统计与关系扩展', () => {
  it('返回 fts/vector/graph 三道统计；无查询向量时向量道 degraded', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '端口配置说明' })
    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    expect(result.channels?.map(stat => stat.channel)).toEqual(['fts', 'vector', 'graph'])
    const fts = result.channels!.find(stat => stat.channel === 'fts')!
    expect(fts.hits).toBe(1)
    expect(fts.degraded).toBe(false)
    const vector = result.channels!.find(stat => stat.channel === 'vector')!
    expect(vector.degraded).toBe(true)
    expect(vector.hits).toBe(0)
  })

  it('supports 邻居经 graph 道引入；contradicts 只进 cues 不计分', async () => {
    const main = await store.write({ scope: 'user', kind: 'fact', content: '端口主配置' })
    const support = await store.write({ scope: 'user', kind: 'fact', content: '补充说明没有关键词' })
    const rival = await store.write({ scope: 'user', kind: 'fact', content: '端口另一套说法' })
    await store.linkEdge(main.id, support.id, 'supports')
    await store.linkEdge(main.id, rival.id, 'contradicts')

    const result = await store.search({ text: '端口', scopes: ['user'] }, undefined)
    const supportHit = result.hits.find(hit => hit.record.id === support.id)
    expect(supportHit?.via).toBe('graph')
    expect(supportHit?.viaEdge).toEqual({ from: main.id, type: 'supports' })
    // contradicts 边两端都命中时，只各自挂 cues.contradicts 提示，不额外提分。
    const mainHit = result.hits.find(hit => hit.record.id === main.id)
    expect(mainHit?.cues?.contradicts).toContain(rival.id)
    expect(result.channels!.find(stat => stat.channel === 'graph')!.hits).toBe(1)
  })
})

describe('冲突裁决（listConflicts / resolveConflict）', () => {
  it('列出 contradicts 边两端；keep-left 归档右端、删边并写 conflict-resolve 审计', async () => {
    const left = await store.write({ scope: 'user', kind: 'fact', content: '端口 4000' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '端口 5000' })
    await store.linkEdge(left.id, right.id, 'contradicts')

    const conflicts = await store.listConflicts(['user'], 10)
    expect(conflicts.total).toBe(1)
    expect(conflicts.items[0]!.left.id).toBe(left.id)
    expect(conflicts.items[0]!.right.id).toBe(right.id)
    expect(conflicts.items[0]!.createdAt).toBeGreaterThan(0)

    await store.resolveConflict(left.id, right.id, 'keep-left')
    // 边解除后不再是待裁决冲突。
    expect((await store.listConflicts(['user'], 10)).total).toBe(0)
    // 输家归档但保留（可审计），赢家仍 active。
    expect((await store.get(right.id))?.status).toBe('archived')
    expect((await store.get(left.id))?.status).toBe('active')
    expect(await store.countAudit('conflict-resolve', 0)).toBe(1)
    const auditRows = await store.recentAudit('conflict-resolve', 5)
    expect(JSON.parse(auditRows[0]!.detail!)).toEqual({ left: left.id, right: right.id, action: 'keep-left' })
  })

  it('drop-both 两端都归档，keep-both 只解除冲突', async () => {
    const left = await store.write({ scope: 'user', kind: 'fact', content: '甲说 4000' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '乙说 5000' })
    await store.linkEdge(left.id, right.id, 'contradicts')
    await store.resolveConflict(left.id, right.id, 'keep-both')
    expect((await store.get(left.id))?.status).toBe('active')
    expect((await store.get(right.id))?.status).toBe('active')
    expect((await store.listConflicts(['user'], 10)).total).toBe(0)

    await store.linkEdge(left.id, right.id, 'contradicts')
    await store.resolveConflict(left.id, right.id, 'drop-both')
    expect((await store.get(left.id))?.status).toBe('archived')
    expect((await store.get(right.id))?.status).toBe('archived')
  })
})

describe('单条硬删（purgeOne）', () => {
  it('删节点、FTS、边与路线站点；不存在时返回 false', async () => {
    const keep = await store.write({ scope: 'user', kind: 'fact', content: '保留的条目' })
    const drop = await store.write({ scope: 'user', kind: 'fact', content: '独有词甲即将消失' })
    await store.linkEdge(keep.id, drop.id, 'related')
    expect((await store.stats()).edges).toBe(1)

    expect(await store.purgeOne(drop.id)).toBe(true)
    expect(await store.get(drop.id)).toBeUndefined()
    expect(await store.get(keep.id)).toBeDefined()
    expect((await store.stats()).edges).toBe(0)
    // FTS 同步删除：被删条目的独有词再也检索不到。
    expect((await store.search({ text: '独有词甲', scopes: ['user'] }, undefined)).hits).toHaveLength(0)
    // 硬删留一条 tombstone 审计（只记元信息，不记正文）。
    expect(await store.countAudit('tombstone', 0)).toBe(1)
    expect(await store.purgeOne(drop.id)).toBe(false)
  })
})

describe('审计读数', () => {
  it('countAudit / recentAudit（可按 targetId 过滤）/ lastAuditAt', async () => {
    await store.audit('pending-ingest', 'round-1', '{"n":1}')
    await store.audit('pending-ingest', 'round-2', '{"n":2}')
    await store.audit('other', 'round-1', null)
    expect(await store.countAudit('pending-ingest', 0)).toBe(2)
    expect(await store.countAudit('pending-ingest', Date.now() + 1)).toBe(0)

    const recent = await store.recentAudit('pending-ingest', 10)
    expect(recent).toHaveLength(2)
    // 时间倒序（op_log 自增 seq 倒序）：最后写的最前。
    expect(recent[0]!.targetId).toBe('round-2')
    const byTarget = await store.recentAudit('pending-ingest', 10, 'round-1')
    expect(byTarget).toHaveLength(1)
    expect(byTarget[0]!.detail).toBe('{"n":1}')

    expect(await store.lastAuditAt('pending-ingest')).toBeGreaterThan(0)
    expect(await store.lastAuditAt('never-written')).toBeUndefined()
  })
})

describe('证据引用强化（reinforceCitation）', () => {
  it('只提 confidence，不动访问计数与检索时钟', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '被引用的证据' })
    expect(record.accessCount).toBe(0)
    await store.reinforceCitation(record.id, 0.1)
    const after = await store.get(record.id)
    expect(after?.confidence).toBeCloseTo(record.confidence + 0.1, 5)
    expect(after?.accessCount).toBe(0)
    expect(after?.lastRetrievedAt).toBe(record.lastRetrievedAt)
    // 缺省 delta=0.02；缺失 id 静默不抛错（引用可能来自并发删除）。
    await store.reinforceCitation(record.id)
    expect((await store.get(record.id))?.confidence).toBeCloseTo(record.confidence + 0.12, 5)
    await expect(store.reinforceCitation(asMemoryId('missing-id'))).resolves.toBeUndefined()
  })
})

describe('衰减减载（decay limit）', () => {
  it('limit 限制单次归档条数，其余留待下轮', async () => {
    const ids: string[] = []
    for (const content of ['甲', '乙', '丙']) ids.push((await store.write({ scope: 'user', kind: 'fact', content })).id)
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    const staleAt = Date.now() - 40 * DAY
    raw.prepare('UPDATE nodes SET last_accessed_at = ?, last_reviewed_at = ?, next_review_at = NULL').run(staleAt, staleAt)
    raw.close()

    expect(await store.decay({ olderThanDays: 30, limit: 2 })).toBe(2)
    expect((await store.stats()).active).toBe(1)
    expect(await store.decay({ olderThanDays: 30, limit: 2 })).toBe(1)
    expect((await store.stats()).active).toBe(0)
  })
})

describe('stats 扩展指标', () => {
  it('expired / invalidated / byTier / openConflicts / dueCount 全部可读', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '确认过', sourceTier: 'user-confirmed' })
    await store.write({ scope: 'user', kind: 'fact', content: '工具读到的', sourceTier: 'tool-output', expiresAt: Date.now() - 1 })
    const old = await store.write({ scope: 'user', kind: 'fact', content: '会被取代' })
    await store.supersedeMany({ scope: 'user', kind: 'fact', content: '取代它' }, [old.id])
    const left = await store.write({ scope: 'user', kind: 'fact', content: '冲突左' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '冲突右' })
    await store.linkEdge(left.id, right.id, 'contradicts')

    const stats = await store.stats()
    const byTier = stats.byTier ?? {}
    expect(stats.expired).toBe(1)
    expect(stats.invalidated).toBe(1)
    expect(byTier['user-confirmed']).toBe(1)
    expect(byTier['tool-output']).toBe(1)
    // 其余 4 条是缺省来源（旧条 + 取代新条 + 冲突左右）。
    expect(byTier['agent-inferred']).toBe(4)
    expect(stats.openConflicts).toBe(1)
    // 写入期自动排期让新条今天之后到期，dueCount 只数已到期的。
    expect(stats.dueCount).toBe(0)
    // 老字段语义不变。
    expect(stats.total).toBe(6)
    expect(stats.active).toBe(5)
    expect(stats.archived).toBe(1)
  })
})

describe('SM-2 重学（nextSchedule relearning）', () => {
  it('逾期超过重学窗口后答对：reps 清零、间隔回 1 天', () => {
    const t0 = 1_700_000_000_000
    const overdue = { ...initialSchedule(t0), intervalDays: 60, reps: 5 }
    // nextReviewAt 设为窗口之外（默认 30 天，这里逾期 40 天）。
    const state = { ...overdue, nextReviewAt: t0 - 40 * DAY }
    const next = nextSchedule(4, state, t0)
    expect(next.reps).toBe(0)
    expect(next.intervalDays).toBe(1)
    expect(next.nextReviewAt).toBe(t0 + DAY)
    // ease 不罚（答对是正信号，只是间隔重置）。
    expect(next.easeFactor).toBeGreaterThanOrEqual(state.easeFactor)
  })

  it('窗口内的按期通过不受影响；窗口可注入', () => {
    const t0 = 1_700_000_000_000
    const onTime = { ...initialSchedule(t0), nextReviewAt: t0 - 2 * DAY, intervalDays: 6, reps: 2 }
    const normal = nextSchedule(5, onTime, t0)
    expect(normal.reps).toBe(3)
    expect(normal.intervalDays).toBe(Math.max(1, Math.round(6 * onTime.easeFactor)))

    // 自定义窗口 1 天：逾期 2 天即触发重学。
    const relearned = nextSchedule(5, onTime, t0, 1)
    expect(relearned.reps).toBe(0)
    expect(relearned.intervalDays).toBe(1)
    expect(RELEARN_AFTER_DAYS_DEFAULT).toBe(30)
  })

  it('失败分支优先于重学判定（grade < 3 一律回 1 天且 reps 清零）', () => {
    const t0 = 1_700_000_000_000
    const state = { ...initialSchedule(t0), nextReviewAt: t0 - 90 * DAY, intervalDays: 30, reps: 4 }
    const next = nextSchedule(1, state, t0)
    expect(next.reps).toBe(0)
    expect(next.intervalDays).toBe(1)
    // 失败要罚 ease（与重学不同）。
    expect(next.easeFactor).toBeLessThan(state.easeFactor)
  })
})

describe('scheduleReview 接入重学窗口', () => {
  it('逾期 40 天后答对 5 分：reps 归零、间隔 1 天', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '久未复习的条目' })
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE nodes SET next_review_at = ?, review_reps = 4, interval_days = 30 WHERE id = ?')
      .run(Date.now() - 40 * DAY, record.id)
    raw.close()
    const scheduled = await store.scheduleReview(record.id, 5)
    expect(scheduled?.review?.reps).toBe(0)
    expect(scheduled?.review?.intervalDays).toBe(1)
  })
})

describe('检索副作用控制（touch / auditMode / auditQuery / markRetrieved）', () => {
  it('touch:false 不强化命中，但 recall 审计照写', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '只读检索的条目', confidence: 0.5 })
    const before = await store.get(record.id)
    const result = await store.search({ text: '只读检索', scopes: ['user'], touch: false }, undefined)
    expect(result.hits.map(hit => hit.record.id)).toEqual([record.id])

    const after = await store.get(record.id)
    expect(after?.accessCount).toBe(before?.accessCount)
    expect(after?.confidence).toBeCloseTo(before!.confidence, 5)
    expect(after?.lastRetrievedAt).toBe(before?.lastRetrievedAt)

    // 审计与 touch 解耦：不强化也要留下「召回过什么」，否则自动召回不可观测（评审 M4）。
    expect(await store.countAudit('recall', 0)).toBe(1)
    const detail = JSON.parse((await store.recentAudit('recall', 1))[0]!.detail!) as { ids: string[]; mode: string }
    expect(detail.ids).toEqual([record.id])
    expect(detail.mode).toBe('search')
  })

  it('缺省 touch=true 仍强化（access_count+1 / confidence+0.05）', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '默认强化条目', confidence: 0.5 })
    await store.search({ text: '默认强化', scopes: ['user'] }, undefined)
    const after = await store.get(record.id)
    expect(after?.accessCount).toBe(1)
    expect(after?.confidence).toBeCloseTo(0.55, 5)
  })

  it('auditMode 落库：自动召回与工具检索可区分', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '审计模式条目' })
    await store.search({ text: '审计模式', scopes: ['user'], auditMode: 'query-recall' }, undefined)
    const auto = JSON.parse((await store.recentAudit('recall', 1))[0]!.detail!) as { mode: string }
    expect(auto.mode).toBe('query-recall')
    // 缺省保持旧行为 'search'（不破坏既有指标与测试）。
    await store.search({ text: '审计模式', scopes: ['user'] }, undefined)
    const tool = JSON.parse((await store.recentAudit('recall', 1))[0]!.detail!) as { mode: string }
    expect(tool.mode).toBe('search')
  })

  it('auditQuery：raw 默认存原文；hash 只存 16 位哈希；none 都不存', async () => {
    // 查询必须命中至少一条（否则不会写 recall 审计）：正文同时含命中词与密钥。
    const queryText = '隐私审计条目 sk-abcdefghijklmnop'
    const secret = 'sk-abcdefghijklmnop'
    await store.write({ scope: 'user', kind: 'fact', content: '隐私审计条目' })

    await store.search({ text: queryText, scopes: ['user'] }, undefined)
    const raw = JSON.parse((await store.recentAudit('recall', 1))[0]!.detail!) as { query?: string; queryHash?: string }
    expect(raw.query).toBe(queryText)

    await store.search({ text: queryText, scopes: ['user'], auditQuery: 'hash' }, undefined)
    const hashed = JSON.parse((await store.recentAudit('recall', 1))[0]!.detail!) as { query?: string; queryHash?: string }
    expect(hashed.query).toBeUndefined()
    expect(hashed.queryHash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(hashed)).not.toContain(secret)

    await store.search({ text: queryText, scopes: ['user'], auditQuery: 'none' }, undefined)
    const none = JSON.parse((await store.recentAudit('recall', 1))[0]!.detail!) as { query?: string; queryHash?: string }
    expect(none.query).toBeUndefined()
    expect(none.queryHash).toBeUndefined()
    expect(JSON.stringify(none)).not.toContain(secret)
  })

  it('markRetrieved 只推进检索时钟与 confidence，不动 access_count', async () => {
    const record = await store.write({ scope: 'user', kind: 'fact', content: '被展示过但没用', confidence: 0.5 })
    expect(record.accessCount).toBe(0)
    const before = record.lastRetrievedAt
    await store.markRetrieved([record.id])

    const after = await store.get(record.id)
    // 关键：access_count 不动——被召回一次就免疫衰减是评审 M6 指出的反馈回路。
    expect(after?.accessCount).toBe(0)
    expect(after?.confidence).toBeCloseTo(0.52, 5)
    expect(after?.lastRetrievedAt).toBeGreaterThanOrEqual(before ?? 0)

    // 空数组 no-op；缺失 id 静默（并发删除时不该炸召回路径）。
    await expect(store.markRetrieved([])).resolves.toBeUndefined()
    await expect(store.markRetrieved([asMemoryId('missing-id')])).resolves.toBeUndefined()
  })
})
