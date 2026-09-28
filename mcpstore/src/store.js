// Состояние единицы `mcpstore` — SQLite через ВСТРОЕННЫЙ `node:sqlite`
// (ADR 2026-09-28-0736, п. 3). Пакета нет ни одного: правило «Node без
// runtime-зависимостей» (ADR 2026-09-07-1525) для этой единицы действует
// целиком, исключение ADR 2026-09-23-1227 распространяется только на `mcp/`.
// Отсюда и Node 24 в образе: там `node:sqlite` без флага.

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** Потолки — ADR, п. 3: 64 КБ на файл, 200 файлов, срок 30 часов. */
export const MAX_FILE_BYTES = 64 * 1024
export const MAX_FILES = 200
export const TTL_MS = 30 * 60 * 60 * 1000

/**
 * Имя файла — не путь. Каталогов у хранилища нет: имя это ключ строки в
 * таблице, и разделители в нём не значат ничего, кроме попытки притвориться
 * путём. Поэтому набор символов задан белым списком, а не запретом.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..')
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

export function createStore({ path = ':memory:', now = () => Date.now() } = {}) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      name TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_saved_at ON files(saved_at);
  `)

  const insert = db.prepare(
    `INSERT INTO files (name, content, bytes, sha256, saved_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, bytes = excluded.bytes,
       sha256 = excluded.sha256, saved_at = excluded.saved_at`,
  )
  const selectOne = db.prepare('SELECT * FROM files WHERE name = ?')
  const selectAll = db.prepare('SELECT name, bytes, sha256, saved_at FROM files ORDER BY name')
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM files')
  const deleteOld = db.prepare('DELETE FROM files WHERE saved_at < ?')

  /** Срок хранения — 30 часов. Уборка идёт ПЕРЕД каждой операцией, чтобы
   *  просроченный файл не читался и не занимал место в потолке. */
  function purge() {
    return deleteOld.run(now() - TTL_MS).changes
  }

  const row = (r) => ({
    name: r.name,
    bytes: r.bytes,
    sha256: r.sha256,
    savedAt: new Date(r.saved_at).toISOString(),
    expiresAt: new Date(r.saved_at + TTL_MS).toISOString(),
  })

  return {
    purge,

    save(name, content) {
      purge()
      if (!validName(name)) throw new Error('name: буквы, цифры, точка, дефис и подчёркивание, до 64 знаков')
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > MAX_FILE_BYTES) throw new Error(`content: больше ${MAX_FILE_BYTES} байт`)

      // Потолок числа файлов проверяется ДО записи и только для нового имени:
      // перезапись существующего числа файлов не меняет. Вытеснения нет
      // намеренно — молча терять чужой файл хуже, чем честно отказать.
      const exists = selectOne.get(name) !== undefined
      if (!exists && countAll.get().n >= MAX_FILES) {
        throw new Error(`хранилище заполнено: ${MAX_FILES} файлов`)
      }

      const at = now()
      insert.run(name, content, bytes, sha256(content), at)
      return { ...row({ name, bytes, sha256: sha256(content), saved_at: at }), replaced: exists }
    },

    read(name) {
      purge()
      if (!validName(name)) throw new Error('name: буквы, цифры, точка, дефис и подчёркивание, до 64 знаков')
      const found = selectOne.get(name)
      // «Нет файла» — не отказ: вызывающий спрашивал, есть ли он.
      if (found === undefined) return { found: false, name }
      return { found: true, ...row(found), content: found.content }
    },

    list() {
      purge()
      const files = selectAll.all().map(row)
      return { count: files.length, limit: MAX_FILES, files }
    },

    stats() {
      return { files: countAll.get().n, limit: MAX_FILES, ttlHours: TTL_MS / 3_600_000 }
    },

    close() {
      db.close()
    },
  }
}
