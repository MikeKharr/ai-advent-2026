// Агент `mcp-agent` — цикл с моделью, которой даны инструменты серверов MCP
// (ADR 2026-09-28-0736, п. 1). Две точки входа, один цикл: посетитель дня 20
// (`POST /v1/runs`) и планировщик дня 18 (`POST /v1/jobs/:job/trigger`).
//
// РАСХОД ИДЁТ РАЗНЫМИ КЛЮЧАМИ, и это главное различие двух точек входа.
// Интерактивный запуск — ключ приложения `agents` ($10 в сутки), автономный
// запуск планировщика — ключ приложения `scheduler` ($0,5 в сутки). Ключ
// выбирается ЗДЕСЬ, в фабрике точки входа, и нигде больше: в `server.js`
// выбора нет, а `runToolLoop` ключ только получает и никогда не читает
// окружение сам. Подмена ключа местами — красный тест
// («автономный запуск планировщика платит ключом scheduler…» и
// «интерактивный запуск дня 20 платит ключом приложения agents…»,
// `test/mcp-agent.test.js`).
//
// Работа планировщика идёт НЕ ОБЯЗАТЕЛЬНО через модель: агент без модели
// (цепочка дня 19) исполняется здесь же и роутера не зовёт вовсе — ключ
// приложения такой работе не нужен и не читается. Отвергается только агент,
// которого нет в реестре.
//
// Потолок кругов живёт здесь, а не в роутере: роутер меряет круг, не запуск
// (наблюдение `compliance`). Круг — `tools/list` уже сделан, дальше запрос к
// роутеру, и при `stopReason === 'tool_use'` вызовы инструментов с возвратом
// результатов в диалог.

import { listAllTools, payloadOf, PipelineError, rpcEvent, runPipeline } from './pipeline.js'
import { buildToolIndex } from './tool-names.js'

/** Идентификатор записи реестра: по нему сервис находит агента дней 18 и 20. */
export const MCP_AGENT_ID = 'mcp-agent'

/** Кругов с инструментами на запуск (ADR, п. 1). Девятого круга не бывает. */
export const MAX_ROUNDS = 8

/** Потолок времени на запуск (ADR, п. 1). */
export const RUN_DEADLINE_MS = 120_000

/** Результат инструмента в контекст — до 8 КБ с пометкой об обрезке (ADR, п. 1). */
export const TOOL_RESULT_LIMIT = 8 * 1024
const CLIP_NOTE = '\n[результат обрезан хостом]'

/** Потолок текста задания посетителя дня 20 — тот же, что у страницы. */
export const MAX_TASK_CHARS = 600

/** Обрезка результата инструмента по БАЙТАМ: потолок контекста меряется ими. */
export function clipToolResult(text) {
  if (Buffer.byteLength(text) <= TOOL_RESULT_LIMIT) return { text, clipped: false }
  return {
    text: Buffer.from(text).subarray(0, TOOL_RESULT_LIMIT).toString('utf8') + CLIP_NOTE,
    clipped: true,
  }
}

/**
 * Один запрос к роутеру с определениями инструментов. Ключ приложения —
 * ОБЯЗАТЕЛЬНЫЙ аргумент, а не значение из окружения: у двух точек входа
 * агента ключи разные, и молчаливое умолчание свело бы их в один.
 */
