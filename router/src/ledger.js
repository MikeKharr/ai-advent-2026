// Журнал расхода: JSONL только на дозапись, без промптов (ADR, п. 10).
// Суточные суммы восстанавливаются из журнала при старте, поэтому
// перезапуск роутера не обнуляет лимиты.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Начало следующих суток UTC — момент сброса лимитов. */
export function resetAt(ms) {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
}

export function createLedger({ file, now = Date.now }) {
  /** @type {Map<string, {tokens:number, costUsd:number, calls:number}>} ключ `день|приложение` */
  const sums = new Map()

  const add = (entry) => {
    const k = `${dayOf(Date.parse(entry.at))}|${entry.app}`
    const s = sums.get(k) ?? { tokens: 0, costUsd: 0, calls: 0 }
    s.tokens += entry.inputTokens + entry.outputTokens
    s.costUsd += entry.costUsd
    s.calls += 1
    sums.set(k, s)
  }

  if (file) {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          add(JSON.parse(line))
        } catch {
          // Оборванная последняя строка после падения — пропускаем, не падаем.
        }
      }
    }
  }

  return {
    record({
      app,
      taskClass,
      provider,
      model,
      inputTokens,
      outputTokens,
      costUsd,
      outcome,
      fallback,
    }) {
      const entry = {
        at: new Date(now()).toISOString(),
        app,
        taskClass,
        provider,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        outcome,
        fallback: Boolean(fallback),
      }
      if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`)
      add(entry)
      return entry
    },

    spent(app, at = now()) {
      return sums.get(`${dayOf(at)}|${app}`) ?? { tokens: 0, costUsd: 0, calls: 0 }
    },

    /** Все приложения за день — для /v1/spend. */
    report(at = now()) {
      const day = dayOf(at)
      const out = {}
      for (const [k, s] of sums) {
        const [d, app] = k.split('|')
        if (d === day) out[app] = { ...s, costUsd: round(s.costUsd) }
      }
      return { day, apps: out }
    },
  }
}

export function costUsd(price, usage) {
  if (!price) return 0
  return round(
    (usage.inputTokens / 1e6) * price.inputPerMTok +
      (usage.outputTokens / 1e6) * price.outputPerMTok,
  )
}

function round(x) {
  return Math.round(x * 1e6) / 1e6
}
