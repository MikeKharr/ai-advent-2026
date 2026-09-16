// Хранилище диалогов: сессии и сообщения в SQLite на томе агента
// (ADR 2026-09-09-1906). База — источник истины: она хранит переписку
// целиком, а сколько её уйдёт модели, решает бюджет контекста.
//
// `node:sqlite` — модуль самого Node, зависимостей не добавляет. В Node 22
// он требует флага `--experimental-sqlite`, поэтому образ сервиса — Node 24.

import { randomUUID } from 'node:crypto'
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

-- Факты разговора (ADR 2026-09-14-0447, п. 7.3): строка на сессию,
-- перезаписывается каждым вызовом, живёт и удаляется вместе с перепиской.
-- Цена вызовов копится в summary_costs — та же сумма «вызовы памяти».
CREATE TABLE IF NOT EXISTS facts (
  session_id       TEXT PRIMARY KEY,
  text             TEXT NOT NULL,          -- '' после обрезанного первого вызова
  tokens           INTEGER NOT NULL,
  through_id       INTEGER NOT NULL,
  model            TEXT,
  limit_tokens     INTEGER NOT NULL,       -- лимит последнего вызова
  truncated_streak INTEGER NOT NULL DEFAULT 0,  -- обрезаний подряд; ≥ 2 — стоп
  updated_at       INTEGER NOT NULL
);

-- Профили дня 11 (ADR 2026-09-15-2024, п. 10). Профиль — ярлык, по которому
-- агент находит свою память, а не защита: все профили видны всем. Живёт
-- 30 дней от последнего действия любого посетителя в нём.
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  settings     TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Память персонализации: правила из разговора. Имя правила уникально в
-- профиле, новое правило заменяет прежнее с тем же именем. Пополняет их
-- вызов памяти (фаза 4б); хранение и уборка — здесь.
CREATE TABLE IF NOT EXISTS personalization (
  profile_id        TEXT NOT NULL,
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  source_session_id TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (profile_id, key)
);

-- Память фактов: темы профиля и факты в них. Тема переживает сессию и
-- уходит только вместе с профилем (ADR, п. 6.1). Имя "facts" в базе занято
-- строкой стратегии рабочей памяти, поэтому таблица — topic_facts.
CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS topics_by_profile ON topics(profile_id, updated_at);
CREATE TABLE IF NOT EXISTS topic_facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id          INTEGER NOT NULL,
  text              TEXT NOT NULL,
  source_session_id TEXT,
  at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS topic_facts_by_topic ON topic_facts(topic_id, id);
