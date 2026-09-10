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

/** Родительный падеж множественного числа — для строки «Ни одного ребра». */
export const TYPE_MANY = {
  adr: 'решений ADR',
  design: 'раскладок',
  history: 'записей',
  guide: 'гайдов',
  invariant: 'инвариантов',
  role: 'ролей',
  tier: 'ярусов моделей',
  skill: 'скиллов',
  class: 'классов гейтов',
  phase: 'фаз',
  day: 'дней',
  service: 'сервисов',
  volume: 'томов',
  external: 'внешних сервисов',
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

// ───────────────────────────── отрисовка ─────────────────────────────

const REPO = 'https://github.com/mikekharr/ai-advent-2026'
const ATLAS_ADR = `${REPO}/blob/main/agent_docs/adr/2026-09-13-2000-project-atlas.md`
/** До скольких узлов подписи видны всегда. */
const LABELS_UPTO = 40
/** Строк в списке до свёртки и в выдаче поиска. */
const LIST_UPTO = 10
const SEARCH_UPTO = 12

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

const state = {
  graph: null,
  index: null,
  addresses: null,
  stats: null,
  selected: null,
  missing: null,
  depth: 1,
  full: false,
  hidden: new Set(),
  hover: null,
  view: { ids: new Set(), edges: [], place: null, line: '' },
  cam: { base: 1, cx: 0, cy: 0, scale: 1, panX: 0, panY: 0 },
  from: null,
  t0: 0,
  status: 'loading',
  reason: '',
  open: new Set(),
}

/** Числа экрана — из графа. Литералов в разметке нет: граф растёт каждый мерж. */
function statsOf(graph) {
  const byType = {}
  for (const n of graph.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1
  const fired = graph.edges.filter((e) => e.kind === 'fired')
  const roles = graph.nodes.filter((n) => n.type === 'role')
  const traced = new Set(fired.map((e) => e.from))
  const alone = graph.nodes.filter((n) => state.index.near.get(n.id).size === 0)
  const aloneBy = {}
  for (const n of alone) aloneBy[n.type] = (aloneBy[n.type] ?? 0) + 1
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byType,
    fired,
    roles,
    rolesWithout: roles.filter((r) => !traced.has(r.id)).length,
    alone: alone.length,
    aloneBy,
    twoStep: maxTwoStep(state.index.near),
  }
}

const node = (id) => state.index.byId.get(id)
const famClass = (n) => `f-${familyOf(n.type)}`

/** Ссылка на узел: настоящая `a[href="#…"]`, а не `div` с обработчиком. */
function nodeLink(n, note) {
  const a = el('a', `node-link ${famClass(n)}`)
  a.href = `#${addressOf(n.id)}`
  const dot = el('span', 'dot')
  dot.setAttribute('aria-hidden', 'true')
  a.append(dot, el('span', 'name', shortName(n)), el('span', 'meta', note ?? TYPE_NAME[n.type]))
  if (n.id === state.selected) a.setAttribute('aria-current', 'true')
  return a
}

function ghLink(file, line) {
  const sha = state.graph.provenance?.sha || 'main'
  return `${REPO}/blob/${sha}/${file}${line ? `#L${line}` : ''}`
}

// ── Вид ────────────────────────────────────────────────────────────────

const mapOpen = () => $('map').open

const horizontal = () => {
  const box = mapOpen() ? $('map-wrap') : $('canvas-wrap')
  return box.clientWidth >= box.clientHeight
}

const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`)

/** Кратные рёбра между одной парой рисуются одной линией. Перечисляет их панель. */
function dedupe(edges) {
  const seen = new Set()
  return edges.filter((e) => {
    const key = pairKey(e.from, e.to)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function computeView() {
  const { graph } = state
  let ids
  let place = null
  let edges

  if (state.full) {
    ids = new Set(graph.nodes.map((n) => n.id))
    edges = graph.edges
  } else if (state.selected) {
    ids = neighborhood(state.index.near, state.selected, state.depth)
    edges = graph.edges
  } else {
    const cycle = cycleView(graph, horizontal())
    ids = cycle.ids
    place = cycle.place
    edges = cycle.edges
  }

  // Фильтр убирает узлы с канвы, но не влияет на панель: иначе он молча
  // уводил бы посетителя с узла, который он читает.
  const shown = new Set([...ids].filter((id) => !state.hidden.has(node(id).type)))
  const links = dedupe(edges.filter((e) => shown.has(e.from) && shown.has(e.to)))
  state.view = { ids: shown, edges: links, place, line: viewLine(shown, links) }
}

function viewLine(ids, links) {
  if (state.full) {
    return `Весь граф: ${count(state.stats.nodes, 'узел', 'узла', 'узлов')}, ${count(state.stats.edges, 'связь', 'связи', 'связей')}. Подписи скрыты — узел называет панель`
  }
  if (ids.size === 0) return 'Ни одного узла: скрыты все типы'
  if (state.selected) {
    if (ids.size === 1 && links.length === 0) return 'У этого узла нет связей — на канве только он'
    const step = state.depth === 1 ? '1 шаг' : '2 шага'
    return `Соседи узла ${shortName(node(state.selected))}, ${step}: ${count(ids.size, 'узел', 'узла', 'узлов')}, ${count(links.length, 'связь', 'связи', 'связей')}`
  }
  const of = (type) => [...ids].filter((id) => node(id).type === type).length
  return `Цикл дня: ${count(of('phase'), 'фаза', 'фазы', 'фаз')}, ${count(of('role'), 'роль', 'роли', 'ролей')}, ${count(of('class'), 'класс', 'класса', 'классов')} гейтов`
}

// ── Канва ──────────────────────────────────────────────────────────────

const PAD = 32
const TWEEN = 120
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const colors = {}

function readColors() {
  const css = getComputedStyle(document.documentElement)
  for (const key of ['fam-dec', 'fam-rul', 'fam-rec', 'fam-act', 'fam-sys', 'fg', 'acc', 'line-ctl', 'surface'])
    colors[key] = css.getPropertyValue(`--${key}`).trim()
}

/** Координаты приходят из сборки; стартовый вид считает их сам по номеру фазы. */
function points() {
  const map = new Map()
  for (const id of state.view.ids) {
    const p = state.view.place?.get(id) ?? node(id)
    map.set(id, { x: p.x, y: p.y })
  }
  return map
}

function fit(canvas, pts) {
  if (pts.size === 0) return { base: 1, cx: 0, cy: 0 }
  const xs = [...pts.values()].map((p) => p.x)
  const ys = [...pts.values()].map((p) => p.y)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  const base = Math.min(
    spanX > 0 ? (canvas.clientWidth - 2 * PAD) / spanX : Infinity,
    spanY > 0 ? (canvas.clientHeight - 2 * PAD) / spanY : Infinity,
  )
  return {
    base: Number.isFinite(base) ? base : 1,
    cx: (Math.max(...xs) + Math.min(...xs)) / 2,
    cy: (Math.max(...ys) + Math.min(...ys)) / 2,
  }
}

const transform = (canvas, cam) => {
  const k = cam.base * cam.scale
  const w = canvas.clientWidth / 2
  const h = canvas.clientHeight / 2
  return (p) => ({ x: (p.x - cam.cx) * k + w + cam.panX, y: (p.y - cam.cy) * k + h + cam.panY })
}

/** Переход камеры — только положение и масштаб, 120 мс. Узлы не анимируются. */
function camNow() {
  if (!state.from) return state.cam
  const t = Math.min(1, (performance.now() - state.t0) / TWEEN)
  const from = state.from
  const to = state.cam
  const mix = (key) => from[key] + (to[key] - from[key]) * t
  if (t >= 1) state.from = null
  return { base: mix('base'), cx: mix('cx'), cy: mix('cy'), scale: mix('scale'), panX: mix('panX'), panY: mix('panY') }
}

/** Перерисовка по событию, а не в цикле: статичная картинка не занимает процессор. */
function paint() {
  const canvas = mapOpen() ? $('map-canvas') : $('canvas')
  if (!canvas || canvas.clientWidth === 0 || !state.graph) return
  const dpr = devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const cam = camNow()
  const at = transform(canvas, cam)
  const screen = new Map([...points()].map(([id, p]) => [id, at(p)]))
  const sel = state.view.ids.has(state.selected) ? state.selected : null
  const selFam = sel ? colors[`fam-${familyOf(node(sel).type)}`] : null

  // Порядок отрисовки — рёбра, узлы, подписи: подпись всегда поверх всего,
  // ребро никогда не поверх узла.
  for (const e of state.view.edges) {
    const a = screen.get(e.from)
    const b = screen.get(e.to)
    if (!a || !b) continue
    const touches = sel !== null && (e.from === sel || e.to === sel)
    ctx.strokeStyle = touches ? selFam : colors['line-ctl']
    ctx.lineWidth = touches ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  for (const [id, p] of screen) {
    const isSel = id === sel
    const r = isSel ? 8 : 5
    // Наведение меняет заливку, а не размер: подрастающий узел читается как
    // сбой, а на плотном графе ещё и наезжает на соседей.
    ctx.fillStyle = id === state.hover ? colors.fg : colors[`fam-${familyOf(node(id).type)}`]
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    if (!isSel) continue
    // Кольцо --acc — единственный акцентный элемент экрана.
    ctx.strokeStyle = colors.acc
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2)
    ctx.stroke()
  }

  const always = state.view.ids.size <= LABELS_UPTO
  const near = sel ? state.index.near.get(sel) : null
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  // Порядок важности: выбранный, узел под курсором, его соседи, остальные.
  // Подпись, которой не хватило места, уступает более важной — полный список
  // узлов вида всё равно стоит рядом строками, и там не теряется ничего.
  // В цепи фаза важнее всех: она и есть рассказ стартового вида.
  const rank = (id) =>
    id === sel ? 0 : state.view.place !== null && node(id).type === 'phase' ? 1 : id === state.hover ? 2 : near?.has(id) ? 3 : 4
  const order = [...screen.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const boxes = []
  const free = (box) =>
    boxes.every((b) => box.x2 <= b.x1 || box.x1 >= b.x2 || box.y2 <= b.y1 || box.y1 >= b.y2)
  for (const id of order) {
    const p = screen.get(id)
    if (!always && id !== sel && id !== state.hover && !near?.has(id)) continue
    const n = node(id)
    const text = shortName(n)
    const width = ctx.measureText(text).width
    // В цепи подписи разводятся по высоте: колонка цепи на канве 864 px — это
    // 86 px, а подпись до 24 знаков занимает до 170 px, и десять подписей в
    // один ряд не помещаются ни при какой ширине колонки.
    const chain = state.view.place?.get(id)
    const isPhase = n.type === 'phase'
    let top = p.y + 8
    if (chain && !horizontal()) {
      // Цепь идёт сверху вниз: роли стоят сбоку от своей фазы, поэтому их
      // подписи уходят над узлом, а подпись фазы остаётся под ним.
      top = isPhase ? p.y + 8 : p.y - 24
    } else if (chain) {
      const odd = Math.abs(Math.round(chain.x)) % 2 === 1
      top = isPhase ? (odd ? p.y - 24 : p.y + 8) : p.y + 8 + (odd ? 18 : 0)
    }
    // Подпись у края канвы не обрезается: сдвигается внутрь целиком.
    const x = Math.min(Math.max(p.x, width / 2 + 4), w - width / 2 - 4)
    // Подложка в ширину текста плюс 2 px: без неё подпись на пересечении с
    // ребром нечитаема.
    const box = { x1: x - width / 2 - 2, x2: x + width / 2 + 2, y1: top, y2: top + 16 }
    if (!free(box)) continue
    boxes.push(box)
    ctx.fillStyle = colors.surface
    ctx.fillRect(box.x1, box.y1, width + 4, 16)
    ctx.fillStyle = colors.fg
    ctx.fillText(text, x, top + 2)
  }

  if (state.from) requestAnimationFrame(paint)
}

function reframe(animate) {
  const canvas = mapOpen() ? $('map-canvas') : $('canvas')
  if (!canvas || canvas.clientWidth === 0) return
  const before = { ...state.cam }
  state.cam = { ...fit(canvas, points()), scale: 1, panX: 0, panY: 0 }
  state.from = animate && !reduceMotion() ? before : null
  state.t0 = performance.now()
  paint()
}

/** Пределы масштаба — 0.5x…4x. */
const clampScale = (s) => Math.min(4, Math.max(0.5, s))

function zoom(factor, anchor) {
  const canvas = mapOpen() ? $('map-canvas') : $('canvas')
  const next = clampScale(state.cam.scale * factor)
  if (anchor) {
    const k = next / state.cam.scale
    const w = canvas.clientWidth / 2
    const h = canvas.clientHeight / 2
    state.cam.panX = anchor.x - w - (anchor.x - w - state.cam.panX) * k
    state.cam.panY = anchor.y - h - (anchor.y - h - state.cam.panY) * k
  }
  state.cam.scale = next
  paint()
}

function pick(canvas, ev) {
  const box = canvas.getBoundingClientRect()
  const x = ev.clientX - box.left
  const y = ev.clientY - box.top
  const at = transform(canvas, camNow())
  let best = null
  for (const [id, p] of points()) {
    const s = at(p)
    const d = Math.hypot(s.x - x, s.y - y)
    if (d <= 10 && (best === null || d < best.d)) best = { id, d }
  }
  return best === null ? null : best.id
}

function wireCanvas(canvas) {
  let drag = null
  canvas.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, panX: state.cam.panX, panY: state.cam.panY, moved: false }
    canvas.setPointerCapture(ev.pointerId)
  })
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x
      const dy = ev.clientY - drag.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
      state.cam.panX = drag.panX + dx
      state.cam.panY = drag.panY + dy
      paint()
      return
    }
    const hit = pick(canvas, ev)
    if (hit === state.hover) return
    state.hover = hit
    canvas.style.cursor = hit ? 'pointer' : 'grab'
    paint()
  })
  canvas.addEventListener('pointerup', (ev) => {
    const moved = drag !== null && drag.moved
    drag = null
    if (!moved) {
      const hit = pick(canvas, ev)
      if (hit) {
        select(hit)
        if (mapOpen()) $('map').close()
      }
    }
  })
  canvas.addEventListener('pointercancel', () => {
    drag = null
  })
  // Колесо без модификатора прокручивает страницу: перехват ломает прокрутку
  // узкого экрана и раздражает на широком.
  canvas.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return
      ev.preventDefault()
      const box = canvas.getBoundingClientRect()
      zoom(ev.deltaY < 0 ? 1.1 : 0.9, { x: ev.clientX - box.left, y: ev.clientY - box.top })
    },
    { passive: false },
  )
}

// ── Колонка навигации ──────────────────────────────────────────────────

function renderLede() {
  const s = state.stats
  $('lede').textContent =
    `Схема того, как устроен этот проект и по каким правилам он делается: ` +
    `${count(s.nodes, 'узел', 'узла', 'узлов')} и ${count(s.edges, 'связь', 'связи', 'связей')}, ` +
    `извлечённых из файлов репозитория. Вручную заведены только классы гейтов, фазы цикла и внешние ` +
    `сервисы — всё остальное собрано из ссылок, которые документы проекта уже ставят друг на друга.`
}

function renderTools() {
  const s = state.stats
  $('depth-note').textContent = `Два шага у самых связанных узлов доходят до ${count(s.twoStep, 'узла', 'узлов', 'узлов')} из ${s.nodes} — это уже почти весь граф`
  // Ярлык «2 шага» несёт цену до нажатия, когда узел выбран.
  const two = state.selected ? neighborhood(state.index.near, state.selected, 2).size : null
  $('depth-2').textContent = two === null ? '2 шага' : `2 шага (${count(two, 'узел', 'узла', 'узлов')})`
  $('full-label').textContent = `Показать весь граф — ${count(s.nodes, 'узел', 'узла', 'узлов')}, ${count(s.edges, 'связь', 'связи', 'связей')}`

  const box = clear($('filters'))
  for (const fam of FAMILIES) {
    const types = fam.types.filter((t) => s.byType[t] > 0)
    if (types.length === 0) continue
    const group = el('fieldset', `fam f-${fam.key}`)
    const legend = el('legend')
    const swatch = el('span', 'swatch')
    swatch.setAttribute('aria-hidden', 'true')
    const head = el('span', 'fam-head')
    head.append(swatch, el('span', undefined, fam.name))
    legend.appendChild(head)
    group.appendChild(legend)

    const all = types.every((t) => !state.hidden.has(t))
    const none = types.every((t) => state.hidden.has(t))
    const famBox = el('input')
    famBox.type = 'checkbox'
    famBox.checked = all
    famBox.indeterminate = !all && !none
    famBox.addEventListener('change', () => {
      for (const t of types) if (famBox.checked) state.hidden.delete(t)
        else state.hidden.add(t)
      refresh()
    })
    const famLabel = el('label')
    famLabel.append(famBox, el('span', undefined, all || none ? 'все типы' : 'часть типов'))
    group.appendChild(famLabel)

    const list = el('div', 'types')
    for (const type of types) {
      const label = el('label')
      const box2 = el('input')
      box2.type = 'checkbox'
      box2.checked = !state.hidden.has(type)
      box2.addEventListener('change', () => {
        if (box2.checked) state.hidden.delete(type)
        else state.hidden.add(type)
        refresh()
      })
      label.append(box2, el('span', undefined, TYPE_PLURAL[type]), el('span', 'n', String(s.byType[type])))
      list.appendChild(label)
    }
    group.appendChild(list)
    box.appendChild(group)
  }

  const reset = $('filters-reset')
  reset.hidden = state.hidden.size === 0
  reset.textContent = `Сбросить фильтры (скрыто ${count(state.hidden.size, 'тип', 'типа', 'типов')})`
}

function renderNodeList() {
  const order = new Map(FAMILIES.map((f, i) => [f.key, i]))
  const ids = [...state.view.ids].sort((a, b) => {
    if (a === state.selected) return -1
    if (b === state.selected) return 1
    const na = node(a)
    const nb = node(b)
    return (
      order.get(familyOf(na.type)) - order.get(familyOf(nb.type)) ||
      na.type.localeCompare(nb.type) ||
      na.title.localeCompare(nb.title, 'ru')
    )
  })
  $('nodelist-h').textContent = `Узлы в этом виде: ${ids.length}`
  const ul = clear($('nodes'))
  if (ids.length === 0) {
    const li = el('li')
    li.appendChild(el('p', 'empty', 'Ни одного узла: скрыты все типы'))
    ul.appendChild(li)
    return
  }
  for (const id of ids) {
    const li = el('li')
    li.appendChild(nodeLink(node(id)))
    ul.appendChild(li)
  }
}

function renderSearch() {
  const q = $('q').value
  const ul = clear($('results'))
  if (q.trim() === '') return
  const { hits, total } = searchNodes(state.graph.nodes, q, SEARCH_UPTO)
  if (hits.length === 0) {
    const li = el('li')
    li.appendChild(el('p', 'empty', 'Ничего не нашлось. Поиск идёт по заголовкам и коротким именам, не по тексту документов.'))
    ul.appendChild(li)
    return
  }
  for (const n of hits) {
    const li = el('li')
    li.appendChild(nodeLink(n, `${TYPE_NAME[n.type]} · ${n.title}`))
    ul.appendChild(li)
  }
  if (total > hits.length) {
    const li = el('li')
    li.appendChild(el('p', 'empty', `Ещё ${count(total - hits.length, 'совпадение', 'совпадения', 'совпадений')}: уточните запрос`))
    ul.appendChild(li)
  }
}

// ── Панель ─────────────────────────────────────────────────────────────

function block(title) {
  const section = el('section', 'panel-block')
  if (title) section.appendChild(el('h3', undefined, title))
  return section
}

function renderPanel() {
  const panel = clear($('panel'))
  panel.classList.add('panel')
  if (state.status === 'loading') {
    panel.appendChild(el('p', 'empty', 'Читаю схему проекта…'))
    return
  }
  if (state.status === 'error') {
    panel.appendChild(el('p', 'empty', `Схему не удалось загрузить. ${state.reason}`))
    return
  }
  if (state.missing) {
    renderMissing(panel)
    return
  }
  if (!state.selected) {
    renderStart(panel)
    return
  }
  renderNode(panel, node(state.selected))
}

function renderMissing(panel) {
  const head = block()
  const h2 = el('h2', undefined, 'Узла нет в этой сборке')
  h2.id = 'panel-h'
  head.appendChild(h2)
  const p = el('p', 'empty')
  p.append('Узла ', el('code', 'mono', state.missing), ' нет в этой сборке. Схема пересобирается при каждом мерже — документ мог быть переименован.')
  head.appendChild(p)
  const back = el('button', undefined, 'К началу')
  back.type = 'button'
  back.addEventListener('click', () => select(null))
  head.appendChild(back)
  panel.appendChild(head)
}

function renderStart(panel) {
  const s = state.stats
  const head = block()
  const h2 = el('h2', undefined, 'С чего начать')
  h2.id = 'panel-h'
  head.append(
    h2,
    el('p', 'sub', 'Слева — цикл дня: десять фаз, через которые проходит любая задача, и роли, которые их ведут. Две фазы помечены как гейт владельца — без его слова работа дальше не идёт.'),
    el('p', 'meta-row num', `${count(s.nodes, 'узел', 'узла', 'узлов')} · ${count(s.edges, 'связь', 'связи', 'связей')} · ${count(s.byType.history ?? 0, 'запись', 'записи', 'записей')} истории`),
  )
  panel.appendChild(head)

  const traces = block('Правила и их следы')
  traces.appendChild(el('p', 'trace-note', `имя роли рядом с признаком гейта в ${count(s.byType.history ?? 0, 'записи', 'записях', 'записях')} истории`))
  const table = el('table', 'summary-table')
  const body = el('tbody')
  const byRole = new Map()
  for (const e of s.fired) {
    if (!byRole.has(e.from)) byRole.set(e.from, [])
    byRole.get(e.from).push(e)
  }
  for (const [id, mine] of [...byRole].sort((a, b) => b[1].length - a[1].length)) {
    const tr = el('tr')
    const cell = el('td')
    cell.appendChild(nodeLink(node(id)))
    const dates = mine.map((e) => node(e.to).date).filter(Boolean).sort()
    const span = dates.length === 0 ? '' : dates[0] === dates[dates.length - 1] ? dayMonth(dates[0]) : `${dayMonth(dates[0])} – ${dayMonth(dates[dates.length - 1])}`
    // Счётчик и диапазон дат в одной ячейке: в колонке 24rem три столбца
    // текстом не живут, а число обрезать нельзя.
    const right = el('td', 'n', traceCounter(mine))
    right.append(el('br'), el('span', 'span', span))
    tr.append(cell, right)
    body.appendChild(tr)
  }
  table.appendChild(body)
  traces.append(table, el('p', 'trace-note', `У остальных ${count(s.rolesWithout, 'роли', 'ролей', 'ролей')} следов нет — почему, сказано на их узлах.`))
  panel.appendChild(traces)
}

/** Дата дня приходит уже как `13.09`, дата документа — как `2026-09-13`. */
const isIso = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
const dayMonth = (date) => (isIso(date) ? `${date.slice(8, 10)}.${date.slice(5, 7)}` : (date ?? ''))
const fullDate = (date) => (isIso(date) ? `${dayMonth(date)}.${date.slice(0, 4)}` : (date ?? ''))

function renderNode(panel, n) {
  const head = block()
  const kicker = el('p', `kicker ${famClass(n)}`)
  const dot = el('span', 'dot')
  dot.setAttribute('aria-hidden', 'true')
  kicker.append(dot, el('span', undefined, TYPE_NAME[n.type]))
  const h2 = el('h2', undefined, n.title)
  h2.id = 'panel-h'
  head.append(kicker, h2)

  const meta = []
  if (n.date) meta.push(fullDate(n.date))
  const about = state.graph.edges.find((e) => e.from === n.id && e.kind === 'about')
  if (about) meta.push(node(about.to).key)
  const row = el('p', 'meta-row num')
  if (n.type === 'adr') {
    row.append(el('span', 'chip', statusChip(n.status)), ' ')
  }
  row.append(meta.join(' · '))
  if (meta.length > 0 || n.type === 'adr') head.appendChild(row)
  if (state.hidden.has(n.type)) head.appendChild(el('p', 'empty', `Тип «${TYPE_PLURAL[n.type]}» сейчас скрыт фильтром.`))
  panel.appendChild(head)

  const facts = factsOf(n)
  if (facts.length > 0) {
    const box = block('Факты')
    const dl = el('dl')
    for (const [term, value, mono] of facts) {
      dl.appendChild(el('dt', undefined, term))
      const dd = el('dd', mono ? 'mono' : undefined)
      if (Array.isArray(value)) value.forEach((link, i) => dd.append(i ? ', ' : '', link))
      else if (mono) dd.append(value)
      // Разметка в тексте документа разбирается тем же однопроходным разбором:
      // показать `**` и `` ` `` как есть — показать протёкший markdown.
      else for (const run of excerptRuns(value, 0, value.length, null)) dd.appendChild(runNode(run))
      dl.appendChild(dd)
    }
    box.appendChild(dl)
    panel.appendChild(box)
  }

  if (n.excerpt) {
    const box = block('Из документа')
    const quote = el('blockquote', 'quote')
    for (const run of excerptRuns(n.excerpt, 0, n.excerpt.length, null)) quote.appendChild(runNode(run))
    const link = el('a', 'plain', 'Полный текст — в репозитории')
    link.href = ghLink(n.file)
    const p = el('p', 'trace-note')
    p.appendChild(link)
    box.append(quote, p)
    panel.appendChild(box)
  }

  if (n.type === 'phase') panel.appendChild(phaseNav(n))
  if (state.index.near.get(n.id).size === 0) {
    const s = state.stats
    const by = Object.entries(s.aloneBy)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n2]) => `${TYPE_MANY[type]} ${n2}`)
      .join(', ')
    panel.appendChild(block()).appendChild(
      el('p', 'empty', `Ни одного ребра. Сейчас таких узлов ${s.alone}: ${by}.`),
    )
  }
  linkBlocks(panel, n)
  if (n.type === 'role') panel.appendChild(tracesBlock(n))
}

