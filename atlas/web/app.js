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
/**
 * Заголовок для панели: без машинного префикса `[2026-09-13 18:00]`, которым
 * начинаются ADR и записи истории. Дата уже стоит в строке меты, и повторять
 * её в виде штампа незачем.
 */
export const plainTitle = (node) => node.title.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/, '')

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

// Полнотекстовый поиск — agent_docs/design/2026-09-14-2300-atlas-3d-fullgraph-search.md,
// раздел 4. Заголовки, ключ и короткое имя ищутся с первого знака, текст
// документа и текстовые поля узла — с третьего.

/** С какого знака запроса ищется текст: два знака подсвечивали бы две трети графа. */
export const TEXT_FROM = 3

/**
 * Сравнение без регистра и с «ё» = «е»: в документах пишется «объём», а
 * набирают «объем». Длина строки сохраняется, поэтому позиция совпадения в
 * сложенной строке — позиция в исходной, и отрывок режется по исходной.
 */
export function fold(s) {
  const low = s.toLowerCase()
  const same =
    low.length === s.length
      ? low
      : [...s].map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join('')
  return same.replaceAll('ё', 'е')
}

/** Текстовые поля узла, которые уже есть в `graph.json` и ищутся как текст. */
const TEXT_FIELDS = {
  invariant: ['text'],
  role: ['description', 'owns', 'never'],
  skill: ['description'],
  phase: ['exit'],
  class: ['what', 'note'],
  external: ['note'],
}

const prep = (raw) => {
  const text = raw.replace(/\s+/g, ' ').trim()
  return { raw: text, norm: fold(text) }
}

/**
 * Индекс поиска в порядке узлов графа. Тексты берутся только для узлов этой
 * сборки: идентификатор, которого в графе нет (выкатка между двумя
 * запросами), пропускается, а узел без текста ищется по заголовку и полям.
 * @param {object} texts идентификатор узла → строка текста; `{}` — текстов нет
 */
export function buildSearch(nodes, texts) {
  return nodes.map((node, order) => {
    const bodies = []
    const own = Object.hasOwn(texts, node.id) ? texts[node.id] : undefined
    if (typeof own === 'string' && own !== '') bodies.push(prep(own))
    for (const field of TEXT_FIELDS[node.type] ?? []) if (typeof node[field] === 'string' && node[field] !== '') bodies.push(prep(node[field]))
    return { node, order, head: fold(`${node.title} ${node.key} ${shortName(node)}`), title: prep(plainTitle(node)), bodies }
  })
}

function occurrences(norm, q) {
  const at = []
  for (let i = norm.indexOf(q); i !== -1; i = norm.indexOf(q, i + q.length)) at.push(i)
  return at
}

/** Кусок строки, разложенный на отрезки: совпадение — `hit`. */
function markRuns(raw, norm, q, from, to) {
  const runs = []
  let i = from
  for (const at of occurrences(norm.slice(from, to), q)) {
    if (from + at > i) runs.push({ text: raw.slice(i, from + at), hit: false })
    runs.push({ text: raw.slice(from + at, from + at + q.length), hit: true })
    i = from + at + q.length
  }
  if (i < to) runs.push({ text: raw.slice(i, to), hit: false })
  return runs
}

/** До 40 знаков до совпадения и до 80 после, края — по границе слова. */
const BEFORE = 40
const AFTER = 80

/**
 * Отрывок вокруг первого совпадения. Многоточие — только там, где текст
 * обрезан: это отрывок документа, а не выдержка следа, у которой обрезание
 * запрещено.
 */
function snippetOf({ raw, norm }, q, at) {
  let from = at - BEFORE
  if (from <= 0) from = 0
  else {
    const space = raw.indexOf(' ', from - 1)
    from = space !== -1 && space < at ? space + 1 : at
  }
  let to = at + q.length + AFTER
  if (to >= raw.length) to = raw.length
  else {
    const space = raw.lastIndexOf(' ', to)
    to = space >= at + q.length ? space : at + q.length
  }
  const runs = markRuns(raw, norm, q, from, to)
  if (from > 0) runs.unshift({ text: '…', hit: false })
  if (to < raw.length) runs.push({ text: '…', hit: false })
  return runs
}

/**
 * Поиск: сначала совпавшие по заголовку, ключу или имени — в порядке графа;
 * затем совпавшие только по тексту — по числу вхождений от большего, при
 * равенстве — в порядке графа. `found` — все найденные, `hits` — первые
 * `limit` с отрывком.
 * @returns {{hits:Array<{node:object, where:'title'|'text', snippet:Array<{text:string, hit:boolean}>}>, total:number, found:Set<string>, short:boolean}}
 */
export function searchAtlas(index, query, limit) {
  const q = fold(query.replace(/\s+/g, ' ').trim())
  const short = q.length < TEXT_FROM
  if (q === '') return { hits: [], total: 0, found: new Set(), short }
  const titled = []
  const texted = []
  for (const entry of index) {
    if (entry.head.includes(q)) {
      titled.push({ entry, where: 'title' })
      continue
    }
    if (short) continue
    let count = 0
    let first = null
    for (const body of entry.bodies) {
      const at = occurrences(body.norm, q)
      if (at.length > 0 && first === null) first = { body, at: at[0] }
      count += at.length
    }
    if (count > 0) texted.push({ entry, where: 'text', count, first })
  }
  texted.sort((a, b) => b.count - a.count || a.entry.order - b.entry.order)
  const all = [...titled, ...texted]
  const hits = all.slice(0, limit).map(({ entry, where, first }) => ({
    node: entry.node,
    where,
    snippet:
      where === 'title'
        ? markRuns(entry.title.raw, entry.title.norm, q, 0, entry.title.raw.length)
        : snippetOf(first.body, q, first.at),
  }))
  return { hits, total: all.length, found: new Set(all.map(({ entry }) => entry.node.id)), short }
}

/** Подсказка под полем поиска по состоянию `texts.json`. */
export function textsNote(texts) {
  if (texts === 'loading') return 'Тексты документов ещё грузятся — пока ищу только в заголовках'
  if (texts === 'error') return 'Тексты документов не загрузились — ищу только в заголовках'
  return 'Ищет в заголовках сразу, в тексте документов — от трёх знаков'
}

/** Пустая выдача называет причину, а не только факт. */
export function emptyNote({ texts, short }) {
  if (short) return 'В заголовках ничего нет. По тексту документов ищу от трёх знаков.'
  if (texts === 'ready') return 'Ничего не нашлось ни в заголовках, ни в тексте документов.'
  if (texts === 'error') return 'В заголовках ничего нет, а тексты документов не загрузились.'
  return 'В заголовках ничего нет. Тексты документов ещё грузятся — выдача обновится сама.'
}

/** Подпись под выдачей: объяснение кольца и ответ на «где остальные». */
export const moreNote = (total, shown) =>
  total > shown ? `Ещё ${total - shown} — выделены кольцом на схеме и в списке узлов.` : 'Все найденные выделены кольцом на схеме и в списке узлов.'

/**
 * Объявление исхода загрузки текстов. Успех с первой попытки молчит: выдача
 * обновилась на месте. Номер попытки делает повторный отказ новым текстом.
 */
export function textsOutcome({ ok, attempt }) {
  if (ok) return attempt > 1 ? 'Тексты документов загружены — поиск идёт и по тексту.' : null
  const say = 'тексты документов не загрузились — поиск идёт только по заголовкам.'
  return attempt > 1 ? `Попытка ${attempt}: ${say}` : `Т${say.slice(1)}`
}

/**
 * Выделение на канве — таблица «Сочетание выбора и поиска». `sel` — выбранный
 * узел, если он виден; `near` — его соседи; `found` — видимые найденные.
 * Выбор и поиск складываются. Выбранный и найденный получает только кольцо
 * `--acc`: состояние выбора важнее.
 */
export function highlight({ sel, near, found }) {
  const lit = new Set(found)
  if (sel !== null) {
    lit.add(sel)
    for (const id of near ?? []) lit.add(id)
  }
  const rings = new Set([...found].filter((id) => id !== sel))
  return { on: sel !== null || found.size > 0, lit, rings }
}

/**
 * Прокрутка списка к выбранному: верх строки — на `round(H/3)` от верха
 * видимой области, в пределах `0 … scrollHeight − H`.
 * @param {{top:number, height:number, scrollHeight:number}} at `top` — верх строки в координатах содержимого области
 */
export const listScrollTop = ({ top, height, scrollHeight }) =>
  Math.min(Math.max(0, scrollHeight - height), Math.max(0, top - Math.round(height / 3)))

/** Высота коробки подписи и зазор от узла — из шага сетки. */
export const LABEL_H = 16
const GAP = 8

/**
 * Позиции подписи относительно узла. Первая — «под узлом, по центру»
 * (раскладка, «Подписи»); остальные пробуются, только когда первая занята или
 * не помещается на канве. Одна позиция на узел означала бы, что подпись
 * пропадает при первом же соседе — а требование раскладки в видах до 40 узлов
 * противоположное: подписи не прячутся.
 */
const ROWS = [1, 2, 3, 4]
const ALIGN = ['', '-start', '-end']

/**
 * Позиции подписи, от лучшей к худшей. Первая — «под узлом, по центру»
 * (раскладка, «Подписи»); дальше тот же ряд над узлом, сбоку, прижатый краем
 * к узлу, и то же вторым и третьим рядом. Одна позиция на узел означала бы,
 * что подпись пропадает при первом же соседе, — а требование в видах до 40
 * узлов противоположное: подписи не прячутся.
 *
 * `-start` и `-end` прижимают подпись краем к узлу: только так подписывается
 * узел у самой границы канвы, чья подпись шире оставшегося поля.
 */
export const SLOTS = [
  'below',
  'above',
  'right',
  'left',
  ...ROWS.flatMap((row) =>
    ALIGN.flatMap((align) => (row === 1 && align === '' ? [] : [`below${row === 1 ? '' : row}${align}`, `above${row === 1 ? '' : row}${align}`])),
  ),
]

/**
 * Позиция первого ряда касается своего узла: между ними только зазор. Номер
 * ряда в имени позиции есть у всех рядов, начиная со второго.
 */
const adjacent = (slot) => !/\d/.test(slot)

function boxAt(slot, p, width) {
  const full = width + 4
  if (slot === 'right') return { x1: p.x + GAP + 2, y1: p.y - LABEL_H / 2 }
  if (slot === 'left') return { x1: p.x - GAP - 2 - full, y1: p.y - LABEL_H / 2 }
  const up = slot.startsWith('above')
  const row = Number(/^(?:below|above)(\d)?/.exec(slot)[1] ?? 1)
  const y1 = up ? p.y - GAP - row * LABEL_H - (row - 1) * 2 : p.y + GAP + (row - 1) * (LABEL_H + 2)
  if (slot.endsWith('-start')) return { x1: p.x - GAP, y1 }
  if (slot.endsWith('-end')) return { x1: p.x + GAP - full, y1 }
  return { x1: p.x - full / 2, y1 }
}

