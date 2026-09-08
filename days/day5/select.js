// Отбор статей из накопленного окна под конкретный запрос.
//
// Задача дня 5: не «свежее за неделю», а «то, что относится к теме», —
// иначе окно в тысячу текстов не нужно. Отбор алгоритмический: модель
// получает уже отобранное, поиском в интернете не пользуется.
//
// Важное ограничение: тема и запрос обычно на русском, а статьи на
// английском, поэтому совпадений по словам может не быть вовсе. Тогда
// отбор молча вырождается в «самые свежие» — как в дне 3, а не в пустоту.

const STOPWORDS = new Set([
  'что',
  'как',
  'про',
  'для',
  'все',
  'или',
  'это',
  'кто',
  'где',
  'при',
  'над',
  'под',
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'was',
  'were',
  'has',
  'have',
  'новости',
  'новость',
  'статья',
  'статьи',
  'расскажи',
  'сделай',
  'напиши',
  'какие',
])

/** Слова длиннее двух символов, без стоп-слов; регистр и пунктуация снимаются. */
export function terms(text) {
  const out = new Set()
  for (const word of String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue
    out.add(word)
  }
  return [...out]
}

/**
 * Основа слова для сопоставления: русские слова в запросе стоят в падеже
 * («в Индии»), а в тексте — в другом («Индия»). Точное совпадение их
 * не свяжет, поэтому сравниваем по началу слова.
 */
export function stem(word) {
  return word.length > 4 ? word.slice(0, word.length - 1) : word
}

const LETTER = /\p{L}|\p{N}/u

/**
 * Совпадения считаются только с начала слова: основа «банк» не должна
 * находиться в «урбанистика», а «инди» — в «индивидуальный». Конец слова
 * свободен намеренно — там и живут окончания, ради которых основа берётся.
 */
function countOccurrences(haystack, needle) {
  if (!haystack) return 0
  let count = 0
  let from = 0
  while (true) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    const before = at === 0 ? '' : haystack[at - 1]
    if (before === '' || !LETTER.test(before)) count += 1
    from = at + needle.length
  }
  return count
}

/**
 * Оценка релевантности. Заголовок весит втрое: попадание в него —
 * признак того, что статья о теме, а не упоминает её вскользь.
 * Вклад тела ограничен, иначе длинная статья побеждает одной длиной.
 * Источник и регион тоже проверяются: они по-русски, и запрос вроде
 * «что в Индии» находит их даже при английских текстах.
 */
export function score(item, queryTerms, { now = Date.now() } = {}) {
  if (queryTerms.length === 0) return 0
  const title = (item.title ?? '').toLowerCase()
  const body = (item.text ?? item.summary ?? '').toLowerCase()
  const meta = `${item.source ?? ''} ${item.region ?? ''}`.toLowerCase()

  let hits = 0
  for (const term of queryTerms) {
    const needle = stem(term)
    hits += 3 * countOccurrences(title, needle)
    hits += Math.min(countOccurrences(body, needle), 5)
    hits += 2 * countOccurrences(meta, needle)
  }
  if (hits === 0) return 0

  // Свежесть — добавка к найденному, а не отдельная ось: старая, но точно
  // по теме статья должна обгонять сегодняшнюю не по теме.
  const ageDays = (now - Date.parse(item.date)) / 86_400_000
  const freshness = ageDays <= 7 ? 3 : ageDays <= 30 ? 1 : 0
  return hits + freshness
}

/**
 * Не больше `limit` записей с источника; порядок входа сохраняется.
 * Счётчики можно передать снаружи, чтобы потолок был сквозным для
 * нескольких проходов: иначе добор свежими начинает счёт заново и
 * приносит с одного издания вдвое больше обещанного.
 */
export function capPerSource(items, limit, counts = new Map()) {
  const out = []
  for (const item of items) {
    const n = counts.get(item.source) ?? 0
    if (n >= limit) continue
    counts.set(item.source, n + 1)
    out.push(item)
  }
  return out
}

/**
 * Раздаёт бюджет символов по отобранному списку: пока бюджет есть, статья
 * идёт целиком, дальше — заголовком с пометкой `textOmitted`. Пометка
 * важна: статья, которую урезали мы, — не то же самое, что статья,
 * которой издание не дало текста.
 */
export function withinTextBudget(items, maxChars) {
  let used = 0
  return items.map((item) => {
    const text = item.text ?? ''
    if (text && used + text.length <= maxChars) {
      used += text.length
      return item
    }
    if (!text) return item
    const { text: _dropped, ...rest } = item
    return { ...rest, textOmitted: true }
  })
}

/**
 * Полный отбор: релевантные по запросу, добитые свежими до нужного числа,
 * с потолком на источник и бюджетом символов.
 */
export function selectForQuery(
  all,
  { sphere, prompt, perSource, limit, maxChars, now = Date.now() },
) {
  const queryTerms = terms(`${sphere} ${prompt ?? ''}`)
  const scored = []
  for (const item of all) {
    const value = score(item, queryTerms, { now })
    if (value > 0) scored.push({ item, value })
  }
  scored.sort(
    (a, b) =>
      b.value - a.value ||
      Date.parse(b.item.date) - Date.parse(a.item.date) ||
      (a.item.url < b.item.url ? -1 : 1),
  )

  const counts = new Map()
  const chosen = capPerSource(
    scored.map((s) => s.item),
    perSource,
    counts,
  ).slice(0, limit)
  // Счётчики после среза: `slice` мог отбросить хвост, и эти статьи
  // источникам возвращаются, иначе потолок занижается.
  counts.clear()
  for (const item of chosen) counts.set(item.source, (counts.get(item.source) ?? 0) + 1)

  // Добор свежими: русский запрос по английским текстам может не дать ни
  // одного совпадения, и пустой ответ был бы хуже, чем лента дня 3.
  const matched = chosen.length
  if (chosen.length < limit) {
    const taken = new Set(chosen.map((i) => i.url))
    const rest = all.filter((i) => !taken.has(i.url))
    for (const item of capPerSource(rest, perSource, counts)) {
      if (chosen.length >= limit) break
      chosen.push(item)
    }
  }

  chosen.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || (a.url < b.url ? -1 : 1))
  return { items: withinTextBudget(chosen, maxChars), matched, terms: queryTerms }
}