function factsOf(n) {
  const out = []
  const link = (id) => nodeLink(node(id))
  const targets = (kind) => state.graph.edges.filter((e) => e.from === n.id && e.kind === kind).map((e) => link(e.to))
  const sources = (kind) => state.graph.edges.filter((e) => e.to === n.id && e.kind === kind).map((e) => link(e.from))
  switch (n.type) {
    case 'adr':
      if (n.status) out.push(['Статус', n.status])
      if (n.date) out.push(['Дата', n.date])
      out.push(['Файл', n.file, true])
      break
    case 'history':
    case 'design':
      if (n.date) out.push(['Дата', n.date])
      out.push(['Файл', n.file, true])
      break
    case 'guide':
      out.push(['Файл', n.file, true])
      break
    case 'invariant':
      out.push(['Текст инварианта', n.text])
      break
    case 'role':
      if (n.model) out.push(['Модель', n.model])
      if (n.effort) out.push(['Усилие', n.effort])
      if (n.skills?.length) out.push(['Предзагруженные скиллы', targets('preloads')])
      if (n.owns) out.push(['Владеет', n.owns])
      if (n.never) out.push(['Никогда', n.never])
      if (n.description) out.push(['Описание', n.description])
      break
    case 'tier':
      out.push(['Модель', n.model], ['Усилие', n.effort], ['Роли этого яруса', sources('tier')])
      break
    case 'skill':
      if (n.description) out.push(['Описание', n.description])
      out.push(['Происхождение', n.vendored ? 'вендорный' : 'свой'], ['Файл', n.file, true])
      break
    case 'class':
      out.push(['Что входит', n.what])
      if (n.note) out.push(['Примечание', n.note])
      break
    case 'phase':
      out.push(['Номер', String(n.n)])
      out.push(['Критерий выхода', n.exit])
      out.push(['Гейт владельца', n.human ? 'да' : 'нет'])
      break
    case 'day':
      if (n.date) out.push(['Дата', n.date])
      out.push(['Маршрут', n.route, true], ['Каталог', n.dir, true], ['Образ', n.image, true])
      if (n.envFiles?.length) out.push(['Файлы окружения', n.envFiles.join(' '), true])
      break
    case 'service':
      out.push(['Образ', n.image, true])
      out.push(['Файлы окружения', n.envFiles?.length ? n.envFiles.join(' ') : 'нет', true])
      break
    case 'external':
      out.push(['Вид', n.kind], ['Ярус', n.tier], ['Модель', n.model ?? 'нет'])
      if (n.note) out.push(['Примечание', n.note])
      break
    default:
      break
  }
  return out
}