/**
 * Расстановка подписей: узлы в порядке важности занимают первую свободную из
 * своих позиций. Подпись, которой не хватило места ни в одной, не рисуется —
 * но с двенадцатью позициями это остаток, а не правило.
 *
 * Внутри одного ранга порядок — по тесноте: первым встаёт узел, у которого
 * свободных позиций осталось меньше всех. Порядок по идентификатору в плотном
 * кусте отдавал единственную позицию одного узла соседу, у которого были
 * другие. Если подписи всё равно негде встать, её единственную помеху того же
 * ранга можно переставить на другую свою позицию. Более важную подпись не
 * двигает никто: выбранному узлу остаётся «под узлом».
 *
 * Чистая функция: измеритель приходит снаружи, поэтому расстановку можно
 * посчитать и проверить без канвы, а страница и замер считают её одинаково.
 *
 * @param {Array<{id:string, x:number, y:number, text:string, rank:number, slots?:string[]}>} items
 * @param {{width:number, height:number}} field
 * @param {(text:string)=>number} measure ширина текста в пикселях
 * @returns {Map<string,{x:number, y:number, width:number}>} левый верхний угол коробки
 */
export function placeLabels(items, field, measure) {
  const inside = (b) => b.x1 >= 2 && b.x2 <= field.width - 2 && b.y1 >= 2 && b.y2 <= field.height - 2

  /** Расстояние от точки до прямоугольника: ноль, если точка внутри. */
  const reach = (p, b) =>
    Math.hypot(Math.max(b.x1 - p.x, 0, p.x - b.x2), Math.max(b.y1 - p.y, 0, p.y - b.y2))

  /**
   * К своему узлу подпись обязана быть ближе, чем к любому чужому: иначе
   * дальняя позиция подпишет соседа, а подпись не на своём узле хуже
   * отсутствия подписи — она не молчит, она врёт. Меряется до коробки, а не
   * до её середины: подпись привязана краем, и «под узлом» — это восемь
   * пикселей, сколько бы места ни занимала сама надпись. Равенство — не
   * помеха: в цепи роль стоит на одной высоте со своей фазой, и подпись под
   * фазой ровно так же отстоит от обеих, а читается по столбцу.
   *
   * Для первого ряда — только «не накрывает чужой узел»: подпись там
   * примыкает к своему узлу, и примыкание сильнее близости. Соседство в
   * шести пикселях не делает подпись чужой, а вот надпись поверх чужого
   * узла делает.
   */
  const owned = (item, box, strict) => {
    const mine = reach(item, box)
    return items.every((other) => other === item || reach(other, box) >= (strict ? mine : 1))
  }

  // Позиции, доступные узлу вообще: в поле и у своего узла. От соседних
  // подписей это не зависит, поэтому считается один раз, в порядке `slots`.
  const options = new Map(
    items.map((item) => {
      const width = measure(item.text)
      const own = []
      for (const slot of item.slots ?? SLOTS) {
        const at = boxAt(slot, item, width)
        const box = { x1: at.x1, y1: at.y1, x2: at.x1 + width + 4, y2: at.y1 + LABEL_H, width }
        if (inside(box) && owned(item, box, !adjacent(slot))) own.push(box)
      }
      return [item.id, own]
    }),
  )
  const rankOf = new Map(items.map((item) => [item.id, item.rank]))
  const taken = new Map()
  const cross = (a, b) => !(b.x2 <= a.x1 || b.x1 >= a.x2 || b.y2 <= a.y1 || b.y1 >= a.y2)
  const freeOf = (box, skip) => {
    for (const [id, o] of taken) if (id !== skip && cross(box, o)) return false
    return true
  }
  const free = (item) => options.get(item.id).filter((box) => freeOf(box))

  /** Позиция, освобождённая перестановкой единственной помехи того же ранга. */
  const yielded = (item) => {
    for (const box of options.get(item.id)) {
      const hits = [...taken].filter(([, o]) => cross(box, o))
      if (hits.length !== 1 || rankOf.get(hits[0][0]) !== item.rank) continue
      const [other] = hits[0]
      const moved = options.get(other).find((o) => !cross(box, o) && freeOf(o, other))
      if (!moved) continue
      taken.set(other, moved)
      return box
    }
    return undefined
  }

  // Равная теснота — по идентификатору побайтно, а не через `localeCompare`:
  // тот зависит от локали и версии ICU, и «ноль пропущенных» перестал бы быть
  // воспроизводимым числом.
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const rank of [...new Set(items.map((item) => item.rank))].sort((a, b) => a - b)) {
    const left = items.filter((item) => item.rank === rank).sort(byId)
    while (left.length > 0) {
      const room = left.map(free)
      const next = room.reduce((best, boxes, k) => (boxes.length < room[best].length ? k : best), 0)
      const [item] = left.splice(next, 1)
      const box = room[next][0] ?? yielded(item)
      if (box) taken.set(item.id, box)
    }
  }
  return new Map([...taken].map(([id, box]) => [id, { x: box.x1, y: box.y1, width: box.width }]))
}

/**
 * Числа экрана — из графа, а не из разметки: граф растёт с каждым документом,
 * и витрина с вбитым числом начинает врать на следующем же мерже.
 */
export function statsOf(graph, near) {
  const byType = {}
  for (const n of graph.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1
  const fired = graph.edges.filter((e) => e.kind === 'fired')
  const roles = graph.nodes.filter((n) => n.type === 'role')
  const traced = new Set(fired.map((e) => e.from))
  const alone = graph.nodes.filter((n) => near.get(n.id).size === 0)
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
  }
}

const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`)

/** Кратные рёбра между одной парой рисуются одной линией. Перечисляет их панель. */
export function dedupe(edges) {
  const seen = new Set()
  return edges.filter((e) => {
    const key = pairKey(e.from, e.to)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Строка полосы вида — тот же текст, что уходит скринридеру. Один источник
 * фактов, два способа его получить.
 */
export function viewLine({ ids, links, hidden, selected, byId, near, found, volume }) {
  if (ids.size === 0) return 'Ни одного узла: скрыты все типы'
  // «· объём» — последним сегментом и только в объёме. Одиночный узел
  // повернуть можно, увидеть — нет.
  const tail = !volume ? '' : ids.size === 1 ? ' · объём: вращать нечего' : ' · объём'
  // Вид один — весь граф, поэтому строка называет, что на нём выделено.
  let pick = null
  if (selected) {
    const name = shortName(byId.get(selected))
    const k = [...(near.get(selected) ?? [])].filter((id) => ids.has(id)).length
    if (!ids.has(selected)) pick = `${name} скрыт фильтром`
    else if ((near.get(selected)?.size ?? 0) === 0) pick = `Выделен ${name}: у него нет связей`
    else if (k === 0) pick = `Выделен ${name}, соседи скрыты`
    else pick = `Выделены ${name} и ${count(k, 'сосед', 'соседа', 'соседей')}`
  }
  if (pick && found > 0) return `${pick}; найдено ${found}${tail}`
  if (pick) return `${pick}${tail}`
  if (found > 0) return `Найдено по запросу: ${found}${tail}`
  const sizes = `${count(ids.size, 'узел', 'узла', 'узлов')}, ${count(links.length, 'связь', 'связи', 'связей')}`
  return hidden === 0 ? `Весь граф: ${sizes}${tail}` : `Скрыто ${count(hidden, 'тип', 'типа', 'типов')}: ${sizes}${tail}`
}

// Путь посещений — agent_docs/design/2026-09-14-0900-atlas-visit-trail.md.
// Путь — идентификаторы узлов без корня: корень стоит первым всегда.

/**
 * Одно правило шага: узел уже есть в пути — всё после него отрезается; нет —
 * добавляется в конец. `null` — корень. Повторов в пути поэтому не бывает, и
 * длина ограничена числом узлов без искусственного предела.
 */
export function stepTrail(trail, id) {
  if (id === null) return []
  const at = trail.indexOf(id)
  return at === -1 ? [...trail, id] : trail.slice(0, at + 1)
}

/**
 * Путь при загрузке страницы. Адрес называет только узел; сохранённый путь
 * верится, лишь если кончается на нём, — иначе он чужой этому заходу.
 * Звенья, которых нет в этой сборке, выбрасываются: путь не притворяется
 * целым. `raw` — адрес без `#`; пустой или мёртвый — один корень.
 */
export function restoreTrail(saved, raw, addresses) {
  const id = addresses.get(raw)
  if (!id) return []
  const known = new Set(addresses.values())
  const kept = Array.isArray(saved) ? saved.filter((x) => known.has(x)) : []
  return kept[kept.length - 1] === id ? kept : [id]
}

/**
 * Сколько звеньев свернуть в «… ещё N». Звенья скрываются от старых к новым,
 * пока строка не встанет в `room`; корень, предыдущее и текущее не
 * скрываются никогда — не встают и они, строка переносится.
 * @param {number} root ширина корня
 * @param {number[]} links стоимость звеньев пути по порядку, с разделителем и зазором
 * @param {(n:number)=>number} more стоимость кнопки «… ещё n»
 * @returns {number} число скрытых звеньев — первых в пути
 */
export function foldTrail(root, links, more, room) {
  const sum = (from) => links.slice(from).reduce((a, b) => a + b, 0)
  if (root + sum(0) <= room) return 0
  const most = Math.max(0, links.length - 2)
  for (let n = 1; n < most; n += 1) if (root + more(n) + sum(n) <= room) return n
  return most
}

/** Ярлык кнопки свёртки: видимая часть и продолжение для скринридера. */
export function trailMore(n) {
  const shown = `… ещё ${n}`
  return { shown, rest: `${count(n, 'узел', 'узла', 'узлов').slice(String(n).length)} пути` }
}

// Режим «Объём» — agent_docs/design/2026-09-14-1200-atlas-3d-mode.md, ADR
// 2026-09-14-1000. Поза — два угла в градусах: рыскание `yaw` и тангаж
// `pitch`. Центр вращения — центр куба (0.5, 0.5, 0.5) для любого вида, и
// сдвиг к центру канвы делается только при вписывании, не в кадре вращения.

/** Поза при включении: наклон, а не ноль, — иначе флажок «не работает». */
export const POSE0 = Object.freeze({ yaw: 30, pitch: 20 })
/** Расстояние камеры — две стороны куба. */
export const CAM_D = 2
const RAD = Math.PI / 180

export const clampPitch = (deg) => Math.min(90, Math.max(-90, deg))

/**
 * Проекция точки: поворот вокруг центра куба и перспектива. Больший `z` —
 * дальше от камеры. Экранная точка до `fit`/`transform` — `(x, y)`.
 * @returns {{x:number, y:number, z:number, f:number}}
 */
export function project(p, pose) {
  const cy = Math.cos(pose.yaw * RAD)
  const sy = Math.sin(pose.yaw * RAD)
  const cp = Math.cos(pose.pitch * RAD)
  const sp = Math.sin(pose.pitch * RAD)
  const px = p.x - 0.5
  const py = p.y - 0.5
  const pz = p.z - 0.5
  const x1 = px * cy + pz * sy
  const z1 = -px * sy + pz * cy
  const y2 = py * cp - z1 * sp
  const z2 = py * sp + z1 * cp
  const f = CAM_D / (CAM_D + z2)
  return { x: x1 * f, y: y2 * f, z: z2, f }
}

export const projectAll = (pts, pose) => new Map([...pts].map(([id, p]) => [id, project(p, pose)]))

/** 15 поз вокруг текущей: рыскание ±0, 30, 60, тангаж ±0, 20 с ограничением ±90°. */
export function envelopePoses(pose) {
  const out = []
  for (const dy of [-60, -30, 0, 30, 60]) {
    for (const dp of [-20, 0, 20]) out.push({ yaw: pose.yaw + dy, pitch: clampPitch(pose.pitch + dp) })
  }
  return out
}

