// Интеграционный тест: настоящий сервер дня против ПОДДЕЛЬНОГО сервиса агентов
// на локальном порту. Предмет проверки:
//
//   1. ключ AGENT_KEY не появляется ни в одном ответе (I-1), а до сервиса
//      агентов доходит — и это видно по ЖУРНАЛУ стенда, не по коду ответа;
//   2. поток событий уходит на страницу насквозь, байт в байт: тела JSON-RPC
//      внутри стадии `rpc` и есть предмет показа;
//   3. слот лимитера берётся ДО обращения к сервису (I-4);
//   4. идентификатор запуска из URL не уходит в сервис не проверенным.
//
// Стенд НЕ пересказывает представление автора о сервисе: он записывает всё,
// что получил, и отдаёт то, что ему велено, — иначе тест проверял бы согласие
// заглушки с кодом, а не код.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

// Ключ только из ASCII: значение заголовка — ByteString.
const KEY = 'agent-key-secret-7c1b-do-not-leak'

/** @type {{method:string,url:string,headers:object,body:string}[]} журнал стенда */
const seen = []
let runsReply = { status: 202, body: JSON.stringify({ runId: 'run-abc' }) }
/** Точные байты потока событий, которые стенд отдаст на /events. */
let eventsBody = ''
let eventsStatus = 200
/** Что стенд отдаёт на /v1/sessions/:id — переписку или отказ. */
let sessionsReply = { status: 200, body: JSON.stringify({ ok: true, messages: [] }) }

const agents = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() })

  if (req.url.startsWith('/v1/sessions/')) {
    res.writeHead(sessionsReply.status, { 'content-type': 'application/json' })
    return res.end(sessionsReply.body)
  }

  if (req.url.endsWith('/events')) {
    if (eventsStatus !== 200) {
      res.writeHead(eventsStatus, { 'content-type': 'application/json' })
      return res.end('{"error":"нет"}')
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(eventsBody)
    return res.end()
  }
  res.writeHead(runsReply.status, { 'content-type': 'application/json' })
  res.end(runsReply.body)
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '3'
process.env.RATE_LIMIT_PER_HOUR = '6'
// Потолок заведомо недостижим в этом файле: будь он близко, отказ приходил
// бы от него, и минутное окно осталось бы без держателя. Сам потолок держит
// test/limits.test.js.
process.env.MAX_DAILY_CALLS = '50'

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

const post = (task, ip = '10.0.0.1') =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ task }),
  })

test('/healthz зелёный при заданном ключе и не печатает сам ключ', async () => {
  const res = await fetch(`${base}/healthz`)
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!text.includes(KEY), 'ключ в /healthz')
})

test('запуск создаётся: стенд ВИДЕЛ запрос с ключом — свидетельство из его журнала', async () => {
  seen.length = 0
  const res = await post('fintech', '10.0.0.2')
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { runId: 'run-abc' })

  // Улика — запись стенда, а не код ответа: код 202 стенд отдал бы и без ключа.
  const entry = seen.find((s) => s.url === '/v1/runs')
  assert.ok(entry, 'сервис агентов запроса не видел')
  assert.equal(entry.headers.authorization, `Bearer ${KEY}`)
  assert.equal(JSON.parse(entry.body).agent, env.AGENT_ID)
  assert.equal(JSON.parse(entry.body).input.task, 'fintech')
})

test('ключ не появляется ни в одном ответе /api/* (I-1)', async () => {
  const bodies = [await (await post('fintech', '10.0.0.3')).text(), await (await fetch(`${base}/api/runs/run-abc/events`)).text()]
  for (const body of bodies) assert.ok(!body.includes(KEY), `ключ утёк: ${body.slice(0, 120)}`)
})

test('пустое и слишком длинное задание до сервиса не доходят', async () => {
  seen.length = 0
  assert.equal((await post('   ', '10.0.0.4')).status, 400)
  assert.equal((await post('x'.repeat(601), '10.0.0.4')).status, 400)
  assert.equal(seen.length, 0, 'отвергнутый запрос всё-таки ушёл в сервис агентов')
})

