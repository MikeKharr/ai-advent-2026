// Запуски планировщика на томе: `jobs.db`, свой файл рядом с `sessions.db`
// (ADR 2026-09-28-0736, п. 6 и 7). Отдельный файл — чтобы миграции дней 7–15
// и 30-часовая уборка диалогов не задевали сводки, а сводки не задевали их.
//
// Почему не в памяти, как запуски дней 6–15: счётчик стартов за сутки — это
// денежная защита. Счётчик в памяти обнулялся бы каждой выкаткой, и потолок
// «6 стартов в сутки» переставал бы что-либо значить ровно тогда, когда
// выкаток много. Поэтому и счётчик, и сами сводки живут на томе.
//
// Сутки — UTC ПО ПОСТРОЕНИЮ: день считается `getUTC*`, а не форматтером
// локали. Пояс контейнера сдвинуть эти сутки не может, даже если кто-то
// поменяет `TZ`.

import { DatabaseSync } from 'node:sqlite'

/** Сколько последних запусков хранится (ADR, п. 7). Это ЛЕНТА сводок. */
export const KEEP_RUNS = 50

/**
 * Сколько суток хранится счётчик стартов. К ленте отношения не имеет: строка
 * на работу в сутки, и срок здесь — только чтобы таблица не росла вечно.
 */
export const STARTS_KEEP_DAYS = 7

/** Ключ суток UTC: `2026-09-28`. */
export function utcDay(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function createJobStore({ file, now = Date.now }) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job TEXT NOT NULL,
      utc_day TEXT NOT NULL,
      planned_at INTEGER,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      summary TEXT,
      trace TEXT,
      tokens INTEGER,
      budget_left REAL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS job_runs_by_day ON job_runs(job, utc_day)')
  // Суточный счётчик стартов — СВОЯ таблица, и уборка ленты сводок её не
  // касается. Пока он считался строками `job_runs`, денежная защита зависела
  // от политики хранения: `pruneOld` оставляет 50 последних строк по всем
  // работам сразу, поэтому потолок выше 50 был неисполним, а при нескольких
  // работах счётчик каждой занижался чужими стартами (находка гейта, PR #234).
  // Отдельная таблица делает эту связь ненужной, а не выражает её проверкой:
  // проверку можно снять и не заметить, а таблицу уборка не видит вовсе.
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_starts (
      job TEXT NOT NULL,
      utc_day TEXT NOT NULL,
      starts INTEGER NOT NULL,
      PRIMARY KEY (job, utc_day)
    )
  `)

  const insert = db.prepare(
    `INSERT INTO job_runs (id, job, utc_day, planned_at, started_at, status)
     VALUES (?, ?, ?, ?, ?, 'running')`,
  )
  const bumpStarts = db.prepare(
    `INSERT INTO job_starts (job, utc_day, starts) VALUES (?, ?, 1)
     ON CONFLICT(job, utc_day) DO UPDATE SET starts = starts + 1`,
  )
  const countDay = db.prepare('SELECT starts FROM job_starts WHERE job = ? AND utc_day = ?')
  // Счётчик старых суток никому не нужен, но и удалять его вместе с лентой
  // нельзя: срез по времени, а не по числу строк, и текущие сутки он не
  // трогает ни при каком числе работ.
  const pruneStarts = db.prepare('DELETE FROM job_starts WHERE utc_day < ?')
  const selectRunning = db.prepare(
    "SELECT id FROM job_runs WHERE job = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
  )
  const finishRun = db.prepare(
    `UPDATE job_runs SET finished_at = ?, status = ?, summary = ?, trace = ?, tokens = ?, budget_left = ?
     WHERE id = ?`,
  )
  const markInterrupted = db.prepare(
    "UPDATE job_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
  )
  const selectRecent = db.prepare(
    'SELECT * FROM job_runs WHERE job = ? ORDER BY started_at DESC LIMIT ?',
  )
  const pruneOld = db.prepare(
    `DELETE FROM job_runs WHERE id NOT IN
       (SELECT id FROM job_runs ORDER BY started_at DESC LIMIT ?)`,
  )

  return {
    /**
     * Запуск, оборванный выкаткой, остаётся в базе со статусом `running` и
     * висел бы так вечно, занимая «работа идёт». Помечается один раз на
     * старте процесса (ADR, разбор вопроса 2): повтора нет, следующий срок
     * придёт по расписанию.
     */
    markInterruptedOnStart() {
      const { changes } = markInterrupted.run(now())
      return Number(changes ?? 0)
    },

    /** Стартов этой работы за сутки UTC. Читается ДО решения о запуске. */
    startsToday(job, at = now()) {
      return Number(countDay.get(job, utcDay(at))?.starts ?? 0)
    },

    /** Идущий запуск этой работы или `null`. */
    running(job) {
      return selectRunning.get(job)?.id ?? null
    },

    /** Строка старта. Пишется ДО работы: иначе обрыв стёр бы след старта. */
    start({ id, job, plannedAt = null, at = now() }) {
      const day = utcDay(at)
      // Счётчик растёт первым: строку ленты уборка может снять, счётчик — нет.
      bumpStarts.run(job, day)
      pruneStarts.run(utcDay(at - STARTS_KEEP_DAYS * 24 * 3600_000))
      insert.run(id, job, day, plannedAt, at)
      return id
    },

    finish({ id, status, summary = null, trace = null, tokens = null, budgetLeftUsd = null, at = now() }) {
      finishRun.run(
        at,
        status,
        summary,
        trace === null ? null : JSON.stringify(trace),
        tokens,
        budgetLeftUsd,
        id,
      )
      pruneOld.run(KEEP_RUNS)
    },

    /** Последние запуски работы в виде, который отдаёт ручка сводок. */
    recent(job, limit = KEEP_RUNS) {
      return selectRecent.all(job, limit).map((row) => ({
        id: row.id,
        startedAt: new Date(row.started_at).toISOString(),
        finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
        status: row.status,
        summary: row.summary,
        tokens: row.tokens,
        budgetLeftUsd: row.budget_left,
        trace: parseTrace(row.trace),
      }))
    },

    close: () => db.close(),
  }
}

/** Битый JSON трейса не должен ронять всю ленту: у такой сводки трейс пуст. */
function parseTrace(raw) {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
