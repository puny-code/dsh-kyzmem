/**
 * Словарь: ядро плагина — профиль сессии, бюджет токенов, предложение экскурсии,
 * обоснование отбора, образцы памяти.
 *
 * Ключи этой области начинаются с `core.`. Оригинальный китайский текст автора
 * сохранён в `zh`; английский набор — образец полноты, русский может быть неполным
 * (недостающее берётся из английского).
 *
 * @module dsh-kyzmem/i18n/catalog/core
 */

/** Оригинальные формулировки автора. */
export const zh = {
  // ---- Профиль сессии (renderProfileDetailed / renderProfileWithCurated) ----
  'core.profileHeader': 'User memory profile (dsh-kyzmem, cross-session) — Grand Hall (always present):',
  'core.profileFooter': 'Use kyzmem_search to recall details (pass room to search inside one room); use kyzmem_save to persist new facts.',
  'core.curatedHeader': 'Curated profile (user-maintained via kyzmem_profile_edit; authoritative over derived facts):',
  'core.observationsHeader': 'Consolidated beliefs (distilled from multiple stored memories; verify against sources before high-stakes use):',
  'core.observationItem': '- {belief} ({count} sources)',
  'core.reviewDue': '\nPalace review due today: {count}{plus} memories. Use kyzmem_review_queue for active recall (recall beats re-reading).',
  // ---- 首问 keyed 召回（retrieve/query-recall：用首问原文检索一次，结果并入 memory_context）----
  'core.recallHeader': '与本轮提问相关的既有记忆（首问召回，不是常驻画像）：',
  'core.recallItem': '- [{kind}] {content}（{ref}）',
  'core.recallExamineHint': '需要原文用 kyzmem_examine ids=[{ids}]',
  'core.recallBatchNote': 'batch {batchId}：evidenceRefs 用行内括号里的 ref',
  // ---- [RESUME] 恢复简报（resume-briefing：上一条会话摘要 + 今日待回忆 + 未完成摄取）----
  'core.resumeHeader': '[RESUME] 上次会话（{date}）：{summary}',
  'core.resumeDue': '今日待回忆 {count} 条',
  'core.resumePendingIngest': '上次未完成摄取 {count} 条',
  'core.compressSystem': '把记忆条目压缩为更短的一句话表述（每条不超过 40 个字符），保留可跨会话复用的关键信息（事实、偏好、决策、方法）。\n只输出一个 JSON 数组，每项形如 {"id": "原样返回的id", "content": "压缩后表述"}，条目数量与 id 必须与输入一一对应。\n不要输出 JSON 以外的任何内容。',

  // ---- Обоснование отбора (selection-rationale) ----
  'core.rationaleHeader': '本轮画像共 {count} 条记忆，挑选理由如下：',
  'core.rationaleFooter': '如果某条理由错误，请通过 kyzmem_report 反馈，越准的画像越能帮你。',
  'core.reasonBase': '基础入选',
  'core.reasonRecent': '近期被参观',
  'core.reasonBright': '地标明亮',
  'core.reasonCorridorHit': '走廊常客',
  'core.reasonStrongEvidence': '管家验证有效',

  // ---- Предложение экскурсии (tour-proposal) ----
  'core.tourEmpty': '[{scope}] 宫殿尚空。建议：先放第一段记忆（例如一条 fact 或 preference），让后续会话有锚点可循。',
  'core.tourGreeting': '[{scope}] 宫殿现存 {count} 条 active 记忆。建议开场巡游：{stops}。',
  'core.tourStop': '第 {index} 站「{preview}」',

  // ---- Образцы памяти (palace-sample) ----
  'core.samplePreference': '我喜欢简洁的命令行界面与键盘流胜过鼠标点击。',
  'core.samplePreferenceCaption': '竹简翻页',
  'core.samplePreferenceTag0': '纸香',
  'core.samplePreferenceTag1': '木桌',
  'core.sampleFact': '默认使用 macOS，shell 是 zsh + oh-my-zsh，编辑用 Neovim。',
  'core.sampleFactCaption': '磨砂铝机',
  'core.sampleFactTag0': '金属凉',
  'core.sampleFactTag1': '键声脆',
  'core.sampleDecision': '2024 年起所有个人项目都用 TypeScript + pnpm 工作区，理由：单仓库多包协作最稳。',
  'core.sampleDecisionCaption': '白漆棋盘',
  'core.sampleDecisionTag0': '釉面凉',
  'core.sampleEpisode': '第一次完整读《沉思录》那本书——上中学时在图书馆角落读完，窗外是雨。',
  'core.sampleEpisodeCaption': '雨窗铜铃',
  'core.sampleEpisodeTag0': '钟声',
  'core.sampleEpisodeTag1': '潮气',

  // ---- Диагностика (console) ----
  'core.warnReplayPendingFailed': '[dsh-kyzmem] 待补做摄取重放失败（保留 pending，不影响对话）：',
  'core.warnSettingsOverlayFailed': '[dsh-kyzmem] 设置覆盖层 settings.json 无法读取，已忽略并沿用宿主配置：',
  'ingest.replayKeyFailed': '[dsh-kyzmem] 重放单条 pending 失败（保留，下个会话重试）：',
  'ingest.replayAbandoned': '[dsh-kyzmem] 陈旧 pending 放弃重放（会话超 180 天仍失败，出队）：',
  'ingest.deadLetter': '[dsh-kyzmem] pending 转死信出队（尝试次数达上限或值不可解析，已记 ingest-dead-letter）：',
  'core.warnIngestPreviousFailed': '[dsh-kyzmem] 本轮自动摄取失败（已跳过，不影响对话）：',
  'core.warnHistoryBackfillFailed': '[dsh-kyzmem] 历史回填失败：',
  'core.warnDisposeFinalFailed': '[dsh-kyzmem] 会话结束的收尾处理异常（不影响对话）：',
  'core.warnReflectFailed': '[dsh-kyzmem] 会话结束的信念巩固异常（{scope}，不影响对话）：',
  'core.warnConsolidationFailed': '[dsh-kyzmem] 闭馆整理失败（不影响对话）：',
  'core.warnMaintenanceFailed': '[dsh-kyzmem] 后台整理失败（不影响对话）：',
  'core.warnMaintenanceAuditFailed': '[dsh-kyzmem] 后台整理审计写入失败（整理结果已生效）：',
  'core.warnAutoResolveFailed': '[dsh-kyzmem] 自动裁决失败（已跳过，不影响整理任务）：',
  'core.warnLiveConfigFallback': '[dsh-kyzmem] 热配置重读失败（已回退上一次快照）：',
  'core.warnRecallAuditFailed': '[dsh-kyzmem] 召回采用率统计失败（不影响对话）：',
  'core.warnQueryRecallFailed': '[dsh-kyzmem] 首问召回失败（已跳过，不影响对话）：',
  'core.warnObservationBudget': '[dsh-kyzmem] 信念区块超出硬上限（{actual} > {limit}），已截断注入：',
  'core.logMaintenanceDone': '[dsh-kyzmem] 后台整理完成：{job} 处理 {items} 条（{ms} ms）',
  'core.warnEmbedderUnavailable': '[dsh-kyzmem] 嵌入器不可用，检索降级为纯关键词模式：',
  'core.warnRoomFull': '[dsh-kyzmem] 房间已满，自动开新房「{room}」（可在管理面板翻新清单中人工拆分/命名）',
  'core.warnSlotsBackfilled': '[dsh-kyzmem] 存量记忆排桩完成：{count} 条已钉入宫殿（{path}）',
  'core.logReflectDone': '[dsh-kyzmem] 信念巩固完成（{scope}）：新建 {formed}，细化 {refined}，维持 {confirmed}，否定 {refuted}',
  'core.logConsolidationDone': '[dsh-kyzmem] 闭馆整理完成：归档 {archived}，合并 {merged}，跳过 {skipped}（{ms} ms）',
  'core.backfillBusy': '已有回填任务正在运行，请先暂停或等待完成',
} as const

