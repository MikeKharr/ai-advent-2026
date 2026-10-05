// Ключ оператора в прогоне проверки (ADR 2026-10-05-1130, п. 9): откуда он
// берётся, куда уходит и чего не делает.
//
// Стенд здесь — заглушка публичного API дня на локальном порту, как в
// `run-stub.test.js`, и чем он отличается от прода, названо там же. Для этого
// файла важно одно: стенд пишет В ЖУРНАЛ ЗАГОЛОВКИ, поэтому «ключ ушёл» и
// «ключ не ушёл» доказываются записью журнала, а не кодом ответа.
//
// Настоящего файла ключа на машине запуска тест не касается: путь всегда
// подставляется, и `readEvalKey` зовётся с явным `file`.

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  EVAL_HEADER,
  EVAL_KEY_FILE,
  readEvalKey,
  runAll,
  runOne,
  SPACING_MS,
  SPACING_WITH_KEY_MS,
} from '../eval/run.mjs'
import { MODES } from '../eval/score.mjs'

const KEY = 'eval-key-secret-do-not-leak-32-chars'

/** @type {{url:string,headers:object}[]} журнал стенда */
let seen = []

const day = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ url: req.url, headers: { ...req.headers } })
  if (req.url === '/api/runs') {
    res.writeHead(202, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ runId: 'run-1' }))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.end(
    `event: end\ndata: ${JSON.stringify({
      status: 'succeeded',
      result: { answer: 'ответ стенда', refused: false, sources: [], index: { commit: 'c', strategy: 's' } },
    })}\n\n`,
  )
})

await new Promise((resolve) => day.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${day.address().port}`
after(() => day.close())

const ask = (id = 'q08') => ({
  id,
  origin: id,
  set: 'first',
  question: `вопрос ${id}`,
  expect: 'верный ответ',
  key: 'snapshot.md',
  sources: ['agent_docs/guides/dod.md'],
})

const file = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-key-'))
  const path = join(dir, 'eval.key')
  writeFileSync(path, text)
  return path
}

// ─── Откуда берётся ключ.

test('ключ читается из файла и обрезается по краям', () => {
  assert.equal(readEvalKey({ file: file(`${KEY}\n`) }), KEY)
  assert.equal(readEvalKey({ file: file(`  ${KEY}  \n\n`) }), KEY)
})

test('файла нет или он пуст — ключа нет, и это не ошибка', () => {
  assert.equal(readEvalKey({ file: join(tmpdir(), 'нет-такого-файла-eval.key') }), null)
  assert.equal(readEvalKey({ file: file('') }), null)
  assert.equal(readEvalKey({ file: file('   \n') }), null, 'пробелы приняты за ключ')
})

test('умолчание пути — в домашнем каталоге, и в репозитории файла ключа нет', () => {
  assert.match(EVAL_KEY_FILE, /\.config[/\\]advent[/\\]eval\.key$/)
  // Путь абсолютный и ведёт в дом, а не в дерево проекта: ключ в репозитории
  // не живёт никогда (I-2).
  assert.ok(!EVAL_KEY_FILE.includes('ai-advent-2026'), `путь ключа ведёт в репозиторий: ${EVAL_KEY_FILE}`)
})

// ─── Куда уходит ключ.

test('с ключом он уходит заголовком создания запуска — и только там', async () => {
  seen = []
  const got = await runOne({ base, question: ask(), mode: 'rag', key: KEY })
  assert.ok(got.result, `ожидался ответ, получен отказ: ${JSON.stringify(got.failure)}`)
  assert.equal(seen.length, 2, 'создание запуска и поток событий')
  assert.equal(seen[0].url, '/api/runs')
  assert.equal(seen[0].headers[EVAL_HEADER], KEY, 'ключ не дошёл до дня')
  // Поток событий идёт под окном чтений, и ключ там не нужен: 600 чтений в час
  // прогону не мешают (ADR 2026-10-05-1130, п. 7).
  assert.equal(seen[1].headers[EVAL_HEADER], undefined, 'ключ ушёл туда, где окно не снимается')
})

test('без ключа заголовка нет вовсе — день видит обычного посетителя', async () => {
  seen = []
  await runOne({ base, question: ask(), mode: 'rag' })
  for (const request of seen) assert.equal(request.headers[EVAL_HEADER], undefined, `${request.url}: заголовок ключа`)
})

test('прочих ключей прогон дню не предъявляет (I-3)', async () => {
  seen = []
  await runOne({ base, question: ask(), mode: 'rag', key: KEY })
  for (const request of seen) {
    assert.equal(request.headers.authorization, undefined, `${request.url}: ключ сервиса агентов`)
    assert.equal(request.headers['x-api-key'], undefined, `${request.url}: ключ модели`)
  }
})

test('значение ключа не попадает в вывод прогона', async () => {
  seen = []
  const said = []
  await runAll({ base, questions: [ask()], sleep: async () => {}, key: KEY, log: (m) => said.push(String(m)) })
  assert.ok(said.length > 0, 'прогон не сказал ничего — проверять нечего')
  for (const line of said) assert.ok(!line.includes(KEY), `ключ в выводе: ${line}`)
})

// ─── Ритм: что именно связывает прогон с ключом и без.

test('с ключом пауза короче, без ключа — прежняя', async () => {
  const waits = []
  await runAll({ base, questions: [ask('q08'), ask('q09')], sleep: async (ms) => waits.push(ms), key: KEY, log: () => {} })
  assert.deepEqual(waits, [SPACING_WITH_KEY_MS, SPACING_WITH_KEY_MS, SPACING_WITH_KEY_MS])

  waits.length = 0
  await runAll({ base, questions: [ask('q08'), ask('q09')], sleep: async (ms) => waits.push(ms), log: () => {} })
  assert.deepEqual(waits, [SPACING_MS, SPACING_MS, SPACING_MS], 'без ключа пауза взялась не из окна дня')
})

/**
 * Величина короткой паузы, а не её существование. Проверка выше сверяет паузы
 * с САМОЙ КОНСТАНТОЙ и прошла бы при любом её значении (тот же приём, что у
 * `SPACING_MS` в `run-stub.test.js`, мутация `reviewer` к PR #304).
 *
 * Снятые окна дня не снимают окно службы `rag`: 10 запросов в минуту на весь
 * хост (ADR 2026-10-04-0735, п. 4, Р6(а)). Поиск зовёт каждый второй запуск —
 * режимы идут парой, — поэтому связывает `пауза × число режимов ≥ 6000 мс`.
 */
test('короткая пауза не уже окна службы rag: 10 в минуту — это ≥ 6 с на запрос с поиском', () => {
  const RAG_WINDOW_MS = 60_000
  const RAG_PER_MIN = 10
  const floor = RAG_WINDOW_MS / RAG_PER_MIN
  assert.equal(MODES.length, 2, 'режимов стало не два — пауза прогона пересчитывается')
  assert.ok(
    SPACING_WITH_KEY_MS * MODES.length >= floor,
    `пауза ${SPACING_WITH_KEY_MS} мс × ${MODES.length} режима уже окна службы (${floor} мс на запрос с поиском)`,
  )
})
