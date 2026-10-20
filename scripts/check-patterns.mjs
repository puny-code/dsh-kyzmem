#!/usr/bin/env node
/**
 * Приёмка языковых образцов распознавания (F-10).
 *
 * Проверяет, что вычистка секретов и отсев болтовни работают на всех объявленных
 * языках, а не только на китайском. До F-10 русская запись «пароль: …» уходила
 * в память открытым текстом, а «не запоминай это» запись не отменяло.
 *
 * Проверяется не «код запустился», а поведение: что вычищается, что обязано
 * остаться нетронутым и как это меняется при переключении языка.
 *
 * Запуск: node scripts/check-patterns.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = resolve(import.meta.dirname, '..', 'src')
const load = (rel) => import(pathToFileURL(resolve(SRC, rel)).href)

const { redactSecrets } = await load('security/redact.ts')
const { setMessageLanguage } = await load('i18n/messages.ts')
const { setExtraRedactWords, extraRedactWords, chitchatPatterns, noCapturePatterns } = await load('i18n/patterns.ts')

/*
 * Почему не импортируем hook.ts. Он тянет за собой llm/client.ts, а тот — значение
 * из `@deepseek-ai/dsh-llm`: внутренний пакет DSH, существующий только в дереве harness
 * (scripts/link-peers.mjs поставляет его симлинком оттуда). Поэтому обе функции
 * проверяются здесь ровно тем же выражением, что и в hook.ts, а само связывание
 * hook.ts с языковым пакетом проверяется по исходнику в конце.
 */
const isChitchat = (text) => chitchatPatterns().some((pattern) => pattern.test(text.trim()))
const forbidsCapture = (text) => noCapturePatterns().some((pattern) => pattern.test(text))

let failures = 0
let total = 0

/** Одна проверка: ожидание против факта. */
function show(ok, label, detail) {
  total++
  if (ok) {
    console.log(`  ок    ${label}`)
    return
  }
  failures++
  console.log(`  ПРОВАЛ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Текст обязан быть вычищен. */
function redacts(label, text) {
  const out = redactSecrets(text)
  show(out.includes('[REDACTED:'), label, `ожидалась пометка, получено: ${out}`)
}

/** Текст обязан остаться нетронутым. */
function keeps(label, text) {
  const out = redactSecrets(text)
  show(!out.includes('[REDACTED:'), label, `пометки быть не должно, получено: ${out}`)
}

/** Ожидание по болтовне. */
function chit(label, text, expected) {
  const got = isChitchat(text)
  show(got === expected, label, `ожидалось ${expected}, получено ${got}`)
}

/** Ожидание по запрету запоминать. */
function forbid(label, text, expected) {
  const got = forbidsCapture(text)
  show(got === expected, label, `ожидалось ${expected}, получено ${got}`)
}

console.log('язык русский: образцы английского и русского вместе')
setMessageLanguage('ru')
redacts('пароль с двоеточием', 'пароль: hunter2')
redacts('Пароль с равно, в начале строки', 'Пароль = S3cretPass')
redacts('логин', 'логин: admin01')
redacts('имя пользователя', 'имя пользователя: root42')
redacts('английская метка при русском языке', 'password: hunter2')
keeps('фраза о пароле, а не пароль', 'пароль не должен быть простым')
keeps('русское значение — строгий вариант', 'пароль: неверный')
keeps('кириллический секрет не вычищается (осознанно)', 'пароль: моякошка')
keeps('слово с меткой внутри не ловится', 'суперпароль: abc12345')
redacts('универсальное: sk-', 'sk-abcdefghijklmnopqrstuvwxyz012345')
redacts('универсальное: Bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz')
redacts('универсальное: github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789')
redacts('универсальное: AWS', 'AKIAIOSFODNN7EXAMPLE')
redacts('универсальное: PEM', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')
redacts('универсальное: телефон материкового Китая', 'звони 13800138000 сегодня')
keeps('китайская метка при русском языке (правило: английский ∪ действующий)', '密码：abc12345')

console.log('\nязык английский: только образцы английского')
setMessageLanguage('en')
redacts('английская метка', 'password: hunter2')
keeps('русская метка не действует', 'пароль: hunter2')
keeps('китайская метка не действует', '密码：abc12345')

console.log('\nязык китайский: образцы английского и китайского')
setMessageLanguage('zh')
redacts('китайская метка', '密码：abc12345')
redacts('китайская метка со словом 为', '密码为abc12345')
redacts('английская метка при китайском языке', 'password: hunter2')

console.log('\nболтовня: сообщение целиком')
setMessageLanguage('ru')
chit('привет', 'привет', true)
chit('Спасибо!', 'Спасибо!', true)
chit('ок', 'ок', true)
chit('Понял.', 'Понял.', true)
chit('здравствуйте…', 'здравствуйте…', true)
chit('английское hello при русском языке', 'hello', true)
chit('сообщение с содержимым не болтовня', 'привет, давай займёмся делом', false)
chit('болтовня плюс указание не болтовня', 'ок, запомни это', false)

console.log('\nзапрет запоминать: ищется в любом месте')
forbid('не запоминай это', 'не запоминай это', true)
forbid('в середине фразы', 'кстати, не запоминай это пожалуйста', true)
forbid('не надо запоминать', 'не надо запоминать', true)
forbid('английское', "don't remember this", true)
forbid('просьба запомнить не путается с запретом', 'запомни это', false)
forbid('обычная фраза', 'давай продолжим работу', false)

console.log('\nслова пользователя: действуют всегда, независимо от языка')
setMessageLanguage('en')
setExtraRedactWords(['мойсекрет', 'тайнокод'])
redacts('слово пользователя при английском языке', 'мойсекрет: abc12345')
redacts('второе слово пользователя', 'тайнокод = zzz99999')
show(extraRedactWords().length === 2, 'список слов пользователя сохранён', `получено: ${extraRedactWords().length}`)
setExtraRedactWords([])
keeps('после очистки списка слово не действует', 'мойсекрет: abc12345')

console.log('\nсвязывание hook.ts с языковым пакетом')
const hookSource = readFileSync(resolve(SRC, 'ingest/hook.ts'), 'utf8')
show(!/const CHITCHAT_RE|const NO_CAPTURE_RE/.test(hookSource), 'локальных образцов в hook.ts больше нет')
show(/chitchatPatterns\(\)\.some/.test(hookSource), 'isChitchat берёт образцы из пакета')
show(/noCapturePatterns\(\)\.some/.test(hookSource), 'forbidsCapture берёт образцы из пакета')

console.log(`\nпроверок: ${total}, провалов: ${failures}`)
if (failures > 0) process.exitCode = 1
