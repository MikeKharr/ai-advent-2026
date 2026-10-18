// Тесты локального stdio-сервера MCP `mcpfiles` (день 34, ADR
// 2026-10-18-2152). Живут в корневом `test/`: он целиком идёт шагом «Данные
// страницы прогресса» в `docs-guard.yml` (`node --test test/*.test.js`) на
// каждом PR, как тесты единицы `mcpgit` и прочие тесты уровня проекта там же.
//
// Сервер поднимается НАСТОЯЩИМ дочерним процессом (`node mcpfiles/server.mjs`)
// и говорит по stdio: проверяется программа, а не импортированные функции.
// Дерево — временный git-репозиторий со своим `agent_docs/`: репозиторий
// самого проекта не трогается ни на чтение, ни на запись.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SERVER = join(ROOT, 'mcpfiles/server.mjs')

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

const write = (dir, rel, text) => {
  mkdirSync(join(dir, dirname(rel)), { recursive: true })
  writeFileSync(join(dir, rel), text)
}

/** Пункт очереди такой же формы, как в репозитории: один абзац, длинный. */
const ITEM_RAG = '- [ ] Владельцу: признак `cited` ищет путь подстрокой и ошибается в обе стороны (q72, q57).'
const ITEM_INDEX = '- [ ] Индекс корпуса пересобирается на каждой выкатке, и прогон замера смешивается.'

/**
 * Дерево под тест: git-репозиторий с `agent_docs/`, снимком, бэклогом из двух
 * тем и архивом с существующим разделом месяца. Коммит — чтобы `git status`
 * показывал ровно то, что сделал сервер.
 */
function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'mcpfiles-tree-'))
  write(dir, 'agent_docs/snapshot.md', ['# Снимок', '', '## Где сейчас работа', '', 'День 34: ассистент над файлами.', '', '## Долги', '', 'Ничего.', ''].join('\n'))
  write(dir, 'agent_docs/backlog.md', ['# Бэклог', '', 'Оглавление очереди.', ''].join('\n'))
  write(dir, 'agent_docs/backlog/rag.md', ['# Бэклог: rag', '', '## Next', '', ITEM_RAG, '', ITEM_INDEX, ''].join('\n'))
  write(dir, 'agent_docs/backlog/process.md', ['# Бэклог: процесс', '', '## Next', '', '- [ ] Владельцу: принять ADR про модель.', ''].join('\n'))
  write(dir, 'agent_docs/backlog-closed.md', ['# Закрытые пункты бэклога', '', 'Архив.', '', '## 2026-10', '', '- [x] 2026-10-08 — прежний закрытый пункт.', ''].join('\n'))
  write(dir, 'agent_docs/development-history/2026-10-18-1200-day34-note.md', ['# Запись', '', 'Признак `cited` исправлен прогоном.', ''].join('\n'))
  // Файл ВНЕ agent_docs с той же подстрокой: он не должен попасть в поиск.
  write(dir, 'README.md', ['# Проект', '', 'Признак `cited` упомянут и здесь.', ''].join('\n'))
  write(dir, '.env', 'RAG_KEY=ключ-которого-не-должно-быть-в-ответе\n')
  git(['init', '-b', 'main'], dir)
  git(['add', '-A'], dir)
  git(['commit', '-m', 'tree'], dir)
  return dir
}

/**
 * Один сеанс со сервером: отправить объекты JSON-RPC построчно, собрать
 * ответы, закрыть stdin и дождаться выхода процесса. Корень передаётся
 * через `CLAUDE_PROJECT_DIR` — ровно так его передаёт Claude Code.
 */