export async function askTools(
  { messages, tools, system, taskClass, provider, answerTokens },
  { routerUrl, routerKey, fetchImpl = fetch, timeoutMs },
) {
  if (typeof routerKey !== 'string' || routerKey === '')
    throw new Error('вызов роутера без ключа приложения')
  const response = await fetchImpl(`${routerUrl}/v1/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${routerKey}` },
    body: JSON.stringify({ taskClass, provider, answerTokens, system, messages, tools }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await response.json().catch(() => null)
  if (!json) {
    const error = new Error(`роутер ${response.status}: ответ не разобран`)
    error.status = response.status
    throw error
  }
  if (!json.ok) {
    const error = new Error(json.message ?? `роутер ${response.status}`)
    error.status = response.status
    error.code = json.code
    throw error
  }
  return {
    text: json.text ?? '',
    // Блоки как пришли: `tool_use` обязан остаться блоком.
    content: Array.isArray(json.content) ? json.content : [],
    stopReason: json.stopReason ?? null,
    usage: {
      inputTokens: json.usage?.inputTokens ?? null,
      outputTokens: json.usage?.outputTokens ?? null,
    },
    budgetLeft: json.budgetLeft ?? null,
    provider: json.provider ?? null,
  }
}

/** Определения инструментов для модели: имя из таблицы, схема — как отдал сервер. */
function toolDefs(tools) {
  return tools.map((tool) => ({
    name: tool.apiName,
    // Роутер требует непустое описание. Своего у инструмента может не быть —
    // тогда его заменяет заголовок или имя, а не пустая строка, на которой
    // запрос отвергался бы целиком.
    description:
      (typeof tool.description === 'string' && tool.description.trim() !== ''
        ? tool.description
        : null) ??
      (typeof tool.title === 'string' && tool.title.trim() !== '' ? tool.title : null) ??
      `Инструмент ${tool.name} сервера ${tool.server}`,
    input_schema:
      tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object' },
  }))
}

/**
 * Цикл с моделью. Возвращает `{status, summary, answer, tokens, budgetLeftUsd,
 * rounds, warnings, calls}` и НИКОГДА не бросает из-за отказа роутера или
 * сервера: отказ — предупреждение и статус `failed`, а не исключение сквозь
 * планировщик.
 */
export async function runToolLoop({
  task,
  system,
  servers,
  taskClass,
  provider,
  answerTokens,
  routerUrl,
  routerKey,
  timeoutMs,
  emit = () => {},
  fetchImpl = fetch,
  now = Date.now,
  maxRounds = MAX_ROUNDS,
  deadlineMs = RUN_DEADLINE_MS,
}) {
  const startedAt = now()
  const warnings = []
  const calls = []

  const { tools, unreachable } = await listAllTools({ servers, emit })
  for (const miss of unreachable)
    warnings.push(`Сервер «${miss.server}» не отдал список инструментов (${miss.reason}).`)

  // Обратный разбор имени — по индексу, а не по строке: одноимённые
  // инструменты разных серверов не должны сталкиваться.
  const index = buildToolIndex(tools)
  const defs = toolDefs(tools)

  // Инструментов нет — модель звать не за чем и не на что: роутер отверг бы
  // пустой список, а платить за круг без инструментов бессмысленно.
  if (defs.length === 0) {
    warnings.push('Ни один сервер MCP не отдал инструментов: модель не вызывалась.')
    return {
      status: 'failed',
      summary: warnings.join('\n'),
      answer: '',
      tokens: null,
      budgetLeftUsd: null,
      rounds: 0,
      warnings,
      calls,
      table: index.table(),
    }
  }

  const messages = [{ role: 'user', content: task }]
  let tokens = 0
  let counted = false
  let budgetLeftUsd = null
  let rounds = 0
  let answer = ''
  let status = 'failed'

  for (;;) {
    // Оба потолка проверяются ДО вызова роутера: круг, которого не должно
    // быть, не должен стоить денег (I-4).
    if (rounds >= maxRounds) {
      warnings.push(`Потолок в ${maxRounds} кругов исчерпан: модель всё ещё звала инструменты.`)
      break
    }
    if (now() - startedAt >= deadlineMs) {
      warnings.push(`Потолок времени ${Math.round(deadlineMs / 1000)} с на запуск исчерпан.`)
      break
    }
    rounds += 1

    let reply
    try {
      reply = await askTools(
        { messages, tools: defs, system, taskClass, provider, answerTokens },
        { routerUrl, routerKey, fetchImpl, timeoutMs },
      )
    } catch (error) {
      warnings.push(`Модель не ответила: ${error.message}`)
      break
    }

    if (reply.usage.inputTokens !== null || reply.usage.outputTokens !== null) {
      tokens += (reply.usage.inputTokens ?? 0) + (reply.usage.outputTokens ?? 0)
      counted = true
    }
    if (typeof reply.budgetLeft?.costUsd === 'number') budgetLeftUsd = reply.budgetLeft.costUsd
    emit({
      stage: 'llm_result',
      title: `Модель ответила, круг ${rounds}`,
      detail: `${reply.stopReason ?? 'без причины остановки'}`,
      data: { round: rounds, stopReason: reply.stopReason, provider: reply.provider },
    })

    // ЕДИНСТВЕННОЕ условие исполнения инструментов. Обрыв по длине роутер
    // называет `length`, и блок `tool_use` в таком ответе обрезан — исполнять
    // его нельзя (ADR, п. 1). Поэтому здесь проверяется равенство `tool_use`,
    // а не неравенство `max_tokens`.
    if (reply.stopReason !== 'tool_use') {
      answer = reply.text
      status = answer === '' ? 'failed' : 'succeeded'
      if (reply.stopReason === 'length')
        warnings.push('Ответ модели обрезан потолком токенов: он может быть неполным.')
      if (answer === '') warnings.push('Модель вернула пустой ответ.')
      break
    }

    messages.push({ role: 'assistant', content: reply.content })
    const results = []
    for (const block of reply.content) {
      if (block?.type !== 'tool_use') continue
      results.push(await callOne(block))
    }
    // Результаты всех вызовов круга уходят одним сообщением.
    if (results.length === 0) {
      warnings.push('Модель просила инструменты, но ни одного вызова в ответе не нашлось.')
      break
    }
    messages.push({ role: 'user', content: results })
  }

  const summary = [answer, ...warnings.map((w) => `Предупреждение: ${w}`)]
    .filter((part) => part !== '')
    .join('\n\n')

  return {
    status,
    summary: summary === '' ? 'Сводка не собрана.' : summary,
    answer,
    tokens: counted ? tokens : null,
    budgetLeftUsd,
    rounds,
    warnings,
    calls,
    table: index.table(),
  }

  /** Один вызов инструмента. Любая беда — `tool_result` с `is_error`, не бросок. */
  async function callOne(block) {
    const fail = (text) => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: [{ type: 'text', text }],
      is_error: true,
    })

    const at = index.resolve(block.name)
    if (!at) {
      emit({
        stage: 'warning',
        level: 'warn',
        title: 'Модель назвала неизвестный инструмент',
        detail: String(block.name),
        data: { tool: String(block.name) },
      })
      warnings.push(`Модель позвала неизвестный инструмент ${block.name}.`)
      return fail(`Инструмента ${block.name} нет. Выбери имя из списка.`)
    }
    const server = servers.get(at.server)
    if (!server) return fail(`Сервер ${at.server} недоступен.`)

    let out
    try {
      out = await server.client.callTool(at.tool, block.input ?? {})
    } catch (error) {
      if (error.trace) emit(rpcEvent(error.trace, `Вызов ${at.tool} не выполнен`, 'error'))
      warnings.push(`Инструмент ${at.tool} сервера «${at.server}» не ответил: ${error.message}`)
      return fail(`Инструмент ${at.tool} не ответил: ${error.message}`)
    }
    emit(rpcEvent(out.trace, `Выполнен ${at.tool} на «${at.server}»`, out.isError ? 'warn' : 'info'))
    calls.push({ tool: at.tool, server: at.server, ms: out.trace.ms, isError: out.isError })

    // Тело ответа для модели — текст как есть. Разбор нужен только там, где
    // текста нет вовсе: `payloadOf` — единственное место разбора в проекте.
    const raw = out.text !== '' ? out.text : JSON.stringify(payloadOf(out))
    const { text, clipped } = clipToolResult(raw)
    if (clipped) warnings.push(`Результат ${at.tool} обрезан до ${TOOL_RESULT_LIMIT} байт.`)
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: [{ type: 'text', text }],
      ...(out.isError ? { is_error: true } : {}),
    }
  }
}

