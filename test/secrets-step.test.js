// Шаг «Секреты не попали в репозиторий» из .github/workflows/docs-guard.yml
// исполняется здесь как есть: тело шага вырезается из workflow и запускается
// под `bash -e` во временном каталоге. Так проверяется поведение гейта, а не
// его копия (ADR 2026-09-12-0440, раздел 3).
//
// Плюс сверка выражения гейта со списком образцов инструмента
// (`node build.js --samples`), когда клон инструмента доступен: в job `guard`
// это всегда, локально — после .github/scripts/atlas-tool.sh. Литерал SAMPLES
// ниже — запасной страж на случай, когда инструмента нет; он записан в той же
// форме, что и у инструмента, иначе два пути сверки сравнивали бы разное.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = join(ROOT, '.github/workflows/docs-guard.yml')
const STEP = 'Секреты не попали в репозиторий'

/** Те же образцы, что KEY_SAMPLES инструмента: буква префикса в классе `[k]`. */
const SAMPLES = [
  's[k]-ant-[A-Za-z0-9_-]{10,}',
  'BEGIN [A-Z0-9 ]*PRIVATE KEY',
  'gs[k]_[A-Za-z0-9]{20,}',
  '(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}',
  '(^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}',
]

/** Тело `run:` шага по его имени: строки блока без общего отступа. */
export function stepScript(workflow, name) {
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

/**
 * Выражение `grep -E '…'` шага, разобранное на образцы: `|` внутри скобок и
 * классов — часть образца, а не разделитель (у токенов GitHub он такой).
 */
export function stepSamples(script) {
  const match = script.match(/grep -rIl --exclude-dir=\.git -E '([^']*)'/)
  assert.notEqual(match, null, 'в шаге не найдено выражение grep -E')
  const out = []
  let current = ''
  let depth = 0
  let klass = false
  for (let i = 0; i < match[1].length; i += 1) {
    const ch = match[1][i]
    if (ch === '\\') {
      current += ch + match[1][i + 1]
      i += 1
      continue
    }
    if (klass) {
      if (ch === ']') klass = false
    } else if (ch === '[') klass = true
    else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === '|' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

const script = stepScript(readFileSync(WORKFLOW, 'utf8'), STEP)

/** Шаг в отдельном каталоге: он сканирует `.`, то есть свой рабочий каталог. */
function runStep(prepare) {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-step-'))
  try {
    const file = join(dir, 'step.sh')
    writeFileSync(file, script)
    prepare?.(dir)
    const run = spawnSync('bash', ['-e', file], { cwd: dir, encoding: 'utf8' })
    return { ...run, output: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('чистый каталог — код 0 и «ok»', () => {
  const run = runStep((dir) => writeFileSync(join(dir, 'README.md'), '# документ без ключей\n'))
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /ok: ключей не найдено/)
})

test('образец ключа — код 1, в выводе имя файла и нет тела ключа', () => {
  // Ключ собран из кусков: иначе этот файл сам стал бы находкой гейта.
  const key = `${['sk', 'ant', 'api03'].join('-')}-${'A1b2C3d4E5f6G7h8'}`
  const run = runStep((dir) => writeFileSync(join(dir, 'leak.md'), `ключ: ${key}\n`))
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /похожий на реальный API-ключ/)
  assert.match(run.output, /leak\.md/)
  assert.equal(run.output.includes(key), false, 'тело ключа ушло в журнал Actions')
  assert.equal(run.output.includes('A1b2C3d4E5f6G7h8'), false, 'хвост ключа ушло в журнал Actions')
})

test('нечитаемый файл — grep возвращает 2, шаг падает и говорит об этом', () => {
  const run = runStep((dir) => {
    const file = join(dir, 'unreadable.md')
    writeFileSync(file, 'текст\n')
    chmodSync(file, 0o000)
  })
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /проверка секретов не выполнилась: grep вернул код 2/)
})

test('выражение шага совпадает с литералом образцов', () => {
  assert.deepEqual(stepSamples(script), SAMPLES)
})

test('выражение шага совпадает со списком инструмента (--samples)', (t) => {
  const tool = process.env.ATLAS_TOOL
  if (!tool) {
    t.skip('ATLAS_TOOL не задан — сверка с инструментом пропущена, остаётся литерал')
    return
  }
  const run = spawnSync('node', [join(tool, 'build.js'), '--samples'], { encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  assert.deepEqual(stepSamples(script), run.stdout.trimEnd().split('\n'))
})
