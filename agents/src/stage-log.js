// Журнал этапов дня 13 (ADR 2026-09-21-1747, п. 7): строка — один проход
// одного этапа, файл на томе агентов, дописывается в конце запуска.
//
// Текстов в журнале нет: ни промпта, ни реплик, ни правил и фактов, ни имени
// профиля, ни адреса. Промпт — идентификатор, восемь знаков SHA-256 и размер.
// Это то же правило, что у событий монитора (ADR 2026-09-09-0854, п. 4), и
// держится оно здесь набором колонок: чего нет в списке, того не записать.
//
// Файл дописывается синхронно: строки пишутся один раз на запуск, и
// асинхронная запись на общий файл потребовала бы очереди ради выигрыша в
// доли миллисекунды.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Колонки журнала. Порядок значим: он же порядок в файле и в таблице. */
export const STAGE_LOG_COLUMNS = [
  'run_id',
  'session_id',
  'agent',
  'model',
  'state',
  'state_index',
  'attempt',
  'entered_at',
  'left_at',
  'duration_ms',
  'outcome',
  'pauses',
  'llm_called',
  'prompt_id',
  'prompt_sha8',
  'prompt_tokens',
  'context_tokens',
  'input_tokens',
  'output_tokens',
  'round',
  'verdict',
  'run_status',
  'error_code',
  // Дописана в конец, а не рядом с `prompt_tokens`: файл на томе переживает
  // выкатку, `rowsOf` разбирает строку по номерам колонок, и вставка в
  // середину сдвинула бы все прежние строки на одну ячейку. У этапа
  // «Подготовка промпта» дня 15 здесь длина `system` и `input` вместе
  // (ADR 2026-09-23-0646, п. 4); текста в журнале по-прежнему нет — он в
  // SQLite и уходит вместе с диалогом.
  'prompt_chars',
]

/** BOM: без него русский Excel читает UTF-8 как cp1251. */
const BOM = '﻿'

/** Ячейка по RFC 4180: управляющие символы снимаются, запятая и кавычка экранируются. */
function cell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ')
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Разбор строки CSV: кавычки по RFC 4180, разделитель — запятая. */
function parseLine(line) {
  const cells = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else quoted = false
      } else current += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      cells.push(current)
      current = ''
    } else current += ch
  }
  cells.push(current)
  return cells
}

export function createStageLog({ file, log = () => {} }) {
  const header = `${STAGE_LOG_COLUMNS.join(',')}\n`

  /** Строки файла без заголовка и без BOM. Битый или отсутствующий файл — пусто. */
  function lines() {
    if (!existsSync(file)) return []
    try {
      const raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
      return raw.split('\n').filter((line) => line !== '' && !line.startsWith('run_id,'))
    } catch (error) {
      log(`журнал этапов: чтение не удалось: ${error.message}`)
      return []
    }
  }

  return {
    /** Дописывает проходы этапов одного запуска. Отказ записи запуск не валит. */
    append(rows) {
      if (rows.length === 0) return false
      const text = rows.map((row) => STAGE_LOG_COLUMNS.map((c) => cell(row[c])).join(',')).join('\n')
      try {
        const fresh = !existsSync(file)
        appendFileSync(file, `${fresh ? BOM + header : ''}${text}\n`, 'utf8')
        return true
      } catch (error) {
        log(`журнал этапов: запись не удалась: ${error.message}`)
        return false
      }
    },

    /** Строки одного запуска объектами — для таблицы в карточке запуска. */
    rowsOf(runId) {
      const rows = []
      for (const line of lines()) {
        const cells = parseLine(line)
        if (cells[0] !== runId) continue
        rows.push(Object.fromEntries(STAGE_LOG_COLUMNS.map((c, i) => [c, cells[i] ?? ''])))
      }
      return rows
    },

    /** Файл одного запуска: заголовок и его строки. Чужих строк в нём нет. */
    csvOf(runId) {
      const own = lines().filter((line) => parseLine(line)[0] === runId)
      return `${BOM}${header}${own.map((line) => `${line}\n`).join('')}`
    },

    /**
     * Снимает строки старше среза по времени входа в этап. Зовётся уборкой
     * сессий: срок хранения журнала — тот же, что у переписки (ADR, п. 7).
     */
    prune(cutoffIso) {
      const all = lines()
      const kept = all.filter((line) => {
        const at = parseLine(line)[STAGE_LOG_COLUMNS.indexOf('entered_at')]
        return at >= cutoffIso
      })
      if (kept.length === all.length) return 0
      try {
        if (kept.length === 0 && !existsSync(file)) return 0
        writeFileSync(file, `${BOM}${header}${kept.map((line) => `${line}\n`).join('')}`, 'utf8')
      } catch (error) {
        log(`журнал этапов: уборка не удалась: ${error.message}`)
        return 0
      }
      return all.length - kept.length
    },
  }
}