function phaseNav(n) {
  const box = block('Цикл дня')
  const phases = state.graph.nodes.filter((x) => x.type === 'phase').sort((a, b) => a.n - b.n)
  const rail = el('ul', 'rail')
  for (const p of phases) {
    const li = el('li')
    const a = el('a', undefined, String(p.n))
    a.href = `#${addressOf(p.id)}`
    if (p.id === n.id) a.setAttribute('aria-current', 'true')
    li.appendChild(a)
    rail.appendChild(li)
  }
  box.appendChild(rail)
  const roles = state.graph.edges.filter((e) => e.from === n.id && e.kind === 'runs')
  if (roles.length === 0) box.appendChild(el('p', 'empty', 'Роли нет: фаза механическая — ветка, PR, зелёный CI.'))
  const steps = el('div', 'steps')
  const at = phases.findIndex((p) => p.id === n.id)
  // Ссылки, которой некуда вести, просто нет — не отключённая кнопка.
  if (at > 0) {
    const prev = el('a', undefined, `← ${shortName(phases[at - 1])}`)
    prev.href = `#${addressOf(phases[at - 1].id)}`
    steps.appendChild(prev)
  } else steps.appendChild(el('span'))
  if (at < phases.length - 1) {
    const next = el('a', undefined, `${shortName(phases[at + 1])} →`)
    next.href = `#${addressOf(phases[at + 1].id)}`
    steps.appendChild(next)
  }
  box.appendChild(steps)
  return box
}

