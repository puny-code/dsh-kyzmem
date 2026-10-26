import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerKyzmemRoutes } from '../src/routes.ts'
import type { RouteDeps } from '../src/routes.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import type { KyzmemStore } from '../src/store/interface.ts'
import type { ProjectPalaceView } from '../src/routes.ts'

/**
 * 路由级测试的最小 HTTP 夹具。
 * 为什么要自己造 req/res：router 只依赖 IncomingMessage/ServerResponse 的极小子集
 * （method/url/headers/socket/异步可迭代 body、writeHead/end），造真实 socket 反而更脆。
 */
type RouteHandler = (req: never, res: never) => Promise<void>

interface Reply {
  readonly status: number
  readonly json: any
}

function makeReq(method: string, path: string, body?: unknown): never {
  const chunks = body === undefined ? [] : [JSON.stringify(body)]
  const req = Readable.from(chunks) as unknown as Record<string, unknown>
  req['method'] = method
  req['url'] = path
  req['headers'] = {
    host: '127.0.0.1:11258',
    origin: 'http://127.0.0.1:11258',
    'content-type': 'application/json',
  }
  req['socket'] = { remoteAddress: '127.0.0.1' }
  return req as never
}

function makeRes(): { res: never; state: { status: number; body: string } } {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status: number): void {
      state.status = status
    },
    end(chunk?: unknown): void {
      if (chunk !== undefined) state.body = String(chunk)
    },
  }
  return { res: res as never, state }
}

let dir: string
let store: KyzmemStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kyzmem-routes-'))
  store = await openKyzmemStore(join(dir, 'user.db'))
})

afterEach(async () => {
  await store.close()
})

/** 项目宫殿视图：路由只在 project scope 用到，字段给全避免 nullable 分支干扰断言。 */
function projectView(): ProjectPalaceView {
  return {
    dbName: 'proj-abc',
    title: '测试项目',
    path: dir,
    kind: 'process',
    source: 'cwd',
    workspaceId: null,
    exists: true,
    memories: 0,
  }
}

/**
 * 组装 RouteDeps：所有 store 落到同一个 user.db（作用域差异不是本 spec 的关注点）。
 * history 只填默认规则——历史回填走独立的 node 侧测试。
 */
function makeDeps(): RouteDeps {
  return {
    openStore: async () => store,
    closeStores: async () => undefined,
    projects: {
      list: async () => [projectView()],
      open: async () => ({ store, project: projectView() }),
    },
    exportDir: join(dir, 'exports'),
    embedder: Promise.resolve(undefined),
    mirrorDir: join(dir, 'palaces'),
    dbDir: dir,
    pluginVersion: '0.11.0',
    language: 'zh',
    history: {
      estimate: async () => ({ sessions: 0, rounds: 0, candidates: 0 }),
      start: () => ({ ok: false, reason: 'disabled' }),
      cancel: () => undefined,
      status: () => ({ progress: {}, failures: [] }),
      models: async () => ({ providers: [], failures: [] }),
      defaults: { days: 7, maxTurnsPerSession: 20, maxTotalTurns: 200, includeSubagents: false, includeSeeded: false, includeNoCwd: false },
    },
  } as unknown as RouteDeps
}

/** 注册路由并返回「发一条请求拿 JSON」的调用器。 */
function harness(deps: RouteDeps): (method: string, path: string, body?: unknown) => Promise<Reply> {
  let handler: RouteHandler | undefined
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register: (definition: { handler: RouteHandler }) => {
        handler = definition.handler
        return () => undefined
      },
    },
  }
  registerKyzmemRoutes(ctx as never, deps)
  if (handler === undefined) throw new Error('route handler not registered')
  const run = handler
  return async (method: string, path: string, body?: unknown) => {
    const { res, state } = makeRes()
    await run(makeReq(method, path, body), res)
    return { status: state.status, json: state.body === '' ? undefined : JSON.parse(state.body) }
  }
}

