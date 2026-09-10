import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { run } from '../build.js'
import { makeFixture } from './helpers.js'

// Витрина не должна расширять публикуемое (I-1…I-3). Входы заданы явным
// списком путей, поэтому секрет не может попасть в граф даже случайно —
// но это проверяется, а не предполагается: рядом с входами кладётся файл
// с маркером, и маркера в выходе быть не должно.

const MARKER = 'ATLAS-SECRET-MARKER-8fd31c'

const fixture = makeFixture()
after(() => fixture.cleanup())

mkdirSync(join(fixture.root, 'deploy'), { recursive: true })
mkdirSync(join(fixture.root, 'logs'), { recursive: true })
mkdirSync(join(fixture.root, 'router/data'), { recursive: true })

writeFileSync(join(fixture.root, 'deploy/secrets.env'), `ANTHROPIC_API_KEY=sk-ant-api03-${MARKER}\n`)
writeFileSync(join(fixture.root, 'deploy/router.env'), `GROQ_API_KEY=gsk_${MARKER}\n`)
writeFileSync(join(fixture.root, '.env'), `DEPLOY_KEY=${MARKER}\n`)
writeFileSync(join(fixture.root, 'logs/app.log'), `запрос к 100.77.87.97 с ключом ${MARKER}\n`)
writeFileSync(join(fixture.root, 'router/data/ledger.jsonl'), `{"key":"${MARKER}"}\n`)
writeFileSync(join(fixture.root, 'id_ed25519'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARKER}\n`)

const out = join(fixture.root, 'atlas/dist/graph.json')
const result = run({ root: fixture.root, out })
const text = readFileSync(out, 'utf8')

test('сборка на копии со секретами рядом проходит без находок', () => {
  assert.deepEqual(result.findings, [])
  assert.ok(result.nodes.length > 100)
})

test('маркер из подложенных секретов не попал в graph.json', () => {
  assert.equal(text.includes(MARKER), false)
})

test('в выходе нет образцов ключей и адресов частной сети', () => {
  for (const pattern of ['sk-ant-', 'gsk_', 'BEGIN OPENSSH', '100.']) {
    assert.equal(text.includes(pattern), false, `в graph.json найден образец «${pattern}»`)
  }
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
