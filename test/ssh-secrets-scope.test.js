// Страж «SSH-секреты читаются только в окружении production» (ADR
// 2026-10-18-1300). Формы доступа к секрету разбираются регулярными
// выражениями, а в них легко промахнуться мимо случая — отсюда тест на
// `namedIn` (просьба владельца к PR #352).
//
// Что проверяется, помимо отдельных форм:
//   - оптовые формы краснеют В ЛЮБОМ job, включая job с окружением:
//     это и есть то, чем они отличаются от именованных;
//   - проза «secrets.SSH_*» в комментарии стражем НЕ считается ссылкой —
//     иначе он краснел бы на собственном объяснении;
//   - CLI краснеет на пустоте и печатает `::error::`, а не стек Node.
//
// Скрипт запускается и как модуль, и как CLI — тем же способом, что в шаге
// docs-guard: `node .github/scripts/ssh-secrets-scope.mjs` из корня дерева.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ENVIRONMENT, WORKFLOWS, namedIn, parseJobs, problems } from '../.github/scripts/ssh-secrets-scope.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, '.github/scripts/ssh-secrets-scope.mjs')

/** Дерево с заданными workflow — как его видел бы страж в CI. */
function treeWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-secrets-scope-'))
  mkdirSync(join(dir, WORKFLOWS), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, WORKFLOWS, name), text)
  return dir
}

/** Прогон CLI из корня дерева. */
function run(cwd) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })
}

/** Один job с заданным телом; `environment` опускается значением null. */
function workflow(jobName, environment, ...steps) {
  const env = environment === null ? '' : `    environment: ${environment}\n`
  return `on: push\njobs:\n  ${jobName}:\n    runs-on: ubuntu-latest\n${env}    steps:\n${steps.map((s) => `      - run: ${s}\n`).join('')}`
}

const files = (text) => [{ file: `${WORKFLOWS}/w.yml`, text }]

test('namedIn: точечная форма', () => {
  assert.deepEqual(namedIn('  SSH_KEY: ${{ secrets.SSH_KEY }}'), ['SSH_KEY'])
  assert.deepEqual(namedIn('${{ secrets.SSH_HOST }}${{ secrets.SSH_USER }}'), ['SSH_HOST', 'SSH_USER'])
})

test('namedIn: скобочная форма — кавычки любые, пробелы внутри скобок', () => {
  // Ровно тот обход, из-за которого форму и добавили: переписать одну строку
  // из точечной в скобочную — и правило перестаёт действовать.
  assert.deepEqual(namedIn("${{ secrets['SSH_KEY'] }}"), ['SSH_KEY'])
  assert.deepEqual(namedIn('${{ secrets["SSH_KEY"] }}'), ['SSH_KEY'])
  assert.deepEqual(namedIn('${{ secrets[ "SSH_USER" ] }}'), ['SSH_USER'])
  assert.deepEqual(namedIn("${{ secrets[\t'SSH_HOST'\t] }}"), ['SSH_HOST'])
})

test('namedIn: не считается ссылкой то, что секрета не читает', () => {
  // Проза об имени секрета — в комментариях deploy.yml её много.
  assert.deepEqual(namedIn('# SSH_HOST — секрет, и этому имени не равен'), [])
  // Звезда в прозе: из-за `*` вместо `+` страж однажды покраснел на своём же
  // комментарии, и это поведение закреплено тестом, а не памятью.
  assert.deepEqual(namedIn('# ссылка на secrets.SSH_* вне job'), [])
  // Чужие секреты правилу не подчиняются.
  assert.deepEqual(namedIn('${{ secrets.GITHUB_TOKEN }}'), [])
  assert.deepEqual(namedIn('${{ secrets.MODEL_KEYS }}'), [])
  // Префикс без подчёркивания — другое имя.
  assert.deepEqual(namedIn('${{ secrets.SSHKEY }}'), [])
  // Одно подчёркивание без имени — тоже не имя.
  assert.deepEqual(namedIn('${{ secrets.SSH_ }}'), [])
})

test('problems: именованная ссылка в job с окружением production — чисто', () => {
  const text = workflow('deploy', ENVIRONMENT, 'echo "${{ secrets.SSH_KEY }}"')
  assert.deepEqual(problems(files(text)), [])
})

