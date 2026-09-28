// `pipeline-agent` дня 19 (ADR 2026-09-28-0736, п. 8): цепочка инструментов
// в коде, без модели. Порядок задаёт этот файл, данные между шагами
// переносит он же, расход модели — ноль.
//
// Цепочка: `news.search` → `news.summarize` → `file.save` → `file.read`.
// Последний шаг существует не ради чтения: хост считает `sha256` выжимки,
// которую отдал `mcpnews`, и `sha256` текста, который вернул `mcpstore`, и
// показывает оба. Совпадение — и есть «корректность передачи данных между
// инструментами»: проверяемая, а не объявленная. Расхождение — не мелочь на
// экране, а отказ запуска: цепочка, потерявшая данные посередине, успешной
// не бывает.

import { createHash } from 'node:crypto'
import { McpError } from './client.js'
import { apiToolName } from './tool-names.js'

/** Шаги цепочки: имя инструмента и как из прошлых итогов собрать аргументы. */
export const STEPS = [
  { server: 'mcpnews', tool: 'news.search', args: ({ input }) => ({ query: input.query, days: input.days, limit: input.limit }) },
  { server: 'mcpnews', tool: 'news.summarize', args: ({ items }) => ({ items }) },
  { server: 'mcpstore', tool: 'file.save', args: ({ fileName, summary }) => ({ name: fileName, content: summary }) },
  { server: 'mcpstore', tool: 'file.read', args: ({ fileName }) => ({ name: fileName }) },
]

/**
 * Полезная часть ответа инструмента, тремя ступенями. `structuredContent` по
 * спецификации MCP необязателен, и наши серверы его не кладут: они кладут
 * JSON строкой в текстовый блок (`mcpstore/src/rpc.js:94`). Служба дня 16
 * написана до этого контракта и меняться не будет, поэтому требовать поле
 * нельзя ни от кого.
 *
 * Ступени: поле есть — берём его; нет — разбираем текст как JSON; не JSON —
 * считаем текст просто текстом. Последняя ступень не падает никогда: ответ
 * инструмента — недоверенные данные.
 */
export function payloadOf(out) {
  if (out?.structured && typeof out.structured === 'object' && !Array.isArray(out.structured))
    return out.structured
  const raw = typeof out?.text === 'string' ? out.text : ''
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // Не JSON — ниже он и будет просто текстом.
  }
  return { text: raw }
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Ошибка цепочки: несёт шаг, на котором всё кончилось. */
export class PipelineError extends Error {
  constructor(message, { step, reason }) {
    super(message)
    this.name = 'PipelineError'
    this.step = step
    this.reason = reason
  }
}

/**
 * Инструменты всех серверов реестра одним списком: у каждого рядом имя
 * сервера. Недоступный сервер — событие и работа без него, не отказ
 * (ADR, п. 1).
 */
export async function listAllTools({ servers, emit = () => {} }) {
  const tools = []
  const unreachable = []
  for (const server of servers.values()) {
    try {
      const { tools: own, trace } = await server.client.listTools()
      emit(rpcEvent(trace, `Получен список инструментов «${server.name}»`))
      // Имя для модели считается здесь, чтобы непроходное имя всплыло на
      // списке инструментов, а не на 400 от роутера посреди запуска.
      tools.push(...own.map((tool) => ({ ...tool, apiName: apiToolName(server.name, tool.name) })))
    } catch (error) {
      if (error.trace) emit(rpcEvent(error.trace, `Сервер «${server.name}» не отдал список`, 'warn'))
      unreachable.push({ server: server.name, reason: error.reason ?? 'unknown' })
    }
  }
  return { tools, unreachable }
}

/** Событие монитора стадии `rpc`: сырые тела, имя сервера, метод, миллисекунды. */
export function rpcEvent(trace, title, level = 'info') {
  return {
    stage: 'rpc',
    level,
    title,
    detail: `${trace.server} · ${trace.method} · ${trace.ms} мс`,
    durationMs: trace.ms,
    data: {
      server: trace.server,
      method: trace.method,
      request: trace.request,
      response: trace.response,
      status: trace.status,
      ms: trace.ms,
      clipped: trace.clipped,
    },
  }
}

/**
 * Прогон цепочки. `servers` — реестр (`loadServers`), `emit` — событие
 * монитора. Любой отказ шага — `PipelineError`: цепочка не идёт дальше с
 * пустыми руками.
 */
