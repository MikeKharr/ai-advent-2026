// Хранилище диалогов: сессии и сообщения в SQLite на томе агента
// (ADR 2026-09-12-0930). База — источник истины: она хранит переписку
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

    /** Удаляет переписку сессии целиком. Действие «очистить» на странице. */
    clear(sessionId) {
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
     * входят (ADR 2026-09-13-0930).
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