test('problems: окружение отображением (environment: + name:) — чисто', () => {
  const text = [
    'on: push',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    environment:',
    `      name: ${ENVIRONMENT}`,
    '      url: https://challenge.zpq.ai',
    '    steps:',
    '      - run: echo "${{ secrets.SSH_KEY }}"',
  ].join('\n')
  assert.deepEqual(problems(files(text)), [])
})

test('problems: job с другим окружением — находка, и она называет окружение', () => {
  const found = problems(files(workflow('deploy', 'staging', 'echo "${{ secrets.SSH_KEY }}"')))
  assert.equal(found.length, 1)
  assert.match(found[0], /secrets\.SSH_KEY/)
  assert.match(found[0], /environment: staging/)
})

test('problems: job без окружения — находка, отличимая от «окружение не то»', () => {
  const found = problems(files(workflow('exfil', null, 'echo "${{ secrets.SSH_KEY }}"')))
  assert.equal(found.length, 1)
  // Улика обязана различать гипотезы: «нет окружения» и «не то окружение» —
  // разные правки и разные починки.
  assert.match(found[0], /\(нет\)/)
})

test('problems: скобочная форма судится так же, как точечная', () => {
  const found = problems(files(workflow('exfil', null, 'echo "${{ secrets[\'SSH_KEY\'] }}"')))
  assert.equal(found.length, 1)
  assert.match(found[0], /secrets\.SSH_KEY/)
})

test('problems: оптовые формы краснеют даже в job с окружением production', () => {
  // Главное свойство оптовых форм: место их не оправдывает. Имени секрета в
  // тексте нет, и сказать, попал ли в выгрузку SSH-ключ, уже нельзя.
  for (const expr of ['echo "${{ toJSON(secrets) }}"', 'echo "${{ toJson( secrets ) }}"']) {
    const found = problems(files(workflow('deploy', ENVIRONMENT, expr)))
    assert.equal(found.length, 1, expr)
    assert.match(found[0], /toJSON\(secrets\)/)
    assert.match(found[0], /не по имени/)
  }
})

test('problems: secrets: inherit — кавычки и хвостовой комментарий не спасают', () => {
  // Блокирующая reviewer к `38efbfe`: обещание ADR «в любой законной форме»
  // было шире механизма — выражение требовало конца строки сразу после
  // `inherit`, и три законные записи YAML оставались зелёными.
  for (const line of ['    secrets: inherit  # комментарий', '    secrets: "inherit"', "    secrets: 'inherit'"]) {
    const text = ['on: push', 'jobs:', '  call:', '    uses: ./.github/workflows/deploy.yml', line].join('\n')
    const found = problems(files(text))
    assert.equal(found.length, 1, line)
    assert.match(found[0], /secrets: inherit/)
  }
})

test('problems: вычисляемый индекс — безымянная форма, краснеет и в job выкатки', () => {
  // Совет compliance: `secrets[...]` без строкового литерала — то же самое,
  // что toJSON, потому что имени в тексте нет. Проверяется в job С окружением:
  // место такую форму не оправдывает.
  const exprs = [
    "echo \"${{ secrets[format('SSH{0}','_KEY')] }}\"",
    'echo "${{ secrets[env.N] }}"',
    'echo "${{ secrets[matrix.name] }}"',
    // Склейка НАЧИНАЕТСЯ с кавычки, поэтому проверка «первый символ не
    // кавычка» её пропускала бы; мимо NAMED она тоже проходит, так как тот
    // требует закрывающей скобки сразу после литерала.
    'echo "${{ secrets[\'SSH\' + \'_KEY\'] }}"',
  ]
  for (const expr of exprs) {
    const found = problems(files(workflow('deploy', ENVIRONMENT, expr)))
    assert.equal(found.length, 1, expr)
    assert.match(found[0], /вычисляемый индекс/)
    assert.match(found[0], /не по имени/)
  }
})

test('problems: названный строковым литералом чужой секрет оптовым не считается', () => {
  // Граница исключения с другой стороны: `secrets['MODEL_KEYS']` — обычный
  // именованный доступ к не-SSH секрету, и правило его не касается. Без этого
  // различения страж краснел бы на любом секрете в скобочной форме.
  assert.deepEqual(problems(files(workflow('any', null, 'echo "${{ secrets[\'MODEL_KEYS\'] }}"'))), [])
  assert.deepEqual(problems(files(workflow('any', null, 'echo "${{ secrets.MODEL_KEYS }}"'))), [])
})

