import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { messageIn } from '../src/i18n/messages.ts'
import { openKyzmemStore } from '../src/store/sqlite.ts'
import { RESUME_BRIEFING_CHARS_DEFAULT, RESUME_SUMMARY_MAX_CHARS, renderResumeBriefing, shouldRunResumeBriefing } from '../src/resume-briefing.ts'
import { resolveProjectIdentity } from '../src/project/identity.ts'

/**
 * `[RESUME]` 恢复简报（方案 §7 D）：
 *  - 纯函数：预算收缩顺序（先压摘要、再丢计数行）、摘要 120 字上限、每会话一次的门；
 *  - 经真实 apply() + agent/pre-step 的集成：有摘要注入且整块 ≤200 字符、无摘要不注入、
 *    开关关闭不注入、压缩后重注入一次、项目库不存在时不建库（与首问召回同口径）。
 */

const HEADER = messageIn('zh', 'core.profileHeader')
/** 简报的协议标记：三语都以 `[RESUME]` 开头，直接按标记切片即可。 */
const RESUME = '[RESUME]'

/** 从注入文本里切出 `[RESUME]` 小节（到画像标题之前）。 */
function resumeSection(injected: string): string {
  const start = injected.indexOf(RESUME)
  if (start === -1) return ''
  const end = injected.indexOf(HEADER, start)
  return injected.slice(start, end === -1 ? undefined : end).trim()
}

describe('renderResumeBriefing', () => {
  it('三行版式：上次会话 + 今日待回忆 + 未完成摄取', () => {
    const block = renderResumeBriefing({
      summary: '在调文件锚迁移，schema 15 → 16。',
      updatedAt: Date.parse('2026-10-20T09:00:00Z'),
      due: 3,
      pendingIngests: 2,
      chars: RESUME_BRIEFING_CHARS_DEFAULT,
      language: 'zh',
    })
    const lines = block.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(messageIn('zh', 'core.resumeHeader', { date: '2026-10-20', summary: '在调文件锚迁移，schema 15 → 16。' }))
    expect(lines[1]).toBe(messageIn('zh', 'core.resumeDue', { count: 3 }))
    expect(lines[2]).toBe(messageIn('zh', 'core.resumePendingIngest', { count: 2 }))
  })

  it('计数为 0 的行省略（不注入「今日待回忆 0 条」这种噪声）', () => {
    const block = renderResumeBriefing({
      summary: '只有摘要。', updatedAt: 0, due: 0, pendingIngests: 0, chars: 200, language: 'zh',
    })
    expect(block.split('\n')).toHaveLength(1)
  })

  it('摘要归一为单行并截到 120 字', () => {
    const long = `${'甲'.repeat(200)}\n第二行`
    const block = renderResumeBriefing({ summary: long, updatedAt: 0, due: 0, pendingIngests: 0, chars: 600, language: 'zh' })
    expect(block).not.toContain('\n')
    expect(block).toContain(`${'甲'.repeat(RESUME_SUMMARY_MAX_CHARS)}…`)
    expect(block).not.toContain('甲'.repeat(RESUME_SUMMARY_MAX_CHARS + 1))
  })

  it('整块硬上限：先压摘要，再丢计数行，仍超才硬截断', () => {
    const long = '乙'.repeat(400)
    const roomy = renderResumeBriefing({ summary: long, updatedAt: 0, due: 5, pendingIngests: 1, chars: 200, language: 'zh' })
    expect(roomy.length).toBeLessThanOrEqual(200)
    // 200 字符装得下两行计数：摘要被压短，计数行保留。
    expect(roomy.split('\n')).toHaveLength(3)
    expect(roomy).toContain(messageIn('zh', 'core.resumeDue', { count: 5 }))

    // 70 字符：摘要压到下限后仍放不下两行计数，后加的 pending 行先让位。
    const mid = renderResumeBriefing({ summary: long, updatedAt: 0, due: 5, pendingIngests: 1, chars: 70, language: 'zh' })
    expect(mid.length).toBeLessThanOrEqual(70)
    expect(mid).toContain(messageIn('zh', 'core.resumeDue', { count: 5 }))
    expect(mid).not.toContain(messageIn('zh', 'core.resumePendingIngest', { count: 1 }))

    // 40 字符：连标题 + 摘要下限都放不下，计数行全丢后硬截断（仍然是合法的单行）。
    const tight = renderResumeBriefing({ summary: long, updatedAt: 0, due: 5, pendingIngests: 1, chars: 40, language: 'zh' })
    expect(tight.length).toBeLessThanOrEqual(40)
    expect(tight.startsWith('[RESUME]')).toBe(true)
    expect(tight).not.toContain(messageIn('zh', 'core.resumeDue', { count: 5 }))
  })

  it('摘要本身为空时不渲染（调用方据此不消耗会话机会）', () => {
    expect(renderResumeBriefing({ summary: '   \n  ', updatedAt: 0, due: 1, pendingIngests: 0, chars: 200, language: 'zh' })).toBe('')
  })
})

