import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStore } from '../src/tools/archive/store.js'

const dir = () => mkdtempSync(join(tmpdir(), 'day5-'))

function item(n, { source = 'TechCrunch', day = 10, text = 'текст' } = {}) {
  return {
    url: `https://example.com/${source}/${n}`,
    title: `Статья ${n}`,
    source,
    region: 'США',
    date: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    text,
  }
}

test('добавляются только новые записи, повтор не удваивает окно', () => {
  const store = createStore({ file: join(dir(), 'store.json'), capacity: 100, sources: 8 })
  assert.deepEqual(store.add([item(1), item(2)]), { added: 2, dropped: 0 })
  assert.deepEqual(store.add([item(2), item(3)]), { added: 1, dropped: 0 })
  assert.equal(store.size(), 3)
})

test('окно не растёт сверх ёмкости, вытесняются самые старые', () => {
  const store = createStore({ file: join(dir(), 'store.json'), capacity: 5, sources: 1 })
  for (let n = 1; n <= 8; n++) store.add([item(n, { day: n })])
  assert.equal(store.size(), 5)
  const dates = store.all().map((i) => i.date.slice(8, 10))
  assert.deepEqual(dates, ['08', '07', '06', '05', '04'], 'остались пять свежих')
})

test('квота держит редкий источник, когда плодовитый переполняет окно', () => {
  // Ёмкость 16 на 8 источников: квота 2 у каждого.
  const store = createStore({ file: join(dir(), 'store.json'), capacity: 16, sources: 8 })
  // Редкое издание пишет давно, плодовитое — сегодня и много.
  store.add([item(1, { source: 'Pandaily', day: 1 }), item(2, { source: 'Pandaily', day: 2 })])
  for (let n = 0; n < 30; n++) store.add([item(n, { source: 'TechCrunch', day: 20 })])

  assert.equal(store.size(), 16)
  const counts = store.bySource()
  assert.equal(counts.Pandaily, 2, 'старые статьи редкого издания уцелели по квоте')
  assert.equal(counts.TechCrunch, 14)
})

test('окно переживает перезапуск, битый файл не роняет приложение', () => {
  const file = join(dir(), 'store.json')
  const first = createStore({ file, capacity: 100, sources: 8 })
  first.add([item(1), item(2)])
  first.markRefreshed()

  const second = createStore({ file, capacity: 100, sources: 8 })
  second.load()
  assert.equal(second.size(), 2)
  assert.ok(second.lastRefresh() > 0, 'отметка обновления тоже сохраняется')

  writeFileSync(file, '{ это не json')
  const broken = createStore({ file, capacity: 100, sources: 8, log: () => {} })
  broken.load()
  assert.equal(broken.size(), 0, 'начинаем с пустого окна, а не падаем')
})

test('издание, убранное из списка лент, исчезает из архива', () => {
  // Футер обещает изданию убрать его ленту по просьбе. Обещание должно
  // распространяться и на уже сохранённые тексты, а не только на приём.
  const store = createStore({
    file: join(dir(), 'store.json'),
    capacity: 100,
    sources: 8,
    knownSources: ['TechCrunch'],
  })
  store.add([item(1, { source: 'TechCrunch' }), item(2, { source: 'Pandaily' })])
  assert.equal(store.size(), 2)
  assert.equal(store.prune(), 1)
  assert.deepEqual(Object.keys(store.bySource()), ['TechCrunch'])
})

test('записи старше срока хранения уходят, даже если место в окне есть', () => {
  const now = Date.parse('2026-09-09T12:00:00Z')
  const store = createStore({
    file: join(dir(), 'store.json'),
    capacity: 100,
    sources: 8,
    maxAgeDays: 30,
    now: () => now,
  })
  store.add([
    { ...item(1), date: '2026-09-01T10:00:00.000Z' },
    { ...item(2), date: '2026-01-01T10:00:00.000Z' },
  ])
  assert.equal(store.size(), 2, 'малотиражное издание под вытеснение по квоте не попадает')
  assert.equal(store.prune(now), 1)
  assert.equal(store.size(), 1)
  assert.equal(store.all()[0].date.slice(0, 7), '2026-09')
})

test('одинаковый заголовок в разные недели — рубрика, а не дубликат', () => {
  const now = Date.parse('2026-09-09T12:00:00Z')
  const store = createStore({
    file: join(dir(), 'store.json'),
    capacity: 100,
    sources: 8,
    now: () => now,
  })
  const roundup = (url, date) => ({ ...item(1), url, title: 'Startup funding roundup', date })
  store.add([roundup('https://e.test/w1', '2026-09-09T10:00:00.000Z')])
  // Тот же заголовок неделей раньше — следующий выпуск рубрики.
  assert.equal(store.add([roundup('https://e.test/w0', '2026-09-01T10:00:00.000Z')]).added, 1)
  // А вот тот же заголовок сегодня под другой ссылкой — перепечатка.
  assert.equal(store.add([roundup('https://mirror.test/x', '2026-09-09T09:00:00.000Z')]).added, 0)
})

test('запись с неразбираемой датой не принимается и не грузится', () => {
  const file = join(dir(), 'store.json')
  const store = createStore({ file, capacity: 100, sources: 8, log: () => {} })
  assert.equal(store.add([{ ...item(1), date: 'позавчера' }]).added, 0)

  writeFileSync(
    file,
    JSON.stringify({ version: 1, lastRefresh: 0, items: [item(2), { ...item(3), date: 'вчера' }] }),
  )
  const loaded = createStore({ file, capacity: 100, sources: 8, log: () => {} })
  loaded.load()
  assert.equal(loaded.size(), 1)
  assert.equal(loaded.skippedOnLoad(), 1)
})

test('пакет изменений пишет файл один раз', () => {
  const file = join(dir(), 'store.json')
  const store = createStore({ file, capacity: 100, sources: 8 })
  store.batch(() => {
    store.add([item(1)])
    store.add([item(2)])
    store.markRefreshed()
  })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.items.length, 2)
  assert.ok(raw.lastRefresh > 0)
})

test('запись атомарна: на диске всегда цельный JSON', () => {
  const file = join(dir(), 'store.json')
  const store = createStore({ file, capacity: 100, sources: 8 })
  store.add([item(1)])
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.items.length, 1)
  assert.equal(raw.items[0].text, 'текст', 'тексты статей хранятся вместе с записью')
})

test('записи без обязательных полей при загрузке пропускаются', () => {
  const file = join(dir(), 'store.json')
  writeFileSync(
    file,
    JSON.stringify({ version: 1, lastRefresh: 0, items: [item(1), { url: 'x' }, null] }),
  )
  const store = createStore({ file, capacity: 100, sources: 8, log: () => {} })
  store.load()
  assert.equal(store.size(), 1)
  assert.equal(store.skippedOnLoad(), 2)
})