/**
 * Точки вида во всех позах огибающей — вход `fit`: вписанный по ним вид
 * заранее оставляет место под умеренный поворот вокруг центра куба.
 */
export function envelopePoints(pts, pose) {
  const out = new Map()
  envelopePoses(pose).forEach((each, k) => {
    for (const [id, p] of projectAll(pts, each)) out.set(`${k} ${id}`, p)
  })
  return out
}

/** Радиус по глубине: 5·f в пределах 3…7 px; выбранный — 8 px на любой глубине. */
export const depthRadius = (f, selected = false) => (selected ? 8 : Math.min(7, Math.max(3, 5 * f)))

const bytewise = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Порядок отрисовки узлов: от дальних к ближним, при равной глубине — по
 * идентификатору побайтно; выбранный и наведённый — последними. Состояние
 * важнее расстояния: закрытый соседом выбранный прятал бы единственный акцент.
 * @param {Map<string,{z:number}>} screen
 */
export function drawOrder(screen, sel, hover) {
  const order = [...screen.keys()]
    .filter((id) => id !== sel && id !== hover)
    .sort((a, b) => screen.get(b).z - screen.get(a).z || bytewise(a, b))
  if (screen.has(sel)) order.push(sel)
  if (hover !== sel && screen.has(hover)) order.push(hover)
  return order
}

/**
 * Выбор щелчком. Указатель внутри нарисованного круга — выигрывает круг,
 * нарисованный последним: посетитель щёлкает то, что видит. Иначе —
 * ближайший центр в 10 px; при разнице меньше 0.5 px — ближний к камере.
 */
export function pickNode(screen, order, x, y) {
  let top = null
  const near = []
  for (const id of order) {
    const p = screen.get(id)
    const d = Math.hypot(p.x - x, p.y - y)
    if (d <= p.r) top = id
    if (d <= 10) near.push({ id, d, z: p.z })
  }
  if (top !== null) return top
  if (near.length === 0) return null
  const min = Math.min(...near.map((c) => c.d))
  const tied = near.filter((c) => c.d - min < 0.5).sort((a, b) => a.z - b.z || bytewise(a.id, b.id))
  return tied[0].id
}

/**
 * Подписи в объёме — та же `placeLabels`. Глубина только упорядочивает узлы
 * внутри их группы важности, ближние первыми, и в более важную группу не
 * поднимает. `placeLabels` при равной тесноте берёт узлы в порядке
 * идентификаторов, поэтому порядок по глубине приходит через них: ключ —
 * номер узла от ближнего к дальнему. Ранг и позиции остаются как есть.
 *
 * Гарантии «подпись есть у всех» в объёме нет, поэтому наведённый узел,
 * оставшийся без подписи, поднимается до ранга наведения (2) и расстановка
 * повторяется: под курсором всегда видно имя. Наведение на узел с подписью
 * ничего не переставляет.
 * @param {Map<string,number>} depth глубина `z` по идентификатору
 * @param {string|null} hover узел под курсором
 */
export function placeDepthLabels(items, field, measure, depth, hover = null) {
  const place = (list) => {
    const near = [...list].sort((a, b) => depth.get(a.id) - depth.get(b.id) || bytewise(a.id, b.id))
    const real = new Map()
    const keyed = near.map((item, i) => {
      const key = `${String(i).padStart(6, '0')} ${item.id}`
      real.set(key, item.id)
      return { ...item, id: key }
    })
    return new Map([...placeLabels(keyed, field, measure)].map(([key, box]) => [real.get(key), box]))
  }
  const still = place(items)
  const mine = items.find((item) => item.id === hover)
  if (!mine || still.has(hover) || mine.rank <= 2) return still
  return place(items.map((item) => (item === mine ? { ...item, rank: 2 } : item)))
}

/**
 * Смесь двух конечных картинок перехода плоский ⇄ объём: положения и радиусы.
 * При `t = 0` — ровно первая, при `t = 1` — ровно вторая. Глубина — у той,
 * у которой она есть: порядок отрисовки в переходе — объёмный.
 */
export function blend(a, b, t) {
  const out = new Map()
  for (const [id, q] of b) {
    const p = a.get(id) ?? q
    out.set(id, {
      x: p.x * (1 - t) + q.x * t,
      y: p.y * (1 - t) + q.y * t,
      r: p.r * (1 - t) + q.r * t,
      z: q.z ?? p.z ?? 0,
    })
  }
  return out
}

/**
 * Подсказка под канвой рядом с «Плоским видом» — по режиму и устройству
 * ввода. На полном графе подписей нет у большинства узлов при любом угле:
 * посетителю нужен способ узнать имя, а не предупреждение.
 */
export function flatHint(flat, fine) {
  if (fine) return flat ? 'Перетаскивание сдвигает; имя узла — под указателем' : 'Перетаскивание вращает, с Shift — сдвигает; имя узла — под указателем'
  return flat ? 'Палец сдвигает схему' : 'Палец вращает; к центру вернёт «Сбросить вид»'
}

// Фокус после шага — agent_docs/design/2026-09-14-1500-atlas-focus-after-step.md.

/**
 * Ставит ли шаг фокус на заголовок новой панели. Ссылка — всегда: панель —
 * результат шага. Стрелка фазы — только если перерисовка удалила элемент с
 * фокусом. Канва и карта — нет: это работа указателем, `Tab` продолжается от
 * канвы, а с карты фокус на «Карту» возвращает закрытие диалога.
 */
export const focusesPanel = (source, lost) => source === 'link' || (source === 'arrow' && lost)

/** Тип внутри фразы: строчной только первая буква — «решение — ADR». */
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1)

/**
 * Объявление выбора узла. Фокус на заголовке уже произнёс имя узла, поэтому
 * `#live` добавляет только тип — в `h2` его нет — и вид.
 */
export function selectNote({ title, type, line, focused, returned }) {
  if (focused) return `${type}. Вид: ${line}`
  const what = `${title}, ${lowerFirst(type)}. Вид: ${line}`
  return returned ? `Вернулись к узлу: ${what}` : `Выбран узел: ${what}`
}

// Сбой загрузки — agent_docs/design/2026-09-14-1730-atlas-load-error.md.

/**
 * Объявление исхода попытки — раздел «Объявления». `head` — заголовок блока
 * ошибки, при успехе его нет; `attempt` — номер попытки вместе с первой.
 * Номер делает текст повторного отказа новым: неизменный текст живая
 * область не произносит.
 */
export function outcomeNote({ head = null, reason = '', attempt = 1, line = '' }) {
  if (head === null) return attempt > 1 ? `Схема загружена. Вид: ${line}` : `Вид: ${line}`
  return attempt > 1 ? `Попытка ${attempt}: ${lowerFirst(head)}. ${reason}` : `${head}. ${reason}`
}

/**
 * «Попробовать снова» и строка под действиями — таблица «Повтор». До первого
 * нажатия строки нет; пока идёт попытка, кнопка `aria-disabled`, а не
 * `disabled`: браузер снимает фокус с недоступного элемента.
 */
export function retryPhase(status, attempt) {
  if (attempt < 2) return { busy: false, line: null }
  if (status === 'loading') return { busy: true, line: 'Читаю схему проекта…' }
  return { busy: false, line: `Попыток: ${attempt}` }
}

/** Кнопки и флажки, которые работают по графу: пока его нет, они `disabled`. */
export const GRAPH_BUTTONS = ['map-open', 'zoom-out', 'zoom-in', 'view-reset', 'flat', 'map-flat']
/** Блоки, чьё содержимое и есть граф: пока его нет, они скрыты. */
export const GRAPH_BLOCKS = ['tools', 'nodelist']

/**
 * Срок попытки загрузки схемы — раскладка
 * `design/2026-09-14-1930-atlas-load-timeout.md`. На `LOAD_HINT_MS` строка
 * «Читаю схему проекта…» дополняется подсказкой, на `LOAD_LIMIT_MS` попытка
 * кончается отказом. Число в текстах — из той же константы, между ним и «с»
 * неразрывный пробел.
 */
export const LOAD_HINT_MS = 8000
export const LOAD_LIMIT_MS = 30000
const LIMIT_TEXT = `${LOAD_LIMIT_MS / 1000}\u00a0с`
export const LOAD_HINT = `Читаю схему проекта… Это дольше обычного, жду не дольше ${LIMIT_TEXT}.`
export const LOAD_TIMEOUT = `Файл graph.json не пришёл за ${LIMIT_TEXT}: сервер не отвечает или сеть слишком медленная.`

/**
 * Одна попытка загрузки. У неё свой `AbortController`: сигнал действует и на
 * заголовки, и на чтение тела, так что срок закрывает запрос, и поздний ответ
 * странице не достаётся. Причину выбирает срок, а не имя ошибки: отмена
 * посреди тела приходит как `AbortError` и иначе стала бы «это не JSON».
 * Исход гасит оба таймера. `get` подменяется в тестах.
 */
export async function fetchGraph(onHint, get = fetch) {
  const ctl = new AbortController()
  let expired = false
  const hint = setTimeout(onHint, LOAD_HINT_MS)
  const limit = setTimeout(() => {
    expired = true
    ctl.abort()
  }, LOAD_LIMIT_MS)
  try {
    // Относительный путь: страница едет под handle_path /atlas/*.
    let res
    try {
      res = await get('graph.json', { cache: 'no-cache', signal: ctl.signal })
    } catch {
      throw new Error('Файл graph.json не получен: сети нет или адрес не отвечает.')
    }
    if (!res.ok) throw new Error(`На graph.json пришёл ответ ${res.status}.`)
    try {
      return await res.json()
    } catch {
      throw new Error('Файл graph.json получен, но это не JSON.')
    }
  } catch (err) {
    throw expired ? new Error(LOAD_TIMEOUT) : err
  } finally {
    clearTimeout(hint)
    clearTimeout(limit)
  }
}

/**
 * Тексты документов для поиска — `texts.json`, объект «идентификатор узла →
 * строка». Та же отмена по сроку, что у схемы, но без ступени 8 с: поиск по
 * заголовкам работает с первой миллисекунды, и страница не молчит. Причину
 * посетитель не читает — поле говорит «не загрузились», — поэтому отказ
 * один на все случаи. `get` подменяется в тестах.
 */
export async function fetchTexts(get = fetch) {
  const ctl = new AbortController()
  const limit = setTimeout(() => ctl.abort(), LOAD_LIMIT_MS)
  try {
    const res = await get('texts.json', { cache: 'no-cache', signal: ctl.signal })
    if (!res.ok) throw new Error(`На texts.json пришёл ответ ${res.status}.`)
    const json = await res.json()
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('texts.json — не объект.')
    return json
  } finally {
    clearTimeout(limit)
  }
}

// ───────────────────────────── отрисовка ─────────────────────────────

