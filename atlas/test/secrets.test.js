import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { run } from '../build.js'
import { KEY_SAMPLES, SAMPLES } from '../lib/texts.js'
import { ROOT, makeFixture } from './helpers.js'

// Витрина не должна расширять публикуемое (I-1…I-3). Входы заданы явным
// списком путей, поэтому секрет не может попасть в граф даже случайно —
// но это проверяется, а не предполагается: рядом с входами кладётся файл
// с маркером, и маркера в выходе быть не должно.

const MARKER = 'ATLAS-SECRET-MARKER-8fd31c'
// Префиксы ключей собираются из кусков, а не пишутся литералом: файл теста
// не должен выглядеть утечкой ни для сканеров, ни для шага docs-guard,
// который ищет в репозитории строки вида `sk-ant-…`.
const FAKE_ANTHROPIC = `${['sk', 'ant', 'api03'].join('-')}-${MARKER}`
const FAKE_GROQ = `gs${'k'}_${MARKER}`
// Заголовок PEM и токен GitHub — тоже из кусков: шаг docs-guard ищет их по
// репозиторию так же, как ключ Anthropic.
const PEM = (kind) => ['BEGIN', kind, 'PRIVATE', 'KEY'].filter(Boolean).join(' ')
const TAIL = 'A1b2C3d4E5f6G7h8J9k0'
const GH = (letter) => `gh${letter}_${TAIL}`
const GH_PAT = `${'github'}_pat_${TAIL}_${TAIL}`

const fixture = makeFixture()
after(() => fixture.cleanup())

mkdirSync(join(fixture.root, 'deploy'), { recursive: true })
mkdirSync(join(fixture.root, 'logs'), { recursive: true })
mkdirSync(join(fixture.root, 'router/data'), { recursive: true })

writeFileSync(join(fixture.root, 'deploy/secrets.env'), `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`)
writeFileSync(join(fixture.root, 'deploy/router.env'), `GROQ_API_KEY=${FAKE_GROQ}\n`)
writeFileSync(join(fixture.root, '.env'), `DEPLOY_KEY=${MARKER}\n`)
writeFileSync(join(fixture.root, 'logs/app.log'), `запрос к 100.77.87.97 с ключом ${MARKER}\n`)
writeFileSync(join(fixture.root, 'router/data/ledger.jsonl'), `{"key":"${MARKER}"}\n`)
writeFileSync(join(fixture.root, 'id_ed25519'), `-----${PEM('OPENSSH')}-----\n${MARKER}\n`)
writeFileSync(join(fixture.root, 'id_rsa'), `-----${PEM('RSA')}-----\n${MARKER}\n`)
writeFileSync(join(fixture.root, 'deploy/gh.env'), `GH_TOKEN=${GH('p')}\nGH_PAT=${GH_PAT}\n# ${MARKER}\n`)

const out = join(fixture.root, 'atlas/dist/graph.json')
const result = run({ root: fixture.root, out })

/** Все файлы каталога выхода, а не одна строка графа: витрина и vault
 *  пишут свои файлы, и гарантия не должна зависеть от того, что они
 *  совпадают с graph.json. */
const filesIn = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((rel) => join(dir, rel))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
const site = filesIn(result.siteDir)
const vault = filesIn(result.vaultDir)

test('сборка на копии со секретами рядом проходит без находок', () => {
  assert.deepEqual(result.findings, [])
  assert.ok(result.nodes.length > 100)
  assert.ok(site.some((f) => f.path.endsWith('graph.json')), 'витрина собрана')
  assert.ok(vault.length > 100, 'vault собран')
})

test('маркер из подложенных секретов не попал ни в один файл витрины и vault', () => {
  for (const f of [...site, ...vault]) assert.equal(f.text.includes(MARKER), false, `маркер в ${f.path}`)
})

// Образцы стража — тот же список, по которому санитайз `lib/texts.js`
// скрывает их в texts.json: разойтись двум копиям негде.
const patterns = SAMPLES.map((s) => new RegExp(s))

// Образцы ищутся по витрине, но не по vault: vault — полные копии
// публичных документов, а они сами называют эти образцы (проект решения
// атласа, ADR и запись 2026-09-09-0258 про адрес tailnet).
test('в витрине нет образцов ключей и адресов частной сети', () => {
  for (const f of site) for (const re of patterns) assert.equal(re.test(f.text), false, `в ${f.path} найден образец ${re}`)
})

const NEW_SAMPLES = [
  PEM('RSA'),
  PEM('EC'),
  PEM(''),
  PEM('ENCRYPTED'),
  ...['p', 'o', 'u', 's', 'r'].map(GH),
  GH_PAT,
]

test('страж ловит заголовки PEM и токены GitHub', () => {
  for (const sample of NEW_SAMPLES) {
    assert.ok(
      patterns.some((re) => re.test(`строка документа: ${sample}.`)),
      `образец не пойман: ${sample}`,
    )
  }
})

// У новых образцов хвост обязателен: документ, называющий префикс словами,
// сборку не роняет. Префиксы Anthropic и Groq ведут себя иначе — их образец
// ловит и голый префикс, это прежнее поведение.
test('упоминание префикса токена GitHub без хвоста — не находка стража', () => {
  for (const text of [`токен \`${'gh'}p_\``, `префикс ${'github'}_pat_ в тексте`]) {
    assert.equal(patterns.some((re) => re.test(text)), false, text)
  }
})

// Шаг «Секреты не попали в репозиторий» — grep в docs-guard.yml. Его список
// шире не может быть: в публичных документах законно названы адрес tailnet и
// префиксы ключей. Но образцы с хвостом ключа у него те же, что у атласа.
test('шаг секретов docs-guard ищет те же образцы с хвостом ключа', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/docs-guard.yml'), 'utf8')
  const grep = yml.match(/grep -rIn --exclude-dir=\.git -E '([^']+)' \./)
  assert.ok(grep, 'в docs-guard.yml не найден шаг grep секретов')
  for (const s of KEY_SAMPLES) assert.ok(grep[1].split('|').includes(s), `в docs-guard нет образца ${s}`)

  const re = new RegExp(grep[1])
  for (const sample of NEW_SAMPLES) assert.ok(re.test(sample), `docs-guard не ловит ${sample}`)
  assert.equal(re.test(`токен \`${'gh'}p_\` и ${'github'}_pat_`), false)
})

test('секрет, дописанный в сам входной документ, — уже не наша граница', () => {
  // Честная граница: атлас не читает секретные файлы, но всё, что владелец
  // сам положил в публичный документ, в граф попадёт. Проверяется, что это
  // так и есть, — чтобы предыдущие три теста не выглядели гарантией шире,
  // чем они дают.
  const guide = join(fixture.root, 'agent_docs/guides/dod.md')
  const saved = readFileSync(guide, 'utf8')
  appendFileSync(guide, `\n## Контекст\n\n${MARKER}\n`)
  const second = run({ root: fixture.root, out })
  writeFileSync(guide, saved)

  assert.equal(JSON.stringify(second.nodes).includes(MARKER), true)
})
