// Кэш в памяти процесса: лента, общая для всех сфер, и готовые дайджесты.
// Ключ дайджеста — нормализованная сфера и сутки, не пользователь (I-10).

export function createCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {value: unknown, expires: number}>} */
  const store = new Map()

  return {
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
      store.set(key, { value, expires: now() + ttlMs })
    },
    size() {
      return store.size
    },
  }
}

/** Приводит сферу к ключу: регистр и лишние пробелы не должны плодить вызовы API. */
export function sphereKey(sphere, now = new Date()) {
  const normalized = sphere.trim().toLowerCase().replace(/\s+/g, ' ')
  return `digest:${now.toISOString().slice(0, 10)}:${normalized}`
}
