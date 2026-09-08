import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capPerSource, score, selectForQuery, terms, withinTextBudget } from '../select.js'

const NOW = Date.parse('2026-09-09T12:00:00Z')

function item(over = {}) {
  return {
    url: 'https://example.com/a',
    title: 'Заголовок',
    source: 'TechCrunch',
    region: 'США',
    date: '2026-09-09T10:00:00.000Z',
    text: 'текст статьи',
    ...over,
  }
}

test('термины запроса: короткие слова и стоп-слова отбрасываются', () => {
  assert.deepEqual(terms('Какие новости про финтех в Индии?'), ['финтех', 'индии'])
  assert.deepEqual(terms(''), [])
})

test('заголовок весит больше тела, вклад тела ограничен', () => {
  const inTitle = score(item({ title: 'Финтех растёт' }), ['финтех'], { now: NOW })
  const inBody = score(item({ text: 'финтех' }), ['финтех'], { now: NOW })
  assert.ok(inTitle > inBody)

  const many = score(item({ text: 'финтех '.repeat(50) }), ['финтех'], { now: NOW })
  const few = score(item({ text: 'финтех '.repeat(5) }), ['финтех'], { now: NOW })
  assert.equal(many, few, 'длина статьи сама по себе не побеждает')
})

test('регион и издание тоже участвуют: русский запрос находит английские статьи', () => {
  const indian = item({ source: 'Inc42', region: 'Индия', title: 'Fintech funding' })
  const american = item({ source: 'TechCrunch', region: 'США', title: 'Fintech funding' })
  assert.ok(score(indian, terms('что в Индии'), { now: NOW }) > 0)
  assert.equal(score(american, terms('что в Индии'), { now: NOW }), 0)
})

test('свежесть — добавка, а не отдельная ось: точная старая обгоняет свежую мимо темы', () => {
  const oldOnTopic = item({ title: 'Финтех и банки', date: '2026-07-01T10:00:00.000Z' })
  const freshOffTopic = item({ title: 'Роботы на складе', date: '2026-09-09T09:00:00.000Z' })
  const q = terms('финтех')
  assert.ok(score(oldOnTopic, q, { now: NOW }) > score(freshOffTopic, q, { now: NOW }))
})

test('потолок на источник соблюдается, порядок входа сохраняется', () => {
  const items = [
    item({ url: 'a', source: 'A' }),
    item({ url: 'b', source: 'A' }),
    item({ url: 'c', source: 'B' }),
  ]
  assert.deepEqual(
    capPerSource(items, 1).map((i) => i.url),
    ['a', 'c'],
  )
})

test('бюджет символов: что не поместилось — помечается, а не выдаётся за статью без текста', () => {
  const items = [item({ url: 'a', text: 'x'.repeat(80) }), item({ url: 'b', text: 'y'.repeat(80) })]
  const out = withinTextBudget(items, 100)
  assert.equal(out[0].text.length, 80)
  assert.equal(out[1].text, undefined)
  assert.equal(out[1].textOmitted, true)
})

test('отбор: сначала по запросу, потом добор свежими до нужного числа', () => {
  const all = [
    item({
      url: 'topic',
      title: 'Финтех и платежи',
      date: '2026-08-01T10:00:00.000Z',
      source: 'A',
    }),
    item({ url: 'fresh1', title: 'Роботы', date: '2026-09-09T11:00:00.000Z', source: 'B' }),
    item({ url: 'fresh2', title: 'Космос', date: '2026-09-09T10:00:00.000Z', source: 'C' }),
  ]
  const out = selectForQuery(all, {
    sphere: 'финтех',
    prompt: '',
    perSource: 5,
    limit: 3,
    maxChars: 10_000,
    now: NOW,
  })
  assert.equal(out.matched, 1, 'по запросу нашлась одна')
  assert.equal(out.items.length, 3, 'остальные добраны свежими')
  assert.ok(out.items.some((i) => i.url === 'topic'))
})

test('запрос без совпадений вырождается в самые свежие, а не в пустоту', () => {
  const all = [
    item({ url: 'a', title: 'Robotics funding', date: '2026-09-09T11:00:00.000Z', source: 'A' }),
    item({ url: 'b', title: 'Space startups', date: '2026-09-08T11:00:00.000Z', source: 'B' }),
  ]
  const out = selectForQuery(all, {
    sphere: 'квантовая криптография',
    prompt: '',
    perSource: 5,
    limit: 2,
    maxChars: 10_000,
    now: NOW,
  })
  assert.equal(out.matched, 0)
  assert.deepEqual(
    out.items.map((i) => i.url),
    ['a', 'b'],
  )
})

test('потолок на источник сквозной: добор свежими его не обходит', () => {
  // Одно издание даёт и релевантные, и свежие статьи. Потолок обещан
  // пользователю в панели параметров, значит должен считаться по всему
  // отбору, а не заново на каждом проходе.
  const all = []
  for (let n = 0; n < 6; n++)
    all.push(
      item({
        url: `t${n}`,
        title: 'Финтех растёт',
        source: 'A',
        date: `2026-08-0${n + 1}T10:00:00.000Z`,
      }),
    )
  for (let n = 0; n < 6; n++)
    all.push(
      item({ url: `f${n}`, title: 'Прочее', source: 'A', date: `2026-09-0${n + 1}T10:00:00.000Z` }),
    )

  const out = selectForQuery(all, {
    sphere: 'финтех',
    prompt: '',
    perSource: 3,
    limit: 8,
    maxChars: 100_000,
    now: NOW,
  })
  assert.equal(out.items.length, 3, 'больше потолка с единственного издания не берём')
})

test('основа слова совпадает только с начала слова', () => {
  // Внутри слова совпадений быть не должно: «акци» из «акции» не найдено
  // в «реакции». Однокоренные слова («банки» и «банкротство») основа по-
  // прежнему связывает — это цена префиксного сравнения, названная в ADR.
  const inside = item({ title: 'Реакции рынка на отчёт' })
  const start = item({ title: 'Акции выросли' })
  const q = terms('акции')
  assert.equal(score(inside, q, { now: NOW }), 0, 'внутри слова не считается')
  assert.ok(score(start, q, { now: NOW }) > 0)
})

test('отбор детерминирован: одинаковый вход — одинаковый результат', () => {
  const all = Array.from({ length: 20 }, (_, n) =>
    item({ url: `u${n}`, title: `Финтех ${n % 3}`, source: `S${n % 4}` }),
  )
  const run = () =>
    selectForQuery(all, {
      sphere: 'финтех',
      prompt: 'раунды',
      perSource: 2,
      limit: 5,
      maxChars: 10_000,
      now: NOW,
    }).items.map((i) => i.url)
  assert.deepEqual(run(), run())
})