/** Английский набор — образец полноты. */
export const en = {
  // ---- Session profile (renderProfileDetailed / renderProfileWithCurated) ----
  'core.profileHeader': 'User memory profile (dsh-kyzmem, cross-session) — Grand Hall (always present):',
  'core.profileFooter': 'Use kyzmem_search to recall details (pass room to search inside one room); use kyzmem_save to persist new facts.',
  'core.curatedHeader': 'Curated profile (user-maintained via kyzmem_profile_edit; authoritative over derived facts):',
  'core.observationsHeader': 'Consolidated beliefs (distilled from multiple stored memories; verify against sources before high-stakes use):',
  'core.observationItem': '- {belief} ({count} sources)',
  'core.reviewDue': '\nPalace review due today: {count}{plus} memories. Use kyzmem_review_queue for active recall (recall beats re-reading).',
  // ---- First-question keyed recall (retrieve/query-recall) ----
  'core.recallHeader': 'Memories relevant to this opening question (first-question recall, not the standing profile):',
  'core.recallItem': '- [{kind}] {content} ({ref})',
  'core.recallExamineHint': 'For the original text use kyzmem_examine ids=[{ids}]',
  'core.recallBatchNote': 'batch {batchId}: use the ref in parentheses as evidenceRefs',
  // ---- [RESUME] briefing (resume-briefing: previous session summary + due reviews + pending ingests) ----
  'core.resumeHeader': '[RESUME] Last session ({date}): {summary}',
  'core.resumeDue': 'Review due today: {count}',
  'core.resumePendingIngest': 'Unfinished ingests: {count}',
  'core.compressSystem': 'Compress each memory entry into a shorter single-sentence wording (at most 40 characters per entry), keeping the key information that can be reused across sessions (facts, preferences, decisions, methods).\nOutput only one JSON array, each item shaped like {"id": "the id returned verbatim", "content": "the compressed wording"}; the number of items and the ids must correspond one-to-one with the input.\nDo not output anything other than JSON.',

  // ---- Selection rationale (selection-rationale) ----
  'core.rationaleHeader': 'This profile holds {count} memories in total; they were picked for the following reasons:',
  'core.rationaleFooter': 'If any reason is wrong, report it via kyzmem_report — the more accurate the profile, the better it helps you.',
  'core.reasonBase': 'base inclusion',
  'core.reasonRecent': 'visited recently',
  'core.reasonBright': 'bright landmark',
  'core.reasonCorridorHit': 'corridor regular',
  'core.reasonStrongEvidence': 'verified effective by the curator',

  // ---- Tour proposal (tour-proposal) ----
  'core.tourEmpty': '[{scope}] The palace is still empty. Suggestion: store your first memory (a fact or a preference, for instance) so later sessions have an anchor to follow.',
  'core.tourGreeting': '[{scope}] The palace currently holds {count} active memories. Suggested opening tour: {stops}.',
  'core.tourStop': 'stop {index} “{preview}”',

  // ---- Sample memories (palace-sample) ----
  'core.samplePreference': 'I prefer a lean command-line interface and keyboard-driven flow over mouse clicks.',
  'core.samplePreferenceCaption': 'bamboo slips turning',
  'core.samplePreferenceTag0': 'scent of paper',
  'core.samplePreferenceTag1': 'wooden desk',
  'core.sampleFact': 'Uses macOS by default; the shell is zsh + oh-my-zsh and the editor is Neovim.',
  'core.sampleFactCaption': 'brushed aluminium machine',
  'core.sampleFactTag0': 'cold metal',
  'core.sampleFactTag1': 'crisp key clicks',
  'core.sampleDecision': 'Since 2024 every personal project uses TypeScript + pnpm workspaces — a single repository with many packages is the steadiest way to collaborate.',
  'core.sampleDecisionCaption': 'white-lacquered chessboard',
  'core.sampleDecisionTag0': 'cool glaze',
  'core.sampleEpisode': 'Reading “Meditations” all the way through for the first time — finished it in a library corner in secondary school, rain outside the window.',
  'core.sampleEpisodeCaption': 'bronze bell by the rain-streaked window',
  'core.sampleEpisodeTag0': 'bell tone',
  'core.sampleEpisodeTag1': 'damp air',

  // ---- Diagnostics (console) ----
  'core.warnReplayPendingFailed': '[dsh-kyzmem] Replaying a pending ingest failed (pending kept, conversation unaffected):',
  'core.warnSettingsOverlayFailed': '[dsh-kyzmem] Settings overlay settings.json could not be read; ignored, using host config:',
  'ingest.replayKeyFailed': '[dsh-kyzmem] Replaying one pending key failed (kept for next session):',
  'ingest.replayAbandoned': '[dsh-kyzmem] Stale pending abandoned (session older than 180 days, still failing — dequeued):',
  'ingest.deadLetter': '[dsh-kyzmem] Pending moved to dead letter (retry limit reached or value unparseable; logged as ingest-dead-letter):',
  'core.warnIngestPreviousFailed': '[dsh-kyzmem] Automatic ingest of this turn failed (skipped, conversation unaffected):',
  'core.warnHistoryBackfillFailed': '[dsh-kyzmem] History backfill failed:',
  'core.warnDisposeFinalFailed': '[dsh-kyzmem] Session-end finalisation threw (conversation unaffected):',
  'core.warnReflectFailed': '[dsh-kyzmem] Belief consolidation at session end threw ({scope}, conversation unaffected):',
  'core.warnConsolidationFailed': '[dsh-kyzmem] Closing-time consolidation failed (conversation unaffected):',
  'core.warnMaintenanceFailed': '[dsh-kyzmem] Background maintenance failed (conversation unaffected):',
  'core.warnMaintenanceAuditFailed': '[dsh-kyzmem] Background maintenance audit write failed (changes already applied):',
  'core.warnAutoResolveFailed': '[dsh-kyzmem] Auto resolution failed (skipped, maintenance job unaffected):',
  'core.warnLiveConfigFallback': '[dsh-kyzmem] Hot config re-read failed (fell back to last snapshot):',
  'core.warnRecallAuditFailed': '[dsh-kyzmem] Recall adoption accounting failed (conversation unaffected):',
  'core.warnQueryRecallFailed': '[dsh-kyzmem] First-question recall failed (skipped, conversation unaffected):',
  'core.warnObservationBudget': '[dsh-kyzmem] Belief block exceeded its hard cap ({actual} > {limit}); truncated for injection:',
  'core.logMaintenanceDone': '[dsh-kyzmem] Background maintenance done: {job} processed {items} item(s) ({ms} ms)',
  'core.warnEmbedderUnavailable': '[dsh-kyzmem] Embedder unavailable; retrieval degrades to keyword-only mode:',
  'core.warnRoomFull': '[dsh-kyzmem] Room full; opening a new room “{room}” automatically (split or rename it by hand in the panel’s slot-list view)',
  'core.warnSlotsBackfilled': '[dsh-kyzmem] Existing memories slotted: {count} pinned into the palace ({path})',
  'core.logReflectDone': '[dsh-kyzmem] Belief consolidation done ({scope}): {formed} formed, {refined} refined, {confirmed} confirmed, {refuted} refuted',
  'core.logConsolidationDone': '[dsh-kyzmem] Closing-time consolidation done: {archived} archived, {merged} merged, {skipped} skipped ({ms} ms)',
  'core.backfillBusy': 'A backfill job is already running; pause it or wait for it to finish first',
} as const

