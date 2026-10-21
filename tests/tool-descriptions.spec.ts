/**
 * 工具描述的字符预算与语义护栏。
 *
 * 22 个工具的 schema 每个请求都会重新发一遍，描述文案是固定 token 成本的大头
 * （改前：顶层 8,294 字符 / 全量 14,727 字符，英文口径）。这里把瘦身目标钉成
 * 断言，防止后续改文案时悄悄长回去：
 *   · 顶层单条 ≤150 字符、参数单条 ≤60 字符、全量 ≤6,000 字符（英文为验收口径）；
 *   · 每条顶层描述仍能说清"做什么"，动作词不许丢；
 *   · 最容易被误解的 5 个工具（search / examine / save / assess / profile_edit）
 *     的语义关键词单独钉死，防止瘦身把含义删没。
 *
 * 键集合取自 `src/tools/create.ts` 里真正的 `description: message('tool.…')`
 * 引用，不手抄工具表：新增工具时这里会自动覆盖到。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, ru, zh } from '../src/i18n/catalog/tool.ts'

const LANGUAGES = ['zh', 'en', 'ru'] as const
type Language = (typeof LANGUAGES)[number]

/** 三份目录都能按字符串键取，方便统一遍历。 */
const CATALOG: Record<Language, Record<string, string>> = { zh, en, ru }

/** 预算口径（字符数）。英文是验收语言：固定 token 成本按英文档算。 */
const BUDGET = { top: 150, param: 60, keys: 6000, emitted: 6600 } as const
const GATED_LANGUAGE: Language = 'en'
/**
 * 单键例外：nextStrategy 必须把 6 个枚举值原样写出来（评审 P1-3）。
 * 6 个值本身 58 字符，加任意分隔符最少 63，压不进 60；用 `search_*` 通配正是评审要修掉的写法。
 * 与 scripts/measure-descriptions.mjs 的 PARAM_ALLOWANCES 保持同一份口径。
 */
const PARAM_ALLOWANCES: Readonly<Record<string, number>> = {
  'tool.assessNextStrategyDescription': 70,
}

const CREATE_PATH = fileURLToPath(new URL('../src/tools/create.ts', import.meta.url))
const createText = readFileSync(CREATE_PATH, 'utf8')

/** 工具名 → 顶层描述键，顺序即工具表顺序。 */
const TOP = [...createText.matchAll(/name: '(kyzmem_[a-z_]+)',\s*\n\s*description: message\('(tool\.[A-Za-z0-9]+)'\)/g)]
  .map(match => ({ tool: match[1] ?? '', key: match[2] ?? '' }))
