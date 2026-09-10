import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firedTraces } from '../lib/fired.js'

// Правило «правило → где сработало» уточнено после ревью этапа 1:
// agent_docs/design/2026-09-13-2000-project-atlas.md, раздел
// «Правило → где сработало».

const ROLES = new Set(['compliance', 'reviewer', 'design', 'design-review', 'backend'])
const roles = (text) => firedTraces(text, ROLES).map((t) => t.role)

test('регистр не учитывается', () => {
  assert.deepEqual(roles('Compliance вынес вето.'), ['compliance'])
  assert.deepEqual(roles('Reviewer дал ПРАВКИ.'), ['reviewer'])
})

test('признак ищется по границам слова: «ответов» и «приветом» — не вето', () => {
  assert.deepEqual(roles('compliance перечитал десяток ответов.'), [])
  assert.deepEqual(roles('backend попрощался с приветом.'), [])
})

test('строка таблицы — одна единица целиком', () => {
  const line = '| compliance | **Вето:** расчёт цены сравнивал с непривязывающим пределом | Раздел переписан |'
  assert.deepEqual(roles(line), ['compliance'])
})

test('прозаическая строка делится на фрагменты: чужое вето роли не приписывается', () => {
  assert.deepEqual(roles('Compliance — вето нет; reviewer дал ПРАВКИ.'), ['reviewer'])
  assert.deepEqual(roles('Вето снято. reviewer подтвердил.'), [])
})

test('отрицание отбрасывает срабатывание', () => {
  assert.deepEqual(roles('Ревью compliance: вето нет.'), [])
  assert.deepEqual(roles('У reviewer блокирующих нет.'), [])
  assert.deepEqual(roles('Пройдено без вето compliance.'), [])
  assert.deepEqual(roles('У compliance нет находок.'), [])
  assert.deepEqual(roles('compliance вето не ставил.'), [])
  assert.deepEqual(roles('compliance вето не наложил.'), [])
  assert.deepEqual(roles('reviewer правки не дал.'), [])
})

test('несколько срабатываний в записи дают несколько рёбер', () => {
  const text = '| compliance | **Вето:** первое |\n| compliance | **Вето:** второе |\n'
  const found = firedTraces(text, ROLES)
  assert.equal(found.length, 2)
  assert.deepEqual(
    found.map((t) => t.line),
    [1, 2],
  )
})

test('одна строка даёт роли не больше одного ребра', () => {
  const found = firedTraces('compliance вынес вето; compliance повторил вето.', ROLES)
  assert.equal(found.length, 1)
})

test('имя роли не берётся из пути и не режется из design-review', () => {
  assert.deepEqual(roles('Правки по `agent_docs/design/corpus.md` внесены.'), [])
  assert.deepEqual(roles('design-review дал ПРАВКИ.'), ['design-review'])
})

test('выдержка — строка целиком, обрезанная до 160 символов', () => {
  const line = `| compliance | **Вето:** ${'а'.repeat(300)} |`
  const [trace] = firedTraces(line, ROLES)
  assert.ok(trace.excerpt.length <= 161, String(trace.excerpt.length))
  assert.match(trace.excerpt, /^\| compliance \| \*\*Вето:\*\*/)
})
