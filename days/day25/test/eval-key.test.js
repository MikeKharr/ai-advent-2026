// Ключ оператора дня 25 (ADR 2026-10-05-1130): прогон проверки идёт мимо окон
// «в минуту/в час» НА АДРЕС, а суточный потолок остаётся.
//
// Предмет проверки — четыре утверждения, и улика у каждого различает гипотезы:
//
//   1. с ключом окно на адрес не считается — второй запрос в ту же минуту
//      доходит ДО СТЕНДА (журнал стенда, а не код ответа);
//   2. суточный потолок ключом НЕ снимается — отказ несёт текст именно
//      суточного окна, и до стенда не доходит;
//   3. неверный ключ — обычный посетитель: тот же код и тот же ТЕКСТ отказа
//      минутного окна, что и без заголовка вовсе. Оракула нет;
//   4. окно ЗАПИСЕЙ профиля ключом не снимается (ADR, п. 8) — прогон профилей
//      не правит, и снятое окно пришлось бы держать отдельно.
//
// Ручка для проверки — `POST /api/invariants/draft`: единственная у дня
// запись таблицы с окном `run` и известным заранее числом слотов (`slots: 1`).
// У ручки сообщения `slots: 'own'`, и число берётся из настроек профиля —
// считать слоты в тесте было бы сложнее без выигрыша.
//
// Числа окружения подобраны так, чтобы всё поместилось в один процесс:
// минутное окно = 1, окно записей = 1, суточный потолок = 4 — ровно столько
// слотов тратят тесты ниже. Поэтому тесты файла идут ПО ПОРЯДКУ и считают
// слоты: порядок здесь — часть постановки, а не стиль.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { createLimiter, EVAL_HEADER, isOperator } from '../limits.js'

const AGENT_KEY = 'agent-key-secret-eval-do-not-leak'
const EVAL_KEY = 'eval-key-secret-do-not-leak-32-chars'
const PID = '11111111-1111-4111-8111-111111111111'

/** @type {{method:string,url:string}[]} журнал стенда сервиса агентов */
const seen = []

const agents = http.createServer(async (req, res) => {
  for await (const _ of req) void _
  seen.push({ method: req.method, url: req.url })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, draft: { variants: [], ticket: 't' } }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = AGENT_KEY
process.env.EVAL_KEY = EVAL_KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '1'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '1'
process.env.MAX_DAILY_CALLS = '4'

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

/** Ручка окна запусков. `body` — строка: негодное тело тоже нужно послать. */
const draft = (ip, key, body = JSON.stringify({ text: 'правило' })) =>
  fetch(`${base}/api/invariants/draft`, {
    method: 'POST',
    headers: {
      'x-forwarded-for': ip,
      'content-type': 'application/json',
      cookie: `day25_pid=${PID}`,
      ...(key === undefined ? {} : { [EVAL_HEADER]: key }),
    },
    body,
  })

/** Ручка окна ЗАПИСЕЙ профиля: её ключ оператора не касается. */
const write = (ip, key) =>
  fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: {
      'x-forwarded-for': ip,
      'content-type': 'application/json',
      cookie: `day25_pid=${PID}`,
      ...(key === undefined ? {} : { [EVAL_HEADER]: key }),
    },
    body: JSON.stringify({ strategy: 'window' }),
  })

const MINUTE_DENIAL = 'Слишком часто. Подождите минуту.'
const WRITES_DENIAL = 'Слишком много изменений профилей за час. Попробуйте позже.'

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
  const numbers = {
    RATE_LIMIT_PER_MIN: 1,
    RATE_LIMIT_PER_HOUR: 1000,
    RATE_LIMIT_WRITES_PER_HOUR: 1000,
    MAX_DAILY_CALLS: 2,
  }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  assert.equal(limiter.reserve('1.1.1.1', 1, { operator: true }).ok, true)
  // Второй запрос в ту же минуту: без ключа это отказ `minute`.
  assert.equal(limiter.reserve('1.1.1.1', 1, { operator: true }).ok, true, 'окно на адрес ключом не снято')
  const denied = limiter.reserve('1.1.1.1', 1, { operator: true })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'daily', 'оператор прошёл мимо суточного потолка')
  assert.equal(limiter.stats().callsToday, 2, 'запуски оператора не попали в суточный счётчик')
})

test('лимитер: число слотов оператор берёт то же, и возврат их отдаёт', () => {
  const numbers = {
    RATE_LIMIT_PER_MIN: 1,
    RATE_LIMIT_PER_HOUR: 1000,
    RATE_LIMIT_WRITES_PER_HOUR: 1000,
    MAX_DAILY_CALLS: 10,
  }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  const got = limiter.reserve('1.1.1.1', 3, { operator: true })
  assert.equal(got.ok, true)
  assert.equal(got.reserved, 3, 'оператору выдано не столько слотов, сколько просил')
  assert.equal(limiter.stats().callsToday, 3)
  limiter.release(3)
  assert.equal(limiter.stats().callsToday, 0)
})

test('лимитер: без ключа окно на адрес на месте (контрольная ветвь)', () => {
  const numbers = {
    RATE_LIMIT_PER_MIN: 1,
    RATE_LIMIT_PER_HOUR: 1000,
    RATE_LIMIT_WRITES_PER_HOUR: 1000,
    MAX_DAILY_CALLS: 100,
  }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  assert.equal(limiter.reserve('1.1.1.1').ok, true)
  const denied = limiter.reserve('1.1.1.1')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'minute')
  // Умолчание безопасное: ключа нет в аргументах вовсе — окно считается.
  assert.equal(limiter.reserve('1.1.1.1', 1, {}).ok, false)
})

