// Правила страницы — исполнением, а не поиском строки в исходнике.
// Модуль public/console.js импортируется и вызывается: это тот же код, что
// исполняет браузер. Проверка поиском по тексту страницы была бы слепа к
// строке, разорванной склейкой, и к правилу, которое осталось верным, но
// перестало вызываться (agent_docs/guides/verification.md).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  BODY_LIMIT,
  EMPTY_BODY,
  clipBody,
  describe as verdict,
  formatBytes,
  formatMs,
  metaLine,
  parseCommand,
  partialNotes,
  reindent,
  statusLine,
} from '../public/console.js'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

/** Подписи готовых команд прямо из разметки: кнопка *есть* команда (раскладка, п. 4.1). */
const chips = [...page.matchAll(/<button class="chip" type="button">([^<]+)<\/button>/g)].map((m) => m[1])

test('на странице семь готовых команд в закреплённом порядке', () => {
  assert.deepEqual(chips, [
    'initialize',
    'tools/list',
    'tools/call clock.now {}',
    'tools/call weather.current {"city":"Сингапур"}',
    'tools/call wiki.summary {"title":"JSON-RPC"}',
    'GET',
    'initialize --no-key',
  ])
})

test('каждая готовая команда разбирается — ни одна кнопка не ведёт в отказ разбора', () => {
  for (const text of chips) {
    const got = parseCommand(text, 1)
    assert.equal(got.ok, true, `кнопка «${text}» не разобралась: ${got.message}`)
    assert.equal(got.text, text, 'в поле встаёт текст кнопки целиком и без правок')
  }
})

test('initialize собирает конверт с той же ревизией, что названа в строке соединения', () => {
  const got = parseCommand('initialize', 7)
  assert.equal(got.http, 'POST')
  assert.equal(got.noKey, false)
  assert.equal(got.rpc.jsonrpc, '2.0')
  assert.equal(got.rpc.id, 7)
  assert.equal(got.rpc.method, 'initialize')
  assert.equal(got.rpc.params.protocolVersion, '2025-11-25')
  assert.ok(page.includes('MCP-Protocol-Version <b>2025-11-25</b>'), 'подпись на странице обязана совпадать')
})

test('tools/call разбирает имя и аргументы; пустые аргументы — {}', () => {
  const full = parseCommand('tools/call weather.current {"city":"Сингапур"}', 3)
  assert.equal(full.rpc.method, 'tools/call')
  assert.equal(full.rpc.params.name, 'weather.current')
  assert.deepEqual(full.rpc.params.arguments, { city: 'Сингапур' })
  const bare = parseCommand('tools/call clock.now', 4)
  assert.deepEqual(bare.rpc.params.arguments, {})
  assert.deepEqual(parseCommand('tools/call clock.now {}', 5).rpc.params.arguments, {})
})

test('GET — проба метода: тела нет, конверт не собирается', () => {
  const got = parseCommand('GET', 1)
  assert.equal(got.http, 'GET')
  assert.equal(got.rpc, null)
})

test('--no-key снимается с хвоста и становится признаком, а не частью команды', () => {
  const got = parseCommand('initialize --no-key', 2)
  assert.equal(got.noKey, true)
  assert.equal(got.rpc.method, 'initialize', 'команда разобрана без хвоста')
  assert.equal(got.text, 'initialize --no-key', 'в записи ленты видна набранная строка целиком')
  assert.equal(parseCommand('tools/list --no-key', 2).noKey, true)
  assert.equal(parseCommand('tools/list', 2).noKey, false)
})

test('неизвестная команда не отправляется и не исправляется', () => {
  const got = parseCommand('tool/list', 1)
  assert.equal(got.ok, false)
  assert.equal(
    got.message,
    'Не отправлено: нет команды «tool/list». Есть: initialize, tools/list, tools/call <имя> <json>, GET.',
  )
  assert.equal(parseCommand('tools/List', 1).ok, false, 'регистр не «исправляется»')
  assert.equal(parseCommand('', 1).ok, false)
  assert.equal(parseCommand('--no-key', 1).ok, false)
})

test('битые аргументы не отправляются: причина — от JSON.parse, а не «что-то не так»', () => {
  const got = parseCommand('tools/call weather.current {city:Сингапур}', 1)
  assert.equal(got.ok, false)
  assert.match(got.message, /^Не отправлено: аргументы не разбираются как JSON — /)
  assert.ok(got.message.length > 'Не отправлено: аргументы не разбираются как JSON — '.length)
  // Массив и число — разобрались как JSON, но конверт tools/call их не примет.
  assert.equal(parseCommand('tools/call clock.now [1,2]', 1).ok, false)
  assert.equal(parseCommand('tools/call clock.now 5', 1).ok, false)
  assert.equal(parseCommand('tools/call', 1).ok, false, 'tools/call без имени инструмента')
})

