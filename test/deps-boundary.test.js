// Шаг «Граница runtime-зависимостей» из .github/workflows/ci.yml исполняется
// здесь как есть: тело шага вырезается из workflow и запускается под `bash -e`
// во временном каталоге. Проверяется поведение стража, а не его копия
// (тот же приём, что в test/secrets-step.test.js).
//
// Страж — механизм границы из ADR 2026-09-23-1227, п. 2: зависимости
// разрешены только в единице mcp/ и только для пакетов протокола. Приманки
// ниже — постоянные, а не разовые: правило, показанное красным только один
// раз руками, назавтра снова становится прозой.
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
  assert.match(run.output, /вне списка исключения/)
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
  assert.match(run.output, /вне списка исключения/)
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
})

test('настоящее дерево репозитория проходит', () => {
  const run = spawnSync('bash', ['-e', '-c', script], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
})
