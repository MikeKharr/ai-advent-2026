// Тесты локального stdio-сервера MCP `mcpgit` (ADR 2026-10-18-1147, раздел
// дня 31, п. 3). Живут в корневом `test/`: он целиком идёт шагом «Данные
// страницы прогресса» в `docs-guard.yml` (`node --test test/*.test.js`) на
// каждом PR, как и прочие тесты уровня проекта там же. Матрица `ci.yml`
// каталог `mcpgit/` вне своего списка имён не видит.
//
// Сервер поднимается НАСТОЯЩИМ дочерним процессом (`node mcpgit/server.mjs`) и
// говорит по stdio: проверяется программа, а не импортированные функции.
// Репозиторий — временный, со своей известной веткой и известными файлами;
// репозиторий самого проекта не трогается, и его текущая ветка на результат
// не влияет (тест о корне из `CLAUDE_PROJECT_DIR` это доказывает отдельно).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SERVER = join(ROOT, 'mcpgit/server.mjs')
const BRANCH = 'feat/probe-31'
const MAX_FILES = 200

let repo
/** Каталог вне репозитория: из него сервер запускается в тестах про корень. */
let elsewhere

const git = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'mcpgit-repo-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'mcpgit-elsewhere-'))

  git(['init', '-b', 'main'], repo)
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(['add', 'base.txt'], repo)
  git(['commit', '-m', 'base'], repo)

  git(['checkout', '-b', BRANCH], repo)
  writeFileSync(join(repo, 'committed-on-branch.txt'), 'branch\n')
  git(['add', 'committed-on-branch.txt'], repo)
  git(['commit', '-m', 'branch'], repo)

  // Незакоммиченные: одна правка отслеживаемого файла и один новый файл.
  writeFileSync(join(repo, 'base.txt'), 'base changed\n')
  writeFileSync(join(repo, 'untracked.txt'), 'new\n')
})

after(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

/**
 * Один сеанс со сервером: отправить объекты JSON-RPC построчно, собрать
 * ответы, закрыть stdin и дождаться выхода процесса. Возвращает разобранные
 * ответы по порядку и текст stderr — в stdout ничего, кроме протокола, быть
 * не должно, и это проверяется отдельным тестом.
 */
function session(requests, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', () => {
      const lines = out.split('\n').filter((line) => line.trim() !== '')
      try {
        resolve({ responses: lines.map((line) => JSON.parse(line)), stderr: err, raw: out })
      } catch (error) {
        reject(new Error(`${error.message}; stdout: ${out.slice(0, 500)}`))
      }
    })
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
    child.stdin.end()
  })
}

const call = (id, name) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
const payload = (response) => JSON.parse(response.result.content[0].text)

test('сервер отвечает на initialize ревизией протокола и представляется', async () => {
  const { responses } = await session([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }], { cwd: repo })
  assert.equal(responses.length, 1)
  assert.equal(responses[0].result.protocolVersion, '2025-11-25')
  assert.equal(responses[0].result.serverInfo.name, 'ai-advent-2026-git')
})

test('tools/list отдаёт ровно два инструмента, оба без аргументов', async () => {
  const { responses } = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], { cwd: repo })
  const tools = responses[0].result.tools
  assert.deepEqual(
    tools.map((t) => t.name),
    ['git.branch', 'git.changed'],
  )
  for (const tool of tools) {
    // Схема без свойств и без `additionalProperties` — обещание «входа нет»
    // в том виде, в каком его читает клиент. Сам сервер аргументы не читает.
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false })
  }
})

test('git.branch отдаёт текущую ветку рабочей копии', async () => {
  const { responses } = await session([call(1, 'git.branch')], { cwd: repo })
  assert.deepEqual(payload(responses[0]), { branch: BRANCH, detached: false })
})

test('git.changed отдаёт незакоммиченные файлы и отличия ветки от main', async () => {
  const { responses } = await session([call(1, 'git.changed')], { cwd: repo })
  const body = payload(responses[0])
  assert.deepEqual(body.working.sort(), ['base.txt', 'untracked.txt'])
  assert.equal(body.base, 'main')
  assert.deepEqual(body.vsBase, ['committed-on-branch.txt'])
  assert.equal(body.vsBaseError, null)
  assert.equal(body.workingTruncated, false)
  assert.equal(body.vsBaseTruncated, false)
})

// Красная ветвь безопасности: аргументы вызова приходят от МОДЕЛИ. Если
// когда-нибудь из них соберут путь или флаг git, этот тест покраснеет —
// ответ перестанет быть ответом о `repo`.
test('аргументы вызова не доходят до git: путь и флаг из запроса игнорируются', async () => {
  const { responses } = await session(
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'git.branch', arguments: { cwd: elsewhere, args: ['--version'], ref: 'HEAD~1' } },
      },
    ],
    { cwd: repo },
  )
  assert.deepEqual(payload(responses[0]), { branch: BRANCH, detached: false })
})

