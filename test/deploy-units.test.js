// Отбор единиц выкатки — .github/scripts/deploy-units.sh — на настоящем
// дереве git, а не на его описании. Повод: единица mcp требует правки пяти
// мест конвейера, и ошибка в одном молча выкидывает её из выкатки
// (ADR 2026-09-23-1227, «Последствия»). Молчаливый пропуск и ловится здесь:
// каждая проверка ниже краснеет, если имя единицы забыли в отборе.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, '.github/scripts/deploy-units.sh')

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

function write(dir, path, text) {
  mkdirSync(join(dir, dirname(path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}

/** Временный репозиторий с деревом проекта в миниатюре. */
function repo(build) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-units-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  return { dir, build: build?.(dir), commit: (message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD').trim() } }
}

/** Скрипт в этом репозитории: day, base, head. */
function units(dir, day, base, head = 'HEAD') {
  const run = spawnSync('bash', [SCRIPT, day, base, head], { cwd: dir, encoding: 'utf8' })
  return { ...run, output: `${run.stdout}${run.stderr}` }
}

function baseTree(dir) {
  for (const unit of ['router', 'agents', 'atlas', 'mcp', 'days/day1', 'days/day16']) {
    write(dir, `${unit}/Dockerfile`, 'FROM node:22-alpine\n')
    write(dir, `${unit}/server.js`, '// служба\n')
  }
  write(dir, 'mcp/package.json', '{"name":"mcp"}\n')
}

test('единица mcp есть в дереве — она попадает в полный список', () => {
  const r = repo(baseTree)
  r.commit('первый')
  const run = units(r.dir, '', '')
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['agents', 'atlas', 'day1', 'day16', 'mcp', 'router'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('правка только в mcp/ поднимает ровно единицу mcp', () => {
  const r = repo(baseTree)
  const base = r.commit('первый')
  write(r.dir, 'mcp/src/tools.js', '// инструмент\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['mcp'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('правка в другой единице mcp не поднимает', () => {
  const r = repo(baseTree)
  const base = r.commit('первый')
  write(r.dir, 'router/src/policy.js', '// политика\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['router'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('правка только в days/day16/ поднимает ровно единицу day16', () => {
  const r = repo(baseTree)
  const base = r.commit('первый')
  write(r.dir, 'days/day16/public/app.js', '// консоль\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['day16'])
  rmSync(r.dir, { recursive: true, force: true })
})

// День 16 и служба — разные единицы: правка в одной не пересобирает другую,
// но едут они одним PR, и тогда в выкатке должны быть обе.
test('правка в days/day16/ и в mcp/ поднимает обе единицы', () => {
  const r = repo(baseTree)
  const base = r.commit('первый')
  write(r.dir, 'days/day16/server.js', '// день\n')
  write(r.dir, 'mcp/src/tools.js', '// инструмент\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['day16', 'mcp'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('ручной передеплой единицы mcp принимается', () => {
  const r = repo(baseTree)
  r.commit('первый')
  const run = units(r.dir, 'mcp', '')
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['mcp'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('без mcp/Dockerfile единица не выкатывается — имя само по себе ничего не даёт', () => {
  const r = repo((dir) => {
    baseTree(dir)
    rmSync(join(dir, 'mcp/Dockerfile'))
  })
  r.commit('первый')
  const all = units(r.dir, '', '')
  assert.equal(JSON.parse(all.stdout).includes('mcp'), false, all.output)
  const manual = units(r.dir, 'mcp', '')
  assert.equal(manual.status, 1, manual.output)
  assert.match(manual.output, /не единица выкатки/)
  rmSync(r.dir, { recursive: true, force: true })
})

// --- единица rag (ADR 2026-09-29-1639, п. 3) ----------------------------------
// У rag две особенности против остальных единиц. Первая: она попадает в
// выкатку не только от правки своего каталога, но и от правки КОРПУСА —
// документов и кода живых единиц, — потому что корпус едет в образ. Без этого
// свежесть индекса держалась бы на памяти человека. Вторая: регулярка корпуса
// живёт в двух файлах (ci.yml решает «пересобирать», этот скрипт — «выкатывать»),
// и их совпадение держит rag/test/test_corpus.py::CiRegexTest.

function ragTree(dir) {
  baseTree(dir)
  write(dir, 'rag/Dockerfile', 'FROM python:3.12-slim\n')
  write(dir, 'rag/build.py', '# сборка\n')
  write(dir, 'README.md', '# проект\n')
  write(dir, 'days/day1/public/index.html', '<p>день</p>\n')
}

test('rag — единица выкатки: она есть в полном списке', () => {
  const r = repo(ragTree)
  r.commit('первый')
  const run = units(r.dir, '', '')
  assert.equal(run.status, 0, run.output)
  assert.ok(JSON.parse(run.stdout).includes('rag'), run.stdout)
  rmSync(r.dir, { recursive: true, force: true })
})

// Корневой README.md, а не agent_docs/: он в корпусе есть, а в регулярке
// атласа его нет — иначе в ответе стояло бы ещё и `atlas`, и проверка
// перестала бы говорить именно про rag.
test('правка документа в корпусе выкатывает rag — иначе индекс стареет молча', () => {
  const r = repo(ragTree)
  const base = r.commit('первый')
  write(r.dir, 'README.md', '# проект\n\nновый абзац\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(JSON.parse(run.stdout), ['rag'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('правка кода живой единицы выкатывает и её саму, и rag', () => {
  const r = repo(ragTree)
  const base = r.commit('первый')
  write(r.dir, 'router/src/policy.js', '// политика\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.deepEqual(JSON.parse(run.stdout), ['rag', 'router'])
  rmSync(r.dir, { recursive: true, force: true })
})

// Обратная сторона: если бы регулярка ловила всё подряд, обе проверки выше
// были бы зелёными и не значили бы ничего. Дни в корпус не входят — правило
// владельца от 2026-09-08, сданные дни не поддерживаются.
test('правка сданного дня rag НЕ выкатывает: дней в корпусе нет', () => {
  const r = repo(ragTree)
  const base = r.commit('первый')
  write(r.dir, 'days/day1/public/index.html', '<p>другой день</p>\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.deepEqual(JSON.parse(run.stdout), ['day1'])
  rmSync(r.dir, { recursive: true, force: true })
})

test('без rag/Dockerfile правка корпуса никого не выкатывает — имени мало', () => {
  const r = repo((dir) => {
    ragTree(dir)
    rmSync(join(dir, 'rag/Dockerfile'))
  })
  const base = r.commit('первый')
  write(r.dir, 'README.md', '# проект\n\nновый абзац\n')
  r.commit('второй')
  const run = units(r.dir, '', base)
  assert.deepEqual(JSON.parse(run.stdout), [])
  rmSync(r.dir, { recursive: true, force: true })
})
