// Единица `mcpgit` — локальный stdio-сервер MCP с двумя инструментами о
// состоянии рабочей копии: `git.branch` и `git.changed`
// (ADR 2026-10-18-1147, п. 1 раздела дня 31; развилка Р4, вариант «а»).
//
// Почему своя копия JSON-RPC, а не SDK: SDK и `zod` разрешены только единице
// `mcp/` (ADR 2026-09-23-1227, п. 2; карта в шаге «Граница runtime-зависимостей»
// в `ci.yml`). Эта копия — четвёртая в проекте после `mcpnews/src/rpc.js`,
// `mcpstore` и `rag/rpc.py`; цена границы названа в ADR 2026-09-28-0736, п. 3.
// Образец формы ответов — `mcpnews/src/rpc.js`: та же ревизия протокола, тот же
// `isError` у отказа инструмента, те же коды JSON-RPC.
//
// Поверхности для подстановки нет по построению: оба инструмента БЕЗ
// аргументов, аргументы запроса не читаются вовсе, команды — литералы
// массивом в `execFile` (без оболочки), каталог запуска — корень проекта, а
// не что-либо из запроса. Модель не может ни передать git чужой флаг, ни
// сменить каталог, ни выполнить что-то кроме двух зашитых команд.
//
// Процесс локальный: его запускает Claude Code на ноутбуке через `.mcp.json`.
// В образы и в `deploy/compose.yml` он не входит, на VPS его нет.

import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

export const PROTOCOL_VERSION = '2025-11-25'
export const SERVER_INFO = { name: 'ai-advent-2026-git', version: '1.0.0' }

/** Коды JSON-RPC — то же подмножество, что у `mcpnews/src/rpc.js`. */
export const CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
}

/** Лимит вывода: больше имён ответ не несёт, остаток помечен `truncated`. */
export const MAX_FILES = 200
/** Длиннее этого путь режется: ответ — для модели, а не для файловой системы. */
export const MAX_PATH = 300
/** Срок одной команды git. Локальный репозиторий отвечает за миллисекунды. */
export const GIT_TIMEOUT_MS = 10_000
/** Потолок буфера вывода git — прежде, чем из него что-то читается. */
const MAX_BUFFER = 1024 * 1024

/** Ветка сравнения у `git.changed`. Литерал, а не аргумент. */
const BASE = 'main'

/**
 * Корень репозитория: переменная Claude Code, иначе каталог процесса.
 * Из запроса путь не берётся никогда.
 */
export function projectRoot(env = process.env, cwd = process.cwd()) {
  const dir = env.CLAUDE_PROJECT_DIR
  return typeof dir === 'string' && dir !== '' ? dir : cwd
}

/** Запуск git без оболочки. `args` — литералы вызывающего кода. */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout, stderr) => {
        if (error) {
          const text = String(stderr || error.message || 'git не выполнился').trim()
          reject(new Error(text.slice(0, 300)))
          return
        }
        resolve(stdout)
      },
    )
  })
}

const cutPath = (value) => (value.length > MAX_PATH ? value.slice(0, MAX_PATH) : value)

/** Применение лимита к списку имён: срез и честный признак `truncated`. */
function capped(names) {
  return { files: names.slice(0, MAX_FILES).map(cutPath), truncated: names.length > MAX_FILES }
}

/**
 * Разбор `git status --porcelain=v1 -z`. Формат `-z` выбран, чтобы не
 * разбирать кавычки `core.quotepath`: записи разделены NUL, путь — как есть.
 * У переименования и копирования следом идёт ВТОРАЯ запись — прежнее имя;
 * она пропускается, иначе список имён смешивал бы старое с новым.
 */
export function parseStatusZ(stdout) {
  const parts = stdout.split('\0')
  const out = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry === '') continue
    if (entry.length < 4) throw new Error(`непонятная запись git status: ${entry.slice(0, 40)}`)
    const code = entry.slice(0, 2)
    out.push(entry.slice(3))
    if (code.includes('R') || code.includes('C')) i += 1
  }
  return out
}

/** Разбор `--name-only -z`: имена, разделённые NUL. */
export function parseNamesZ(stdout) {
  return stdout.split('\0').filter((name) => name !== '')
}