function linkBlocks(panel, n) {
  const out = state.graph.edges.filter((e) => e.from === n.id && e.kind !== 'fired')
  const back = state.graph.edges.filter((e) => e.to === n.id && e.kind !== 'fired')
  if (out.length > 0) panel.appendChild(linkList('Ссылается на', out, true, `out:${n.id}`))
  if (back.length > 0) panel.appendChild(linkList('На него ссылаются', back, false, `in:${n.id}`))
}

function linkList(title, edges, outgoing, key) {
  const box = block(title)
  const ul = el('ul', 'links')
  const expanded = state.open.has(key)
  const shown = expanded ? edges : edges.slice(0, LIST_UPTO)
  for (const e of shown) {
    const li = el('li')
    li.appendChild(nodeLink(node(outgoing ? e.to : e.from), relation(e.kind, outgoing)))
    ul.appendChild(li)
  }
  box.appendChild(ul)
  if (edges.length > LIST_UPTO) {
    // Кнопка со счётчиком честнее треугольника: она называет, сколько скрыто.
    const more = el('button', undefined, expanded ? 'Свернуть' : `Показать все ${edges.length}`)
    more.type = 'button'
    more.setAttribute('aria-expanded', String(expanded))
    more.addEventListener('click', () => {
      if (expanded) state.open.delete(key)
      else state.open.add(key)
      renderPanel()
    })
    box.appendChild(more)
  }
  return box
}