function session(requests, { root, cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root ?? '' },
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
        resolve({ responses: lines.map((line) => JSON.parse(line)), stderr: err })
      } catch (error) {
        reject(new Error(`${error.message}; stdout: ${out.slice(0, 500)}`))
      }
    })
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
    child.stdin.end()
  })
}

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const payload = (response) => JSON.parse(response.result.content[0].text)
const errorOf = (response) => {
  assert.equal(response.error, undefined, 'ожидался отказ инструмента (isError), а пришёл отказ протокола')
  assert.equal(response.result.isError, true, `ожидался isError, пришло: ${JSON.stringify(response.result).slice(0, 300)}`)
  return JSON.parse(response.result.content[0].text).error
}

/** Один вызов инструмента на свежем дереве — короткая запись в тестах. */
async function one(root, name, args) {
  const { responses } = await session([call(1, name, args)], { root })
  return responses[0]
}

const clean = (dir) => rmSync(dir, { recursive: true, force: true })
const status = (dir) => git(['status', '--porcelain'], dir).trim()

test('tools/list отдаёт четыре инструмента: три читающих и один пишущий', async () => {
  const dir = makeTree()
  try {
    const { responses } = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], { root: dir })
    assert.deepEqual(
      responses[0].result.tools.map((t) => t.name),
      ['docs.read', 'docs.search', 'backlog.list', 'backlog.close'],
    )
  } finally {
    clean(dir)
  }
})

