/**
 * P1.2 Judge 接线：路由解析 + buildJudge 的 ask 解析。
 *
 * TDD：先红后绿。buildJudge 把会话模型包装成 MemoryJudge：
 * judge.model 为空用默认对话路由；指定模型只换 model 不换 provider；
 * 无路由/调用失败/输出不可解析一律抛错（调用方已有降级：decideWrite 回纯规则，
 * confirmContradictions 回全量建边）。
 */
import { describe, expect, it } from 'vitest'
import { buildJudge, resolveJudgeModel } from '../src/automation/judge.ts'
import type { LlmRoute } from '../src/llm/client.ts'

const route: LlmRoute = { provider: 'deepseek', model: 'deepseek-chat' }

function mockCall(raw: string) {
  return async (_params: {
    route: LlmRoute; system: string; userText: string; maxTokens: number; purpose: string; signal: AbortSignal; sessionId?: string
  }): Promise<string> => raw
}

describe('resolveJudgeModel', () => {
  it('judge.model 为空时用默认对话路由（同一对象）', () => {
    expect(resolveJudgeModel(route, '')).toBe(route)
    expect(resolveJudgeModel(route, '   ')).toBe(route)
  })

  it('指定模型只换 model，不换 provider', () => {
    expect(resolveJudgeModel(route, 'deepseek-reasoner')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('无路由时返回 undefined（调用方降级，不抛错）', () => {
    expect(resolveJudgeModel(undefined, 'deepseek-reasoner')).toBeUndefined()
  })
})

describe('buildJudge.ask', () => {
  const base = {
    call: mockCall('{"same_memory": 0.92}'),
    getRoute: () => route,
    judgeModel: '',
    deferMergeAbove: 0.9,
    deferAcceptBelow: 0.15,
    contradictMinProbability: 0.9,
  }

  it('解析出被问问题的概率', async () => {
    const judge = buildJudge(base)
    await expect(judge.ask('state', [{ id: 'same_memory', instructions: 'x' }])).resolves.toEqual({ same_memory: 0.92 })
  })

  it('输出不可解析时抛错（调用方降级）', async () => {
    const judge = buildJudge({ ...base, call: mockCall('not json') })
    await expect(judge.ask('state', [{ id: 'same_memory', instructions: 'x' }])).rejects.toThrow()
  })

  it('缺失被问 id 时抛错', async () => {
    const judge = buildJudge({ ...base, call: mockCall('{"other": 0.5}') })
    await expect(judge.ask('state', [{ id: 'same_memory', instructions: 'x' }])).rejects.toThrow()
  })

  it('非数字或越界概率抛错', async () => {
    const judge = buildJudge({ ...base, call: mockCall('{"same_memory": 1.5}') })
    await expect(judge.ask('state', [{ id: 'same_memory', instructions: 'x' }])).rejects.toThrow()
  })

  it('无路由时抛错（调用方降级，不静默捏造）', async () => {
    const judge = buildJudge({ ...base, getRoute: () => undefined })
    await expect(judge.ask('state', [{ id: 'same_memory', instructions: 'x' }])).rejects.toThrow()
  })

  it('指定模型时调用走覆盖后的路由', async () => {
    let seen: LlmRoute | undefined
    const judge = buildJudge({
      ...base,
      judgeModel: 'deepseek-reasoner',
      call: (async (params: { route: LlmRoute }) => {
        seen = params.route
        return '{"same_memory": 0.1}'
      }) as typeof base.call,
    })
    await judge.ask('state', [{ id: 'same_memory', instructions: 'x' }])
    expect(seen).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })
})