const REPO = 'https://github.com/mikekharr/ai-advent-2026'
const ATLAS_ADR = `${REPO}/blob/main/agent_docs/adr/2026-09-13-2000-project-atlas.md`
/** До скольких узлов подписи видны всегда. */
const LABELS_UPTO = 40
/** Строк в списке до свёртки и в выдаче поиска: результат с отрывком выше, и пять — это ≈ 430 px. */
const LIST_UPTO = 10
const SEARCH_UPTO = 5

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
  hidden: new Set(),
  hover: null,
  view: { ids: new Set(), edges: [], line: '' },
  /** Камера уже вписывала вид: выбор узла её не перевписывает. */
  framed: false,
  cam: { base: 1, cx: 0, cy: 0, scale: 1, panX: 0, panY: 0 },
  from: null,
  t0: 0,
  status: 'loading',
  reason: '',
  /** Заголовок блока ошибки и номер попытки загрузки вместе с первой. */
  head: '',
  attempt: 0,
  drawn: false,
  open: new Set(),
  /** Путь посещений без корня и признак развёрнутой свёртки. */
  trail: [],
  trailOpen: false,
  /**
   * Вид: объём по умолчанию, `flat` — флажок «Плоский вид». Поза посетителя,
   * смесь перехода плоский ⇄ объём и признак движения рукой — пока он есть,
   * подписи только у выбранного и наведённого.
   */
  flat: false,
  pose: { ...POSE0 },
  morph: null,
  turning: false,
  /**
   * Поиск: индекс, найденные по текущему запросу, состояние `texts.json`
   * (`idle` — не запрошены) и номер попытки его загрузки.
   */
  search: [],
  found: new Set(),
  texts: 'idle',
  textsData: null,
  textsAttempt: 0,
  /** Строки списка «Узлы в этом виде» и набор, по которому они собраны. */
  rows: new Map(),
  listKey: null,
}

const node = (id) => state.index.byId.get(id)
const famClass = (n) => `f-${familyOf(n.type)}`

/** Ссылка на узел: настоящая `a[href="#…"]`, а не `div` с обработчиком. */
function nodeLink(n, note) {
  const a = el('a', `node-link ${famClass(n)}`)
  a.href = `#${addressOf(n.id)}`
  const dot = el('span', 'dot')
  dot.setAttribute('aria-hidden', 'true')
  a.append(dot, el('span', 'name', shortName(n)))
  // Пустая подпись — не «нет типа», а «тип здесь не нужен»: в сводке следов
  // каждая строка и так роль, и слово «Роль» отняло бы место у счётчика.
  if (note !== '') a.appendChild(el('span', 'meta', note ?? TYPE_NAME[n.type]))
  if (n.id === state.selected) a.setAttribute('aria-current', 'true')
  return a
}

function ghLink(file, line) {
  const sha = state.graph.provenance?.sha || 'main'
  return `${REPO}/blob/${sha}/${file}${line ? `#L${line}` : ''}`
}

// ── Вид ────────────────────────────────────────────────────────────────

const mapOpen = () => $('map').open

/**
 * Вид один — весь граф; уменьшают его только фильтры типов. Фильтр убирает
 * узлы с канвы, но не влияет на панель: иначе он молча уводил бы посетителя
 * с узла, который он читает.
 */
function computeView() {
  const shown = new Set(state.graph.nodes.filter((n) => !state.hidden.has(n.type)).map((n) => n.id))
  const links = dedupe(state.graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to)))
  state.view = { ids: shown, edges: links, line: '' }
  state.view.line = lineNow()
}

/** Найденные поиском, которые сейчас на канве. */
const foundShown = () => new Set([...state.found].filter((id) => state.view.ids.has(id)))

function lineNow() {
  return viewLine({
    ids: state.view.ids,
    links: state.view.edges,
    hidden: state.hidden.size,
    selected: state.selected,
    byId: state.index.byId,
    near: state.index.near,
    found: foundShown().size,
    volume: volumeOn(),
  })
}

/** Строка вида — в полосе и в заголовке карты: тот же текст, что уходит скринридеру. */
function showLine() {
  $('view-line').textContent = state.view.line
  $('map-title').textContent = state.view.line
}

// ── Канва ──────────────────────────────────────────────────────────────

export const PAD = 32
const fieldOf = (canvas) => ({ width: canvas.clientWidth, height: canvas.clientHeight })
const TWEEN = 120
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const colors = {}

function readColors() {
  const css = getComputedStyle(document.documentElement)
  for (const key of ['fam-dec', 'fam-rul', 'fam-rec', 'fam-act', 'fam-sys', 'fg', 'acc', 'line', 'line-ctl', 'surface'])
    colors[key] = css.getPropertyValue(`--${key}`).trim()
}

/** Координаты приходят из сборки. */
function points() {
  const map = new Map()
  for (const id of state.view.ids) {
    const p = node(id)
    map.set(id, { x: p.x, y: p.y })
  }
  return map
}

const volumeOn = () => !state.flat

/** Узлы вида с координатами из сборки — `x`, `y`, `z`. */
const spatial = () => new Map([...state.view.ids].map((id) => [id, node(id)]))

/** Картинка объёма: экранная точка, радиус по глубине и глубина для порядка. */
function volumeScreen(at, sel) {
  const out = new Map()
  for (const [id, p] of projectAll(spatial(), state.pose)) {
    const s = at(p)
    out.set(id, { x: s.x, y: s.y, r: depthRadius(p.f, id === sel), z: p.z })
  }
  return out
}

/** Плоская картинка в той же форме — конец или начало смеси перехода. */
const flatScreen = (at, sel) =>
  new Map([...points()].map(([id, p]) => [id, { ...at(p), r: id === sel ? 8 : 5 }]))

/** Смесь перехода на этот кадр; `null` — перехода нет, и кадр рисует свой путь. */
function morphNow(at, sel) {
  if (!state.morph) return null
  const t = (performance.now() - state.morph.t0) / TWEEN
  if (t >= 1) {
    state.morph = null
    return null
  }
  return blend(state.morph.from, volumeOn() ? volumeScreen(at, sel) : flatScreen(at, sel), t)
}

export function fit(field, pts) {
  if (pts.size === 0) return { base: 1, cx: 0, cy: 0 }
  const xs = [...pts.values()].map((p) => p.x)
  const ys = [...pts.values()].map((p) => p.y)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  const base = Math.min(
    spanX > 0 ? (field.width - 2 * PAD) / spanX : Infinity,
    spanY > 0 ? (field.height - 2 * PAD) / spanY : Infinity,
  )
  return {
    base: Number.isFinite(base) ? base : 1,
    cx: (Math.max(...xs) + Math.min(...xs)) / 2,
    cy: (Math.max(...ys) + Math.min(...ys)) / 2,
  }
}

export const transform = (field, cam) => {
  const k = cam.base * cam.scale
  const w = field.width / 2
  const h = field.height / 2
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

const LABEL_FONT = '12px ui-sans-serif, system-ui, sans-serif'

/**
 * Порядок важности: выбранный узел, узел под курсором, соседи выбранного и
 * найденные поиском, остальные. Важному узлу достаётся позиция ближе к «под
 * узлом», остальным — из оставшихся.
 *
 * Узел под курсором поднимается, только когда подписи показаны не у всех
 * (`always` ложно). В виде до 40 узлов его подпись и так есть, а повышение
 * переставляло бы соседние: подписи прыгали бы от движения мыши.
 */
export const labelRank = ({ id, sel, near, hover, found, always }) =>
  id === sel ? 0 : id === hover && !always ? 2 : near?.has(id) || found?.has(id) ? 3 : 4

/** Не больше одной перерисовки за кадр: движения указателя копятся до кадра. */
let queued = false
function requestPaint() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    paint()
  })
}