/** Русский набор. */
export const ru = {
  // ---- Профиль сессии (renderProfileDetailed / renderProfileWithCurated) ----
  'core.profileHeader': 'Профиль памяти пользователя (dsh-kyzmem, межсессионный) — Большой зал (присутствует всегда):',
  'core.profileFooter': 'Для подробностей используйте kyzmem_search (room ищет внутри одной комнаты); для сохранения новых фактов — kyzmem_save.',
  'core.curatedHeader': 'Курируемый профиль (ведётся пользователем через kyzmem_profile_edit; главнее выведенных фактов):',
  'core.observationsHeader': 'Устоявшиеся убеждения (выведены из множества сохранённых воспоминаний; перед важными решениями сверяйтесь с источниками):',
  'core.observationItem': '- {belief} (источников: {count})',
  'core.reviewDue': '\nСегодня пора вспомнить: {count}{plus} воспоминаний во дворце. Используйте kyzmem_review_queue для активного припоминания (припоминание сильнее перечитывания).',
  // ---- Поиск по первому запросу сессии (retrieve/query-recall) ----
  'core.recallHeader': 'Воспоминания, связанные с первым вопросом этой сессии (поиск по первому запросу, а не постоянный профиль):',
  'core.recallItem': '- [{kind}] {content} ({ref})',
  'core.recallExamineHint': 'Чтобы получить исходный текст, используйте kyzmem_examine ids=[{ids}]',
  'core.recallBatchNote': 'batch {batchId}: evidenceRefs — это ref в скобках',
  // ---- Сводка [RESUME] (resume-briefing: сводка прошлой сессии + что пора вспомнить + незавершённые извлечения) ----
  'core.resumeHeader': '[RESUME] Прошлая сессия ({date}): {summary}',
  'core.resumeDue': 'Сегодня пора вспомнить: {count}',
  'core.resumePendingIngest': 'Незавершённых извлечений: {count}',
  'core.compressSystem': 'Сожми каждую запись памяти в более короткую однострочную формулировку (не более 40 символов на запись), сохранив ключевую информацию, пригодную для повторного использования между сессиями (факты, предпочтения, решения, методы).\nВыведи только один JSON-массив, каждый элемент вида {"id": "id, возвращённый как есть", "content": "сжатая формулировка"}; число элементов и id должны взаимно однозначно соответствовать входу.\nНе выводи ничего, кроме JSON.',

  // ---- Обоснование отбора (selection-rationale) ----
  'core.rationaleHeader': 'В этом профиле всего {count} воспоминаний; причины отбора:',
  'core.rationaleFooter': 'Если какая-то причина неверна, сообщите через kyzmem_report — чем точнее профиль, тем лучше он вам помогает.',
  'core.reasonBase': 'базовый отбор',
  'core.reasonRecent': 'недавно посещалось',
  'core.reasonBright': 'яркий ориентир',
  'core.reasonCorridorHit': 'завсегдатай коридора',
  'core.reasonStrongEvidence': 'подтверждено куратором',

  // ---- Предложение экскурсии (tour-proposal) ----
  'core.tourEmpty': '[{scope}] Дворец пока пуст. Совет: положите первое воспоминание (например, факт или предпочтение), чтобы следующим сессиям было за что зацепиться.',
  'core.tourGreeting': '[{scope}] Во дворце сейчас {count} активных воспоминаний. Предлагаемый маршрут на открытие: {stops}.',
  'core.tourStop': 'остановка {index} «{preview}»',

  // ---- Образцы памяти (palace-sample) ----
  'core.samplePreference': 'Предпочитаю лаконичный интерфейс командной строки и работу с клавиатуры, а не клики мышью.',
  'core.samplePreferenceCaption': 'бамбуковые дощечки перелистываются',
  'core.samplePreferenceTag0': 'запах бумаги',
  'core.samplePreferenceTag1': 'деревянный стол',
  'core.sampleFact': 'По умолчанию macOS, оболочка zsh + oh-my-zsh, редактор Neovim.',
  'core.sampleFactCaption': 'матовый алюминиевый корпус',
  'core.sampleFactTag0': 'холод металла',
  'core.sampleFactTag1': 'щёлканье клавиш',
  'core.sampleDecision': 'С 2024 года все личные проекты — на TypeScript + рабочих пространствах pnpm: один репозиторий с множеством пакетов — самый надёжный вариант.',
  'core.sampleDecisionCaption': 'доска под белым лаком',
  'core.sampleDecisionTag0': 'прохлада глазури',
  'core.sampleEpisode': 'Первый раз прочитал книгу «Размышления» целиком — дочитал в углу библиотеки ещё в школе, за окном шёл дождь.',
  'core.sampleEpisodeCaption': 'бронзовый колокольчик у дождливого окна',
  'core.sampleEpisodeTag0': 'звон колокола',
  'core.sampleEpisodeTag1': 'сырость',

  // ---- Диагностика (console) ----
  'core.warnReplayPendingFailed': '[dsh-kyzmem] Не удалось повторить отложенное извлечение (pending сохранён, диалог не затронут):',
  'core.warnSettingsOverlayFailed': '[dsh-kyzmem] Файл настроек settings.json не читается; он проигнорирован, используется конфиг хоста:',
  'ingest.replayKeyFailed': '[dsh-kyzmem] Не удалось повторить один pending (сохранён, повтор в следующей сессии):',
  'ingest.replayAbandoned': '[dsh-kyzmem] Устаревший pending снят с очереди (сессия старше 180 дней, всё ещё падает):',
  'ingest.deadLetter': '[dsh-kyzmem] Pending переведён в dead letter (исчерпан лимит попыток или значение не разбирается; записано ingest-dead-letter):',
  'core.warnIngestPreviousFailed': '[dsh-kyzmem] Автоматическое извлечение этого хода не удалось (пропущено, диалог не затронут):',
  'core.warnHistoryBackfillFailed': '[dsh-kyzmem] Заполнение истории не удалось:',
  'core.warnDisposeFinalFailed': '[dsh-kyzmem] Ошибка завершающей обработки при закрытии сессии (диалог не затронут):',
  'core.warnReflectFailed': '[dsh-kyzmem] Ошибка закрепления убеждений при закрытии сессии ({scope}, диалог не затронут):',
  'core.warnConsolidationFailed': '[dsh-kyzmem] Закрытие зала не удалось (диалог не затронут):',
  'core.warnMaintenanceFailed': '[dsh-kyzmem] Фоновое обслуживание не удалось (диалог не затронут):',
  'core.warnMaintenanceAuditFailed': '[dsh-kyzmem] Не удалось записать аудит обслуживания (изменения применены):',
  'core.warnAutoResolveFailed': '[dsh-kyzmem] Авторазрешение не удалось (пропущено, задача обслуживания не затронута):',
  'core.warnLiveConfigFallback': '[dsh-kyzmem] Не удалось перечитать горячую конфигурацию (откат к последнему снимку):',
  'core.warnRecallAuditFailed': '[dsh-kyzmem] Не удалось учесть использование результатов поиска (диалог не затронут):',
  'core.warnQueryRecallFailed': '[dsh-kyzmem] Поиск по первому запросу не удался (пропущен, диалог не затронут):',
  'core.warnObservationBudget': '[dsh-kyzmem] Блок убеждений превысил жёсткий лимит ({actual} > {limit}), при инъекции обрезан:',
  'core.logMaintenanceDone': '[dsh-kyzmem] Фоновое обслуживание завершено: {job}, обработано {items} ({ms} мс)',
  'core.warnEmbedderUnavailable': '[dsh-kyzmem] Встраиватель недоступен, поиск деградирует до режима «только ключевые слова»:',
  'core.warnRoomFull': '[dsh-kyzmem] Комната заполнена, автоматически открывается новая «{room}» (её можно вручную разделить или переименовать в списке обновления панели)',
  'core.warnSlotsBackfilled': '[dsh-kyzmem] Разметка существующих воспоминаний завершена: {count} закреплено во дворце ({path})',
  'core.logReflectDone': '[dsh-kyzmem] Закрепление убеждений завершено ({scope}): создано {formed}, уточнено {refined}, подтверждено {confirmed}, опровергнуто {refuted}',
  'core.logConsolidationDone': '[dsh-kyzmem] Закрытие зала завершено: архивировано {archived}, объединено {merged}, пропущено {skipped} ({ms} ms)',
  'core.backfillBusy': 'Задача заполнения уже выполняется; сначала приостановите её или дождитесь завершения',
} as const
