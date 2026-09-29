// Журнал обращений поверхности управления (ADR 2026-09-28-1820, п. 2, ▲).
//
// СОСТАВ — решение владельца при приёмке ADR: «журнал обращений — с текстами,
// срок хранения 30 суток». Владелец изменил предложенный состав: п. 2 ADR
// писался под «без текстов» и после решения переписан не был. Реализовано по
// приёмке.
//
// Следствие, названное владельцем прямо: в журнале оседают ТЕКСТЫ СООБЩЕНИЙ
// ПОСЕТИТЕЛЕЙ. Значит, чувствительность у этого файла та же, что у
// `sessions.db`, и обязанности те же:
//   — наружу не показывать: операции чтения журнала нет и не будет;
//   — в ответы операций не выносить: ни одна строка `ops.js` его не читает;
//   — чистить по сроку: `prune` снимает строки старше 30 суток, и её зовёт
//     та же периодическая уборка, что чистит диалоги.
//
// Журнал — НЕ про деньги. Расход операций управления виден в сводке роутера
// по приложению `agents` суммой с днями 6–20 (ADR 2026-09-16-0907). Журнал
// держит другое: что через поверхность делали с профилями и кто стучался без
// ключа. Отказ пишется ТОЙ ЖЕ строкой, что успех, — иначе залп был бы виден
// только по отсутствию строк.
//
// Предъявленного значения ключа здесь нет и быть не может: его не принимает
// ни одна функция этого модуля.

import { DatabaseSync } from 'node:sqlite'

/** Ключ суток UTC: `2026-09-29`. Пояс контейнера этих суток не сдвигает. */
export function utcDay(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function createControlLog({ file, keepDays, now = Date.now }) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      op TEXT NOT NULL,
      outcome TEXT NOT NULL,
      ms INTEGER NOT NULL,
      paid INTEGER NOT NULL,
      profile_id TEXT,
      remote TEXT,
      texts TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS control_log_by_at ON control_log(at)')
  // Суточный счётчик платных вызовов — СВОЯ таблица, и уборка журнала её не
  // касается. Тот же довод, что у `job_starts` (ADR 2026-09-28-1323): счётчик
  // это денежная защита, и она не должна зависеть от политики хранения
  // журнала. На томе, а не в памяти: счётчик в памяти обнулялся бы каждой
  // выкаткой ровно тогда, когда выкаток много.
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_paid (
      utc_day TEXT PRIMARY KEY,
      calls INTEGER NOT NULL
    )
  `)

  const insert = db.prepare(
    `INSERT INTO control_log (at, op, outcome, ms, paid, profile_id, remote, texts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const pruneOld = db.prepare('DELETE FROM control_log WHERE at < ?')
  const bumpPaid = db.prepare(
    `INSERT INTO control_paid (utc_day, calls) VALUES (?, 1)
     ON CONFLICT(utc_day) DO UPDATE SET calls = calls + 1`,
  )
  const countPaid = db.prepare('SELECT calls FROM control_paid WHERE utc_day = ?')
  const prunePaid = db.prepare('DELETE FROM control_paid WHERE utc_day < ?')

  return {
    /**
     * Строка на каждый вызов — и на успех, и на отказ. `op` у отказа до
     * разбора пути равен `-`: имени операции ещё нет, а строка уже обязана
     * быть.
     *
     * `texts` — тексты аргументов операции, по решению владельца. Сюда
     * попадает только то, что операция объявила текстом в `ops.js`;
     * предъявленного ключа среди них нет ни у одной.
     */
    write({ at = now(), op, outcome, ms, paid = false, profileId = null, remote = null, texts = null }) {
      insert.run(
        at,
        op,
        outcome,
        Math.round(ms),
        paid ? 1 : 0,
        profileId,
        remote,
        texts === null ? null : JSON.stringify(texts),
      )
    },

    /** Платных вызовов поверхности за сутки UTC. Читается ДО вызова модели. */
    paidToday(at = now()) {
      return Number(countPaid.get(utcDay(at))?.calls ?? 0)
    },

    /** Занять слот платного вызова. Зовётся ДО вызова, а не после (I-4). */
    takePaidSlot(at = now()) {
      bumpPaid.run(utcDay(at))
      prunePaid.run(utcDay(at - keepDays * 24 * 3600_000))
    },

    /**
     * Уборка по сроку. Возвращает число снятых строк: молчаливая уборка
     * данных посетителей — это уборка, которую нечем проверить.
     */
    prune(at = now()) {
      const { changes } = pruneOld.run(at - keepDays * 24 * 3600_000)
      return Number(changes ?? 0)
    },

    close: () => db.close(),
  }
}
