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

/** Сколько последних запусков хранится (ADR, п. 7). */
export const KEEP_RUNS = 50

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

  const insert = db.prepare(
    `INSERT INTO job_runs (id, job, utc_day, planned_at, started_at, status)
     VALUES (?, ?, ?, ?, ?, 'running')`,
  )
  const countDay = db.prepare('SELECT COUNT(*) AS n FROM job_runs WHERE job = ? AND utc_day = ?')
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
      return Number(countDay.get(job, utcDay(at)).n)
    },

    /** Идущий запуск этой работы или `null`. */
    running(job) {
      return selectRunning.get(job)?.id ?? null
    },

    /** Строка старта. Пишется ДО работы: иначе обрыв стёр бы след старта. */
    start({ id, job, plannedAt = null, at = now() }) {
      insert.run(id, job, utcDay(at), plannedAt, at)
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
