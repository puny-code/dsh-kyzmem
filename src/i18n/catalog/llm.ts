/**
 * Словарь: обращения к вспомогательной модели — извлечение, дистилляция,
 * консолидация убеждений, переписывание запроса.
 *
 * Ключи этой области начинаются с `llm.`. Оригинальный китайский текст автора
 * сохранён в `zh`; английский набор — образец полноты, русский может быть неполным
 * (недостающее берётся из английского).
 *
 * @module dsh-kyzmem/i18n/catalog/llm
 */

/** Оригинальные формулировки автора. */
export const zh = {
  // ---- Извлечение из диалога (ingest/hook) ----
  'llm.ingestSystem': '从对话记录中提取值得跨会话长期记住的用户信息（事实/偏好/决策/经历/做事方法）。\n只输出一个 JSON 数组，每项形如 {"content": "一句话完整表述", "kind": "fact|preference|decision|episode|skill", "scope": "project|user", "importance": 0到1的小数, "entities": [{"name": "实体名", "kind": "person|project|tool|concept|other", "aliases": ["别名"]}], "facts": [{"entity": "实体名", "content": "关于该实体的一句话事实"}]}。\nentities 是这条记忆里提到的具体对象（人名/项目名/工具名/概念名），没有就省略该字段；实体名要短（专名本身，不超过 20 字），aliases 列出该实体的其他叫法，没有就省略。\nfacts 列出这条记忆中关于具体实体的客观事实（状态/归属/关系/数据），entity 必须取该条 entities 里出现过的实体名，一条一个知识点，没有就省略该字段。\nscope 决定这条记忆进哪座宫殿：只跟当前项目/仓库有关的（技术选型、项目约定、架构决策、该项目自身的事实）用 project；与具体项目无关、跨项目通用的（个人偏好、习惯、用户本人的经历、通用事实）用 user。拿不准用 project。\n忠实转述：原文中被否定、拒绝或纠正的内容，记录时必须保持其被否定的语义，不得写成正面断言；不要添加原文没有的关联、判断或结论。\n只提取明确、可复用的信息；寒暄、临时上下文、你自己的回答不要提取。没有值得记的就输出 []。\n不要输出 JSON 以外的任何内容。',
  'llm.ingestUserPrompt': '从下面这轮对话（JSON 数组）提取值得长期记住的信息：',
  'llm.ingestRecallNote': '（注意：上一轮调用过记忆召回工具（kyzmem_search 等），其返回已省略；助手回答中复述的既有记忆不是新信息，不要提取。）',
  'llm.sessionSummarySystem': '概括下面这段会话：用一句话（不超过 60 字）说明这场会话主要做了什么、达成了什么结果。\n直接输出摘要本身，不要前缀、引号或任何解释。',
  'llm.sessionSummaryUserPrompt': '概括下面这段会话：',
  'llm.warnFinalIngestFailed': '[dsh-kyzmem] 会话结束的末轮摄取失败（已记入待补做队列，不影响对话）：',

  // ---- Правила заполнения истории (ingest/history) ----
  'llm.backfillDaysRange': 'historyBackfill: days 必须是 [0, 3650] 的整数（0 = 不限）',
  'llm.backfillMaxTurnsRange': 'historyBackfill: maxTurnsPerSession 必须是 [1, 500] 的整数',
  'llm.backfillMaxTotalTurnsRange': 'historyBackfill: maxTotalTurns 必须是 [1, 5000] 的整数',
  'llm.backfillProviderModelPair': 'historyBackfill: provider 与 model 必须成对提供',
  'llm.backfillUnavailable': '当前环境未挂载会话持久化服务（会话日志不可读，例如 headless 组合），无法回填历史会话',

  // ---- Дистилляция (flywheel/distill) ----
  'llm.distillSystem': '下面是一组用户的长期记忆条目。把表达同一主题或可归纳为一条规律的若干条，合并提炼为更高层的一条。\n只输出一个 JSON 数组，每项形如 {"content": "提炼后的一句话规律", "kind": "skill或fact", "importance": 0到1, "supersedes": ["被合并条目的id", ...]}。\nsupersedes 必须从输入给出的 id 中选取且每组至少 1 个；无法归并的条目不要输出。没有可归并的就输出 []。\n不要输出 JSON 以外的任何内容。',
  'llm.distillUserPrompt': '记忆条目：',

  // ---- Консолидация убеждений (consolidation/reflect) ----
  'llm.reflectMarkerNewMemories': '【待巩固记忆】',
  'llm.reflectMarkerBeliefs': '【待复核信念】',
  'llm.reflectSystem': '下面给出两部分材料：{newMark}是新近写入的原始记忆；{reviewMark}是此前巩固出、但可能受新证据影响的信念（附原始证据）。\n请对材料做巩固与复核，只输出一个 JSON 数组，每项为以下四种动作之一：\n1. {"action":"form","belief":"巩固出的一句话信念（结论/规律/稳定偏好）","sourceIds":["证据记忆id"]} —— sourceIds 至少 1 个且必须全部来自{newMark}的 id；多条记忆支撑同一信念时合并成一条，不要为单条琐碎记忆立信念。\n2. {"action":"refine","observationId":"待复核信念id","belief":"结合新证据后的新表述","sourceIds":["新增证据记忆id"]} —— 新证据补充或限定了该信念时使用；sourceIds 必须来自{newMark}，可为空数组（仅表述更准确）。\n3. {"action":"still","observationId":"待复核信念id"} —— 新证据不影响该信念，原表述仍成立。\n4. {"action":"refute","observationId":"待复核信念id","reason":"被否定的原因（引用证据）"} —— 新证据与信念矛盾且原信念不再成立。\nobservationId 必须取自{reviewMark}给出的 id。材料中没有值得巩固或复核的内容时输出 []。不要输出 JSON 以外的任何内容。',
  'llm.reflectStaleLine': '[{id}] 证据 {count} 条：{belief}',
  'llm.reflectFormBeliefMissing': 'form: belief 缺失',
  'llm.reflectFormSourceIdsInvalid': 'form: sourceIds 越界或为空',

  // ---- Переписывание поискового запроса (retrieve/rewrite) ----
  'llm.rewriteSystemIntro': '把用户输入的检索查询改写为最多 {max} 个互补的检索查询（同义词、上下位概念、不同措辞），用于长期记忆库的语义+关键词混合检索。',
  'llm.rewriteSystemJsonOnly': '只输出一个 JSON 字符串数组，不要输出 JSON 以外的任何内容；无法改进时输出只含原查询的数组。',

  // ---- Ошибки вспомогательного вызова (llm/client) ----
  'llm.finishMaxTokens': 'dsh-kyzmem: 辅助调用输出达到 maxTokens 上限',
  'llm.finishUnexpectedToolCalls': 'dsh-kyzmem: 辅助调用意外请求工具',
  'llm.finishUnsupported': 'dsh-kyzmem: 不支持的终止原因 "{kind}"',
  'llm.emptyOutput': '辅助调用返回空输出',
} as const