test('лимитер: адрес оператора не запоминается — хранить нечего (I-10)', () => {
  const numbers = {
    RATE_LIMIT_PER_MIN: 1,
    RATE_LIMIT_PER_HOUR: 1000,
    RATE_LIMIT_WRITES_PER_HOUR: 1000,
    MAX_DAILY_CALLS: 100,
  }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  limiter.reserve('1.1.1.1', 1, { operator: true })
  assert.equal(limiter.stats().trackedIps, 0, 'адрес оператора попал в хранение окна')
})

test('лимитер: окно записей профиля ключом не снимается вовсе', () => {
  const numbers = {
    RATE_LIMIT_PER_MIN: 1000,
    RATE_LIMIT_PER_HOUR: 1000,
    RATE_LIMIT_WRITES_PER_HOUR: 1,
    MAX_DAILY_CALLS: 100,
  }
  const limiter = createLimiter(numbers, { now: () => Date.UTC(2026, 9, 5, 11) })
  assert.equal(limiter.reserveWrite('1.1.1.1').ok, true)
  // У `reserveWrite` параметра ключа нет и не появилось: окно записей про
  // общую память, а не про частоту прогона.
  assert.equal(limiter.reserveWrite('1.1.1.1', { operator: true }).ok, false, 'ключ снял окно записей')
})

// ─── Через HTTP: слоты суточного потолка тратятся по-настоящему, порядок важен.

test('без ключа и с НЕВЕРНЫМ ключом — один и тот же отказ окна: оракула нет', async () => {
  const ip = '10.25.0.1'
  assert.equal((await draft(ip)).status, 200, 'первому запросу слот не выдан') // слот 1 из 4

  seen.length = 0
  const plain = await draft(ip)
  const plainBody = await plain.json()
  assert.equal(plain.status, 429)
  assert.equal(plainBody.error, MINUTE_DENIAL)

  const wrong = await draft(ip, `${EVAL_KEY}-wrong`) // значение заголовка — только ASCII
  const wrongBody = await wrong.json()
  assert.equal(wrong.status, plain.status, 'неверный ключ дал другой код ответа — это оракул')
  assert.equal(wrongBody.error, plainBody.error, 'отказ неверному ключу отличается текстом — это оракул')

  // Улика различает гипотезы: отказ не только вернул 429, но и не дошёл до
  // стенда — код ответа день отдал бы и сходив в службу.
  assert.deepEqual(seen, [], `отказ дошёл до службы: ${JSON.stringify(seen)}`)
})

test('с верным ключом окно на адрес снято', async () => {
  const ip = '10.25.0.2'
  seen.length = 0
  assert.equal((await draft(ip, EVAL_KEY)).status, 200) // слот 2 из 4
  // Второй запрос в ту же минуту с того же адреса: без ключа здесь 429.
  assert.equal((await draft(ip, EVAL_KEY)).status, 200, 'ключ не снял минутное окно') // слот 3 из 4
  assert.equal(seen.length, 2, `до стенда дошли не оба запроса: ${JSON.stringify(seen)}`)
})

test('негодное тело с ключом слота не ест: 4xx возвращает и слот оператора', async () => {
  const ip = '10.25.0.3'
  seen.length = 0
  // Занято 3 слота из 4. Негодное тело берёт четвёртый и обязано вернуть его:
  // иначе законный запрос сразу за ним упёрся бы в сутки (решение владельца
  // Р8(б), ADR 2026-10-05-0544, п. 6). Это и проверяет пара ниже.
  const bad = await draft(ip, EVAL_KEY, 'не JSON вовсе')
  assert.equal(bad.status, 400, 'негодное тело прошло дальше формы')
  assert.deepEqual(seen, [], `отказ формы дошёл до службы: ${JSON.stringify(seen)}`)

  const again = await draft(ip, EVAL_KEY) // снова слот 4 из 4 — тот самый, что вернулся
  assert.equal(again.status, 200, 'слот оператора после 4xx не вернулся — упёрлись в сутки')
})

test('суточный потолок ключом не снимается', async () => {
  const ip = '10.25.0.4'
  seen.length = 0
  const denied = await draft(ip, EVAL_KEY)
  assert.equal(denied.status, 429, 'оператор прошёл мимо суточного потолка')
  assert.match((await denied.json()).error, /Суточный лимит/, 'отказало не суточное окно')
  assert.deepEqual(seen, [], `отказ суточного потолка дошёл до службы: ${JSON.stringify(seen)}`)
})

test('окно записей профиля ключом не снимается и через HTTP', async () => {
  const ip = '10.25.0.5'
  assert.notEqual((await write(ip, EVAL_KEY)).status, 429, 'первому запросу записи слот не выдан')
  const denied = await write(ip, EVAL_KEY)
  assert.equal(denied.status, 429, 'ключ оператора снял окно записей профиля')
  assert.equal((await denied.json()).error, WRITES_DENIAL, 'отказало не окно записей')
})

// ─── Ключ не уходит наружу (I-1).

test('ключа оператора нет ни в одном ответе дня: ни в /healthz, ни на странице', async () => {
  assert.equal(env.EVAL_KEY, EVAL_KEY, 'день не прочитал EVAL_KEY — проверять утечку нечего')
  for (const path of ['/healthz', '/']) {
    const res = await fetch(`${base}${path}`)
    const text = await res.text()
    assert.ok(!text.includes(EVAL_KEY), `${path}: ключ оператора в ответе`)
    assert.ok(!text.includes(AGENT_KEY), `${path}: ключ сервиса агентов в ответе`)
    // Имя заголовка на странице тоже не нужно: заголовок ставит раннер, а не
    // браузер посетителя.
    if (path !== '/healthz') assert.ok(!text.includes(EVAL_HEADER), `${path}: страница знает про ${EVAL_HEADER}`)
  }
})
