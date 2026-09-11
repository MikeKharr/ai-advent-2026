import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph } from '../lib/extract.js'
import { readSources } from '../lib/sources.js'
import {
  CAM_D,
  PAD,
  POSE0,
  blend,
  clampPitch,
  depthRadius,
  drawOrder,
  envelopePoints,
  envelopePoses,
  fit,
  indexGraph,
  labelRank,
  pickNode,
  placeDepthLabels,
  project,
  projectAll,
  transform,
} from '../web/app.js'
import { ROOT } from './helpers.js'

// Режим «Объём» — agent_docs/design/2026-09-10-1517-atlas-3d-mode.md, раздел
// «Тесты `qa` на чистую часть». Поза — два угла в градусах: рыскание `yaw`
// и тангаж `pitch`.

const graph = buildGraph(readSources(ROOT))
const index = indexGraph(graph)
const byId = new Map(graph.nodes.map((n) => [n.id, n]))
/** Узел и его прямые соседи — часть графа для проверок «центр — куба, не вида». */
const around = (id) => new Set([id, ...index.near.get(id)])
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`)

// ── Проекция ───────────────────────────────────────────────────────────

test('поза при включении — 30° по рысканию и 20° по тангажу, камера на двух сторонах куба', () => {
  assert.deepEqual(POSE0, { yaw: 30, pitch: 20 })
  assert.equal(CAM_D, 2)
})

test('центр куба уходит в начало экрана с множителем 1 при любой позе', () => {
  for (const pose of [{ yaw: 0, pitch: 0 }, POSE0, { yaw: -135, pitch: 90 }]) {
    const p = project({ x: 0.5, y: 0.5, z: 0.5 }, pose)
    close(p.x, 0)
    close(p.y, 0)
    close(p.z, 0)
    close(p.f, 1)
  }
})

test('при нулевой позе точка лежит там же, где в плоскости, со сдвигом к центру куба', () => {
  const p = project({ x: 0.9, y: 0.2, z: 0.5 }, { yaw: 0, pitch: 0 })
  close(p.x, 0.4)
  close(p.y, -0.3)
  close(p.f, 1)
})

test('поворот на 90° по рысканию переводит ось x в глубину', () => {
  const p = project({ x: 1, y: 0.5, z: 0.5 }, { yaw: 90, pitch: 0 })
  close(p.x, 0)
  close(p.z, -0.5)
  close(p.f, CAM_D / (CAM_D - 0.5))
})

test('больший z2 — дальше от камеры и мельче', () => {
  const near = project({ x: 0.5, y: 0.5, z: 0 }, { yaw: 0, pitch: 0 })
  const far = project({ x: 0.5, y: 0.5, z: 1 }, { yaw: 0, pitch: 0 })
  assert.ok(far.z > near.z)
  assert.ok(far.f < near.f)
})

test('при начальной позе ближняя часть графа сдвинута влево и вниз', () => {
  const p = project({ x: 0.5, y: 0.5, z: 0 }, POSE0)
  assert.ok(p.x < 0)
  assert.ok(p.y > 0)
})

test('тангаж ограничен ±90°, рыскание — нет', () => {
  assert.equal(clampPitch(120), 90)
  assert.equal(clampPitch(-91), -90)
  assert.equal(clampPitch(45), 45)
})

test('проекция узла не зависит от того, какие узлы в виде: центр — куба, не вида', () => {
  const all = projectAll(new Map(graph.nodes.map((n) => [n.id, n])), POSE0)
  const ids = around('role/compliance')
  const part = projectAll(new Map([...ids].map((id) => [id, byId.get(id)])), POSE0)
  for (const id of ids) assert.deepEqual(part.get(id), all.get(id))
})

// ── Огибающая ──────────────────────────────────────────────────────────

test('огибающая — 15 поз: рыскание ±0, 30, 60, тангаж ±0, 20', () => {
  const poses = envelopePoses(POSE0)
  assert.equal(poses.length, 15)
  const yaws = [...new Set(poses.map((p) => p.yaw))].sort((a, b) => a - b)
  const pitches = [...new Set(poses.map((p) => p.pitch))].sort((a, b) => a - b)
  assert.deepEqual(yaws, [-30, 0, 30, 60, 90])
  assert.deepEqual(pitches, [0, 20, 40])
})

test('тангаж огибающей ограничен ±90°', () => {
  const pitches = envelopePoses({ yaw: 0, pitch: 80 }).map((p) => p.pitch)
  assert.equal(Math.max(...pitches), 90)
  assert.equal(Math.min(...pitches), 60)
})

test('вид, вписанный по огибающей, остаётся в канве с полем 32 px в каждой из 15 поз', () => {
  const field = { width: 816, height: 571 }
  const views = [
    new Map(graph.nodes.map((n) => [n.id, n])),
    new Map([...around('role/compliance')].map((id) => [id, byId.get(id)])),
    new Map([[graph.nodes[0].id, graph.nodes[0]]]),
  ]
  for (const pts of views) {
    for (const pose of [POSE0, { yaw: 200, pitch: -75 }]) {
      const cam = { ...fit(field, envelopePoints(pts, pose)), scale: 1, panX: 0, panY: 0 }
      const at = transform(field, cam)
      for (const each of envelopePoses(pose)) {
        for (const p of projectAll(pts, each).values()) {
          const s = at(p)
          assert.ok(s.x >= PAD - 1e-6 && s.x <= field.width - PAD + 1e-6, `x ${s.x}`)
          assert.ok(s.y >= PAD - 1e-6 && s.y <= field.height - PAD + 1e-6, `y ${s.y}`)
        }
      }
    }
  }
})

// ── Радиус ─────────────────────────────────────────────────────────────

test('радиус — 5·f в пределах 3…7 px', () => {
  close(depthRadius(1), 5)
  close(depthRadius(1.2), 6)
  assert.equal(depthRadius(2), 7)
  assert.equal(depthRadius(0.4), 3)
})

test('у выбранного — 8 px при любой глубине', () => {
  for (const f of [0.4, 1, 2]) assert.equal(depthRadius(f, true), 8)
})

// ── Порядок отрисовки ──────────────────────────────────────────────────

const dot = (x, y, r, z) => ({ x, y, r, z })

test('узлы рисуются от дальних к ближним, равная глубина — по идентификатору побайтно', () => {
  const screen = new Map([
    ['b', dot(0, 0, 5, 0.1)],
    ['a', dot(0, 0, 5, 0.1)],
    ['near', dot(0, 0, 5, -0.3)],
    ['far', dot(0, 0, 5, 0.4)],
    ['B', dot(0, 0, 5, 0.1)],
  ])
  assert.deepEqual(drawOrder(screen, null, null), ['far', 'B', 'a', 'b', 'near'])
})

test('выбранный и наведённый рисуются последними, наведённый — поверх выбранного', () => {
  const screen = new Map([
    ['sel', dot(0, 0, 8, 0.4)],
    ['hover', dot(0, 0, 5, 0.3)],
    ['near', dot(0, 0, 5, -0.3)],
    ['far', dot(0, 0, 5, 0.5)],
  ])
  assert.deepEqual(drawOrder(screen, 'sel', 'hover'), ['far', 'near', 'sel', 'hover'])
})

test('наведённый выбранный рисуется один раз', () => {
  const screen = new Map([
    ['sel', dot(0, 0, 8, 0.4)],
    ['x', dot(0, 0, 5, 0.3)],
  ])
  assert.deepEqual(drawOrder(screen, 'sel', 'sel'), ['x', 'sel'])
})

// ── Выбор щелчком ──────────────────────────────────────────────────────

test('верхний нарисованный круг под указателем выигрывает у ближнего центра под ним', () => {
  // Дальний узел рисуется первым, ближний — поверх и закрывает его центр.
  const screen = new Map([
    ['far', dot(100, 100, 4, 0.3)],
    ['near', dot(106, 100, 7, -0.2)],
  ])
  const order = drawOrder(screen, null, null)
  assert.equal(pickNode(screen, order, 102, 100), 'near')
})

test('вне кругов — ближайший центр в пределах 10 px', () => {
  const screen = new Map([
    ['a', dot(100, 100, 4, 0)],
    ['b', dot(120, 100, 4, 0)],
  ])
  const order = drawOrder(screen, null, null)
  assert.equal(pickNode(screen, order, 108, 100), 'a')
  assert.equal(pickNode(screen, order, 113, 100), 'b')
  assert.equal(pickNode(screen, order, 100, 111), null)
})

test('вне кругов при разнице расстояний меньше 0.5 px — ближний к камере', () => {
  const screen = new Map([
    ['far', dot(100, 100, 3, 0.4)],
    ['near', dot(116, 100, 3, -0.1)],
  ])
  const order = drawOrder(screen, null, null)
  // До дальнего 7.8 px, до ближнего 8.2 px: разница 0.4 — выигрывает ближний.
  assert.equal(pickNode(screen, order, 107.8, 100), 'near')
  // Разница 2 px — выигрывает ближайший центр, как в плоском виде.
  assert.equal(pickNode(screen, order, 107, 100), 'far')
})

// ── Подписи ────────────────────────────────────────────────────────────

const measure = (text) => text.length * 7
const field = { width: 400, height: 300 }

test('внутри группы важности ближний к камере получает место первым', () => {
  // Два узла в одной точке: одна и та же первая позиция достаётся одному.
  const items = [
    { id: 'a', x: 200, y: 150, text: 'alpha', rank: 4 },
    { id: 'b', x: 200, y: 150, text: 'bravo', rank: 4 },
  ]
  const near = placeDepthLabels(items, field, measure, new Map([['a', 0.3], ['b', -0.2]]))
  const box = near.get('b')
  assert.ok(box && box.y > 150, 'ближний b — под узлом')
  const flipped = placeDepthLabels(items, field, measure, new Map([['a', -0.2], ['b', 0.3]]))
  assert.ok(flipped.get('a').y > 150, 'ближний a — под узлом')
})

test('группа важнее глубины: дальний сосед выбранного опережает ближний прочий узел', () => {
  const items = [
    { id: 'rest', x: 200, y: 150, text: 'alpha', rank: 4 },
    { id: 'nb', x: 200, y: 150, text: 'bravo', rank: 3 },
  ]
  const labels = placeDepthLabels(items, field, measure, new Map([['rest', -0.4], ['nb', 0.4]]))
  assert.ok(labels.get('nb').y > 150, 'сосед — под узлом')
})

// Вид до 40 узлов в покое — синтетический, а не окрестность из живого графа:
// та растёт с каждым документом и однажды переходит порог 40 (PR #80: 41 узел
// у compliance). Тесный куст из 18 узлов гарантирует, что в покое подпись
// есть не у всех; 12 узлов вразброс — что она есть у многих. Ранг и вызов —
// как у страницы (paintDepth): labelRank с always, наведённый — в расстановку.
const crowded = (() => {
  const sel = 'n00'
  const near = new Set(['n01', 'n02', 'n03', 'n04', 'n05', 'n18', 'n19', 'n20'])
  const nodes = Array.from({ length: 30 }, (_, i) => {
    const id = `n${String(i).padStart(2, '0')}`
    const x = i < 18 ? 200 + (i % 6) * 4 : 30 + (i - 18) * 30
    const y = i < 18 ? 140 + Math.floor(i / 6) * 4 : i % 2 ? 40 : 260
    return { id, x, y, text: `node-${id}` }
  })
  const depth = new Map(nodes.map(({ id }, i) => [id, ((i * 7) % 30) / 30 - 0.5]))
  const layout = (hover) =>
    placeDepthLabels(
      nodes.map((n) => ({ ...n, rank: labelRank({ id: n.id, sel, near, hover, always: true }) })),
      field,
      measure,
      depth,
      hover,
    )
  const still = layout(null)
  return { nodes, layout, still }
})()

test('в объёме в покое, в виде до 40 узлов, наведение на узел с подписью не меняет ни одной позиции', () => {
  const { nodes, layout, still } = crowded
  const labelled = nodes.filter(({ id }) => still.has(id))
  assert.ok(labelled.length >= 10 && labelled.length < nodes.length, `с подписью ${labelled.length} из ${nodes.length}`)
  for (const { id } of labelled) assert.deepEqual(layout(id), still, `наведение на ${id}`)
})

test('в объёме в покое, в виде до 40 узлов, наведённый узел без подписи получает имя', () => {
  const { nodes, layout, still } = crowded
  const silent = nodes.filter(({ id }) => !still.has(id))
  assert.ok(silent.length >= 3, `без подписи ${silent.length}`)
  for (const { id } of silent) assert.ok(layout(id).has(id), `наведение на ${id}`)
})

test('наведение на узел без подписи в покое показывает его имя', () => {
  // Единственная позиция на двоих: ближний к камере её занимает, дальний молчит.
  const items = [
    { id: 'near', x: 200, y: 150, text: 'alpha', rank: 4, slots: ['below'] },
    { id: 'far', x: 200, y: 150, text: 'bravo', rank: 4, slots: ['below'] },
  ]
  const depth = new Map([['near', -0.2], ['far', 0.3]])
  const still = placeDepthLabels(items, field, measure, depth, null)
  assert.ok(still.has('near') && !still.has('far'))
  const hovered = placeDepthLabels(items, field, measure, depth, 'far')
  assert.ok(hovered.has('far'), 'наведённый без подписи получает имя')
})

test('наведение на узел с подписью не меняет ни одной позиции', () => {
  const items = [
    { id: 'near', x: 200, y: 150, text: 'alpha', rank: 4, slots: ['below'] },
    { id: 'far', x: 200, y: 150, text: 'bravo', rank: 4, slots: ['below'] },
  ]
  const depth = new Map([['near', -0.2], ['far', 0.3]])
  assert.deepEqual(
    placeDepthLabels(items, field, measure, depth, 'near'),
    placeDepthLabels(items, field, measure, depth, null),
  )
})

test('подписи возвращаются по настоящим идентификаторам', () => {
  const items = [
    { id: 'role/compliance', x: 100, y: 100, text: 'compliance', rank: 0 },
    { id: 'role/qa', x: 300, y: 200, text: 'qa', rank: 4 },
  ]
  const labels = placeDepthLabels(items, field, measure, new Map([['role/compliance', 0], ['role/qa', 0]]))
  assert.deepEqual([...labels.keys()].sort(), ['role/compliance', 'role/qa'])
})

// ── Смесь перехода ─────────────────────────────────────────────────────

test('смесь перехода: при t = 0 — первая картинка, при t = 1 — вторая, точно', () => {
  const a = new Map([['n', { x: 10.1, y: 20.3, r: 5 }]])
  const b = new Map([['n', { x: 333.7, y: 0.9, r: 4.37, z: 0.2 }]])
  const at0 = blend(a, b, 0).get('n')
  const at1 = blend(a, b, 1).get('n')
  assert.deepEqual([at0.x, at0.y, at0.r], [10.1, 20.3, 5])
  assert.deepEqual([at1.x, at1.y, at1.r], [333.7, 0.9, 4.37])
  const mid = blend(a, b, 0.5).get('n')
  close(mid.x, (10.1 + 333.7) / 2)
  close(mid.r, (5 + 4.37) / 2)
})

test('глубина в смеси берётся у объёмной картинки в обе стороны', () => {
  const flat = new Map([['n', { x: 0, y: 0, r: 5 }]])
  const vol = new Map([['n', { x: 1, y: 1, r: 6, z: -0.3 }]])
  assert.equal(blend(flat, vol, 0.5).get('n').z, -0.3)
  assert.equal(blend(vol, flat, 0.5).get('n').z, -0.3)
})