test('исход «ок» — только 2xx с result без isError', () => {
  const ok = verdict({ outcome: 'upstream', status: 200, bodyText: '{"result":{"tools":[]},"id":1}' })
  assert.deepEqual(ok, { kind: 'ok', note: 'Ответ получен.' })
})

test('isError — нейтральный результат, и пояснение это говорит', () => {
  const got = verdict({
    outcome: 'upstream',
    status: 200,
    bodyText: '{"result":{"isError":true,"content":[{"type":"text","text":"город не найден"}]},"id":1}',
  })
  assert.equal(got.kind, 'proto')
  assert.match(got.note, /isError/)
  assert.equal(/что-то пошло не так|попробуйте позже/i.test(got.note), false)
  assert.equal(got.note.includes('город не найден'), false, 'пояснение объясняет код, а не пересказывает тело')
})

test('ошибка JSON-RPC называет свой код и остаётся нейтральной', () => {
  const got = verdict({ outcome: 'upstream', status: 200, bodyText: '{"error":{"code":-32601,"message":"x"},"id":1}' })
  assert.equal(got.kind, 'proto')
  assert.match(got.note, /-32601/)
})

test('404 и 405 — НЕ красные: это результат, сервер ответил', () => {
  for (const status of [404, 405, 406, 415, 400, 500, 503]) {
    const got = verdict({ outcome: 'upstream', status, bodyText: '{"error":"x"}' })
    assert.equal(got.kind, 'proto', `${status} обязан быть нейтральным`)
    assert.ok(got.note.startsWith(String(status)), `пояснение ${status} называет код словом: ${got.note}`)
  }
  assert.match(verdict({ outcome: 'upstream', status: 405, bodyText: '' }).note, /только POST/)
})

test('проба ключа объясняет ПРИЁМ, а не отказ в доступе', () => {
  // Служба без годного ключа отвечает так, будто её нет (решение владельца
  // 2026-09-23, ADR 2026-09-23-1844). Пояснение, обещающее «нет доступа», разошлось бы с
  // механизмом: доступ ничем не отказан, эндпоинт просто не признаётся.
  const got = verdict({ outcome: 'upstream', status: 404, bodyText: '' })
  assert.equal(got.kind, 'proto', 'спрятанный эндпоинт — не сбой соединения')
  assert.ok(got.note.startsWith('404'), got.note)
  assert.match(got.note, /будто его здесь нет/)
  assert.match(got.note, /защита, а не поломка/)
  for (const слово of ['нет доступа', 'не авторизован', 'unauthorized', 'запрещ'])
    assert.equal(new RegExp(слово, 'i').test(got.note), false, `пояснение выдаёт приём за отказ в доступе: ${слово}`)
})

test('пояснение к 404 не приписывает ему причин, которых у него нет', () => {
  const note = verdict({ outcome: 'upstream', status: 404, bodyText: '' }).note
  assert.match(note, /без годного ключа/, 'достижимый со страницы случай назван')
  assert.match(note, /причины он не называет/, 'единственным этот случай не объявлен')
  assert.equal(
    /ключ не подошёл|неверный ключ|ключ не подходит/i.test(note),
    false,
    `пояснение утверждает причину как установленную: ${note}`,
  )
  // Потолок отказов, гасивший консоль всем, снят в mcp aa8b6b0. Замер:
  // 60 проб «без ключа», затем рабочая команда — было 404, стало 200.
  // Слово об этой причине описывало бы механизм, которого больше нет.
  for (const слово of ['слишком много', 'перебор', 'слишком часто'])
    assert.equal(
      new RegExp(слово, 'i').test(note),
      false,
      `пояснение называет причину, снятую в службе: «${слово}»`,
    )
})

test('про 401 страница больше ничего не утверждает', () => {
  // Отдельного пояснения у 401 нет: эндпоинт его не возвращает, и строка про
  // «проверяет ключ до чтения тела» описывала бы несуществующий механизм.
  // Прийти 401 может только откуда-то ещё — и тогда говорится лишь то, что видно.
  const got = verdict({ outcome: 'upstream', status: 401, bodyText: '{"error":"x"}' })
  assert.equal(got.kind, 'proto')
  assert.equal(got.note, '401 — сервер ответил отказом. Причина в теле ответа.')
  assert.equal(/ключ/i.test(got.note), false, 'про ключ на 401 больше не утверждается ничего')
})

test('пустое тело — не ошибка и не пустота без объяснения', () => {
  // Третий случай рядом с «ответ получен» и «ответа нет вовсе»: ответ есть,
  // байтов нет. Красным он не красится, и размер называет правду.
  assert.equal(verdict({ outcome: 'upstream', status: 404, bodyText: '' }).kind, 'proto')
  assert.equal(formatBytes(0), '0 Б', 'ноль байт называется нулём, а не прочерком')
  assert.equal(
    statusLine({ outcome: 'upstream', status: 404, ms: 4, bytes: 0 }),
    'Ответ 404 · 4 мс · 0 Б',
  )
  assert.equal(typeof EMPTY_BODY, 'string')
  assert.ok(EMPTY_BODY.length > 0)
  assert.match(EMPTY_BODY, /ни одного байта/)
  // Рамка говорит об отсутствии тела, а не пересказывает несуществующее.
  assert.equal(/ошибка|сбой|не удалось/i.test(EMPTY_BODY), false)
})

