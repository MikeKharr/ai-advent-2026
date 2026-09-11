import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { run } from '../build.js'
import { makeFixture } from './helpers.js'

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
writeFileSync(join(fixture.root, 'id_ed25519'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARKER}\n`)

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

// Образцы ищутся по витрине, но не по vault: vault — полные копии
// публичных документов, а они сами называют эти образцы (проект решения
// атласа, ADR и запись 2026-09-09-0258 про адрес tailnet).
test('в витрине нет образцов ключей и адресов частной сети', () => {
  const patterns = [
    new RegExp(['sk', 'ant', ''].join('-')),
    /gsk_/,
    /BEGIN OPENSSH/,
    // Адрес tailnet, а не любое «100.»: цена или номер строки в тексте
    // документа не должны ронять проверку.
    /\b100\.\d+\.\d+\.\d+\b/,
  ]
  for (const f of site) for (const re of patterns) assert.equal(re.test(f.text), false, `в ${f.path} найден образец ${re}`)
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
