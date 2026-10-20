/**
 * Язык вывода — серверная половина плагина.
 *
 * Клиентская половина язык не выбирает: она отдаёт хосту свои словари
 * (см. src/client/locales), а нужный выбирает рендерер по настройке языка DSH.
 * У серверной половины такого сервиса нет — тексты инструментов формируются
 * задолго до отрисовки, — поэтому язык определяется здесь: из настройки плагина,
 * а при значении «auto» — из системной локали.
 *
 * @module dsh-kyzmem/i18n/language
 */

/** Языки, для которых у плагина есть словари. */
export const KYZMEM_LANGUAGES = ['zh', 'en', 'ru'] as const

/** Язык вывода. */
export type KyzmemLanguage = (typeof KYZMEM_LANGUAGES)[number]

/** Язык, когда системный не распознан или словаря для него нет. */
export const FALLBACK_LANGUAGE: KyzmemLanguage = 'en'

/** Настройка языка: конкретный язык либо автоопределение. */
export type LanguageSetting = 'auto' | KyzmemLanguage

/** Проверка, что строка — поддерживаемый язык. */
export function isKyzmemLanguage(value: string): value is KyzmemLanguage {
  return (KYZMEM_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Язык системы. Берётся из Intl: «ru-RU» → «ru».
 * Язык без словаря сводится к языку по умолчанию: показывать пустые подписи хуже,
 * чем показать английские.
 */
export function systemLanguage(): KyzmemLanguage {
  let tag = ''
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return FALLBACK_LANGUAGE
  }
  const base = (tag.split('-')[0] ?? '').toLowerCase()
  return isKyzmemLanguage(base) ? base : FALLBACK_LANGUAGE
}

/** Итоговый язык вывода: «auto» разворачивается в системный язык. */
export function resolveLanguage(setting: LanguageSetting): KyzmemLanguage {
  return setting === 'auto' ? systemLanguage() : setting
}
