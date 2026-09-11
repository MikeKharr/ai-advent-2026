import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firedTraces } from '../lib/fired.js'

// Правило «правило → где сработало» уточнено после ревью этапа 1:
// agent_docs/design/2026-09-10-0550-project-atlas.md, раздел
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
  // «без» сужено до соседства с признаком: иначе терялся бы обычный оборот.
  assert.deepEqual(roles('compliance снял вето без условий.'), ['compliance'])
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

test('выдержка — фраза целиком, собранная через переносы внутри абзаца', () => {
  // Документы переносятся по ~80 символам, поэтому фраза почти всегда лежит
  // на двух-трёх строках; резать её по границе строки исходника нельзя.
  const text = 'Первое предложение.\nCompliance вынес вето по расчёту\nцены, и раздел переписан. Третье.\n'
  const [trace] = firedTraces(text, ROLES)
  assert.equal(trace.excerpt, 'Compliance вынес вето по расчёту цены, и раздел переписан.')
  assert.equal(trace.line, 2, 'номер — строка, где начинается совпавшая единица')
})

test('единица привязки осталась строкой: фраза не склеивает роль с чужим признаком', () => {
  // Роль на одной строке, признак на другой — следа нет, как и до правки:
  // расширение до предложения касается выдержки, а не поиска.
  const text = 'Ревью вёл reviewer,\nа вето по расчёту цены осталось за другими.\n'
  assert.deepEqual(roles(text), [])
})

test('marks: смещения совпавшей единицы, роли и признака внутри выдержки', () => {
  const [prose] = firedTraces('Ревью шло долго. Compliance вынес вето по расчёту цены.\n', ROLES)
  assert.equal(prose.excerpt.slice(...prose.marks.unit), 'Compliance вынес вето по расчёту цены.')
  assert.equal(prose.excerpt.slice(...prose.marks.role), 'Compliance')
  assert.equal(prose.excerpt.slice(...prose.marks.sign), 'вето')

  const [row] = firedTraces('| compliance | **Вето:** причина | итог |\n', ROLES)
  // У строки таблицы единица — вся выдержка.
  assert.deepEqual(row.marks.unit, [0, row.excerpt.length])
  assert.equal(row.excerpt.slice(...row.marks.role), 'compliance')
  assert.equal(row.excerpt.slice(...row.marks.sign), 'Вето')

  // Роль и признак лежат внутри единицы, а единица — внутри выдержки.
  for (const trace of [prose, row]) {
    const { unit, role, sign } = trace.marks
    assert.ok(unit[0] >= 0 && unit[1] <= trace.excerpt.length)
    for (const inner of [role, sign]) assert.ok(inner[0] >= unit[0] && inner[1] <= unit[1], JSON.stringify(inner))
  }
})

test('marks считаются по выдержке до обработки разметки', () => {
  // Маркер пункта снят и из выдержки, и из смещений; `**` осталось на месте.
  const [trace] = firedTraces('- **Ревью**: compliance ставил вето.\n', ROLES)
  assert.equal(trace.excerpt, '**Ревью**: compliance ставил вето.')
  assert.equal(trace.excerpt.slice(...trace.marks.role), 'compliance')
  assert.equal(trace.excerpt.slice(...trace.marks.sign), 'вето')
})

test('выдержка следа не режется по длине', () => {
  const long = `Compliance вынес вето, ${'и повод расписан подробно, '.repeat(20)}на этом всё.`
  const [trace] = firedTraces(`${long}\n`, ROLES)
  assert.equal(trace.excerpt, long)
  assert.ok(trace.excerpt.length > 400)
  assert.equal(trace.excerpt.endsWith('…'), false, 'предел длины у следа снят')
})

test('выдержка — строка целиком, без обрезки', () => {
  const line = `| compliance | **Вето:** ${'а'.repeat(300)} |`
  const [trace] = firedTraces(line, ROLES)
  assert.equal(trace.excerpt, line)
  assert.match(trace.excerpt, /^\| compliance \| \*\*Вето:\*\*/)
})
