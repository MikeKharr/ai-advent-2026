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
export function layout(nodes, edges, { seed = LAYOUT_SEED, iterations = 400 } = {}) {
  const n = nodes.length
  if (n === 0) return new Map()
  if (n === 1) return new Map([[nodes[0].id, { x: 0.5, y: 0.5 }]])

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

    // Отталкивание всех от всех: 174 узла — 15 тысяч пар, это дёшево.
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

  // Приведение в единичный квадрат одним масштабом по обеим осям: разное
  // масштабирование осей исказило бы расстояния, ради которых всё считалось.
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
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const offsetX = (1 - (maxX - minX) / span) / 2
  const offsetY = (1 - (maxY - minY) / span) / 2

  const placed = new Map()
  for (let i = 0; i < n; i += 1) {
    placed.set(nodes[i].id, {
      x: round6(offsetX + (px[i] - minX) / span),
      y: round6(offsetY + (py[i] - minY) / span),
    })
  }
  return placed
}