const TOP_KEYS = TOP.map(entry => entry.key)
/** 所有挂在 description 位置的键：顶层 + 参数（共享键只算一次）。 */
const DESCRIPTION_KEYS = [...new Set(
  [...createText.matchAll(/\bdescription:\s*message\('(tool\.[A-Za-z0-9]+)'/g)].map(match => match[1] ?? ''),
)]
/** 每一处 `description:` 引用（含重复）：真实请求里共享键会被按调用点重复下发。 */
const DESCRIPTION_REFS = [...createText.matchAll(/\bdescription:\s*message\('(tool\.[A-Za-z0-9]+)'/g)]
  .map(match => match[1] ?? '')
const PARAM_KEYS = DESCRIPTION_KEYS.filter(key => !TOP_KEYS.includes(key))

/** 取某语言的文案；缺失用空串，让断言以"空"而不是"undefined"报错。 */
const textOf = (language: Language, key: string): string => CATALOG[language][key] ?? ''

/** 每个工具顶层描述必须含有的动作词（小写匹配），防止取名被压成空话。 */
const ACTION_WORDS: Readonly<Record<string, readonly string[]>> = {
  kyzmem_save: ['save', 'kind', 'items'],
  kyzmem_search: ['search', 'room'],
  kyzmem_facts: ['fact', 'entity'],
  kyzmem_assess: ['evidence', 'verdict'],
  kyzmem_timeline: ['browse', 'memories'],
  kyzmem_episode_timeline: ['episode', 'session'],
  kyzmem_update: ['correct', 'supersede'],
  kyzmem_forget: ['delete', 'epitaph'],
  kyzmem_ingest_history: ['backfill', 'sessions'],
  kyzmem_audit_forgotten: ['closed', 'epitaph'],
  kyzmem_review_queue: ['queue', 'recall'],
  kyzmem_report: ['record', 'grade'],
  kyzmem_review: ['audit'],
  kyzmem_stats: ['statistics', 'room'],
  kyzmem_export: ['export'],
  kyzmem_import: ['import'],
  kyzmem_distill: ['distil'],
  kyzmem_reflect: ['consolidate'],
  kyzmem_examine: ['nameplate', 'ids'],
  kyzmem_neighbors: ['corridor', 'neighbour'],
  kyzmem_tour: ['tour', 'mode='],
  kyzmem_profile_edit: ['profile', 'action='],
}

describe('工具描述预算（瘦身后的固定 token 成本）', () => {
  it('工具表是 22 个顶层描述键，键集合取自 create.ts', () => {
    expect(TOP).toHaveLength(22)
    // 同一个键被两个工具复用会让顶层口径重复计数。
    expect(new Set(TOP_KEYS).size).toBe(TOP_KEYS.length)
    // 参数描述不能为空集：否则说明 create.ts 的 description 写法变了，本文件的取数逻辑失效。
    expect(PARAM_KEYS.length).toBeGreaterThan(0)
    // 顶层键必须都能在目录里查到，否则预算统计是假的。
    for (const key of TOP_KEYS) expect(textOf('en', key)).not.toBe('')
  })

  it(`顶层描述每条 ≤${BUDGET.top} 字符，三语都不超`, () => {
    const over: string[] = []
    for (const language of LANGUAGES) {
      for (const key of TOP_KEYS) {
        const length = textOf(language, key).length
        if (length === 0 || length > BUDGET.top) over.push(`${language} ${key}=${length}`)
      }
    }
    expect(over).toEqual([])
  })

  it(`参数描述每条 ≤${BUDGET.param} 字符（nextStrategy 单独额度 ${PARAM_ALLOWANCES['tool.assessNextStrategyDescription']}），三语都不超`, () => {
    const over: string[] = []
    for (const language of LANGUAGES) {
      for (const key of PARAM_KEYS) {
        const length = textOf(language, key).length
        const limit = PARAM_ALLOWANCES[key] ?? BUDGET.param
        if (length === 0 || length > limit) over.push(`${language} ${key}=${length}>${limit}`)
      }
    }
    expect(over).toEqual([])
  })

  it(`keys 口径（唯一键）英文 ≤${BUDGET.keys} 字符`, () => {
    const keys = DESCRIPTION_KEYS.reduce((sum, key) => sum + textOf(GATED_LANGUAGE, key).length, 0)
    expect(keys).toBeLessThanOrEqual(BUDGET.keys)
    // 老轨迹留个对照：改前唯一键是 14,727 字符，瘦身至少得砍掉一半，否则说明只动了个别条目。
    expect(keys).toBeLessThan(14_727 / 2)
  })

  it(`emitted 口径（按 description 调用点展开，共享键重复计）英文 ≤${BUDGET.emitted} 字符`, () => {
    const emitted = DESCRIPTION_REFS.reduce((sum, key) => sum + textOf(GATED_LANGUAGE, key).length, 0)
    const keys = DESCRIPTION_KEYS.reduce((sum, key) => sum + textOf(GATED_LANGUAGE, key).length, 0)
    expect(emitted).toBeLessThanOrEqual(BUDGET.emitted)
    // emitted 必须 ≥ keys：差额正是共享键的重复下发，两个口径都在测才看得见这块成本。
    expect(emitted).toBeGreaterThanOrEqual(keys)
    expect(DESCRIPTION_REFS.length).toBeGreaterThan(DESCRIPTION_KEYS.length)
  })

  it('顶层描述带上各工具的动作词：能判断"这个工具干什么"', () => {
    const missing: string[] = []
    for (const { tool, key } of TOP) {
      const words = ACTION_WORDS[tool]
      if (words === undefined) { missing.push(`${tool}: 没有登记动作词`); continue }
      const text = textOf(GATED_LANGUAGE, key).toLowerCase()
      for (const word of words) if (!text.includes(word)) missing.push(`${tool} 缺少「${word}」`)
    }
    // 反向：动作词表里不能有工具表里不存在的工具（工具改名/删除时提醒本文件同步）。
    for (const tool of Object.keys(ACTION_WORDS)) {
      if (!TOP.some(entry => entry.tool === tool)) missing.push(`${tool}: 动作词表里有、工具表里没有`)
    }
    expect(missing).toEqual([])
  })
})

describe('语义护栏：最容易被误解的工具', () => {
  it('kyzmem_search：混合检索、room 收窄、返回可引用的 ref', () => {
    const text = textOf('en', 'tool.searchDescription').toLowerCase()
    expect(text).toContain('search')
    expect(text).toMatch(/semantic|keyword/)
    // room 是"收窄到单个房间"，不是必填：丢了这个词模型会以为只能全库搜。
    expect(text).toContain('room')
    expect(text).toMatch(/refs?|ids?/)
  })

  it('kyzmem_examine：渐进披露，按 id 取完整铭牌，不是另一路检索', () => {
    const text = textOf('en', 'tool.examineDescription').toLowerCase()
    expect(text).toContain('progressive')
    expect(text).toContain('nameplate')
    expect(text).toContain('ids')
    // 必须说明 id 来源，否则模型会拿关键词直接调它。
    expect(text).toMatch(/search\/timeline\/neighbors|search/)
  })

  it('kyzmem_save：单条/批量两种形态、kind 与返回处置', () => {
    const text = textOf('en', 'tool.saveDescription').toLowerCase()
    expect(text).toContain('save')
    expect(text).toContain('kind')
    expect(text).toContain('items')
    expect(text).toMatch(/≤10|max 10|at most 10/)
    // 返回的是 id / 并入 / 待裁决，不是整条内容。
    expect(text).toMatch(/returns/)
  })

  it('kyzmem_assess：证据门的位置、必填项与代码校验口径', () => {
    const text = textOf('en', 'tool.assessDescription').toLowerCase()
    expect(text).toContain('evidence')
    expect(text).toContain('batchid')
    expect(text).toContain('sufficient')
    expect(text).toContain('nextstrategy')
    expect(text).toContain('verdict')
    // 调用时机是"检索之后、作答之前"——这是它存在的理由。
    expect(text).toContain('kyzmem_search')
    expect(text).toContain('before answering')
  })

  it('kyzmem_profile_edit：管的画像层、三个 action、乐观锁', () => {
    const text = textOf('en', 'tool.profileEditDescription').toLowerCase()
    expect(text).toContain('profile')
    expect(text).toContain('session start')
    expect(text).toContain('expectedversion')
    for (const action of ['view', 'edit', 'rollback']) expect(text).toContain(action)
  })

  it('kyzmem_stats：房间目录是检索的前置入口', () => {
    const text = textOf('en', 'tool.statsDescription').toLowerCase()
    expect(text).toContain('statistics')
    expect(text).toContain('room')
  })
})

describe('参数语义：必填项的含义没有被预算压掉', () => {
  it('mode 的三个取值都在（index / timeline / full）', () => {
    const text = textOf('en', 'tool.searchModeDescription')
    for (const value of ['index', 'timeline', 'full']) expect(text).toContain(value)
    expect(text).toContain('default')
  })

  it('asOf 明确是"时点回看"', () => {
    expect(textOf('en', 'tool.searchAsOfDescription')).toContain('point-in-time')
    expect(textOf('en', 'tool.factsAsOfDescription')).toContain('point-in-time')
  })

  it('nextStrategy 的 6 个真实取值都写明，不再用 search_* 通配', () => {
    const allowed = ['answer', 'search_keyword', 'search_room', 'search_timeline', 'ask_user', 'stop']
    for (const language of LANGUAGES) {
      const text = textOf(language, 'tool.assessNextStrategyDescription')
      for (const value of allowed) expect(text, `${language} 缺 ${value}`).toContain(value)
      expect(text).not.toContain('search_*')
    }
  })

  it('scope 的三义都写着：user=跨项目 / project=当前工作区 / shared=跨 agent', () => {
    for (const language of LANGUAGES) {
      const text = textOf(language, 'tool.scopeDescription')
      expect(text, `${language} 缺 user=`).toContain('user=')
      expect(text, `${language} 缺 project=`).toContain('project=')
      expect(text, `${language} 缺 shared=`).toContain('shared=')
      // 默认值占位符必须保留：共享键合并后每处的默认值靠它展开。
      expect(text).toContain('{default}')
    }
  })

  it('save 的 kind 描述列全 5 种（含 skill）', () => {
    for (const key of ['tool.saveKindDescription', 'tool.saveItemKindDescription']) {
      for (const language of LANGUAGES) {
        const text = textOf(language, key)
        for (const kind of ['fact', 'preference', 'decision', 'episode', 'skill']) {
          expect(text, `${language} ${key} 缺 ${kind}`).toContain(kind)
        }
      }
    }
  })

  it('search 顶层描述说清 index=元信息 / full=正文（防模型一律选 full）', () => {
    const text = textOf('en', 'tool.searchDescription')
    expect(text).toMatch(/index[=: ]/i)
    expect(text).toMatch(/metadata|meta/i)
    expect(text).toMatch(/full[=: ]/i)
    expect(text).toContain('text')
    // 正文不在 index 里，就要说清去哪取——否则模型会以为 index 就是全文。
    expect(text).toContain('examine')
  })

  it('sufficient 的强约束仍写着 nextStrategy=answer', () => {
    expect(textOf('en', 'tool.assessSufficientDescription')).toContain('nextStrategy=answer')
  })

  it('evidenceRefs 仍写明上限与"只能取本批次 ref"', () => {
    const text = textOf('en', 'tool.assessEvidenceRefsDescription')
    expect(text).toContain('ref=')
    expect(text).toContain('8')
  })

  it('共享参数键仍带 {default} 占位符：合并后每处默认值仍可读', () => {
    for (const key of ['tool.scopeDescription', 'tool.limitDescription']) {
      expect(textOf('en', key)).toContain('{default}')
      for (const language of LANGUAGES) expect(textOf(language, key)).toContain('{default}')
    }
  })
})

describe('共享参数合并：不再按工具各写一遍', () => {
  it('旧的 scope / limit / since / until 重复键已合并，不允许回潮', () => {
    const legacy = [
      'tool.scopeDescriptionProject', 'tool.scopeDescriptionAll', 'tool.scopeDescriptionUser',
      'tool.entryScopeDescription', 'tool.updateScopeDescription', 'tool.importScopeDescription',
      'tool.searchLimitDescription', 'tool.limitDescription20', 'tool.reviewQueueLimitDescription',
      'tool.episodeLimitDescription',
      'tool.sinceDateDescription', 'tool.untilDateDescription',
    ]
    for (const key of legacy) {
      for (const language of LANGUAGES) expect(CATALOG[language]).not.toHaveProperty(key)
    }
  })

  it('每个共享键调用点都传了 {default}：漏传会让模型看到字面量 "{default}"', () => {
    // message() 对未传的占位符原样保留（见 src/i18n/messages.ts 的 fill），
    // 所以漏掉 options 不会报错、只会把 "{default}" 发出去——这里用引用次数对齐来兜住。
    const count = (pattern: RegExp) => [...createText.matchAll(pattern)].length
    const guarded = [
      { key: 'tool.scopeDescription', all: /message\('tool\.scopeDescription'\)/g, withDefault: /message\('tool\.scopeDescription', \{ default: [^}]+ \}\)/g },
      { key: 'tool.limitDescription', all: /message\('tool\.limitDescription'\)/g, withDefault: /message\('tool\.limitDescription', \{ default: [^}]+ \}\)/g },
    ]
    const problems: string[] = []
    for (const { key, all, withDefault } of guarded) {
      if (count(all) > 0) problems.push(`${key}: ${count(all)} 处调用没传 {default}`)
      if (count(withDefault) === 0) problems.push(`${key}: create.ts 里一处带 {default} 的调用都没有，取数逻辑可能失效`)
    }
    expect(problems).toEqual([])
  })
})

describe('三语同步', () => {
  it('描述键在中/英/俄三份目录里都存在且非空', () => {
    const missing: string[] = []
    for (const language of LANGUAGES) {
      for (const key of DESCRIPTION_KEYS) {
        if (textOf(language, key).trim() === '') missing.push(`${language} ${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})