describe('GET /api/kyzmem/stats（§8 指标 + 通道）', () => {
  it('三库 parts + metrics + channels 一次给齐', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '统计用条目' })
    const request = harness(makeDeps())
    const reply = await request('GET', '/api/kyzmem/stats')
    expect(reply.status).toBe(200)
    expect(reply.json.parts.map((part: { scope: string }) => part.scope)).toEqual(['user', 'project', 'shared'])
    // 指标对象必在：面板首屏靠它画卡片；缺指标比缺值更糟。
    expect(reply.json.metrics).toBeTypeOf('object')
    // 没有任何检索归因时采用率缺省（面板渲染成「—」），不是 0。
    expect(reply.json.metrics.recallUsed).toBe(0)
    expect(Array.isArray(reply.json.channels)).toBe(true)
    expect(reply.json.windowDays).toBe(7)
  })

  it('写入后 dropRate、weeklyGrowth 有数；byTier 透传到 parts', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '第一条', sourceTier: 'user-confirmed' })
    await store.write({ scope: 'user', kind: 'fact', content: '第二条', sourceTier: 'tool-output' })
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/stats')
    expect(reply.json.metrics.weeklyGrowth).toBeGreaterThanOrEqual(0)
    expect(reply.json.metrics.dropRate).toBe(0)
    const userPart = reply.json.parts.find((part: { scope: string }) => part.scope === 'user')
    expect(userPart.stats.byTier).toMatchObject({ 'user-confirmed': 1, 'tool-output': 1 })
  })

  it('R5 六项随 metrics 一起给出：没有注入时缺省，不抛 500', async () => {
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/stats')
    expect(reply.status).toBe(200)
    // 「跑了是 0」与「还没跑」分开：注入次数是 0，曝光/激活/token 成本缺省（面板显示「—」）。
    expect(reply.json.metrics.injectionCount).toBe(0)
    expect(reply.json.metrics.exposureChars).toBeUndefined()
    expect(reply.json.metrics.activationRate).toBeUndefined()
    expect(reply.json.metrics.tokenCostEstimate).toBeUndefined()
    // 窗口内没有工具检索（分母 0）⇒ 下钻率缺省；有检索但零下钻会是 0%。
    expect(reply.json.metrics.drillDownRate).toBeUndefined()
    // 无带锚条目 ⇒ 锚点过期率缺省。
    expect(reply.json.metrics.staleAnchorRate).toBeUndefined()
  })

  it('R5 有注入审计时按 zh 口径折算 token 成本，曝光/激活出炉', async () => {
    await store.audit('query-recall', 'BATCH', JSON.stringify({ outcome: 'injected', chars: 100, tookMs: 3, top: 3, ids: [] }))
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/stats')
    // 夹具把三个 scope 都指到同一个 store（makeDeps 的 openStore 恒返回 store），所以同一条
    // 审计会被三个 scope 各读一遍——断言按「次数 × 单次口径」写，不写死 1。
    const injections = reply.json.metrics.injectionCount as number
    expect(injections).toBeGreaterThan(0)
    expect(reply.json.metrics.exposureChars).toBe(100 * injections)
    // deps.language = 'zh' ⇒ 1.5 token/字。
    expect(reply.json.metrics.tokenCostEstimate).toBe(150 * injections)
    // 注入过但没有工具检索/下钻 ⇒ 激活率是 0（有样本的 0，不是缺省）。
    expect(reply.json.metrics.activationRate).toBe(0)
  })
})

describe('GET /api/kyzmem/memories（confirmedOnly=1）', () => {
  it('只回显式确认的条目（user-confirmed），过滤 agent 推断/tool-output/web', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '用户确认过', sourceTier: 'user-confirmed' })
    await store.write({ scope: 'user', kind: 'fact', content: 'agent 推断的' })
    await store.write({ scope: 'user', kind: 'fact', content: '工具跑出来的', sourceTier: 'tool-output' })
    await store.write({ scope: 'user', kind: 'fact', content: '网页抄来的', sourceTier: 'web-content' })
    const request = harness(makeDeps())
    const all = await request('GET', '/api/kyzmem/memories?scope=user')
    expect(all.json.records).toHaveLength(4)
    const confirmed = await request('GET', '/api/kyzmem/memories?scope=user&confirmedOnly=1')
    expect(confirmed.json.records.map((record: { content: string }) => record.content).sort()).toEqual(['用户确认过'])
  })

  it('list 与 memories 是同一实现（旧面板兼容）', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '同一份数据' })
    const request = harness(makeDeps())
    const viaList = await request('GET', '/api/kyzmem/list?scope=user')
    const viaMemories = await request('GET', '/api/kyzmem/memories?scope=user')
    expect(viaMemories.json.total).toBe(viaList.json.total)
  })
})