/**
 * ТОЧКА ВХОДА 1 — посетитель дня 20. Расход идёт ключом приложения `agents`:
 * запуск затеял человек за кнопкой, и потолок у него общий с днями 6–16.
 */
export function createMcpAgent({
  agent,
  servers,
  runs,
  env,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
}) {
  return {
    id: agent.id,
    version: agent.version,
    tools: [...agent.tools],
    defaults: { ...agent.defaults },
    // Диалогов и сессий у агента нет: замка тоже нет.
    isBusy: () => false,
    hold: () => {},

    parseInput(body) {
      if (!body || typeof body !== 'object')
        return { ok: false, message: 'input должен быть объектом' }
      const task = typeof body.task === 'string' ? body.task.trim() : ''
      if (task === '') return { ok: false, message: 'Поле task должно быть непустой строкой' }
      if (task.length > MAX_TASK_CHARS)
        return { ok: false, message: `Поле task длиннее ${MAX_TASK_CHARS} знаков` }
      return { ok: true, input: { task, sessionId: null, params: { model: agent.defaults.model } } }
    },

    async execute(run) {
      const startedAt = now()
      try {
        const out = await runToolLoop({
          task: run.input.task,
          system: agent.systemPrompt,
          servers,
          taskClass: agent.taskClass,
          provider: agent.defaults.model,
          answerTokens: agent.defaults.maxTokens,
          routerUrl: env.ROUTER_URL,
          // Ключ приложения `agents`: интерактивный запуск.
          routerKey: env.ROUTER_APP_KEY,
          timeoutMs: env.ROUTER_TIMEOUT_MS,
          emit: (event) => runs.emit(run.id, event),
          fetchImpl,
          now,
        })
        return finishRun(runs, run, out, now() - startedAt)
      } catch (error) {
        log(`запуск ${run.id}: ${error.stack ?? error.message}`)
        return runs.finish(run.id, {
          status: 'failed',
          error: { code: 'internal', message: 'Внутренняя ошибка агента' },
          event: {
            stage: 'error',
            level: 'error',
            title: 'Внутренняя ошибка агента',
            detail: error.message,
            durationMs: now() - startedAt,
          },
        })
      }
    },
  }
}

