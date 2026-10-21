import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('空配置回落到 ~/.dsh/kyzmem 与全部默认值', () => {
    const resolved = resolveConfig({})
    expect(resolved.dbDir).toBe(join(homedir(), '.dsh', 'kyzmem'))
    expect(resolved.injectProfile).toBe(true)
    expect(resolved.profileTopN).toBe(8)
    expect(resolved.modelCacheDir).toBe(join(homedir(), '.dsh', 'kyzmem', 'models'))
    expect(resolved.ingest).toBe('off')
    expect(resolved.legacyMigration).toBe('eager')
    expect(resolved.routeOverride).toBeUndefined()
    expect(resolved.decayAfterDays).toBe(90)
    expect(resolved.injectTokenBudget).toBe(1024)
    expect(resolved.rankRecencyWeight).toBe(0.2)
    expect(resolved.rankProofWeight).toBe(0.05)
    // E（v0.12 第三批）：adoption 因子默认开、权重 0.05（贡献封顶 +10%，见 sqlite.ts）。
    expect(resolved.rankAdoptionWeight).toBe(0.05)
    expect(resolved.queryRewrite).toBe(true)
    expect(resolved.injectItemBudgetStart).toBe(160)
    expect(resolved.injectItemBudgetDecay).toBe(0.9)
    expect(resolved.injectItemBudgetFloor).toBe(24)
    expect(resolved.assessReminder).toBe(true)
    // 首问 keyed 召回（方案 §4 A）：默认 light / 640 字 / 3 条。
    // 640 让「3 条 × 80 字（截断后 81）+ 标题 + examine 提示 + 批次行」在三语下都装得下
    // （实测本仓模板：zh 460 / en 569 / ru 589 字符；600 时 ru 差一点装不下第 3 条——复审 N1）。
    expect(resolved.queryRecall).toBe('light')
    expect(resolved.queryRecallBudget).toBe(640)
    expect(resolved.queryRecallTop).toBe(3)
  })

  it('显式值全部透传', () => {
    const resolved = resolveConfig({
      dbDir: '/tmp/e', injectProfile: false, profileTopN: 3, modelCacheDir: '/tmp/m',
      hfEndpoint: 'https://hf-mirror.com', ingest: 'eager',
      provider: 'deepseek', model: 'deepseek-v4-flash',
      decayAfterDays: 7,
      injectTokenBudget: 2048, rankRecencyWeight: 0, rankProofWeight: 1.5, rankAdoptionWeight: 0.3,
      queryRewrite: false,
      injectItemBudgetStart: 200, injectItemBudgetDecay: 0.8, injectItemBudgetFloor: 40,
      assessReminder: false,
    })
    expect(resolved.dbDir).toBe('/tmp/e')
    expect(resolved.injectProfile).toBe(false)
    expect(resolved.profileTopN).toBe(3)
    expect(resolved.modelCacheDir).toBe('/tmp/m')
    expect(resolved.hfEndpoint).toBe('https://hf-mirror.com')
    expect(resolved.ingest).toBe('eager')
    expect(resolved.routeOverride).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolved.decayAfterDays).toBe(7)
    expect(resolved.injectTokenBudget).toBe(2048)
    expect(resolved.rankRecencyWeight).toBe(0)
    expect(resolved.rankProofWeight).toBe(1.5)
    expect(resolved.rankAdoptionWeight).toBe(0.3)
    expect(resolved.queryRewrite).toBe(false)
    expect(resolved.injectItemBudgetStart).toBe(200)
    expect(resolved.injectItemBudgetDecay).toBe(0.8)
    expect(resolved.injectItemBudgetFloor).toBe(40)
    expect(resolved.assessReminder).toBe(false)
  })

  it('未知键 loud 失败', () => {
    expect(() => resolveConfig({ nope: 1 } as never)).toThrow(/unknown config key/)
  })

  it('profileTopN 越界 loud 失败', () => {
    expect(() => resolveConfig({ profileTopN: 0 })).toThrow(/profileTopN/)
    expect(() => resolveConfig({ profileTopN: 65 })).toThrow(/profileTopN/)
  })

  it('ingest 非法档位 loud 失败', () => {
    expect(() => resolveConfig({ ingest: 'aggressive' as never })).toThrow(/ingest/)
  })

  it('provider/model 只给其一 loud 失败', () => {
    expect(() => resolveConfig({ provider: 'deepseek' })).toThrow(/provider and model/)
    expect(() => resolveConfig({ model: 'v4' })).toThrow(/provider and model/)
  })

  it('decay 参数越界 loud 失败', () => {
    expect(() => resolveConfig({ decayAfterDays: 0 })).toThrow(/decayAfterDays/)
  })

  it('injectTokenBudget 越界 loud 失败', () => {
    expect(() => resolveConfig({ injectTokenBudget: 127 })).toThrow(/injectTokenBudget/)
    expect(() => resolveConfig({ injectTokenBudget: 8193 })).toThrow(/injectTokenBudget/)
    expect(() => resolveConfig({ injectTokenBudget: 1024.5 })).toThrow(/injectTokenBudget/)
  })

  it('排序 boost 权重越界 loud 失败', () => {
    expect(() => resolveConfig({ rankRecencyWeight: -0.1 })).toThrow(/rankRecencyWeight/)
    expect(() => resolveConfig({ rankRecencyWeight: 2.1 })).toThrow(/rankRecencyWeight/)
    expect(() => resolveConfig({ rankProofWeight: 3 })).toThrow(/rankProofWeight/)
    // adoption 的因子贡献封顶 +10%，权重上界 1（再大也不生效，但不静默接受乱填）。
    expect(() => resolveConfig({ rankAdoptionWeight: -0.1 })).toThrow(/rankAdoptionWeight/)
    expect(() => resolveConfig({ rankAdoptionWeight: 1.1 })).toThrow(/rankAdoptionWeight/)
  })

  it('分级递减预算参数越界 loud 失败', () => {
    expect(() => resolveConfig({ injectItemBudgetStart: 39 })).toThrow(/injectItemBudgetStart/)
    expect(() => resolveConfig({ injectItemBudgetStart: 2001 })).toThrow(/injectItemBudgetStart/)
    expect(() => resolveConfig({ injectItemBudgetStart: 160.5 })).toThrow(/injectItemBudgetStart/)
    expect(() => resolveConfig({ injectItemBudgetDecay: 0.49 })).toThrow(/injectItemBudgetDecay/)
    expect(() => resolveConfig({ injectItemBudgetDecay: 1.01 })).toThrow(/injectItemBudgetDecay/)
    expect(() => resolveConfig({ injectItemBudgetFloor: 7 })).toThrow(/injectItemBudgetFloor/)
    expect(() => resolveConfig({ injectItemBudgetFloor: 201 })).toThrow(/injectItemBudgetFloor/)
  })

  it('floor 超过 start loud 失败（截断预算下限不得高于首条预算）', () => {
    expect(() => resolveConfig({ injectItemBudgetStart: 100, injectItemBudgetFloor: 101 }))
      .toThrow(/injectItemBudgetFloor/)
  })

  it('assessReminder 非布尔 loud 失败', () => {
    expect(() => resolveConfig({ assessReminder: 'yes' as never })).toThrow(/assessReminder/)
  })

  it('首问召回档位：full 同时抬条数与预算，避免 full 与 light 等效', () => {
    expect(resolveConfig({ queryRecall: 'off' }).queryRecall).toBe('off')
    expect(resolveConfig({ queryRecall: 'light' }).queryRecallTop).toBe(3)
    expect(resolveConfig({ queryRecall: 'light' }).queryRecallBudget).toBe(640)
    // full：5 条 + 预算下限 960（实测本仓模板 5 条 zh 706 / en 817 / ru 837，三语都放得下）。
    expect(resolveConfig({ queryRecall: 'full' }).queryRecallTop).toBe(5)
    expect(resolveConfig({ queryRecall: 'full' }).queryRecallBudget).toBe(960)
    // 显式值：条数优先；预算在 full 下被抬到「至少 960」——这是**有意**的：低于 960 的 full
    // 兑现不了 5 条，与 light 同效（复审 N2）。生效值就是 ResolvedKyzmemConfig.queryRecallBudget，
    // 调用方无需自己再算；light 下显式值原样透传。
    expect(resolveConfig({ queryRecall: 'full', queryRecallTop: 2 }).queryRecallTop).toBe(2)
    expect(resolveConfig({ queryRecall: 'full', queryRecallBudget: 500 }).queryRecallBudget).toBe(960)
    expect(resolveConfig({ queryRecall: 'full', queryRecallBudget: 800 }).queryRecallBudget).toBe(960)
    expect(resolveConfig({ queryRecall: 'full', queryRecallBudget: 1000 }).queryRecallBudget).toBe(1000)
    expect(resolveConfig({ queryRecallTop: 7, queryRecallBudget: 1000 }).queryRecallBudget).toBe(1000)
    expect(resolveConfig({ queryRecallBudget: 300 }).queryRecallBudget).toBe(300)
  })

  it('首问召回非法值 loud 失败', () => {
    expect(() => resolveConfig({ queryRecall: 'eager' as never })).toThrow(/queryRecall/)
    expect(() => resolveConfig({ queryRecallBudget: 239 })).toThrow(/queryRecallBudget/)
    expect(() => resolveConfig({ queryRecallBudget: 4001 })).toThrow(/queryRecallBudget/)
    expect(() => resolveConfig({ queryRecallBudget: 320.5 })).toThrow(/queryRecallBudget/)
    expect(() => resolveConfig({ queryRecallTop: 0 })).toThrow(/queryRecallTop/)
    expect(() => resolveConfig({ queryRecallTop: 11 })).toThrow(/queryRecallTop/)
    expect(() => resolveConfig({ queryRecallTop: 2.5 })).toThrow(/queryRecallTop/)
  })

  it('RESUME 恢复简报：默认开启、整块 200 字符，非法值 loud 失败', () => {
    // 默认开启：素材（会话摘要）本来就在库里，不给就用不上。
    expect(resolveConfig({}).resumeBriefing).toBe(true)
    expect(resolveConfig({}).resumeBriefingChars).toBe(200)
    expect(resolveConfig({ resumeBriefing: false }).resumeBriefing).toBe(false)
    expect(resolveConfig({ resumeBriefingChars: 80 }).resumeBriefingChars).toBe(80)
    expect(resolveConfig({ resumeBriefingChars: 600 }).resumeBriefingChars).toBe(600)
    expect(() => resolveConfig({ resumeBriefingChars: 79 })).toThrow(/resumeBriefingChars/)
    expect(() => resolveConfig({ resumeBriefingChars: 601 })).toThrow(/resumeBriefingChars/)
    expect(() => resolveConfig({ resumeBriefingChars: 120.5 })).toThrow(/resumeBriefingChars/)
    expect(() => resolveConfig({ resumeBriefing: 'yes' as never })).toThrow(/resumeBriefing/)
  })
})

describe('legacyMigration config', () => {
  it('accepts both policies', () => {
    expect(resolveConfig({ legacyMigration: 'eager' }).legacyMigration).toBe('eager')
    expect(resolveConfig({ legacyMigration: 'conservative' }).legacyMigration).toBe('conservative')
  })
  it.each(['typo', '', null, false, 1])('rejects invalid policy %s', (value) => {
    expect(() => resolveConfig({ legacyMigration: value as never })).toThrow(/legacyMigration/)
  })
})
