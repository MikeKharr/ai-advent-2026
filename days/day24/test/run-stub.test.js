// Прогон против ЗАГЛУШКИ публичного API дня на локальном порту. Настоящий API
// дня 24 здесь не участвует, модель и служба поиска — тем более: предмет
// проверки это прогон, и только он.
//
// Стенд НЕ пересказывает представление автора о дне: он записывает всё, что
// получил, в журнал `seen` и отдаёт то, что ему велено. Поэтому «запрос дошёл»
// доказывается записью журнала, а не кодом ответа.
//
// ЧЕМ СТЕНД ОТЛИЧАЕТСЯ ОТ ПРОДА, названо здесь, а не подразумевается:
//   — ответы модели подменены строками теста, денег не стоят и не зависят
//     от Haiku; схема JSON к провайдеру не ездит вовсе;
//   — лимитера нет: 429 стенд отдаёт по приказу теста, а не по окну;
//   — поиска, отбора и индекса нет: `cited`, `quotes`, `checks` и `index`
//     стенд выдумывает;
//   — режим стенд называет сам полем `mode`, тогда как на проде его называет
//     переменная `RUN_MODE` сервера дня.
// Что отсюда НЕ следует: что прогон по проду даст такие же тексты и такие же
// признаки. Следует только одно — что прогон верно читает то, что получил, и
// верно считает, сколько запусков потратить.

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, test } from 'node:test'
import {
  contextOf,
  EVAL_KEY_FILE,
  main,
  parseEnd,
  readEvalKey,
  runAll,
  runOne,
  SPACING_MS,
} from '../eval/run.mjs'

const DOD = 'agent_docs/guides/dod.md'

/** @type {{method:string,url:string,headers:object,body:string}[]} журнал стенда */
let seen = []
/** Что стенд делает с очередным запросом. Приказ теста, не поведение дня. */
let plan = {}
/** Сколько запусков идёт одновременно: больше одного — прогон не последователен. */
let inFlight = 0
let maxInFlight = 0

const endFrame = (payload) => `event: end\ndata: ${JSON.stringify(payload)}\n\n`

const succeeded = (over = {}) =>
  endFrame({
    status: 'succeeded',
    result: {
      mode: 'rerank',
      outcome: 'answered',
      answer: 'ответ стенда',
      cited: [{ n: 1, source: DOD, section: '', claimedSource: DOD, claimedSection: '' }],
      quotes: [{ n: 1, text: 'снимок', verified: true }],
      checks: {
        sources_present: true,
        quotes_present: true,
        quotes_verbatim: true,
        cited_exact: true,
      },
      index: { commit: 'стенд-коммит', strategy: 'structural' },
      ...over,
    },
  })

const failed = (code, message) => endFrame({ status: 'failed', error: { code, message } })