export async function runPipeline({ input, servers, emit = () => {}, now = Date.now }) {
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (query === '') throw new PipelineError('Запрос пуст.', { step: null, reason: 'bad_input' })

  const { tools } = await listAllTools({ servers, emit })
  // Ключ — пара «сервер и инструмент», а не голое имя. По голому имени
  // одноимённые инструменты разных серверов сталкивались бы, и побеждал бы
  // последний опрошенный: шаг `file.save` ушёл бы на чужой сервер, если бы
  // тот объявил такое же имя. Порядок цепочки дня 19 задан ADR (п. 8) — там
  // назван и сервер каждого шага, поэтому он назван и здесь (находка гейта,
  // PR #233).
  const have = new Set(tools.map((tool) => `${tool.server}/${tool.name}`))

  const started = now()
  const fileName = `pipeline-${started}.txt`
  const state = {
    input: { query, days: input.days ?? 7, limit: input.limit ?? 5 },
    fileName,
  }
  const calls = []

  for (const step of STEPS) {
    const serverName = step.server
    if (!have.has(`${serverName}/${step.tool}`))
      throw new PipelineError(`Инструмент ${step.tool} не нашёлся на сервере «${serverName}».`, {
        step: step.tool,
        reason: 'no_tool',
      })
    const server = servers.get(serverName)

    let out
    try {
      out = await server.client.callTool(step.tool, step.args(state))
    } catch (error) {
      if (error instanceof McpError && error.trace)
        emit(rpcEvent(error.trace, `Шаг ${step.tool} не выполнен`, 'error'))
      throw new PipelineError(`Шаг ${step.tool}: ${error.message}`, {
        step: step.tool,
        reason: error.reason ?? 'unknown',
      })
    }
    emit(rpcEvent(out.trace, `Выполнен ${step.tool} на «${serverName}»`, out.isError ? 'warn' : 'info'))
    if (out.isError)
      throw new PipelineError(`Шаг ${step.tool} отказал: ${out.text || 'без объяснения'}`, {
        step: step.tool,
        reason: 'tool_error',
      })

    calls.push({ tool: step.tool, server: serverName, ms: out.trace.ms })

    const payload = payloadOf(out)

    if (step.tool === 'news.search') {
      state.items = Array.isArray(payload.items) ? payload.items : []
      if (state.items.length === 0)
        throw new PipelineError('Шаг news.search не нашёл ни одной новости.', {
          step: 'news.search',
          reason: 'empty',
        })
    }
    if (step.tool === 'news.summarize') {
      // Именно `text`: так называет выжимку `mcpnews` (его `newsSummarize`).
      // Сверяется дальше этот текст, а не обёртка ответа — иначе оба
      // отпечатка считались бы от одного и того же JSON и совпадали бы
      // всегда, что бы ни лежало в хранилище.
      state.summary = typeof payload.text === 'string' ? payload.text : ''
      // Объявленный сервером отпечаток. Сверку он не заменяет: считает его
      // тот же сервер, который отдал текст.
      state.declaredSha = typeof payload.sha256 === 'string' ? payload.sha256 : null
      if (state.summary === '')
        throw new PipelineError('Шаг news.summarize вернул пустую выжимку.', {
          step: 'news.summarize',
          reason: 'empty',
        })
    }
    if (step.tool === 'file.save') state.savedSha = typeof payload.sha256 === 'string' ? payload.sha256 : null
    if (step.tool === 'file.read') {
      // «Нет файла» хранилище отказом не считает (`found: false` без
      // `isError`). Для цепочки это отказ: сверять нечего.
      if (payload.found === false)
        throw new PipelineError(`Шаг file.read: файла ${fileName} в хранилище нет.`, {
          step: 'file.read',
          reason: 'not_found',
        })
      state.readBack = typeof payload.content === 'string' ? payload.content : null
      if (state.readBack === null)
        throw new PipelineError('Шаг file.read вернул ответ без содержимого файла.', {
          step: 'file.read',
          reason: 'malformed',
        })
    }
  }

  const sentSha = sha256(state.summary)
  const readSha = sha256(state.readBack)
  const match = sentSha === readSha

  const result = {
    query,
    fileName,
    summary: state.summary,
    // Оба отпечатка на экран — требование дня 19.
    sentSha256: sentSha,
    readSha256: readSha,
    declaredSha256: state.declaredSha,
    savedSha256: state.savedSha ?? null,
    match,
    calls,
    ms: now() - started,
  }

  if (!match)
    throw Object.assign(
      new PipelineError('Прочитанное не совпало с сохранённым: sha256 разошлись.', {
        step: 'file.read',
        reason: 'sha_mismatch',
      }),
      { result },
    )

  return result
}
