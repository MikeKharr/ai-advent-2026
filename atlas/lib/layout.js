// Раскладка графа: координаты считаются при сборке, а не в браузере
// посетителя (раскладка `agent_docs/design/2026-09-13-2100-atlas-page-layout.md`,
// контракт 1 этапа 3). Каждый узел получает `x` и `y` в единичном квадрате
// `0…1` с шестью знаками после точки.
//
// Детерминированность здесь — не удобство, а условие идемпотентности сборки:
// две сборки одного коммита обязаны дать байт-в-байт одинаковый graph.json.
// Поэтому ни `Math.random`, ни времени, ни тригонометрии: только сложение,
// умножение, деление и `Math.sqrt` — операции, которые IEEE 754 округляет
// однозначно, то есть дают тот же результат на любой машине.

/** Псевдослучайное с фиксированным семенем (mulberry32): целочисленная арифметика. */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Шесть знаков после точки — форма из контракта. */
const round6 = (v) => Math.round(v * 1e6) / 1e6

export const LAYOUT_SEED = 20260913
/** Разрежение после силовой модели: сколько проходов и с какого расстояния. */
const DECLUTTER_STEPS = 250
const DECLUTTER_NEAR = 2.5

/**
 * Силовая раскладка Фрухтермана — Рейнгольда.
 *
 * Стартовый вид витрины («Цикл дня») сюда не входит: раскладка задаёт его
 * сама, слева направо на широком экране и сверху вниз на узком, то есть
 * зависит от ширины окна и посчитаться при сборке не может. Второго набора
 * координат в графе нет — странице хватает поля `n` у фаз и рёбер `runs`.
 *
 * @param {Array<{id:string}>} nodes
 * @param {Array<{from:string,to:string}>} edges
 * @param {{seed?:number, iterations?:number}} options
 * @returns {Map<string,{x:number,y:number}>}
 */
export function layout(nodes, edges, options = {}) {
  const { seed = LAYOUT_SEED, iterations = 400 } = options
  const placed = new Map()
  if (nodes.length === 0) return placed
  if (nodes.length === 1) return placed.set(nodes[0].id, { x: 0.5, y: 0.5 })

  const known = new Set(nodes.map((node) => node.id))
  const linked = new Set()
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue
    linked.add(e.from)
    linked.add(e.to)
  }

  // Изолированные узлы в симуляции не участвуют и на масштаб не влияют.
  // К ним применялось бы только отталкивание — они улетали бы к границам и
  // задавали габарит за всех остальных: на main 24 таких узла ужимали
  // связную часть до 7.7 % квадрата, и в окрестностях пропадали подписи.
  const core = nodes.filter((node) => linked.has(node.id))
  const loose = nodes.filter((node) => !linked.has(node.id))

  if (core.length >= 2) {
    for (const [id, point] of simulate(core, edges, seed, iterations, options)) placed.set(id, point)
  } else {
    for (const node of core) placed.set(node.id, { x: 0.5, y: 0.5 })
  }

  // Изолированные раскладываются по краю квадрата, ровным шагом по периметру:
  // они видны, подписаны и не мешают связной части.
  for (const [i, node] of loose.entries()) placed.set(node.id, onBorder(i, loose.length))

  for (const [id, point] of placed) placed.set(id, { x: round6(point.x), y: round6(point.y) })
  return placed
}

/** Поля: связная часть занимает центр, изолированные стоят по краю. */
const BORDER = 0.03
const INNER = 1 - 2 * BORDER

/**
 * Точка на периметре квадрата по доле пути. Без тригонометрии: обход четырёх
 * сторон сравнениями, чтобы раскладка оставалась побитово воспроизводимой.
 */
function onBorder(i, total) {
  const t = ((i + 0.5) / total) * 4
  const side = Math.floor(t)
  const u = t - side
  const lo = BORDER / 2
  const hi = 1 - BORDER / 2
  if (side === 0) return { x: lo + u * (hi - lo), y: lo }
  if (side === 1) return { x: hi, y: lo + u * (hi - lo) }
  if (side === 2) return { x: hi - u * (hi - lo), y: hi }
  return { x: lo, y: hi - u * (hi - lo) }
}

