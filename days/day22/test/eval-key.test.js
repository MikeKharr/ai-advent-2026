// Ключ оператора дня 22 (ADR 2026-10-05-1130): прогон проверки идёт мимо окон
// «в минуту/в час» НА АДРЕС, а суточный потолок остаётся.
//
// Предмет проверки здесь — ТРИ утверждения, и каждое проверяется так, чтобы
// улика различала гипотезы:
//
//   1. с ключом окно на адрес не считается — второй запрос в ту же минуту
//      доходит ДО СТЕНДА (журнал стенда, а не код ответа);
//   2. суточный потолок ключом НЕ снимается — отказ несёт текст именно
//      суточного окна, и до стенда не доходит;
//   3. неверный ключ — обычный посетитель: тот же код, тот же ТЕКСТ отказа
//      минутного окна, что и без заголовка вовсе. Оракула нет.
//
// Числа окружения подобраны так, чтобы все три поместились в один процесс:
// минутное окно = 1 (второй запрос обязан упереться без ключа), суточный
// потолок = 3 (ровно столько слотов тратят тесты ниже, и четвёртый обращение
// упирается в сутки). Поэтому тесты файла идут ПО ПОРЯДКУ и считают слоты:
// порядок здесь — часть постановки, а не стиль.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { createLimiter, EVAL_HEADER, isOperator } from '../limits.js'

const AGENT_KEY = 'agent-key-secret-eval-do-not-leak'
const EVAL_KEY = 'eval-key-secret-do-not-leak-32-chars'

/** @type {{method:string,url:string}[]} журнал стенда сервиса агентов */
const seen = []

const agents = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ method: req.method, url: req.url })
  res.writeHead(202, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ runId: 'run-abc' }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = AGENT_KEY
process.env.EVAL_KEY = EVAL_KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '1'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_READS_PER_HOUR = '1000'
process.env.MAX_DAILY_CALLS = '3'

const { env, server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const ask = (ip, key) =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: {
      'x-forwarded-for': ip,
      'content-type': 'application/json',
      ...(key === undefined ? {} : { [EVAL_HEADER]: key }),
    },
    body: JSON.stringify({ question: 'где держится I-4', mode: 'norag' }),
  })

const MINUTE_DENIAL = 'Предел запросов страницы: слишком часто.'

// ─── Сверка ключа как таковая. Стенд здесь не участвует.

test('пустой EVAL_KEY — возможности нет вовсе: не совпадает ни с чем, включая пустой заголовок', () => {
  const off = { EVAL_KEY: '' }
  assert.equal(isOperator(off, ''), false, 'пустой заголовок совпал с пустым ключом — окна сняты у всех')
  assert.equal(isOperator(off, 'что угодно'), false)
  assert.equal(isOperator(off, undefined), false)
  // Переменной нет вовсе — то же самое, и это отдельная гипотеза: `?? ''`
  // против `undefined` ведёт себя иначе, чем против пустой строки.
  assert.equal(isOperator({}, ''), false)
  assert.equal(isOperator({}, 'что угодно'), false)
})

test('верный ключ опознаётся, неверный — нет, и длина ключа ответом не выдаётся', () => {
  const on = { EVAL_KEY }
  assert.equal(isOperator(on, EVAL_KEY), true)
  assert.equal(isOperator(on, `${EVAL_KEY}x`), false, 'ключ с лишним знаком принят')
  assert.equal(isOperator(on, EVAL_KEY.slice(0, -1)), false, 'обрезанный ключ принят')
  assert.equal(isOperator(on, EVAL_KEY.toUpperCase()), false)
  // Строка другой длины НЕ бросает исключение: сверка идёт по свёрткам, и
  // мутация «сравнивать сырые буферы» красит этот assert падением
  // `timingSafeEqual` на разной длине.
  assert.equal(isOperator(on, 'x'), false)
  assert.equal(isOperator(on, undefined), false)
  assert.equal(isOperator(on, Buffer.from(EVAL_KEY)), false, 'не-строка принята за ключ')
})

// ─── Сам лимитер: что именно снимается ключом, а что нет.

test('лимитер: с ключом минутное окно не считается, суточный потолок считается', () => {
  const numbers = { RATE_LIMIT_PER_MIN: 1, RATE_LIMIT_PER_HOUR: 1000, MAX_DAILY_CALLS: 2 }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  assert.equal(limiter.reserve('1.1.1.1', { operator: true }).ok, true)
  // Второй запрос в ту же минуту: без ключа это отказ `minute`.
  assert.equal(limiter.reserve('1.1.1.1', { operator: true }).ok, true, 'окно на адрес ключом не снято')
  // Слоты суточного потолка оператор тратит наравне со всеми — здесь их 2.
  const denied = limiter.reserve('1.1.1.1', { operator: true })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'daily', 'оператор прошёл мимо суточного потолка')
  assert.equal(limiter.stats().callsToday, 2, 'запуски оператора не попали в суточный счётчик')
})

