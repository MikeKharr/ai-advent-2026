// Хранилище статей: окно фиксированного размера на диске, переживает
// перезапуск контейнера. День 5 отличается от дня 3 именно этим — статьи
// накапливаются, а не перечитываются на каждый запрос.
//
// Окно общее на все источники, но у каждого есть гарантированная квота:
// TechCrunch даёт десятки статей в сутки, Pandaily — единицы, и без квоты
// плодовитые издания вытеснили бы регионы, ради которых список и собран
// (ADR 2026-09-07-2016).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dedupeKey } from './rss.js'

/**
 * Ключ записи — строка, а не объект: `dedupeKey` отдаёт `{ url, title }`,
 * и класть его в Map как есть значит сравнивать по ссылке на объект,
 * то есть не дедуплицировать вовсе.
 */
const keyOf = (item) => dedupeKey(item).url

export function createStore({
  file,
  capacity = 1000,
  sources = 8,
  now = Date.now,
  log = console.error,
}) {
  /** @type {Map<string, object>} ключ дедупликации → запись */
  let items = new Map()
  let lastRefresh = 0
  let skipped = 0

  const quota = Math.floor(capacity / Math.max(1, sources))

  function load() {
    if (!file || !existsSync(file)) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      lastRefresh = Number.isFinite(raw.lastRefresh) ? raw.lastRefresh : 0
      for (const item of raw.items ?? []) {
        if (!item?.url || !item?.date || !item?.title) {
          skipped += 1
          continue
        }
        items.set(keyOf(item), item)
      }
    } catch (error) {
      // Битый файл не должен мешать приложению подняться: начинаем с пустого
      // окна и говорим об этом в лог, а не роняем день целиком.
      log(`хранилище ${file}: ${error.message}; начинаем с пустого окна`)
      items = new Map()
    }
  }

  function save() {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    const payload = JSON.stringify({ version: 1, lastRefresh, items: all() })
    // Запись через временный файл: обрыв на середине не оставит битый JSON,
    // который потом придётся чинить руками.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, payload)
    renameSync(tmp, file)
  }

  /** Самые свежие первыми; порядок детерминирован — при равных датах по ссылке. */
  function all() {
    return [...items.values()].sort(
      (a, b) => Date.parse(b.date) - Date.parse(a.date) || (a.url < b.url ? -1 : 1),
    )
  }

  /**
   * Вытеснение до ёмкости. Сначала выбывают самые старые записи тех
   * источников, что вышли за квоту; если за квоту не вышел никто —
   * самые старые вообще.
   */
  function evict() {
    if (items.size <= capacity) return []
    const sorted = all()
    const counts = new Map()
    for (const item of sorted) counts.set(item.source, (counts.get(item.source) ?? 0) + 1)

    const dropped = []
    // Идём от самых старых: они первые кандидаты на выбывание.
    for (let i = sorted.length - 1; i >= 0 && items.size - dropped.length > capacity; i--) {
      const item = sorted[i]
      if ((counts.get(item.source) ?? 0) <= quota) continue
      counts.set(item.source, counts.get(item.source) - 1)
      dropped.push(item)
    }
    for (let i = sorted.length - 1; i >= 0 && items.size - dropped.length > capacity; i--) {
      const item = sorted[i]
      if (dropped.includes(item)) continue
      dropped.push(item)
    }
    for (const item of dropped) items.delete(keyOf(item))
    return dropped
  }

  return {
    load,
    save,
    all,
    size: () => items.size,
    lastRefresh: () => lastRefresh,
    skippedOnLoad: () => skipped,

    /**
     * Добавляет только те записи, которых в окне ещё нет. Возвращает,
     * сколько добавлено и сколько вытеснено: это и есть «проверяем
     * алгоритмически, нет ли новых» из задания.
     */
    add(incoming) {
      let added = 0
      // Заголовки проверяются наравне со ссылками: одна и та же новость
      // приходит под разными URL у агрегаторов (та же логика, что в dedupe).
      const titles = new Set()
      for (const item of items.values()) {
        const t = dedupeKey(item).title
        if (t) titles.add(t)
      }
      for (const item of incoming) {
        const key = keyOf(item)
        const title = dedupeKey(item).title
        if (items.has(key) || (title && titles.has(title))) continue
        items.set(key, item)
        if (title) titles.add(title)
        added += 1
      }
      const dropped = evict()
      if (added > 0 || dropped.length > 0) save()
      return { added, dropped: dropped.length }
    },

    markRefreshed() {
      lastRefresh = now()
      save()
    },

    /** Сколько записей у каждого источника — для панели состояния. */
    bySource() {
      const counts = {}
      for (const item of items.values()) counts[item.source] = (counts[item.source] ?? 0) + 1
      return counts
    },

    quota,
    capacity,
  }
}