/** Общий финал запуска для обеих точек входа. */
function finishRun(runs, run, out, durationMs) {
  return runs.finish(run.id, {
    status: out.status === 'succeeded' ? 'succeeded' : 'failed',
    result: {
      answer: out.answer,
      rounds: out.rounds,
      calls: out.calls,
      table: out.table,
      warnings: out.warnings,
      tokens: out.tokens,
      budgetLeftUsd: out.budgetLeftUsd,
    },
    error:
      out.status === 'succeeded'
        ? null
        : { code: 'tool_loop_failed', message: out.warnings[0] ?? 'Запуск не дал ответа' },
    event:
      out.status === 'succeeded'
        ? {
            stage: 'done',
            title: 'Отдал сводку',
            detail: `кругов ${out.rounds}, вызовов ${out.calls.length}`,
            durationMs,
          }
        : {
            stage: 'error',
            level: 'error',
            title: 'Запуск не дал ответа',
            detail: out.warnings[0] ?? '',
            durationMs,
          },
  })
}

/**
 * ТОЧКА ВХОДА 2 — планировщик дня 18. Расход идёт ключом приложения
 * `scheduler` ($0,5 в сутки), а НЕ ключом приложения `agents` ($10): иначе
 * ночная сводка тратила бы бюджет дней 6–16 и в журнале роутера была бы от
 * них неотличима (прямое условие `compliance`). Ключ берётся здесь и только
 * здесь; `server.js` выбора не делает.
 *
 * Запуск заводится в памяти сервиса ПОД ТЕМ ЖЕ идентификатором, что записан
 * на томе: страница дня 18 читает поток событий идущего запуска по нему.
 */