describe('冲突路由（§8）', () => {
  /** 造一对 contradicts：路由只读 store 的冲突视图，判定逻辑在 store 侧单测覆盖。 */
  async function seedConflict(): Promise<{ left: { id: string; content: string }; right: { id: string; content: string } }> {
    const left = await store.write({ scope: 'user', kind: 'fact', content: '端口是 4000' })
    const right = await store.write({ scope: 'user', kind: 'fact', content: '端口是 5000' })
    await store.linkEdge(left.id as never, right.id as never, 'contradicts')
    return { left, right }
  }

  it('GET /conflicts 返回 { items, total }，成对带两端记录', async () => {
    const { left, right } = await seedConflict()
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/conflicts?scope=user&limit=10')
    expect(reply.status).toBe(200)
    expect(reply.json.total).toBe(1)
    const pair = reply.json.items[0]
    expect(pair.left.id).toBe(left.id)
    expect(pair.right.id).toBe(right.id)
    expect(pair.left.content).toBe('端口是 4000')
    expect(typeof pair.createdAt).toBe('number')
  })

  it('scope=all 按库分别过滤后合并（同一 store 只在 user 库命中）', async () => {
    await seedConflict()
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/conflicts?scope=all')
    expect(Array.isArray(reply.json.items)).toBe(true)
    // project/shared 两轮过滤掉 user 作用域的行，只剩 user 库这一条——说明 scope 过滤确实下推到了 store。
    expect(reply.json.total).toBe(1)
  })

  it('POST /conflicts/resolve keep-left：右边归档、冲突消解、审计落 op_log', async () => {
    const { left, right } = await seedConflict()
    const request = harness(makeDeps())
    const resolved = await request('POST', '/api/kyzmem/conflicts/resolve', { left: left.id, right: right.id, action: 'keep-left' })
    expect(resolved.status).toBe(200)
    expect(resolved.json).toEqual({ ok: true })
    const after = await request('GET', '/api/kyzmem/conflicts?scope=user')
    expect(after.json.total).toBe(0)
    expect((await store.get(right.id as never))?.status).toBe('archived')
    const ops = await store.recentOps(20)
    expect(ops.some(op => op.op === 'conflict-resolve')).toBe(true)
  })

  it('POST /conflicts/resolve 非法 action / 缺字段 → 400', async () => {
    const request = harness(makeDeps())
    const badAction = await request('POST', '/api/kyzmem/conflicts/resolve', { left: 'a', right: 'b', action: 'merge' })
    expect(badAction.status).toBe(400)
    const missing = await request('POST', '/api/kyzmem/conflicts/resolve', { action: 'keep-left' })
    expect(missing.status).toBe(400)
  })
})

describe('自动动作审计路由（P1.4）', () => {
  it('GET /auto-history 返回 auto-action 审计行（含 scope），面板据此渲染裁决历史', async () => {
    const { logAutoAction } = await import('../src/automation/log.ts')
    await logAutoAction(store, {
      op: 'auto-action',
      ruleId: 'conflict-rule/r-tier',
      thresholds: { newerMinAgeDays: 30 },
      leftId: 'left-1',
      rightId: 'right-1',
      batchId: 'auto-conflict-1',
      version: '0.16.0-test',
      undo: { restoreIds: ['right-1'] },
    })
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/auto-history?scope=user&limit=10')
    expect(reply.status).toBe(200)
    expect(Array.isArray(reply.json.entries)).toBe(true)
    expect(reply.json.entries.length).toBe(1)
    const row = reply.json.entries[0]
    expect(row.op).toBe('auto-action')
    expect(row.scope).toBe('user')
    expect(typeof row.at).toBe('number')
    const detail = JSON.parse(row.detail) as { ruleId: string; batchId: string }
    expect(detail.ruleId).toBe('conflict-rule/r-tier')
    expect(detail.batchId).toBe('auto-conflict-1')
  })

  it('POST /auto-undo 回滚批次归档并返回计数', async () => {
    const { logAutoAction } = await import('../src/automation/log.ts')
    const doomed = await store.write({ scope: 'user', kind: 'fact', content: '待撤销归档' })
    await store.resolveConflict(
      (await store.write({ scope: 'user', kind: 'fact', content: '胜者' })).id as never,
      doomed.id as never,
      'keep-left',
    )
    await logAutoAction(store, {
      op: 'auto-action',
      ruleId: 'conflict-rule/r-tier',
      thresholds: {},
      batchId: 'auto-conflict-undo-1',
      version: '0.16.0-test',
      undo: { restoreIds: [String(doomed.id)] },
    })
    const reply = await harness(makeDeps())('POST', '/api/kyzmem/auto-undo', { batchId: 'auto-conflict-undo-1', scope: 'user' })
    expect(reply.status).toBe(200)
    expect(reply.json.restored).toEqual([String(doomed.id)])
    expect((await store.get(doomed.id as never))?.status).toBe('active')
  })
})

