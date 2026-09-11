// Правила строк страницы прогресса. Один файл на двоих: страница отбирает им
// строки для отрисовки, тест test/progress-data.test.js проверяет data.js в CI.
// Формат — agent_docs/design/2026-09-10-1553-progress-page.md, раздел «Файл данных».
// Обычный скрипт, а не модуль: страница подключает его без сборки, Node — импортом.
{
  const TYPES = ['feat', 'fix', 'docs', 'chore', 'test', 'refactor']
  const CLASSES = ['A', 'B', 'C']
  const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
  const UTC = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?Z$/
  const STREAM_KEY = /^[a-z][a-z0-9-]*$/
  // Поля каждого уровня. Лишнее поле — находка: страница его не рисует, но
  // Caddy отдаёт файл целиком, и в нём может уехать что угодно.
  const FIELDS = {
    top: ['now', 'streams', 'prs'],
    now: ['updated', 'items'],
    stream: ['key', 'label'],
    pr: ['n', 'merged', 'type', 'stream', 'cls', 'result', 'goal'],
    item: ['stage', 'title', 'text'],
  }
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const extra = (obj, level) => Object.keys(obj).filter((k) => !FIELDS[level].includes(k))

  // Непустая строка не длиннее max знаков (кодовых точек, не единиц UTF-16).
  const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && [...v].length <= max

  // Полная проверка строки для CI: поля плюс запрет лишних.
  function prProblems(pr, streamKeys) {
    if (!isObj(pr)) return ['строка — не объект']
    return [...extra(pr, 'pr').map((k) => `лишнее поле ${k}`), ...prFieldProblems(pr, streamKeys)]
  }

  // Только поля, которые рисует страница. Ею страница отбирает строки: лишнее
  // поле не рисуется и ловится в CI, а строку не прячет.
  function prFieldProblems(pr, streamKeys) {
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
    const out = extra(item, 'item').map((k) => `лишнее поле ${k}`)
    if (!isText(item.stage, 24)) out.push('stage — непустой, ≤ 24 знаков')
    if (!isText(item.title, 100)) out.push('title — непустой, ≤ 100 знаков')
    if (!isText(item.text, 300)) out.push('text — непустой, ≤ 300 знаков')
    return out
  }

  // Все находки по файлу данных целиком; пустой массив — данные в порядке.
  function dataProblems(data) {
    if (!isObj(data)) return ['PROGRESS — не объект']
    const out = extra(data, 'top').map((k) => `лишнее поле ${k}`)
    const streams = Array.isArray(data.streams) ? data.streams : []
    if (!Array.isArray(data.streams) || streams.length === 0) out.push('streams — непустой массив')
    const keys = []
    streams.forEach((s, i) => {
      if (!isObj(s) || !STREAM_KEY.test(s.key) || !isText(s.label, Infinity)) {
        out.push(`streams[${i}] — { key: слово латиницей, label }`)
        return
      }
      for (const k of extra(s, 'stream')) out.push(`streams[${i}]: лишнее поле ${k}`)
      if (keys.includes(s.key)) out.push(`streams[${i}] — ключ ${s.key} повторяется`)
      else keys.push(s.key)
    })
    if (!isObj(data.now)) out.push('now — объект')
    else {
      for (const k of extra(data.now, 'now')) out.push(`now: лишнее поле ${k}`)
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

  // Страница публичная: в файле нет адресов, приватных следов и обращения к
  // владельцу. Проверяется сырой текст data.js — комментарии и любые поля.
  // «Вы» не ловится: совпадёт с «выкатка», его проверяет чтение.
  // Без `sh`: иначе ловятся скрипты репозитория (bootstrap.sh, deploy.sh).
  const TLD = 'ai|app|biz|cloud|co|com|de|dev|info|io|link|me|net|online|org|page|ru|run|sg|site|so|tech|uk|us|xyz'
  const PRIVATE = [
    ['адрес со схемой', /[a-z][a-z0-9+.-]*:\/\//i],
    ['адрес с www.', /www\./i],
    ['временный путь', /(^|[^\w/.-])\/(tmp|private|var)\//],
    ['домашний путь', /(^|[^\w/.-])(~\/|\/(Users|home|root)\/)/],
    ['домен без схемы', new RegExp(`(^|[^\\w@.-])(?:[a-z0-9-]+\\.)+(?:${TLD})(?![\\w-])`, 'i')],
    ['имя хоста', /\blocalhost\b|\.(local|internal|lan|ts\.net)(?![\w-])/i],
    // id файла Drive — 25+ знаков из [A-Za-z0-9_-] вперемешку: буквы обоих
    // регистров и цифры. Имя файла спецификации (строчные, цифры, дефисы) не
    // попадает — у него нет заглавных.
    ['id Google Drive', (s) => /drive/i.test(s) || (s.match(/[A-Za-z0-9_-]{25,}/g) || []).some((t) => /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t))],
    ['email', /[\w.+-]@[a-z0-9-]/i],
    ['IPv4-адрес', /\b\d{1,3}(\.\d{1,3}){3}\b/],
    // Две группы «hex:» и дальше; время «15:19» и «T15:19Z» не совпадает —
    // нужна буква a–f или «::».
    ['IPv6-адрес', (s) => (s.match(/(?:^|[^\w:])(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*/gi) || []).some((t) => /::|[a-f]/i.test(t))],
    // Формы «ваш» и «вам» целым словом: «Вашингтон» — не обращение.
    ['обращение к владельцу', /(^|[^а-яё])(ваш(а|е|и|у|ей|его|ему|ем|им|их|ими)?|вам|вами)(?![а-яё])/i],
  ]

  function publicProblems(source) {
    const out = []
    String(source).split('\n').forEach((line, i) => {
      for (const [what, rule] of PRIVATE) {
        if (typeof rule === 'function' ? rule(line) : rule.test(line)) out.push(`строка ${i + 1}: ${what} — «${line.trim()}»`)
      }
    })
    return out
  }

  globalThis.PROGRESS_CHECK = { isText, prProblems, prFieldProblems, itemProblems, dataProblems, publicProblems }
}
