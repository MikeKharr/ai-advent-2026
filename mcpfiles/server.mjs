// Единица `mcpfiles` — локальный stdio-сервер MCP, ассистент над файлами
// этого репозитория: читает, ищет и выполняет ОДНУ правку — перенос пункта
// бэклога в `agent_docs/backlog-closed.md` (день 34, ADR 2026-10-18-2152).
//
// Образец формы — `mcpgit/server.mjs` (день 31): та же ревизия протокола, те
// же коды JSON-RPC, тот же `isError` у отказа инструмента, тот же корень из
// `CLAUDE_PROJECT_DIR`. Своя копия JSON-RPC, а не SDK: SDK и `zod` разрешены
// только единице `mcp/` (карта шага «Граница runtime-зависимостей» в
// `ci.yml`, ADR 2026-09-23-1227, п. 2). Это пятая копия в проекте после
// `mcpnews/src/rpc.js`, `mcpstore`, `rag/rpc.py` и `mcpgit`; цена границы
// названа в ADR 2026-09-28-0736, п. 3.
//
// Чем этот сервер отличается от `mcpgit`: у инструментов ЕСТЬ аргументы, и
// один из них пишет на диск. Отсюда две преграды, обе ниже с тестами:
//   1. Любой путь из запроса проходит `resolveInRoot` — лексическую проверку
//      и сверку `realpath` с корнем. Вне корня, в `.git/` и в файлах `.env*`
//      чтения нет вовсе (ключ в `.env` на ноутбуке существует; I-1, I-3).
//   2. Писать можно ровно в два места: `agent_docs/backlog/<имя>.md`, откуда
//      пункт уходит, и `agent_docs/backlog-closed.md`, куда он приходит.
//      Путь записи из запроса НЕ собирается: имя файла бэклога сверяется с
//      закрытым шаблоном и каталогом, второй путь — литерал.
//
// Воспроизводимость — свойство `backlog.close`: повторный вызов с тем же
// якорем на том же дереве ничего не пишет и отвечает `changed: false`.
//
// Процесс локальный: его запускает Claude Code на ноутбуке по `.mcp.json`.
// В образы и в `deploy/compose.yml` он не входит, на VPS его нет. Ключей и
// сети у единицы нет — платного вызова она не делает.

import { createInterface } from 'node:readline'
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PROTOCOL_VERSION = '2025-11-25'
export const SERVER_INFO = { name: 'ai-advent-2026-files', version: '1.0.0' }

/** Коды JSON-RPC — то же подмножество, что у `mcpgit/server.mjs`. */
export const CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
}

/** Каталог корпуса документов: единственное, где ищет `docs.search`. */
export const DOCS_DIR = 'agent_docs'
/** Каталог тематических файлов очереди — единственный источник пунктов. */
export const BACKLOG_DIR = 'agent_docs/backlog'
/** Файл архива закрытых пунктов — литерал, из запроса не собирается. */
export const CLOSED_FILE = 'agent_docs/backlog-closed.md'

/** Строк за одно чтение: ответ — для модели, а не для файловой системы. */
export const MAX_READ_LINES = 400
/** Байт за одно чтение файла с диска. */
export const MAX_READ_BYTES = 256 * 1024
/** Находок поиска за один вызов. */
export const MAX_SEARCH_RESULTS = 50
/** Знаков выдержки у одной находки. */
export const MAX_EXCERPT = 200
/** Пунктов в ответе `backlog.list`. */
export const MAX_ITEMS = 300
/** Знаков текста пункта в ответе `backlog.list`. */
export const MAX_ITEM_TEXT = 300
/** Короче этого якорь не принимается: он адресует правку файла. */
export const MIN_ANCHOR = 12
/** Знаков в примечании закрытия. */
export const MAX_NOTE = 2000

/**
 * Корень репозитория: переменная Claude Code, иначе каталог процесса.
 * Из запроса путь не берётся никогда.
 */
export function projectRoot(env = process.env, cwd = process.cwd()) {
  const dir = env.CLAUDE_PROJECT_DIR
  return typeof dir === 'string' && dir !== '' ? dir : cwd
}

/** Отказ инструмента с понятным текстом. Протокол при этом целый. */
class ToolError extends Error {}
const fail = (message) => {
  throw new ToolError(message)
}

