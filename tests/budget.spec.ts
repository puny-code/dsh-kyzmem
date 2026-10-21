import { describe, expect, it } from 'vitest'
import {
  RECALL_PER_ITEM_CHARS,
  RECALL_TOTAL_CHARS,
  RENDER_PER_ITEM_CHARS,
  enforceBudget,
  fitWithinBudget,
  truncateItem,
  truncateRecallItem,
} from '../src/retrieve/budget.ts'

describe('truncateItem 单条截断', () => {
  it('短文本原样返回', () => {
    expect(truncateItem('短条目')).toBe('短条目')
    expect(truncateItem('a'.repeat(RENDER_PER_ITEM_CHARS))).toBe('a'.repeat(RENDER_PER_ITEM_CHARS))
  })

  it('超长截断并加省略号（缺省走非召回的 1200 字宽上限）', () => {
    const text = '长'.repeat(RENDER_PER_ITEM_CHARS + 100)
    const out = truncateItem(text)
    expect(out).toHaveLength(RENDER_PER_ITEM_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('自定义上限生效', () => {
    expect(truncateItem('abcdef', 3)).toBe('abc…')
  })
})

describe('truncateRecallItem 召回单条截断（跟配置 recallPerItem）', () => {
  it('缺省上限是 160 字', () => {
    expect(RECALL_PER_ITEM_CHARS).toBe(160)
    const text = '召'.repeat(200)
    expect(truncateRecallItem(text)).toHaveLength(161)
  })

  it('配置值覆盖缺省', () => {
    expect(truncateRecallItem('abcdef', 3)).toBe('abc…')
    expect(truncateRecallItem('abc', 3)).toBe('abc')
  })

  it('非召回路径不受召回收紧影响（1200 仍保留）', () => {
    const text = 'a'.repeat(RECALL_PER_ITEM_CHARS + 50)
    expect(truncateItem(text)).toBe(text)
  })
})

describe('enforceBudget 总量装填', () => {
  it('全部装得下时原样保序返回', () => {
    const lines = ['第一行', '第二行', '第三行']
    expect(enforceBudget(lines, 100)).toEqual(lines)
  })

  it('装不下的行被跳过并计数，末尾追加提示行', () => {
    const lines = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]
    const out = enforceBudget(lines, 90)
    expect(out).toEqual([lines[0], `（另有 2 条未展示：缩小查询范围或降低 limit 后重试）`])
  })

  it('某行装不下时继续尝试更短的后续行', () => {
    const lines = ['x'.repeat(90), '短行', 'y'.repeat(90)]
    const out = enforceBudget(lines, 100)
    expect(out).toEqual([lines[0], '短行', `（另有 1 条未展示：缩小查询范围或降低 limit 后重试）`])
  })

  it('空输入返回空数组（无提示行）', () => {
    expect(enforceBudget([], 100)).toEqual([])
  })

  it('默认预算为协议内定值', () => {
    expect(RECALL_TOTAL_CHARS).toBe(4800)
    expect(RECALL_PER_ITEM_CHARS).toBe(160)
    expect(RENDER_PER_ITEM_CHARS).toBe(1200)
  })

  it('fitWithinBudget 是 enforceBudget 的基元：只报丢弃数，不追加提示行', () => {
    const { kept, dropped } = fitWithinBudget(['aa', 'bb', 'cc'], item => item.length, 4)
    expect(kept).toEqual(['aa', 'bb'])
    expect(dropped).toBe(1)
  })
})