/** Силовая раскладка связной части с последующей нормировкой по ней же. */
function simulate(nodes, edges, seed, iterations, { declutterSteps = DECLUTTER_STEPS, declutterNear = DECLUTTER_NEAR } = {}) {
  const n = nodes.length
  const rnd = random(seed)
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    px[i] = rnd()
    py[i] = rnd()
  }

  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b)

  // Идеальное расстояние между узлами при площади 1.
  const k = Math.sqrt(1 / n)
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  // Минимальное расстояние: без него совпавшие узлы дают деление на ноль.
  const MIN = 1e-6

  for (let step = 0; step < iterations; step += 1) {
    dx.fill(0)
    dy.fill(0)

    // Отталкивание всех от всех: полторы сотни узлов — это дёшево.
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ex = px[i] - px[j]
        let ey = py[i] - py[j]
        let d2 = ex * ex + ey * ey
        if (d2 < MIN) {
          // Разводим совпавшие узлы предсказуемо, а не случайно.
          ex = (i - j) * MIN
          ey = MIN
          d2 = ex * ex + ey * ey
        }
        const d = Math.sqrt(d2)
        const force = (k * k) / d
        const ux = (ex / d) * force
        const uy = (ey / d) * force
        dx[i] += ux
        dy[i] += uy
        dx[j] -= ux
        dy[j] -= uy
      }
    }

    // Притяжение по рёбрам.
    for (const [a, b] of links) {
      const ex = px[a] - px[b]
      const ey = py[a] - py[b]
      const d = Math.sqrt(ex * ex + ey * ey) || MIN
      const force = (d * d) / k
      const ux = (ex / d) * force
      const uy = (ey / d) * force
      dx[a] -= ux
      dy[a] -= uy
      dx[b] += ux
      dy[b] += uy
    }

    // Охлаждение: шаг убывает линейно, поэтому картинка сходится, а не дрожит.
    const temp = 0.1 * (1 - step / iterations)
    for (let i = 0; i < n; i += 1) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || MIN
      const limit = d < temp ? d : temp
      px[i] += (dx[i] / d) * limit
      py[i] += (dy[i] / d) * limit
    }
  }

  // Разрежение: несколько проходов чистого отталкивания на коротких
  // расстояниях. Силовая модель даёт общую форму, но оставляет пары,
  // сидящие почти в одной точке, — а на канве это две подписи в одном
  // месте, из которых видна одна.
  const near = declutterNear * k
  for (let step = 0; step < declutterSteps; step += 1) {
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ex = px[i] - px[j]
        let ey = py[i] - py[j]
        let d2 = ex * ex + ey * ey
        if (d2 >= near * near) continue
        if (d2 < MIN) {
          ex = (i - j) * MIN
          ey = MIN
          d2 = ex * ex + ey * ey
        }
        const d = Math.sqrt(d2)
        const push = (near - d) / 2
        const ux = (ex / d) * push
        const uy = (ey / d) * push
        dx[i] += ux
        dy[i] += uy
        dx[j] -= ux
        dy[j] -= uy
      }
    }
    for (let i = 0; i < n; i += 1) {
      px[i] += dx[i] * 0.5
      py[i] += dy[i] * 0.5
    }
  }

  // Нормировка — по связной части и по каждой оси отдельно: витрина
  // показывает окрестность, вписанную в канву, и вытянутое облако в
  // единичном квадрате означало бы, что половина канвы пуста, а узлы
  // окрестности сидят друг на друге.
  let minX = px[0]
  let maxX = px[0]
  let minY = py[0]
  let maxY = py[0]
  for (let i = 1; i < n; i += 1) {
    if (px[i] < minX) minX = px[i]
    if (px[i] > maxX) maxX = px[i]
    if (py[i] < minY) minY = py[i]
    if (py[i] > maxY) maxY = py[i]
  }
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1

  const out = new Map()
  for (let i = 0; i < n; i += 1) {
    out.set(nodes[i].id, {
      x: BORDER + ((px[i] - minX) / spanX) * INNER,
      y: BORDER + ((py[i] - minY) / spanY) * INNER,
    })
  }
  return out
}
