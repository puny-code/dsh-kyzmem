#!/usr/bin/env node
/**
 * Миграция имён комнат: отображаемые названия → нейтральные идентификаторы.
 *
 * До появления языкового слоя в slot_room писалось отображаемое имя («事实厅»),
 * из-за чего язык интерфейса протекал в данные. Теперь в данных лежит идентификатор
 * (fact), а человекочитаемое имя берётся из словаря по языку вывода
 * (см. src/i18n/rooms.ts). Скрипт переписывает уже сохранённые записи.
 *
 * По умолчанию ничего не меняет — только показывает, что будет сделано.
 *
 * Запуск:
 *   node scripts/migrate-room-ids.mjs                    # показать план
 *   node scripts/migrate-room-ids.mjs --apply            # выполнить
 *   node scripts/migrate-room-ids.mjs --db-dir <путь>    # другая папка с базами
 */

import { DatabaseSync } from 'node:sqlite'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Старое отображаемое имя → нейтральный идентификатор. */
const ROOM_IDS = {
  '事实厅': 'fact',
  '偏好阁': 'preference',
  '决策堂': 'decision',
  '往事廊': 'episode',
  '技法坊': 'skill',
}

/** «事实厅-2» → «fact-2»; неизвестное имя → undefined (не трогаем). */
function migrateRoom(room) {
  for (const [label, id] of Object.entries(ROOM_IDS)) {
    if (room === label) return id
    if (room.startsWith(`${label}-`)) return `${id}${room.slice(label.length)}`
  }
  return undefined
}

function parseArgs(argv) {
  const options = { apply: false, dbDir: join(homedir(), '.dsh', 'kyzmem') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true
    else if (argv[i] === '--db-dir') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--db-dir требует путь')
      options.dbDir = value
      i += 1
    } else throw new Error(`неизвестный аргумент: ${argv[i]}`)
  }
  return options
}

function main() {
  const { apply, dbDir } = parseArgs(process.argv.slice(2))
  const files = readdirSync(dbDir)
    .filter(name => name.endsWith('.db'))
    .map(name => join(dbDir, name))
    .filter(path => statSync(path).isFile())

  if (files.length === 0) {
    console.log(`В ${dbDir} нет файлов .db`)
    return
  }

  let totalChanged = 0
  for (const path of files) {
    const db = new DatabaseSync(path)
    try {
      const rows = db.prepare(
        'SELECT slot_room AS room, COUNT(*) AS n FROM nodes WHERE slot_room IS NOT NULL GROUP BY slot_room',
      ).all()

      const plan = []
      for (const row of rows) {
        const next = migrateRoom(String(row.room))
        if (next !== undefined && next !== row.room) plan.push({ from: String(row.room), to: next, n: Number(row.n) })
      }

      const name = path.slice(path.lastIndexOf('\\') + 1)
      if (plan.length === 0) {
        console.log(`${name}: нечего менять`)
        continue
      }

      console.log(`${name}:`)
      for (const step of plan) console.log(`  ${step.from} → ${step.to}  (${step.n} записей)`)

      if (apply) {
        const update = db.prepare('UPDATE nodes SET slot_room = ? WHERE slot_room = ?')
        db.exec('BEGIN')
        try {
          for (const step of plan) {
            update.run(step.to, step.from)
            totalChanged += step.n
          }
          db.exec('COMMIT')
          console.log('  применено')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
    } finally {
      db.close()
    }
  }

  console.log(apply ? `\nИзменено записей: ${totalChanged}` : '\nЭто план. Для выполнения добавьте --apply')
}

main()
