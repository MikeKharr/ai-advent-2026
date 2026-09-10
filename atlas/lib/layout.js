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
 * Предел искажения расстояний пооcевой нормировкой. Выше него компонента
 * нормируется изотропно: лучше пустое место в коробке, чем молча растянутая
 * в разы картина.
 */
export const MAX_STRETCH = 1.3

/**
 * Раскладка графа по компонентам связности.
 *
 * Компоненты раскладываются каждая отдельно и потом укладываются в квадрат
 * коробками со стороной, пропорциональной корню из числа узлов. Общая
 * симуляция для этого не годится: отталкивание уносит маленькую компоненту в
 * угол, потому что притягивать её к остальным нечем, — на main пара из двух
 * узлов улетала в противоположный угол и одна задавала габарит, а главная
 * компонента из 150 узлов сжималась в 2.7 % площади. Габаритная рамка при
 * этом выглядела здоровой: она мерит рамку, а не заполненность.
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

  const parts = components(nodes, edges)

  // Коробка компоненты: сторона по корню из числа узлов, то есть площадь
  // пропорциональна размеру. Компонента из одного узла — точка, из ста —
  // в десять раз шире.
  const boxes = parts.map((part, i) => ({
    nodes: part,
    side: Math.sqrt(part.length),
    // Семя своё у каждой компоненты, иначе одинаковые по форме компоненты
    // легли бы одинаково и читались как одна.
    local: part.length >= 2 ? simulate(part, edges, seed + i, iterations, options) : new Map([[part[0].id, { x: 0.5, y: 0.5 }]]),
  }))

  const packed = pack(boxes)
  for (const box of boxes) {
    for (const node of box.nodes) {
      const local = box.local.get(node.id)
      placed.set(node.id, {
        x: packed.scale * (box.x + local.x * box.side - packed.minX) + packed.offsetX,
        y: packed.scale * (box.y + local.y * box.side - packed.minY) + packed.offsetY,
      })
    }
  }

  for (const [id, point] of placed) placed.set(id, { x: round6(point.x), y: round6(point.y) })
  return placed
}

/** Поля квадрата: узел у самой границы обрезался бы подписью. */
const BORDER = 0.03
const INNER = 1 - 2 * BORDER
/** Просвет между коробками компонент, в тех же единицах, что сторона. */
const GAP = 0.6

/**
 * Компоненты связности, от большой к малой. Порядок детерминирован: узлы
 * обходятся в порядке графа, компоненты сортируются по размеру, а при равном
 * размере — по первому идентификатору в порядке кодовых единиц (не
 * `localeCompare`: он зависит от локали и версии ICU).
 */
export function components(nodes, edges) {
  const near = new Map(nodes.map((node) => [node.id, []]))
  for (const e of edges) {
    if (!near.has(e.from) || !near.has(e.to) || e.from === e.to) continue
    near.get(e.from).push(e.to)
    near.get(e.to).push(e.from)
  }

  const seen = new Set()
  const parts = []
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    const part = []
    const queue = [node.id]
    seen.add(node.id)
    while (queue.length > 0) {
      const id = queue.shift()
      part.push(id)
      for (const other of near.get(id)) {
        if (seen.has(other)) continue
        seen.add(other)
        queue.push(other)
      }
    }
    const byId = new Map(nodes.map((n) => [n.id, n]))
    parts.push(part.map((id) => byId.get(id)))
  }

  return parts.sort((a, b) => b.length - a.length || (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0))
}

/**
 * Полочная укладка коробок: строка заполняется слева направо, следующая
 * начинается, когда строка переросла целевую ширину. Целевая ширина — корень
 * из суммарной площади, поэтому укладка выходит примерно квадратной.
 * Масштаб общий для обеих осей: разный исказил бы размеры компонент
 * относительно друг друга.
 */
function pack(boxes) {
  const area = boxes.reduce((sum, b) => sum + b.side * b.side, 0)
  const target = Math.sqrt(area) * 1.1
  let x = 0
  let y = 0
  let rowHeight = 0
  let width = 0
  for (const box of boxes) {
    if (x > 0 && x + box.side > target) {
      y += rowHeight + GAP
      x = 0
      rowHeight = 0
    }
    box.x = x
    box.y = y
    x += box.side + GAP
    if (box.side > rowHeight) rowHeight = box.side
    if (x - GAP > width) width = x - GAP
  }
  const height = y + rowHeight
  const scale = INNER / Math.max(width, height, 1e-9)
  return {
    scale,
    minX: 0,
    minY: 0,
    offsetX: BORDER + (INNER - width * scale) / 2,
    offsetY: BORDER + (INNER - height * scale) / 2,
  }
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

  // Нормировка коробки компоненты — по каждой оси отдельно. Это осознанное
  // искажение расстояний: страница масштабирует обе оси одним коэффициентом
  // (`fit` в `web/app.js` берёт `Math.min` по осям и центрирует), поэтому
  // растяжение доезжает до экрана, а не снимается отрисовкой. Размен — на
  // main облако связной части 14.61 × 16.69, то есть расстояния искажаются в
  // 1.14 раза, и за это коробка заполняется целиком вместо 77 %.
  //
  // Порог обязателен: без него искажение может незаметно вырасти в разы на
  // другом наборе документов. Выше MAX_STRETCH нормировка изотропная —
  // компонента займёт свою коробку не целиком, но форма не соврёт.
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
  const stretch = Math.max(spanX, spanY) / Math.min(spanX, spanY)

  let scaleX = 1 / spanX
  let scaleY = 1 / spanY
  let shiftX = 0
  let shiftY = 0
  if (stretch > MAX_STRETCH) {
    const common = 1 / Math.max(spanX, spanY)
    scaleX = common
    scaleY = common
    shiftX = (1 - spanX * common) / 2
    shiftY = (1 - spanY * common) / 2
  }

  const out = new Map()
  for (let i = 0; i < n; i += 1) {
    out.set(nodes[i].id, {
      x: shiftX + (px[i] - minX) * scaleX,
      y: shiftY + (py[i] - minY) * scaleY,
    })
  }
  return out
}
