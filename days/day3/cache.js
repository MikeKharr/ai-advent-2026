// Кэш в памяти процесса. В дне 2 кэшируется только общая лента новостей:
// ответ модели зависит от параметров пользователя, и кэшировать его —
// значит прятать эффект параметров, ради которого день и сделан.

export function createCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {value: unknown, expires: number}>} */
  const store = new Map()
  /** @type {Map<string, Promise<unknown>>} Работы, уже выполняющиеся по этому ключу. */
  const inFlight = new Map()

  function evictExpired(t) {
    for (const [key, entry] of store) if (entry.expires <= t) store.delete(key)
  }

  return {
    /**
     * Одна работа на ключ. Без этого пять одновременных запросов дают
     * пять раундов загрузки лент: между чтением кэша и записью стоят await.
     */
    async once(key, work) {
      const running = inFlight.get(key)
      if (running) return running
      const promise = (async () => work())().finally(() => inFlight.delete(key))
      inFlight.set(key, promise)
      return promise
    },

    get(key) {
      const hit = store.get(key)
      if (!hit) return undefined
      if (hit.expires <= now()) {
        store.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key, value, ttlMs) {
      const t = now()
      evictExpired(t)
      store.set(key, { value, expires: t + ttlMs })
    },
  }
}