// ── Следы в записях ────────────────────────────────────────────────────

function tracesBlock(role) {
  const box = block()
  const head = el('div', 'panel-head')
  head.append(el('h3', undefined, 'Следы в записях'))
  const mine = state.stats.fired.filter((e) => e.from === role.id)
  head.appendChild(el('p', 'counter', traceCounter(mine)))
  box.append(head, el('p', 'trace-note', 'имя роли рядом с признаком гейта'))

  if (mine.length === 0) {
    box.appendChild(el('p', 'empty', 'Следов нет: имя этой роли ни разу не встретилось в записях рядом с признаком гейта. Роль работает — просто записи описывают её работу другими словами.'))
    return box
  }

  const p = el('p', 'trace-note')
  p.append(
    'Правило ищет в записях истории имя роли рядом со словом-признаком — вето, блокирующая, находка, правки, переделать — в одной фразе. Оно видит, что роль названа рядом с признаком, но не знает, вынесено вето или снято: среди следов ниже есть и «его зона вето», и «вето снято решением владельца». Счётчик поэтому считает следы, а не события, а ',
    el('code', 'mono', 'reviewer'),
    ' и ',
    el('code', 'mono', 'design-review'),
    ' занижены — записи часто зовут их «ревью кода» и «правки по дизайну», без имени роли.',
  )
  box.appendChild(p)

  // Записи от новых к старым, внутри записи — по номеру строки: вопрос
  // посетителя «это ещё работает?», и свежий след отвечает на него лучше.
  const sorted = [...mine].sort((a, b) => node(b.to).date.localeCompare(node(a.to).date) || node(b.to).key.localeCompare(node(a.to).key) || a.line - b.line)
  const ul = el('ul', 'traces')
  for (const e of sorted) ul.appendChild(traceCard(e))
  box.appendChild(ul)
  return box
}