describe('GET /api/kyzmem/health（后台欠账 + 维护 kick）', () => {
  it('返回 overall/parts/debt；维护调度器未落地时 debt 退化但结构完整', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '健康检查用条目' })
    const reply = await harness(makeDeps())('GET', '/api/kyzmem/health')
    expect(reply.status).toBe(200)
    expect(typeof reply.json.overall).toBe('number')
    expect(reply.json.debt).toMatchObject({
      activeGrowth: expect.any(Number),
      openConflicts: expect.any(Number),
      dueReviews: expect.any(Number),
      pendingIngests: expect.any(Number),
      missingSummaries: expect.any(Number),
    })
  })
})

describe('POST/GET /api/kyzmem/search-test（带 channels）', () => {
  it('GET 与 POST 都回 channels 与 hits', async () => {
    await store.write({ scope: 'user', kind: 'fact', content: '检索测试端口 4000' })
    const request = harness(makeDeps())
    const getReply = await request('GET', '/api/kyzmem/search-test?q=端口&scope=user')
    expect(getReply.status).toBe(200)
    expect(Array.isArray(getReply.json.channels)).toBe(true)
    expect(getReply.json.hits.length).toBeGreaterThan(0)
    const postReply = await request('POST', '/api/kyzmem/search-test', { q: '端口', scope: 'user' })
    expect(postReply.status).toBe(200)
    expect(Array.isArray(postReply.json.channels)).toBe(true)
    expect(postReply.json.hits.length).toBe(getReply.json.hits.length)
  })
})

describe('回环守卫', () => {
  it('非回环 Host 直接 403（防 DNS rebinding）', async () => {
    const reply = await (async () => {
      // 单独造一条 host 非法的请求：守卫必须在路由分发前拦下。
      const { res, state } = makeRes()
      const ctx = {
        effect: (fn: () => unknown) => fn(),
        webServer: {
          register: (definition: { handler: RouteHandler }) => {
            const req = makeReq('GET', '/api/kyzmem/stats') as unknown as Record<string, unknown>
            ;(req['headers'] as Record<string, string>)['host'] = '127.0.0.1.attacker.com'
            void definition.handler(req as never, res)
            return () => undefined
          },
        },
      }
      registerKyzmemRoutes(ctx as never, makeDeps())
      await new Promise(resolve => setTimeout(resolve, 50))
      return { status: state.status, body: state.body }
    })()
    expect(reply.status).toBe(403)
  })
})

describe('POST /api/kyzmem/settings（Phase 2.2 按键 restartRequired）', () => {
  it('纯热键补丁 restartRequired=false', async () => {
    const request = harness({ ...makeDeps(), hostConfig: {} })
    const reply = await request('POST', '/api/kyzmem/settings', { decayAfterDays: 7 })
    expect(reply.status).toBe(200)
    expect(reply.json.restartRequired).toBe(false)
  })
  it('含 judgeModel 补丁 restartRequired=true', async () => {
    const request = harness({ ...makeDeps(), hostConfig: {} })
    const reply = await request('POST', '/api/kyzmem/settings', { judgeModel: 'test-model' })
    expect(reply.status).toBe(200)
    expect(reply.json.restartRequired).toBe(true)
  })
})
