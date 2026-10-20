/**
 * Словарь служебных сообщений серверной половины.
 *
 * Клиентская половина переводится средствами хоста (`ctx.locale`), но у серверной
 * такого сервиса нет: тексты инструментов и промптов формируются до отрисовки.
 * Поэтому язык здесь разрешается один раз при сборке плагина (ключ `language`,
 * по умолчанию — язык системы) и держится в модульной переменной: сообщения
 * разбросаны по десяткам функций, и протаскивать язык через каждую дороже, чем
 * хранить одно значение на процесс.
 *
 * Логика отката повторяет хостовую: цепочка сходится к английскому, поэтому
 * английский набор — образец полноты, а русский может быть неполным.
 *
 * Ключи сгруппированы по областям и лежат в `./catalog/*`.
 *
 * @module dsh-kyzmem/i18n/messages
 */

import { FALLBACK_LANGUAGE, type KyzmemLanguage } from './language.ts'
import { en as enCore, ru as ruCore, zh as zhCore } from './catalog/core.ts'
import { en as enLlm, ru as ruLlm, zh as zhLlm } from './catalog/llm.ts'
import { en as enMisc, ru as ruMisc, zh as zhMisc } from './catalog/misc.ts'
import { en as enStore, ru as ruStore, zh as zhStore } from './catalog/store.ts'
import { en as enTool, ru as ruTool, zh as zhTool } from './catalog/tool.ts'

/** Подстановки в шаблон: `{name}` заменяется значением. */
export type MessageParams = Readonly<Record<string, string | number>>

const EN = { ...enCore, ...enLlm, ...enMisc, ...enStore, ...enTool }
const RU = { ...ruCore, ...ruLlm, ...ruMisc, ...ruStore, ...ruTool }
const ZH = { ...zhCore, ...zhLlm, ...zhMisc, ...zhStore, ...zhTool }

/** Ключ сообщения. Английский набор — образец полноты. */
export type MessageKey = keyof typeof EN

const CATALOG: Readonly<Record<KyzmemLanguage, Readonly<Record<string, string>>>> = {
  zh: ZH,
  en: EN,
  ru: RU,
}

let current: KyzmemLanguage = FALLBACK_LANGUAGE

/**
 * Задать язык служебных сообщений.
 * Вызывается один раз при сборке плагина; дальше язык на процесс не меняется.
 */
export function setMessageLanguage(language: KyzmemLanguage): void {
  current = language
}

/** Язык, на котором сейчас говорит серверная половина. */
export function messageLanguage(): KyzmemLanguage {
  return current
}

/** Подстановка параметров; неизвестный параметр остаётся в шаблоне как есть. */
function fill(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Сообщение на заданном языке.
 * Недостающий русский ключ берётся из английского; неизвестный ключ возвращается
 * как есть — лучше показать ключ, чем пустую строку.
 */
export function messageIn(language: KyzmemLanguage, key: MessageKey, params?: MessageParams): string {
  // Неизвестный или отсутствующий язык — не повод показать ключ вместо текста:
  // английский набор объявлен образцом полноты, на него и откатываемся.
  const table = CATALOG[language] ?? CATALOG[FALLBACK_LANGUAGE]
  const template: string | undefined = table[key] ?? EN[key]
  if (template === undefined) return key
  return params === undefined ? template : fill(template, params)
}

/** Сообщение на текущем языке процесса. */
export function message(key: MessageKey, params?: MessageParams): string {
  return messageIn(current, key, params)
}