`

/**
 * Столбцы дерева дня 10 (ADR 2026-09-14-0447, п. 9) и профиля дня 11
 * (ADR 2026-09-15-2024, п. 10). Добавляются при старте идемпотентно: старые
 * строки получают NULL, все операторы дней 6–10 называют столбцы явно,
 * поэтому ни один их запрос не меняет ни текста, ни результата. `profile_id`
 * NULL — это и есть сессия дней 6–10: она не принадлежит ни одному профилю
 * и потому не попадает ни под один оператор удаления профиля.
 */
function migrate(db) {
  const has = (table, column) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
  if (!has('messages', 'parent_id')) db.exec('ALTER TABLE messages ADD COLUMN parent_id INTEGER')
  if (!has('sessions', 'head_id')) db.exec('ALTER TABLE sessions ADD COLUMN head_id INTEGER')
  if (!has('sessions', 'profile_id')) db.exec('ALTER TABLE sessions ADD COLUMN profile_id TEXT')
  if (!has('sessions', 'topic_id')) db.exec('ALTER TABLE sessions ADD COLUMN topic_id INTEGER')
  if (!has('sessions', 'pending_topic')) {
    db.exec('ALTER TABLE sessions ADD COLUMN pending_topic TEXT')
  }
  // Индекс создаётся после столбца: в старой базе его колонки ещё нет.
  db.exec('CREATE INDEX IF NOT EXISTS sessions_by_profile ON sessions(profile_id, last_seen_at)')
}

export function createSessions({
  file,
  ttlMs,
  // Профиль живёт дольше своих диалогов, потолки — временные рабочие
  // значения решения владельца 8 (ADR 2026-09-15-2024).
  profileTtlMs = 30 * 24 * 3600_000,
  profileCap = 5,
  sessionCap = 20,
  now = Date.now,
  log = console.error,
}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL: чтение не блокируется записью, а обрыв процесса не рвёт файл.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  migrate(db)

  const stmt = {
    touch: db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ),
    insert: db.prepare(
      `INSERT INTO messages (session_id, role, text, tokens, at, run_id, meta, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    history: db.prepare(
      `SELECT id, role, text, tokens, at, run_id AS runId, meta, parent_id AS parentId
       FROM messages WHERE session_id = ? ORDER BY id ASC`,
    ),
    // Путь ветки строится вверх от головы по parent_id. Фильтр по session_id
    // стоит на каждом шаге обхода, а не только в стартовом узле: номера
    // сообщений сквозные по общей базе дней 6–10, и обход без него, начатый
    // с чужого узла, собрал бы чужую переписку (ADR 2026-09-14-0447, п. 8.3).
    pathUp: db.prepare(
      `WITH RECURSIVE up(id, role, text, tokens, meta, parent_id) AS (
         SELECT id, role, text, tokens, meta, parent_id
           FROM messages WHERE id = ? AND session_id = ?
         UNION ALL
         SELECT m.id, m.role, m.text, m.tokens, m.meta, m.parent_id
           FROM messages m JOIN up ON m.id = up.parent_id
          WHERE m.session_id = ?
       )
       SELECT id, role, text, tokens, meta FROM up ORDER BY id ASC`,
    ),
    // Самый поздний лист поддерева: наибольший номер в нём. Ребёнок всегда
    // моложе родителя, поэтому узел с наибольшим номером детей не имеет.
    subtreeLatest: db.prepare(
      `WITH RECURSIVE down(id) AS (
         SELECT id FROM messages WHERE id = ? AND session_id = ?
         UNION ALL
         SELECT m.id FROM messages m JOIN down ON m.parent_id = down.id
          WHERE m.session_id = ?
       )
       SELECT max(id) AS id FROM down`,
    ),
    setHead: db.prepare('UPDATE sessions SET head_id = ? WHERE id = ?'),
    head: db.prepare('SELECT head_id AS headId FROM sessions WHERE id = ?'),
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
    facts: db.prepare(
      `SELECT text, tokens, through_id AS throughId, model, limit_tokens AS limitTokens,
              truncated_streak AS truncatedStreak, updated_at AS updatedAt
       FROM facts WHERE session_id = ?`,
    ),
    saveFacts: db.prepare(
      `INSERT INTO facts
         (session_id, text, tokens, through_id, model, limit_tokens, truncated_streak, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         text = excluded.text, tokens = excluded.tokens,
         through_id = excluded.through_id, model = excluded.model,
         limit_tokens = excluded.limit_tokens,
         truncated_streak = excluded.truncated_streak,
         updated_at = excluded.updated_at`,
    ),
    dropFacts: db.prepare('DELETE FROM facts WHERE session_id = ?'),
    orphanFacts: db.prepare(
      'DELETE FROM facts WHERE session_id NOT IN (SELECT id FROM sessions)',
    ),
    hasMessage: db.prepare('SELECT 1 AS yes FROM messages WHERE id = ? AND session_id = ?'),
    message: db.prepare('SELECT id, role FROM messages WHERE id = ? AND session_id = ?'),
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
    // Сироты: строки, чья сессия уже удалена. `sweep` идёт по строкам
    // `sessions`, поэтому без отдельного прохода они не удалялись бы никогда
    // (ADR 2026-09-14-0447, п. 9).
    orphanMessages: db.prepare(
      'DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)',
    ),
    orphanSummaries: db.prepare(
      'DELETE FROM summaries WHERE session_id NOT IN (SELECT id FROM sessions)',
    ),
    orphanCosts: db.prepare(
      'DELETE FROM summary_costs WHERE session_id NOT IN (SELECT id FROM sessions)',
    ),
    counts: db.prepare(
      'SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM messages) AS messages',
    ),

    // --- Профили дня 11 (ADR 2026-09-15-2024, п. 2 и 3) ------------------
    addProfile: db.prepare(
      'INSERT INTO profiles (id, name, settings, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ),
    liveProfiles: db.prepare(
      `SELECT p.id, p.name, p.created_at AS createdAt, p.last_seen_at AS lastSeenAt,
              (SELECT count(*) FROM sessions s
                WHERE s.profile_id = p.id AND s.last_seen_at >= ?) AS sessions
         FROM profiles p WHERE p.last_seen_at >= ? ORDER BY p.last_seen_at DESC`,
    ),
    countProfiles: db.prepare('SELECT count(*) AS n FROM profiles WHERE last_seen_at >= ?'),
    profile: db.prepare(
      `SELECT id, name, settings, created_at AS createdAt, last_seen_at AS lastSeenAt
         FROM profiles WHERE id = ? AND last_seen_at >= ?`,
    ),
    touchProfile: db.prepare('UPDATE profiles SET last_seen_at = ? WHERE id = ?'),
    saveSettings: db.prepare('UPDATE profiles SET settings = ?, last_seen_at = ? WHERE id = ?'),
    staleProfiles: db.prepare('SELECT id FROM profiles WHERE last_seen_at < ?'),
    rules: db.prepare(
      `SELECT key, value, source_session_id AS sourceSessionId, updated_at AS updatedAt
         FROM personalization WHERE profile_id = ? ORDER BY updated_at DESC`,
    ),
    topics: db.prepare(
      `SELECT t.id, t.title, t.created_at AS createdAt, t.updated_at AS updatedAt,
              (SELECT count(*) FROM topic_facts f WHERE f.topic_id = t.id) AS facts
         FROM topics t WHERE t.profile_id = ? ORDER BY t.updated_at DESC`,
    ),
    topicOfProfile: db.prepare('SELECT id FROM topics WHERE id = ? AND profile_id = ?'),

    // --- Сессии профиля --------------------------------------------------
    addSession: db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_id, topic_id)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    liveSessions: db.prepare(
      `SELECT s.id, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt,
              s.topic_id AS topicId, t.title AS topicTitle,
              (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS messages,
              (SELECT m.text FROM messages m
                WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id ASC LIMIT 1) AS opening
         FROM sessions s LEFT JOIN topics t ON t.id = s.topic_id
        WHERE s.profile_id = ? AND s.last_seen_at >= ?
        ORDER BY s.last_seen_at DESC`,
    ),
    countSessions: db.prepare(
      'SELECT count(*) AS n FROM sessions WHERE profile_id = ? AND last_seen_at >= ?',
    ),
    sessionOwner: db.prepare('SELECT profile_id AS profileId FROM sessions WHERE id = ?'),

    // --- Удаление профиля: девять таблиц одной транзакцией (критерий 2) ---
    // Каждый оператор ограничен профилем и его сессиями. Сессии дней 6–10
    // несут `profile_id` NULL, а `= ?` с непустым идентификатором с NULL не
    // совпадает никогда — поэтому чужая переписка под эти операторы не
    // попадает ни при каком значении.
    dropProfileMessages: db.prepare(
      'DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE profile_id = ?)',
    ),
    dropProfileSummaries: db.prepare(
      'DELETE FROM summaries WHERE session_id IN (SELECT id FROM sessions WHERE profile_id = ?)',
    ),
    dropProfileFacts: db.prepare(
      'DELETE FROM facts WHERE session_id IN (SELECT id FROM sessions WHERE profile_id = ?)',
    ),
    dropProfileCosts: db.prepare(
      'DELETE FROM summary_costs WHERE session_id IN (SELECT id FROM sessions WHERE profile_id = ?)',
    ),
    dropProfileSessions: db.prepare('DELETE FROM sessions WHERE profile_id = ?'),
    dropProfileTopicFacts: db.prepare(
      'DELETE FROM topic_facts WHERE topic_id IN (SELECT id FROM topics WHERE profile_id = ?)',
    ),
    dropProfileTopics: db.prepare('DELETE FROM topics WHERE profile_id = ?'),
    dropProfileRules: db.prepare('DELETE FROM personalization WHERE profile_id = ?'),
    dropProfile: db.prepare('DELETE FROM profiles WHERE id = ?'),

    // --- Сироты новых таблиц --------------------------------------------
    orphanRules: db.prepare(
      'DELETE FROM personalization WHERE profile_id NOT IN (SELECT id FROM profiles)',
    ),
    orphanTopics: db.prepare('DELETE FROM topics WHERE profile_id NOT IN (SELECT id FROM profiles)'),
    orphanTopicFacts: db.prepare(
      'DELETE FROM topic_facts WHERE topic_id NOT IN (SELECT id FROM topics)',
    ),
    // Сессия, чей профиль уже удалён: убирается целиком, как любая другая.
    orphanProfileSessions: db.prepare(
      'SELECT id FROM sessions WHERE profile_id IS NOT NULL AND profile_id NOT IN (SELECT id FROM profiles)',
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
      // NULL у линейных сессий дней 6–9: у них дерева нет.
      parentId: row.parentId ?? null,
      meta,
    }
  }

  /** Запись об ошибке агента: в контекст не идёт, родителем быть может. */
  const failed = (row) => {
    try {
      return row.meta ? JSON.parse(row.meta).error === true : false
    } catch {
      return false
    }
  }

  return {
    /** Отмечает сессию живой: от этой метки считается срок хранения. */
    touch(sessionId, at = now()) {
      stmt.touch.run(sessionId, at, at)
    },

    append({ sessionId, role, text, tokens, runId = null, meta = null, parentId = null, at = now() }) {
      this.touch(sessionId, at)
      const info = stmt.insert.run(
        sessionId,
        role,
        text,
        Math.max(0, Math.round(tokens)),
        at,
        runId,
        meta ? JSON.stringify(meta) : null,
        parentId,
      )
      return Number(info.lastInsertRowid)
    },

    /** Голова текущей ветки или null у линейных сессий дней 6–9. */
    head(sessionId) {
      return stmt.head.get(sessionId)?.headId ?? null
    },

    /** Переставляет голову. Принадлежность сообщения сессии проверяет вызывающий. */
    setHead(sessionId, messageId) {
      stmt.setHead.run(messageId, sessionId)
    },

    /** Есть ли такое сообщение в этой сессии. Граница чтения чужой переписки. */
    hasMessage(sessionId, messageId) {
      return Boolean(stmt.hasMessage.get(messageId, sessionId))
    },

    /** Сообщение этой сессии или null — для проверки родителя на границе. */
    message(sessionId, messageId) {
      const row = stmt.message.get(messageId, sessionId)
      return row ? { id: row.id, role: row.role } : null
    },

    /**
     * Самый поздний лист поддерева — куда встаёт голова при переключении
     * ветки: сестра грузится со всем своим нижним хвостом.
     */
    latestLeaf(sessionId, messageId) {
      return stmt.subtreeLatest.get(messageId, sessionId, sessionId)?.id ?? null
    },

    /**
     * Путь от корня до головы, без записей об ошибках. У сессий без головы
     * (дни 6–9) путь — вся переписка по порядку номеров: дерева нет, и
     * «последние M» считаются от неё.
     */
    path(sessionId, fromId = undefined) {
      // Обычный запуск идёт от головы; запуск с явным родителем — от него:
      // новая ветка наследует путь указанного предка, а не прежней головы.
      const start = fromId === undefined ? this.head(sessionId) : fromId
      // Явный корень: наследовать нечего.
      if (start === null && fromId === null) return []
      const rows =
        start === null ? stmt.history.all(sessionId) : stmt.pathUp.all(start, sessionId, sessionId)
      return rows
        .filter((row) => !failed(row))
        .map((row) => ({ id: row.id, role: row.role, text: row.text, tokens: row.tokens }))
    },

    /**
     * Источник сводки по пути: реплики после якоря `through_id`. Если якорь
     * не на пути, сводку писали в другой ветке — она считается отсутствующей,
     * и стратегия стартует заново со всего пути (ADR 2026-09-14-0447, п. 8.4,
     * критерий 5). Иначе пересказ соседней ветки ушёл бы модели, осел бы в
     * базе и наследовался всеми следующими сводками.
     */
    summarySource(sessionId, throughId, fromId = undefined) {
      const path = this.path(sessionId, fromId)
      if (!throughId) return { onPath: true, fresh: path }
      const at = path.findIndex((m) => m.id === throughId)
      if (at === -1) return { onPath: false, fresh: path }
      return { onPath: true, fresh: path.slice(at + 1) }
    },

    /**
     * Источник фактов по пути — то же правило, что у сводки: якорь вне пути
     * значит, что факты писали в другой ветке, и они считаются отсутствующими
     * (ADR 2026-09-14-0447, п. 8.4). Сколько реплик из `fresh` реально уйдёт
     * в вызов, решает запуск: не больше последних M и не больше потолка
     * исходника в токенах.
     */
    factsSource(sessionId, throughId, fromId = undefined) {
      return this.summarySource(sessionId, throughId, fromId)
    },

    /** Факты разговора или null (ADR 2026-09-14-0447, п. 7.3). */
    facts(sessionId) {
      return stmt.facts.get(sessionId) ?? null
    },

    /** Последние M реплик пути — стратегия «окно» (ADR 2026-09-14-0447, п. 6). */
    lastOnPath(sessionId, count, fromId = undefined) {
      return this.path(sessionId, fromId).slice(-count)
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
     * Что накоплено к следующему сообщению. Без стратегии — ответ дней 7–9,
     * байт в байт: сводка и реплики после неё, без учёта окна модели.
     * Со стратегией счётчик считается по ней и по действующему окну модели,
     * иначе число на странице врало бы (ADR 2026-09-14-0447, п. 3).
     */
    context(sessionId, { strategy = null, windowSize = null, effective = null } = {}) {
      if (strategy === 'window') {
        const messages = this.lastOnPath(sessionId, windowSize)
        const total = messages.reduce((sum, m) => sum + m.tokens, 0)
        return { total, messages: messages.length, windowSize }
      }
      if (strategy === 'facts') {
        const messages = this.lastOnPath(sessionId, windowSize)
        const fresh = messages.reduce((sum, m) => sum + m.tokens, 0)
        const row = stmt.facts.get(sessionId)
        // Факты с якорем вне пути в счёт не идут — их не получит и запуск.
        const onPath = row ? this.factsSource(sessionId, row.throughId).onPath : false
        const factsTokens = onPath ? row.tokens : 0
        return { total: factsTokens + fresh, factsTokens, messages: messages.length, windowSize }
      }
      if (strategy === 'branches') {
        const path = this.path(sessionId)
        // Хвостом в окно, как в запуске: целыми репликами от свежих к старым.
        let used = 0
        let taken = 0
        for (let i = path.length - 1; i >= 0; i--) {
          if (used + path[i].tokens > effective) break
          used += path[i].tokens
          taken += 1
        }
        return {
          total: used,
          messages: taken,
          pathMessages: path.length,
          dropped: path.length - taken,
          effective,
        }
      }
      const row = stmt.summary.get(sessionId)
      if (strategy !== 'summary') {
        // Дни 7–9: по номерам и без учёта окна модели — его знает только запуск.
        const fresh = this.since(sessionId, row?.throughId ?? 0)
        const freshTokens = fresh.reduce((sum, m) => sum + m.tokens, 0)
        const summaryTokens = row?.tokens ?? 0
        return { total: summaryTokens + freshTokens, summaryTokens, freshTokens }
      }
      // Стратегия 1 — по пути, тем же правилом, что в `memory.js`: сводка с
      // якорем вне пути не считается, а оставшаяся идёт, только если
      // помещается в окно целиком (подрезать её нельзя), репликам — остаток.
      const source = this.summarySource(sessionId, row?.throughId ?? 0)
      const stored = source.onPath ? (row?.tokens ?? 0) : 0
      const summaryTokens = stored <= effective ? stored : 0
      let freshTokens = 0
      for (let i = source.fresh.length - 1; i >= 0; i--) {
        if (freshTokens + source.fresh[i].tokens > effective - summaryTokens) break
        freshTokens += source.fresh[i].tokens
      }
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
     * Новые факты вместо прежних; цена вызова прибавляется к накопленной —
     * в ту же сумму «вызовы памяти», что и сводка. Защита та же, что у
     * `saveSummary`: вызов фактов идёт секунды после ответа, и «очистить»
     * или уборка по сроку за это время не должны получить обратно выжимку
     * стёртой переписки. Проверка и запись — без await между ними и одной
     * транзакцией (ADR 2026-09-14-0447, п. 7.3).
     *
     * `throughId` — якорь, с которого начнётся источник следующего вызова;
     * при обрезанном выходе он не двигается и может быть нулевым. Живой
     * проверяется `aliveId` — реплика, которую этот вызов только что
     * обработал: якорь 0 проверить нечем, а гонку с удалением ловить надо.
     * Возвращает, записаны ли факты.
     */
    saveFacts({
      sessionId,
      text,
      tokens,
      throughId,
      aliveId = throughId,
      model = null,
      limitTokens,
      truncatedStreak = 0,
      spentTokens = 0,
      at = now(),
    }) {
      if (!stmt.hasMessage.get(aliveId, sessionId)) return false
      db.exec('BEGIN')
      try {
        this.touch(sessionId, at)
        stmt.saveFacts.run(
          sessionId,
          text,
          Math.max(0, Math.round(tokens)),
          throughId,
          model,
          limitTokens,
          truncatedStreak,
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
      // Сводка и факты — выжимка из той же переписки: живут и удаляются
      // вместе с ней (ADR 2026-09-14-0447, п. 7.3, решение владельца 5).
      stmt.dropFacts.run(sessionId)
      stmt.dropSummary.run(sessionId)
      stmt.dropCost.run(sessionId)
      const removed = stmt.dropMessages.run(sessionId)
      stmt.dropSession.run(sessionId)
      return Number(removed.changes)
    },

    /**
     * Уборка по сроку хранения: сессии без активности дольше TTL. Следом —
     * сироты: строки, чья сессия уже удалена. `sweep` идёт по `sessions`,
     * поэтому иначе к ним никто больше не пришёл бы никогда, а страница
     * обещает 30 часов (ADR 2026-09-14-0447, п. 9).
     */
    sweep(at = now()) {
      // Сначала профили старше своего срока: они уходят со всей памятью тем
      // же оператором, что `deleteProfile`, и уносят свои сессии целиком.
      // Возвращаемое число — по-прежнему убранные сессии: его читает журнал
      // сервиса, и смысл «сколько диалогов истекло» не меняется.
      for (const row of stmt.staleProfiles.all(at - profileTtlMs)) this.deleteProfile(row.id)
      const cutoff = at - ttlMs
      const stale = stmt.stale.all(cutoff)
      for (const row of stale) this.clear(row.id)
      // Сессия, чей профиль удалён в обход `deleteProfile` (оборвавшаяся
      // транзакция, правка базы руками), уходит целиком, а не строкой.
      for (const row of stmt.orphanProfileSessions.all()) this.clear(row.id)
      stmt.orphanMessages.run()
      stmt.orphanSummaries.run()
      stmt.orphanFacts.run()
      stmt.orphanCosts.run()
      stmt.orphanRules.run()
      stmt.orphanTopics.run()
      // Факты тем — после тем: осиротевшая тема сначала должна исчезнуть.
      stmt.orphanTopicFacts.run()
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

    // --- Профили дня 11 (ADR 2026-09-15-2024) -----------------------------

    /**
     * Все живые профили по убыванию активности: их видят все посетители —
     * профиль это ярлык памяти, а не учётная запись (решение владельца 9).
     */
    profiles(at = now()) {
      return stmt.liveProfiles.all(at - ttlMs, at - profileTtlMs)
    },

    /**
     * Профиль со всей его памятью для экрана и монитора: настройки, правила,
     * темы, живые диалоги. `lastSession` — последний по активности живой
     * диалог или null; на нём стоит решение страницы, ставить ли cookie
     * сессии. Чтение профиля активность НЕ продлевает (ADR, п. 2): иначе
     * случайный клик постороннего держал бы чужую память ещё месяц.
     */
    profile(id, at = now()) {
      const row = stmt.profile.get(id, at - profileTtlMs)
      if (!row) return null
      let settings = {}
      try {
        settings = row.settings ? JSON.parse(row.settings) : {}
      } catch {
        // Порченые настройки не должны прятать профиль целиком: остальная
        // память посетителю нужнее, а окно настроек перезапишет их.
        log(`настройки профиля ${id.slice(0, 8)}… не разобраны`)
      }
      const sessions = stmt.liveSessions.all(id, at - ttlMs)
      return {
        id: row.id,
        name: row.name,
        settings,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        rules: stmt.rules.all(id),
        topics: stmt.topics.all(id),
        sessions,
        lastSession: sessions[0]?.id ?? null,
      }
    },

    /**
     * Новый профиль. Потолок живых профилей проверяется в той же транзакции,
     * что вставка: два одновременных создания иначе дали бы шестой.
     * Шестому посетителю продукт не предлагает стереть чужое — он получает
     * отказ `profiles_full`.
     */
    createProfile({ name, at = now() }) {
      db.exec('BEGIN')
      try {
        if (stmt.countProfiles.get(at - profileTtlMs).n >= profileCap) {
          db.exec('ROLLBACK')
          return { ok: false, code: 'profiles_full' }
        }
        const id = randomUUID()
        stmt.addProfile.run(id, name, '{}', at, at)
        db.exec('COMMIT')
        return { ok: true, profile: this.profile(id, at) }
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    /**
     * Действие в профиле: срок хранения всей его памяти идёт от него. Любое
     * действие любого посетителя, не владельца данных (ADR, «Последствия»).
     */
    touchProfile(id, at = now()) {
      if (!stmt.profile.get(id, at - profileTtlMs)) return false
      stmt.touchProfile.run(at, id)
      return true
    },

    /** Настройки агента за профилем: пишутся целиком заново (ADR, п. 4). */
    saveSettings({ profileId, settings, at = now() }) {
      if (!stmt.profile.get(profileId, at - profileTtlMs)) return false
      stmt.saveSettings.run(JSON.stringify(settings), at, profileId)
      return true
    },

    /**
     * Удаление профиля со всей связанной памятью — одной транзакцией
     * (решение владельца 10, критерий 2). После неё ни в одной из девяти
     * таблиц нет строки этого профиля, его сессий и его тем; чужие сессии
     * (`profile_id` NULL у дней 6–10 и идентификатор другого профиля) ни под
     * один оператор не попадают. Удалить профиль может любой посетитель —
     * это названное последствие открытости, а не упущение.
     */
    deleteProfile(id) {
      if (!stmt.profile.get(id, 0)) return null
      db.exec('BEGIN')
      try {
        const removed = {
          messages: Number(stmt.dropProfileMessages.run(id).changes),
          summaries: Number(stmt.dropProfileSummaries.run(id).changes),
          facts: Number(stmt.dropProfileFacts.run(id).changes),
          costs: Number(stmt.dropProfileCosts.run(id).changes),
          topicFacts: Number(stmt.dropProfileTopicFacts.run(id).changes),
          topics: Number(stmt.dropProfileTopics.run(id).changes),
          rules: Number(stmt.dropProfileRules.run(id).changes),
          sessions: Number(stmt.dropProfileSessions.run(id).changes),
          profiles: Number(stmt.dropProfile.run(id).changes),
        }
        db.exec('COMMIT')
        return removed
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    /**
     * Новый диалог профиля. Потолок живых диалогов — в той же транзакции,
     * что вставка, и действует на любой путь создания: и на кнопку «Новый
     * диалог», и на первое сообщение без cookie сессии (ADR, п. 8.3).
     * Создание диалога — действие в профиле, поэтому срок профиля продлевает.
     */
    createSession({ profileId, topicId = null, at = now() }) {
      if (!stmt.profile.get(profileId, at - profileTtlMs)) return { ok: false, code: 'no_profile' }
      if (topicId !== null && !stmt.topicOfProfile.get(topicId, profileId)) {
        return { ok: false, code: 'unknown_topic' }
      }
      db.exec('BEGIN')
      try {
        if (stmt.countSessions.get(profileId, at - ttlMs).n >= sessionCap) {
          db.exec('ROLLBACK')
          return { ok: false, code: 'sessions_full' }
        }
        const id = randomUUID()
        stmt.addSession.run(id, at, at, profileId, topicId)
        stmt.touchProfile.run(at, profileId)
        db.exec('COMMIT')
        return { ok: true, id }
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    /** Живые диалоги профиля по убыванию активности. */
    sessionsOf(profileId, at = now()) {
      return stmt.liveSessions.all(profileId, at - ttlMs)
    },

    /**
     * Чей это диалог: идентификатор профиля, `null` у сессий дней 6–10 и
     * `undefined`, если сессии нет вовсе. Граница чтения чужой памяти:
     * сессия чужого профиля отвечает как несуществующая — 404.
     */
    sessionProfile(sessionId) {
      const row = stmt.sessionOwner.get(sessionId)
      return row ? (row.profileId ?? null) : undefined
    },

    stats() {
      return stmt.counts.get()
    },

    close() {
      db.close()
    },
  }
}