function traceCard(e) {
  const record = node(e.to)
  const li = el('li')
  const card = el('div', 'trace')

  const head = el('div', 'trace-head')
  const where = el('span')
  where.append(`${dayMonth(record.date)} · `)
  const about = state.graph.edges.find((x) => x.from === record.id && x.kind === 'about')
  // Три следа к дню не привязаны — тогда дня в строке просто нет.
  if (about) where.append(`${node(about.to).key} · `)
  const key = el('a', 'plain', record.key)
  key.href = `#${addressOf(record.id)}`
  where.append(key, ` : ${e.line}`)
  const gh = el('a', 'plain', '↗')
  gh.href = ghLink(record.file, e.line)
  gh.setAttribute('aria-label', `Строка ${e.line} записи ${record.key} на GitHub`)
  head.append(where, gh)
  card.appendChild(head)

  const key2 = `trace:${e.from}:${e.to}:${e.line}`
  const expanded = state.open.has(key2)
  const { end, hidden } = foldExcerpt(e.excerpt, e.marks)
  const to = expanded ? e.excerpt.length : end
  card.appendChild(excerptNode(e.excerpt, to, e.marks))

  if (hidden > 0) {
    // Многоточие в месте свёртки не ставится: `…` — знак снятого предела
    // длины, и возвращать его значило бы возвращать сигнал обрыва.
    const more = el('button', undefined, expanded ? 'Свернуть' : `Показать фразу целиком (ещё ${count(hidden, 'знак', 'знака', 'знаков')})`)
    more.type = 'button'
    more.setAttribute('aria-expanded', String(expanded))
    more.addEventListener('click', () => {
      if (expanded) state.open.delete(key2)
      else state.open.add(key2)
      renderPanel()
    })
    card.appendChild(more)
  }

  card.appendChild(
    el('p', 'trace-note', e.marks ? 'Подчёркнуто то, что нашло правило: имя роли и признак.' : 'Совпавший фрагмент не отмечен в этой сборке.'),
  )
  li.appendChild(card)
  return li
}

