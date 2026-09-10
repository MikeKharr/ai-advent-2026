// Витрина атласа: страница `challenge.zpq.ai/atlas/`.
// Раскладка — agent_docs/design/2026-09-13-2100-atlas-page-layout.md,
// решение — ADR 2026-09-13-2000. Ноль зависимостей: только браузерные API
// (ADR 2026-09-07-1525).
//
// Файл делится надвое. Сверху — чистая часть: всё, что считается из
// `graph.json` и проверяется тестами `atlas/test/web.test.js` без браузера.
// Снизу — отрисовка, которая ничего не решает сама.
//
// Ни одно число экрана не написано в разметке: счётчики считаются из
// загруженного графа. Граф растёт с каждым документом, и витрина с вбитым
// числом начинает врать на следующем же мерже.

// ───────────────────────────── чистая часть ─────────────────────────────

/**
 * Форма слова по числу — по последним двум цифрам, как в русском счёте.
 * Витрина про качество работы не имеет права написать «1 следов».
 */
export function plural(n, one, few, many) {
  const tail = Math.abs(n) % 100
  if (tail > 10 && tail < 20) return many
  const last = tail % 10
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

export const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`

/**
 * Счётчик следов. Называет отношение, а не вывод: правило видит имя роли
 * рядом с признаком гейта и не знает, вынесено вето или снято.
 */
export function traceCounter(traces) {
  if (traces.length === 0) return '0 следов по имени роли'
  const records = new Set(traces.map((t) => t.to)).size
  return `${count(traces.length, 'след', 'следа', 'следов')} по имени роли в ${records} ${plural(records, 'записи', 'записях', 'записях')}`
}

const OPEN_CLOSE = [
  ['(', ')'],
  ['«', '»'],
]

/** Скобки и кавычки слева от границы закрыты. */
function balanced(head) {
  return OPEN_CLOSE.every(([o, c]) => {
    let depth = 0
    for (const ch of head) {
      if (ch === o) depth += 1
      else if (ch === c) depth -= 1
    }
    return depth === 0
  })
}

/** `;` или конец предложения — те же знаки, по которым делит `unitsOf`. */
const BOUNDARY = /;|[.!?…]["»)]?(?=\s|$)/g

/**
 * Сегменты чтения. Граница — `;` или конец предложения, у которого слева
 * одинаково `(` и `)` и одинаково `«` и `»`. Несбалансированная граница
 * пропускается: карточка, кончающаяся незакрытой скобкой, — тот самый
 * дефект, ради которого снят предел длины выдержки.
 * @returns {Array<{start:number, end:number}>}
 */
export function segments(text) {
  const out = []
  let start = 0
  for (const m of text.matchAll(BOUNDARY)) {
    const end = m.index + m[0].length
    if (!balanced(text.slice(0, end))) continue
    out.push({ start, end })
    start = end
  }
  if (start < text.length) out.push({ start, end: text.length })
  if (out.length === 0) out.push({ start: 0, end: text.length })
  return out
}

/** От 200 знаков хвост прячется: ниже кнопка стоит внимания дороже текста. */
export const FOLD_FROM = 200

export const isTableRow = (text) => text.trimStart().startsWith('|')

/**
 * Сколько выдержки показывать. Карточка показывает сегменты от первого до
 * последнего, несущего метку: голова перед совпавшим фрагментом сохраняется
 * целиком, подсветку скрыть нельзя по построению.
 * @returns {{end:number, hidden:number}} `end` — конец показанного, `hidden` — знаков в хвосте
 */
export function foldExcerpt(excerpt, marks) {
  const whole = { end: excerpt.length, hidden: 0 }
  if (!marks || isTableRow(excerpt)) return whole
  const segs = segments(excerpt)
  const [from, to] = marks.unit
  let last = -1
  for (let i = 0; i < segs.length; i += 1) if (segs[i].start < to && segs[i].end > from) last = i
  if (last === -1 || last === segs.length - 1) return whole
  const end = segs[last].end
  const hidden = excerpt.length - end
  return hidden < FOLD_FROM ? whole : { end, hidden }
}

/**
 * Разбор разметки внутри одной строки: `**жирный**` и `` `код` ``, и больше
 * ничего. Непарный маркер остаётся символом: `hit()` в `atlas/lib/fired.js`
 * намеренно не снимает ведущие `**`, и выдержка может начинаться с
 * открывающей пары без закрывающей.
 *
 * Возвращает символы с их смещением в исходной строке — разбор идёт третьим
 * шагом после меток и сегментов, и координаты обязаны остаться исходными.
 * @returns {Array<{i:number, strong:boolean, code:boolean}>}
 */
export function parseMarkup(text, base = 0) {
  const chars = []
  const take = (from, to, strong, code) => {
    for (let k = from; k < to; k += 1) chars.push({ i: base + k, strong, code })
  }
  let i = 0
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const close = text.indexOf('**', i + 2)
      if (close !== -1) {
        take(i + 2, close, true, false)
        i = close + 2
        continue
      }
    }
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1)
      if (close !== -1) {
        take(i + 1, close, false, true)
        i = close + 1
        continue
      }
    }
    take(i, i + 1, false, false)
    i += 1
  }
  return chars
}

const inside = (span, i) => span !== undefined && i >= span[0] && i < span[1]

/**
 * Показанный кусок выдержки, разложенный на отрезки одного вида. Порядок
 * обработки обязателен и он трёхшаговый: метки → сегменты → разметка. Здесь
 * третий шаг: метки уже посчитаны по сырой строке, диапазон уже выбран.
 *
 * `mut` — вне совпавшего фрагмента (`--fg-mut`), `mark` — имя роли или
 * слово-признак: то, что нашло правило.
 * @returns {Array<{text:string, mut:boolean, mark:string|null, strong:boolean, code:boolean}>}
 */
export function excerptRuns(raw, from, to, marks) {
  const runs = []
  for (const ch of parseMarkup(raw.slice(from, to), from)) {
    const mut = Boolean(marks) && !inside(marks.unit, ch.i)
    const mark = !marks ? null : inside(marks.role, ch.i) ? 'role' : inside(marks.sign, ch.i) ? 'sign' : null
    const last = runs[runs.length - 1]
    if (last && last.mut === mut && last.mark === mark && last.strong === ch.strong && last.code === ch.code) {
      last.text += raw[ch.i]
    } else {
      runs.push({ text: raw[ch.i], mut, mark, strong: ch.strong, code: ch.code })
    }
  }
  return runs
}

/**
 * Ячейки строки таблицы в координатах исходной строки: `|` не показывается
 * символом, ячейки разделит линия. Ведущий и замыкающий `|` отбрасываются.
 * @returns {Array<{start:number, end:number}>}
 */
export function tableCells(row) {
  const bars = []
  for (let i = 0; i < row.length; i += 1) if (row[i] === '|') bars.push(i)
  if (bars.length < 2) return [{ start: 0, end: row.length }]
  const cells = []
  for (let k = 0; k < bars.length - 1; k += 1) cells.push({ start: bars[k] + 1, end: bars[k + 1] })
  return cells
}

/**
 * Адрес узла: идентификатор с `/`, заменённым на `-`. Обратно разбором не
 * переводится — в ключах есть дефисы; страница строит таблицу по всем
 * идентификаторам графа.
 */
export const addressOf = (id) => id.replaceAll('/', '-')

export function addressTable(nodes) {
  const table = new Map()
  for (const n of nodes) table.set(addressOf(n.id), n.id)
  return table
}

export const FAMILIES = [
  { key: 'dec', name: 'Решения', types: ['adr', 'design'] },
  { key: 'rul', name: 'Правила', types: ['invariant', 'guide', 'class', 'phase'] },
  { key: 'rec', name: 'Записи', types: ['history'] },
  { key: 'act', name: 'Исполнители', types: ['role', 'tier', 'skill'] },
  { key: 'sys', name: 'Система', types: ['day', 'service', 'volume', 'external'] },
]

const FAMILY_OF = new Map(FAMILIES.flatMap((f) => f.types.map((t) => [t, f.key])))
export const familyOf = (type) => FAMILY_OF.get(type) ?? 'act'

/** Имя типа словом: цвет семейства никогда не единственный носитель смысла. */
export const TYPE_NAME = {
  adr: 'Решение — ADR',
  design: 'Дизайн — раскладка',
  history: 'Запись истории',
  guide: 'Гайд',
  invariant: 'Инвариант',
  role: 'Роль',
  tier: 'Ярус модели',
  skill: 'Скилл',
  class: 'Класс гейтов',
  phase: 'Фаза цикла',
  day: 'День',
  service: 'Сервис',
  volume: 'Том',
  external: 'Внешний сервис',
}

/** Имя типа во множественном числе — для фильтров и строки «тип скрыт». */
export const TYPE_PLURAL = {
  adr: 'Решения ADR',
  design: 'Раскладки',
  history: 'Записи',
  guide: 'Гайды',
  invariant: 'Инварианты',
  role: 'Роли',
  tier: 'Ярусы моделей',
  skill: 'Скиллы',
  class: 'Классы гейтов',
  phase: 'Фазы цикла',
  day: 'Дни',
  service: 'Сервисы',
  volume: 'Тома',
  external: 'Внешние сервисы',
}

const LABEL_MAX = 24
export const clipLabel = (s) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX)}…` : s)

