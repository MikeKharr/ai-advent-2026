// Запуски и их события в памяти сервиса (ADR 2026-09-09-0854, п. 3–4).
// Событие — единица монитора: статус запуска в момент события, стадия,
// уровень, заголовок, детали, структурные данные. Текстов в событиях нет:
// ни промпта, ни статей, ни ответа — ответ идёт отдельным полем результата.
//
// Долгого хранения нет намеренно: монитор показывает только запросы своего
// браузера, и хранит их браузер. Готовый запуск живёт здесь ещё TTL, чтобы
// страница успела дочитать поток после обрыва, и удаляется.

import { randomUUID } from 'node:crypto'

export const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
export const STAGES = [
  'received',
  'planning',
  'tool_call',
  'tool_result',
  'llm_call',
  'llm_result',
  'guard',
  'warning',
  'error',
  'done',
]
export const LEVELS = ['info', 'warn', 'error']

export function createRuns({ now = Date.now, ttlMs = 10 * 60_000 } = {}) {
  /** @type {Map<string, object>} */
  const runs = new Map()

  function must(runId) {
    const run = runs.get(runId)
    if (!run) throw new Error(`запуск ${runId} не найден`)
    return run
  }

  function notify(run, message) {
    for (const listener of run.listeners) listener(message)
  }

  function buildEvent(run, fields) {
    const {
      stage,
      level = 'info',
      title,
      detail = '',
      data = {},
      durationMs,
      toolCallId,
      attempt,
    } = fields
    if (!STAGES.includes(stage)) throw new Error(`стадия ${stage} не в контракте`)
    if (!LEVELS.includes(level)) throw new Error(`уровень ${level} не в контракте`)
    if (typeof title !== 'string' || title.length === 0) throw new Error('событие без заголовка')
    run.seq += 1
    return {
      id: randomUUID(),
      runId: run.id,
      agent: { ...run.agent },
      seq: run.seq,
      at: new Date(now()).toISOString(),
      status: run.status,
      stage,
      level,
      title,
      detail,
      data,
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      // Зарезервировано под подагентов и повторы: в контракте, а не в комментариях.
      parentRunId: run.parentRunId,
      toolCallId: toolCallId ?? null,
      attempt: attempt ?? null,
    }
  }

  return {
    create({ agent, input, parentRunId = null }) {
      const run = {
        id: randomUUID(),
        agent: { id: agent.id, version: agent.version },
        input,
        status: 'queued',
        createdAt: now(),
        finishedAt: null,
        seq: 0,
        events: [],
        result: null,
        error: null,
        parentRunId,
        listeners: new Set(),
      }
      runs.set(run.id, run)
      return run
    },

    get: (runId) => runs.get(runId) ?? null,
    size: () => runs.size,

    /** Событие живого запуска. После терминального статуса событий не бывает. */
    emit(runId, fields) {
      const run = must(runId)
      if (TERMINAL.has(run.status)) throw new Error(`запуск ${runId} уже завершён`)
      if (run.status === 'queued') run.status = 'running'
      const event = buildEvent(run, fields)
      run.events.push(event)
      notify(run, { type: 'event', event })
      return event
    },

    /**
     * Завершение: терминальный статус, результат или ошибка и последнее
     * событие (`done` или `error`) с этим статусом. Слушатели получают
     * событие, затем `end`, и отписываются.
     */
    finish(runId, { status, result = null, error = null, event }) {
      const run = must(runId)
      if (!TERMINAL.has(status)) throw new Error(`статус ${status} не терминальный`)
      if (TERMINAL.has(run.status)) throw new Error(`запуск ${runId} уже завершён`)
      run.status = status
      run.finishedAt = now()
      run.result = result
      run.error = error
      const last = buildEvent(run, event)
      run.events.push(last)
      notify(run, { type: 'event', event: last })
      notify(run, { type: 'end', status, result, error })
      run.listeners.clear()
      return last
    },

    /**
     * Подписка: сначала уже накопленные события, затем живые. У готового
     * запуска — накопленные и сразу `end`. Возвращает отписку.
     */
    subscribe(runId, listener) {
      const run = must(runId)
      for (const event of run.events) listener({ type: 'event', event })
      if (TERMINAL.has(run.status)) {
        listener({ type: 'end', status: run.status, result: run.result, error: run.error })
        return () => {}
      }
      run.listeners.add(listener)
      return () => run.listeners.delete(listener)
    },

    /** Снимок без слушателей и без входа: вход — текст пользователя. */
    snapshot(runId) {
      const run = runs.get(runId)
      if (!run) return null
      return {
        id: run.id,
        agent: { ...run.agent },
        status: run.status,
        createdAt: new Date(run.createdAt).toISOString(),
        finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
        events: run.events,
        result: run.result,
        error: run.error,
      }
    },

    /** Удаляет готовые запуски старше TTL. Незавершённые не трогает. */
    sweep(at = now()) {
      let removed = 0
      for (const [id, run] of runs) {
        if (run.finishedAt !== null && at - run.finishedAt >= ttlMs) {
          runs.delete(id)
          removed += 1
        }
      }
      return removed
    },
  }
}
