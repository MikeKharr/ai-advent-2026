// Журнал расхода: JSONL только на дозапись, без промптов (ADR, п. 10).
// Суточные и месячные суммы восстанавливаются из журнала при старте,
// поэтому перезапуск роутера не обнуляет лимиты.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function monthOf(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Начало следующих суток UTC — момент сброса лимитов. */
export function resetAt(ms) {
  const d = new Date(ms);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  ).toISOString();
}

const EMPTY = () => ({ tokens: 0, costUsd: 0, calls: 0 });

export function createLedger({ file, now = Date.now }) {
  /**
   * Ключ `период|приложение`, период — день или месяц. Внутри — итог и
   * разбивки по классам и провайдерам.
   * @type {Map<string, {total:object, byClass:object, byProvider:object}>}
   */
  const sums = new Map();
  let skipped = 0;

  const bumpInto = (s, entry) => {
    s.tokens += entry.inputTokens + entry.outputTokens;
    s.costUsd += entry.costUsd;
    s.calls += 1;
  };
  const bump = (k, entry) => {
    if (!sums.has(k))
      sums.set(k, { total: EMPTY(), byClass: {}, byProvider: {} });
    const s = sums.get(k);
    bumpInto(s.total, entry);
    bumpInto((s.byClass[entry.taskClass] ??= EMPTY()), entry);
    bumpInto((s.byProvider[entry.provider] ??= EMPTY()), entry);
  };
  const add = (entry) => {
    const at = Date.parse(entry.at);
    bump(`${dayOf(at)}|${entry.app}`, entry);
    bump(`${monthOf(at)}|${entry.app}`, entry);
  };

  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          add(JSON.parse(line));
        } catch {
          // Оборванная последняя строка после падения — пропускаем, но считаем:
          // порча файла должна быть видна в стартовом логе.
          skipped += 1;
        }
      }
    }
  }

  const rounded = (s) => ({ ...s, costUsd: round(s.costUsd) });
  const view = (s) => ({
    ...rounded(s.total),
    byClass: Object.fromEntries(
      Object.entries(s.byClass).map(([k, v]) => [k, rounded(v)]),
    ),
    byProvider: Object.fromEntries(
      Object.entries(s.byProvider).map(([k, v]) => [k, rounded(v)]),
    ),
  });

  return {
    record({
      app,
      taskClass,
      provider,
      model,
      thinking,
      inputTokens,
      outputTokens,
      webSearches = 0,
      costUsd,
      outcome,
      fallback,
      estimated = false,
    }) {
      const entry = {
        at: new Date(now()).toISOString(),
        app,
        taskClass,
        provider,
        model,
        thinking,
        inputTokens,
        outputTokens,
        webSearches,
        costUsd,
        outcome,
        fallback: Boolean(fallback),
        estimated,
      };
      if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
      add(entry);
      return entry;
    },

    spent(app, at = now()) {
      return sums.get(`${dayOf(at)}|${app}`)?.total ?? EMPTY();
    },

    /** Все приложения за день и за месяц, по классам и провайдерам — для /v1/spend. */
    report(at = now()) {
      const day = dayOf(at);
      const month = monthOf(at);
      const out = { day, month, apps: {}, monthly: {} };
      for (const [k, s] of sums) {
        const [period, app] = k.split("|");
        if (period === day) out.apps[app] = view(s);
        if (period === month) out.monthly[app] = view(s);
      }
      return out;
    },

    /** Сколько строк журнала не разобралось при старте. */
    skippedLines: () => skipped,
  };
}

export function costUsd(price, usage) {
  if (!price) return 0;
  return round(
    (usage.inputTokens / 1e6) * price.inputPerMTok +
      (usage.outputTokens / 1e6) * price.outputPerMTok +
      (usage.webSearches ?? 0) * (price.perWebSearch ?? 0),
  );
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}
