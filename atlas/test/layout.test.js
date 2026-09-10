import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LAYOUT_SEED, layout } from '../lib/layout.js'

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

test('граф не схлопывается в точку и не кладёт узлы друг на друга', () => {
  const { nodes, edges } = sample()
  const placed = [...layout(nodes, edges).values()]
  const xs = placed.map((p) => p.x)
  const ys = placed.map((p) => p.y)
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.5, 'разброс по x меньше половины квадрата')
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.5, 'разброс по y меньше половины квадрата')
  assert.equal(new Set(placed.map((p) => `${p.x},${p.y}`)).size, nodes.length, 'узлы совпали позициями')
})

test('масштаб общий для обеих осей: одна ось занимает квадрат целиком', () => {
  const { nodes, edges } = sample()
  const placed = [...layout(nodes, edges).values()]
  const spanX = Math.max(...placed.map((p) => p.x)) - Math.min(...placed.map((p) => p.x))
  const spanY = Math.max(...placed.map((p) => p.y)) - Math.min(...placed.map((p) => p.y))
  assert.ok(Math.abs(Math.max(spanX, spanY) - 1) < 1e-6, `${spanX} × ${spanY}`)
})

test('вырожденные случаи не роняют сборку', () => {
  assert.equal(layout([], []).size, 0)
  assert.deepEqual(layout([{ id: 'a' }], []).get('a'), { x: 0.5, y: 0.5 })
  // Узлы без единого ребра — обычное дело: 24 таких есть на main.
  const loose = layout(
    [{ id: 'a' }, { id: 'b' }],
    [{ from: 'a', to: 'нет-такого' }],
  )
  assert.equal(loose.size, 2)
})