test('docs.read отдаёт один раздел с номерами строк', async () => {
  const dir = makeTree()
  try {
    const body = payload(await one(dir, 'docs.read', { path: 'agent_docs/snapshot.md', section: 'Где сейчас работа' }))
    assert.equal(body.path, 'agent_docs/snapshot.md')
    assert.equal(body.section, 'Где сейчас работа')
    assert.equal(body.from, 3)
    assert.match(body.text, /День 34: ассистент над файлами\./u)
    // Следующий раздел в срез не входит: иначе «раздел» ничего не означает.
    assert.doesNotMatch(body.text, /## Долги/u)
    assert.equal(status(dir), '', 'чтение не должно менять дерево')
  } finally {
    clean(dir)
  }
})

test('docs.read: раздела нет — понятная ошибка, дерево не менялось', async () => {
  const dir = makeTree()
  try {
    const message = errorOf(await one(dir, 'docs.read', { path: 'agent_docs/snapshot.md', section: 'Раздела такого нет' }))
    assert.match(message, /раздел не найден/u)
    assert.equal(status(dir), '')
  } finally {
    clean(dir)
  }
})

// Красная ветвь безопасности: путь приходит от МОДЕЛИ. Три формы обхода, и
// каждая проверяется отдельно — лексическая, абсолютная и симлинком, потому
// что ловят их три разных условия `resolveInRoot`.
test('docs.read: путь вне корня репозитория отвергается во всех трёх формах', async () => {
  const dir = makeTree()
  const outside = mkdtempSync(join(tmpdir(), 'mcpfiles-outside-'))
  try {
    writeFileSync(join(outside, 'secret.md'), 'секрет снаружи\n')
    symlinkSync(join(outside, 'secret.md'), join(dir, 'agent_docs/link.md'))

    // Путь СУЩЕСТВУЮЩЕГО файла снаружи, собранный сегментами `..`: иначе
    // отказ пришёл бы по причине «файла нет», и проверка не различала бы
    // гипотезы «защита работает» и «пути просто не существует».
    const upwards = relative(dir, join(outside, 'secret.md'))
    assert.match(upwards, /^\.\./u, `путь наружу собран неверно: ${upwards}`)
    const traversal = errorOf(await one(dir, 'docs.read', { path: upwards }))
    assert.match(traversal, /вне корня репозитория/u)
    assert.doesNotMatch(traversal, /секрет снаружи/u)

    const absolute = errorOf(await one(dir, 'docs.read', { path: join(outside, 'secret.md') }))
    assert.match(absolute, /вне корня репозитория/u)

    // Симлинк лексически внутренний: его ловит только сверка realpath.
    const link = errorOf(await one(dir, 'docs.read', { path: 'agent_docs/link.md' }))
    assert.match(link, /вне корня репозитория/u)
    assert.doesNotMatch(JSON.stringify(link), /секрет снаружи/u)
  } finally {
    clean(dir)
    clean(outside)
  }
})

test('docs.read: .env и .git закрыты, содержимое ключа в ответ не идёт (I-1, I-3)', async () => {
  const dir = makeTree()
  try {
    const env = errorOf(await one(dir, 'docs.read', { path: '.env' }))
    assert.match(env, /\.env/u)
    assert.doesNotMatch(env, /RAG_KEY|ключ-которого/u)

    const head = errorOf(await one(dir, 'docs.read', { path: '.git/HEAD' }))
    assert.match(head, /\.git/u)
  } finally {
    clean(dir)
  }
})

test('docs.search ищет только в agent_docs и отдаёт путь со строкой', async () => {
  const dir = makeTree()
  try {
    const body = payload(await one(dir, 'docs.search', { query: 'признак `cited`' }))
    assert.deepEqual(
      body.matches.map((m) => `${m.path}:${m.line}`),
      ['agent_docs/backlog/rag.md:5', 'agent_docs/development-history/2026-10-18-1200-day34-note.md:3'],
    )
    // `README.md` содержит ту же подстроку и в выдачу не попал: область
    // поиска — корпус документов, а не всё дерево.
    assert.ok(!body.matches.some((m) => m.path === 'README.md'))
    assert.equal(body.scope, 'agent_docs')
  } finally {
    clean(dir)
  }
})

test('docs.search: limit режет выдачу и признаётся в этом', async () => {
  const dir = makeTree()
  try {
    const body = payload(await one(dir, 'docs.search', { query: 'признак `cited`', limit: 1 }))
    assert.equal(body.matches.length, 1)
    assert.equal(body.total, 2)
    assert.equal(body.truncated, true)
  } finally {
    clean(dir)
  }
})

test('backlog.list отдаёт открытые пункты всех тем с файлом и строкой', async () => {
  const dir = makeTree()
  try {
    const body = payload(await one(dir, 'backlog.list', {}))
    assert.deepEqual(
      body.items.map((i) => `${i.file}:${i.line}`),
      ['agent_docs/backlog/process.md:5', 'agent_docs/backlog/rag.md:5', 'agent_docs/backlog/rag.md:7'],
    )
    assert.match(body.items[1].text, /признак `cited`/u)
  } finally {
    clean(dir)
  }
})

test('backlog.close переносит пункт в архив по правилам очереди', async () => {
  const dir = makeTree()
  try {
    const body = payload(
      await one(dir, 'backlog.close', {
        file: 'rag.md',
        anchor: 'признак `cited` ищет путь подстрокой',
        note: 'закрыто прогоном, запись `development-history/2026-10-18-1200-day34-note.md`',
        date: '2026-10-18',
      }),
    )
    assert.equal(body.changed, true)
    assert.equal(body.closedAs, '- [x]')
    assert.equal(body.section, '## 2026-10')
    assert.equal(body.sectionCreated, false)

    const queue = readFileSync(join(dir, 'agent_docs/backlog/rag.md'), 'utf8')
    assert.doesNotMatch(queue, /признак `cited`/u, 'пункт остался в очереди')
    assert.match(queue, /Индекс корпуса/u, 'соседний пункт пострадал')
    assert.doesNotMatch(queue, /\n\n\n/u, 'в очереди осталась лишняя пустая строка')

    const closed = readFileSync(join(dir, 'agent_docs/backlog-closed.md'), 'utf8')
    assert.match(closed, /- \[x\] 2026-10-18 — закрыто прогоном/u)
    // Исходный текст переносится: по нему якорь находится на втором прогоне.
    assert.match(closed, /Исходный текст: Владельцу: признак `cited` ищет путь подстрокой/u)
    assert.match(closed, /- \[x\] 2026-10-08 — прежний закрытый пункт/u, 'прежний архив затёрт')
    // Новый пункт стоит выше прежнего: раздел месяца ведёт свежим.
    assert.ok(closed.indexOf('2026-10-18 — закрыто') < closed.indexOf('2026-10-08 — прежний'))
  } finally {
    clean(dir)
  }
})

test('backlog.close: новый месяц заводит свой раздел перед существующими', async () => {
  const dir = makeTree()
  try {
    const body = payload(
      await one(dir, 'backlog.close', {
        file: 'rag.md',
        anchor: 'Индекс корпуса пересобирается',
        note: 'снят как ошибочный: прогон и выкатка разведены вручную',
        date: '2026-11-02',
        kind: 'dropped',
      }),
    )
    assert.equal(body.section, '## 2026-11')
    assert.equal(body.sectionCreated, true)
    assert.equal(body.closedAs, '- [~]')
    const closed = readFileSync(join(dir, 'agent_docs/backlog-closed.md'), 'utf8')
    assert.ok(closed.indexOf('## 2026-11') < closed.indexOf('## 2026-10'))
    assert.match(closed, /- \[~\] 2026-11-02 — снят как ошибочный/u)
  } finally {
    clean(dir)
  }
})

/**
 * «Воспроизводимо» в задании дня — это свойство, а не слово. Сценарий тот же
 * самый: список открытых пунктов → поиск подтверждения в корпусе → закрытие.
 * Первый прогон меняет два файла, второй на том же дереве — НИ ОДНОГО, и
 * `git status` это показывает.
 */
const scenario = (root) =>
  session(
    [
      call(1, 'backlog.list', {}),
      call(2, 'docs.search', { query: 'признак `cited`' }),
      call(3, 'backlog.close', {
        file: 'rag.md',
        anchor: 'признак `cited` ищет путь подстрокой',
        note: 'закрыто прогоном, запись `development-history/2026-10-18-1200-day34-note.md`',
        date: '2026-10-18',
      }),
    ],
    { root },
  )

test('второй прогон того же сценария на том же дереве даёт пустой git diff', async () => {
  const dir = makeTree()
  try {
    const first = await scenario(dir)
    assert.equal(payload(first.responses[2]).changed, true)
    assert.deepEqual(
      status(dir)
        .split('\n')
        .map((l) => l.trim())
        .sort(),
      ['M agent_docs/backlog-closed.md', 'M agent_docs/backlog/rag.md'],
    )
    git(['add', '-A'], dir)
    git(['commit', '-m', 'first run'], dir)

    const second = await scenario(dir)
    const body = payload(second.responses[2])
    assert.equal(body.changed, false)
    assert.equal(body.reason, 'already-closed')
    assert.equal(status(dir), '', 'второй прогон изменил дерево — сценарий не воспроизводим')
    assert.equal(git(['diff'], dir), '')
  } finally {
    clean(dir)
  }
})

test('backlog.close: несуществующий пункт — понятная ошибка без изменений', async () => {
  const dir = makeTree()
  try {
    const message = errorOf(
      await one(dir, 'backlog.close', {
        file: 'rag.md',
        anchor: 'такого пункта в очереди нет',
        note: 'не должно записаться',
        date: '2026-10-18',
      }),
    )
    assert.match(message, /пункт не найден/u)
    assert.match(message, /backlog\/rag\.md/u)
    assert.equal(status(dir), '', 'отказ оставил правку на диске')
  } finally {
    clean(dir)
  }
})

test('backlog.close: два подходящих пункта — отказ с номерами строк, а не «какой-то из двух»', async () => {
  const dir = makeTree()
  try {
    const path = join(dir, 'agent_docs/backlog/rag.md')
    const twin = '- [ ] Владельцу: признак `cited` ошибается и во втором месте.'
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${twin}\n`)
    git(['add', '-A'], dir)
    git(['commit', '-m', 'twin'], dir)

    const message = errorOf(
      await one(dir, 'backlog.close', {
        file: 'rag.md',
        anchor: 'признак `cited`',
        note: 'не должно записаться',
        date: '2026-10-18',
      }),
    )
    assert.match(message, /подходит к 2 открытым пунктам/u)
    assert.equal(status(dir), '')
  } finally {
    clean(dir)
  }
})

test('backlog.close: пункт и в архиве, и в очереди — отказ, а не второй перенос', async () => {
  const dir = makeTree()
  try {
    const path = join(dir, 'agent_docs/backlog-closed.md')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n- [x] 2026-10-18 — признак \`cited\` ищет путь подстрокой: уже закрыт.\n`)
    git(['add', '-A'], dir)
    git(['commit', '-m', 'conflict'], dir)

    const message = errorOf(
      await one(dir, 'backlog.close', {
        file: 'rag.md',
        anchor: 'признак `cited` ищет путь подстрокой',
        note: 'не должно записаться',
        date: '2026-10-18',
      }),
    )
    assert.match(message, /ещё открыт/u)
    assert.equal(status(dir), '', 'при конфликте сервер всё равно что-то записал')
  } finally {
    clean(dir)
  }
})