// Каталог берётся из CLAUDE_PROJECT_DIR, а не из cwd процесса: именно так его
// запускает Claude Code по `.mcp.json`. Проверка различает гипотезы — процесс
// стоит в каталоге БЕЗ репозитория, и верный ответ возможен только из
// переменной.
test('корень репозитория берётся из CLAUDE_PROJECT_DIR, а не из каталога процесса', async () => {
  const { responses } = await session([call(1, 'git.branch')], { cwd: elsewhere, env: { CLAUDE_PROJECT_DIR: repo } })
  assert.deepEqual(payload(responses[0]), { branch: BRANCH, detached: false })
})

test('вне репозитория инструмент отказывает как инструмент (isError), а не рвёт протокол', async () => {
  const { responses } = await session([call(1, 'git.branch')], { cwd: elsewhere })
  assert.equal(responses[0].error, undefined)
  assert.equal(responses[0].result.isError, true)
  assert.match(JSON.parse(responses[0].result.content[0].text).error, /git|repo/i)
})

test('неизвестный метод — отказ протокола -32601', async () => {
  const { responses } = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/run' }], { cwd: repo })
  assert.equal(responses[0].error.code, -32601)
})

test('неизвестный инструмент — отказ протокола -32602', async () => {
  const { responses } = await session([call(1, 'git.diff')], { cwd: repo })
  assert.equal(responses[0].error.code, -32602)
})

test('уведомление ответа не получает, и порядок ответов равен порядку запросов', async () => {
  const { responses, stderr } = await session(
    [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      call(1, 'git.branch'),
      call(2, 'git.changed'),
    ],
    { cwd: repo },
  )
  assert.deepEqual(
    responses.map((r) => r.id),
    [1, 2],
  )
  // В stdout — только JSON-RPC: разбор выше уже это доказал (строка-не-JSON
  // уронила бы сеанс). Здесь — что сервер не пишет в stderr без повода.
  assert.equal(stderr, '')
})

test('лимит вывода: больше MAX_FILES имён не отдаётся, остаток помечен truncated', async () => {
  const many = mkdtempSync(join(tmpdir(), 'mcpgit-many-'))
  try {
    git(['init', '-b', 'main'], many)
    writeFileSync(join(many, 'base.txt'), 'base\n')
    git(['add', 'base.txt'], many)
    git(['commit', '-m', 'base'], many)
    for (let i = 0; i < MAX_FILES + 5; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x\n')

    const { responses } = await session([call(1, 'git.changed')], { cwd: many })
    const body = payload(responses[0])
    assert.equal(body.working.length, MAX_FILES)
    assert.equal(body.workingTruncated, true)
  } finally {
    rmSync(many, { recursive: true, force: true })
  }
})

test('без ветки main сравнение честно отказывает, а состояние рабочей копии всё равно приходит', async () => {
  const solo = mkdtempSync(join(tmpdir(), 'mcpgit-solo-'))
  try {
    git(['init', '-b', 'trunk'], solo)
    writeFileSync(join(solo, 'base.txt'), 'base\n')
    git(['add', 'base.txt'], solo)
    git(['commit', '-m', 'base'], solo)
    writeFileSync(join(solo, 'draft.txt'), 'draft\n')

    const { responses } = await session([call(1, 'git.changed')], { cwd: solo })
    const body = payload(responses[0])
    assert.deepEqual(body.working, ['draft.txt'])
    assert.equal(body.vsBase, null)
    assert.match(body.vsBaseError, /main/)
  } finally {
    rmSync(solo, { recursive: true, force: true })
  }
})

test('переименование не смешивает прежнее имя с новым', async () => {
  const moved = mkdtempSync(join(tmpdir(), 'mcpgit-moved-'))
  try {
    git(['init', '-b', 'main'], moved)
    writeFileSync(join(moved, 'old.txt'), 'x\n')
    git(['add', 'old.txt'], moved)
    git(['commit', '-m', 'base'], moved)
    git(['mv', 'old.txt', 'new.txt'], moved)

    const { responses } = await session([call(1, 'git.changed')], { cwd: moved })
    assert.deepEqual(payload(responses[0]).working, ['new.txt'])
  } finally {
    rmSync(moved, { recursive: true, force: true })
  }
})

test('.mcp.json подключает сервер этого каталога', () => {
  const config = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'))
  const entry = config.mcpServers.mcpgit
  assert.ok(entry, '.mcp.json: записи mcpgit нет — сервер в сессии не поднимется')
  assert.equal(entry.type, 'stdio')
  assert.equal(entry.command, 'node')
  assert.deepEqual(entry.args, ['${CLAUDE_PROJECT_DIR:-.}/mcpgit/server.mjs'])
})
