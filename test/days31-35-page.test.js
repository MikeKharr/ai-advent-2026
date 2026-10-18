// Страница недели 31–35 статическая целиком: скрипта и файла данных у неё нет,
// а всё, чем она доказывает «это сделано», — ссылки на файлы репозитория и на
// журналы прогонов (раскладка
// agent_docs/design/2026-10-18-2336-days31-35-week-page.md, пп. 1, 6, 9).
//
// Ради чего: site/ не единица CI, разметку этой страницы не проверяет ничто.
// Переименуют или уберут файл, на который она ссылается, — утверждение
// «это сделано» станет непроверяемым, и узнает об этом посетитель, а не CI.
// Пять карточек лендинга ведут на пять якорей одной страницы (ADR
// 2026-10-18-1147, п. 4), и переименование id ломает их молча.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const page = await readFile(new URL('site/days31-35/index.html', root), 'utf8')
const days = [31, 32, 33, 34, 35]

test('у страницы недели нет ни скрипта, ни файла данных, ни noscript', () => {
  assert.equal(existsSync(new URL('site/days31-35/app.js', root)), false)
  assert.equal(existsSync(new URL('site/days31-35/results.json', root)), false)
  assert.doesNotMatch(page, /<script/i)
  assert.doesNotMatch(page, /<noscript/i)
})

test('каждая ссылка на файл репозитория ведёт на существующий файл', () => {
  const paths = [...page.matchAll(/blob\/main\/([^"#]+)/g)].map((m) => m[1])
  assert.ok(paths.length >= 10, `ссылок на файлы репозитория найдено ${paths.length}`)
  const missing = paths.filter((p) => !existsSync(new URL(p, root)))
  assert.deepEqual(missing, [], 'ссылки ведут в никуда: ' + missing.join(', '))
})

test('пять секций с якорями day31…day35 на месте', () => {
  for (const day of days) {
    assert.match(
      page,
      new RegExp(`<section id="day${day}" class="day" tabindex="-1" aria-labelledby="day${day}-h">`),
      `секции day${day} нет`,
    )
    assert.match(page, new RegExp(`<h2 id="day${day}-h">`), `заголовка секции day${day} нет`)
  }
})

// Полоса недели здесь оглавление, а не пометка текущего дня: пометить одну из
// пяти секций «текущей страницей» значило бы соврать (раскладка, п. 3).
test('полоса недели ведёт на пять якорей и ни одну секцию не зовёт текущей', () => {
  for (const day of days) {
    assert.match(page, new RegExp(`<a class="wk-link" href="#day${day}">${day}</a>`))
  }
  assert.doesNotMatch(page, /aria-current/)
  assert.doesNotMatch(page, /wk-now/)
})

// Приватный репозиторий вилл назван именем, но ссылки на него нет: у
// постороннего посетителя она даёт 404 — ссылка в никуда (раскладка, п. 7).
test('ссылок на приватный репозиторий на странице нет', () => {
  assert.doesNotMatch(page, /href="[^"]*samui-villas/)
})

test('пять карточек лендинга ведут на /days31-35/#dayN, по одной на день', async () => {
  const landing = await readFile(new URL('site/index.html', root), 'utf8')
  for (const day of days) {
    const hits = [...landing.matchAll(new RegExp(`href="/days31-35/#day${day}"`, 'g'))]
    assert.equal(hits.length, 1, `карточек на день ${day} найдено ${hits.length}`)
  }
})
