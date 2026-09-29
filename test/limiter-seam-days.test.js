// Слой 3 держателя «лимитер в диспетчере» (ADR 2026-09-29-1600): конвенция
// между днями. Дни не делят кода — единица сборки, тестов и выкатки это
// каталог дня, и общий модуль не попал бы ни в один образ, — поэтому шов живёт
// в каждом дне копией, а одинаковость копий держит этот тест.
//
// Граница честная и названа в ADR: тест держит КОНВЕНЦИЮ (таблица есть, окно у
// каждой записи названо, свой тест шва на месте), а не правду о том, что слот
// занимается до обработчика, — это проверяет тест шва внутри дня. Ручку,
// вписанную `if`-ом до `dispatch`, не ловит ни один из трёх слоёв: её ловит
// ревьюер чтением диффа.
//
// Дни до 20-го под конвенцию не подпадают: охват выбран владельцем 2026-09-30
// (дни 21 и 20), дни 7–11 и 13–15 остаются с дефектом осознанно.
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** С какого дня шов обязателен. Меняется только вместе с решением владельца. */
const FROM = 20
const LIMITS = ['run', 'write', 'read', 'open']

const days = readdirSync(join(ROOT, 'days'))
  .map((name) => ({ name, n: Number(/^day(\d+)$/.exec(name)?.[1]) }))
  .filter((d) => Number.isInteger(d.n) && d.n >= FROM)
  .sort((a, b) => a.n - b.n)

// Пустой список — не наблюдение конвенции, а её отсутствие: день 20 в
// репозитории есть, и если сюда не попал ни один каталог, сломан сам поиск.
test(`дни с ${FROM}-го найдены`, () => {
  assert.ok(days.length > 0, `в days/ нет ни одного дня с номером ≥ ${FROM}`)
  assert.ok(days.some((d) => d.name === 'day20'), `день 20 не попал в список: ${days.map((d) => d.name)}`)
})

for (const day of days) {
  test(`${day.name}: свой тест шва на месте`, () => {
    const file = join(ROOT, 'days', day.name, 'test/limiter-seam.test.js')
    assert.ok(existsSync(file), `нет ${file} — окно новой ручки держать нечем`)
  })

  test(`${day.name}: диспетчер отдаёт таблицу ручек, и у каждой названо окно`, async () => {
    process.env.NODE_ENV = 'test'
    process.env.AGENT_KEY ||= 'root-seam-check'
    const mod = await import(join(ROOT, 'days', day.name, 'server.js'))
    assert.ok(Array.isArray(mod.routes), `${day.name}/server.js не экспортирует routes`)
    assert.ok(mod.routes.length > 0, `${day.name}: таблица ручек пуста`)
    for (const route of mod.routes) {
      const name = `${route.method} ${route.path}`
      assert.ok(LIMITS.includes(route.limit), `${day.name}, ${name}: окно не названо`)
      if (route.limit === 'open')
        assert.ok(route.why && route.why.trim() !== '', `${day.name}, ${name}: исключение без причины`)
    }
  })
}
