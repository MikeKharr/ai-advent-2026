// Правила строк страницы прогресса. Один файл на двоих: страница отбирает им
// строки для отрисовки, тест test/progress-data.test.js проверяет data.js в CI.
// Формат — agent_docs/design/2026-09-14-1300-progress-page.md, раздел «Файл данных».
// Обычный скрипт, а не модуль: страница подключает его без сборки, Node — импортом.
{
  const TYPES = ['feat', 'fix', 'docs', 'chore', 'test', 'refactor']
  const CLASSES = ['A', 'B', 'C']
  const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
  const UTC = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?Z$/
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

  // Непустая строка не длиннее max знаков (кодовых точек, не единиц UTF-16).
  const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && [...v].length <= max

  function prProblems(pr, streamKeys) {
    if (!isObj(pr)) return ['строка — не объект']
    const out = []
    if (!Number.isInteger(pr.n) || pr.n < 1) out.push('n — целое ≥ 1')
    if (typeof pr.merged !== 'string' || !DAY.test(pr.merged)) out.push('merged — YYYY-MM-DD')
    if (!TYPES.includes(pr.type)) out.push(`type — один из ${TYPES.join(', ')}`)
    if (!streamKeys.includes(pr.stream)) out.push('stream — один из streams[].key')
    if ('cls' in pr && !CLASSES.includes(pr.cls)) out.push('cls — A, B или C')
    if (!isText(pr.result, 100)) out.push('result — непустой, ≤ 100 знаков')
    if (!isText(pr.goal, 80)) out.push('goal — непустая, ≤ 80 знаков')
    return out
  }

  function itemProblems(item) {
    if (!isObj(item)) return ['пункт — не объект']
    const out = []
    if (!isText(item.stage, 24)) out.push('stage — непустой, ≤ 24 знаков')
    if (!isText(item.title, 100)) out.push('title — непустой, ≤ 100 знаков')
    if (!isText(item.text, 300)) out.push('text — непустой, ≤ 300 знаков')
    return out
  }

  // Все находки по файлу данных целиком; пустой массив — данные в порядке.
  function dataProblems(data) {
    if (!isObj(data)) return ['PROGRESS — не объект']
    const out = []
    const streams = Array.isArray(data.streams) ? data.streams : []
    if (!Array.isArray(data.streams) || streams.length === 0) out.push('streams — непустой массив')
    const keys = []
    streams.forEach((s, i) => {
      if (!isObj(s) || !isText(s.key, Infinity) || !isText(s.label, Infinity)) out.push(`streams[${i}] — { key, label }`)
      else if (keys.includes(s.key)) out.push(`streams[${i}] — ключ ${s.key} повторяется`)
      else keys.push(s.key)
    })
    if (!isObj(data.now)) out.push('now — объект')
    else {
      if (typeof data.now.updated !== 'string' || !UTC.test(data.now.updated)) out.push('now.updated — ISO 8601 в UTC с Z')
      if (!Array.isArray(data.now.items)) out.push('now.items — массив')
      else {
        if (data.now.items.length > 5) out.push('now.items — не больше 5 пунктов')
        data.now.items.forEach((item, i) => {
          for (const p of itemProblems(item)) out.push(`now.items[${i}]: ${p}`)
        })
      }
    }
    if (!Array.isArray(data.prs)) return [...out, 'prs — массив']
    let prev = 0
    data.prs.forEach((pr, i) => {
      const at = `prs[${i}]${isObj(pr) && pr.n !== undefined ? ` (#${pr.n})` : ''}`
      for (const p of prProblems(pr, keys)) out.push(`${at}: ${p}`)
      if (isObj(pr) && Number.isInteger(pr.n)) {
        if (pr.n <= prev) out.push(`${at}: номера по возрастанию и без повторов`)
        prev = Math.max(prev, pr.n)
      }
    })
    return out
  }

  // Страница публичная: в тексте нет адресов, приватных следов и обращения
  // к владельцу. «Вы» не ловится: совпадёт с «выкатка», его проверяет чтение.
  const PRIVATE = [
    [/:\/\//, 'адрес с ://'],
    [/www\./i, 'адрес с www.'],
    [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'IPv4-адрес'],
    [/ts\.net/i, 'имя частной сети'],
    [/drive/i, 'Google Drive'],
    [/\/Users\/|\/private\//, 'путь рабочего каталога'],
    [/(^|[^а-яё])ва[шм]/i, 'обращение к владельцу'],
  ]

  function publicProblems(data) {
    if (!isObj(data)) return []
    const texts = []
    for (const s of Array.isArray(data.streams) ? data.streams : []) if (isObj(s)) texts.push(['streams', s.label])
    for (const it of isObj(data.now) && Array.isArray(data.now.items) ? data.now.items : []) {
      if (isObj(it)) texts.push(['now', it.stage], ['now', it.title], ['now', it.text])
    }
    for (const pr of Array.isArray(data.prs) ? data.prs : []) {
      if (isObj(pr)) texts.push([`#${pr.n}`, pr.result], [`#${pr.n}`, pr.goal])
    }
    const out = []
    for (const [where, text] of texts) {
      if (typeof text !== 'string') continue
      for (const [re, what] of PRIVATE) if (re.test(text)) out.push(`${where}: ${what} — «${text}»`)
    }
    return out
  }

  globalThis.PROGRESS_CHECK = { isText, prProblems, itemProblems, dataProblems, publicProblems }
}