const day = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  seen.push({
    method: req.method,
    url: req.url,
    headers: { ...req.headers },
    body: Buffer.concat(chunks).toString(),
  })

  if (req.url === '/api/runs') {
    if (plan.createStatus && plan.createStatus !== 202) {
      res.writeHead(plan.createStatus, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(plan.createBody ?? {}))
    }
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    res.writeHead(202, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ runId: `run-${seen.length}` }))
  }

  if (req.url.endsWith('/events')) {
    inFlight -= 1
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    // Кадры отдаются ровно теми куска́ми, какие назвал тест: границы кусков —
    // предмет проверки разбора, и склеивать их здесь нельзя.
    const pieces = plan.piecesBy?.(seen.length) ?? plan.pieces ?? [succeeded()]
    for (const piece of pieces) res.write(piece)
    return res.end()
  }

  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => day.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${day.address().port}`
after(() => day.close())

const ask = (id, over = {}) => ({
  id,
  origin: id,
  set: 'first',
  question: `вопрос ${id}`,
  expect: 'выверенный ответ',
  key: 'snapshot.md',
  sources: [DOD],
  ...over,
})

const ten = Array.from({ length: 10 }, (unused, i) => ask(`q${String(i + 1).padStart(2, '0')}`))

function reset(next = {}) {
  seen = []
  plan = next
  inFlight = 0
  maxInFlight = 0
}

const quiet = () => {}

test('запрос дошёл до стенда: его журнал несёт вопрос и путь', async () => {
  reset()
  const got = await runOne({ base, question: ask('q08') })
  assert.ok(got.result, `ожидался ответ, получен отказ: ${JSON.stringify(got.failure)}`)
  assert.equal(seen.length, 2, 'создание запуска и поток событий')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, '/api/runs')
  assert.match(seen[1].url, /^\/api\/runs\/run-1\/events$/)
})

test('тело запроса — РОВНО вопрос: поля mode в нём нет (режим называет сервер дня)', async () => {
  reset()
  await runOne({ base, question: ask('q08') })
  // Предмет проверки — ЖУРНАЛ СТЕНДА, то есть то, что реально ушло в сеть.
  // День 24 поле `mode` не читает (`server.js`, `handleRun`), и послать его
  // значило бы записать в файл результата режим, которым прогон мог и не идти.
  assert.deepEqual(JSON.parse(seen[0].body), { question: 'вопрос q08' })
})

// ——— ключ оператора: единственный ключ, который прогон предъявляет (I-3) ———
//
// СВОЙСТВО ПЕРЕПИСАНО ОСОЗНАННО, а не ослаблено под новую возможность. До
// ADR 2026-10-05-1130 прогон не предъявлял дню ничего, и тест требовал
// отсутствия любого ключа. Теперь ключ оператора есть, и требование стало
// точнее, а не мягче: ключ ровно один, уходит ровно в одно место и не
// появляется нигде, кроме заголовка. Прочие ключи запрещены как прежде.

/** Значение, которого в выводе и в файле результата быть не должно. */
const OPERATOR_KEY = 'operator-key-secret-do-not-leak'

test('ключ оператора уходит заголовком создания запуска — и только там (I-3)', async () => {
  reset()
  await runOne({ base, question: ask('q08'), key: OPERATOR_KEY })
  const [create, events] = seen
  assert.equal(create.url, '/api/runs')
  assert.equal(create.headers['x-eval-key'], OPERATOR_KEY)
  // Поток событий идёт под окном ЧТЕНИЙ, которому флаг оператора не положен
  // (`days/day24/server.js`, `RESERVE`): предъявлять там ключ значило бы
  // светить им в месте, где он ничего не открывает.
  assert.match(events.url, /\/events$/)
  assert.equal(events.headers['x-eval-key'], undefined, 'ключ ушёл в поток событий')
})

test('без ключа заголовка нет вовсе — день видит обычного посетителя', async () => {
  reset()
  await runOne({ base, question: ask('q08') })
  for (const record of seen)
    assert.equal(record.headers['x-eval-key'], undefined, 'заголовок появился без ключа')
})

test('пустой ключ равен отсутствию: пустое значение не посылается', async () => {
  reset()
  // День трактует `x-eval-key` с пустым значением как «возможности нет»
  // (`limits.js`, `isOperator`), так что пустое значение изображало бы
  // предъявление ключа.
  for (const empty of [null, '', '   ']) {
    reset()
    await runOne({ base, question: ask('q08'), key: readEvalKey({ read: () => empty ?? '' }) })
    assert.equal(seen[0].headers['x-eval-key'], undefined, JSON.stringify(empty))
  }
})

test('прочих ключей прогон дню не предъявляет (I-3)', async () => {
  reset()
  await runOne({ base, question: ask('q08'), key: OPERATOR_KEY })
  for (const record of seen) {
    assert.equal(record.headers.authorization, undefined)
    assert.equal(record.headers['x-api-key'], undefined)
  }
})

test('значение ключа не попадает ни в вывод прогона, ни в файл результата', async () => {
  reset()
  const out = tmp()
  const lines = []
  await main({
    argv: ['--base', base, '--out', out, '--questions', questionsFile(), '--force'],
    sleep: async () => {},
    log: (l) => lines.push(l),
    key: OPERATOR_KEY,
  })
  // Стенд ключ получил — значит проверяется не пустая выдумка.
  assert.equal(seen[0].headers['x-eval-key'], OPERATOR_KEY, 'ключ до стенда не дошёл')
  const printed = lines.join('\n')
  assert.ok(!printed.includes(OPERATOR_KEY), `ключ напечатан: ${printed}`)
  assert.ok(!readFileSync(out, 'utf8').includes(OPERATOR_KEY), 'ключ попал в файл результата')
  // Но сказать, ЕСТЬ ли ключ, прогон обязан: под окнами и мимо окон — разные
  // условия прогона, и читающий вывод должен знать, в каких он шёл.
  assert.ok(/ключ оператора: есть/.test(printed), printed)
})

test('ключ читается из файла, обрезается по краям, а его отсутствие — не ошибка', () => {
  const dir = mkdtempSync(join(tmpdir(), 'day24-key-'))
  const file = join(dir, 'eval.key')
  writeFileSync(file, `  ${OPERATOR_KEY}\n`)
  assert.equal(readEvalKey({ file }), OPERATOR_KEY)
  writeFileSync(file, '   \n')
  assert.equal(readEvalKey({ file }), null, 'пустой файл дал ключ')
  assert.equal(readEvalKey({ file: join(dir, 'нет-такого') }), null)
})

test('умолчание пути — в домашнем каталоге, и в репозитории ключа нет', () => {
  // Путь обязан быть вне репозитория: файл ключа рядом с кодом однажды
  // уехал бы в коммит (I-2).
  assert.ok(EVAL_KEY_FILE.endsWith(join('.config', 'advent', 'eval.key')), EVAL_KEY_FILE)
  assert.ok(!EVAL_KEY_FILE.includes(`${sep}days${sep}`), EVAL_KEY_FILE)
})

test('режим и индекс берутся ИЗ ОТВЕТА запуска, а не из догадки', async () => {
  reset({ pieces: [succeeded({ mode: 'rewrite', index: { commit: 'c9', strategy: 'fixed' } })] })
  const got = await runOne({ base, question: ask('q08') })
  const runs = new Map([['q08', got]])
  assert.deepEqual(contextOf(runs), {
    mode: 'rewrite',
    index: { commit: 'c9', strategy: 'fixed' },
  })
})

test('запуски идут строго по одному и с паузой окна', async () => {
  reset()
  const pauses = []
  const got = await runAll({
    base,
    questions: ten.slice(0, 3),
    sleep: async (ms) => pauses.push(ms),
    log: quiet,
  })
  assert.equal(got.aborted, null)
  assert.equal(got.runs.size, 3)
  assert.equal(maxInFlight, 1, 'стенд видел два запуска одновременно — залп получил бы 429')
  // Пауз на один меньше, чем запусков: перед первым ждать нечего.
  assert.deepEqual(pauses, [SPACING_MS, SPACING_MS])
})

test('ОТКАЗ ДЫМОВОГО ЗАПУСКА останавливает прогон: девять остальных не потрачены', async () => {
  reset({ pieces: [failed('answer_invalid', 'ответ не по форме')] })
  const lines = []
  const got = await runAll({
    base,
    questions: ten,
    sleep: async () => {},
    log: (line) => lines.push(line),
  })
  assert.deepEqual(got.aborted, { code: 'answer_invalid', message: 'ответ не по форме' })
  assert.equal(got.runs.size, 1, 'после отказа дымового запуска прогон продолжился')
  // Предмет проверки — ЖУРНАЛ СТЕНДА: именно он знает, сколько запусков день
  // реально получил, а значит, сколько денег ушло.
  const creates = seen.filter((r) => r.url === '/api/runs')
  assert.equal(creates.length, 1, `день получил ${creates.length} запусков вместо одного`)
  assert.ok(
    lines.some((l) => /дымовой запуск/.test(l) && /answer_invalid/.test(l)),
    `в выводе нет дословной причины остановки: ${JSON.stringify(lines)}`,
  )
})

test('отказ НЕ ПЕРВОГО запуска прогон не обрывает — он едет в failures', async () => {
  // Второй запуск отказывает, остальные отвечают. Границу «только первый»
  // держит это: иначе один отказ посередине выбрасывал бы оплаченное.
  reset({ piecesBy: (n) => (n === 4 ? [failed('search_unavailable', 'служба молчит')] : [succeeded()]) })
  const got = await runAll({ base, questions: ten.slice(0, 3), sleep: async () => {}, log: quiet })
  assert.equal(got.aborted, null)
  assert.equal(got.runs.size, 3)
  assert.equal(got.runs.get('q02').failure.code, 'search_unavailable')
  assert.equal(seen.filter((r) => r.url === '/api/runs').length, 3)
})

test('отказ создания запуска читается кодом ответа дня, а не молчанием', async () => {
  reset({ createStatus: 429, createBody: { error: 'Слишком часто' } })
  const got = await runOne({ base, question: ask('q08') })
  assert.deepEqual(got.failure, { code: 'http_429', message: 'Слишком часто' })
})

test('кадр end, разорванный по байтам, разбирается — границы кусков не данные', () => {
  const whole = succeeded()
  const state = { buffer: '' }
  const at = Math.floor(whole.length / 2)
  assert.equal(parseEnd(whole.slice(0, at), state), null)
  const end = parseEnd(whole.slice(at), state)
  assert.equal(end.status, 'succeeded')
  assert.equal(end.result.answer, 'ответ стенда')
})

test('служебные кадры SSE данными не считаются', () => {
  const state = { buffer: '' }
  assert.equal(parseEnd(': ping\n\nevent: stage\ndata: {"s":1}\n\n', state), null)
  assert.equal(parseEnd(succeeded(), state).status, 'succeeded')
})

// ——— точка входа: защита от затирания, запись и сверка ———

const tmp = () => join(mkdtempSync(join(tmpdir(), 'day24-eval-')), 'eval.json')

const questionsFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'day24-qs-')), 'questions.json')
  writeFileSync(file, JSON.stringify({ questions: ten.slice(0, 2) }))
  return file
}

test('готовый файл не затирается без --force: повтор прогона стоит денег', async () => {
  reset()
  const out = tmp()
  writeFileSync(out, '{"уже":"есть"}')
  const lines = []
  const code = await main({
    argv: ['--base', base, '--out', out, '--questions', questionsFile()],
    sleep: async () => {},
    log: (l) => lines.push(l),
  })
  assert.equal(code, 1)
  assert.equal(readFileSync(out, 'utf8'), '{"уже":"есть"}', 'файл затёрт без --force')
  // И ДЕНЬГИ ТОЖЕ НЕ ПОТРАЧЕНЫ: защита стоит до запусков, а не после.
  assert.equal(seen.length, 0, 'прогон успел сходить в день, прежде чем отказаться')
  assert.ok(lines.some((l) => /--force/.test(l)))
})

test('--force затирает, и файл получает форму, которую читает страница', async () => {
  reset()
  const out = tmp()
  writeFileSync(out, '{"уже":"есть"}')
  const code = await main({
    argv: ['--base', base, '--out', out, '--questions', questionsFile(), '--force'],
    sleep: async () => {},
    log: quiet,
    now: () => new Date('2026-10-05T10:00:00.000Z'),
  })
  assert.equal(code, 0)
  const report = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(report.ranAt, '2026-10-05T10:00:00.000Z')
  assert.equal(report.mode, 'rerank')
  assert.deepEqual(report.index, { commit: 'стенд-коммит', strategy: 'structural' })
  assert.equal(report.judge.name, null)
  assert.equal(report.questions.length, 2)
  assert.equal(report.questions[0].run.outcome, 'answered')
  assert.deepEqual(report.questions[0].expect, [DOD])
})

test('дымовой отказ не пишет файла вовсе: прогона не было', async () => {
  reset({ pieces: [failed('answer_invalid', 'схема отклонена')] })
  const out = tmp()
  const lines = []
  const code = await main({
    argv: ['--base', base, '--out', out, '--questions', questionsFile()],
    sleep: async () => {},
    log: (l) => lines.push(l),
  })
  assert.equal(code, 1)
  assert.throws(() => readFileSync(out, 'utf8'), /ENOENT/, 'файл записан, хотя прогона не было')
  assert.ok(lines.some((l) => /не записан/.test(l)))
})

test('--check краснеет на испорченной форме и зеленеет на целой', async () => {
  reset()
  const out = tmp()
  await main({
    argv: ['--base', base, '--out', out, '--questions', questionsFile(), '--force'],
    sleep: async () => {},
    log: quiet,
  })
  const qs = questionsFile()
  assert.equal(
    await main({ argv: ['--check', '--out', out, '--questions', qs], log: quiet }),
    0,
    'целый файл не прошёл сверку',
  )
  const report = JSON.parse(readFileSync(out, 'utf8'))
  report.questions[0].question = 'подменённый вопрос'
  writeFileSync(out, JSON.stringify(report))
  const lines = []
  assert.equal(
    await main({ argv: ['--check', '--out', out, '--questions', qs], log: (l) => lines.push(l) }),
    1,
  )
  assert.ok(lines.some((l) => /текст вопроса/.test(l)))
})

test('--check на пустых вердиктах НЕ краснеет: судейства не было по решению владельца', async () => {
  reset()
  const out = tmp()
  await main({
    argv: ['--base', base, '--out', out, '--questions', questionsFile(), '--force'],
    sleep: async () => {},
    log: quiet,
  })
  const lines = []
  const code = await main({
    argv: ['--check', '--out', out, '--questions', questionsFile()],
    log: (l) => lines.push(l),
  })
  assert.equal(code, 0)
  // Число пустых вердиктов всё равно печатается: послабление названо вслух, а
  // не спрятано в зелёном выводе.
  assert.ok(lines.some((l) => /вердиктов не стоит: 4/.test(l)), JSON.stringify(lines))
})
