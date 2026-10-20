/**
 * 新手脚手架：宫殿为空时调用，把 4 条示例记忆写入 user 库，引导用户上手。
 * 幂等：检测到 user 库已有 active 条目则跳过，避免覆盖真实数据。
 * @module dsh-kyzmem/palace-sample
 */

import { message } from './i18n/messages.ts'
import type { KyzmemStore } from './store/interface.ts'
import type { ImageryLabel } from './types.ts'

/** Одна примерочная запись: содержимое и образ берутся из словаря на языке вывода. */
interface SampleMemory {
  readonly kind: 'fact' | 'preference' | 'decision' | 'episode'
  readonly content: string
  readonly importance: number
  readonly imagery: ImageryLabel
}

/**
 * 4 条示例记忆：覆盖 4 种 kind 各一。
 *
 * Собирается вызовом, а не константой уровня модуля: тексты берутся из словаря,
 * а язык становится известен позже загрузки модуля (см. src/i18n/messages.ts).
 * Константа застыла бы на языке-заглушке и не сменилась бы вместе с настройкой.
 */
function sampleMemories(): readonly SampleMemory[] {
  return [
    {
      kind: 'preference',
      content: message('core.samplePreference'),
      importance: 0.7,
      imagery: {
        caption: message('core.samplePreferenceCaption'),
        sensoryTags: [message('core.samplePreferenceTag0'), message('core.samplePreferenceTag1')],
        emotionalValence: 0.4,
        provisional: false,
      },
    },
    {
      kind: 'fact',
      content: message('core.sampleFact'),
      importance: 0.6,
      imagery: {
        caption: message('core.sampleFactCaption'),
        sensoryTags: [message('core.sampleFactTag0'), message('core.sampleFactTag1')],
        emotionalValence: 0.2,
        provisional: false,
      },
    },
    {
      kind: 'decision',
      content: message('core.sampleDecision'),
      importance: 0.8,
      imagery: {
        caption: message('core.sampleDecisionCaption'),
        sensoryTags: [message('core.sampleDecisionTag0')],
        emotionalValence: 0.3,
        provisional: false,
      },
    },
    {
      kind: 'episode',
      content: message('core.sampleEpisode'),
      importance: 0.5,
      imagery: {
        caption: message('core.sampleEpisodeCaption'),
        sensoryTags: [message('core.sampleEpisodeTag0'), message('core.sampleEpisodeTag1')],
        emotionalValence: 0.7,
        provisional: false,
      },
    },
  ]
}

/**
 * 若 user 库 active 为空，写入 4 条示例并返回写入的记忆 id 列表；
 * 已存在条目则直接返回空数组（不覆盖）。
 */
export async function initPalaceSample(store: KyzmemStore): Promise<readonly string[]> {
  const stats = await store.stats()
  if (stats.active > 0) return []
  const ids: string[] = []
  for (const memory of sampleMemories()) {
    const record = await store.write({
      scope: 'user',
      kind: memory.kind,
      content: memory.content,
      importance: memory.importance,
      sourceSessionId: null,
      imagery: memory.imagery,
    })
    ids.push(record.id)
  }
  return ids
}