describe('shouldRunResumeBriefing', () => {
  const base = { enabled: true, agentId: 'a1', resumeAgent: null, resumeCompactions: null, compactionCount: 0 }

  it('关闭直接不跑；新会话跑一次；同会话不再跑；压缩后允许再一次', () => {
    expect(shouldRunResumeBriefing({ ...base, enabled: false })).toBe(false)
    expect(shouldRunResumeBriefing(base)).toBe(true)
    expect(shouldRunResumeBriefing({ ...base, agentId: 'a1', resumeAgent: 'a1', resumeCompactions: 0 })).toBe(false)
    expect(shouldRunResumeBriefing({ ...base, resumeAgent: 'a1', resumeCompactions: 0, compactionCount: 1 })).toBe(true)
    // 压缩计数没变（同样的 compactionCount）不重复注入。
    expect(shouldRunResumeBriefing({ ...base, resumeAgent: 'a1', resumeCompactions: 1, compactionCount: 1 })).toBe(false)
  })
})

describe('经真实 apply() + agent/pre-step 的集成', () => {
  /** 最小 fake Context：只捕获 pre-step 处理器、保留 effect 的 disposer。 */
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

  const SUMMARY = '在调 v0.12 第二批：文件锚（schema v16）与 [RESUME] 简报，测试从 589 涨到 600。'
  let dir: string
  let dbDir: string
  let workspace: string
  let userStorePath: string
  let disposers: (() => unknown)[]
  let preStep: (payload: unknown, next: () => Promise<unknown>) => Promise<DecisionShape>
  const sessionId = 'sess-resume'
  const events: { type: string; data: unknown; seq: number; time: number }[] = []

  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { cwd: '' }, snapshotEvents: () => events },
  }

  /** 起一个真实插件实例（嵌入器替身、后台整理关闭、首问召回关闭以免混入别的块）。 */
  async function boot(config: Record<string, unknown> = {}): Promise<void> {
    dbDir = join(dir, 'kyzmem')
    const seed = await openKyzmemStore(join(dbDir, 'user.db'))
    await seed.write({ scope: 'user', kind: 'preference', content: '画像条目：偏好简体中文', importance: 0.9 })
    userStorePath = join(dbDir, 'user.db')
    await seed.close()
    agent.session.header.cwd = workspace
    const { ctx, handlers, disposers: pending } = makeFakeContext()
    apply(ctx as never, {
      dbDir, ingest: 'off', maintenanceEnabled: false, queryRewrite: false, queryRecall: 'off', ...config,
    })
    disposers = pending
    preStep = handlers.get('agent/pre-step') as unknown as typeof preStep
    expect(preStep).toBeDefined()
  }

  /** 在项目分库里写一条会话摘要（模拟上一个会话结束时的摘要生成）。 */
  async function seedSummary(summary = SUMMARY): Promise<void> {
    const projectStore = await openKyzmemStore(join(dbDir, resolveProjectIdentity(workspace).dbName))
    await projectStore.setSessionSummary('sess-previous', summary)
    await projectStore.close()
  }

  const run = async (step: number, request?: string, turn = 1): Promise<DecisionShape> => preStep(
    { agent, step, turn, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: request === undefined ? [] : [{ content: [{ type: 'text', text: request }] }] }),
  )

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kyzmem-resume-'))
    workspace = join(dir, 'ws')
    await mkdir(workspace, { recursive: true })
    events.length = 0
    disposers = []
  })

  afterEach(async () => {
    for (const disposer of disposers) await disposer()
    await rm(dir, { recursive: true, force: true })
  })

  it('有摘要时注入：位于画像之前，整块 ≤200 字符，带计数行', async () => {
    await boot()
    await seedSummary()
    // 今日到期的复习条目 + 一条未清 pending 摄取：简报的两行计数都要出现。
    const seeded = await openKyzmemStore(userStorePath)
    await seeded.write({ scope: 'user', kind: 'fact', content: '今天该复习的条目', initialReviewAt: Date.now() - 1000 })
    await seeded.audit('ingest-pending', 'sess-old:3', JSON.stringify({ round: 3 }))
    await seeded.close()

    const injected = injectedText(await run(1, '继续'))
    expect(injected).toContain(RESUME)
    expect(injected).toContain(SUMMARY)
    // 简报在画像之前（开场三行），不在包尾。
    expect(injected.indexOf(RESUME)).toBeLessThan(injected.indexOf(HEADER))
    const section = resumeSection(injected)
    expect(section.length).toBeLessThanOrEqual(200)
    expect(section).toContain(messageIn('zh', 'core.resumeDue', { count: 1 }))
    expect(section).toContain(messageIn('zh', 'core.resumePendingIngest', { count: 1 }))
  })

  it('摘要超长时整块仍 ≤200 字符', async () => {
    await boot()
    await seedSummary('摘要很长。'.repeat(60))
    const section = resumeSection(injectedText(await run(1, '继续')))
    expect(section.length).toBeGreaterThan(0)
    expect(section.length).toBeLessThanOrEqual(200)
  })

  it('无摘要不注入（项目库存在但没有任何摘要）', async () => {
    await boot()
    const projectStore = await openKyzmemStore(join(dbDir, resolveProjectIdentity(workspace).dbName))
    await projectStore.close()
    const injected = injectedText(await run(1, '继续'))
    expect(injected).toContain(HEADER)
    expect(injected).not.toContain(RESUME)
  })

  it('resumeBriefing:false 不注入（开关独立可回滚）', async () => {
    await boot({ resumeBriefing: false })
    await seedSummary()
    const injected = injectedText(await run(1, '继续'))
    expect(injected).toContain(HEADER)
    expect(injected).not.toContain(RESUME)
  })

  it('每会话一次；压缩后重注入一次', async () => {
    await boot()
    await seedSummary()
    expect(injectedText(await run(1, '继续'))).toContain(RESUME)
    // 同一会话的第二轮：不重复注入（画像照常去重）。
    expect(injectedText(await run(1, '继续', 2))).not.toContain(RESUME)
    // 压缩把注入的快照摘要掉 → 允许再注入一次（与画像/首问召回同一判据）。
    events.push({ type: 'compaction/end', data: {}, seq: events.length + 1, time: Date.now() })
    expect(injectedText(await run(3, '继续', 3))).toContain(RESUME)
    // 再往后（无新压缩）又归于安静。
    expect(injectedText(await run(3, '继续', 4))).not.toContain(RESUME)
  })

  it('项目库不存在时不建库（与首问召回同口径）', async () => {
    await boot()
    const freshWorkspace = join(dir, 'ws-fresh')
    await mkdir(freshWorkspace, { recursive: true })
    agent.session.header.cwd = freshWorkspace
    // 画像存在 ⇒ 注入路径照常走，只是没有简报。
    expect(injectedText(await run(1, '继续'))).toContain(HEADER)
    expect(existsSync(join(dbDir, resolveProjectIdentity(freshWorkspace).dbName))).toBe(false)
  })

  it('resumeBriefingChars 生效：压到 80 时简报显著变短', async () => {
    await boot({ resumeBriefingChars: 80 })
    await seedSummary('摘要很长。'.repeat(60))
    const section = resumeSection(injectedText(await run(1, '继续')))
    expect(section.length).toBeGreaterThan(0)
    expect(section.length).toBeLessThanOrEqual(80)
  })
})
