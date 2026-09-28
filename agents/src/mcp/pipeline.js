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

/** Шаги цепочки: имя инструмента и как из прошлых итогов собрать аргументы. */
export const STEPS = [
  { tool: 'news.search', args: ({ input }) => ({ query: input.query, days: input.days, limit: input.limit }) },
  { tool: 'news.summarize', args: ({ search }) => ({ items: search.structured?.items ?? [] }) },
  { tool: 'file.save', args: ({ fileName, summary }) => ({ name: fileName, content: summary }) },
  { tool: 'file.read', args: ({ fileName }) => ({ name: fileName }) },
]

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
      tools.push(...own)
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
  // Имя сервера хранится рядом с инструментом: шаг зовёт инструмент по имени,
  // а куда идти — говорит реестр, не этот файл.
  const where = new Map(tools.map((tool) => [tool.name, tool.server]))

  const started = now()
  const fileName = `pipeline-${started}.txt`
  const state = {
    input: { query, days: input.days ?? 7, limit: input.limit ?? 5 },
    fileName,
  }
  const calls = []

  for (const step of STEPS) {
    const serverName = where.get(step.tool)
    if (!serverName)
      throw new PipelineError(`Инструмент ${step.tool} не нашёлся ни на одном сервере.`, {
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

    if (step.tool === 'news.search') state.search = out
    if (step.tool === 'news.summarize') {
      state.summary = out.structured?.summary ?? out.text
      // Объявленный сервером отпечаток. Он не заменяет сверку: считает его
      // тот же сервер, который отдал текст, и совпадение с самим собой
      // ничего бы не доказывало.
      state.declaredSha = out.structured?.sha256 ?? null
      if (typeof state.summary !== 'string' || state.summary === '')
        throw new PipelineError('Шаг news.summarize вернул пустую выжимку.', {
          step: 'news.summarize',
          reason: 'empty',
        })
    }
    if (step.tool === 'file.read') state.readBack = out.structured?.content ?? out.text
  }

  const sentSha = sha256(state.summary)
  const readSha = sha256(state.readBack ?? '')
  const match = sentSha === readSha

  const result = {
    query,
    fileName,
    summary: state.summary,
    // Оба отпечатка на экран — требование дня 19.
    sentSha256: sentSha,
    readSha256: readSha,
    declaredSha256: state.declaredSha,
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