test('namedIn: имена секретов регистронезависимы', () => {
  // `secrets.ssh_key` читает тот же SSH_KEY: контекст secrets к регистру имени
  // нечувствителен. Свой случай того же класса, найден при починке обещания.
  assert.deepEqual(namedIn('${{ secrets.ssh_key }}'), ['ssh_key'])
  assert.deepEqual(namedIn('${{ secrets.Ssh_Host }}'), ['Ssh_Host'])
  assert.deepEqual(namedIn("${{ secrets['ssh_user'] }}"), ['ssh_user'])
})

test('problems: строчное имя в job без окружения — находка', () => {
  const found = problems(files(workflow('exfil', null, 'echo "${{ secrets.ssh_key }}"')))
  assert.equal(found.length, 1)
  assert.match(found[0], /secrets\.ssh_key/)
})

test('problems: secrets: inherit — находка, и разбор job для неё не нужен', () => {
  // Файл без единой именованной ссылки: оптовая форма обязана находиться и
  // здесь, иначе вызов reusable workflow обходил бы правило целиком.
  const text = ['on: push', 'jobs:', '  call:', '    uses: ./.github/workflows/deploy.yml', '    secrets: inherit'].join('\n')
  const found = problems(files(text))
  assert.equal(found.length, 1)
  assert.match(found[0], /secrets: inherit/)
})

test('parseJobs: jobs: с хвостовым комментарием разбирается', () => {
  // Законная строка YAML. Прежняя редакция искала точное совпадение и падала
  // на ней «не найден блок jobs:» — то есть отказ разбора вместо проверки.
  const { jobs } = parseJobs(`jobs: # комментарий\n  a:\n    runs-on: ubuntu-latest\n`, 'w.yml')
  assert.deepEqual(
    jobs.map((j) => j.name),
    ['a'],
  )
})

test('parseJobs: непонятое дерево — исключение, а не тихий пропуск', () => {
  // Страж, не понявший файл, обязан покраснеть: молчание здесь неотличимо от
  // «нарушений нет».
  assert.throws(() => parseJobs('on: push\n', 'w.yml'), /не найден блок jobs:/)
  assert.throws(() => parseJobs('jobs:\n    a:\n      runs-on: x\n', 'w.yml'), /отступом 2 пробела/)
})

test('CLI: настоящие workflow репозитория — зелено, и список ссылок непуст', () => {
  const { status, stdout } = run(ROOT)
  assert.equal(status, 0, stdout)
  assert.match(stdout, new RegExp(`все в job с environment: ${ENVIRONMENT}`))
  assert.match(stdout, /\.github\/workflows\/deploy\.yml:\d+ secrets\.SSH_KEY/)
})

test('CLI: нарушение — код 1 и ::error:: со ссылкой на ADR', () => {
  const dir = treeWith({ 'w.yml': workflow('exfil', null, 'echo "${{ secrets.SSH_KEY }}"') })
  try {
    const { status, stdout } = run(dir)
    assert.equal(status, 1)
    assert.match(stdout, /::error::.*secrets\.SSH_KEY/)
    assert.match(stdout, /2026-10-18-1300-ssh-secrets-environment-scope/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: пустота — тоже отказ', () => {
  // Иначе удаление job выкатки давало бы зелёную проверку, которой нечего
  // проверять.
  const dir = treeWith({ 'w.yml': workflow('lint', null, 'echo ok') })
  try {
    const { status, stdout } = run(dir)
    assert.equal(status, 1)
    assert.match(stdout, /::error::ни одной ссылки на SSH-секрет не найдено/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: негодный workflow — ::error::, а не стек Node', () => {
  const dir = treeWith({ 'w.yml': 'jobs:\n    a:\n      steps:\n        - run: echo "${{ secrets.SSH_KEY }}"\n' })
  try {
    const { status, stdout, stderr } = run(dir)
    assert.equal(status, 1)
    assert.match(stdout, /::error::страж не разобрал workflow/)
    // Стек в stderr означал бы, что отказ стража читается как поломка стража.
    assert.doesNotMatch(stderr, /at .*ssh-secrets-scope\.mjs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
