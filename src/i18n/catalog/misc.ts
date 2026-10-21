/**
 * Словарь: HTTP-маршруты панели, экспорт-зеркало, предложения по обновлению,
 * проверка таблички-названия, настройки Jev.
 *
 * Ключи этой области начинаются с `misc.`. Оригинальный китайский текст автора
 * сохранён в `zh`; английский набор — образец полноты, русский может быть неполным
 * (недостающее берётся из английского).
 *
 * @module dsh-kyzmem/i18n/catalog/misc
 */

/** Оригинальные формулировки автора. */
export const zh = {
  // routes.ts
  'misc.entityNotFound': '未找到实体 {id}',
  'misc.recordNotFound': '未找到条目 {id}',
  'misc.exportHeading': '# dsh-kyzmem 导出（{scope}）',
  'misc.exportRecordLine': '- [{status}/{kind}] {content}（id={id}，importance {importance}）',
  'misc.exportEdgesHeading': '## 关系边',
  'misc.importInvalidPayload': '导入文件结构校验失败：{error}',
  'misc.backfillCannotStart': '无法启动回填',
  'misc.archivePathOutsideDbDir': 'archivePath 必须在 dbDir 内',
  'misc.restoreFailed': '恢复失败：{message}',
  // mirror/markdown.ts
  'misc.mirrorTitle': '# 天枢 · {palace}',
  'misc.mirrorPalacePersonal': '私人宫殿',
  'misc.mirrorPalaceProject': '项目宫殿',
  'misc.mirrorSummary': '> 导出时间 {at} · 共 **{total}** 条记忆（对外开放 {active}） · 走廊 {edges} 条',
  'misc.mirrorRoomsHeading': '## 房间导览',
  'misc.mirrorRoomLine': '- **{room}** · {count} 条记忆（开放 {active} · 展厅 {archived} · 闭馆 {forgotten}）',
  'misc.mirrorRecordsHeading': '## 记忆清单',
  'misc.mirrorCorridorsHeading': '## 走廊（关系边）',
  'misc.mirrorNoCorridors': '（暂无走廊）',
  'misc.mirrorUntitled': '记忆铭牌',
  'misc.mirrorCorridorSection': '## 走廊',
  'misc.mirrorNoEdges': '（此记忆暂未连接任何走廊）',
  'misc.mirrorEdgeLine': '- {direction} `{id}`（{type}）',
  // refurb.ts
  'misc.refurbDemoteReason': '重要性 {importance} < {threshold} 且 {days} 天未访问，建议降级为 archived。',
  'misc.refurbMergeReason': '与 {count} 条记忆内容前 20 字重复，建议蒸馏合并。',
  'misc.refurbConflictReason': '与另一条记忆构成矛盾（{days} 天未裁决），建议裁决或合并。',
  'misc.refurbConflictEscalatedReason': '矛盾已悬置 {days} 天仍未裁决，检索会引用互相打架的信念，建议优先处理。',
  'misc.refurbReviewReason': '重要性 {importance} 但从未被参观，可能埋没在走廊，建议复习。',
  'misc.refurbSplitReason': '内容长度 {length} > 400，建议拆为多条独立记忆。',
  'misc.refurbNoPlacardReason': '{slot}未挂门牌：宫殿纪律要求每个标记唯一、差异化、带日期，建议用 kyzmem_update 的 placard 参数补挂。',
  'misc.refurbLowPlacardReason': '{slot}门牌得分 {score} < 0.5（不合唯一/差异化/带日期纪律），建议重写铭牌。',
  // imagery/score.ts
  // 2026-10-11, A-16: здесь стояло «imagery» — внутреннее имя поля (ImageryLabel, колонка
  // imagery_json); наружный параметр инструмента называется placard (см. refurbNoPlacardReason выше).
  // Вызов с imagery проходит без ошибки и молча проглатывается — табличка не прикрепляется.
  // Исправлено во всех трёх словарях; автору сообщаем — это ошибка разработчика, не замысел.
  'misc.placardImprovementHint': '门牌不合规（宫殿纪律：唯一 · 差异化 · 带日期）：建议用 kyzmem_update 的 placard 参数挂一个 4-30 字、含日期锚点、与同房其他门牌前 6 字不重复的铭牌。',
  // jev/runtime.ts
} as const