/**
 * Перерисовка по событию, а не в цикле: статичная картинка не занимает
 * процессор. Подсветка — таблица «Сочетание выбора и поиска» раскладки:
 * выделенные в полном цвете, остальное приглушено, камера на месте.
 */
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
  const at = transform({ width: w, height: h }, cam)
  const sel = state.view.ids.has(state.selected) ? state.selected : null
  // Объёмный путь рисует и объём, и переход в обе стороны; последний кадр
  // выключения — уже плоский путь.
  const morph = morphNow(at, sel)
  const deep = morph !== null || volumeOn()
  const screen = morph ?? (deep ? volumeScreen(at, sel) : flatScreen(at, sel))
  const near = sel ? state.index.near.get(sel) : null
  const found = foundShown()
  const hl = highlight({ sel, near, found })

  // Порядок отрисовки — рёбра, узлы, подписи: подпись всегда поверх всего,
  // ребро никогда не поверх узла. Рёбра одного вида — одним путём: на полном
  // графе отдельный stroke на каждое ребро — сотни вызовов на кадр.
  const mine = []
  ctx.beginPath()
  for (const e of state.view.edges) {
    const a = screen.get(e.from)
    const b = screen.get(e.to)
    if (!a || !b) continue
    if (sel !== null && (e.from === sel || e.to === sel)) {
      mine.push(a, b)
      continue
    }
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  // Рёбра контекста при выделении — фон (`--line`): предмет выделенного вида —
  // связи выбранного, они цветом его семейства и словами в панели.
  ctx.strokeStyle = hl.on ? colors.line : colors['line-ctl']
  ctx.lineWidth = 1
  ctx.stroke()
  if (mine.length > 0) {
    ctx.beginPath()
    for (let k = 0; k < mine.length; k += 2) {
      ctx.moveTo(mine[k].x, mine[k].y)
      ctx.lineTo(mine[k + 1].x, mine[k + 1].y)
    }
    ctx.strokeStyle = colors[`fam-${familyOf(node(sel).type)}`]
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // В объёме — от дальних к ближним, выбранный и наведённый последними. В
  // плоском — контекст, затем выделенные, затем выбранный и наведённый.
  const rest = [...screen.keys()].filter((id) => id !== sel && id !== state.hover)
  const order = deep
    ? drawOrder(screen, sel, state.hover)
    : [
        ...rest.filter((id) => !hl.lit.has(id)),
        ...rest.filter((id) => hl.lit.has(id)),
        ...[sel, state.hover].filter((id, k, both) => id !== null && screen.has(id) && both.indexOf(id) === k),
      ]
  for (const id of order) {
    const p = screen.get(id)
    // Наведение меняет заливку, а не размер: подрастающий узел читается как
    // сбой. Приглушение — 0,7: при нём все пять семейств держат 3:1.
    ctx.globalAlpha = hl.on && !hl.lit.has(id) && id !== state.hover ? 0.7 : 1
    ctx.fillStyle = id === state.hover ? colors.fg : colors[`fam-${familyOf(node(id).type)}`]
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
    // Кольцо --acc — единственный акцентный элемент экрана; у найденных —
    // кольцо --fg тоньше.
    if (id !== sel && !hl.rings.has(id)) continue
    ctx.strokeStyle = id === sel ? colors.acc : colors.fg
    ctx.lineWidth = id === sel ? 2 : 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Подписи. В объёме в движении — только выбранного и наведённого:
  // расстановка квадратична и считается один раз, в покое.
  const moving = deep && (morph !== null || state.from !== null || state.turning)
  const always = state.view.ids.size <= LABELS_UPTO
  ctx.font = LABEL_FONT
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const items = []
  const depth = new Map()
  for (const [id, p] of screen) {
    const own = id === sel || id === state.hover
    if (!own && (moving || (!always && !hl.lit.has(id)))) continue
    const rank = labelRank({ id, sel, near, hover: state.hover, found, always })
    items.push({ id, x: p.x, y: p.y, text: shortName(node(id)), rank })
    depth.set(id, p.z ?? 0)
  }
  const field = { width: w, height: h }
  const measure = (text) => ctx.measureText(text).width
  const labels = deep ? placeDepthLabels(items, field, measure, depth, state.hover) : placeLabels(items, field, measure)
  for (const [id, box] of labels) {
    // Подложка в ширину текста плюс 2 px: без неё подпись на пересечении с
    // ребром нечитаема.
    ctx.fillStyle = colors.surface
    ctx.fillRect(box.x, box.y, box.width + 4, LABEL_H)
    ctx.fillStyle = colors.fg
    ctx.fillText(shortName(node(id)), box.x + 2, box.y + 2)
  }

  if (state.from || state.morph) requestPaint()
}

function reframe(animate) {
  const canvas = mapOpen() ? $('map-canvas') : $('canvas')
  if (!canvas || canvas.clientWidth === 0) return
  const before = { ...state.cam }
  // В объёме — по огибающей поворота вокруг текущей позы: место под дугу
  // отводится при смене вида, а не пересчитывается в кадре вращения.
  const pts = volumeOn() ? envelopePoints(spatial(), state.pose) : points()
  state.cam = { ...fit(fieldOf(canvas), pts), scale: 1, panX: 0, panY: 0 }
  state.from = animate && !reduceMotion() ? before : null
  state.t0 = performance.now()
  state.framed = true
  paint()
}

/**
 * Узел за краем канвы после «Крупнее», сдвига или поворота: камера сдвигается
 * так, чтобы он встал в центр, масштаб не меняется. Узел на канве камеру не
 * двигает — приближение посетителя остаётся.
 */
function bringIntoView(id) {
  const canvas = mapOpen() ? $('map-canvas') : $('canvas')
  if (!canvas || canvas.clientWidth === 0 || !state.view.ids.has(id)) return
  const field = fieldOf(canvas)
  const at = transform(field, state.cam)
  const p = volumeOn() ? at(project(node(id), state.pose)) : at(node(id))
  if (p.x >= 0 && p.x <= field.width && p.y >= 0 && p.y <= field.height) return
  const before = { ...camNow() }
  state.cam = { ...state.cam, panX: state.cam.panX + field.width / 2 - p.x, panY: state.cam.panY + field.height / 2 - p.y }
  state.from = reduceMotion() ? null : before
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
  const at = transform(fieldOf(canvas), camNow())
  if (volumeOn()) {
    const sel = state.view.ids.has(state.selected) ? state.selected : null
    const screen = volumeScreen(at, sel)
    return pickNode(screen, drawOrder(screen, sel, state.hover), x, y)
  }
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
  /** Конец движения рукой: подписи в покое расставляются один раз. */
  const settle = (ev) => {
    const was = state.turning
    state.turning = false
    // Касанию нечем «навестись» после отпускания: узел под пальцем был
    // наведённым только на время перетаскивания.
    if (volumeOn() && ev.pointerType !== 'mouse') state.hover = null
    if (was || volumeOn()) paint()
  }
  canvas.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, panX: state.cam.panX, panY: state.cam.panY, moved: false }
    // Режим перетаскивания фиксируется в момент нажатия: Shift посреди
    // движения его не переключает. Наведённый — тот, что под указателем.
    if (volumeOn()) {
      Object.assign(drag, { turn: !ev.shiftKey, yaw: state.pose.yaw, pitch: state.pose.pitch })
      state.hover = pick(canvas, ev)
    }
    canvas.setPointerCapture(ev.pointerId)
  })
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x
      const dy = ev.clientY - drag.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
      if (drag.turn) {
        // Ближняя к камере сторона идёт за указателем, 0.5° на пиксель.
        state.pose = { yaw: drag.yaw - 0.5 * dx, pitch: clampPitch(drag.pitch + 0.5 * dy) }
      } else {
        state.cam.panX = drag.panX + dx
        state.cam.panY = drag.panY + dy
      }
      if (drag.turn !== undefined && (dx !== 0 || dy !== 0)) state.turning = true
      requestPaint()
      return
    }
    const hit = pick(canvas, ev)
    // Курсор — на каждом движении, до выхода: иначе `move` из объёма
    // оставался бы над фоном плоского вида до первого узла.
    canvas.style.cursor = hit ? 'pointer' : volumeOn() && ev.shiftKey ? 'move' : 'grab'
    if (hit === state.hover) return
    state.hover = hit
    requestPaint()
  })
  canvas.addEventListener('pointerup', (ev) => {
    const moved = drag !== null && drag.moved
    drag = null
    settle(ev)
    if (!moved) {
      const hit = pick(canvas, ev)
      if (hit) {
        // Карта — выборщик: касание закрывает её, и шаг пишется в путь.
        const source = mapOpen() ? 'map' : 'canvas'
        if (source === 'map') $('map').close()
        go(hit, source)
      }
    }
  })
  canvas.addEventListener('pointercancel', (ev) => {
    drag = null
    settle(ev)
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

// ── Путь посещений ─────────────────────────────────────────────────────
// agent_docs/design/2026-09-14-0900-atlas-visit-trail.md. Путь хранится в
// sessionStorage вкладки и в адрес не пишется: ссылка на узел передаёт узел,
// а не чужой путь к нему.

const TRAIL_KEY = 'atlas-trail'

/** Хранилище может быть запрещено — тогда путь живёт в памяти страницы, молча. */
function readTrail() {
  try {
    return JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? '[]')
  } catch {
    return []
  }
}

function setTrail(trail) {
  state.trail = trail
  state.trailOpen = false
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail))
  } catch {
    // Молча, как и чтение: путь остаётся в памяти страницы.
  }
}

function trailItem(child, first) {
  const li = el('li')
  if (!first) {
    const sep = el('span', 'sep', '›')
    sep.setAttribute('aria-hidden', 'true')
    li.appendChild(sep)
  }
  li.appendChild(child)
  return li
}

/** Звено-ссылка. `data-trail` пустой у корня: возврат к нему — `select(null)`. */
function trailLink(text, href, id, title) {
  const a = el('a', undefined, text)
  a.setAttribute('href', href)
  a.dataset.trail = id
  if (title) a.title = title
  return a
}

/** Текущее звено — не ссылка: ссылка на место, где уже стоишь, ничего не делает. */
function trailHere(text) {
  const span = el('span', 'here', text)
  span.setAttribute('aria-current', 'page')
  span.tabIndex = -1
  return span
}

function fillMore(button, n) {
  if (n === null) {
    button.textContent = 'Свернуть путь'
    return
  }
  const { shown, rest } = trailMore(n)
  button.textContent = shown
  button.appendChild(el('span', 'vh', rest))
}

/**
 * Строка пути. Порядок, чтобы строка не мигала: звенья раскладываются в одну
 * строку без переноса, лишние скрываются от старых к новым, и только потом
 * ниже 73rem включается перенос. Всё — в одной задаче, до отрисовки.
 */
function renderTrail() {
  const nav = $('trail')
  nav.classList.remove('idle')
  const ol = clear($('trail-list'))
  // Корень называет место, куда ведёт: канва показывает весь граф всегда.
  const rootName = 'Весь граф'
  const atRoot = state.trail.length === 0 && !state.missing
  const rootLi = trailItem(atRoot ? trailHere(rootName) : trailLink(rootName, './', ''), true)
  ol.appendChild(rootLi)
  nav.classList.remove('open')
  if (atRoot) return

  const more = el('button')
  more.type = 'button'
  more.addEventListener('click', toggleTrail)
  more.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state.trailOpen) return
    ev.stopPropagation()
    toggleTrail()
  })
  const moreLi = trailItem(more)
  ol.appendChild(moreLi)

  const before = state.missing ? state.trail : state.trail.slice(0, -1)
  const linkLis = before.map((id) => {
    const n = node(id)
    return ol.appendChild(trailItem(trailLink(shortName(n), `#${addressOf(id)}`, id, plainTitle(n))))
  })
  const last = state.trail[state.trail.length - 1]
  const hereLi = ol.appendChild(trailItem(trailHere(state.missing ? 'Узла нет в этой сборке' : shortName(node(last)))))

  nav.classList.add('measure')
  const gap = Number.parseFloat(getComputedStyle(ol).columnGap) || 0
  const cost = (li) => li.getBoundingClientRect().width + gap
  const hidden = foldTrail(
    rootLi.getBoundingClientRect().width,
    [...linkLis, hereLi].map(cost),
    (n) => {
      fillMore(more, n)
      return cost(moreLi)
    },
    ol.clientWidth,
  )
  nav.classList.remove('measure')

  moreLi.hidden = hidden === 0
  if (hidden === 0) return
  more.setAttribute('aria-expanded', String(state.trailOpen))
  fillMore(more, state.trailOpen ? null : hidden)
  nav.classList.toggle('open', state.trailOpen)
  if (!state.trailOpen) for (const li of linkLis.slice(0, hidden)) li.hidden = true
}

/** Разворот и свёртка: фокус остаётся на кнопке, канва перевписывается под новую высоту. */
function toggleTrail() {
  state.trailOpen = !state.trailOpen
  renderTrail()
  $('trail-list').querySelector('button')?.focus()
  reframe(false)
}

/**
 * После шага посетителя путь встаёт у верхнего края окна, если он не виден
 * целиком: на узком экране он над поиском, а посетитель читает панель ниже.
 * Мгновенно — корпус ограничивает движение 120 мс.
 */
function showTrail() {
  const box = $('trail').getBoundingClientRect()
  if (box.top < 0 || box.bottom > innerHeight) $('trail').scrollIntoView({ block: 'start' })
}

/**
 * Узкий экран, фокус на заголовке панели. После прокрутки к пути заголовок
 * может остаться за нижним краем окна (над панелью раскрыт поиск) или под
 * липкой «Картой». Тогда верх панели встаёт на `--s-2` ниже полосы «Карта» —
 * это её собственный отступ снизу.
 */
function showPanelHead() {
  const bar = document.querySelector('.area-map')
  if (getComputedStyle(bar).display === 'none') return
  const head = $('panel-h').getBoundingClientRect()
  const strip = bar.getBoundingClientRect()
  if (head.top >= strip.bottom && head.bottom <= innerHeight) return
  scrollBy(0, $('panel').getBoundingClientRect().top - strip.height - Number.parseFloat(getComputedStyle(bar).paddingBottom))
}

/**
 * Шаг внутри витрины: `link` — ссылка списка, панели или поиска, `canvas`,
 * `map`, `arrow` — стрелка фазы. Источник решает, куда встаёт фокус.
 */
function go(id, source) {
  const was = document.activeElement
  setTrail(stepTrail(state.trail, id))
  select(id, false, false, { source, was })
  showTrail()
  if (document.activeElement === $('panel-h')) showPanelHead()
}

