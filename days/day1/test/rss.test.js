import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { decodeEntities, dedupe, parseFeed, stripHtml } from '../rss.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('разбирает настоящую ленту Sifted', () => {
  const items = parseFeed(fixture('sifted.xml'), 'Sifted')
  assert.ok(items.length >= 20, `ожидалось ≥20 записей, получено ${items.length}`)
  for (const item of items) {
    assert.ok(item.title.length > 0)
    assert.match(item.url, /^https?:\/\//)
    assert.ok(!Number.isNaN(Date.parse(item.date)))
    assert.equal(item.source, 'Sifted')
  }
})

test('разбирает настоящую ленту TechCrunch', () => {
  const items = parseFeed(fixture('techcrunch.xml'), 'TechCrunch')
  assert.ok(items.length >= 15)
  assert.ok(items.every((i) => i.url.startsWith('https://')))
})

test('разворачивает CDATA и сущности в заголовке', () => {
  const xml = `<rss><channel><item>
    <title><![CDATA[Stripe &amp; Adyen: 100&nbsp;млн]]></title>
    <link>https://example.com/a</link>
    <pubDate>Mon, 07 Sep 2026 10:00:00 +0000</pubDate>
    <description><![CDATA[<p>Текст с <b>разметкой</b> &#8212; и тире</p>]]></description>
  </item></channel></rss>`
  const [item] = parseFeed(xml, 'X')
  assert.equal(item.title, 'Stripe & Adyen: 100 млн')
  assert.equal(item.summary, 'Текст с разметкой — и тире')
})

test('понимает Atom: ссылка в href, дата в published', () => {
  const xml = `<feed><entry>
    <title>Atom заголовок</title>
    <link rel="alternate" href="https://example.com/atom"/>
    <published>2026-09-06T08:00:00Z</published>
    <summary>Кратко</summary>
  </entry></feed>`
  const [item] = parseFeed(xml, 'A')
  assert.equal(item.url, 'https://example.com/atom')
  assert.equal(item.date, '2026-09-06T08:00:00.000Z')
})

test('отбрасывает записи без ссылки или без разбираемой даты', () => {
  const xml = `<rss><channel>
    <item><title>Без ссылки</title><pubDate>Mon, 07 Sep 2026 10:00:00 +0000</pubDate></item>
    <item><title>Без даты</title><link>https://example.com/b</link></item>
    <item><title>Битая дата</title><link>https://example.com/c</link><pubDate>не дата</pubDate></item>
    <item><title>Годная</title><link>https://example.com/d</link><pubDate>Mon, 07 Sep 2026 10:00:00 +0000</pubDate></item>
  </channel></rss>`
  const items = parseFeed(xml, 'X')
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Годная')
})

test('дедупликация снимает повтор по URL и по заголовку', () => {
  const items = [
    {
      title: 'Revolut получил лицензию',
      url: 'https://a.com/x?utm_source=rss',
      date: '2026-09-07',
      source: 'A',
    },
    { title: 'Revolut получил лицензию', url: 'https://a.com/x', date: '2026-09-07', source: 'A' },
    { title: 'Revolut получил лицензию!', url: 'https://b.com/y', date: '2026-09-07', source: 'B' },
    { title: 'Другая новость', url: 'https://c.com/z', date: '2026-09-07', source: 'C' },
  ]
  const out = dedupe(items)
  assert.equal(out.length, 2)
  assert.equal(out[1].title, 'Другая новость')
})

test('числовые и именованные сущности', () => {
  assert.equal(decodeEntities('a &amp; b &#233; &#x41;'), 'a & b é A')
  assert.equal(stripHtml('<p>раз</p>  <span>два</span>'), 'раз два')
})
