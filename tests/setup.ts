/**
 * Общая настройка тестов: язык служебных сообщений — состояние процесса
 * (см. src/i18n/messages.ts), поэтому его фиксируют один раз на весь прогон.
 * Без фиксации язык брался бы из системной локали, и результат зависел бы от
 * машины разработчика.
 *
 * Функции, которым язык передаётся аргументом (renderProfile*, writeMirror,
 * evidenceRefOf, gatherRefurbSuggestions, ToolDeps.language), фиксируются не здесь,
 * а в самом тесте — там язык выбирается под ожидания файла: profile.spec проверяет
 * английские строки, mirror.spec — китайские, тесты инструментов — китайские.
 */
import { setMessageLanguage } from '../src/i18n/messages.ts'

setMessageLanguage('zh')