/** Английский набор — образец полноты. */
export const en = {
  // ---- Conversation ingest (ingest/hook) ----
  'llm.ingestSystem': 'Extract from the conversation record the user information worth remembering across sessions for the long term (facts/preferences/decisions/experiences/methods).\nOutput only one JSON array; each item looks like {"content": "a complete one-sentence statement", "kind": "fact|preference|decision|episode|skill", "scope": "project|user", "importance": a decimal from 0 to 1, "entities": [{"name": "entity name", "kind": "person|project|tool|concept|other", "aliases": ["alias"]}], "facts": [{"entity": "entity name", "content": "a one-sentence fact about that entity"}]}.\nentities are the specific objects mentioned in this memory (person/project/tool/concept names); omit the field when there are none. Entity names must be short (the proper name itself, at most 20 characters); aliases lists the other names of that entity — omit them when there are none.\nfacts lists the objective facts about specific entities in this memory (state/ownership/relations/data); entity must be a name that appeared in this item\'s entities, one knowledge point per entry — omit the field when there are none.\nscope decides which palace the memory enters: things that concern only the current project/repository (technology choices, project conventions, architecture decisions, facts about that project itself) use project; things unrelated to a specific project and common across projects (personal preferences, habits, the user\'s own experiences, general facts) use user. When unsure, use project.\nKeep the meaning exact: content that the text denies, rejects or corrects must stay denied, rejected or corrected in the record — never restated as a positive assertion; do not add connections, judgements or conclusions that were not in the text.\nExtract only explicit, reusable information; do not extract greetings, temporary context, or your own answers. If there is nothing worth remembering, output [].\nDo not output anything other than JSON.',
  'llm.ingestUserPrompt': 'From the following turn (a JSON array), extract the information worth remembering for the long term:',
  'llm.ingestRecallNote': '(Note: the previous turn called the memory-recall tools (kyzmem_search and the like) and their results are omitted; existing memories restated in the assistant reply are not new information — do not extract them.)',
  'llm.sessionSummarySystem': 'Summarise the conversation below: in one sentence (at most 60 characters) state what this conversation mainly did and what it achieved.\nOutput the summary itself directly, with no prefix, quotes or explanation.',
  'llm.sessionSummaryUserPrompt': 'Summarise the conversation below:',
  'llm.warnFinalIngestFailed': '[dsh-kyzmem] Ingest of the final turn at session end failed (queued to be retried, conversation unaffected):',

  // ---- History backfill rules (ingest/history) ----
  'llm.backfillDaysRange': 'historyBackfill: days must be an integer in [0, 3650] (0 = unlimited)',
  'llm.backfillMaxTurnsRange': 'historyBackfill: maxTurnsPerSession must be an integer in [1, 500]',
  'llm.backfillMaxTotalTurnsRange': 'historyBackfill: maxTotalTurns must be an integer in [1, 5000]',
  'llm.backfillProviderModelPair': 'historyBackfill: provider and model must be supplied as a pair',
  'llm.backfillUnavailable': 'Session persistence is not mounted in this environment (session logs are unreadable, e.g. in a headless composition), so history sessions cannot be backfilled',

  // ---- Distillation (flywheel/distill) ----
  'llm.distillSystem': 'Below is a group of the user\'s long-term memory entries. Merge the ones that express the same theme or can be generalised into a single rule into one higher-level entry.\nOutput only one JSON array; each item looks like {"content": "the one-sentence rule after distillation", "kind": "skill or fact", "importance": 0 to 1, "supersedes": ["id of a merged entry", ...]}.\nsupersedes must be chosen from the ids given in the input and each group needs at least 1; do not output entries that cannot be merged. If nothing can be merged, output [].\nDo not output anything other than JSON.',
  'llm.distillUserPrompt': 'Memory entries:',

  // ---- Belief consolidation (consolidation/reflect) ----
  'llm.reflectMarkerNewMemories': '[NEW MEMORIES]',
  'llm.reflectMarkerBeliefs': '[BELIEFS UNDER REVIEW]',
  'llm.reflectSystem': 'Two parts of material are given below: {newMark} are the newly written raw memories; {reviewMark} are beliefs consolidated earlier that may be affected by new evidence (with their original evidence).\nConsolidate and review the material; output only one JSON array, each item being one of the following four actions:\n1. {"action":"form","belief":"a one-sentence belief produced by consolidation (conclusion/rule/stable preference)","sourceIds":["evidence memory id"]} — sourceIds needs at least 1 id and all of them must come from the ids in {newMark}; when several memories support the same belief, merge them into one — do not form a belief out of a single trivial memory.\n2. {"action":"refine","observationId":"id of the belief under review","belief":"the new wording after taking the new evidence into account","sourceIds":["id of the newly added evidence memory"]} — use when the new evidence supplements or narrows that belief; sourceIds must come from {newMark} and may be an empty array (wording made more accurate only).\n3. {"action":"still","observationId":"id of the belief under review"} — the new evidence does not affect the belief; the original wording still holds.\n4. {"action":"refute","observationId":"id of the belief under review","reason":"why it was refuted (citing the evidence)"} — the new evidence contradicts the belief and the original belief no longer holds.\nobservationId must be taken from the ids given in {reviewMark}. If the material contains nothing worth consolidating or reviewing, output []. Do not output anything other than JSON.',
  'llm.reflectStaleLine': '[{id}] {count} evidence items: {belief}',
  'llm.reflectFormBeliefMissing': 'form: belief is missing',
  'llm.reflectFormSourceIdsInvalid': 'form: sourceIds is out of range or empty',

  // ---- Search query rewriting (retrieve/rewrite) ----
  'llm.rewriteSystemIntro': 'Rewrite the retrieval query the user entered into at most {max} complementary retrieval queries (synonyms, broader and narrower concepts, different phrasings) for hybrid semantic + keyword retrieval over the long-term memory store.',
  'llm.rewriteSystemJsonOnly': 'Output only one JSON array of strings and nothing other than JSON; when the query cannot be improved, output an array containing only the original query.',

  // ---- Auxiliary-call errors (llm/client) ----
  'llm.finishMaxTokens': 'dsh-kyzmem: auxiliary call output reached the maxTokens limit',
  'llm.finishUnexpectedToolCalls': 'dsh-kyzmem: auxiliary call unexpectedly requested tools',
  'llm.finishUnsupported': 'dsh-kyzmem: unsupported finish reason "{kind}"',
  'llm.emptyOutput': 'the auxiliary call returned empty output',
} as const

