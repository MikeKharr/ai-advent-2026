// Шаг «Граница runtime-зависимостей» из .github/workflows/ci.yml исполняется
// здесь как есть: тело шага вырезается из workflow и запускается под `bash -e`
// во временном каталоге. Проверяется поведение стража, а не его копия
// (тот же приём, что в test/secrets-step.test.js).
//
// Страж — механизм границы из ADR 2026-09-07-1525, в форме карты «единица →
// точные имена пакетов» (ADR 2026-09-29-1639, п. 1): зависимость разрешена
// только той единице и только на тот пакет, которые названы в карте самого
// шага; умолчание для всех прочих — ноль. Приманки ниже — постоянные, а не
// разовые: правило, показанное красным только один раз руками, назавтра
// снова становится прозой.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml')
const STEP = 'Граница runtime-зависимостей'

/** Тело `run:` шага по его имени: строки блока без общего отступа. */
function stepScript(workflow, name) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line.trimStart().startsWith('- name:') && line.includes(name))
  assert.notEqual(start, -1, `шаг «${name}» не найден в ${WORKFLOW}`)
  const runAt = lines.findIndex((line, i) => i > start && line.trimStart().startsWith('run: |'))
  assert.notEqual(runAt, -1, `у шага «${name}» нет блока run: |`)
  const indent = lines[runAt].search(/\S/) + 2
  const body = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break
    body.push(line.slice(indent))
  }
  return `${body.join('\n').replace(/\s+$/, '')}\n`
}

const script = stepScript(readFileSync(WORKFLOW, 'utf8'), STEP)

