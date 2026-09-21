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
import { PARAM_LIMITS, SUMMARIZE_LIMITS, TOPIC_FACT_CAP } from './params.js'
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
-- Столбец settings — настройки дня 11 и только они. Настройки дня 13 живут
-- в своём столбце settings_staged (решение владельца 2026-09-21, вариант «а»):
-- профиль общий, а потолки разные, и значение, годное дню 13 (контекст до
-- 32 000), день 11 принять не может — общий блок ломал бы сданный день
-- чужими действиями.

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
  if (!has('profiles', 'settings_staged')) {
    db.exec("ALTER TABLE profiles ADD COLUMN settings_staged TEXT NOT NULL DEFAULT '{}'")
  }
  moveStagedSettings(db)
}

/**
 * Настройки дня 13, попавшие в общий блок прежней реализацией, переезжают в
 * свой столбец. Правка одноразовая и самоограниченная: трогается только то,
 * что день 11 принять не может, — его собственные значения ниже своих
 * потолков остаются на месте (решение владельца 2026-09-21).
 */
function moveStagedSettings(db) {
  const rows = db.prepare('SELECT id, settings, settings_staged FROM profiles').all()
  const update = db.prepare('UPDATE profiles SET settings = ?, settings_staged = ? WHERE id = ?')
  for (const row of rows) {
    let shared
    let staged
    try {
      shared = JSON.parse(row.settings || '{}')
      staged = JSON.parse(row.settings_staged || '{}')
    } catch {
      continue
    }
    if (!shared || typeof shared !== 'object' || Array.isArray(shared)) continue
    let moved = false
    const take = (key, alien) => {
      if (shared[key] === undefined || !alien(shared[key])) return
      if (staged[key] === undefined) staged[key] = shared[key]
      delete shared[key]
      moved = true
    }
    take('reviewModel', () => true)
    take('reviewRounds', () => true)
    take('contextTokens', (v) => Number(v) > PARAM_LIMITS.contextTokens)
    take('summarizeAt', (v) => Number(v) > SUMMARIZE_LIMITS.max)
    if (moved) update.run(JSON.stringify(shared), JSON.stringify(staged), row.id)
  }
}