/** Возврат по звену, по корню или «К началу»: фокус — на текущее звено пути. */
function back(id) {
  setTrail(stepTrail(state.trail, id))
  select(id, false, true)
  $('trail-list').querySelector('.here')?.focus()
  showTrail()
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

/** Каждое изменение настройки вида объявляется ровно один раз. */
const announceView = () => announce(`Вид: ${state.view.line}`)

function renderTools() {
  const s = state.stats
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
      announceView()
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
        announceView()
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

/**
 * Область прокрутки списка: в трёх колонках — колонка фильтров и списка, в
 * остальных раскладках — сам список (`max-height: 60dvh`).
 */
const listArea = () => (matchMedia('(min-width: 100rem)').matches ? document.querySelector('.area-rest') : $('nodes'))

/**
 * Список «Узлы в этом виде» в постоянном порядке: по семействам, внутри — по
 * типу и заголовку. Пересобирается только при смене набора (фильтры), и
 * прокрутка при этом не меняется; выбор и поиск лишь переставляют отметки.
 */
function renderNodeList() {
  const key = `${state.attempt}|${[...state.hidden].sort().join(',')}`
  if (key !== state.listKey) {
    state.listKey = key
    const area = listArea()
    const keep = area.scrollTop
    const order = new Map(FAMILIES.map((f, i) => [f.key, i]))
    const ids = [...state.view.ids].sort((a, b) => {
      const na = node(a)
      const nb = node(b)
      return (
        order.get(familyOf(na.type)) - order.get(familyOf(nb.type)) ||
        // Порядок для чтения человеком, поэтому локаль задана явно у обоих
        // сравнений: без неё порядок зависит от локали среды и версии ICU —
        // ровно то, что убрано из расстановки подписей.
        na.type.localeCompare(nb.type, 'ru') ||
        na.title.localeCompare(nb.title, 'ru')
      )
    })
    $('nodelist-h').textContent = `Узлы в этом виде: ${ids.length}`
    const ul = clear($('nodes'))
    state.rows = new Map()
    if (ids.length === 0) {
      const li = el('li')
      li.appendChild(el('p', 'empty', 'Ни одного узла: скрыты все типы'))
      ul.appendChild(li)
    }
    for (const id of ids) {
      const li = el('li')
      const a = nodeLink(node(id))
      state.rows.set(id, a)
      li.appendChild(a)
      ul.appendChild(li)
    }
    area.scrollTop = keep
  }
  markNodeList()
}

/** Выбранная строка — рамка и `aria-current`, найденные — кольцо у точки и слово для скринридера. */
function markNodeList() {
  for (const [id, a] of state.rows) {
    if (id === state.selected) a.setAttribute('aria-current', 'true')
    else a.removeAttribute('aria-current')
    const on = state.found.has(id)
    a.classList.toggle('found', on)
    const said = a.querySelector('.found-vh')
    if (on && !said) a.appendChild(el('span', 'vh found-vh', ', найдено'))
    if (!on && said) said.remove()
  }
}

/**
 * Строка выбранного — на треть высоты области прокрутки, прямым `scrollTop`:
 * `scrollIntoView` прокрутил бы и `.side`, и страницу, а панель должна
 * остаться в обзоре (#75). Вызывается после фокуса и прокрутки панели. `null`
 * — возврат к корню: область в начало.
 */
function scrollList(id) {
  if ($('nodelist').hidden) return
  const area = listArea()
  if (id === null) {
    area.scrollTop = 0
    return
  }
  const row = state.rows.get(id)
  // Тип скрыт фильтром — строки нет. Фокус в той же области пережил шаг —
  // область не прокручивается: фокус не уводится из обзора.
  if (!row || area.contains(document.activeElement)) return
  const box = area.getBoundingClientRect()
  const top = row.getBoundingClientRect().top - box.top - area.clientTop + area.scrollTop
  area.scrollTop = listScrollTop({ top, height: area.clientHeight, scrollHeight: area.scrollHeight })
}

/** Выдача поиска: до пяти результатов с отрывком, найденные — все. */
function renderSearch() {
  const q = $('q').value
  const ul = clear($('results'))
  const res = q.trim() === '' ? null : searchAtlas(state.search, q, SEARCH_UPTO)
  state.found = res?.found ?? new Set()
  if (!res) return
  if (res.total === 0) {
    const li = el('li')
    li.appendChild(el('p', 'empty', emptyNote({ texts: state.texts, short: res.short })))
    ul.appendChild(li)
    return
  }
  for (const hit of res.hits) {
    const li = el('li')
    const a = nodeLink(hit.node)
    a.classList.add('result')
    const snippet = el('span', 'snippet')
    for (const run of hit.snippet) snippet.appendChild(run.hit ? el('span', 'hit', run.text) : document.createTextNode(run.text))
    a.appendChild(snippet)
    li.appendChild(a)
    ul.appendChild(li)
  }
  const li = el('li')
  li.appendChild(el('p', 'trace-note', moreNote(res.total, res.hits.length)))
  ul.appendChild(li)
}

/**
 * Смена запроса: выдача, кольца на канве и в списке, строка вида. Ни
 * объявления, ни прокрутки списка: выдача — список рядом с полем.
 */
function showFound() {
  renderSearch()
  if (!redraws(state.status)) return
  state.view.line = lineNow()
  showLine()
  markNodeList()
  paint()
}

/**
 * Подсказка под полем и кнопка повтора — по состоянию `texts.json`. Пока идёт
 * повтор, кнопка `aria-disabled`, а не `disabled`: браузер снял бы с неё фокус.
 */
function showTexts() {
  if (state.status === 'ready') $('q-note').textContent = textsNote(state.texts)
  const retry = $('texts-retry')
  retry.hidden = !(state.texts === 'error' || (state.texts === 'loading' && state.textsAttempt > 1))
  if (state.texts === 'loading') retry.setAttribute('aria-disabled', 'true')
  else retry.removeAttribute('aria-disabled')
}

/**
 * Тексты документов — один раз за жизнь страницы, при первом фокусе в поле.
 * В полёте одна попытка; исход не текущей попытки ничего не меняет.
 */
async function loadTexts() {
  if (state.texts === 'loading' || state.texts === 'ready') return
  const attempt = (state.textsAttempt += 1)
  state.texts = 'loading'
  showTexts()
  let ok = false
  try {
    const texts = await fetchTexts()
    if (attempt !== state.textsAttempt) return
    state.textsData = texts
    if (state.graph) state.search = buildSearch(state.graph.nodes, texts)
    state.texts = 'ready'
    ok = true
  } catch {
    if (attempt !== state.textsAttempt) return
    state.texts = 'error'
  }
  // Фокус на кнопке запоминается до того, как успех её спрячет.
  const kept = document.activeElement === $('texts-retry')
  showTexts()
  if ($('q').value.trim() !== '') showFound()
  const note = textsOutcome({ ok, attempt })
  if (note) announce(note)
  // Посетитель нажал кнопку, чтобы искать: после успеха фокус — в поле.
  if (ok && kept) $('q').focus()
}

// ── Панель ─────────────────────────────────────────────────────────────

/**
 * Кнопка разворачивания. Панель пересобирается целиком, поэтому фокус
 * возвращается на кнопку по её ключу: без этого клавиатурный посетитель
 * улетает в начало документа и идёт обратно через сотню стопов.
 */
function toggle(key, expanded, label) {
  const button = el('button', undefined, expanded ? 'Свернуть' : label)
  button.type = 'button'
  button.dataset.toggle = key
  button.setAttribute('aria-expanded', String(expanded))
  button.addEventListener('click', () => switchOpen(key))
  return button
}

function switchOpen(key) {
  if (state.open.has(key)) state.open.delete(key)
  else state.open.add(key)
  renderPanel()
  $('panel').querySelector(`[data-toggle="${CSS.escape(key)}"]`)?.focus()
}

function block(title) {
  const section = el('section', 'panel-block')
  if (title) section.appendChild(el('h3', undefined, title))
  return section
}

function renderPanel() {
  const panel = clear($('panel'))
  panel.classList.add('panel')
  if (state.status === 'loading' && state.attempt < 2) {
    panel.appendChild(el('p', 'empty', 'Читаю схему проекта…'))
    return
  }
  if (state.status !== 'ready') {
    renderFailure(panel)
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

/**
 * Блок ошибки — раздел «Блок ошибки в панели» раскладки сбоя загрузки. Место
 * одно при любой ширине: панель есть во всех трёх раскладках.
 */
function renderFailure(panel) {
  const head = block()
  const h2 = el('h2', undefined, state.head)
  h2.id = 'panel-h'
  h2.tabIndex = -1
  const cause = el('p', 'cause', state.reason)
  cause.id = 'cause'
  const acts = el('div', 'acts')
  const again = el('button', undefined, 'Попробовать снова')
  again.type = 'button'
  again.id = 'retry'
  again.addEventListener('click', () => {
    if (again.getAttribute('aria-disabled') !== 'true') load()
  })
  const repo = el('a', undefined, 'Открыть репозиторий')
  repo.href = REPO
  acts.append(again, repo)
  const attempts = el('p', 'hint num')
  attempts.id = 'attempts'
  head.append(h2, cause, acts, attempts)
  panel.appendChild(head)
  showRetry()
}

/**
 * Повтор меняет блок на месте, а не пересобирает его: кнопка с фокусом
 * остаётся той же, и всё выше строки попытки не двигается. Заголовок и
 * причина — последнего известного исхода.
 */
function showRetry() {
  const { busy, line } = retryPhase(state.status, state.attempt)
  if (state.status === 'error') {
    $('panel-h').textContent = state.head
    $('cause').textContent = state.reason
  }
  if (busy) $('retry').setAttribute('aria-disabled', 'true')
  else $('retry').removeAttribute('aria-disabled')
  $('attempts').hidden = line === null
  $('attempts').textContent = line ?? ''
}

function renderMissing(panel) {
  const head = block()
  const h2 = el('h2', undefined, 'Узла нет в этой сборке')
  h2.id = 'panel-h'
  h2.tabIndex = -1
  head.appendChild(h2)
  const p = el('p', 'empty')
  p.append('Узла ', el('code', 'mono', state.missing), ' нет в этой сборке. Схема пересобирается при каждом мерже — документ мог быть переименован.')
  head.appendChild(p)
  const start = el('button', undefined, 'К началу')
  start.type = 'button'
  start.addEventListener('click', () => back(null))
  head.appendChild(start)
  panel.appendChild(head)
}

function renderStart(panel) {
  const s = state.stats
  const head = block()
  const h2 = el('h2', undefined, 'С чего начать')
  h2.id = 'panel-h'
  h2.tabIndex = -1
  // Канва показывает весь проект, поэтому абзац объясняет, как выделить узел;
  // вход в цикл дня — ссылка на фазу 1, сам проход — в панели фазы.
  const lead = el('p', 'sub')
  lead.append(
    `На схеме — весь проект: ${count(s.nodes, 'узел', 'узла', 'узлов')}, цвет — семейство. ` +
      'Выберите узел на схеме, в списке или поиском — он и его прямые связи выделятся, остальное станет бледнее.',
  )
  const phases = state.graph.nodes.filter((x) => x.type === 'phase').sort((a, b) => a.n - b.n)
  if (phases.length > 0) {
    const first = el('a', undefined, `фазы ${phases[0].n}`)
    first.href = `#${addressOf(phases[0].id)}`
    lead.append(` Цикл дня — ${count(phases.length, 'фаза', 'фазы', 'фаз')}, через которые проходит любая задача, — начинается с `, first, '.')
  }
  head.append(
    h2,
    lead,
    el('p', 'meta-row num', `${count(s.nodes, 'узел', 'узла', 'узлов')} · ${count(s.edges, 'связь', 'связи', 'связей')} · ${count(s.byType.history ?? 0, 'запись', 'записи', 'записей')} истории`),
  )
  panel.appendChild(head)

  const traces = block('Правила и их следы')
  traces.appendChild(el('p', 'trace-note', `имя роли рядом с признаком гейта в ${count(s.byType.history ?? 0, 'записи', 'записях', 'записях')} истории`))
  const list = el('ul', 'summary')
  const byRole = new Map()
  for (const e of s.fired) {
    if (!byRole.has(e.from)) byRole.set(e.from, [])
    byRole.get(e.from).push(e)
  }
  for (const [id, mine] of [...byRole].sort((a, b) => b[1].length - a[1].length)) {
    const li = el('li')
    const row = el('div', 'summary-row')
    row.append(nodeLink(node(id), ''), el('span', 'counter', traceCounter(mine)))
    const dates = mine.map((e) => node(e.to).date).filter(Boolean).sort()
    li.append(row)
    if (dates.length > 0) {
      const first = dayMonth(dates[0])
      const last = dayMonth(dates[dates.length - 1])
      li.append(el('p', 'span', first === last ? first : `${first} – ${last}`))
    }
    list.appendChild(li)
  }
  traces.append(list, el('p', 'trace-note', `У остальных ${count(s.rolesWithout, 'роли', 'ролей', 'ролей')} следов нет — почему, сказано на их узлах.`))
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
  const h2 = el('h2', undefined, plainTitle(n))
  h2.id = 'panel-h'
  // Цель фокуса после шага, а не элемент управления: в обход `Tab` не входит.
  h2.tabIndex = -1
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

  const facts = factsOf(n, state.graph)
  if (facts.length > 0) {
    const box = block('Факты')
    const dl = el('dl')
    for (const pair of facts) {
      dl.appendChild(el('dt', undefined, pair.term))
      const dd = el('dd', pair.mono ? 'mono' : undefined)
      if (pair.links) pair.links.forEach((id, i) => dd.append(i ? ', ' : '', nodeLink(node(id))))
      else if (pair.mono) dd.append(pair.text)
      // Разметка в тексте документа разбирается тем же однопроходным разбором:
      // показать `**` и `` ` `` как есть — показать протёкший markdown.
      else for (const run of excerptRuns(pair.text, 0, pair.text.length, null)) dd.appendChild(runNode(run))
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

/**
 * Пары «Фактов» узла: чистая функция от графа, без DOM. Значение — строка
 * (`text`) или список идентификаторов узлов (`links`); пары без значения не
 * попадают в вывод вовсе.
 *
 * Отбор пустых — здесь, а не у каждого поля по отдельности: пять узлов
 * `external` из `overlay.json` не несут `tier`, `service/site` не несёт
 * `image`, и любое новое поле overlay окажется в том же положении. Панель,
 * которая печатает «Образ: undefined» или роняет страницу исключением, —
 * один и тот же дефект: факт, которого нет, объявлен фактом.
 *
 * @returns {Array<{term:string, text?:string, links?:string[], mono?:boolean}>}
 */
export function factsOf(node, graph) {
  const raw = []
  const say = (term, text, mono) => raw.push({ term, text, mono })
  const refs = (term, ids) => raw.push({ term, links: ids })
  const type = (id) => graph.nodes.find((n) => n.id === id)?.type
  const targets = (kind, only) =>
    graph.edges.filter((e) => e.from === node.id && e.kind === kind && (!only || type(e.to) === only)).map((e) => e.to)
  const sources = (kind) => graph.edges.filter((e) => e.to === node.id && e.kind === kind).map((e) => e.from)
  const list = (values) => (Array.isArray(values) && values.length > 0 ? values.join(' ') : undefined)

  switch (node.type) {
    case 'adr':
      say('Статус', node.status)
      say('Дата', node.date)
      say('Файл', node.file, true)
      break
    case 'history':
    case 'design':
      say('Дата', node.date)
      say('Файл', node.file, true)
      break
    case 'guide':
      say('Файл', node.file, true)
      break
    case 'invariant':
      say('Текст инварианта', node.text)
      break
    case 'role':
      say('Модель', node.model)
      say('Усилие', node.effort)
      refs('Предзагруженные скиллы', targets('preloads'))
      say('Владеет', node.owns)
      say('Никогда', node.never)
      say('Описание', node.description)
      break
    case 'tier':
      say('Модель', node.model)
      say('Усилие', node.effort)
      refs('Роли этого яруса', sources('tier'))
      break
    case 'skill':
      say('Описание', node.description)
      say('Происхождение', node.vendored ? 'вендорный' : 'свой')
      say('Файл', node.file, true)
      break
    case 'class':
      say('Что входит', node.what)
      say('Примечание', node.note)
      break
    case 'phase':
      say('Номер', node.n === undefined ? undefined : String(node.n))
      refs('Роли', targets('runs', 'role'))
      refs('Классы гейтов', targets('runs', 'class'))
      say('Критерий выхода', node.exit)
      say('Гейт владельца', node.human === undefined ? undefined : node.human ? 'да' : 'нет')
      break
    case 'day':
      say('Дата', node.date)
      say('Маршрут', node.route, true)
      say('Каталог', node.dir, true)
      say('Образ', node.image, true)
      say('Файлы окружения', list(node.envFiles), true)
      break
    case 'service':
      say('Образ', node.image, true)
      say('Файлы окружения', list(node.envFiles) ?? 'нет', true)
      break
    case 'external':
      say('Вид', node.kind)
      say('Ярус', node.tier)
      say('Модель', node.model)
      say('Примечание', node.note)
      break
    default:
      break
  }
  return raw.filter((pair) => (pair.links ? pair.links.length > 0 : typeof pair.text === 'string' && pair.text !== ''))
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
    box.appendChild(toggle(key, expanded, `Показать все ${edges.length}`))
  }
  return box
}

// ── Следы в записях ────────────────────────────────────────────────────

function tracesBlock(role) {
  const box = block('Следы в записях')
  const mine = state.stats.fired.filter((e) => e.from === role.id)
  // Порядок строк — заголовок, подзаголовок, счётчик: подзаголовок объясняет,
  // что именно посчитано, и обязан стоять раньше числа.
  box.append(el('p', 'trace-note', 'имя роли рядом с признаком гейта'), el('p', 'counter', traceCounter(mine)))

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
  // Даты и ключи сравниваются как строки байт за байтом: они в формате
  // `2026-09-13`, порядок от этого не зависит ни от локали, ни от ICU.
  const desc = (x, y) => (x < y ? 1 : x > y ? -1 : 0)
  const sorted = [...mine].sort(
    (a, b) => desc(node(a.to).date, node(b.to).date) || desc(node(a.to).key, node(b.to).key) || a.line - b.line,
  )
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
  // Запись может быть не привязана к дню — тогда дня в строке просто нет,
  // без «—» и без «вне дня».
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
    card.appendChild(toggle(key2, expanded, `Показать фразу целиком (ещё ${count(hidden, 'знак', 'знака', 'знаков')})`))
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

/**
 * Сброс фильтров. Обе кнопки сброса исчезают вместе со своим состоянием,
 * поэтому фокус уходит на первый флажок типов: иначе клавиатурный посетитель
 * оказывается в начале документа — тот же дефект, что с разворачиванием.
 */
function dropFilters() {
  state.hidden.clear()
  refresh(false)
  announceView()
  $('filters').querySelector('input')?.focus()
}

function emptyCanvas(empty) {
  const msg = clear($('canvas-msg'))
  const act = clear($('canvas-act'))
  act.hidden = !empty
  if (!empty) return
  msg.textContent = 'Ни одного узла: скрыты все типы'
  const reset = el('button', undefined, 'Сбросить фильтры')
  reset.type = 'button'
  reset.addEventListener('click', dropFilters)
  act.appendChild(reset)
}

function announce(text) {
  $('live').textContent = text
}

/** Стереть картинку: после отказа на канве не должно остаться прошлого вида. */
function wipe() {
  for (const id of ['canvas', 'map-canvas']) {
    const canvas = $(id)
    if (canvas?.width) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  }
}

/**
 * Перерисовывается только загруженная схема. После отказа — нет: иначе
 * следующий же вызов отрисует вид поверх сообщения о поломке, и канва снова
 * покажет картинку там, где показывать нечего; выход один — «Попробовать
 * снова», то есть перезагрузка схемы. Пока схема грузится — тоже нет: графа
 * ещё нет, а `resize` и прочие поводы приходят и в это время. Такой вызов
 * падал бы на `graph === null`, и пояс в `refresh` на миг показывал бы
 * внутреннюю ошибку вместо «Читаю схему проекта…» и настоящей причины.
 */
export const redraws = (status) => status === 'ready'

/**
 * `refit` — вписать вид заново. Фильтр, «Плоский вид», размер окна и карта
 * перевписывают; выбор узла — нет: граф тот же, и приближение посетителя
 * остаётся. Первое появление канвы вписывается всегда.
 */
function refresh(animate, refit = true) {
  if (!redraws(state.status)) return
  try {
    computeView()
    state.drawn = true
    showLine()
    $('flat-note').textContent = flatHint(state.flat, matchMedia('(any-pointer: fine)').matches)
    renderTrail()
    // Пустая канва читается как «не загрузилось», поэтому у неё есть текст —
    // тот же механизм, что у загрузки и ошибки.
    if (state.status === 'ready') emptyCanvas(state.view.ids.size === 0)
    renderTools()
    renderNodeList()
    renderPanel()
    if (refit || !state.framed) reframe(animate)
    else paint()
  } catch (err) {
    // Пояс поверх причины. Сборка панели под Node не выполняется и ни одним
    // тестом не достижима, поэтому её отказ обязан быть виден: без этого
    // исключение обрывало refresh до reframe и оставляло канву с картинкой
    // предыдущего узла — страница молча показывала не то.
    wipe()
    $('view-line').textContent = ''
    setStatus('error', String(err?.message ?? err), 'Схему не удалось показать')
    announce(outcomeNote({ head: state.head, reason: state.reason }))
    // «Карта» теперь недоступна: карта закрывается, фокус с неё уходит на
    // «Попробовать снова» (обработчик `close`).
    if (mapOpen()) $('map').close()
  }
}

/**
 * «Плоский вид». Два флажка — под канвой и в карте — с одним состоянием.
 * Возврат в объём ставит начальную позу; переход — смесь двух конечных
 * картинок за 120 мс, при `prefers-reduced-motion` мгновенно. Режим не пишется
 * ни в адрес, ни в хранилище: каждое открытие начинается с объёма.
 */
function setFlat(flat) {
  const canvas = mapOpen() ? $('map-canvas') : $('canvas')
  const ready = state.status === 'ready'
  // Картинка, которая на канве сейчас, — начало смеси.
  let from = null
  if (ready && canvas.clientWidth > 0 && !reduceMotion()) {
    const at = transform(fieldOf(canvas), camNow())
    const sel = state.view.ids.has(state.selected) ? state.selected : null
    from = volumeOn() ? volumeScreen(at, sel) : flatScreen(at, sel)
  }
  state.flat = flat
  $('flat').checked = flat
  $('map-flat').checked = flat
  if (!flat) state.pose = { ...POSE0 }
  if (!ready) return
  state.morph = from ? { from, t0: performance.now() } : null
  refresh(false)
  announceView()
}

/**
 * Две колонки: прокручивается не панель, а `.side`, и сброс `scrollTop`
 * панели там ничего не делает. Если заголовок панели не виден целиком, верх
 * панели встаёт у верхнего края колонки — как у пропуск-ссылки.
 */
function showPanel() {
  const side = document.querySelector('.side')
  if (getComputedStyle(side).display === 'contents') return
  const box = side.getBoundingClientRect()
  const head = ($('panel-h') ?? $('panel')).getBoundingClientRect()
  if (head.top < box.top || head.bottom > box.bottom) side.scrollTop += $('panel').getBoundingClientRect().top - box.top
}

/**
 * `returned` — возврат по пути: «Вернулись» отличает его от шага вперёд.
 * `step` — шаг из `go`: источник и элемент, на котором стоял фокус.
 */
function select(id, fromHash, returned, step) {
  state.missing = null
  state.selected = id
  state.open.clear()
  if (!fromHash) {
    // replaceState, а не pushState: иначе «Назад» отматывает по одному узлу
    // через двадцать шагов блуждания и никогда не выводит с витрины.
    history.replaceState(null, '', id ? `#${addressOf(id)}` : location.pathname + location.search)
  }
  // Выбор подсвечивает, а не перестраивает: вид не перевписывается.
  refresh(false, false)
  const focused = step !== undefined && focusesPanel(step.source, !step.was.isConnected)
  showPanel()
  // Перерисовка упала: панель — блок ошибки, узел не показан, причину уже
  // объявил `refresh`.
  if (state.status === 'error') {
    if (focused) $('panel-h').focus({ preventScroll: true })
    return
  }
  if (id) {
    $('panel').scrollTop = 0
    // Сначала фокус, потом `#live`: вежливое объявление встаёт в очередь за
    // тем, что произнёс фокус. Видимость — правила прокрутки, не браузер.
    if (focused) $('panel-h').focus({ preventScroll: true })
    const n = node(id)
    announce(selectNote({ title: plainTitle(n), type: TYPE_NAME[n.type], line: state.view.line, focused, returned }))
    bringIntoView(id)
  } else announce(returned ? `Вернулись к началу. Вид: ${state.view.line}` : `Вид: ${state.view.line}`)
  // Прокрутка списка — после фокуса и видимости панели по #75, в своей области.
  scrollList(id)
}

/** Якоря страницы, а не адреса узлов: контракт `#`-адресов их не знает. */
const PAGE_ANCHORS = new Set(['panel'])

const hashRaw = () => decodeURIComponent(location.hash.replace(/^#/, ''))

/**
 * `step` — смена адреса в открытой вкладке (правка адресной строки): это шаг
 * посетителя, и путь меняется по тому же правилу. При загрузке путь уже
 * восстановлен и не трогается.
 */
function fromHash(step) {
  const raw = hashRaw()
  // Якоря самой страницы узлами не притворяются: пропуск-ссылка ведёт к
  // панели, а не «к отсутствию узла». Но заход прямо по такому адресу —
  // из новой вкладки или по скопированной ссылке — обязан построить вид:
  // иначе страница открывается пустой.
  if (PAGE_ANCHORS.has(raw)) {
    if (!state.drawn) refresh(false)
    return
  }
  if (raw === '') {
    if (step) setTrail([])
    state.missing = null
    state.selected = null
    refresh(false, false)
    scrollList(null)
    return
  }
  const id = state.addresses.get(raw)
  if (id) {
    if (step) setTrail(stepTrail(state.trail, id))
    select(id, true)
    return
  }
  // Ссылки на витрину живут дольше сборок: адрес обязан сказать это словами.
  // Путь — корень и «Узла нет в этой сборке», как при заходе по такой ссылке.
  if (step) setTrail([])
  state.missing = raw
  state.selected = null
  refresh(false, false)
}

/**
 * `reason` и `head` — только у ошибки. Пока идёт повтор, блок ошибки держит
 * причину прошлой попытки: заголовок и причина — последний известный исход.
 */
function setStatus(status, reason, head) {
  state.status = status
  if (status === 'error') {
    state.reason = reason
    state.head = head
  }
  const ready = status === 'ready'
  const msg = clear($('canvas-msg'))
  clear($('canvas-act')).hidden = true
  $('q').disabled = !ready
  // Повтор не двигает ничего выше строки попытки: подсказка поиска держит
  // последний исход. Иначе на узком экране она становится на строку короче,
  // и панель с кнопкой в фокусе уезжает вверх.
  const retrying = status === 'loading' && state.attempt > 1
  if (!retrying) {
    $('q-note').textContent =
      status === 'ready' ? textsNote(state.texts) : status === 'error' ? 'Схема не загрузилась — искать негде' : 'Схема ещё грузится'
  }
  // Пока схемы нет, «Плоский вид» недоступен и подсказка пуста: переключать нечего.
  if (!ready) $('flat-note').textContent = ''
  // Всё, что работает по графу, без графа не притворяется рабочим.
  for (const id of GRAPH_BUTTONS) $(id).disabled = !ready
  for (const id of GRAPH_BLOCKS) $(id).hidden = !ready
  if (status === 'loading') msg.textContent = 'Читаю схему проекта…'
  // Причина и действия — в панели при любой ширине; на канве только указатель.
  if (status === 'error') msg.textContent = 'Рисовать нечего. Причина и «Попробовать снова» — в панели справа.'
  // Без графа ходить некуда: строка пути держит высоту, но невидима.
  if (!ready) $('trail').classList.add('idle')
  if (!ready && $('retry')) showRetry()
  else renderPanel()
}

/**
 * Первая ступень срока: строка «Читаю схему проекта…» дополняется там, где
 * она стоит в этой попытке, и больше нигде, — и один раз звучит в `#live`.
 */
function showSlow() {
  for (const at of [$('canvas-msg'), $('panel').querySelector('.empty'), $('attempts')]) {
    if (at?.textContent === 'Читаю схему проекта…') at.textContent = LOAD_HINT
  }
  announce(LOAD_HINT)
}

async function load() {
  const attempt = (state.attempt += 1)
  setStatus('loading')
  try {
    const graph = await fetchGraph(showSlow)
    // Исход не текущей попытки ничего не меняет — страховка на случай, если
    // отмена где-то не сработала.
    if (attempt !== state.attempt) return
    state.graph = graph
    state.index = indexGraph(graph)
    state.addresses = addressTable(graph.nodes)
    state.stats = statsOf(graph, state.index.near)
    state.search = buildSearch(graph.nodes, state.textsData ?? {})
    // Посетитель остался на «Попробовать снова» — после успеха фокус встаёт
    // на заголовок новой панели. Ушёл с кнопки — фокус не трогается.
    const kept = $('retry') !== null && document.activeElement === $('retry')
    setStatus('ready')
    renderLede()
    renderFooter()
    setTrail(restoreTrail(readTrail(), hashRaw(), state.addresses))
    fromHash()
    // Сначала фокус, потом `#live` — порядок спецификации фокуса после шага.
    if (kept) {
      $('panel-h').focus({ preventScroll: true })
      showPanel()
      showPanelHead()
    }
    // Упавшая перерисовка уже объявила свою причину.
    if (state.status !== 'ready') return
    if (!state.selected || state.attempt > 1) announce(outcomeNote({ attempt: state.attempt, line: state.view.line }))
  } catch (err) {
    setStatus('error', String(err.message ?? err), 'Схему не удалось загрузить')
    announce(outcomeNote({ head: state.head, reason: state.reason, attempt: state.attempt }))
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

  // «Сбросить вид» в объёме возвращает и начальную позу; в плоском поза не видна.
  const resetView = () => {
    state.pose = { ...POSE0 }
    reframe(false)
  }
  $('zoom-in').addEventListener('click', () => zoom(1.25))
  $('zoom-out').addEventListener('click', () => zoom(0.8))
  $('view-reset').addEventListener('click', resetView)
  $('map-zoom-in').addEventListener('click', () => zoom(1.25))
  $('map-zoom-out').addEventListener('click', () => zoom(0.8))
  $('map-reset').addEventListener('click', resetView)

  const map = $('map')
  $('map-open').addEventListener('click', () => {
    map.showModal()
    // Вид вписывается в поле карты: у него свои пропорции.
    refresh(false)
  })
  $('map-close').addEventListener('click', () => map.close())
  // Esc обрабатывает браузер: фокус захвачен, возврат на кнопку «Карта» — тоже.
  // После отказа перерисовки «Карта» недоступна, и возврат на неё уронил бы
  // фокус на `body`: тогда он встаёт на «Попробовать снова».
  map.addEventListener('close', () => {
    const to = $('map-open').disabled ? $('retry') : $('map-open')
    to?.focus()
    refresh(false)
  })

  // Тексты документов — при первом фокусе в поле, не при открытии страницы.
  $('q').addEventListener('focus', () => {
    if (state.texts === 'idle') loadTexts()
  })
  $('q').addEventListener('input', showFound)
  $('texts-retry').addEventListener('click', () => {
    if ($('texts-retry').getAttribute('aria-disabled') !== 'true') loadTexts()
  })
  $('q').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    if ($('q').value !== '') {
      $('q').value = ''
      showFound()
    } else {
      // На узком экране «Сбросить вид» не показывается: канвы в потоке нет.
      const back = [$('view-reset'), $('map-open')].find((b) => b.offsetParent !== null)
      back?.focus()
    }
  })

  for (const id of ['flat', 'map-flat']) $(id).addEventListener('change', () => setFlat($(id).checked))
  $('filters-reset').addEventListener('click', dropFilters)

  // Выбор узла ссылкой — шаг внутри витрины, а не переход браузера: адрес
  // обновляет replaceState, и «Назад» выводит с витрины за один шаг с любой
  // глубины пути. Средний клик и клик с модификатором не перехватываются:
  // `href` настоящий, и узел по-прежнему открывается в новой вкладке.
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return
    const a = ev.target.closest?.('a[href]')
    if (!a || state.status !== 'ready') return
    if (a.dataset.trail !== undefined) {
      ev.preventDefault()
      back(a.dataset.trail || null)
      return
    }
    const href = a.getAttribute('href')
    const id = href.startsWith('#') ? state.addresses.get(decodeURIComponent(href.slice(1))) : undefined
    if (!id) return
    ev.preventDefault()
    go(id, 'link')
  })

  // Без графа адрес не читается: таблицы адресов ещё нет, а после загрузки
  // адрес читается заново.
  addEventListener('hashchange', () => {
    if (state.status === 'ready') fromHash(true)
  })
  addEventListener('resize', () => refresh(false))

  // Единственная клавиатурная сокращённая команда, кроме поиска и Esc, — и
  // только там, где у стрелок очевидный смысл.
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    const key = document.activeElement?.dataset?.toggle
    if (key === undefined || !state.open.has(key)) return
    ev.stopPropagation()
    switchOpen(key)
  })

  // Б3: пропуск-ссылка уводит фокус в панель, но не переписывает адрес —
  // иначе единственный клавиатурный путь к панели стирал бы выбранный узел.
  $('skip').addEventListener('click', (ev) => {
    ev.preventDefault()
    const panel = $('panel')
    panel.focus()
    // Без плавной прокрутки: корпус ограничивает движение 120 мс, а
    // браузерная `smooth` длится дольше и этим сроком не управляется.
    panel.scrollIntoView({ block: 'start' })
  })

  addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (!state.selected || node(state.selected).type !== 'phase') return
    const phases = state.graph.nodes.filter((n) => n.type === 'phase').sort((a, b) => a.n - b.n)
    const at = phases.findIndex((p) => p.id === state.selected)
    const next = phases[at + (ev.key === 'ArrowLeft' ? -1 : 1)]
    if (next) go(next.id, 'arrow')
  })

  // Своя колонка настроек есть только в трёхколоночной раскладке; при двух
  // «Фильтры по типу» — свёрнутый блок правой колонки, как на узком экране.
  const wide = matchMedia('(min-width: 100rem)')
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
