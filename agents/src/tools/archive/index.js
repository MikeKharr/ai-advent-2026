// Инструмент «архив»: накопленное окно статей, обновление лент и отбор под
// запрос. Первый инструмент агента (ADR 2026-09-10-1000, п. 2): вещь с именем
// и контрактом, чтобы вызов был событием монитора, а не строкой в коде.
//
// Хранилище, ленты и отбор перенесены из дня 5 как есть; здесь только то,
// что делает их инструментом: имя, описание, состояние и один вызов `run`.

import { collectItems, FEEDS } from './feeds.js'
import { selectForQuery } from './select.js'
import { createStore } from './store.js'

export const ARCHIVE_TOOL = {
  name: 'archive',
  description:
    'Архив статей восьми изданий на сервере: обновляет ленты не чаще раза в ' +
    'несколько минут и отбирает статьи под тему и запрос.',
}

export function createArchiveTool({
  env,
  feeds = FEEDS,
  fetchImpl = fetch,
  now = Date.now,
  log = console.error,
}) {
  const store = createStore({
    file: env.STORE_FILE,
    capacity: env.WINDOW_SIZE,
    sources: feeds.length,
    maxAgeDays: env.MAX_AGE_DAYS,
    // Источник, убранный из списка лент, перестаёт существовать для агента
    // целиком: его статьи уходят из архива, а не лежат там навсегда.
    knownSources: feeds.map((f) => f.source),
    now,
    log,
  })
  store.load()
  store.prune()

  /** Одно обновление лент на процесс: параллельные запуски ждут первое. */
  let refreshing = null

  /**
   * Пополнение окна: ленты опрашиваются не чаще, чем раз в
   * `REFRESH_MIN_MINUTES`, и только по приходу запроса — фоновой
   * активности на пустом месте нет (решение владельца 2026-09-09).
   */
  async function refreshIfStale() {
    const at = now()
    const stale = at - store.lastRefresh() >= env.REFRESH_MIN_MINUTES * 60_000
    if (!stale) return { attempted: false, refreshed: false, added: 0, dropped: 0, failed: [] }
    if (refreshing) return refreshing

    refreshing = (async () => {
      try {
        const collected = await collectItems({ now: at, fetchImpl, feeds })
        const { added, dropped } = store.batch(() => {
          store.prune(at)
          const result = store.add(collected.items)
          // Отметка ставится и при неудаче части лент: иначе сломанная
          // лента заставляла бы ходить в сеть на каждый запрос.
          store.markRefreshed()
          return result
        })
        log(
          JSON.stringify({
            event: 'refresh',
            added,
            dropped,
            total: store.size(),
            failed: collected.failed.map((f) => f.source),
          }),
        )
        return { attempted: true, refreshed: true, added, dropped, failed: collected.failed }
      } catch (error) {
        log(`обновление окна: ${error.message}`)
        return { attempted: true, refreshed: false, added: 0, dropped: 0, failed: [] }
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  return {
    name: ARCHIVE_TOOL.name,

    describe() {
      return { ...ARCHIVE_TOOL, args: ['sphere', 'prompt', 'perSource', 'limit', 'maxChars'] }
    },

    /** Состояние для панели: размер, квота, последнее обновление. */
    state() {
      const last = store.lastRefresh()
      return {
        total: store.size(),
        capacity: store.capacity,
        quota: store.quota,
        bySource: store.bySource(),
        lastRefresh: last ? new Date(last).toISOString() : null,
        refreshEveryMinutes: env.REFRESH_MIN_MINUTES,
        sources: feeds.map((f) => ({ source: f.source, region: f.region })),
      }
    },

    /** Свежие статьи как есть — для оценки, сколько примет модель. */
    all: () => store.all(),
    size: () => store.size(),
    skippedOnLoad: () => store.skippedOnLoad(),

    /**
     * Один вызов инструмента: обновить окно, если пора, и отобрать статьи
     * под запрос. Пустой архив — не ошибка инструмента: решение, что с этим
     * делать, принимает агент.
     */
    async run({ sphere, prompt, perSource, limit, maxChars }) {
      const refresh = await refreshIfStale()
      const all = store.all()
      if (all.length === 0) return { refresh, total: 0, items: [], matched: 0 }
      const selection = selectForQuery(all, {
        sphere,
        prompt,
        perSource,
        limit,
        maxChars,
        now: now(),
      })
      return { refresh, total: all.length, items: selection.items, matched: selection.matched }
    },
  }
}
