/**
 * P1.2 会话模型裁决器：把辅助 LLM 包装成 MemoryJudge。
 *
 * - judge.model 为空 → 用默认对话路由（当前会话在用的 provider/model）；
 *   指定模型 → 只换 model，不换 provider；指定模型不可用时调用失败，
 *   由调用方降级（decideWrite 回纯规则 defer，confirmContradictions 回全量建边）。
 * - ask 失败一律抛错：无路由、调用异常、输出不可解析、缺失被问 id、
 *   非数字或越界概率。绝不静默捏造概率。
 * - 阈值初值（P1.3 影子评测后再标定）：merge ≥0.9，accept ≤0.15，contradicts 建边 ≥0.9。
 *
 * @module dsh-kyzmem/automation/judge
 */
import type { LlmRoute } from '../llm/client.ts'
import type { JudgeAnswers, JudgeQuestion, MemoryJudge } from '../write-disposition.ts'

/** 模糊带裁决阈值初值：merge 判定线（P1.3 影子评测后标定）。 */
export const JUDGE_DEFER_MERGE_ABOVE = 0.9
/** 模糊带裁决阈值初值：accept 判定线（P1.3 影子评测后标定）。 */
export const JUDGE_DEFER_ACCEPT_BELOW = 0.15
/** 矛盾确认阈值初值：达到才建 contradicts 边（P1.3 影子评测后标定）。 */
export const JUDGE_CONTRADICT_MIN_PROBABILITY = 0.9

/** 单次 judge 调用的 token 上限：只答概率 JSON，不需要长输出。 */
export const JUDGE_MAX_TOKENS = 256

export interface JudgeCallParams {
  readonly route: LlmRoute
  readonly system: string
  readonly userText: string
  readonly maxTokens: number
  readonly purpose: string
  readonly signal: AbortSignal
  readonly sessionId?: string
}

export interface BuildJudgeDeps {
  /** 与 ingest/tools 同形的辅助调用（路由由调用方在 params 里给全）。 */
  readonly call: (params: JudgeCallParams) => Promise<string>
  /** 每次 ask 时解析当前路由（hook 按调用快照、工具按执行快照）。 */
  readonly getRoute: () => LlmRoute | undefined
  /** 配置 judge.model：空 = 默认对话模型。 */
  readonly judgeModel: string
  /**
   * 调用方 signal（会话中断/超时可取消 judge 调用）；与内部 60s 上限二者先到先取消。
   * 缺省只用内部上限（测试与无会话上下文的调用）。
   */
  readonly signal?: AbortSignal
  readonly deferMergeAbove?: number
  readonly deferAcceptBelow?: number
  readonly contradictMinProbability?: number
}

/**
 * 按 judge.model 解析 judge 实际走的路由。
 * @returns 空模型名返回原路由（同一对象）；指定模型只换 model；无路由返回 undefined。
 */
export function resolveJudgeModel(route: LlmRoute | undefined, judgeModel: string): LlmRoute | undefined {
  if (route === undefined) return undefined
  const model = judgeModel.trim()
  if (model === '') return route
  return { ...route, model }
}

const JUDGE_SYSTEM = [
  'You are a memory adjudicator. Answer ONLY with a JSON object mapping each question id to a probability number between 0 and 1.',
  'No explanation, no markdown, no extra keys. Example: {"same_memory": 0.92}.',
].join('\n')

/**
 * 构造 MemoryJudge。ask 对 state 并行提问，返回 id → 概率。
 * @throws 无路由 / 调用异常 / 输出不可解析 / 缺失被问 id / 非数字或越界。
 */
export function buildJudge(deps: BuildJudgeDeps): MemoryJudge {
  const deferMergeAbove = deps.deferMergeAbove ?? JUDGE_DEFER_MERGE_ABOVE
  const deferAcceptBelow = deps.deferAcceptBelow ?? JUDGE_DEFER_ACCEPT_BELOW
  const contradictMinProbability = deps.contradictMinProbability ?? JUDGE_CONTRADICT_MIN_PROBABILITY
  return {
    deferMergeAbove,
    deferAcceptBelow,
    contradictMinProbability,
    ask: async (state: string, questions: readonly JudgeQuestion[]): Promise<JudgeAnswers> => {
      const route = resolveJudgeModel(deps.getRoute(), deps.judgeModel)
      if (route === undefined) throw new Error('dsh-kyzmem: judge has no route (session has no model request and no route override)')
      const userText = `${state}\n\nQuestions:\n${questions.map(question => `- id: ${question.id}\n  ${question.instructions}`).join('\n')}`
      const raw = await deps.call({
        route,
        system: JUDGE_SYSTEM,
        userText,
        maxTokens: JUDGE_MAX_TOKENS,
        purpose: 'judge',
        signal: deps.signal === undefined
          ? AbortSignal.timeout(60_000)
          : AbortSignal.any([deps.signal, AbortSignal.timeout(60_000)]),
      })
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('dsh-kyzmem: judge output is not JSON')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('dsh-kyzmem: judge output is not a JSON object')
      }
      const answers: Record<string, number> = {}
      for (const question of questions) {
        const value = (parsed as Record<string, unknown>)[question.id]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(`dsh-kyzmem: judge answer for "${question.id}" is not a probability in [0, 1]`)
        }
        answers[question.id] = value
      }
      return answers
    },
  }
}