export function createJobRunner({
  registry,
  servers,
  runs,
  env,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
}) {
  return async function runJob({ job, runId }) {
    const entry = registry.get(job.agentId)
    // Отказ — только для агента, которого в реестре нет. Агент БЕЗ МОДЕЛИ
    // работе подходит и идёт цепочкой ниже: предмет дней 18–20 — инструменты
    // и MCP, а не сводка моделью, и автономный прогон цепочки бесплатен
    // (решение владельца: «выход одного — вход другого»).
    if (!entry)
      return {
        status: 'failed',
        summary: `Агента ${job.agentId} нет в реестре.`,
        trace: [],
        tokens: null,
        budgetLeftUsd: null,
      }

    const run = runs.create({ id: runId, agent: entry, input: { task: job.prompt, params: {} } })
    // Трейс ленты дня 18 — те же данные, что уходят в поток событий: страница
    // разбирает их одной функцией и живьём, и из ленты.
    const trace = []
    const emit = (event) => {
      if (event.stage === 'rpc') trace.push(event.data)
      runs.emit(run.id, event)
    }

    const startedAt = now()

    // Путь БЕЗ МОДЕЛИ. Роутер здесь не зовётся вовсе, и ключ приложения —
    // ни `scheduler`, ни `agents` — этой ветке не нужен и не читается: работа
    // бесплатна, и зависеть от ключа, которым ей нечего оплачивать, она не
    // должна. Токены и остаток бюджета остаются `null` — не «ноль потрачено»,
    // а «роутера в этом запуске не было».
    if (entry.modelless) {
      try {
        // Постоянное имя файла — условие ADR 2026-09-28-1323, п. 5: работа
        // идёт 96 раз в сутки и хранилище на 200 файлов не её одно.
        const result = await runPipeline({
          input: { query: job.prompt, fileName: `pipeline-${job.id}.txt` },
          servers,
          emit,
          now,
        })
        runs.finish(run.id, {
          status: 'succeeded',
          result,
          event: {
            stage: 'done',
            title: 'Цепочка пройдена',
            detail: `вызовов ${result.calls.length}, sha256 совпали`,
            durationMs: now() - startedAt,
          },
        })
        return {
          status: 'succeeded',
          summary: `${result.summary}\n\nsha256 отправленного и прочитанного совпали (${result.sentSha256.slice(0, 12)}…), файл ${result.fileName}, вызовов ${result.calls.length}.`,
          trace,
          tokens: null,
          budgetLeftUsd: null,
        }
      } catch (error) {
        const known = error instanceof PipelineError
        if (!known) log(`работа ${job.id}, запуск ${runId}: ${error.stack ?? error.message}`)
        const message = known ? error.message : 'Внутренняя ошибка агента'
        runs.finish(run.id, {
          status: 'failed',
          error: { code: known ? (error.reason ?? 'pipeline') : 'internal', message, paidNothing: true },
          event: {
            stage: 'error',
            level: 'error',
            title: 'Цепочка не пройдена',
            detail: message,
            data: { step: known ? error.step : null, reason: known ? error.reason : 'internal' },
            durationMs: now() - startedAt,
          },
        })
        return { status: 'failed', summary: message, trace, tokens: null, budgetLeftUsd: null }
      }
    }

    let out
    try {
      out = await runToolLoop({
        task: job.prompt,
        system: entry.systemPrompt,
        servers,
        taskClass: entry.taskClass,
        provider: entry.defaults.model,
        answerTokens: entry.defaults.maxTokens,
        routerUrl: env.ROUTER_URL,
        // Ключ приложения `scheduler`: автономный расход.
        routerKey: env.ROUTER_APP_KEY_SCHEDULER,
        timeoutMs: env.ROUTER_TIMEOUT_MS,
        emit,
        fetchImpl,
        now,
      })
    } catch (error) {
      log(`работа ${job.id}, запуск ${runId}: ${error.stack ?? error.message}`)
      runs.finish(run.id, {
        status: 'failed',
        error: { code: 'internal', message: 'Внутренняя ошибка агента' },
        event: {
          stage: 'error',
          level: 'error',
          title: 'Внутренняя ошибка агента',
          detail: error.message,
          durationMs: now() - startedAt,
        },
      })
      return {
        status: 'failed',
        summary: `Внутренняя ошибка агента: ${error.message}`,
        trace,
        tokens: null,
        budgetLeftUsd: null,
      }
    }

    finishRun(runs, run, out, now() - startedAt)
    return {
      status: out.status,
      summary: out.summary,
      trace,
      // Неизвестное не притворяется нулём.
      tokens: out.tokens,
      budgetLeftUsd: out.budgetLeftUsd,
    }
  }
}