test('единственный красный исход — ответа нет вовсе, и причина названа', () => {
  const timeout = verdict({ outcome: 'unreachable', reason: 'timeout' })
  assert.equal(timeout.kind, 'fail')
  assert.equal(timeout.note, 'Ответ не получен: истекли 20 с.')
  assert.equal(verdict({ outcome: 'unreachable', reason: 'network' }).note, 'Ответ не получен: соединение оборвано.')
  // Ни одного «что-то пошло не так» без кода и причины.
  for (const outcome of ['unreachable', 'limited', 'upstream', 'rejected'])
    assert.equal(
      /что-то пошло не так|попробуйте позже/i.test(
        verdict({ outcome, status: 500, reason: 'network', retryAfterSec: 3, bodyText: '' }).note,
      ),
      false,
    )
})

test('предел запросов страницы называет секунды до повтора', () => {
  const got = verdict({ outcome: 'limited', status: 429, retryAfterSec: 12, bodyText: '{"retryAfterSec":12}' })
  assert.equal(got.kind, 'proto', 'предел страницы — результат, а не сбой')
  assert.equal(got.note, '429 — сработал предел запросов страницы. Повторите через 12 с.')
  assert.equal(
    statusLine({ outcome: 'limited', retryAfterSec: 12 }),
    'Ответ 429 · предел запросов страницы; повторите через 12 с',
  )
})

test('отступы меняют только переносы и пробелы: объект после разбора тот же', () => {
  const raw = '{"b":2,"a":[1,{"c":"я"}],"n":null}'
  const pretty = reindent(raw)
  assert.equal(pretty.ok, true)
  assert.notEqual(pretty.text, raw, 'вид изменился')
  assert.deepEqual(JSON.parse(pretty.text), JSON.parse(raw), 'предмет не изменился')
  assert.equal(Object.keys(JSON.parse(pretty.text)).join(), 'b,a,n', 'порядок полей не переставлен')
})

test('тело не JSON остаётся как есть, и об этом сказано строкой, а не молчанием', () => {
  const raw = '<html>502 Bad Gateway</html>'
  const got = reindent(raw)
  assert.equal(got.ok, false)
  assert.equal(got.text, raw)
  assert.match(partialNotes.notJson, /не действует/)
})

test('обрезка тела считается по байтам, а не по знакам', () => {
  // Кириллица — два байта на знак. Обрезка по знакам показала бы 128 КБ.
  const big = `"${'я'.repeat(50_000)}"`
  const got = clipBody(big)
  assert.equal(got.truncated, true)
  assert.ok(new TextEncoder().encode(got.text).length <= BODY_LIMIT)
  assert.ok(new TextEncoder().encode(got.text).length > BODY_LIMIT - 4, 'обрезано не раньше потолка')
  assert.match(partialNotes.clipped(got.total), /Обрезала страница, не сервер/)
  const small = clipBody('{"ok":true}')
  assert.equal(small.truncated, false)
  assert.equal(small.text, '{"ok":true}')
})

test('числа записи — в фиксированном порядке и в форматах дня', () => {
  assert.equal(formatBytes(372), '372 Б')
  assert.equal(formatBytes(1023), '1023 Б')
  assert.equal(formatBytes(2964), '2,9 КБ')
  assert.equal(formatMs(900), '0,9 с')
  assert.equal(formatMs(100), '0,1 с')
  // «0,0 с» читалось бы как «не измерено»: локальный вызов отвечает за 10 мс.
  assert.equal(formatMs(10), '10 мс')
  assert.equal(formatMs(99), '99 мс')
  assert.equal(
    metaLine({ time: '14:07:31', status: 200, ms: 900, bytes: 372 }),
    '14:07:31 · HTTP 200 · 0,9 с · 372 Б',
  )
  assert.equal(
    metaLine({ time: '14:07:31', status: null, ms: 20000 }),
    '14:07:31 · ответа нет · 20,0 с',
    'кода нет — на его месте слово, а не выдуманный код',
  )
  assert.equal(statusLine({ outcome: 'upstream', status: 200, ms: 900, bytes: 372 }), 'Ответ 200 · 0,9 с · 372 Б')
  assert.equal(statusLine({ outcome: 'upstream', status: 401, ms: 100, bytes: 96 }), 'Ответ 401 · 0,1 с · 96 Б')
  assert.equal(statusLine({ outcome: 'unreachable', reason: 'timeout' }), 'Ответ не получен: истекли 20 с')
})