test('backlog.close: имя файла из запроса не собирает путь — выход из каталога очереди закрыт', async () => {
  const dir = makeTree()
  try {
    for (const file of ['../snapshot.md', '../../README.md', '/etc/hosts', 'rag.txt']) {
      const message = errorOf(await one(dir, 'backlog.close', { file, anchor: 'признак `cited` ищет', note: 'нет', date: '2026-10-18' }))
      assert.match(message, /ожидалось имя файла очереди/u, `имя «${file}» принято`)
    }
    assert.equal(status(dir), '')
  } finally {
    clean(dir)
  }
})

test('backlog.close: кривая дата и пустое примечание отвергаются до записи', async () => {
  const dir = makeTree()
  try {
    const date = errorOf(await one(dir, 'backlog.close', { file: 'rag.md', anchor: 'признак `cited` ищет', note: 'нет', date: '18.10.2026' }))
    assert.match(date, /ГГГГ-ММ-ДД/u)
    const note = errorOf(await one(dir, 'backlog.close', { file: 'rag.md', anchor: 'признак `cited` ищет', note: '  ', date: '2026-10-18' }))
    assert.match(note, /примечание/u)
    const anchor = errorOf(await one(dir, 'backlog.close', { file: 'rag.md', anchor: 'cited', note: 'нет', date: '2026-10-18' }))
    assert.match(anchor, /не короче 12/u)
    assert.equal(status(dir), '')
  } finally {
    clean(dir)
  }
})

