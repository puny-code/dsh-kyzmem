/**
 * 会话首问 keyed 召回（方案 §4 A + 风险报告必修项）：
 *  - 两个纯判定：该不该跑（会话/压缩门）、首问文本值不值得查（占位句/寒暄/CJK 与西文分档阈值）；
 *  - 召回本体：相关命中 / 信任与过期门 / 去重 / 条数与字符预算 / 单条截断 / 超时 / 单库失败 /
 *    检索词截断 / search 的 touch+audit 契约 / 默认 light 真出 3 条；
 *  - 经真实 apply() + agent/pre-step 的集成：首轮注入、batchId 可被 assess 接受、
 *    只对注入条目 markRetrieved、第二轮不重复、压缩后重注入、陈旧块不复用、占位句跳过、
 *    off 零检索零副作用、adoption 只认 mode=search。
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { messageIn } from '../src/i18n/messages.ts'
import { assessEvidence, evidenceBatches } from '../src/retrieve/evidence.ts'
import {
  QUERY_RECALL_ITEM_CHARS, QUERY_RECALL_MAX_QUERY_CHARS, QUERY_RECALL_TIMEOUT_MS,
  isPlaceholderRequest, runQueryRecall, shouldQueryRecallText, shouldRunQueryRecall,
} from '../src/retrieve/query-recall.ts'
import type { QueryRecallStore } from '../src/retrieve/query-recall.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import { resolveProjectIdentity } from '../src/project/identity.ts'
import type { SearchQuery, SearchResult } from '../src/types.ts'
import { asMemoryId } from '../src/types.ts'

// 嵌入器替身：本文件不测向量道（首问召回按设计只走 FTS），也避免真去下载模型。
vi.mock('../src/embedder/local.ts', () => ({
  createLocalEmbedder: async (): Promise<undefined> => undefined,
}))

const HEADER = messageIn('zh', 'core.recallHeader')
const HEADER_EN = messageIn('en', 'core.recallHeader')
const PLACEHOLDER_ZH = messageIn('zh', 'store.conversationContinues')
const PLACEHOLDER_EN = messageIn('en', 'store.conversationContinues')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-query-recall-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 开一个真实的 user 库（FTS 行为与线上一致，不用替身）。 */
async function openUserStore(name = 'user.db'): Promise<KyzmemStore> {
  return openKyzmemStore(join(dir, name))
}

/** 取召回行（非标题、非尾部两行）。 */
function itemLines(block: string): string[] {
  return block.split('\n').filter(line => line.startsWith('- ['))
}