export function createSessions({
  file,
  ttlMs,
  // Профиль живёт дольше своих диалогов, потолки — временные рабочие
  // значения решения владельца 8 (ADR 2026-09-15-2024).
  profileTtlMs = 30 * 24 * 3600_000,
  profileCap = 5,
  sessionCap = 20,
  // Потолки слоёв памяти профиля — временные рабочие значения решения
  // владельца 8 (ADR 2026-09-15-2024, пп. 4 и 6.1): тем на профиль, фактов в
  // теме, правил на профиль и припаркованных фактов неотвеченного
  // предложения. Сверх потолка не пишется ничего, вытеснения нет.
  topicCap = 30,
  topicFactCap = TOPIC_FACT_CAP,
  ruleCap = 40,
  parkedFactCap = 24,
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
    updateMeta: db.prepare('UPDATE messages SET meta = ? WHERE id = ? AND session_id = ?'),
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
      `SELECT id, name, settings, settings_staged AS settingsStaged,
              created_at AS createdAt, last_seen_at AS lastSeenAt
         FROM profiles WHERE id = ? AND last_seen_at >= ?`,
    ),
    touchProfile: db.prepare('UPDATE profiles SET last_seen_at = ? WHERE id = ?'),
    saveSettings: db.prepare('UPDATE profiles SET settings = ?, last_seen_at = ? WHERE id = ?'),
    saveStagedSettings: db.prepare(
      'UPDATE profiles SET settings_staged = ?, last_seen_at = ? WHERE id = ?',
    ),
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
    topicOfProfile: db.prepare('SELECT id, title FROM topics WHERE id = ? AND profile_id = ?'),

    // --- Слои памяти профиля: темы, факты тем, правила (ADR, пп. 4 и 6) ---
    titlesOfProfile: db.prepare('SELECT id, title FROM topics WHERE profile_id = ?'),
    addTopic: db.prepare(
      'INSERT INTO topics (profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ),
    touchTopic: db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?'),
    countTopics: db.prepare('SELECT count(*) AS n FROM topics WHERE profile_id = ?'),
    addTopicFact: db.prepare(
      'INSERT INTO topic_facts (topic_id, text, source_session_id, at) VALUES (?, ?, ?, ?)',
    ),
    countTopicFacts: db.prepare('SELECT count(*) AS n FROM topic_facts WHERE topic_id = ?'),
    // Последние факты темы — от свежих: порядок переворачивает вызывающий.
    lastTopicFacts: db.prepare(
      `SELECT id, text, source_session_id AS sourceSessionId, at
         FROM topic_facts WHERE topic_id = ? ORDER BY id DESC LIMIT ?`,
    ),
    countRules: db.prepare('SELECT count(*) AS n FROM personalization WHERE profile_id = ?'),
    hasRule: db.prepare('SELECT 1 AS yes FROM personalization WHERE profile_id = ? AND key = ?'),
    saveRule: db.prepare(
      `INSERT INTO personalization (profile_id, key, value, source_session_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET
         value = excluded.value, source_session_id = excluded.source_session_id,
         updated_at = excluded.updated_at`,
    ),
    sessionState: db.prepare(
      `SELECT s.profile_id AS profileId, s.topic_id AS topicId, s.pending_topic AS pendingTopic,
              t.title AS topicTitle
         FROM sessions s LEFT JOIN topics t ON t.id = s.topic_id
        WHERE s.id = ?`,
    ),
    setTopic: db.prepare('UPDATE sessions SET topic_id = ? WHERE id = ?'),
    setPending: db.prepare('UPDATE sessions SET pending_topic = ? WHERE id = ?'),

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

  /**
   * Ожидающее предложение темы из столбца `pending_topic`. Битый JSON не
   * должен запирать диалог вопросом, на который нельзя ответить: считаем,
   * что предложения нет, — факты пары тогда уйдут в активную тему.
   */
  const parsePending = (raw) => {
    if (!raw) return null
    try {
      const value = JSON.parse(raw)
      if (!value || typeof value.title !== 'string') return null
      return {
        title: value.title,
        facts: Array.isArray(value.facts) ? value.facts.filter((f) => typeof f === 'string') : [],
        at: value.at ?? null,
        messageId: value.messageId ?? null,
      }
    } catch {
      log('ожидающее предложение темы не разобрано')
      return null
    }
  }

  /**
   * Тема профиля по названию без учёта регистра. Сравнение в JS, а не в SQL:
   * `LOWER()` у SQLite работает только по ASCII, и «Финтех» с «финтех» разошлись
   * бы в две темы.
   */
  const findTopicByTitle = (profileId, title) => {
    const wanted = String(title).trim().toLocaleLowerCase('ru')
    for (const row of stmt.titlesOfProfile.all(profileId)) {
      if (row.title.toLocaleLowerCase('ru') === wanted) return { id: row.id, title: row.title }
    }
    return null
  }

  /** Тема по названию или новая. Сверх потолка тема не заводится. */
  const openTopic = (profileId, title, at) => {
    const known = findTopicByTitle(profileId, title)
    if (known) return known
    if (stmt.countTopics.get(profileId).n >= topicCap) return { full: true }
    const id = Number(stmt.addTopic.run(profileId, title, at, at).lastInsertRowid)
    return { id, title }
  }

  /** Факты в тему с её потолком: сверх него не пишется, вытеснения нет. */
  const writeFacts = (topicId, facts, sessionId, at) => {
    let room = Math.max(0, topicFactCap - stmt.countTopicFacts.get(topicId).n)
    let written = 0
    for (const text of facts) {
      if (room === 0) break
      stmt.addTopicFact.run(topicId, text, sessionId, at)
      room -= 1
      written += 1
    }
    if (written > 0) stmt.touchTopic.run(at, topicId)
    return { written, dropped: facts.length - written }
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

    append({
      sessionId,
      role,
      text,
      tokens,
      runId = null,
      meta = null,
      parentId = null,
      at = now(),
      onlyIfLive = false,
    }) {
      // `touch` создаёт строку сессии, если её нет, — для дней 6–10 это и есть
      // «сессия начинается первым сообщением». Диалогу профиля так нельзя:
      // запись в сессию, удалённую вместе с профилем, воскресила бы её строку
      // с `profile_id` NULL, и обещание «удаление без следа» (ADR
      // 2026-09-15-2024, п. 2) держалось бы только до следующего ответа.
      if (onlyIfLive && !stmt.hasSession.get(sessionId)) return null
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

    /**
     * Сводка у сообщения — заново. Нужна дню 13: ответ пишется на этапе
     * «Проверка», а число пройденных этапов известно только на «Выдаче»
     * (ADR 2026-09-21-1747, п. 1). Сообщение обязано принадлежать этой
     * сессии: номера в базе сквозные, и без проверки правка задевала бы
     * чужую переписку. Очищенный диалог правится в ноль строк — это и есть
     * «ничего не воскресло».
     */
    updateMessageMeta({ sessionId, messageId, meta }) {
      const info = stmt.updateMeta.run(meta ? JSON.stringify(meta) : null, messageId, sessionId)
      return Number(info.changes) > 0
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
      // Возвращаемое число — убранные сессии, все до одной: журнал сервиса
      // читает его как «сколько диалогов исчезло», и диалоги, ушедшие внутри
      // удаления профиля, исчезли не меньше прочих.
      let removed = 0
      for (const row of stmt.staleProfiles.all(at - profileTtlMs)) {
        removed += this.deleteProfile(row.id)?.sessions ?? 0
      }
      const cutoff = at - ttlMs
      const stale = stmt.stale.all(cutoff)
      for (const row of stale) this.clear(row.id)
      removed += stale.length
      // Сессия, чей профиль удалён в обход `deleteProfile` (оборвавшаяся
      // транзакция, правка базы руками), уходит целиком, а не строкой.
      for (const row of stmt.orphanProfileSessions.all()) {
        this.clear(row.id)
        removed += 1
      }
      stmt.orphanMessages.run()
      stmt.orphanSummaries.run()
      stmt.orphanFacts.run()
      stmt.orphanCosts.run()
      stmt.orphanRules.run()
      stmt.orphanTopics.run()
      // Факты тем — после тем: осиротевшая тема сначала должна исчезнуть.
      stmt.orphanTopicFacts.run()
      return removed
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
      let stagedSettings = {}
      try {
        settings = row.settings ? JSON.parse(row.settings) : {}
      } catch {
        // Порченые настройки не должны прятать профиль целиком: остальная
        // память посетителю нужнее, а окно настроек перезапишет их.
        log(`настройки профиля ${id.slice(0, 8)}… не разобраны`)
      }
      try {
        stagedSettings = row.settingsStaged ? JSON.parse(row.settingsStaged) : {}
      } catch {
        log(`настройки дня 13 профиля ${id.slice(0, 8)}… не разобраны`)
      }
      const sessions = stmt.liveSessions.all(id, at - ttlMs)
      return {
        id: row.id,
        name: row.name,
        settings,
        // Настройки дня 13 — отдельным полем: день 11 читает `settings` и
        // значений, которых не умеет принять, в нём не встречает.
        stagedSettings,
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
     * Настройки дня 13 — в свой столбец, не в общий блок дня 11
     * (ADR 2026-09-21-1747 и решение владельца 2026-09-21, вариант «а»).
     * Два столбца пишутся врозь и не затирают друг друга.
     */
    saveStagedSettings({ profileId, settings, at = now() }) {
      if (!stmt.profile.get(profileId, at - profileTtlMs)) return false
      stmt.saveStagedSettings.run(JSON.stringify(settings), at, profileId)
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
      // Срок здесь не проверяется намеренно (нулевая граница), в отличие от
      // чтения: истёкший, но ещё не убранный профиль обязан удаляться — этим
      // же оператором его уносит `sweep`. Цена — рассогласование кодов на
      // окне между истечением и уборкой: чтение отдаёт 404, удаление 200.
      // Данные при этом в обоих случаях уходят, и это важнее симметрии.
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

    // --- Слои памяти профиля: чтение (ADR 2026-09-15-2024, пп. 4 и 6) -----
    // Слои отдаются как данные; что из них уйдёт модели, решает политика
    // (`context.js`), а не хранилище.

    /** Правила профиля, от свежих к старым. */
    rulesOf(profileId) {
      return stmt.rules.all(profileId)
    },

    /** Темы профиля с числом фактов, от свежих к старым. */
    topicsOf(profileId) {
      return stmt.topics.all(profileId)
    },

    /** Последние `limit` фактов темы, от старых к свежим. */
    topicFactsOf(topicId, limit) {
      return stmt.lastTopicFacts.all(topicId, limit).reverse()
    },

    /** Тема профиля или null — граница чтения чужой темы. */
    topicOf(profileId, topicId) {
      const row = stmt.topicOfProfile.get(topicId, profileId)
      return row ? { id: row.id, title: row.title } : null
    },

    /**
     * Состояние диалога дня 11: чей он, какая тема активна и ждёт ли ответа
     * предложение новой темы. `null`, если сессии нет вовсе.
     */
    sessionState(sessionId) {
      const row = stmt.sessionState.get(sessionId)
      if (!row) return null
      return {
        profileId: row.profileId ?? null,
        topicId: row.topicId ?? null,
        topicTitle: row.topicTitle ?? null,
        pending: parsePending(row.pendingTopic),
      }
    },

    /**
     * Дельта вызова пополнения в память профиля — одной транзакцией
     * (ADR 2026-09-15-2024, пп. 5.2 и 6.2). Что решать — дело политики и
     * модели; здесь только запись с её правилами: потолки слоёв, парковка
     * фактов до ответа человека и гонка с удалением.
     *
     * Пишется, только если живы и диалог (реплика `aliveId` на месте), и
     * профиль: вызов идёт секунды, и за это время профиль могли удалить —
     * тогда в память не попадает ничего, а цена вызова не воскрешает строк.
     */
    rememberLayers({
      sessionId,
      profileId,
      aliveId,
      topic = { kind: 'continue' },
      facts = [],
      rules = [],
      spentTokens = 0,
      at = now(),
    }) {
      if (!stmt.hasMessage.get(aliveId, sessionId)) return { ok: false, code: 'session_gone' }
      if (!stmt.profile.get(profileId, at - profileTtlMs)) return { ok: false, code: 'profile_gone' }
      const state = this.sessionState(sessionId)
      if (!state || state.profileId !== profileId) return { ok: false, code: 'session_gone' }

      db.exec('BEGIN')
      try {
        const report = {
          ok: true,
          topicId: state.topicId,
          topicTitle: state.topicTitle,
          switched: null,
          proposal: null,
          waiting: false,
          pending: null,
          factsWritten: 0,
          factsParked: 0,
          rulesWritten: 0,
          warnings: [],
        }
        const pending = state.pending
        let decision = topic.kind
        // Пока предложение ждёт ответа, самостоятельных переходов нет: руль у
        // человека, и его ответ решит всё разом (ADR, п. 6.2).
        if (pending && decision !== 'open' && decision !== 'reject') decision = 'wait'
        // Отвечать нечего — «открыть» и «отклонить» читаются как «продолжить».
        if (!pending && (decision === 'open' || decision === 'reject')) decision = 'continue'

        /** Факты в тему с её потолком; тема становится активной у диалога. */
        const store = (target, list) => {
          report.topicId = target.id
          report.topicTitle = target.title
          const { written, dropped } = writeFacts(target.id, list, sessionId, at)
          report.factsWritten += written
          if (dropped > 0) {
            report.warnings.push({ code: 'topic_facts_full', dropped, cap: topicFactCap })
          }
        }
        /** Активной темы нет — факты не записываются никуда (ADR, п. 6.2.4). */
        const intoActive = (list) => {
          if (state.topicId) return store({ id: state.topicId, title: state.topicTitle }, list)
          if (list.length > 0) report.warnings.push({ code: 'no_topic', dropped: list.length })
        }
        const switchTo = (target, by) => {
          stmt.setTopic.run(target.id, sessionId)
          report.switched = { from: state.topicTitle, to: target.title, by }
        }

        if (decision === 'wait') {
          const room = Math.max(0, parkedFactCap - pending.facts.length)
          const added = facts.slice(0, room)
          if (added.length < facts.length) {
            report.warnings.push({
              code: 'parked_full',
              dropped: facts.length - added.length,
              cap: parkedFactCap,
            })
          }
          const next = { ...pending, facts: [...pending.facts, ...added] }
          stmt.setPending.run(JSON.stringify(next), sessionId)
          report.factsParked = added.length
          report.waiting = true
          report.pending = { title: pending.title, facts: next.facts.length }
        } else if (decision === 'open' || decision === 'reject') {
          // Ответ человека репликой: припаркованное и факты этой пары уходят
          // вместе — одним решением, как и кнопкой (ADR, п. 6.2.3).
          const all = [...pending.facts, ...facts]
          stmt.setPending.run(null, sessionId)
          if (decision === 'reject') {
            intoActive(all)
          } else {
            const opened = openTopic(profileId, pending.title, at)
            if (opened.full) {
              report.warnings.push({ code: 'topics_full', cap: topicCap, title: pending.title })
              intoActive(all)
            } else {
              switchTo(opened, 'answer')
              store(opened, all)
            }
          }
        } else if (decision === 'existing') {
          // Чужой или несуществующий идентификатор — как «продолжить».
          const target = this.topicOf(profileId, topic.id)
          if (!target) intoActive(facts)
          else {
            switchTo(target, 'model')
            store(target, facts)
          }
        } else if (decision === 'propose') {
          // Название существующей темы — переход к ней, а не вопрос.
          const known = findTopicByTitle(profileId, topic.title)
          if (known) {
            switchTo(known, 'model')
            store(known, facts)
          } else {
            const parked = facts.slice(0, parkedFactCap)
            if (parked.length < facts.length) {
              report.warnings.push({
                code: 'parked_full',
                dropped: facts.length - parked.length,
                cap: parkedFactCap,
              })
            }
            stmt.setPending.run(
              JSON.stringify({ title: topic.title, facts: parked, at }),
              sessionId,
            )
            report.factsParked = parked.length
            report.proposal = { title: topic.title, facts: parked.length }
            report.pending = { title: topic.title, facts: parked.length }
          }
        } else {
          intoActive(facts)
        }

        // Правила: имя уникально в профиле, новое значение заменяет прежнее;
        // сверх потолка новые имена не заводятся (ADR, п. 4).
        let room = Math.max(0, ruleCap - stmt.countRules.get(profileId).n)
        let rulesDropped = 0
        for (const rule of rules) {
          const known = Boolean(stmt.hasRule.get(profileId, rule.key))
          if (!known && room === 0) {
            rulesDropped += 1
            continue
          }
          stmt.saveRule.run(profileId, rule.key, rule.value, sessionId, at)
          if (!known) room -= 1
          report.rulesWritten += 1
        }
        if (rulesDropped > 0) {
          report.warnings.push({ code: 'rules_full', dropped: rulesDropped, cap: ruleCap })
        }

        // Пополнение памяти — действие в профиле: срок всей его памяти идёт
        // от него (ADR, п. 2). Цена вызова — в ту же сумму «вызовы памяти».
        stmt.touchProfile.run(at, profileId)
        this.touch(sessionId, at)
        stmt.addCost.run(sessionId, Math.max(0, Math.round(spentTokens)))
        db.exec('COMMIT')
        return report
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    /**
     * Ответ человека на предложение темы и ручная смена темы — одна операция
     * (ADR 2026-09-15-2024, п. 6.2.3): `open` уносит припаркованные факты в
     * новую тему, `continue` — в активную, `topicId` меняет тему без вопроса.
     * Вызовов модели здесь нет, поэтому и цены нет.
     */
    resolveTopic({ sessionId, profileId, decision = null, topicId = undefined, at = now() }) {
      if (!stmt.profile.get(profileId, at - profileTtlMs)) {
        return { ok: false, code: 'unknown_profile' }
      }
      const state = this.sessionState(sessionId)
      if (!state || state.profileId !== profileId) return { ok: false, code: 'unknown_session' }
      if (topicId !== undefined) {
        // Ручной выбор: человек решил сам, вопроса нет. `null` — «без темы».
        const target = topicId === null ? null : this.topicOf(profileId, topicId)
        if (topicId !== null && !target) return { ok: false, code: 'unknown_topic' }
        db.exec('BEGIN')
        try {
          const report = {
            ok: true,
            topicId: target ? target.id : null,
            topicTitle: target ? target.title : null,
            switched: { from: state.topicTitle, to: target ? target.title : null, by: 'human' },
            factsWritten: 0,
            warnings: [],
          }
          // Выбор темы рукой — ответ и на висящий вопрос: оставить предложение
          // живым значило бы, что агент дальше не переходит сам и паркует
          // факты в предмет, от которого человек уже ушёл (ревьюер, PR #153).
          const parked = state.pending?.facts ?? []
          if (state.pending) stmt.setPending.run(null, sessionId)
          stmt.setTopic.run(target ? target.id : null, sessionId)
          if (parked.length > 0) {
            if (target) {
              const { written, dropped } = writeFacts(target.id, parked, sessionId, at)
              report.factsWritten = written
              if (dropped > 0) {
                report.warnings.push({ code: 'topic_facts_full', dropped, cap: topicFactCap })
              }
            } else {
              report.warnings.push({ code: 'no_topic', dropped: parked.length })
            }
          }
          stmt.touchProfile.run(at, profileId)
          db.exec('COMMIT')
          return report
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
      if (decision !== 'open' && decision !== 'continue') return { ok: false, code: 'bad_decision' }
      if (!state.pending) return { ok: false, code: 'no_pending' }

      db.exec('BEGIN')
      try {
        const report = {
          ok: true,
          topicId: state.topicId,
          topicTitle: state.topicTitle,
          switched: null,
          factsWritten: 0,
          warnings: [],
        }
        const parked = state.pending.facts
        stmt.setPending.run(null, sessionId)
        const into = (target) => {
          const { written, dropped } = writeFacts(target.id, parked, sessionId, at)
          report.topicId = target.id
          report.topicTitle = target.title
          report.factsWritten = written
          if (dropped > 0) {
            report.warnings.push({ code: 'topic_facts_full', dropped, cap: topicFactCap })
          }
        }
        if (decision === 'open') {
          const opened = openTopic(profileId, state.pending.title, at)
          if (opened.full) {
            report.warnings.push({ code: 'topics_full', cap: topicCap, title: state.pending.title })
            if (state.topicId) into({ id: state.topicId, title: state.topicTitle })
            else if (parked.length > 0) {
              report.warnings.push({ code: 'no_topic', dropped: parked.length })
            }
          } else {
            stmt.setTopic.run(opened.id, sessionId)
            report.switched = { from: state.topicTitle, to: opened.title, by: 'human' }
            into(opened)
          }
        } else if (state.topicId) {
          into({ id: state.topicId, title: state.topicTitle })
        } else if (parked.length > 0) {
          report.warnings.push({ code: 'no_topic', dropped: parked.length })
        }
        stmt.touchProfile.run(at, profileId)
        db.exec('COMMIT')
        return report
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    stats() {
      return stmt.counts.get()
    },

    close() {
      db.close()
    },
  }
}