/** Шаг в отдельном каталоге: он сканирует `.`, то есть свой рабочий каталог. */
function runStep(files) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-boundary-'))
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true })
      writeFileSync(join(dir, path), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`)
    }
    const file = join(dir, 'step.sh')
    writeFileSync(file, script)
    const run = spawnSync('bash', ['-e', file], { cwd: dir, encoding: 'utf8' })
    return { ...run, output: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SDK = '@modelcontextprotocol/sdk'
const CLEAN = {
  'agents/package.json': { name: 'agents' },
  'router/package.json': { name: 'router' },
  'days/day16/package.json': { name: 'day16' },
  'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: '1.30.0', zod: '4.6.5' } },
}

test('дерево по правилам — код 0', () => {
  const run = runStep(CLEAN)
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /граница зависимостей ok/)
})

test('приманка: dependencies у чужой единицы — код 1 и имя файла', () => {
  const run = runStep({ ...CLEAN, 'days/day16/package.json': { name: 'day16', dependencies: { express: '5.1.0' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /days\/day16\/package\.json/)
  assert.match(run.output, /express/)
})

test('приманка: зависимость в mcp вне списка — код 1', () => {
  const run = runStep({ ...CLEAN, 'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: '1.30.0', zod: '4.6.5', express: '5.1.0' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /вне карты единицы mcp/)
})

test('приманка: диапазон вместо точной версии — код 1', () => {
  const run = runStep({ ...CLEAN, 'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: '^1.30.0', zod: '4.6.5' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /не точная/)
})

// Разделы-синонимы: `optionalDependencies` ставится тем же `npm ci` и
// доезжает до прод-образа, `peerDependencies` объявляет ту же чужую единицу
// зависимостью. Страж, который читает только `.dependencies`, обходится
// переименованием раздела — приманки ниже это и стерегут.
test('приманка: optionalDependencies у чужой единицы — код 1', () => {
  const run = runStep({ ...CLEAN, 'router/package.json': { name: 'router', optionalDependencies: { express: '5.1.0' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /router\/package\.json/)
  assert.match(run.output, /express/)
})

test('приманка: optionalDependencies в mcp вне списка — код 1', () => {
  const run = runStep({ ...CLEAN, 'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: '1.30.0', zod: '4.6.5' }, optionalDependencies: { hono: '4.9.0' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /вне карты единицы mcp/)
  assert.match(run.output, /hono/)
})

test('приманка: peerDependencies у чужой единицы — код 1', () => {
  const run = runStep({ ...CLEAN, 'agents/package.json': { name: 'agents', peerDependencies: { zod: '4.6.5' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /agents\/package\.json/)
})

test('приманка: «1.30.0 || 2.0.0» — не точная версия, код 1', () => {
  const run = runStep({ ...CLEAN, 'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: '1.30.0 || 2.0.0', zod: '4.6.5' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /не точная/)
})

test('приманка: «1.30.0-beta.1 x» и «=1.30.0» — тоже не точные', () => {
  for (const version of ['1.30.0 x', '=1.30.0', '1.30.0.0', ' 1.30.0']) {
    const run = runStep({ ...CLEAN, 'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: version, zod: '4.6.5' } } })
    assert.equal(run.status, 1, `${version}: ${run.output}`)
    assert.match(run.output, /не точная/)
  }
})

test('предвыпускная точная версия принимается', () => {
  const run = runStep({ ...CLEAN, 'mcp/package.json': { name: 'mcp', dependencies: { [SDK]: '1.31.0-rc.1', zod: '4.6.5' } } })
  assert.equal(run.status, 0, run.output)
})

test('приманка: зависимость в новой единице верхнего уровня — код 1', () => {
  const run = runStep({ ...CLEAN, 'gateway/package.json': { name: 'gateway', dependencies: { hono: '4.9.0' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /gateway\/package\.json/)
})

test('приманка: подкаталог внутри mcp — не mcp/package.json, поблажки нет', () => {
  const run = runStep({ ...CLEAN, 'mcp/vendor/package.json': { name: 'vendor', dependencies: { [SDK]: '1.30.0' } } })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /mcp\/vendor\/package\.json/)
})

test('битый package.json — шаг падает, а не зеленеет', () => {
  const run = runStep({ ...CLEAN, 'router/package.json': '{ не json\n' })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /не разобран/)
})

test('пустое дерево — шаг падает: страж, который ничего не проверил, не «ok»', () => {
  const run = runStep({ 'README.md': '# пусто\n' })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /не проверил ничего/)
  // Условие пустоты — про обе формы сразу: дерево из одних requirements.txt
  // (и наоборот) страж проверяет, а не объявляет пустым.
  assert.match(run.output, /requirements\.txt/)
})

// ── Вторая форма манифеста: requirements.txt (ADR 2026-09-29-1639, п. 1) ──
// Единица rag/ в карте есть, каталога в дереве ещё нет: карта обязана
// работать до его появления, и настоящее дерево остаётся зелёным (тест ниже).

const H1 = `--hash=sha256:${'1'.repeat(64)}`
const H2 = `--hash=sha256:${'2'.repeat(64)}`
const RAG_OK = [
  '# зависимости единицы rag',
  '--require-hashes',
  '--only-binary=:all:',
  `faiss-cpu==1.15.1 ${H1}`,
  `numpy==2.5.3 ${H2}`,
  `packaging==25.0 ${H1}`,
  '',
].join('\n')

test('requirements.txt единицы rag по карте — код 0', () => {
  const run = runStep({ ...CLEAN, 'rag/requirements.txt': RAG_OK })
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /ok: rag\/requirements\.txt — faiss-cpu==1\.15\.1/)
})

test('хэши на строках-продолжениях склеиваются и засчитываются', () => {
  const body = ['--require-hashes', 'faiss-cpu==1.15.1 \\', `    ${H1} \\`, `    ${H2}`, ''].join('\n')
  const run = runStep({ ...CLEAN, 'rag/requirements.txt': body })
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /хэшей: 2/)
})

test('приманка: новая единица с requirements.txt — её нет в карте, код 1', () => {
  const run = runStep({ ...CLEAN, 'scraper/requirements.txt': `requests==2.32.5 ${H1}\n` })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /scraper\/requirements\.txt/)
  assert.match(run.output, /вне карты единицы scraper/)
  assert.match(run.output, /разрешено: ничего/)
})

test('приманка: rag тянет пакет сверх своего списка — код 1', () => {
  const run = runStep({ ...CLEAN, 'rag/requirements.txt': `${RAG_OK}torch==2.9.0 ${H1}\n` })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /torch/)
  assert.match(run.output, /вне карты единицы rag/)
})

test('приманка: карта держит единицу, а не форму — faiss-cpu в mcp красный', () => {
  const run = runStep({ ...CLEAN, 'mcp/requirements.txt': `faiss-cpu==1.15.1 ${H1}\n` })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /вне карты единицы mcp/)
})

test('приманка: версия без == — код 1', () => {
  for (const line of [`faiss-cpu>=1.15.1 ${H1}`, `faiss-cpu ${H1}`, `faiss-cpu~=1.15 ${H1}`]) {
    const run = runStep({ ...CLEAN, 'rag/requirements.txt': `${line}\n` })
    assert.equal(run.status, 1, `${line}: ${run.output}`)
    assert.match(run.output, /версия не закреплена/)
  }
})

test('приманка: точная версия, но без --hash — код 1', () => {
  const run = runStep({ ...CLEAN, 'rag/requirements.txt': 'faiss-cpu==1.15.1\n' })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /нет --hash=sha256/)
})

test('приманка: хэш не того вида — код 1', () => {
  for (const tail of ['--hash=sha256:deadbeef', `--hash=md5:${'1'.repeat(32)}`, `--hash=sha256:${'Z'.repeat(64)}`]) {
    const run = runStep({ ...CLEAN, 'rag/requirements.txt': `faiss-cpu==1.15.1 ${tail}\n` })
    assert.equal(run.status, 1, `${tail}: ${run.output}`)
    assert.match(run.output, /лишний хвост|нет --hash=sha256/)
  }
})

test('приманка: версия не из цифр и точек — код 1', () => {
  for (const version of ['1.15.1rc1', '1', '1.15.*', '1.15.1+local']) {
    const run = runStep({ ...CLEAN, 'rag/requirements.txt': `faiss-cpu==${version} ${H1}\n` })
    assert.equal(run.status, 1, `${version}: ${run.output}`)
    assert.match(run.output, /не точная|версия не закреплена/)
  }
})

test('приманка: -r и --index-url тянут невидимое отсюда — код 1', () => {
  for (const line of ['-r other.txt', '--index-url https://example.invalid/simple', '-e .']) {
    const run = runStep({ ...CLEAN, 'rag/requirements.txt': `${line}\n` })
    assert.equal(run.status, 1, `${line}: ${run.output}`)
    assert.match(run.output, /не читается стражем/)
  }
})

test('приманка: манифест третьей формы — код 1', () => {
  for (const path of ['rag/pyproject.toml', 'rag/Pipfile', 'rag/poetry.lock']) {
    const run = runStep({ ...CLEAN, [path]: '[project]\n' })
    assert.equal(run.status, 1, `${path}: ${run.output}`)
    assert.match(run.output, /манифест неизвестной страже формы/)
  }
})

test('дерево из одних requirements.txt страж проверяет, а не зовёт пустым', () => {
  const run = runStep({ 'rag/requirements.txt': RAG_OK })
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /граница зависимостей ok/)
})

test('настоящее дерево репозитория проходит', () => {
  const run = spawnSync('bash', ['-e', '-c', script], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
})