/**
 * Единственная дверь к файловой системе для путей из запроса. Проверок
 * ровно две, и ни одна не дублирует другую:
 *   — сверка `realpath` пути с `realpath` корня. Она закрывает ВСЕ три формы
 *     выхода наружу: сегмент `..`, абсолютный путь и симлинк, который
 *     лексически выглядит внутренним. Лексической проверки сверх неё нет
 *     намеренно: она была бы той же защитой во втором месте, то есть её
 *     снятие оставляло бы прогон зелёным (I-14);
 *   — закрытые имена (`.git`, `.env*`) по РАЗРЕШЁННОМУ пути: чтение чужого
 *     внутри корня. `.env` на ноутбуке существует и несёт ключи (I-1, I-3),
 *     и проверка стоит после `realpath` — симлинком её не обойти.
 *
 * Несуществующий путь до проверок не доходит: `realpath` его не видит, и
 * ответ — «файл не найден». Читать в этом случае всё равно нечего.
 */
export function resolveInRoot(root, value, { label = 'путь' } = {}) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label}: ожидалась непустая строка`)
  const raw = value.trim()
  const realRoot = realpathSync(root)
  let real = null
  try {
    real = realpathSync(resolve(realRoot, raw))
  } catch {
    fail(`${label}: файл не найден — ${cut(raw, 120)}`)
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    fail(`${label} вне корня репозитория: «${cut(raw, 120)}» ведёт за пределы проекта`)
  }
  const rel = relative(realRoot, real)
  for (const part of rel.split(sep)) {
    if (part === '.git') fail(`${label} закрыт для чтения: каталог .git`)
    if (part.startsWith('.env')) fail(`${label} закрыт для чтения: файлы .env* несут секреты`)
  }
  return { abs: real, rel: rel.split(sep).join('/') }
}

const cut = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value)

function readText(abs, rel) {
  const info = statSync(abs)
  if (!info.isFile()) fail(`путь: это не файл — ${rel}`)
  if (info.size > MAX_READ_BYTES) fail(`файл больше ${MAX_READ_BYTES} байт — ${rel}`)
  return readFileSync(abs, 'utf8')
}

const HEADING = /^(#{1,6})\s+(.*)$/u

/**
 * Границы раздела по заголовку: от найденного заголовка до следующего
 * того же или более высокого уровня. Неоднозначный заголовок — ОТКАЗ, а не
 * первый подходящий: правка и цитата адресуются разделом, и «какой-то из
 * двух» здесь означает «неизвестно какой».
 */
export function sectionRange(lines, needle) {
  const want = needle.trim().toLowerCase()
  const hits = []
  for (const [i, line] of lines.entries()) {
    const m = HEADING.exec(line)
    if (m && m[2].toLowerCase().includes(want)) hits.push({ index: i, level: m[1].length, title: m[2] })
  }
  if (hits.length === 0) fail(`раздел не найден: «${cut(needle, 120)}»`)
  if (hits.length > 1) {
    fail(`раздел «${cut(needle, 120)}» подходит к ${hits.length} заголовкам (${hits.map((h) => `${h.index + 1}: ${cut(h.title, 60)}`).join('; ')}) — уточните`)
  }
  const [hit] = hits
  let end = lines.length
  for (let i = hit.index + 1; i < lines.length; i += 1) {
    const m = HEADING.exec(lines[i])
    if (m && m[1].length <= hit.level) {
      end = i
      break
    }
  }
  return { from: hit.index + 1, to: end, title: hit.title }
}

/** Чтение файла или одного его раздела. Нумерация строк — с единицы. */
function docsRead(root, args) {
  const { rel, abs } = resolveInRoot(root, args?.path)
  const lines = readText(abs, rel).split('\n')
  let from = 1
  let to = lines.length
  let title = null
  if (args?.section !== undefined && args.section !== null) {
    if (typeof args.section !== 'string' || args.section.trim() === '') fail('section: ожидалась непустая строка')
    const range = sectionRange(lines, args.section)
    from = range.from
    to = range.to
    title = range.title
  }
  const slice = lines.slice(from - 1, to)
  const truncated = slice.length > MAX_READ_LINES
  const kept = slice.slice(0, MAX_READ_LINES)
  return {
    path: rel,
    section: title,
    from,
    to: from + kept.length - 1,
    truncated,
    text: kept.join('\n'),
  }
}

/** Файлы `.md` корпуса в устойчивом порядке: обход детерминирован. */
export function markdownFiles(dirAbs, relPrefix = '') {
  const out = []
  for (const entry of readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.')) continue
    const childRel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...markdownFiles(join(dirAbs, entry.name), childRel))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push({ abs: join(dirAbs, entry.name), rel: childRel })
  }
  return out
}

/**
 * Поиск подстроки по корпусу `agent_docs/`. Подстрока, а не выражение:
 * регулярное выражение из запроса — и чужой ввод в движке, и неустойчивый
 * результат. Регистр не учитывается, порядок — по пути и строке.
 */
function docsSearch(root, args) {
  const query = args?.query
  if (typeof query !== 'string' || query.trim().length < 3) fail('query: ожидалась строка не короче 3 знаков')
  let limit = 10
  if (args?.limit !== undefined && args.limit !== null) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_SEARCH_RESULTS) {
      fail(`limit: ожидалось целое от 1 до ${MAX_SEARCH_RESULTS}`)
    }
    limit = args.limit
  }
  const needle = query.trim().toLowerCase()
  const realRoot = realpathSync(root)
  const matches = []
  let total = 0
  for (const file of markdownFiles(join(realRoot, DOCS_DIR), DOCS_DIR)) {
    const info = statSync(file.abs)
    if (info.size > MAX_READ_BYTES) continue
    const lines = readFileSync(file.abs, 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue
      total += 1
      if (matches.length < limit) matches.push({ path: file.rel, line: i + 1, text: cut(line.trim(), MAX_EXCERPT) })
    }
  }
  return { query: query.trim(), scope: DOCS_DIR, matches, total, truncated: total > matches.length }
}

const OPEN_ITEM = /^- \[ \] /u

/**
 * Блок пункта: строка `- [ ] …` и её продолжение до следующего пункта,
 * заголовка или пустой строки за последней содержательной. Пункты очереди
 * бывают многострочными, и половина пункта в архиве — потерянный текст.
 */
export function openItems(lines) {
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!OPEN_ITEM.test(lines[i])) continue
    let end = i + 1
    while (end < lines.length && lines[end].trim() !== '' && !lines[end].startsWith('- [') && !lines[end].startsWith('#')) end += 1
    out.push({ from: i, to: end, text: lines.slice(i, end).join('\n') })
    i = end - 1
  }
  return out
}

/** Один абзац из многострочного пункта: архив хранит его одной строкой. */
const oneLine = (text) => text.replace(/^- \[ \] /u, '').split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' ')

/** Открытые пункты всех тематических файлов очереди. */
function backlogList(root) {
  const realRoot = realpathSync(root)
  const dir = join(realRoot, BACKLOG_DIR)
  const items = []
  let total = 0
  for (const file of markdownFiles(dir, BACKLOG_DIR)) {
    const lines = readFileSync(file.abs, 'utf8').split('\n')
    for (const item of openItems(lines)) {
      total += 1
      if (items.length < MAX_ITEMS) {
        items.push({ file: file.rel, line: item.from + 1, text: cut(oneLine(item.text), MAX_ITEM_TEXT) })
      }
    }
  }
  return { dir: BACKLOG_DIR, items, total, truncated: total > items.length }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u
/** Имя тематического файла очереди. Путь из этого имени не собирается. */
const BACKLOG_NAME = /^[a-z0-9-]+\.md$/u

/**
 * Вставка закрытого пункта в архив: в начало раздела своего месяца, иначе
 * новым разделом перед первым существующим (разделы идут от свежего к
 * старому). Возвращает новый текст и имя раздела.
 */
export function insertClosed(text, month, entry) {
  const lines = text.split('\n')
  const heading = `## ${month}`
  const at = lines.findIndex((l) => l.trim() === heading)
  if (at !== -1) {
    // Сразу за заголовком, через пустую строку, как в существующем архиве.
    const body = [...entry.split('\n'), '']
    const insertAt = lines[at + 1]?.trim() === '' ? at + 2 : at + 1
    lines.splice(insertAt, 0, ...body)
    return { text: lines.join('\n'), section: heading, created: false }
  }
  const first = lines.findIndex((l) => l.startsWith('## '))
  const block = [heading, '', ...entry.split('\n'), '']
  if (first === -1) {
    const tail = lines.at(-1) === '' ? lines.slice(0, -1) : lines
    return { text: [...tail, '', ...block].join('\n'), section: heading, created: true }
  }
  lines.splice(first, 0, ...block)
  return { text: lines.join('\n'), section: heading, created: true }
}