test('слот берётся ДО обращения к сервису: четвёртый запрос за минуту не доходит', async () => {
  seen.length = 0
  const answers = []
  for (let i = 0; i < 4; i += 1) answers.push(await post('fintech', '10.0.0.9'))
  assert.deepEqual(
    answers.map((r) => r.status),
    [202, 202, 202, 429],
  )
  assert.equal(seen.filter((s) => s.url === '/v1/runs').length, 3, 'отказ лимитера всё-таки дошёл до сервиса')
  // Отказ обязан прийти ИМЕННО от минутного окна. Один только код 429 гипотез
  // не различает: суточный потолок отвечает тем же кодом, и при снятом
  // минутном окне тест остался бы зелёным.
  const denied = await answers[3].json()
  assert.equal(denied.error, 'Предел запросов страницы: слишком часто.')
  assert.ok(Number.isInteger(denied.retryAfterSec) && denied.retryAfterSec > 0, `секунды: ${denied.retryAfterSec}`)
})

test('адрес берётся из ХВОСТА X-Forwarded-For: подделка головы окно не обходит', async () => {
  const ip = '10.0.0.11'
  for (let i = 0; i < 3; i += 1) await post('fintech', ip)
  // Caddy ДОПИСЫВАЕТ реальный адрес в конец: голову подделывает сам клиент.
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.9, ${ip}` },
    body: JSON.stringify({ task: 'fintech' }),
  })
  assert.equal(res.status, 429, 'подделанная голова X-Forwarded-For дала новое окно')
})

test('поток событий уходит насквозь: те же байты, включая сырые тела JSON-RPC', async () => {
  eventsBody =
    'event: event\ndata: {"stage":"rpc","data":{"server":"mcpnews","method":"tools/call","request":{"a":1},"response":{"b":"ц"},"status":200,"ms":12}}\n\n' +
    'event: end\ndata: {"status":"succeeded"}\n\n'
  const res = await fetch(`${base}/api/runs/run-abc/events`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  assert.equal(await res.text(), eventsBody)
})

test('идентификатор запуска вне [A-Za-z0-9-] в сервис не уходит', async () => {
  seen.length = 0
  const res = await fetch(`${base}/api/runs/..%2Fadmin/events`)
  assert.equal(res.status, 404)
  assert.equal(seen.length, 0, 'битый идентификатор всё-таки ушёл в сервис агентов')
})

test('сервис ответил 404 на поток — день говорит «запуск не найден», а не выдумывает поток', async () => {
  eventsStatus = 404
  const res = await fetch(`${base}/api/runs/run-zzz/events`)
  eventsStatus = 200
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'Запуск не найден')
})

test('страница отдаётся статикой и подключает style.css', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.ok((await res.text()).includes('<link rel="stylesheet" href="style.css">'))
})

// ——— Диалог с сессией (ADR 2026-09-28-1852, заход 2, п. 2). Предмет тот же:
// улика — журнал стенда, а не код ответа.

/** Значение cookie дня из заголовков ответа или null. */
const sidOf = (res) => {
  for (const raw of res.headers.getSetCookie())
    if (raw.startsWith('day20_sid=')) return raw
  return null
}

test('первый запуск получает cookie сессии от СЕРВЕРА: HttpOnly, SameSite=Lax, путь дня', async () => {
  const res = await post('fintech', '10.0.1.1')
  const cookie = sidOf(res)
  assert.ok(cookie, 'cookie сессии не выдана')
  assert.match(cookie, /^day20_sid=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12};/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\/day20\//)
  assert.match(cookie, /Max-Age=108000/)
})

test('sessionId уходит в сервис ИЗ COOKIE, а тот, что подставлен в тело, не принимается', async () => {
  seen.length = 0
  const mine = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.1.2',
      cookie: `day20_sid=${mine}`,
    },
    body: JSON.stringify({ task: 'fintech', sessionId: foreign }),
  })
  assert.equal(res.status, 202)
  const entry = seen.find((s) => s.url === '/v1/runs')
  assert.equal(JSON.parse(entry.body).input.sessionId, mine)
  // Улика различает гипотезы: совпадение с cookie ещё не значит, что тело
  // проигнорировано, — поэтому проверяется и отсутствие чужого значения.
  assert.ok(!entry.body.includes(foreign), `идентификатор из тела дошёл до сервиса: ${entry.body}`)
})

test('cookie чужой формы не принимается: сервер чеканит новую, а не шлёт мусор в сервис', async () => {
  seen.length = 0
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.1.3', cookie: 'day20_sid=../../etc/passwd' },
    body: JSON.stringify({ task: 'fintech' }),
  })
  assert.equal(res.status, 202)
  const entry = seen.find((s) => s.url === '/v1/runs')
  assert.ok(!entry.body.includes('passwd'), `чужое значение cookie ушло в сервис: ${entry.body}`)
  assert.match(JSON.parse(entry.body).input.sessionId, /^[0-9a-f-]{36}$/)
})

test('cookie уходит и с отказом: пустое задание не оставляет посетителя без сессии', async () => {
  const res = await post('   ', '10.0.1.4')
  assert.equal(res.status, 400)
  assert.ok(sidOf(res), 'отказ ушёл без cookie — следующее сообщение начало бы новый диалог')
})

test('переписка читается по сессии из cookie и с ключом сервиса — свидетельство из журнала стенда', async () => {
  seen.length = 0
  const sid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  sessionsReply = {
    status: 200,
    body: JSON.stringify({
      ok: true,
      messages: [
        { id: 1, role: 'user', text: 'что нового', meta: null },
        { id: 2, role: 'agent', text: 'итог', meta: { rounds: [{ round: 1, text: 'смотрю новости', chosen: [] }], calls: 1 } },
      ],
    }),
  }
  const res = await fetch(`${base}/api/chat`, { headers: { cookie: `day20_sid=${sid}` } })
  assert.equal(res.status, 200)
  const json = await res.json()
  // Слова кругов доезжают до страницы: именно они переживают перезагрузку.
  assert.equal(json.messages[1].meta.rounds[0].text, 'смотрю новости')

  const entry = seen.find((s) => s.url === `/v1/sessions/${sid}`)
  assert.ok(entry, 'сервис агентов запроса переписки не видел')
  assert.equal(entry.method, 'GET')
  assert.equal(entry.headers.authorization, `Bearer ${KEY}`)
})

test('ключ не появляется в ответе /api/chat (I-1)', async () => {
  const text = await (await fetch(`${base}/api/chat`, { headers: { cookie: 'day20_sid=cccccccc-cccc-4ccc-8ccc-cccccccccccc' } })).text()
  assert.ok(!text.includes(KEY), `ключ утёк: ${text.slice(0, 120)}`)
})

test('очистка доходит до сервиса удалением и меняет cookie только после подтверждения', async () => {
  seen.length = 0
  const sid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  sessionsReply = { status: 200, body: JSON.stringify({ ok: true, removed: 2 }) }
  const res = await fetch(`${base}/api/chat`, { method: 'DELETE', headers: { cookie: `day20_sid=${sid}` } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { messages: [], cleared: true })
  const entry = seen.find((s) => s.url === `/v1/sessions/${sid}`)
  assert.ok(entry && entry.method === 'DELETE', 'удаление до сервиса не дошло')
  const fresh = sidOf(res)
  assert.ok(fresh && !fresh.includes(sid), 'старый идентификатор остался в браузере')
})

test('сервис не подтвердил удаление — cookie не меняется, иначе переписку не удалить уже никогда', async () => {
  const sid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  sessionsReply = { status: 500, body: '{"ok":false}' }
  const res = await fetch(`${base}/api/chat`, { method: 'DELETE', headers: { cookie: `day20_sid=${sid}` } })
  sessionsReply = { status: 200, body: JSON.stringify({ ok: true, messages: [] }) }
  assert.equal(res.status, 502)
  // Идентификатор остаётся ТОТ ЖЕ: пока сервис не подтвердил удаление,
  // переписка жива, и ключ к ней терять нельзя.
  assert.ok(sidOf(res).includes(sid), `после неудачной очистки сервер сменил cookie: ${sidOf(res)}`)
})

test('память диалога недоступна — день говорит это словом, а не пустой перепиской', async () => {
  sessionsReply = { status: 503, body: JSON.stringify({ ok: false, code: 'no_sessions' }) }
  const res = await fetch(`${base}/api/chat`, { headers: { cookie: 'day20_sid=ffffffff-ffff-4fff-8fff-ffffffffffff' } })
  sessionsReply = { status: 200, body: JSON.stringify({ ok: true, messages: [] }) }
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /недоступна/)
})
