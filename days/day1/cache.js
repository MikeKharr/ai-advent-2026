// Кэш в памяти процесса: лента, общая для всех сфер, и готовые дайджесты.
// Ключ дайджеста — нормализованная сфера и сутки, не пользователь (I-10).

export function createCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {value: unknown, expires: number}>} */
  const store = new Map()
  /** @type {Map<string, Promise<unknown>>} Работы, уже выполняющиеся по этому ключу. */
  const inFlight = new Map()

  /** Убирает просроченное: ключи дайджестов уникальны и повторно не читаются. */
  function evictExpired(t) {
    for (const [key, entry] of store) if (entry.expires <= t) store.delete(key)
  }

  return {
    /**
     * Одна работа на ключ. Без этого пять одновременных запросов на одну
     * сферу дают пять вызовов API и пять раундов загрузки лент: между
     * чтением кэша и записью в него стоят await.
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

/** Приводит сферу к ключу: регистр и лишние пробелы не должны плодить вызовы API. */
export function sphereKey(sphere, now = new Date()) {
  const normalized = sphere.trim().toLowerCase().replace(/\s+/g, ' ')
  return `digest:${now.toISOString().slice(0, 10)}:${normalized}`
}