/**
 * Единственная правка, которую умеет сервер: перенос открытого пункта из
 * `agent_docs/backlog/<файл>.md` в `agent_docs/backlog-closed.md` по
 * правилам очереди (`agent_docs/backlog.md`, шапка): `- [x]` — выполнено,
 * `- [~]` — снят как ошибочный.
 *
 * ВОСПРОИЗВОДИМОСТЬ. Якорь ищется сначала в архиве, и это не формальность:
 *   — якорь уже в архиве и пункта в очереди нет → `changed: false`, ни один
 *     файл не открывается на запись. Второй прогон того же сценария даёт
 *     пустой `git diff` — это и проверяет тест;
 *   — якорь в архиве И пункт ещё открыт → ОТКАЗ. Такое состояние возможно
 *     только после сбоя между двумя записями, и тихий повторный перенос
 *     сделал бы в архиве два пункта из одного.
 *
 * Порядок записи — сначала архив, потом вычерк из очереди. Он выбран по
 * цене отказа посередине: «пункт в обоих файлах» виден и правится, «пункт
 * нигде» — потерянный текст. Двух файлов одной операцией не записать, и
 * притворяться, что это атомарно, здесь нечем.
 */
function backlogClose(root, args) {
  const realRoot = realpathSync(root)

  const name = args?.file
  if (typeof name !== 'string' || !BACKLOG_NAME.test(name)) {
    fail(`file: ожидалось имя файла очереди вида «process.md» внутри ${BACKLOG_DIR}/, получено «${cut(String(name), 120)}»`)
  }
  const item = resolveInRoot(root, `${BACKLOG_DIR}/${name}`, { label: 'file' })

  const anchor = args?.anchor
  if (typeof anchor !== 'string' || anchor.trim().length < MIN_ANCHOR) {
    fail(`anchor: ожидалась строка не короче ${MIN_ANCHOR} знаков — якорь адресует правку файла`)
  }
  const note = args?.note
  if (typeof note !== 'string' || note.trim() === '') fail('note: ожидалось непустое примечание закрытия')
  if (note.length > MAX_NOTE) fail(`note: длиннее ${MAX_NOTE} знаков`)
  const date = args?.date
  if (typeof date !== 'string' || !DATE.test(date)) fail('date: ожидалась дата вида ГГГГ-ММ-ДД (UTC)')
  const kind = args?.kind === undefined || args.kind === null ? 'done' : args.kind
  if (kind !== 'done' && kind !== 'dropped') fail('kind: ожидалось «done» (выполнено) или «dropped» (снят как ошибочный)')

  const needle = anchor.trim()
  const closed = resolveInRoot(root, CLOSED_FILE, { label: 'архив' })
  const closedText = readText(closed.abs, closed.rel)
  const alreadyClosed = closedText.includes(needle)

  const lines = readText(item.abs, item.rel).split('\n')
  const hits = openItems(lines).filter((block) => block.text.includes(needle))

  if (alreadyClosed && hits.length === 0) {
    return { changed: false, reason: 'already-closed', file: item.rel, closedFile: closed.rel, anchor: needle }
  }
  if (alreadyClosed) {
    fail(`якорь уже стоит в ${closed.rel}, а пункт в ${item.rel} ещё открыт (строка ${hits[0].from + 1}) — разберите вручную, иначе в архиве будет два пункта из одного`)
  }
  if (hits.length === 0) fail(`пункт не найден: в ${item.rel} нет открытого пункта с «${cut(needle, 120)}», в ${closed.rel} его тоже нет`)
  if (hits.length > 1) {
    fail(`якорь «${cut(needle, 120)}» подходит к ${hits.length} открытым пунктам ${item.rel} (строки ${hits.map((h) => h.from + 1).join(', ')}) — уточните`)
  }

  const [hit] = hits
  const mark = kind === 'done' ? 'x' : '~'
  // Исходный текст переносится, а не выбрасывается, и это не украшение:
  // по нему якорь находится в архиве на втором прогоне.
  const entry = `- [${mark}] ${date} — ${note.trim()}\n  Исходный текст: ${oneLine(hit.text)}`
  const inserted = insertClosed(closedText, date.slice(0, 7), entry)

  const rest = [...lines]
  let cutTo = hit.to
  // Пустая строка-разделитель уходит вместе с пунктом: иначе в очереди
  // остаются две пустые строки подряд и файл меняется больше, чем нужно.
  if (rest[cutTo]?.trim() === '' && rest[hit.from - 1]?.trim() === '') cutTo += 1
  rest.splice(hit.from, cutTo - hit.from)

  writeFileSync(closed.abs, inserted.text)
  writeFileSync(item.abs, rest.join('\n'))

  return {
    changed: true,
    file: item.rel,
    line: hit.from + 1,
    closedFile: closed.rel,
    section: inserted.section,
    sectionCreated: inserted.created,
    closedAs: `- [${mark}]`,
    anchor: needle,
  }
}

