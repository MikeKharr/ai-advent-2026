// Хранилище диалогов: сессии и сообщения в SQLite на томе агента
// (ADR 2026-09-09-1906). База — источник истины: она хранит переписку
// целиком, а сколько её уйдёт модели, решает бюджет контекста.
//
// `node:sqlite` — модуль самого Node, зависимостей не добавляет. В Node 22
// он требует флага `--experimental-sqlite`, поэтому образ сервиса — Node 24.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
export { isSessionId } from './params.js'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  text       TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  run_id     TEXT,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, id);
-- Внешнего ключа нет намеренно: удаление идёт явными двумя операторами,
-- и порядок «сначала сообщения, потом сессия» переживает обрыв между ними.
-- Осиротевшую сессию подберёт уборка по сроку.

-- Сводка разговора (ADR 2026-09-11-1608): одна строка на сессию,
-- перезаписывается каждой суммаризацией, удаляется вместе с перепиской.
CREATE TABLE IF NOT EXISTS summaries (
  session_id    TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  tokens        INTEGER NOT NULL,
  source_tokens INTEGER NOT NULL,
  through_id    INTEGER NOT NULL,
  model         TEXT,
  truncated     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
-- Цена вызовов сводки копится отдельно от неё: оплаченный вызов без
-- годной сводки (пустой ответ) тоже входит в сумму сессии.
CREATE TABLE IF NOT EXISTS summary_costs (
  session_id TEXT PRIMARY KEY,
  tokens     INTEGER NOT NULL
);
`

export function createSessions({ file, ttlMs, now = Date.now, log = console.error }) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL: чтение не блокируется записью, а обрыв процесса не рвёт файл.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)

  const stmt = {
    touch: db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ),
    insert: db.prepare(
      `INSERT INTO messages (session_id, role, text, tokens, at, run_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    history: db.prepare(
      `SELECT id, role, text, tokens, at, run_id AS runId, meta
       FROM messages WHERE session_id = ? ORDER BY id ASC`,
    ),
    tail: db.prepare(
      `SELECT id, role, text, tokens, meta
       FROM messages WHERE session_id = ? ORDER BY id DESC`,
    ),
    since: db.prepare(
      `SELECT id, role, text, tokens, meta
       FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC`,
    ),
    summary: db.prepare(
      `SELECT text, tokens, source_tokens AS sourceTokens, through_id AS throughId,
              model, truncated, updated_at AS updatedAt
       FROM summaries WHERE session_id = ?`,
    ),
    saveSummary: db.prepare(
      `INSERT INTO summaries
         (session_id, text, tokens, source_tokens, through_id, model, truncated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         text = excluded.text, tokens = excluded.tokens,
         source_tokens = excluded.source_tokens, through_id = excluded.through_id,
         model = excluded.model, truncated = excluded.truncated,
         updated_at = excluded.updated_at`,
    ),
    hasMessage: db.prepare('SELECT 1 AS yes FROM messages WHERE id = ? AND session_id = ?'),
    hasSession: db.prepare('SELECT 1 AS yes FROM sessions WHERE id = ?'),
    addCost: db.prepare(
      `INSERT INTO summary_costs (session_id, tokens) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET tokens = summary_costs.tokens + excluded.tokens`,
    ),
    cost: db.prepare('SELECT tokens FROM summary_costs WHERE session_id = ?'),
    dropCost: db.prepare('DELETE FROM summary_costs WHERE session_id = ?'),
    dropSummary: db.prepare('DELETE FROM summaries WHERE session_id = ?'),
    dropMessages: db.prepare('DELETE FROM messages WHERE session_id = ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    stale: db.prepare('SELECT id FROM sessions WHERE last_seen_at < ?'),
    counts: db.prepare(
      'SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM messages) AS messages',
    ),
  }

  /** Строка базы → сообщение для страницы. Битая сводка не роняет чат. */
  const toMessage = (row) => {
    let meta = null
    try {
      meta = row.meta ? JSON.parse(row.meta) : null
    } catch {
      log(`сводка сообщения ${row.id} не разобрана`)
    }
    return {
      id: row.id,
      role: row.role,
      text: row.text,
      tokens: row.tokens,
      at: row.at ? new Date(row.at).toISOString() : null,
      runId: row.runId ?? null,
      meta,
    }
  }

  return {
    /** Отмечает сессию живой: от этой метки считается срок хранения. */
    touch(sessionId, at = now()) {
      stmt.touch.run(sessionId, at, at)
    },

    append({ sessionId, role, text, tokens, runId = null, meta = null, at = now() }) {
      this.touch(sessionId, at)
      const info = stmt.insert.run(
        sessionId,
        role,
        text,
        Math.max(0, Math.round(tokens)),
        at,
        runId,
        meta ? JSON.stringify(meta) : null,
      )
      return Number(info.lastInsertRowid)
    },

    /** Вся переписка сессии, от старых к свежим — для показа в чате. */
    history(sessionId) {
      return stmt.history.all(sessionId).map(toMessage)
    },

    /**
     * Хвост переписки, укладывающийся в бюджет контекста. Набирается целыми
     * сообщениями от свежих к старым: половина реплики хуже её отсутствия.
     * Записи об ошибках агента в контекст не идут — это наш текст, а не
     * слова модели.
     */
    tail(sessionId, budgetTokens) {
      const chosen = []
      let used = 0
      let dropped = 0
      let full = false
      for (const row of stmt.tail.all(sessionId)) {
        let failed = false
        try {
          failed = row.meta ? JSON.parse(row.meta).error === true : false
        } catch {
          failed = false
        }
        if (failed) continue
        // После первой не поместившейся реплики остальные только считаются:
        // страница обязана сказать, сколько прежних сообщений выпало, а не
        // предупреждать о несобытии.
        if (full || used + row.tokens > budgetTokens) {
          full = true
          dropped += 1
          continue
        }
        used += row.tokens
        chosen.push({ role: row.role, text: row.text, tokens: row.tokens })
      }
      chosen.reverse()
      return { messages: chosen, tokens: used, dropped }
    },

    /**
     * Реплики после сводки, от старых к свежим, с номерами — из них
     * считается порог и собирается следующая сводка. Записи об ошибках
     * не идут, как и в `tail`.
     */
    since(sessionId, afterId) {
      const out = []
      for (const row of stmt.since.all(sessionId, afterId)) {
        let failed = false
        try {
          failed = row.meta ? JSON.parse(row.meta).error === true : false
        } catch {
          failed = false
        }
        if (!failed) out.push({ id: row.id, role: row.role, text: row.text, tokens: row.tokens })
      }
      return out
    },

    /** Сводка разговора или null (ADR 2026-09-11-1608). */
    summary(sessionId) {
      const row = stmt.summary.get(sessionId)
      return row ? { ...row, truncated: row.truncated === 1 } : null
    },

    /**
     * Что уйдёт модели со следующим сообщением: сводка и реплики после неё.
     * Без учёта окна модели — его знает только запуск; окно — страховка.
     */
    context(sessionId) {
      const row = stmt.summary.get(sessionId)
      const summaryTokens = row?.tokens ?? 0
      const freshTokens = this.since(sessionId, row?.throughId ?? 0).reduce(
        (sum, m) => sum + m.tokens,
        0,
      )
      return { total: summaryTokens + freshTokens, summaryTokens, freshTokens }
    },

    /**
     * Новая сводка вместо прежней; цена вызова прибавляется к накопленной.
     * Пишется, только если реплика `throughId` этой сессии ещё есть: вызов
     * сводки идёт секунды, и «очистить» или уборка по сроку за это время
     * не должны получить обратно пересказ стёртой переписки. Проверка и
     * запись — без await между ними и одной транзакцией. Сессия при записи
     * отмечается живой: сводка не остаётся без сессии при уборке.
     * Возвращает, записана ли сводка.
     */
    saveSummary({
      sessionId,
      text,
      tokens,
      sourceTokens,
      throughId,
      model = null,
      truncated = false,
      spentTokens = 0,
      at = now(),
    }) {
      if (!stmt.hasMessage.get(throughId, sessionId)) return false
      db.exec('BEGIN')
      try {
        this.touch(sessionId, at)
        stmt.saveSummary.run(
          sessionId,
          text,
          Math.max(0, Math.round(tokens)),
          Math.max(0, Math.round(sourceTokens)),
          throughId,
          model,
          truncated ? 1 : 0,
          at,
        )
        stmt.addCost.run(sessionId, Math.max(0, Math.round(spentTokens)))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return true
    },

    /**
     * Цена оплаченного вызова, не давшего сводки (пустой ответ). Только для
     * живой сессии: очищенной переписке сумма не нужна.
     */
    addSummaryCost(sessionId, tokens) {
      if (!stmt.hasSession.get(sessionId)) return false
      stmt.addCost.run(sessionId, Math.max(0, Math.round(tokens)))
      return true
    },

    /** Удаляет переписку сессии целиком. Действие «очистить» на странице. */
    clear(sessionId) {
      // Сводка — пересказ той же переписки: живёт и удаляется вместе с ней.
      stmt.dropSummary.run(sessionId)
      stmt.dropCost.run(sessionId)
      const removed = stmt.dropMessages.run(sessionId)
      stmt.dropSession.run(sessionId)
      return Number(removed.changes)
    },

    /** Уборка по сроку хранения: сессии без активности дольше TTL. */
    sweep(at = now()) {
      const cutoff = at - ttlMs
      const stale = stmt.stale.all(cutoff)
      for (const row of stale) this.clear(row.id)
      return stale.length
    },

    /**
     * Во что обошлась переписка целиком: сумма токенов по ответам, где
     * модель ответила. Записи об отказах ничего не стоили и в сумму не
     * входят (ADR 2026-09-09-2134).
     */
    totalTokens(sessionId) {
      let total = 0
      for (const row of stmt.tail.all(sessionId)) {
        if (row.role !== 'agent' || !row.meta) continue
        try {
          const meta = JSON.parse(row.meta)
          if (meta.error === true) continue
          if (Number.isFinite(meta.totalTokens)) total += meta.totalTokens
        } catch {
          // Порченая сводка занижает сумму молча — пусть хотя бы останется след.
          log(`сводка сообщения ${row.id} не разобрана, сумма занижена`)
        }
      }
      // Вызовы сводки стоили денег при любом исходе запуска, поэтому их цена
      // копится отдельно, а не в ответах (ADR 2026-09-11-1608).
      total += stmt.cost.get(sessionId)?.tokens ?? 0
      return total
    },

    stats() {
      return stmt.counts.get()
    },

    close() {
      db.close()
    },
  }
}