/** 从块里取第一条 ref（形如 user/#1a2b3c4d）。 */
function firstRef(block: string): string {
  const match = /（((?:user|project)\/#[0-9a-f]{8})）/u.exec(block)
  if (match === null) throw new Error(`no ref in block: ${block}`)
  return match[1]!
}

describe('shouldQueryRecallText（值不值得查）', () => {
  it('占位句直接跳过（无用户文本的 step 不能拿占位句去检索）', () => {
    expect(isPlaceholderRequest(PLACEHOLDER_ZH)).toBe(true)
    expect(isPlaceholderRequest(PLACEHOLDER_EN)).toBe(true)
    expect(shouldQueryRecallText(PLACEHOLDER_ZH, 'zh')).toBe(false)
    expect(shouldQueryRecallText(PLACEHOLDER_EN, 'en')).toBe(false)
  })

  it('CJK 门槛 6 字：中文短问题能过，两字寒暄不能', () => {
    expect(shouldQueryRecallText('如何构建这个项目', 'zh')).toBe(true)
    expect(shouldQueryRecallText('发布流程是什么？', 'zh')).toBe(true)
    expect(shouldQueryRecallText('继续', 'zh')).toBe(false)
    expect(shouldQueryRecallText('构建链呢', 'zh')).toBe(false)
  })

  it('非 CJK 门槛 20 字符：19 个字符不查、20 个字符查', () => {
    expect(shouldQueryRecallText('release flow now?', 'en')).toBe(false)
    expect(shouldQueryRecallText('how do I build this project?', 'en')).toBe(true)
  })

  it('纯寒暄不查（与写入链路 isPureChitchat 同一数据源）', () => {
    // 长度过门槛，但整条就是寒暄 + 标点：走寒暄分支而不是长度分支。
    expect(shouldQueryRecallText('好的！！！！！！！！！！！！', 'zh')).toBe(false)
    expect(shouldQueryRecallText('thank you!!!!!!!!', 'en')).toBe(false)
  })
})

describe('shouldRunQueryRecall（会话/压缩门）', () => {
  it('off 档一律不跑', () => {
    expect(shouldRunQueryRecall({
      agentId: 'a', mode: 'off', recallAgent: null, recallCompactions: null, compactionCount: 0,
    })).toBe(false)
  })

  it('同一 agent 每次会话只做一次', () => {
    expect(shouldRunQueryRecall({
      agentId: 'a', mode: 'light', recallAgent: null, recallCompactions: null, compactionCount: 0,
    })).toBe(true)
    expect(shouldRunQueryRecall({
      agentId: 'a', mode: 'light', recallAgent: 'a', recallCompactions: 0, compactionCount: 0,
    })).toBe(false)
  })

  it('压缩后允许再注入一次（与画像重注入同一判据）', () => {
    expect(shouldRunQueryRecall({
      agentId: 'a', mode: 'light', recallAgent: 'a', recallCompactions: 0, compactionCount: 1,
    })).toBe(true)
    expect(shouldRunQueryRecall({
      agentId: 'a', mode: 'light', recallAgent: 'a', recallCompactions: 1, compactionCount: 1,
    })).toBe(false)
  })
})

describe('runQueryRecall（检索 + 门 + 渲染 + 预算）', () => {
  let store: KyzmemStore
  let matching: string
  const captured: SearchQuery[] = []

  beforeEach(async () => {
    captured.length = 0
    store = await openUserStore()
    matching = (await store.write({
      scope: 'user',
      kind: 'fact',
      content: '项目构建链使用 tsdown 与 pnpm 工作区，TypeScript 严格模式全开',
      importance: 0.6,
    })).id
    await store.write({ scope: 'user', kind: 'preference', content: '周末喜欢去山里徒步', importance: 0.4 })
  })

  afterEach(async () => {
    await store.close()
  })

  /** 真实 store + 记录 query 形状 + 假批次登记。 */
  function depsOf(target: QueryRecallStore = store): {
    open: () => Promise<QueryRecallStore>
    registerBatch: (refs: readonly string[]) => string
  } {
    return {
      open: async () => ({
        search: async (query: SearchQuery, vector: Float32Array | undefined): Promise<SearchResult> => {
          captured.push(query)
          return target.search(query, vector)
        },
      }),
      registerBatch: (refs) => {
        registered.push(refs)
        return 'batch-test'
      },
    }
  }
  const registered: (readonly string[])[] = []

  beforeEach(() => { registered.length = 0 })

  const query = (overrides: Record<string, unknown> = {}) => ({
    text: 'TypeScript 项目的构建链到底用哪个工具？',
    scopes: ['user'] as const,
    top: 3,
    budget: 480,
    language: 'zh' as const,
    now: Date.now(),
    injectTiers: ['user-confirmed', 'agent-inferred'],
    ...overrides,
  })

  it('相关首问命中：行里带短 ref，尾部提示用 ref 不用 UUID，批次已登记', async () => {
    const outcome = await runQueryRecall(depsOf(), query())
    expect(outcome.outcome).toBe('injected')
    expect(outcome.ids).toEqual([matching])
    expect(outcome.refs).toEqual([`user/#${matching.slice(0, 8)}`])
    expect(outcome.batchId).toBe('batch-test')
    expect(registered).toEqual([outcome.refs])
    expect(outcome.block.split('\n')[0]).toBe(HEADER)
    const lines = itemLines(outcome.block)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('- [fact]')
    expect(lines[0]).toContain('tsdown')
    // 统一 id 口径：块里只有短 ref，完整 UUID 不进块（省预算，examine 由 F3 解析 ref）。
    expect(outcome.block).toContain(`user/#${matching.slice(0, 8)}`)
    expect(outcome.block).not.toContain(matching)
    expect(outcome.block).toContain('kyzmem_examine ids=[user/#')
    // 批次行把 batchId 交给模型（assess 要用）。
    expect(outcome.block).toContain('batch batch-test')
    // entries 与 ref 一一对应（交给 rememberCitationRefs）。
    expect(outcome.entries.map(entry => entry.ref)).toEqual(outcome.refs)
    expect(outcome.entries[0]!.record.id).toBe(matching)
    expect(outcome.chars).toBe(outcome.block.length)
  })

  it('检索契约：touch=false + auditMode=query-recall + auditQuery=hash，检索词截到 80 字', async () => {
    await runQueryRecall(depsOf(), query({ text: `构建链 ${'长'.repeat(300)}` }))
    expect(captured.length).toBe(1)
    const shape = captured[0]!
    expect(shape.touch).toBe(false)
    expect(shape.auditMode).toBe('query-recall')
    expect(shape.auditQuery).toBe('hash')
    expect(shape.limit).toBe(5)
    expect(shape.text.length).toBeLessThanOrEqual(QUERY_RECALL_MAX_QUERY_CHARS)
  })

  it('信任/过期门与画像同口径：web-content 与已过期条目都不注入', async () => {
    const web = await store.write({
      scope: 'user', kind: 'fact', content: '构建链的网传说法：某博客说用 gulp', importance: 0.6,
      sourceTier: 'web-content',
    })
    const expired = await store.write({
      scope: 'user', kind: 'decision', content: '构建链方案（已过期的旧决策）用 webpack', importance: 0.6,
      expiresAt: Date.now() - 1000,
    })
    // 两条都可能被 FTS 命中：过滤后只剩 agent-inferred 的那条。
    const outcome = await runQueryRecall(depsOf(), query())
    expect(outcome.outcome).toBe('injected')
    expect(outcome.ids).toEqual([matching])
    expect(outcome.ids).not.toContain(String(web.id))
    expect(outcome.ids).not.toContain(String(expired.id))
  })

  it('无关首问不注入（outcome=no-hit）', async () => {
    const outcome = await runQueryRecall(depsOf(), query({ text: '今天晚上吃什么好呢' }))
    expect(outcome.outcome).toBe('no-hit')
    expect(outcome.block).toBe('')
    expect(registered).toHaveLength(0)
  })

  it('与画像条目按 id 去重：只剩没进画像的那条', async () => {
    const all = await store.search({ text: '周末去山里徒步还是在家', scopes: ['user'], limit: 5, touch: false }, undefined)
    const ids = all.hits.map(hit => String(hit.record.id))
    expect(ids.length).toBeGreaterThan(0)
    const outcome = await runQueryRecall(depsOf(), query({
      text: '周末去山里徒步还是在家',
      excludeIds: new Set(ids),
    }))
    expect(outcome.outcome).toBe('no-hit')
  })

  it('条数是上限：top=2 时最多两条（预算放大后只看条数）', async () => {
    for (const content of [
      '工作区的依赖统一用 pnpm 安装', '工作区的发布脚本走 changesets',
      '工作区的 CI 只在主分支跑', '工作区的新包从 playbook 模板创建',
    ]) {
      await store.write({ scope: 'user', kind: 'decision', content, importance: 0.5 })
    }
    const base = { text: '工作区是怎么组织的？', scopes: ['user'] as const, budget: 4000, language: 'zh' as const }
    const three = await runQueryRecall(depsOf(), query({ ...base, top: 3 }))
    const two = await runQueryRecall(depsOf(), query({ ...base, top: 2 }))
    expect(three.outcome).toBe('injected')
    expect(two.outcome).toBe('injected')
    expect(two.ids).toHaveLength(2)
    expect(two.ids).toEqual(three.ids.slice(0, 2))
  })

  it('默认配置（light + 600）下 80 字内容真的放得下 3 条', async () => {
    const resolved = resolveConfig({})
    expect(resolved.queryRecallTop).toBe(3)
    expect(resolved.queryRecallBudget).toBe(600)
    for (const prefix of ['工作区甲', '工作区乙', '工作区丙']) {
      await store.write({
        scope: 'user', kind: 'fact',
        // 每条都超过 80 字：截断后单条 81 字符，这是默认预算要兜住的最坏情况。
        content: `工作区规范 ${prefix} ${'细'.repeat(120)}`, importance: 0.6,
      })
    }
    const outcome = await runQueryRecall(depsOf(), query({
      text: '工作区的规范是什么？',
      top: resolved.queryRecallTop,
      budget: resolved.queryRecallBudget,
    }))
    expect(outcome.outcome).toBe('injected')
    expect(outcome.ids).toHaveLength(3)
    expect(outcome.chars).toBeLessThanOrEqual(resolved.queryRecallBudget)
  })

  it('预算装不下就整块放弃（outcome=budget-skip，不留空批次）', async () => {
    const outcome = await runQueryRecall(depsOf(), query({ budget: 240 }))
    // 240 = 校验下限，恰好能放 1 条；连 1 条都放不下时给极小预算。
    expect(outcome.outcome).toBe('injected')
    expect(outcome.ids).toHaveLength(1)
    const skipped = await runQueryRecall(depsOf(), query({ budget: 60 }))
    expect(skipped.outcome).toBe('budget-skip')
    expect(registered).toHaveLength(1) // 只有 injected 那次登记过
  })

  it('单条正文截到 80 字，多行正文归一为一行', async () => {
    const collapsed = `工作区 ${'细'.repeat(200)}`
    const id = (await store.write({
      scope: 'user', kind: 'fact', content: `工作区\n${'细'.repeat(200)}`, importance: 0.6,
    })).id
    const outcome = await runQueryRecall(depsOf(), query({ text: '工作区约定是什么', budget: 4000 }))
    expect(outcome.outcome).toBe('injected')
    const line = itemLines(outcome.block).find(candidate => candidate.includes(String(id).slice(0, 8)))
    expect(line).toBeDefined()
    expect(line).toContain(`${collapsed.slice(0, QUERY_RECALL_ITEM_CHARS)}…`)
    expect(line).not.toContain('细'.repeat(QUERY_RECALL_ITEM_CHARS))
  })

  it('单库失败仍出另一库（allSettled：project 库打不开只丢它）', async () => {
    const deps = {
      open: async (scope: 'user' | 'project' | 'shared'): Promise<QueryRecallStore> => {
        if (scope === 'project') throw new Error('project db locked')
        return store
      },
      registerBatch: () => 'batch-user-only',
    }
    const outcome = await runQueryRecall(deps, query({ scopes: ['user', 'project'] }))
    expect(outcome.outcome).toBe('injected')
    expect(outcome.ids).toEqual([matching])
  })

  it('两库全失败 → outcome=error（不抛）', async () => {
    const deps = {
      open: async (): Promise<QueryRecallStore> => { throw new Error('all down') },
      registerBatch: () => 'batch-never',
    }
    const outcome = await runQueryRecall(deps, query())
    expect(outcome.outcome).toBe('error')
  })

  it('延迟保护：检索挂住时 80ms 内返回 timeout（不阻塞本步）', async () => {
    const hanging = { search: () => new Promise<never>(() => { /* 永不 settle */ }) } as unknown as QueryRecallStore
    const started = Date.now()
    const outcome = await runQueryRecall({
      open: async () => hanging,
      registerBatch: () => 'batch-never',
    }, query())
    expect(outcome.outcome).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(QUERY_RECALL_TIMEOUT_MS * 10)
  })

  it('英文语言包渲染英文标题', async () => {
    const outcome = await runQueryRecall(depsOf(), query({ language: 'en' }))
    expect(outcome.block.startsWith(HEADER_EN)).toBe(true)
  })
})

describe('经真实 apply() + agent/pre-step 的集成', () => {
  /** 最小 fake Context：只捕获 pre-step 处理器、并保留 effect 的 disposer（关闭分库）。 */
  function makeFakeContext(): {
    ctx: unknown
    handlers: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
    disposers: (() => unknown)[]
  } {
    const handlers = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    const disposers: (() => unknown)[] = []
    const ctx = {
      effect: (factory: () => () => unknown): void => { disposers.push(factory()) },
      on: (name: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): void => {
        handlers.set(name, handler)
      },
      inject: (): void => { /* 无 webServer：面板路由不装 */ },
      get: (): undefined => undefined,
      tools: { register: (): void => { /* 工具注册不在本文件断言 */ } },
    }
    return { ctx, handlers, disposers }
  }

  interface DecisionShape {
    messages?: readonly { content?: readonly { text?: string }[] }[]
  }

  /** 从决策里拼出注入文本（本插件只追加一条 user 消息）。 */
  function injectedText(decision: DecisionShape): string {
    return (decision.messages ?? [])
      .flatMap(item => item.content ?? [])
      .map(block => block.text ?? '')
      .join('\n')
  }

  let dbDir: string
  let seededId: string
  let disposers: (() => unknown)[]
  let preStep: (payload: unknown, next: () => Promise<unknown>) => Promise<DecisionShape>
  const sessionId = 'sess-query-recall'
  const events: { type: string; data: unknown; seq: number; time: number }[] = []

  /** 起一个真实插件实例（嵌入器已替身、后台整理关闭、画像只留 1 条）。 */
  async function boot(config: Record<string, unknown>): Promise<void> {
    dbDir = join(dir, 'kyzmem')
    const seed = await openKyzmemStore(join(dbDir, 'user.db'))
    // 画像只留 1 条：高重要性的「徒步」占住常驻画像，与首问相关的那条被挤在画像之外——
    // 这正是首问召回要补的那部分。
    await seed.write({ scope: 'user', kind: 'preference', content: '周末喜欢去山里徒步', importance: 0.9 })
    seededId = (await seed.write({
      scope: 'user', kind: 'fact', content: '项目构建链使用 tsdown 与 pnpm 工作区，TypeScript 严格模式全开', importance: 0.3,
    })).id
    await seed.close()
    const { ctx, handlers, disposers: pending } = makeFakeContext()
    apply(ctx as never, {
      dbDir, ingest: 'off', maintenanceEnabled: false, queryRewrite: false, profileTopN: 1, ...config,
    })
    disposers = pending
    const handler = handlers.get('agent/pre-step')
    expect(handler).toBeDefined()
    preStep = handler as unknown as typeof preStep
  }

  const QUESTION = 'TypeScript 项目的构建链到底用哪个工具？'
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: {},
      snapshotEvents: () => events,
    },
  }

  const run = async (step: number, request?: string, turn = 1): Promise<DecisionShape> => preStep(
    { agent, step, turn, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: request === undefined ? [] : [{ content: [{ type: 'text', text: request }] }] }),
  )

  /** 读某个 op 的最近几条审计。 */
  async function recentOps(op: string, limit = 10): Promise<{ detail: string | null }[]> {
    const store = await openKyzmemStore(join(dbDir, 'user.db'))
    const rows = await store.recentAudit(op, limit, 'BATCH')
    await store.close()
    return rows
  }

  beforeEach(() => {
    events.length = 0
    disposers = []
    evidenceBatches.clear(sessionId)
  })

  afterEach(async () => {
    for (const disposer of disposers) await disposer()
    evidenceBatches.clear(sessionId)
  })

  it('首轮注入召回小节：batchId 可被 assess 接受，行内 ref 可用', async () => {
    await boot({ queryRecall: 'light' })
    const injected = injectedText(await run(1, QUESTION))
    expect(injected).toContain(HEADER)
    const ref = firstRef(injected)
    expect(ref).toBe(`user/#${seededId.slice(0, 8)}`)
    // 完整 UUID 不进块（省预算）；块里有批次行。
    expect(injected).not.toContain(seededId)
    const batchId = /batch (batch-\d+)/.exec(injected)?.[1]
    expect(batchId).toBeDefined()

    // 证据门：块里给出的 batchId + ref 真的能被 kyzmem_assess 的校验接受。
    const batch = evidenceBatches.get(sessionId, batchId!)
    expect(batch).toBeDefined()
    expect([...batch!.refs]).toEqual([ref])
    const verdict = assessEvidence(batch!, { sufficient: true, evidenceRefs: [ref], missing: '', nextStrategy: 'answer' })
    expect(verdict.sufficient).toBe(true)
    expect(verdict.rejectedRefs).toEqual([])
  })

  it('隐私：store 层的 recall 审计只存 queryHash，不落首问原文', async () => {
    await boot({ queryRecall: 'light' })
    expect(injectedText(await run(1, QUESTION))).toContain(HEADER)
    await new Promise(resolve => setTimeout(resolve, 100))
    const recalls = await recentOps('recall')
    expect(recalls.length).toBeGreaterThan(0)
    const detail = JSON.parse(recalls[0]!.detail ?? '{}') as { mode?: string; query?: string; queryHash?: string }
    expect(detail.mode).toBe('query-recall')
    expect(detail.query).toBeUndefined()
    expect(detail.queryHash).toMatch(/^[0-9a-f]{16}$/u)
    // 首问原文一个字都不该进库。
    expect(recalls[0]!.detail).not.toContain('构建链到底用哪个工具')
  })

  it('可观测：无关首问也落一行 no-hit 审计', async () => {
    await boot({ queryRecall: 'light' })
    const injected = injectedText(await run(1, '今天晚上吃什么好呢'))
    expect(injected).not.toContain(HEADER)
    await new Promise(resolve => setTimeout(resolve, 100))
    const details = (await recentOps('query-recall')).map(row => JSON.parse(row.detail ?? '{}') as {
      outcome?: string; top?: number; ids?: string[]; chars?: number; tookMs?: number
    })
    expect(details).toHaveLength(1)
    expect(details[0]!.outcome).toBe('no-hit')
    expect(details[0]!.top).toBe(3)
    expect(details[0]!.ids).toEqual([])
    expect(details[0]!.chars).toBe(0)
    expect(typeof details[0]!.tookMs).toBe('number')
  })

  it('只对注入条目 markRetrieved：access_count 不变，last_retrieved_at/confidence 更新', async () => {
    await boot({ queryRecall: 'light' })
    expect(injectedText(await run(1, QUESTION))).toContain(HEADER)
    await new Promise(resolve => setTimeout(resolve, 100))
    const verify = await openKyzmemStore(join(dbDir, 'user.db'))
    const record = await verify.get(asMemoryId(seededId))
    await verify.close()
    expect(record).toBeDefined()
    // 召回是「展示」不是「取用」：access_count 必须保持 0（否则条目永久逃过衰减）。
    expect(record!.accessCount).toBe(0)
    // last_retrieved_at 在写入时初始化成 createdAt，markRetrieved 才会把它推进。
    expect(record!.lastRetrievedAt).toBeGreaterThanOrEqual(record!.createdAt)
    expect(record!.confidence).toBeGreaterThan(0.5)
  })

  it('第二轮不重复；压缩后重注入一次（新批次）', async () => {
    await boot({ queryRecall: 'light' })
    expect(injectedText(await run(1, QUESTION))).toContain(HEADER)
    expect(evidenceBatches.pendingBatches(sessionId)).toHaveLength(1)
    // 第二轮（无压缩、内容相同）：只可能剩证据门收尾提醒，不含召回小节。
    expect(injectedText(await run(2))).not.toContain(HEADER)
    // 压缩后（step 不再等于 1）：允许再注入一次，且重新检索（新批次）。
    events.push({ type: 'compaction/end', data: {}, seq: events.length + 1, time: Date.now() })
    expect(injectedText(await run(3, QUESTION))).toContain(HEADER)
    expect(evidenceBatches.pendingBatches(sessionId)).toHaveLength(2)
  })

  it('陈旧块不复用：后续 step=1 因画像变化重注入时，不再带第 1 问的召回', async () => {
    await boot({ queryRecall: 'light' })
    expect(injectedText(await run(1, QUESTION))).toContain(HEADER)
    // 画像内容变化（新写一条高重要性记忆）→ hash 变化 → 后续 step=1 会重注入。
    const seed = await openKyzmemStore(join(dir, 'seed.db'))
    await seed.close()
    const writer = await openKyzmemStore(join(dbDir, 'user.db'))
    await writer.write({ scope: 'user', kind: 'fact', content: '新增画像条目：用户偏好简体中文', importance: 0.95 })
    await writer.close()
    const second = injectedText(await run(1, QUESTION))
    // 重注入发生了（新的高重要性条目进了画像），但召回小节没有被陈旧复用。
    expect(second).toContain('新增画像条目')
    expect(second).not.toContain(HEADER)
  })

  it('占位句跳过：无用户文本的 step 不检索，审计记 no-text', async () => {
    await boot({ queryRecall: 'light' })
    const injected = injectedText(await run(1))
    expect(injected).toContain(messageIn('zh', 'core.profileHeader'))
    expect(injected).not.toContain(HEADER)
    await new Promise(resolve => setTimeout(resolve, 100))
    const details = (await recentOps('query-recall')).map(row => JSON.parse(row.detail ?? '{}') as { outcome?: string })
    expect(details.map(detail => detail.outcome)).toContain('no-text')
    // 也没有任何真正的检索（store 的 recall 审计为空）。
    expect(await recentOps('recall')).toHaveLength(0)
  })

  it('off 档：零检索、零强化、只留一行 off 审计', async () => {
    await boot({ queryRecall: 'off' })
    const injected = injectedText(await run(1, QUESTION))
    expect(injected).toContain(messageIn('zh', 'core.profileHeader'))
    expect(injected).not.toContain(HEADER)
    await new Promise(resolve => setTimeout(resolve, 100))
    const ops = await recentOps('query-recall')
    const details = ops.map(row => JSON.parse(row.detail ?? '{}') as { outcome?: string })
    expect(details.map(detail => detail.outcome)).toEqual(['off'])
    // 零检索：store 层 recall 审计一条都没有。
    expect(await recentOps('recall')).toHaveLength(0)
    // 零强化：access_count/confidence/last_retrieved_at 都没动。
    const verify = await openKyzmemStore(join(dbDir, 'user.db'))
    const record = await verify.get(asMemoryId(seededId))
    await verify.close()
    expect(record!.accessCount).toBe(0)
    expect(record!.confidence).toBe(0.5)
    // 检索时钟停在写入时的初始化值，没有被推进过。
    expect(record!.lastRetrievedAt).toBe(record!.createdAt)
  })

  it('采用率只认 mode=search 的工具检索：只有首问召回的 recall 审计时不记账', async () => {
    await boot({ queryRecall: 'light' })
    expect(injectedText(await run(1, QUESTION))).toContain(HEADER)
    await run(2)
    await new Promise(resolve => setTimeout(resolve, 100))
    // 首问召回自己写了一条 mode=query-recall 的 recall 审计，但 adoption 不该把它当成检索批次。
    const recalls = await recentOps('recall')
    expect(recalls.length).toBeGreaterThan(0)
    const modes = recalls.map(row => (JSON.parse(row.detail ?? '{}') as { mode?: string }).mode)
    expect(modes).toContain('query-recall')
    expect(await recentOps('recall-used')).toHaveLength(0)
    expect(await recentOps('recall-ignored')).toHaveLength(0)
  })

  it('采用率认 mode=search 的批次（有工具检索时照旧记账）', async () => {
    await boot({ queryRecall: 'light' })
    expect(injectedText(await run(1, QUESTION))).toContain(HEADER)
    // 模拟模型主动检索：写一条 mode=search 的 recall 审计。
    const writer = await openKyzmemStore(join(dbDir, 'user.db'))
    await writer.audit('recall', 'BATCH', JSON.stringify({ ids: [seededId], mode: 'search', query: '构建链' }))
    await writer.close()
    await run(2)
    await new Promise(resolve => setTimeout(resolve, 100))
    const rows = [...await recentOps('recall-used'), ...await recentOps('recall-ignored')]
    expect(rows).toHaveLength(1)
    const detail = JSON.parse(rows[0]!.detail ?? '{}') as { ids?: string[] }
    expect(detail.ids).toEqual([seededId])
  })

  it('有 cwd 时同时查项目宫殿，且只查已存在的库（不为一次性 cwd 建空库）', async () => {
    dbDir = join(dir, 'kyzmem')
    const workspace = join(dir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const projectStore = await openKyzmemStore(join(dbDir, resolveProjectIdentity(workspace).dbName))
    const projectId = (await projectStore.write({
      scope: 'project', kind: 'decision', content: '本项目的发布流程：先跑 changesets 再打 tag', importance: 0.6,
    })).id
    await projectStore.close()
    const { ctx, handlers, disposers: pending } = makeFakeContext()
    apply(ctx as never, {
      dbDir, ingest: 'off', maintenanceEnabled: false, queryRewrite: false,
      queryRecall: 'light',
    })
    disposers = pending
    const handler = handlers.get('agent/pre-step') as unknown as typeof preStep
    const withCwd = {
      id: `${sessionId}-cwd`,
      session: { id: `${sessionId}-cwd`, header: { cwd: workspace }, snapshotEvents: () => [] },
    }
    const decision = await handler(
      { agent: withCwd, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '这个项目的发布流程是什么？' }] }] }),
    )
    const injected = injectedText(decision as DecisionShape)
    expect(injected).toContain(HEADER)
    expect(injected).toContain(`project/#${projectId.slice(0, 8)}`)
  })

  it('有 cwd 但项目库不存在时：只查 user，不为一次性 cwd 建空库', async () => {
    dbDir = join(dir, 'kyzmem')
    const freshWorkspace = join(dir, 'fresh-workspace')
    await mkdir(freshWorkspace, { recursive: true })
    const seed = await openKyzmemStore(join(dbDir, 'user.db'))
    await seed.write({ scope: 'user', kind: 'preference', content: '周末喜欢去山里徒步', importance: 0.9 })
    const userId = (await seed.write({
      scope: 'user', kind: 'fact', content: '项目构建链用 tsdown 打包', importance: 0.6,
    })).id
    await seed.close()
    const { ctx, handlers, disposers: pending } = makeFakeContext()
    apply(ctx as never, {
      dbDir, ingest: 'off', maintenanceEnabled: false, queryRewrite: false, profileTopN: 1, queryRecall: 'light',
    })
    disposers = pending
    const handler = handlers.get('agent/pre-step') as unknown as typeof preStep
    const withCwd = {
      id: `${sessionId}-fresh`,
      session: { id: `${sessionId}-fresh`, header: { cwd: freshWorkspace }, snapshotEvents: () => [] },
    }
    const decision = await handler(
      { agent: withCwd, step: 1, turn: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: '构建链用什么打包？' }] }] }),
    )
    expect(injectedText(decision as DecisionShape)).toContain(`user/#${userId.slice(0, 8)}`)
    // 项目分库文件不该被这次旁路召回创建出来。
    expect(existsSync(join(dbDir, resolveProjectIdentity(freshWorkspace).dbName))).toBe(false)
  })
})