/** Четыре инструмента: три читают, один пишет. */
export function buildTools(root) {
  return [
    {
      name: 'docs.read',
      title: 'Прочитать файл или раздел',
      description:
        'Текст файла репозитория по относительному пути; с `section` — только один раздел по заголовку. Отдаёт номера строк (from/to) для ссылок вида путь:строка.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь от корня репозитория, например agent_docs/snapshot.md' },
          section: { type: 'string', description: 'Подстрока заголовка раздела; неоднозначная — отказ' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      run: (args) => docsRead(root, args),
    },
    {
      name: 'docs.search',
      title: 'Найти строку в agent_docs',
      description: 'Поиск подстроки (без учёта регистра) по всем *.md внутри agent_docs/. Отдаёт путь, номер строки и выдержку.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Подстрока не короче 3 знаков; не регулярное выражение' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Сколько находок отдать, по умолчанию 10' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: (args) => docsSearch(root, args),
    },
    {
      name: 'backlog.list',
      title: 'Открытые пункты бэклога',
      description: 'Открытые пункты (- [ ]) всех файлов agent_docs/backlog/ с именем файла и номером строки. Аргументов нет.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => backlogList(root),
    },
    {
      name: 'backlog.close',
      title: 'Отметить пункт бэклога закрытым',
      description:
        'Переносит один открытый пункт из agent_docs/backlog/<file> в agent_docs/backlog-closed.md: - [x] выполнено, - [~] снят как ошибочный. Повторный вызов с тем же якорем ничего не меняет и отвечает changed: false.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Имя файла очереди, например process.md' },
          anchor: { type: 'string', description: `Подстрока пункта, не короче ${MIN_ANCHOR} знаков; должна подходить ровно к одному` },
          note: { type: 'string', description: 'Примечание закрытия: что сделано и чем это подтверждено' },
          date: { type: 'string', description: 'Дата закрытия ГГГГ-ММ-ДД (UTC)' },
          kind: { type: 'string', enum: ['done', 'dropped'], description: 'done — выполнено (по умолчанию), dropped — снят как ошибочный' },
        },
        required: ['file', 'anchor', 'note', 'date'],
        additionalProperties: false,
      },
      run: (args) => backlogClose(root, args),
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
        try {
          const result = await tool.run(message.params?.arguments ?? {})
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
 * получит мусор вместо JSON-RPC. Строки обрабатываются по очереди: правка
 * файла не должна идти параллельно второй правке того же файла.
 */
export function serveStdio({ input = process.stdin, output = process.stdout, root = projectRoot() } = {}) {
  const handleOne = createRpc({ tools: buildTools(root) })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let queue = Promise.resolve()

  lines.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    queue = queue
      .then(async () => {
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
      .catch((error) => {
        // Сбой одного звена не отравляет очередь: без `catch` отказ записи
        // оставил бы КАЖДУЮ следующую строку без ответа молча (урок
        // `mcpgit`, находка reviewer к PR #350).
        try {
          process.stderr.write(`mcpfiles: строка не обработана: ${String(error?.message ?? error)}\n`)
        } catch {
          // Писать больше некуда. Важно одно: очередь остаётся исполнимой.
        }
      })
  })

  return lines
}

// Запуск как программы; при импорте из теста — ничего не делает.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio()
}