test('неизвестный метод — -32601, неизвестный инструмент — -32602', async () => {
  const dir = makeTree()
  try {
    const { responses } = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/run' }, call(2, 'docs.write')], { root: dir })
    assert.equal(responses[0].error.code, -32601)
    assert.equal(responses[1].error.code, -32602)
  } finally {
    clean(dir)
  }
})

test('корень берётся из CLAUDE_PROJECT_DIR, а не из каталога процесса', async () => {
  const dir = makeTree()
  const elsewhere = mkdtempSync(join(tmpdir(), 'mcpfiles-elsewhere-'))
  try {
    // Процесс стоит в каталоге БЕЗ agent_docs: верный ответ возможен только
    // из переменной — проверка различает гипотезы.
    const { responses } = await session([call(1, 'backlog.list', {})], { root: dir, cwd: elsewhere })
    assert.equal(payload(responses[0]).items.length, 3)
  } finally {
    clean(dir)
    clean(elsewhere)
  }
})

test('.mcp.json подключает сервер этого каталога', () => {
  const config = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'))
  const entry = config.mcpServers.mcpfiles
  assert.ok(entry, '.mcp.json: записи mcpfiles нет — сервер в сессии не поднимется')
  assert.equal(entry.type, 'stdio')
  assert.equal(entry.command, 'node')
  assert.deepEqual(entry.args, ['${CLAUDE_PROJECT_DIR:-.}/mcpfiles/server.mjs'])
})
