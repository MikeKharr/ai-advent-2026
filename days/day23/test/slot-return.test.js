// ВОЗВРАТ СЛОТА СУТОЧНОГО ПОТОЛКА НА ОТКАЗ 4xx — решение владельца,
// ADR 2026-10-05-0544, развилка Р8, вариант (б), состав правок в п. 6.
//
// Предмет здесь не «в лимитере есть метод», а воспроизведение дефекта и его
// исчезновение: при потолке 50 день выключался до полуночи UTC пятьюдесятью
// негодными POST — без единого вызова модели и без единого цента расхода, —
// потому что слот занимает диспетчер до разбора тела (I-4). Воспроизведение
// `compliance` к PR #313: `MAX_DAILY_CALLS=2`, три разных адреса, два мусорных
// POST, после которых законный запрос получал 429.
//
// Улика различает гипотезы: проверяется не только код ответа, но и ЖУРНАЛ
// стенда сервиса агентов — 202 день отдал бы и не сходив в сервис, а «до
// сервиса дошло» и есть то, ради чего слот тратится.
//
// Отдельный файл, а не добавка к `limiter-seam.test.js`: потолок там заведомо
// недостижим (1000), и предмет этого теста требует потолка 2. Окружение
// читается при загрузке модуля, а `node --test` даёт каждому файлу свой
// процесс.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const KEY = 'agent-key-secret-slot-do-not-leak'

/** @type {{url:string}[]} журнал стенда сервиса агентов */
const seen = []

/**
 * Чем отвечает стенд: `202` по умолчанию, `400` — как настоящий сервис при
 * негодном вводе (разбор входа агента до создания запуска), `503` — как
 * лежащий сервис, который день пересказывает посетителю как 502.
 */
let answer = 202

const agents = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ url: req.url })
  if (answer === 400) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ message: 'сервис отверг ввод' }))
  }
  if (answer === 503) {
    res.writeHead(503, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ code: 'no_agent' }))
  }
  res.writeHead(202, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ runId: 'run-slot' }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Потолок — 4, и это счёт, а не запас. В одну сторону: мусорных POST в первом
// тесте ровно четыре, то есть без возврата слота они исчерпали бы потолок
// целиком. В обратную: слот расходуют ровно четыре обращения (один принятый
// запуск, два после возвращённого 400 сервиса, один сгоревший на 502) — после
// чего потолок обязан отказать. Окна на адрес заведомо недостижимы: иначе
// отказ приходил бы от них, и предмет тестов остался бы без держателя.
process.env.MAX_DAILY_CALLS = '4'
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_READS_PER_HOUR = '1000'

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

/** Запрос с НАЗВАННОГО адреса: окна на адрес и потолок считают порознь. */
const post = (body, ip) =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('мусорные POST не жгут суточный потолок, и законный запрос доходит до сервиса', async () => {
  seen.length = 0

  // Три вида негодного тела, каждый — со своего адреса: окна на адрес здесь
  // не при чём, предмет — общий суточный счётчик.
  const empty = await post({ question: '   ', mode: 'rerank' }, '10.0.0.1')
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error, 'Вопрос пустой.')

  const broken = await post('это не JSON', '10.0.0.2')
  assert.equal(broken.status, 400)
  assert.equal((await broken.json()).error, 'тело не JSON')

  const noMode = await post({ question: 'вопрос' }, '10.0.0.3')
  assert.equal(noMode.status, 400)
  assert.equal((await noMode.json()).error, 'Режим не назван.')

  // Четвёртый — длиннее предела. Мусорных POST здесь РОВНО СТОЛЬКО, сколько
  // потолок: без возврата слота они исчерпали бы его целиком, и законный
  // запрос ниже получил бы 429. Меньшее число оставляло бы запас, и тест был
  // бы зелёным при выключенном возврате — то есть держателем не был бы.
  const long = await post({ question: 'я'.repeat(601), mode: 'rag' }, '10.0.0.13')
  assert.equal(long.status, 400)
  assert.match((await long.json()).error, /длиннее/)

  // До сервиса агентов не дошло НИЧЕГО: все четыре отказа — наши.
  assert.deepEqual(seen, [], 'негодный запрос всё-таки ушёл в сервис')

  // А теперь законный запрос — с нового адреса. Без возврата слота здесь был
  // бы 429 «суточный предел исчерпан»: четыре мусорных POST = потолок.
  const ok = await post({ question: 'где держится инвариант I-4', mode: 'rerank' }, '10.0.0.4')
  assert.equal(ok.status, 202, 'три мусорных POST погасили день')
  assert.equal((await ok.json()).runId, 'run-slot')
  // Улика дошедшего запроса — журнал стенда, а не код ответа.
  assert.deepEqual(seen, [{ url: '/v1/runs' }])
})

