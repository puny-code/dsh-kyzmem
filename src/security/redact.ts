/**
 * 摄取脱敏：记忆入库前用正则清洗常见密钥凭据（API key、Bearer、AWS、GitHub
 * token、PEM 私钥、password/token 赋值），命中片段替换为 [REDACTED:<kind>]，
 * 保留类型便于事后审计。只处理入库内容与辅助调用输入，不触碰对话原文。
 *
 * Русская доработка (F-10). Правила здесь делятся на два вида:
 * - **универсальные** — форматы, не зависящие от языка интерфейса: PEM, `Bearer`,
 *   `sk-…`, `ghp_…`, `AKIA…`, телефоны и документы. Включены всегда: номер телефона
 *   не перестаёт быть номером оттого, что интерфейс переключили на другой язык;
 * - **языковые** — слова-метки перед значением (`password=`, `密码`, `пароль`).
 *   Они живут в языковом пакете (`i18n/patterns.ts`) и берутся оттуда вместе
 *   со словами, добавленными пользователем в настройках.
 *
 * Пометка `[REDACTED:<kind>]` остаётся английской намеренно: это служебный маркер,
 * а не текст для человека, и переводить его нельзя — см. §4 «ПРАВИЛА РАБОТЫ.md».
 *
 * @module dsh-kyzmem/security/redact
 */

import { redactLabelPatterns } from '../i18n/patterns.ts'

/** 替换标记：类型后缀帮助审计时区分泄漏类别。 */
function redacted(kind: string): string {
  return `[REDACTED:${kind}]`
}

/**
 * 清洗文本中的密钥凭据。
 * @param text - 待清洗原文（会话文本、模型输出候选、工具保存正文）。
 * @returns 脱敏后的文本；无命中时原样返回。
 */
export function redactSecrets(text: string): string {
  // Универсальные образцы. Порядок авторский и менять его нельзя: правило PEM-ключа
  // обязано идти первым, иначе присваивание обрежет ключ на середине.
  let cleaned = text
    // PEM 私钥整段（含换行），最先处理避免被赋值规则截断。
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, redacted('private-key'))
    // Authorization: Bearer 头；保留 "Bearer" 词让上下文可读。
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${redacted('bearer-token')}`)
    // sk- 系密钥（OpenAI/DeepSeek/MiniMax token plan 等，允许 sk-proj-/sk-cp- 派生前缀）。
    .replace(/\bsk-(?:proj-|cp-|ant-|svcacct-)?[A-Za-z0-9_-]{16,}/g, redacted('api-key'))
    // GitHub 细粒度与经典 token（ghp_/gho_/ghu_/ghs_/ghr_）。
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, redacted('github-token'))
    // AWS 访问密钥 id（AKIA + 16 位大写数字）。
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, redacted('aws-access-key'))

  // Языковые метки: английский набор плюс набор действующего языка, плюс слова
  // пользователя. Метка сохраняется в тексте — при разборе видно, что именно нашли.
  for (const { pattern, kind } of redactLabelPatterns()) {
    cleaned = cleaned.replace(pattern, (_match, key: string) => `${key}=${redacted(kind)}`)
  }

  // 中国大陆手机号：1[3-9] 开头 11 位；前后紧邻数字（更长数字串的片段）不命中。
  // 中国大陆居民身份证 18 位：区划 + 出生日期 + 顺序码 + 校验位；结构不符（如 13 月）不命中。
  return cleaned
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, redacted('phone'))
    .replace(/\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, redacted('id-number'))
}
