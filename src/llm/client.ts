/**
 * 辅助 LLM 调用客户端：封装 ctx.llm.stream + BlockAssembler，路由从会话日志解析。
 * 遵守 model-visible ⟺ logged：每次辅助调用的完整请求由调用方 append 到会话日志。
 * @module dsh-kyzmem/llm/client
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { KyzmemError } from '../types.ts'
import { message } from '../i18n/messages.ts'

/** 一次辅助调用的模型路由。 */
export interface LlmRoute {
  readonly provider: string
  readonly model: string
}

/** 摄取/蒸馏可读的事件最小形状（会话日志事件的运行时窄化视图）。 */
export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
  readonly time?: number
  readonly seq?: number
}

/** 从会话事件流解析最近一条模型路由（request/header → header.config）。 */
export function routeFromEvents(events: readonly SessionEventLike[]): LlmRoute | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | null)?.header?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string' && config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
  }
  return undefined
}

/**
 * 需要 session 头做路由的 provider：OpenCode Zen/Go 在请求里读 `x-opencode-session`，
 * 缺失即 400 MissingSessionID。宿主只在 sessionId 非空时才写这个头。
 */
const SESSION_ROUTED_PROVIDERS = new Set(['opencode', 'opencode-go'])

/**
 * 解析真正随请求下发的 sessionId。
 *
 * 空串不能原样下发：宿主把它映射成 provider 的会话路由头时要求非空
 * （`options.sessionId === undefined ? {} : …`），而 OpenCode 系网关缺该头直接 400，
 * 所以历史回填（拿不到当前会话）会整批失败。这类 provider 退化为按用途固定的
 * 辅助会话标识（同一进程内稳定，可被网关用于路由），其他 provider 则干脆不带。
 * @param provider - 路由 provider id。
 * @param sessionId - 调用方给的归属会话 id（可能为空/缺省）。
 * @param purpose - 辅助调用用途，用于拼稳定的兜底标识。
 * @returns 非空会话 id；不该下发时 undefined。
 */
export function resolveSessionId(provider: string, sessionId: string | undefined, purpose: string): string | undefined {
  const trimmed = sessionId?.trim() ?? ''
  if (trimmed !== '') return trimmed
  if (!SESSION_ROUTED_PROVIDERS.has(provider) && !provider.startsWith('opencode-')) return undefined
  const tag = purpose
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = tag === '' ? 'aux' : tag
  return base.startsWith('kyzmem') ? base : `kyzmem-${base}`
}

/** 从模型输出提取 JSON 数组：剥 Markdown 代码栅栏后解析；无有效数组返回 undefined。 */
export function parseJsonArray(text: string): unknown[] | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 终止原因转错误（session-title-llm 同款语义）。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error(message('llm.finishMaxTokens'))
    case 'tool-calls':
      return new Error(message('llm.finishUnexpectedToolCalls'))
    default:
      return new Error(message('llm.finishUnsupported', { kind: String((finish as { kind?: unknown }).kind) }))
  }
}

/**
 * 一次辅助 LLM 调用：流式收集文本输出。
 * @param ctx - 提供 llm 服务的上下文。
 * @param params.route - 模型路由（来自日志解析或显式配置）。
 * @param params.system - 系统指令。
 * @param params.userText - 用户侧 JSON 框定输入。
 * @param params.sessionId - 归属会话 id 字符串（调用方来自 agent.session.id，内部转 branded）；
 *   空值由 {@link resolveSessionId} 兜底，OpenCode 系 provider 绝不发空 sessionId。
 * @param params.maxTokens - 输出上限。
 * @param params.purpose - 用途标记（宿主 purpose 枚举未开放第三方注册，运行时经 cast 传入，
 *   token-meter 归因由 sessionId/provider/model 承载）。
 * @param params.signal - 取消信号。
 * @returns 模型输出全文。
 */
export async function streamText(
  ctx: Context,
  params: {
    route: LlmRoute
    system: string
    userText: string
    sessionId?: string | undefined
    maxTokens: number
    purpose: string
    signal: AbortSignal
  },
): Promise<string> {
  // 与注入端同工厂构造：v4 producer-owned 前缀 kind（不带退役的 plugin 字段）。
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: params.userText }],
    source: { kind: 'plugin:dsh-kyzmem' },
  })]
  const sessionId = resolveSessionId(params.route.provider, params.sessionId, params.purpose)
  const options: GenerateOptions = {
    provider: params.route.provider,
    model: params.route.model,
    messages,
    system: params.system,
    maxTokens: params.maxTokens,
    ...sessionId === undefined ? {} : { sessionId: sessionId as never as NonNullable<GenerateOptions['sessionId']> },
    purpose: params.purpose as NonNullable<GenerateOptions['purpose']>,
    signal: params.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    assembler.push(chunk)
  }
  const text = assembler.blocks()
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('')
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) {
    // Русская доработка (A-17): исход `max-tokens` — не приговор. У вызывающего есть шанс
    // спасти целые записи из начала ответа, поэтому отдаём ему недосказанное вместе с
    // ошибкой. Для остальных вызывающих ничего не меняется — ошибка по-прежнему бросается.
    if (assembler.finish.kind === 'max-tokens') {
      (terminalError as Error & { partialText?: string }).partialText = text
    }
    throw terminalError
  }
  if (text.trim() === '') throw new KyzmemError('LLM_EMPTY_OUTPUT', message('llm.emptyOutput'))
  return text
}

