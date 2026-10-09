// Страница дня 27 статическая целиком: скрипта и файла данных у неё нет, а
// всё, чем она доказывает «это уже сделано», — ссылки на файлы репозитория
// (раскладка agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md,
// «Тело дня», день 27, п. 6).
//
// Ради чего: site/ не единица CI, разметку этой страницы не проверяет ничто.
// Переименуют или уберут файл, на который она ссылается, — утверждение
// «закрыто раньше» станет непроверяемым, и узнает об этом посетитель, а не CI.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const page = await readFile(new URL('site/day27/index.html', root), 'utf8')

test('у страницы дня 27 нет ни скрипта, ни файла данных, ни noscript', () => {
  assert.equal(existsSync(new URL('site/day27/app.js', root)), false)
  assert.equal(existsSync(new URL('site/day27/results.json', root)), false)
  assert.doesNotMatch(page, /<script/i)
  assert.doesNotMatch(page, /<noscript/i)
})

test('каждая ссылка на файл репозитория ведёт на существующий файл', () => {
  const paths = [...page.matchAll(/blob\/main\/([^"#]+)/g)].map((m) => m[1])
  assert.ok(paths.length >= 10, `ссылок на файлы репозитория найдено ${paths.length}`)
  const missing = paths.filter((p) => !existsSync(new URL(p, root)))
  assert.deepEqual(missing, [], 'ссылки ведут в никуда: ' + missing.join(', '))
})

// Прокручиваемый блок Chrome делает остановкой табуляции сам, по факту
// переполнения, и aria-hidden его из порядка обхода не убирает: клавиатура
// останавливалась на схеме с браузерным кольцом (находка design-review к #337,
// 28 остановок против 27). Снять остановку скриптом эта страница не может —
// скрипта у неё нет, поэтому tabindex стоит в разметке и держится тестом.
test('моноширинная схема пути не остановка табуляции', () => {
  const chain = page.match(/<p class="chain"[^>]*>/)
  assert.ok(chain, 'блока .chain в разметке нет')
  assert.match(chain[0], /aria-hidden="true"/)
  assert.match(chain[0], /tabindex="-1"/)
})

test('полоса недели несёт все пять позиций, а 27-я — не ссылка', () => {
  for (const day of [26, 28, 29, 30]) {
    assert.match(page, new RegExp(`<a class="wk-link" href="/day${day}/">${day}</a>`))
  }
  assert.match(page, /<span class="wk-link wk-now" aria-current="page">27<\/span>/)
  assert.doesNotMatch(page, /href="\/day27\/"/)
})

test('ссылка на день 11 стоит в разметке, а не в раскрывающемся блоке', () => {
  const link = page.indexOf('href="/day11/"')
  assert.notEqual(link, -1, 'ссылки на день 11 нет')
  const open = page.lastIndexOf('<details', link)
  const close = page.lastIndexOf('</details>', link)
  assert.ok(open < close, 'ссылка на день 11 спрятана под details')
})

test('день 27 есть в списке приложений на лендинге', async () => {
  const landing = await readFile(new URL('site/index.html', root), 'utf8')
  assert.match(landing, /<a class="app" href="\/day27\/"/)
})