function runNode(run) {
  let leaf = document.createTextNode(run.text)
  if (run.code) {
    const code = el('code')
    code.appendChild(leaf)
    leaf = code
  }
  if (run.strong) {
    const strong = el('strong')
    strong.appendChild(leaf)
    leaf = strong
  }
  if (run.mark || run.mut) {
    const span = el('span', run.mark ? 'hit' : 'mut')
    span.appendChild(leaf)
    leaf = span
  }
  return leaf
}

/**
 * Выдержка следа. Порядок обработки обязателен: метки и сегменты уже
 * посчитаны по сырой строке, здесь только разметка и разбивка на ячейки.
 * Строка таблицы рисуется целой строкой, но `|` не показывается символом.
 */
function excerptNode(excerpt, to, marks) {
  const p = el('p', 'excerpt')
  if (isTableRow(excerpt)) {
    const row = el('span', 'row')
    for (const cell of tableCells(excerpt)) {
      const span = el('span', 'cell')
      for (const run of excerptRuns(excerpt, cell.start, cell.end, marks)) span.appendChild(runNode(run))
      row.appendChild(span)
    }
    p.appendChild(row)
    return p
  }
  for (const run of excerptRuns(excerpt, 0, to, marks)) p.appendChild(runNode(run))
  return p
}

// ── Подвал ─────────────────────────────────────────────────────────────

function renderFooter() {
  const foot = clear($('footer'))
  const prov = state.graph.provenance
  const first = el('p')
  if (prov?.sha) {
    first.textContent = `Схема собрана из репозитория на коммит ${prov.sha.slice(0, 7)}${prov.date ? ` от ${prov.date}` : ''}${prov.dirty ? ' с несохранёнными правками рабочего дерева' : ''}.`
  } else {
    // Выдуманной даты здесь нет: сборка не отдала коммит — так и сказано.
    first.textContent = 'Схема собрана из ветки main.'
  }
  const second = el('p', undefined, 'Источник истины — git; здесь копия только для чтения.')
  const links = el('p')
  const repo = el('a', 'plain', 'Репозиторий')
  repo.href = REPO
  const adr = el('a', 'plain', 'Как это устроено (ADR 2026-09-13-2000)')
  adr.href = ATLAS_ADR
  links.append(repo, ' · ', adr)
  foot.append(first, second, links)
}

// ── Состояния и события ────────────────────────────────────────────────

function announce(text) {
  $('live').textContent = text
}

