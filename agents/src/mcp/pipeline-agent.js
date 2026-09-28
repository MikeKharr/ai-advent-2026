// Исполнитель агента `pipeline-agent` дня 19 (ADR 2026-09-28-0736, п. 8):
// обёртка цепочки `runPipeline` в контракт запусков сервиса. Порядок шагов,
// перенос данных и сверка `sha256` — в `pipeline.js`; здесь только вход
// запуска, события и терминальный статус.
//
// Модели у агента нет: расход — ноль, ключ приложения ему не нужен вовсе.
// Запись реестра без этого исполнителя уходила бы в общую ветку `server.js` и
// становилась бы агентом дня 6 с платным вызовом (находка гейта, PR #233), —
// поэтому запись и исполнитель приезжают вместе.

import { PipelineError, runPipeline } from './pipeline.js'

export const PIPELINE_AGENT_ID = 'pipeline-agent'

/** Потолок текста задания — тот же, что у страницы дня 19 (`MAX_TASK`). */
export const MAX_TASK_CHARS = 600

export function createPipelineAgent({ agent, servers, runs, now = Date.now, log = () => {} }) {
  return {
    id: agent.id,
    version: agent.version,
    tools: [...agent.tools],
    defaults: { ...agent.defaults },
    // Диалогов у цепочки нет: занимать нечего.
    isBusy: () => false,
    hold: () => {},

    parseInput(body) {
      if (!body || typeof body !== 'object')
        return { ok: false, message: 'input должен быть объектом' }
      const task = typeof body.task === 'string' ? body.task.trim() : ''
      if (task === '') return { ok: false, message: 'Поле task должно быть непустой строкой' }
      if (task.length > MAX_TASK_CHARS)
        return { ok: false, message: `Поле task длиннее ${MAX_TASK_CHARS} знаков` }
      return { ok: true, input: { task, sessionId: null, params: {} } }
    },

    async execute(run) {
      const startedAt = now()
      try {
        const result = await runPipeline({
          input: { query: run.input.task },
          servers,
          emit: (event) => runs.emit(run.id, event),
          now,
        })
        return runs.finish(run.id, {
          status: 'succeeded',
          result,
          event: {
            stage: 'done',
            title: 'Цепочка пройдена',
            detail: `вызовов ${result.calls.length}, sha256 совпали`,
            durationMs: now() - startedAt,
          },
        })
      } catch (error) {
        const known = error instanceof PipelineError
        if (!known) log(`запуск ${run.id}: ${error.stack ?? error.message}`)
        return runs.finish(run.id, {
          status: 'failed',
          error: {
            code: known ? (error.reason ?? 'pipeline') : 'internal',
            message: known ? error.message : 'Внутренняя ошибка агента',
            // Модели в цепочке нет — денег она не стоила ни при каком исходе.
            paidNothing: true,
          },
          event: {
            stage: 'error',
            level: 'error',
            title: 'Цепочка не пройдена',
            detail: known ? error.message : 'Внутренняя ошибка агента',
            data: { step: known ? error.step : null, reason: known ? error.reason : 'internal' },
            durationMs: now() - startedAt,
          },
        })
      }
    },
  }
}
