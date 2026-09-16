CREATE TABLE facts (
  session_id       TEXT PRIMARY KEY,
  text             TEXT NOT NULL,          -- '' после обрезанного первого вызова
  tokens           INTEGER NOT NULL,
  through_id       INTEGER NOT NULL,
  model            TEXT,
  limit_tokens     INTEGER NOT NULL,       -- лимит последнего вызова
  truncated_streak INTEGER NOT NULL DEFAULT 0,  -- обрезаний подряд; ≥ 2 — стоп
  updated_at       INTEGER NOT NULL
);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  text       TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  run_id     TEXT,
  meta       TEXT
, parent_id INTEGER);
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
, head_id INTEGER);
CREATE TABLE summaries (
  session_id    TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  tokens        INTEGER NOT NULL,
  source_tokens INTEGER NOT NULL,
  through_id    INTEGER NOT NULL,
  model         TEXT,
  truncated     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE summary_costs (
  session_id TEXT PRIMARY KEY,
  tokens     INTEGER NOT NULL
);
CREATE INDEX messages_by_session ON messages(session_id, id);
INSERT INTO "facts" ("session_id", "text", "tokens", "through_id", "model", "limit_tokens", "truncated_streak", "updated_at") VALUES ('10101010-1010-4010-8010-101010101010', '- пользователь спрашивает про раунды
- интересует Индия', 25, 10, 'claude-haiku-4-5', 600, 0, 1757000012000);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (1, '77777777-7777-4777-8777-777777777777', 'user', 'что нового в финтехе', 12, 1757000000000, NULL, NULL, NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (2, '77777777-7777-4777-8777-777777777777', 'agent', 'Вот дайджест по финтеху', 40, 1757000001000, 'run-7', '{"model":"claude-haiku-4-5","totalTokens":520}', NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (3, '77777777-7777-4777-8777-777777777777', 'agent', 'Модель не ответила: таймаут', 9, 1757000002000, NULL, '{"error":true}', NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (4, '99999999-9999-4999-8999-999999999999', 'user', 'расскажи про раунды', 20, 1757000003000, NULL, NULL, NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (5, '99999999-9999-4999-8999-999999999999', 'agent', 'Раунды за неделю: A, B, C', 60, 1757000004000, 'run-9', '{"model":"claude-haiku-4-5","totalTokens":1400}', NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (6, '99999999-9999-4999-8999-999999999999', 'user', 'а в Индии?', 11, 1757000005000, NULL, NULL, NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (7, '10101010-1010-4010-8010-101010101010', 'user', 'вопрос А', 10, 1757000007000, NULL, NULL, NULL);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (8, '10101010-1010-4010-8010-101010101010', 'agent', 'ответ А', 50, 1757000008000, 'run-10a', '{"model":"claude-haiku-4-5","totalTokens":900}', 7);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (9, '10101010-1010-4010-8010-101010101010', 'user', 'вопрос Б', 10, 1757000009000, NULL, NULL, 8);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (10, '10101010-1010-4010-8010-101010101010', 'agent', 'ответ Б', 55, 1757000010000, 'run-10b', '{"model":"claude-haiku-4-5","totalTokens":1100}', 9);
INSERT INTO "messages" ("id", "session_id", "role", "text", "tokens", "at", "run_id", "meta", "parent_id") VALUES (11, '10101010-1010-4010-8010-101010101010', 'user', 'вопрос В', 10, 1757000011000, NULL, NULL, 8);
INSERT INTO "sessions" ("id", "created_at", "last_seen_at", "head_id") VALUES ('77777777-7777-4777-8777-777777777777', 1757000000000, 1757000002000, NULL);
INSERT INTO "sessions" ("id", "created_at", "last_seen_at", "head_id") VALUES ('99999999-9999-4999-8999-999999999999', 1757000003000, 1757000006000, NULL);
INSERT INTO "sessions" ("id", "created_at", "last_seen_at", "head_id") VALUES ('10101010-1010-4010-8010-101010101010', 1757000007000, 1757000012000, 10);
INSERT INTO "summaries" ("session_id", "text", "tokens", "source_tokens", "through_id", "model", "truncated", "updated_at") VALUES ('99999999-9999-4999-8999-999999999999', 'Обсудили раунды недели и Индию', 30, 91, 5, 'claude-haiku-4-5', 0, 1757000006000);
INSERT INTO "summary_costs" ("session_id", "tokens") VALUES ('99999999-9999-4999-8999-999999999999', 300);
INSERT INTO "summary_costs" ("session_id", "tokens") VALUES ('10101010-1010-4010-8010-101010101010', 210);
