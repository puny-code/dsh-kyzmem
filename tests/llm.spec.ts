import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveSessionId, streamText } from '../src/llm/client.ts'

/** 只提供 llm.stream 的上下文替身：捕获下发选项后立刻抛错，省掉假事件的装配。 */
function captureContext(seen: Record<string, unknown>[]): Context {
  return {
    llm: {
      stream: (options: Record<string, unknown>): AsyncIterable<never> => {
        seen.push(options)
        throw new Error('captured')
      },
    },
  } as never as Context
}

describe('resolveSessionId', () => {
  it('真实会话 id 原样下发', () => {
    expect(resolveSessionId('opencode-go', 'ee1b455655b3', 'kyzmem-ingest')).toBe('ee1b455655b3')
    expect(resolveSessionId('deepseek', ' sess-1 ', 'kyzmem-ingest')).toBe('sess-1')
  })

  it('OpenCode 系 provider 的空会话 id 退化为按用途固定的辅助标识', () => {
    // 宿主只在 sessionId 非空时才写 x-opencode-session，空值会被网关 400 MissingSessionID。
    expect(resolveSessionId('opencode-go', '', 'kyzmem-ingest')).toBe('kyzmem-ingest')
    expect(resolveSessionId('opencode', undefined, 'kyzmem-session-summary')).toBe('kyzmem-session-summary')
    expect(resolveSessionId('opencode-zen', '   ', 'kyzmem-distill')).toBe('kyzmem-distill')
  })

  it('其他 provider 空会话 id 就不下发（不伪造归属）', () => {
    expect(resolveSessionId('deepseek', '', 'kyzmem-ingest')).toBeUndefined()
    expect(resolveSessionId('zai', undefined, 'kyzmem-ingest')).toBeUndefined()
  })

  it('用途里的非法字符被压平，空用途落到 aux', () => {
    expect(resolveSessionId('opencode-go', undefined, 'a b/c')).toBe('kyzmem-a-b-c')
    expect(resolveSessionId('opencode-go', undefined, '!!!')).toBe('kyzmem-aux')
  })
})

describe('streamText 的会话归属', () => {
  const base = {
    route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    system: 'system',
    userText: 'user',
    maxTokens: 64,
    purpose: 'kyzmem-ingest',
    signal: new AbortController().signal,
  }

  it('OpenCode 路由缺会话 id 时仍下发非空 sessionId', async () => {
    const seen: Record<string, unknown>[] = []
    await expect(streamText(captureContext(seen), base)).rejects.toThrow('captured')
    expect(seen[0]?.['sessionId']).toBe('kyzmem-ingest')
  })

  it('非 OpenCode 路由缺会话 id 时不下发该字段', async () => {
    const seen: Record<string, unknown>[] = []
    const params = { ...base, route: { provider: 'deepseek', model: 'deepseek-v4' } }
    await expect(streamText(captureContext(seen), params)).rejects.toThrow('captured')
    expect('sessionId' in (seen[0] ?? {})).toBe(false)
  })

  it('调用方给了真实会话 id 时以它为准', async () => {
    const seen: Record<string, unknown>[] = []
    await expect(streamText(captureContext(seen), { ...base, sessionId: 'sess-42' })).rejects.toThrow('captured')
    expect(seen[0]?.['sessionId']).toBe('sess-42')
  })
})