/** Русский набор. */
export const ru = {
  // ---- Извлечение из диалога (ingest/hook) ----
  'llm.ingestSystem': 'Извлеки из записи диалога информацию о пользователе, которую стоит помнить между сессиями долго (факты/предпочтения/решения/опыт/способы работы).\nВыведи только один JSON-массив, каждый элемент вида {"content": "законченное утверждение из одного предложения", "kind": "fact|preference|decision|episode|skill", "scope": "project|user", "importance": десятичная дробь от 0 до 1, "entities": [{"name": "имя сущности", "kind": "person|project|tool|concept|other", "aliases": ["другое название"]}], "facts": [{"entity": "имя сущности", "content": "факт об этой сущности одним предложением"}]}.\nentities — конкретные объекты, упомянутые в этом воспоминании (имена людей/проектов/инструментов/понятий); если их нет, опусти это поле. Имена сущностей должны быть короткими (само имя собственное, не более 20 символов); aliases перечисляет другие названия этой сущности — если их нет, опусти.\nfacts перечисляет объективные факты о конкретных сущностях в этом воспоминании (состояние/принадлежность/отношения/данные); entity должно быть именем, которое встречалось в entities этого элемента, одна запись — один факт; если их нет, опусти это поле.\nscope решает, в какой дворец попадёт воспоминание: то, что касается только текущего проекта/репозитория (выбор технологий, договорённости проекта, архитектурные решения, факты о самом проекте), — project; то, что не связано с конкретным проектом и общее для разных проектов (личные предпочтения, привычки, собственный опыт пользователя, общие факты), — user. Если сомневаешься, используй project.\nСохраняй смысл сказанного точно: то, что в тексте отрицается, отвергается или исправляется, в записи должно остаться отрицанием, отказом или исправлением — не превращай это в положительное утверждение; не достраивай связи, оценки и выводы, которых в тексте не было.\nИзвлекай только явную информацию, пригодную для повторного использования; приветствия, временный контекст и собственные ответы не извлекай. Если запоминать нечего, выведи [].\nНе выводи ничего, кроме JSON.',
  'llm.ingestUserPrompt': 'Из следующего хода (массив JSON) извлеки информацию, которую стоит помнить долго:',
  'llm.ingestRecallNote': '(Внимание: в прошлом ходе вызывались инструменты припоминания (kyzmem_search и подобные), их вывод опущен; уже существующие воспоминания, пересказанные в ответе ассистента, — не новая информация, не извлекай их.)',
  'llm.sessionSummarySystem': 'Суммируй приведённый ниже диалог: одним предложением (не более 60 символов) скажи, чем в основном занимались в этой сессии и к какому результату пришли.\nВыведи сам текст резюме, без префикса, кавычек и каких-либо пояснений.',
  'llm.sessionSummaryUserPrompt': 'Суммируй приведённый ниже диалог:',
  'llm.warnFinalIngestFailed': '[dsh-kyzmem] Извлечение последнего хода при завершении сессии не удалось (поставлено в очередь на повтор, диалог не затронут):',

  // ---- Правила заполнения истории (ingest/history) ----
  'llm.backfillDaysRange': 'historyBackfill: days должно быть целым числом в диапазоне [0, 3650] (0 = без ограничения)',
  'llm.backfillMaxTurnsRange': 'historyBackfill: maxTurnsPerSession должно быть целым числом в диапазоне [1, 500]',
  'llm.backfillMaxTotalTurnsRange': 'historyBackfill: maxTotalTurns должно быть целым числом в диапазоне [1, 5000]',
  'llm.backfillProviderModelPair': 'historyBackfill: provider и model должны передаваться вместе',
  'llm.backfillUnavailable': 'В этом окружении не подключена служба сохранения сессий (журналы сессий недоступны для чтения, например в headless-сборке), поэтому заполнить историю сессий нельзя',

  // ---- Дистилляция (flywheel/distill) ----
  'llm.distillSystem': 'Ниже — набор долговременных воспоминаний пользователя. Объедини те из них, что выражают одну тему или сводятся к одной закономерности, в одну запись более высокого уровня.\nВыведи только один JSON-массив, каждый элемент вида {"content": "закономерность одним предложением после обобщения", "kind": "skill или fact", "importance": от 0 до 1, "supersedes": ["id объединённой записи", ...]}.\nsupersedes должен выбираться из id, приведённых во входе, и в каждой группе должен быть хотя бы 1; записи, которые нельзя объединить, не выводи. Если объединять нечего, выведи [].\nНе выводи ничего, кроме JSON.',
  'llm.distillUserPrompt': 'Записи памяти:',

  // ---- Закрепление убеждений (consolidation/reflect) ----
  'llm.reflectMarkerNewMemories': '[НОВЫЕ ВОСПОМИНАНИЯ]',
  'llm.reflectMarkerBeliefs': '[УБЕЖДЕНИЯ НА ПЕРЕПРОВЕРКУ]',
  'llm.reflectSystem': 'Ниже даны две части материала: {newMark} — недавно записанные исходные воспоминания; {reviewMark} — ранее выведенные убеждения, на которые могли повлиять новые доказательства (с исходными доказательствами).\nЗакрепи и перепроверь материал; выведи только один JSON-массив, каждый элемент — одно из четырёх действий:\n1. {"action":"form","belief":"убеждение одним предложением, выведенное при закреплении (вывод/закономерность/устойчивое предпочтение)","sourceIds":["id воспоминания-доказательства"]} — в sourceIds нужен хотя бы 1 id, и все они должны быть из id в {newMark}; если одно убеждение подтверждают несколько воспоминаний, объедини их в одно — не создавай убеждение ради одного мелкого воспоминания.\n2. {"action":"refine","observationId":"id убеждения под перепроверкой","belief":"новая формулировка с учётом новых доказательств","sourceIds":["id нового воспоминания-доказательства"]} — используй, когда новые доказательства дополняют или сужают это убеждение; sourceIds должны быть из {newMark} и могут быть пустым массивом (только более точная формулировка).\n3. {"action":"still","observationId":"id убеждения под перепроверкой"} — новые доказательства не влияют на убеждение; исходная формулировка остаётся верной.\n4. {"action":"refute","observationId":"id убеждения под перепроверкой","reason":"причина опровержения (со ссылкой на доказательства)"} — новые доказательства противоречат убеждению и исходное убеждение больше не верно.\nobservationId должен быть взят из id, приведённых в {reviewMark}. Если в материале нет ничего, что стоит закреплять или перепроверять, выведи []. Не выводи ничего, кроме JSON.',
  'llm.reflectStaleLine': '[{id}] доказательств: {count} — {belief}',
  'llm.reflectFormBeliefMissing': 'form: belief отсутствует',
  'llm.reflectFormSourceIdsInvalid': 'form: sourceIds вне диапазона или пуст',

  // ---- Переписывание поискового запроса (retrieve/rewrite) ----
  'llm.rewriteSystemIntro': 'Перепиши поисковый запрос пользователя в не более чем {max} взаимодополняющих поисковых запросов (синонимы, более общие и более узкие понятия, иные формулировки) для гибридного семантического и ключевого поиска по хранилищу долговременной памяти.',
  'llm.rewriteSystemJsonOnly': 'Выведи только один JSON-массив строк и ничего, кроме JSON; если улучшить запрос нельзя, выведи массив, содержащий только исходный запрос.',

  // ---- Ошибки вспомогательного вызова (llm/client) ----
  'llm.finishMaxTokens': 'dsh-kyzmem: вывод вспомогательного вызова достиг предела maxTokens',
  'llm.finishUnexpectedToolCalls': 'dsh-kyzmem: вспомогательный вызов неожиданно запросил инструменты',
  'llm.finishUnsupported': 'dsh-kyzmem: неподдерживаемая причина завершения "{kind}"',
  'llm.emptyOutput': 'вспомогательный вызов вернул пустой вывод',
} as const
