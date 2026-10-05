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

const agents = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ url: req.url })
  res.writeHead(202, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ runId: 'run-slot' }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Потолок — 2: ровно столько, чтобы два мусорных POST его исчерпали, если
// слот не возвращается. Окна на адрес заведомо недостижимы: иначе отказ
// приходил бы от них, и предмет теста остался бы без держателя.
process.env.MAX_DAILY_CALLS = '2'
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

  // До сервиса агентов не дошло НИЧЕГО: все три отказа — наши.
  assert.deepEqual(seen, [], 'негодный запрос всё-таки ушёл в сервис')

  // А теперь законный запрос — с четвёртого адреса. При потолке 2 и без
  // возврата слота здесь был бы 429 «суточный предел исчерпан».
  const ok = await post({ question: 'где держится инвариант I-4', mode: 'rerank' }, '10.0.0.4')
  assert.equal(ok.status, 202, 'три мусорных POST погасили день')
  assert.equal((await ok.json()).runId, 'run-slot')
  // Улика дошедшего запроса — журнал стенда, а не код ответа.
  assert.deepEqual(seen, [{ url: '/v1/runs' }])
})

test('ПОТОЛОК ПРИ ЭТОМ ЖИВ: два принятых запуска его исчерпывают', async () => {
  seen.length = 0
  // Первый слот съел предыдущий тест, остался один.
  const second = await post({ question: 'второй законный вопрос', mode: 'rag' }, '10.0.0.5')
  assert.equal(second.status, 202)

  const third = await post({ question: 'третий законный вопрос', mode: 'rag' }, '10.0.0.6')
  assert.equal(third.status, 429, 'суточный потолок перестал держать')
  const json = await third.json()
  assert.equal(json.error, 'Суточный предел вопросов дня исчерпан. Попробуйте завтра.')
  // У суточного потолка секунд до повтора нет и взяться им неоткуда.
  assert.equal(json.retryAfterSec, null)
  // Отказ потолка до сервиса не доходит: в журнале только принятый запуск.
  assert.deepEqual(seen, [{ url: '/v1/runs' }])

  // И ОТКАЗ ПОТОЛКА СЛОТА НЕ ВОЗВРАЩАЕТ — иначе он отпускал бы сам себя:
  // следующий законный запрос обязан получить тот же отказ.
  const fourth = await post({ question: 'четвёртый законный вопрос', mode: 'rag' }, '10.0.0.7')
  assert.equal(fourth.status, 429, 'отказ потолка вернул слот и потолок развалился')
})