/** Английский набор — образец полноты. */
export const en = {
  // routes.ts
  'misc.entityNotFound': 'entity {id} not found',
  'misc.recordNotFound': 'record {id} not found',
  'misc.exportHeading': '# dsh-kyzmem export ({scope})',
  'misc.exportRecordLine': '- [{status}/{kind}] {content} (id={id}, importance {importance})',
  'misc.exportEdgesHeading': '## Relation edges',
  'misc.importInvalidPayload': 'import file structure validation failed: {error}',
  'misc.backfillCannotStart': 'cannot start backfill',
  'misc.archivePathOutsideDbDir': 'archivePath must be inside dbDir',
  'misc.restoreFailed': 'restore failed: {message}',
  // mirror/markdown.ts
  'misc.mirrorTitle': '# Tianshu · {palace}',
  'misc.mirrorPalacePersonal': 'Personal palace',
  'misc.mirrorPalaceProject': 'Project palace',
  'misc.mirrorSummary': '> Exported at {at} · **{total}** memories in total ({active} public) · {edges} corridors',
  'misc.mirrorRoomsHeading': '## Room guide',
  'misc.mirrorRoomLine': '- **{room}** · {count} memories (open {active} · exhibition {archived} · closed {forgotten})',
  'misc.mirrorRecordsHeading': '## Memory list',
  'misc.mirrorCorridorsHeading': '## Corridors (relation edges)',
  'misc.mirrorNoCorridors': '(no corridors yet)',
  'misc.mirrorUntitled': 'Memory placard',
  'misc.mirrorCorridorSection': '## Corridors',
  'misc.mirrorNoEdges': '(this memory is not connected to any corridor yet)',
  'misc.mirrorEdgeLine': '- {direction} `{id}` ({type})',
  // refurb.ts
  'misc.refurbDemoteReason': 'importance {importance} < {threshold} and not accessed for {days} days; consider demoting to archived.',
  'misc.refurbMergeReason': 'the first 20 characters duplicate {count} other memories; consider distilling and merging them.',
  'misc.refurbConflictReason': 'contradicts another memory ({days} days unresolved); adjudicate or merge it.',
  'misc.refurbConflictEscalatedReason': 'the contradiction has been unresolved for {days} days; recall would surface conflicting beliefs, so handle it first.',
  'misc.refurbReviewReason': 'importance {importance} but never visited; it may be buried in a corridor, so review is recommended.',
  'misc.refurbSplitReason': 'content length {length} > 400; consider splitting it into several independent memories.',
  'misc.refurbNoPlacardReason': '{slot}no placard yet: palace discipline requires every marker to be unique, distinctive and date-anchored; add one with the placard parameter of kyzmem_update.',
  'misc.refurbLowPlacardReason': '{slot}placard score {score} < 0.5 (violates the unique/distinctive/date-anchored discipline); rewrite the placard.',
  // imagery/score.ts
  // 2026-10-11, A-16: полное пояснение — в китайском блоке выше; наружный параметр называется placard.
  'misc.placardImprovementHint': 'placard does not comply (palace discipline: unique · distinctive · date-anchored): attach a 4-30 character placard with the placard parameter of kyzmem_update, including a date anchor and not repeating the first 6 characters of another placard in the same room.',
  // jev/runtime.ts
} as const

/** Русский набор. */
export const ru = {
  // routes.ts
  'misc.entityNotFound': 'сущность {id} не найдена',
  'misc.recordNotFound': 'запись {id} не найдена',
  'misc.exportHeading': '# Экспорт dsh-kyzmem ({scope})',
  'misc.exportRecordLine': '- [{status}/{kind}] {content} (id={id}, importance {importance})',
  'misc.exportEdgesHeading': '## Связи',
  'misc.importInvalidPayload': 'проверка структуры файла импорта не пройдена: {error}',
  'misc.backfillCannotStart': 'не удалось запустить заполнение',
  'misc.archivePathOutsideDbDir': 'archivePath должен находиться внутри dbDir',
  'misc.restoreFailed': 'восстановление не удалось: {message}',
  // mirror/markdown.ts
  'misc.mirrorTitle': '# Тяньшу · {palace}',
  'misc.mirrorPalacePersonal': 'Личный дворец',
  'misc.mirrorPalaceProject': 'Дворец проекта',
  'misc.mirrorSummary': '> Экспорт {at} · всего **{total}** записей (открыто {active}) · коридоров {edges}',
  'misc.mirrorRoomsHeading': '## Обзор комнат',
  'misc.mirrorRoomLine': '- **{room}** · {count} записей (открыто {active} · выставка {archived} · закрыто {forgotten})',
  'misc.mirrorRecordsHeading': '## Список записей',
  'misc.mirrorCorridorsHeading': '## Коридоры (связи)',
  'misc.mirrorNoCorridors': '(коридоров пока нет)',
  'misc.mirrorUntitled': 'Табличка памяти',
  'misc.mirrorCorridorSection': '## Коридоры',
  'misc.mirrorNoEdges': '(эта запись пока не связана ни с одним коридором)',
  'misc.mirrorEdgeLine': '- {direction} `{id}` ({type})',
  // refurb.ts
  'misc.refurbDemoteReason': 'важность {importance} < {threshold} и нет обращений {days} дн.; рекомендуется понизить до archived.',
  'misc.refurbMergeReason': 'первые 20 символов совпадают с {count} записями; рекомендуется объединить их дистилляцией.',
  'misc.refurbConflictReason': 'противоречит другой записи ({days} дн. без решения); рекомендуется разрешить или объединить.',
  'misc.refurbConflictEscalatedReason': 'противоречие не разрешено уже {days} дн.; поиск будет выдавать конфликтующие убеждения — займитесь им в первую очередь.',
  'misc.refurbReviewReason': 'важность {importance}, но запись ни разу не посещали — возможно, она затерялась в коридоре; рекомендуется повторить.',
  'misc.refurbSplitReason': 'длина содержимого {length} > 400; рекомендуется разделить на несколько независимых записей.',
  'misc.refurbNoPlacardReason': '{slot}табличка не установлена: дисциплина дворца требует, чтобы каждый маркер был уникальным, различимым и с датой; добавьте её параметром placard инструмента kyzmem_update.',
  'misc.refurbLowPlacardReason': '{slot}оценка таблички {score} < 0.5 (нарушает дисциплину уникальности/различимости/даты); перепишите табличку.',
  // imagery/score.ts
  // 2026-10-11, A-16: полное пояснение — в китайском блоке выше; наружный параметр называется placard.
  'misc.placardImprovementHint': 'табличка не соответствует дисциплине дворца (уникальность · различимость · дата): прикрепите параметром placard инструмента kyzmem_update табличку из 4-30 символов с датой, первые 6 символов которой не совпадают с другими табличками той же комнаты.',
  // jev/runtime.ts
} as const