test('ОТКАЗ 400 ОТ САМОГО СЕРВИСА слот ВОЗВРАЩАЕТ: вызова модели не было', async () => {
  // 400 отдаёт разбор входа агента ДО создания запуска — модель не звали, и
  // негодный ввод не должен стоить дню суточного слота ни тогда, когда его
  // отверг сам день, ни тогда, когда его отверг агент (решение владельца
  // 2026-10-05 по Р8(б)).
  seen.length = 0
  answer = 400
  const spoken = await post({ question: 'вопрос, который отвергнет сервис', mode: 'rerank' }, '10.0.0.8')
  assert.equal(spoken.status, 400)
  assert.equal((await spoken.json()).error, 'сервис отверг ввод')
  // Улика того, что запрос ДОШЁЛ до сервиса: журнал стенда, а не код ответа.
  // Без неё тест не отличал бы «агент отверг» от «день отверг сам».
  assert.deepEqual(seen, [{ url: '/v1/runs' }], 'запрос до сервиса не дошёл — проверено не то')
  answer = 202

  // Слот вернулся. Счёт прямой: потолок 4, предыдущий тест израсходовал один
  // принятый запуск, этот запрос слота не стоил. Значит остаётся три, и два
  // законных запроса ниже обязаны пройти оба.
  const first = await post({ question: 'законный вопрос', mode: 'rag' }, '10.0.0.9')
  assert.equal(first.status, 202)
  const second = await post({ question: 'второй законный', mode: 'rag' }, '10.0.0.10')
  assert.equal(second.status, 202, '400 сервиса сжёг слот, хотя вызова модели не было')
})

test('502 СЛОТ СЖИГАЕТ: запуск мог завестись, и вызов мог состояться', async () => {
  // Различающий случай к тесту выше: оба исхода — ответ сервиса на дошедший
  // запрос, и если бы пометка снималась не на одной ветви, а на любом ответе,
  // этот тест остался бы зелёным только при сгоревшем слоте.
  seen.length = 0
  answer = 503
  const down = await post({ question: 'вопрос лежащему сервису', mode: 'rag' }, '10.0.0.11')
  assert.equal(down.status, 502)
  assert.deepEqual(seen, [{ url: '/v1/runs' }], 'запрос до сервиса не дошёл — проверено не то')
  answer = 202

  // Потолок 3 исчерпан: два принятых запуска выше плюс сгоревший слот.
  const denied = await post({ question: 'законный после 502', mode: 'rag' }, '10.0.0.12')
  assert.equal(denied.status, 429, 'слот за 502 вернулся, хотя запуск мог завестись')
})

test('ПОТОЛОК ПРИ ЭТОМ ЖИВ: отказ потолка слота не возвращает', async () => {
  seen.length = 0
  // К этому месту потолок уже исчерпан предыдущими тестами: ещё один законный
  // запрос обязан получить отказ.
  const third = await post({ question: 'четвёртый законный вопрос', mode: 'rag' }, '10.0.0.6')
  assert.equal(third.status, 429, 'суточный потолок перестал держать')
  const json = await third.json()
  assert.equal(json.error, 'Суточный предел вопросов дня исчерпан. Попробуйте завтра.')
  // У суточного потолка секунд до повтора нет и взяться им неоткуда.
  assert.equal(json.retryAfterSec, null)
  // Отказ потолка до сервиса не доходит вовсе.
  assert.deepEqual(seen, [], 'отказ потолка ушёл в сервис')

  // И ОТКАЗ ПОТОЛКА СЛОТА НЕ ВОЗВРАЩАЕТ — иначе он отпускал бы сам себя:
  // следующий законный запрос обязан получить тот же отказ.
  const fourth = await post({ question: 'четвёртый законный вопрос', mode: 'rag' }, '10.0.0.7')
  assert.equal(fourth.status, 429, 'отказ потолка вернул слот и потолок развалился')
})