function refresh(animate) {
  computeView()
  $('view-line').textContent = state.view.line
  $('map-title').textContent = state.view.line
  renderTools()
  renderNodeList()
  renderPanel()
  reframe(animate)
}

function select(id, fromHash) {
  state.missing = null
  state.selected = id
  state.open.clear()
  if (!fromHash) {
    // replaceState, а не pushState: иначе «Назад» отматывает по одному узлу
    // через двадцать шагов блуждания и никогда не выводит с витрины.
    history.replaceState(null, '', id ? `#${addressOf(id)}` : location.pathname + location.search)
  }
  refresh(true)
  if (id) {
    $('panel').scrollTop = 0
    announce(`Выбран узел: ${node(id).title}, ${TYPE_NAME[node(id).type].toLowerCase()}. Вид: ${state.view.line}`)
  } else announce(`Вид: ${state.view.line}`)
}

function fromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''))
  if (raw === '' || raw === 'panel') {
    state.missing = null
    state.selected = null
    refresh(false)
    return
  }
  const id = state.addresses.get(raw)
  if (id) {
    select(id, true)
    return
  }
  // Ссылки на витрину живут дольше сборок: адрес обязан сказать это словами.
  state.missing = raw
  state.selected = null
  refresh(false)
}

function setStatus(status, reason) {
  state.status = status
  state.reason = reason ?? ''
  const msg = clear($('canvas-msg'))
  const act = clear($('canvas-act'))
  act.hidden = true
  $('q').disabled = status !== 'ready'
  $('q-note').textContent =
    status === 'ready'
      ? 'Ищет по заголовку и короткому имени, не по тексту документов'
      : status === 'error'
        ? 'Схема не загрузилась — искать не по чему'
        : 'Схема ещё грузится'
  if (status === 'loading') msg.textContent = 'Читаю схему проекта…'
  if (status === 'error') {
    msg.className = 'canvas-msg canvas-err'
    msg.textContent = `Схему не удалось загрузить. ${state.reason}`
    const again = el('button', undefined, 'Попробовать снова')
    again.type = 'button'
    again.addEventListener('click', load)
    const repo = el('a', 'plain', 'Открыть репозиторий')
    repo.href = REPO
    act.append(again, repo)
    act.hidden = false
  }
  if (status === 'ready') msg.className = 'canvas-msg'
  renderPanel()
}

async function load() {
  setStatus('loading')
  try {
    // Относительный путь: страница едет под handle_path /atlas/*.
    const res = await fetch('graph.json', { cache: 'no-cache' })
    if (!res.ok) throw new Error(`ответ ${res.status}`)
    const graph = await res.json()
    state.graph = graph
    state.index = indexGraph(graph)
    state.addresses = addressTable(graph.nodes)
    state.stats = statsOf(graph)
    setStatus('ready')
    renderLede()
    renderFooter()
    fromHash()
    if (!state.selected) announce(`Вид: ${state.view.line}`)
  } catch (err) {
    setStatus('error', String(err.message ?? err))
  }
}

function wire() {
  readColors()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readColors()
    paint()
  })

  wireCanvas($('canvas'))
  wireCanvas($('map-canvas'))

  $('zoom-in').addEventListener('click', () => zoom(1.25))
  $('zoom-out').addEventListener('click', () => zoom(0.8))
  $('view-reset').addEventListener('click', () => reframe(false))
  $('map-zoom-in').addEventListener('click', () => zoom(1.25))
  $('map-zoom-out').addEventListener('click', () => zoom(0.8))
  $('map-reset').addEventListener('click', () => reframe(false))

  const map = $('map')
  $('map-open').addEventListener('click', () => {
    map.showModal()
    // Пересчёт вида, а не только камеры: цепь фаз идёт сверху вниз или слева
    // направо по пропорциям того поля, в котором она рисуется.
    refresh(false)
  })
  $('map-close').addEventListener('click', () => map.close())
  // Esc обрабатывает браузер: фокус захвачен, возврат на кнопку «Карта» — тоже.
  map.addEventListener('close', () => {
    $('map-open').focus()
    refresh(false)
  })

  $('q').addEventListener('input', renderSearch)
  $('q').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    if ($('q').value !== '') {
      $('q').value = ''
      renderSearch()
    } else $('view-reset').focus()
  })

  for (const radio of document.querySelectorAll('input[name="depth"]')) {
    radio.addEventListener('change', () => {
      state.depth = Number(radio.value)
      refresh(true)
    })
  }
  $('full').addEventListener('change', () => {
    state.full = $('full').checked
    refresh(true)
  })
  $('filters-reset').addEventListener('click', () => {
    state.hidden.clear()
    refresh(false)
  })

  addEventListener('hashchange', fromHash)
  addEventListener('resize', () => refresh(false))

  // Единственная клавиатурная сокращённая команда, кроме поиска и Esc, — и
  // только там, где у стрелок очевидный смысл.
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (!state.selected || node(state.selected).type !== 'phase') return
    const phases = state.graph.nodes.filter((n) => n.type === 'phase').sort((a, b) => a.n - b.n)
    const at = phases.findIndex((p) => p.id === state.selected)
    const next = phases[at + (ev.key === 'ArrowLeft' ? -1 : 1)]
    if (next) select(next.id)
  })

  // На широком экране «Фильтры и вид» — не свёрнутый блок, а сама колонка.
  const wide = matchMedia('(min-width: 73rem)')
  const setTools = () => {
    $('tools').open = wide.matches
  }
  wide.addEventListener('change', setTools)
  setTools()
}

if (typeof document !== 'undefined') {
  wire()
  load()
}