test('лимитер: без ключа окно на адрес на месте (контрольная ветвь)', () => {
  const numbers = { RATE_LIMIT_PER_MIN: 1, RATE_LIMIT_PER_HOUR: 1000, MAX_DAILY_CALLS: 100 }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
  const denied = limiter.reserve('1.1.1.1')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'minute')
  // Умолчание безопасное: ключа нет в аргументах вовсе — окно считается.
  assert.equal(limiter.reserve('1.1.1.1', {}).ok, false)
})

test('лимитер: адрес оператора не запоминается — хранить нечего (I-10)', () => {
  const numbers = { RATE_LIMIT_PER_MIN: 1, RATE_LIMIT_PER_HOUR: 1000, MAX_DAILY_CALLS: 100 }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  limiter.reserve('1.1.1.1', { operator: true })
  assert.equal(limiter.stats().trackedIps, 0, 'адрес оператора попал в хранение окна')
})

// ─── Через HTTP: слоты суточного потолка тратятся по-настоящему, порядок важен.

test('без ключа и с НЕВЕРНЫМ ключом — один и тот же отказ окна: оракула нет', async () => {
  const ip = '10.22.0.1'
  assert.equal((await ask(ip)).status, 202, 'первому запросу слот не выдан') // слот 1 из 3

  seen.length = 0
  const plain = await ask(ip)
  const plainBody = await plain.json()
  assert.equal(plain.status, 429)
  assert.equal(plainBody.error, MINUTE_DENIAL)

  const wrong = await ask(ip, `${EVAL_KEY}-wrong`) // значение заголовка — только ASCII
  const wrongBody = await wrong.json()
  assert.equal(wrong.status, plain.status, 'неверный ключ дал другой код ответа — это оракул')
  assert.equal(wrongBody.error, plainBody.error, 'отказ неверному ключу отличается текстом — это оракул')
  assert.equal(wrong.headers.get('retry-after'), plain.headers.get('retry-after'), 'заголовки отказов различаются')

  // Улика различает гипотезы: отказ не только вернул 429, но и не дошёл до
  // стенда — код ответа день отдал бы и сходив в сервис.
  assert.deepEqual(seen, [], `отказ дошёл до сервиса: ${JSON.stringify(seen)}`)
})

test('с верным ключом окно на адрес снято, а суточный потолок — нет', async () => {
  const ip = '10.22.0.2'

  seen.length = 0
  assert.equal((await ask(ip, EVAL_KEY)).status, 202) // слот 2 из 3
  // Второй запрос в ту же минуту с того же адреса: без ключа здесь 429.
  assert.equal((await ask(ip, EVAL_KEY)).status, 202, 'ключ не снял минутное окно') // слот 3 из 3
  assert.equal(seen.length, 2, `до стенда дошли не оба запуска: ${JSON.stringify(seen)}`)

  // Слоты суток кончились (1 + 2 = 3 из 3). Ключ их не добавляет.
  seen.length = 0
  const denied = await ask(ip, EVAL_KEY)
  assert.equal(denied.status, 429, 'оператор прошёл мимо суточного потолка')
  const body = await denied.json()
  assert.match(body.error, /Суточный предел/, 'отказало не суточное окно')
  assert.equal(body.retryAfterSec, null)
  assert.deepEqual(seen, [], `отказ суточного потолка дошёл до сервиса: ${JSON.stringify(seen)}`)
})

// ─── Ключ не уходит наружу (I-1).

test('ключа оператора нет ни в одном ответе дня: ни в /healthz, ни на странице, ни в её JS', async () => {
  assert.equal(env.EVAL_KEY, EVAL_KEY, 'день не прочитал EVAL_KEY — проверять утечку нечего')
  for (const path of ['/healthz', '/', '/app.js', '/style.css']) {
    const res = await fetch(`${base}${path}`)
    const text = await res.text()
    assert.ok(!text.includes(EVAL_KEY), `${path}: ключ оператора в ответе`)
    assert.ok(!text.includes(AGENT_KEY), `${path}: ключ сервиса агентов в ответе`)
    // Имя заголовка на странице тоже не нужно: заголовок ставит раннер, а не
    // браузер посетителя.
    if (path !== '/healthz') assert.ok(!text.includes(EVAL_HEADER), `${path}: страница знает про ${EVAL_HEADER}`)
  }
})