async function gitBranch(cwd) {
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
  // `HEAD` здесь — не ветка, а отсоединённое состояние. Молчать о нём нельзя:
  // «ветка HEAD» модель поняла бы буквально.
  return { branch, detached: branch === 'HEAD' }
}

async function gitChanged(cwd) {
  const working = capped(parseStatusZ(await runGit(['status', '--porcelain=v1', '-z'], cwd)))

  // Ветки `main` может не быть (свежий клон без неё, чужой репозиторий).
  // Это не отказ инструмента: состояние рабочей копии уже собрано, и честнее
  // отдать его с причиной, чем потерять весь ответ.
  let vsBase = null
  let baseError = null
  try {
    vsBase = capped(parseNamesZ(await runGit(['diff', '--name-only', '-z', `${BASE}...HEAD`], cwd)))
  } catch (error) {
    baseError = String(error?.message ?? 'сравнение с main не выполнилось')
  }

  return {
    working: working.files,
    workingTruncated: working.truncated,
    base: BASE,
    vsBase: vsBase?.files ?? null,
    vsBaseTruncated: vsBase?.truncated ?? false,
    vsBaseError: baseError,
  }
}

/** Два инструмента. Оба без аргументов: `inputSchema` ничего не принимает. */
export function buildTools(cwd) {
  const noArgs = { type: 'object', properties: {}, additionalProperties: false }
  return [
    {
      name: 'git.branch',
      title: 'Текущая ветка',
      description: 'Имя текущей ветки рабочей копии проекта (git rev-parse --abbrev-ref HEAD).',
      inputSchema: noArgs,
      run: () => gitBranch(cwd),
    },
    {
      name: 'git.changed',
      title: 'Изменённые файлы',
      description:
        'Файлы рабочей копии: незакоммиченные (git status) и отличия ветки от main (git diff --name-only main...HEAD).',
      inputSchema: noArgs,
      run: () => gitChanged(cwd),
    },
  ]
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const listed = (tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
})

/**
 * Отказ ИНСТРУМЕНТА, а не протокола: спецификация требует `isError` в
 * результате, чтобы вызывающая модель увидела текст и могла поправиться.
 */
const toolFailure = (message) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
})

/** Обработчик одного объекта JSON-RPC; `null` — для уведомления. */
export function createRpc({ serverInfo = SERVER_INFO, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  return async function handleOne(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, CODES.INVALID_REQUEST, 'invalid request')
    }
    const { id, method } = message
    const isNotification = id === undefined || id === null
    if (typeof method !== 'string') {
      return isNotification ? null : rpcError(id, CODES.INVALID_REQUEST, 'invalid request')
    }
    if (method === 'notifications/initialized') return null

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        })
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: tools.map(listed) })
      case 'tools/call': {
        const name = message.params?.name
        const tool = typeof name === 'string' ? byName.get(name) : undefined
        if (!tool) return rpcError(id, CODES.INVALID_PARAMS, `unknown tool: ${String(name).slice(0, 64)}`)
        // `params.arguments` не читается вовсе: у обоих инструментов входа нет.
        try {
          const result = await tool.run()
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] })
        } catch (error) {
          return rpcResult(id, toolFailure(String(error?.message ?? 'сбой инструмента')))
        }
      }
      default:
        return isNotification ? null : rpcError(id, CODES.METHOD_NOT_FOUND, `unknown method: ${method.slice(0, 64)}`)
    }
  }
}

/**
 * Транспорт stdio: по объекту JSON на строку. В stdout уходят ТОЛЬКО ответы
 * протокола — любое сообщение человеку пишется в stderr, иначе клиент
 * получит мусор вместо JSON-RPC.
 */
export function serveStdio({ input = process.stdin, output = process.stdout, cwd = projectRoot() } = {}) {
  const handleOne = createRpc({ tools: buildTools(cwd) })
  const lines = createInterface({ input, crlfDelay: Infinity })
  // Строки обрабатываются по очереди: порядок ответов равен порядку запросов,
  // иначе тест на последовательность вызовов ничего бы не значил.
  let queue = Promise.resolve()

  lines.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    queue = queue.then(async () => {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        output.write(`${JSON.stringify(rpcError(null, CODES.INVALID_REQUEST, 'invalid json'))}\n`)
        return
      }
      const response = await handleOne(message)
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    })
  })

  return lines
}

// Запуск как программы; при импорте из теста — ничего не делает.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio()
}