/** Дата и время из ключа `2026-09-13-1800` → `13.09 18:00`. */
function stampOf(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2}))?/.exec(key)
  if (!m) return null
  const day = `${m[3]}.${m[2]}`
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day
}

/**
 * Подпись узла на канве — короткое имя, а не заголовок: у заголовков медиана
 * 29 знаков и максимум 99, на графе такое не живёт.
 */
export function shortName(node) {
  const stamp = stampOf(node.key)
  switch (node.type) {
    case 'adr':
      return stamp ? `ADR ${stamp}` : `ADR ${node.key}`
    case 'history':
      return stamp ? `Запись ${stamp}` : `Запись ${node.key}`
    case 'design':
      return stamp ? `Дизайн ${stamp}` : node.key
    case 'class':
      return `Класс ${node.key}`
    case 'phase':
      return clipLabel(`${node.n}. ${node.title}`)
    case 'tier':
      return node.title
    case 'skill':
      return clipLabel(node.key)
    default:
      return node.key
  }
}

/**
 * Чип статуса ADR: в данных 23 различных строки `## Статус` длиной до 185
 * знаков. Чип — навигация, полная строка ниже в «Фактах» — правда.
 */
export function statusChip(status) {
  const first = String(status ?? '')
    .trim()
    .replace(/^[«"]/, '')
    .split(/[\s,.:(]/)[0]
  if (first === 'Принято') return 'Принято'
  if (first === 'Предложено') return 'Предложено'
  if (first === 'Отклонено') return 'Отклонено'
  if (first === 'Заменено') return 'Заменено'
  if (first === 'Заменяет') return 'Принято, заменяет'
  return 'Статус не разобран'
}

/** Вид отношения словом. Называет отношение, а не вывод. */
export const RELATION = {
  cites: ['цитирует', 'процитирован в'],
  replaces: ['заменяет', 'заменён решением'],
  relies: ['опирается на', 'на него опираются'],
  mentions: ['называет роль', 'назван в'],
  about: ['про день', 'документы дня'],
  preloads: ['предзагружает', 'предзагружен ролью'],
  tier: ['ярус модели', 'роли яруса'],
  gates: ['гейт класса', 'класс, где это гейт'],
  runs: ['ведёт фаза', 'фазы, где участвует'],
  routes: ['маршрутизирует', 'маршрут через'],
  serves: ['отдаёт', 'отдаётся через'],
  depends: ['зависит от', 'от него зависят'],
  mounts: ['монтирует', 'монтируется в'],
  calls: ['вызывает', 'вызывается из'],
  image: ['образ в', 'образы из'],
  publishes: ['публикует в', 'публикуется из'],
}

export const relation = (kind, outgoing) => (RELATION[kind] ?? [kind, kind])[outgoing ? 0 : 1]

/**
 * Смежность по всем рёбрам, включая `fired`: след — такая же связь, и на
 * канве он рисуется. Свой блок в панели у него потому, что показывается он
 * иначе, а не потому, что его нет в графе. Кратные рёбра между одной парой
 * узлов сводятся к одной связи — их перечисляет панель, а не картинка.
 */
export function indexGraph(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const near = new Map(graph.nodes.map((n) => [n.id, new Set()]))
  for (const e of graph.edges) {
    near.get(e.from)?.add(e.to)
    near.get(e.to)?.add(e.from)
  }
  return { byId, near }
}

/** Окрестность узла заданной глубины, включая сам узел. */
export function neighborhood(near, id, depth) {
  const seen = new Set([id])
  let front = [id]
  for (let step = 0; step < depth; step += 1) {
    const next = []
    for (const at of front) {
      for (const to of near.get(at) ?? []) {
        if (seen.has(to)) continue
        seen.add(to)
        next.push(to)
      }
    }
    front = next
  }
  return seen
}

/** Самая большая окрестность в два шага: цена второго шага фактом, а не предупреждением. */
export function maxTwoStep(near) {
  let max = 0
  for (const id of near.keys()) max = Math.max(max, neighborhood(near, id, 2).size)
  return max
}

/** Поиск подстрокой по заголовку и короткому имени. Не по тексту документов — их в витрине нет. */
export function searchNodes(nodes, query, limit) {
  const q = query.trim().toLowerCase()
  if (q === '') return { hits: [], total: 0 }
  const all = nodes.filter((n) => `${n.title} ${n.key} ${shortName(n)}`.toLowerCase().includes(q))
  return { hits: all.slice(0, limit), total: all.length }
}

/**
 * Стартовый вид: цепь фаз с ролями и классами гейтов, которые их ведут.
 * Раскладка задана здесь, а не силовой моделью: у неё нет причин ставить
 * фазу 1 слева. Связок «фаза → следующая фаза» в графе нет — порядок задаёт
 * поле `n`, и страница рисует их сама.
 * @returns {{ids:Set<string>, edges:Array, place:Map<string,{x:number,y:number}>}}
 */
export function cycleView(graph, horizontal) {
  const phases = graph.nodes.filter((n) => n.type === 'phase').sort((a, b) => a.n - b.n)
  const runs = graph.edges.filter((e) => e.kind === 'runs')
  const ids = new Set(phases.map((p) => p.id))
  const place = new Map()
  const owner = new Map()
  for (const e of runs) if (!owner.has(e.to)) owner.set(e.to, e.from)

  const around = new Map(phases.map((p) => [p.id, []]))
  for (const [to, from] of owner) {
    around.get(from)?.push(to)
    ids.add(to)
  }

  phases.forEach((phase, col) => {
    place.set(phase.id, { x: col, y: 0 })
    around.get(phase.id).forEach((id, k) => {
      const side = k % 2 === 0 ? -1 : 1
      place.set(id, { x: col, y: side * (1 + Math.floor(k / 2)) })
    })
  })

  const edges = [...runs, ...graph.edges.filter((e) => e.kind === 'gates')].filter((e) => ids.has(e.from) && ids.has(e.to))
  for (let i = 0; i < phases.length - 1; i += 1) edges.push({ from: phases[i].id, to: phases[i + 1].id, kind: 'next' })

  if (!horizontal) for (const p of place.values()) [p.x, p.y] = [p.y, p.x]
  return { ids, edges, place }
}
