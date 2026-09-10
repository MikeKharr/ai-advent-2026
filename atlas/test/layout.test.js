import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LAYOUT_SEED, MAX_STRETCH, components, layout } from '../lib/layout.js'
import { density } from './helpers.js'

// Контракт 1 этапа 3: координаты приходят из сборки, а не считаются в
// браузере посетителя (раскладка 2026-09-13-2100).

/** Небольшой граф-цепочка с парой перемычек. */
function sample(n = 40) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}` }))
  const edges = []
  for (let i = 1; i < n; i += 1) edges.push({ from: `n${i - 1}`, to: `n${i}` })
  for (let i = 0; i + 7 < n; i += 7) edges.push({ from: `n${i}`, to: `n${i + 7}` })
  return { nodes, edges }
}

test('координаты лежат в единичном квадрате с шестью знаками после точки', () => {
  const { nodes, edges } = sample()
  for (const { x, y } of layout(nodes, edges).values()) {
    for (const v of [x, y]) {
      assert.equal(typeof v, 'number')
      assert.ok(Number.isFinite(v), String(v))
      assert.ok(v >= 0 && v <= 1, String(v))
      assert.ok((String(v).split('.')[1] ?? '').length <= 6, String(v))
    }
  }
})

test('раскладка детерминирована: два вызова дают те же числа', () => {
  const { nodes, edges } = sample()
  const first = layout(nodes, edges)
  const second = layout(nodes, edges)
  for (const [id, point] of first) assert.deepEqual(second.get(id), point, id)
})

test('семя задаёт картинку: другое семя — другие координаты', () => {
  const { nodes, edges } = sample()
  const base = layout(nodes, edges)
  const other = layout(nodes, edges, { seed: LAYOUT_SEED + 1 })
  const same = [...base].filter(([id, p]) => other.get(id).x === p.x && other.get(id).y === p.y).length
  assert.ok(same < nodes.length / 2, `совпало ${same} позиций — семя ни на что не влияет`)
})

test('граф заполняет квадрат, а не собирается в клубок', () => {
  // Габаритная рамка мерит рамку, а не заполненность: она была здоровой ровно
  // тогда, когда 150 узлов сидели в 2.7 % площади, а рамку натягивала пара из
  // двух узлов в противоположном углу (находка Б6 ревью этапа 3). Поэтому
  // меряются занятые ячейки сетки и расстояние между соседями.
  const { nodes, edges } = sample(60)
  const loose = Array.from({ length: 20 }, (_, i) => ({ id: `сам-по-себе-${i}` }))
  const all = [...nodes, ...loose, { id: 'пара-1' }, { id: 'пара-2' }]
  const withPair = [...edges, { from: 'пара-1', to: 'пара-2' }]

  const { filled, median } = density([...layout(all, withPair).values()])
  assert.ok(filled >= 0.5, `в своей ячейке сетки ${(filled * 100).toFixed(1)} % узлов`)
  assert.ok(median >= 0.02, `медиана расстояния до соседа ${median.toFixed(4)}`)
  assert.equal(new Set([...layout(all, withPair).values()].map((p) => `${p.x},${p.y}`)).size, all.length)
})

test('маленькая компонента не задаёт габарит за всех', () => {
  // Отталкивание уносило пару из двух узлов в угол, потому что притягивать её
  // к остальным нечем, и нормировка считала по ней.
  const { nodes, edges } = sample(60)
  const alone = [...layout(nodes, edges).values()]
  const withPair = [
    ...layout([...nodes, { id: 'пара-1' }, { id: 'пара-2' }], [...edges, { from: 'пара-1', to: 'пара-2' }]).values(),
  ]
  const spread = (pts, axis) => Math.max(...pts.map((p) => p[axis])) - Math.min(...pts.map((p) => p[axis]))
  for (const axis of ['x', 'y']) {
    assert.ok(spread(withPair, axis) > spread(alone, axis) * 0.6, `ось ${axis} схлопнулась из-за пары`)
  }
})

test('компоненты связности находятся и идут от большой к малой', () => {
  const { nodes, edges } = sample(10)
  const parts = components([...nodes, { id: 'один' }, { id: 'два' }, { id: 'три' }], [...edges, { from: 'два', to: 'три' }])
  assert.deepEqual(
    parts.map((p) => p.length),
    [10, 2, 1],
  )
})

test('искажение расстояний ограничено порогом', () => {
  // Пооcевая нормировка — осознанный размен: страница масштабирует обе оси
  // одним коэффициентом (`fit` берёт Math.min по осям), поэтому растяжение
  // доезжает до экрана и должно быть ограничено, а не оставлено на самотёк.
  assert.equal(MAX_STRETCH, 1.3, 'порог искажения зафиксирован в коде')

  // Цепь из тридцати узлов ложится вытянутой — выше порога, поэтому
  // нормировка изотропная и коробка заполняется не целиком.
  const chain = Array.from({ length: 30 }, (_, i) => ({ id: `ц${i}` }))
  const line = chain.slice(1).map((n, i) => ({ from: chain[i].id, to: n.id }))
  const placed = [...layout(chain, line).values()]
  const spanX = Math.max(...placed.map((p) => p.x)) - Math.min(...placed.map((p) => p.x))
  const spanY = Math.max(...placed.map((p) => p.y)) - Math.min(...placed.map((p) => p.y))
  assert.ok(Math.max(spanX, spanY) / Math.min(spanX, spanY) > 1.05, `цепь легла квадратом: ${spanX} × ${spanY}`)
})

test('вырожденные случаи не роняют сборку', () => {
  assert.equal(layout([], []).size, 0)
  assert.deepEqual(layout([{ id: 'a' }], []).get('a'), { x: 0.5, y: 0.5 })
  // Узлы без единого ребра — обычное дело: два десятка таких есть на main.
  const loose = layout(
    [{ id: 'a' }, { id: 'b' }],
    [{ from: 'a', to: 'нет-такого' }],
  )
  assert.equal(loose.size, 2)
})
