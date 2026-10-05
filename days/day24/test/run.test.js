// Правила показа запуска — исполнением (days/day24/public/run.js).
//
// Предмет здесь поведенческий: что страница скажет при таких-то данных. Все
// входы — то, что реально отдаёт `agents/src/rag-agent.js`; формы событий
// взяты из его же `emit` и из `agents/src/mcp/pipeline.js`, `rpcEvent`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ANSWER_BLANK,
  ANSWER_TORN,
  answerMeta,
  DAY_LIMIT_NOTE,
  dayLimitNote,
  FAILED_BEFORE_SEARCH,
  failedSections,
  failure,
  formatScore,
  fragmentsFromPlanning,
  fragmentSummary,
  fragmentTextNote,
  indexMeta,
  isBlank,
  MAX_QUESTION,
  CHECK_ROWS,
  CHECKS_NONE,
  CITED_RULE,
  claimedNote,
  CLAIMED_PREFIX,
  checkWord,
  citedNote,
  CITED_NONE,
  CITED_NONE_FILTER,
  CLARIFY_LABEL,
  keptWord,
  MODE_WORD,
  OUTCOME_NOTE,
  OUTCOME_NONE,
  outcomeNote,
  parseResult,
  plural,
  answerBlock,
  fromWord,
  PICK_RULE,
  QUOTE_EMPTY,
  QUOTE_UNVERIFIED,
  QUOTE_VERIFIED,
  quotesNote,
  QUOTES_NONE,
  QUOTES_NONE_FILTER,
  quotesTally,
  quoteCutNote,
  quoteWord,
  relevanceWord,
  rewriteSearchWord,
  selectionNote,
  selectNone,
  repoUrl,
  sourceUrl,
  SRCS_TORN_AFTER,
  SRCS_TORN_BEFORE,
  STATUS,
  statusFor,
  steps,
  strategyWord,
  tornSrcsNote,
  UNVERIFIED_NOTE,
  VERBATIM_NOTE,
} from '../public/run.js'

const COMMIT = '57a5cd7aa11bb22cc33dd44ee55ff6677889900a'

const result = (over = {}) => ({
  mode: 'rerank',
  outcome: 'answered',
  status: 'answered',
  answer: 'Ответ модели.',
  clarification: null,
  cited: [
    {
      n: 1,
      source: 'agent_docs/invariants.md',
      section: 'Расход средств › I-4',
      claimedSource: 'agent_docs/invariants.md',
      claimedSection: 'Расход средств › I-4',
    },
  ],
  quotes: [{ n: 1, text: 'строка', verified: true }],
  checks: { sources_present: true, quotes_present: true, quotes_verbatim: true, cited_exact: true },
  refused: false,
  sources: [
    { n: 1, source: 'agent_docs/invariants.md', section: 'Расход средств › I-4', score: 0.7142, text: 'строка\nвторая', truncated: false },
    { n: 2, source: 'rag/tools.py', section: '', score: 0.6551, text: '', truncated: false },
  ],
  index: { commit: COMMIT, strategy: 'structural', chunks: 3167 },
  rpc: { server: 'rag', method: 'tools/call', request: '{}', response: '{}', status: 200, ms: 800, clipped: false },
  tokens: 4312,
  budgetLeftUsd: 9.87,
  truncated: false,
  model: { id: 'anthropic-haiku' },
  durationMs: 3400,
  ...over,
})

test('разбор результата: пустой текст фрагмента и ОТСУТСТВИЕ поля — разные случаи', () => {
  const parsed = parseResult(result({ sources: [
    { n: 1, source: 'a.md', section: '', score: 0.5, text: '' },
    { n: 2, source: 'b.md', section: '', score: 0.5 },
  ] }))
  assert.equal(parsed.sources[0].text, '', 'пустой текст — пустая строка')
  assert.equal(parsed.sources[1].text, null, 'поля не было — null, а не пустая строка')
})

test('разбор результата не падает на чужом вводе и не выдумывает полей', () => {
  for (const bad of [null, undefined, 'строка', 42, [], { sources: 'нет', index: 'нет' }]) {
    const parsed = parseResult(bad)
    assert.equal(parsed.mode, null)
    assert.equal(parsed.answer, '')
    assert.equal(parsed.refused, false)
    assert.deepEqual(parsed.sources, [])
    assert.equal(parsed.index, null)
    assert.equal(parsed.tokens, null)
  }
})

test('признак отказа берётся ПОЛЕМ, а не поиском фразы в ответе', () => {
  // Ответ содержит фразу, но поля нет — отказом он не считается: сверку по
  // подстроке раскладка запрещает (п. 5.3).
  const sneaky = parseResult(result({ answer: 'В найденных фрагментах ответа нет', refused: undefined }))
  assert.equal(sneaky.refused, false)
  assert.equal(parseResult(result({ refused: true })).refused, true)
})

test('строка меры называет остаток бюджета остатком, а не ценой запроса', () => {
  const meta = answerMeta(parseResult(result()))
  assert.equal(meta, 'режим: с отбором · фрагментов: 2 · токенов ответа: 4312 · бюджет дня: остаток $9,87')
})

test('строка меры режима с отбором называет ОБА числа: сколько было и сколько осталось', () => {
  const meta = answerMeta(
    parseResult(
      result({
        mode: 'rerank',
        candidates: [
          { n: 1, source: 'a.md', score: 0.5, relevance: 2, kept: true },
          { n: 2, source: 'b.md', score: 0.4, relevance: 0, kept: false },
        ],
        sources: [{ n: 1, source: 'a.md', section: '', score: 0.5, text: 'т' }],
      }),
    ),
  )
  assert.ok(meta.includes('кандидатов: 2 → оставлено: 1'), meta)
})

test('чего не пришло, того в строке меры нет — нуля на его месте не бывает (I-8)', () => {
  const meta = answerMeta(parseResult(result({ tokens: null, budgetLeftUsd: null })))
  assert.equal(meta, 'режим: с отбором · фрагментов: 2')
})

test('шапка источников несёт короткий коммит и имя стратегии словом', () => {
  assert.equal(indexMeta(parseResult(result())), 'индекс 57a5cd7 · стратегия структурная · фрагментов 2')
  assert.equal(indexMeta(parseResult(result({ index: null }))), '')
})

test('имя стратегии — слово; незнакомый код не переводится и не прячется', () => {
  assert.equal(strategyWord('structural'), 'структурная')
  assert.equal(strategyWord('fixed'), 'фиксированная')
  assert.equal(strategyWord('semantic'), 'semantic', 'незнакомую стратегию страница не переименовывает')
  assert.equal(strategyWord(''), null)
  assert.equal(strategyWord(undefined), null)
})

test('путь ведёт на файл НА ТОМ КОММИТЕ; без коммита ссылки нет вовсе', () => {
  assert.equal(
    sourceUrl('agent_docs/invariants.md', COMMIT),
    `https://github.com/MikeKharr/ai-advent-2026/blob/${COMMIT}/agent_docs/invariants.md`,
  )
  assert.equal(sourceUrl('a.md', null), null, 'без коммита путь остаётся текстом')
  assert.equal(sourceUrl('a.md', 'не-коммит'), null, 'чужая форма коммита ссылкой не становится')
  assert.equal(sourceUrl('', COMMIT), null)
  // Путь — недоверенные данные: он уезжает в адрес и обязан быть закодирован.
  assert.ok(!sourceUrl('a/..?x=1#y.md', COMMIT).includes('?'))
})

test('близость — три знака, запятой; шкалы и цвета у неё нет', () => {
  assert.equal(formatScore(0.7142), '0,714')
  assert.equal(formatScore(0.6551), '0,655')
  assert.equal(formatScore(1), '1,000')
})

test('сводка свёртки считает знаки пришедшего текста и склоняет слово', () => {
  assert.equal(fragmentSummary('абв'), 'текст фрагмента · 3 знака')
  assert.equal(fragmentSummary('а'), 'текст фрагмента · 1 знак')
  assert.equal(fragmentSummary('а'.repeat(11)), 'текст фрагмента · 11 знаков')
  assert.equal(fragmentSummary(''), 'текст фрагмента · пусто')
  assert.equal(fragmentSummary(null), null, 'поля не было — свёртки нет')
})

test('частичный результат называется числами, а не прячется', () => {
  const parsed = parseResult(result())
  const sources = parsed.sources
  const partial = [{ text: 'есть' }, { text: null }, { text: null }]
  assert.equal(fragmentTextNote(partial), 'Текст пришёл у 1 фрагментов из 3.')
  assert.equal(fragmentTextNote([{ text: null }]), 'Текста фрагментов в этом ответе не пришло.')
  assert.equal(fragmentTextNote(sources), null, 'текст у всех — строки нет')
})

test('склонение после числа', () => {
  const f = (n) => plural(n, 'знак', 'знака', 'знаков')
  assert.deepEqual([1, 2, 5, 11, 21, 104].map(f), ['знак', 'знака', 'знаков', 'знаков', 'знак', 'знака'])
})

// ——— лента конвейера ———

const at = (sec) => new Date(Date.UTC(2026, 9, 4, 12, 0, sec)).toISOString()

const ragEvents = [
  { stage: 'received', at: at(0), data: { mode: 'rag', strategy: 'structural', limit: 5 } },
  { stage: 'rpc', at: at(1), data: { server: 'rag', method: 'tools/call', request: '{"a":1}', response: '{"b":2}', status: 200, ms: 800, clipped: false } },
  { stage: 'planning', at: at(1), data: { index: { commit: COMMIT }, sources: [1, 2, 3, 4, 5] } },
  { stage: 'llm_call', at: at(1), data: { provider: 'anthropic-haiku' } },
  { stage: 'llm_result', at: at(4), data: { usage: { inputTokens: 4000, outputTokens: 312 } } },
]

test('лента рага: шесть записей в порядке конвейера, сборка промпта — своя', () => {
  const list = steps(ragEvents)
  assert.deepEqual(
    list.map((s) => s.label),
    ['ПРИНЯТ ВОПРОС', 'ПОИСК ПО ПРОЕКТУ', 'ФРАГМЕНТЫ ПОЛУЧЕНЫ', 'СБОРКА ПРОМПТА', 'ВЫЗОВ МОДЕЛИ', 'ОТВЕТ МОДЕЛИ'],
  )
  // Стратегия и число фрагментов приехали из события `received`: в трейсе их
  // нет вовсе, и запись о поиске без этого переноса осталась бы без меры.
  assert.equal(list[1].meta, 'project.search по MCP · структурная · 5')
  assert.equal(list[2].meta, '5 фрагментов')
  assert.equal(list[3].meta, '5 фрагментов в контекст')
  assert.equal(list[5].meta, 'токенов 4312')
  // Время — ПОСЧИТАНО по событиям, а не придумано: тиканья нет.
  assert.deepEqual(list.map((s) => s.time), ['0 мс', '1,0 с', '1,0 с', '1,0 с', '1,0 с', '4,0 с'])
})

test('лента без RAG: три записи, призраков пропущенных шагов нет', () => {
  const list = steps([
    { stage: 'received', at: at(0), data: { mode: 'rerank' } },
    { stage: 'llm_call', at: at(0), data: {} },
    { stage: 'llm_result', at: at(3), data: { usage: { inputTokens: 100, outputTokens: 200 } } },
  ])
  assert.deepEqual(list.map((s) => s.label), ['ПРИНЯТ ВОПРОС', 'ВЫЗОВ МОДЕЛИ', 'ОТВЕТ МОДЕЛИ'])
  // «СБОРКА ПРОМПТА» без фрагментов не рисуется: собирать в контекст нечего.
  assert.ok(!list.some((s) => s.label === 'СБОРКА ПРОМПТА'))
})

test('запись поиска несёт тела как есть и отличает обрыв вызова от пустого ответа', () => {
  const broken = steps([
    { stage: 'received', at: at(0), data: { mode: 'rag', strategy: 'fixed', limit: 5 } },
    { stage: 'rpc', at: at(1), data: { request: '{"a":1}', response: '', status: null, ms: 10 } },
  ])
  assert.equal(broken[1].rpc.request, '{"a":1}')
  // Тело передаётся КАК ПРИШЛО: пустую строку страница не превращает в `null`
  // и обратно. Обрыв вызова опознаётся ОТСУТСТВИЕМ кода ответа, а не формой
  // пустоты, — иначе «служба ответила пустым» и «ответа не было» слились бы
  // в один случай, а у них разные слова и разный цвет (п. 10).
  assert.equal(broken[1].rpc.response, '')
  assert.equal(broken[1].rpc.status, null, 'по отсутствию кода и опознаётся обрыв')

  const empty = steps([
    { stage: 'received', at: at(0), data: { mode: 'rag' } },
    { stage: 'rpc', at: at(1), data: { request: '{}', response: '', status: 200, ms: 10 } },
  ])
  assert.equal(empty[1].rpc.status, 200, 'служба ответила — это не обрыв')
})

test('лента пуста, когда событий не было, и не падает на чужом вводе', () => {
  assert.deepEqual(steps([]), [])
  assert.deepEqual(steps([null, 'строка', {}, { stage: 'неизвестная', at: at(0) }]), [])
})

// ——— четыре отказа ———

test('окно службы поиска: названо общим, и сказано, что денег не стоило', () => {
  const f = failure(
    { code: 'search_refused', message: 'Слишком часто: не больше 10 запросов в минуту. Модель не вызывалась.', paidNothing: true },
    { status: 429 },
  )
  assert.equal(f.kind, 'rag_window')
  assert.match(f.lead, /общее на всех посетителей/)
  assert.match(f.lead, /денег не стоил/)
  // Слова службы уходят ОТДЕЛЬНЫМ полем, а не склеиваются с фразой: фраза
  // агента уже кончается «Модель не вызывалась.», и склейка сказала бы дважды.
  assert.equal(f.words, 'Слишком часто: не больше 10 запросов в минуту. Модель не вызывалась.')
  assert.equal(f.paidNothing, true)
})

test('поиск недоступен: слова службы показаны, и режим, которого нет, не предлагается', () => {
  for (const code of ['search_refused', 'search_failed', 'search_unavailable', 'search_empty']) {
    const f = failure({ code, message: 'NO_STRATEGY_INDEX: индекс стратегии не собран.', paidNothing: true })
    assert.equal(f.kind, 'search_down', code)
    assert.equal(f.words, 'NO_STRATEGY_INDEX: индекс стратегии не собран.')
    assert.match(f.tail, /Модель не вызывалась/)
    // НАХОДКА `design-review`: прежний текст предлагал «задать тот же вопрос в
    // режиме без RAG». Такого режима у дня 24 нет, и выбора режима на экране
    // нет вовсе — это был совет нажать несуществующую кнопку.
    assert.ok(!/без RAG|с RAG/.test(f.tail), f.tail)
    assert.match(f.tail, /Отвечать не по чему/)
  }
})

test('отказ службы на 429 и отказ инструмента различаются, хотя код у них один', () => {
  const same = { code: 'search_refused', message: 'слова', paidNothing: true }
  assert.equal(failure(same, { status: 429 }).kind, 'rag_window')
  assert.equal(failure(same, { status: null }).kind, 'search_down')
})

test('отказ после вызова модели не врёт, что денег не стоил', () => {
  const paid = failure({ code: 'router_error', message: 'роутер ответил 500', paidNothing: false })
  assert.equal(paid.kind, 'other')
  assert.match(paid.lead, /стоил денег/)
  const free = failure({ code: 'rate_limited', message: 'нет', paidNothing: true })
  assert.match(free.lead, /денег не стоил/)
})

test('слов у отказа нет — поля words нет, а не пустая строка на экране', () => {
  assert.equal(failure({ code: 'internal', message: '', paidNothing: true }).words, null)
  assert.equal(failure(undefined).words, null)
})

test('про деньги не утверждается ничего, когда сервер о них не сказал', () => {
  // Находка `compliance` и `reviewer` к PR #303: прежняя редакция считала
  // отсутствие поля за «денег не стоил», то есть утверждала про расход там,
  // где не знала ничего. Исходов три, и третий назван словами.
  const unknown = failure({ code: 'internal', message: 'внутренняя ошибка' })
  assert.equal(unknown.paidNothing, null, 'неизвестное выдано за известное')
  assert.match(unknown.lead, /сервер не сказал/)
  assert.ok(!/денег не стоил/.test(unknown.lead), 'страница всё-таки утверждает про деньги')
  assert.equal(failure(undefined).paidNothing, null)
  // А когда сказал — утверждается ровно сказанное.
  assert.match(failure({ code: 'x', paidNothing: true }).lead, /денег не стоил/)
  assert.match(failure({ code: 'x', paidNothing: false }).lead, /стоил денег/)
})

/**
 * Строка про суточный предел ставится ТОЛЬКО там, где он и исчерпан.
 *
 * Находка `design-review`: страница ставила её на любой 429, и экран
 * противоречил сам себе — «слишком часто» в строке состояния и «суточный
 * предел исчерпан» под ней при `callsToday` 1 из 3. Находка `compliance`: у
 * первой правки не было держателя — снятие условия оставляло все 315 тестов
 * зелёными. Этот тест и есть держатель, и он исполняет правило, а не сверяет
 * исходный текст.
 *
 * Вход — ровно то, что приходит со сервера дня: у суточного потолка
 * `retryAfterSec` равен `null` (`limits.js`, ветвь `daily`), у минутного и
 * часового окна это число секунд.
 */
test('суточный предел называется исчерпанным только когда он исчерпан', () => {
  assert.equal(dayLimitNote(429, null), DAY_LIMIT_NOTE, 'потолок не назван')
  assert.match(DAY_LIMIT_NOTE, /суточный предел вопросов исчерпан/)
  // Окна: строки нет вовсе — достоверные слова уже в строке состояния.
  for (const sec of [60, 1800, 3599, 1]) assert.equal(dayLimitNote(429, sec), null, `окно на ${sec} с`)
  // Ноль — тоже число, то есть окно, а не потолок.
  assert.equal(dayLimitNote(429, 0), null, 'ноль секунд принят за потолок')
})

/**
 * Обрыв потока: ни одна секция не остаётся с утверждением, которое обрыв
 * сделал ложным.
 *
 * Блокирующая `design-review` к PR #303: «Источники» оставались на «Ищу
 * фрагменты…» навсегда — настоящее время рядом с красной строкой о том, что
 * запуск кончился, — а блок «Ответ» был пустой областью высотой 0 px.
 * Правило вынесено сюда и держится ИСПОЛНЕНИЕМ: в прошлом круге того же PR
 * `compliance` показал, что правило, оставленное в обработчике, обходится не
 * тронув ни одной проверенной строки.
 */
test('при обрыве потока секция источников не обещает идущий поиск', () => {
  // Число фрагментов успело прийти и не успело — РАЗНЫЕ случаи, и они не
  // сливаются. Различитель именно такой, а не «стадия `planning` пришла»:
  // `fragmentsFound` остаётся `null` и когда стадия пришла с `sources`
  // не-массивом (находка `reviewer` к PR #303).
  assert.equal(tornSrcsNote('rerank', 5), SRCS_TORN_AFTER, 'доложившийся поиск назван недоложившимся')
  assert.equal(tornSrcsNote('rerank', 0), SRCS_TORN_AFTER, 'ноль фрагментов — тоже доклад')
  assert.equal(tornSrcsNote('rerank', null), SRCS_TORN_BEFORE, 'недоложившийся поиск назван доложившимся')
  assert.notEqual(SRCS_TORN_AFTER, SRCS_TORN_BEFORE, 'два случая одними словами')
  // Ни один из них не ставит поиск в настоящее время.
  for (const text of [SRCS_TORN_AFTER, SRCS_TORN_BEFORE])
    assert.ok(!/Ищу/.test(text), `обещает идущий поиск: ${text}`)
  // Режим без RAG не трогаем: там стоит SRCS_NORAG, и обрыв этого не меняет.
  for (const mode of ['norag', null, undefined, 'что-то третье'])
    assert.equal(tornSrcsNote(mode, 5), null, `режим ${mode} переписан`)
})

test('при обрыве потока блок ответа говорит словами и молчит про деньги', () => {
  assert.ok(ANSWER_TORN.length > 0, 'пустое место на месте главного предмета экрана (I-8)')
  assert.match(ANSWER_TORN, /оборвался/)
  // Был ли вызов модели оплачен, с оборванного потока не видно.
  for (const word of ['денег', 'бесплатн', 'не стоил', 'потрачен'])
    assert.ok(!ANSWER_TORN.includes(word), `утверждает про расход: ${word}`)
})

test('при деградации страница молчит про причину, а не угадывает её', () => {
  // Тело 429 не разобралось либо поля нет: утверждать причину нельзя.
  assert.equal(dayLimitNote(429, undefined), null, 'поля нет — причина выдумана')
  // Не 429 — строка не про этот случай вовсе.
  for (const status of [200, 400, 502, 0]) assert.equal(dayLimitNote(status, null), null, `статус ${status}`)
})

test('путь из файла итогов кодируется так же, как путь из выдачи поиска', () => {
  assert.equal(repoUrl('agent_docs/guides/dod.md'), `${'https://github.com/MikeKharr/ai-advent-2026/blob'}/main/agent_docs/guides/dod.md`)
  assert.equal(repoUrl(''), null)
  assert.equal(repoUrl(null), null)
  // Две соседние ветви одного показа не расходятся: один и тот же путь даёт
  // одинаково закодированный хвост.
  const odd = 'a b/c?d#e.md'
  assert.equal(repoUrl(odd).split('/main/')[1], sourceUrl(odd, COMMIT).split(`/${COMMIT}/`)[1])
  assert.ok(!repoUrl(odd).includes('?') && !repoUrl(odd).includes('#'))
})

test('пустой и пробельный ответ при удачном запуске — один случай', () => {
  // Пустое место на месте главного предмета экрана — та же заглушка, что «—»
  // (I-8), только невидимая. Пробельный ответ считается тем же случаем:
  // «\n  \n» даёт не состояние, а пустую полосу.
  for (const text of ['', '   ', '\n  \n', undefined, null, 42]) assert.equal(isBlank(text), true, JSON.stringify(text))
  for (const text of ['ответ', ' а ', 'В найденных фрагментах ответа нет']) assert.equal(isBlank(text), false, text)
  assert.match(ANSWER_BLANK, /Вызов при этом состоялся/, 'не сказано, что деньги потрачены')
})

test('строка состояния называет числа из событий, а не из разметки', () => {
  assert.equal(STATUS.asking(5), 'Отбор оставил 5. Спрашиваю модель…')
  assert.equal(STATUS.found(5), 'Поиск вернул 5 фрагментов. Отбираю…')
  assert.equal(STATUS.done(3400), 'Готово за 3,4 с.')
  assert.equal(STATUS.long, `Не отправлено: вопрос длиннее ${MAX_QUESTION} знаков.`)
})

// ——— отбор второй ступенью (ADR 2026-10-05-0544, пп. 1.2–1.4) ———

const cands = [
  { n: 1, source: 'agent_docs/invariants.md', section: 'I-4', score: 0.71, relevance: 2, kept: true },
  { n: 2, source: 'rag/tools.py', section: '', score: 0.65, relevance: 1, kept: true },
  { n: 3, source: 'README.md', section: '', score: 0.61, relevance: 0, kept: false },
]

test('кандидаты разбираются по одному, и порядок не пересортировывается', () => {
  const parsed = parseResult(result({ mode: 'rerank', candidates: cands }))
  assert.deepEqual(
    parsed.candidates.map((c) => c.n),
    [1, 2, 3],
  )
  assert.equal(parsed.candidates[2].kept, false)
  // Не массив, мусор внутри, поля нет вовсе — пустой список, а не падение.
  for (const raw of [undefined, null, 'нет', [1, 'два', null]])
    assert.deepEqual(parseResult(result({ candidates: raw })).candidates.length === 0, true)
})

test('«не оценивал» и «оценил нулём» — разные вещи, и ноль не подставляется (I-8)', () => {
  const parsed = parseResult(
    result({ mode: 'rerank', candidates: [{ n: 1, source: 'a.md', score: 0.5, kept: false }] }),
  )
  assert.equal(parsed.candidates[0].relevance, null, 'отсутствие оценки стало нулём')
  assert.equal(relevanceWord(null), '', 'на месте неоценённого появилось слово')
  assert.equal(relevanceWord(0), 'не относится')
  assert.equal(relevanceWord(2), 'отвечает')
  // Незнакомая оценка показывается как пришла, а не прячется.
  assert.equal(relevanceWord(7), '7')
})

test('`kept` приходит полем и не выводится страницей из релевантности', () => {
  // Агент сказал «отброшен» при релевантности 2 — страница показывает то, что
  // сказал агент: порог отбора держит он, и второго правила здесь нет.
  const parsed = parseResult(
    result({ mode: 'rerank', candidates: [{ n: 1, source: 'a.md', relevance: 2, kept: false }] }),
  )
  assert.equal(parsed.candidates[0].kept, false)
  assert.equal(keptWord(false), 'отброшен')
  assert.equal(keptWord(true), 'оставлен')
})

test('строка над таблицей считает по пришедшему, а не по потолку из разметки', () => {
  const parsed = parseResult(result({ mode: 'rerank', candidates: cands }))
  assert.equal(selectionNote(parsed), 'Кандидатов: 3. Оставлено отбором: 2.')
  assert.equal(selectionNote(parseResult(result())), null, 'строка о кандидатах без кандидатов')
})

test('числа порога на экране нет: агент его не отдаёт, и страница его не выдумывает', () => {
  // ADR (п. 1.1) называл порог числом на экране, но в контракте запуска такого
  // поля нет. Печатать литерал значило бы показать число, которого никто не
  // считал, — и как раз про доверие к отбору.
  assert.ok(!/\d/.test(PICK_RULE), `в подписи про отбор появилось число: ${PICK_RULE}`)
  assert.match(PICK_RULE, /не близость/)
})

test('откуда пришёл кандидат — слово, а незнакомый код показывается как есть', () => {
  assert.equal(fromWord('original'), 'исходный запрос')
  assert.equal(fromWord('rewritten'), 'переписанный')
  assert.equal(fromWord('both'), 'оба запроса')
  assert.equal(fromWord(null), '')
  assert.equal(fromWord('что-то'), 'что-то')
})

test('шаблон пустого отбора называет число найденных и НЕ врёт про вызов', () => {
  assert.match(selectNone(10), /ни один из 10 найденных/)
  assert.match(selectNone(1), /ни один из 1 найденного/)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ против дня 23: там при пустом отборе модель ответа не
  // вызывалась, здесь вызывается (решение владельца Р5(б)). Слова дня 23 были
  // бы здесь ложью про расход, и их тут быть не должно.
  assert.ok(!/не вызывалась/.test(selectNone(10)), selectNone(10))
  assert.match(selectNone(10), /модель спросили без фрагментов/)
  // Числа не было — фразы с числом нет, а не «ни один из 0».
  assert.ok(!/\d/.test(selectNone(null)), selectNone(null))
  // Ни одного слова про промах, выдумку или поломку: именно их смешение в
  // одном вердикте и есть долг дня 22, который закрывает форма дня 24.
  assert.ok(!/выдум|промах|ошиб|сломал/i.test(selectNone(10)), selectNone(10))
})

test('переписанный вопрос: пустая строка и пробелы — это НЕ переписанный вопрос', () => {
  assert.equal(parseResult(result({ rewritten: 'инвариант I-4 держатель' })).rewritten, 'инвариант I-4 держатель')
  for (const raw of ['', '   ', null, undefined, 42])
    assert.equal(parseResult(result({ rewritten: raw })).rewritten, null, String(raw))
})

test('режимов ровно два, и чужое значение режимом не становится', () => {
  assert.deepEqual(Object.keys(MODE_WORD), ['rerank', 'rewrite'])
  // `rag` — режим дня 23, и днём 24 он не принимается: контракт называет два.
  for (const m of ['rag', 'norag', 'RERANK', '', null, 7])
    assert.equal(parseResult(result({ mode: m })).mode, null, String(m))
})

test('номер фрагмента не перенумеровывается и не выдумывается', () => {
  // Номера идут С ПРОПУСКАМИ: под ними фрагмент стоит в тексте ответа
  // (контракт, «Нумерация»). Порядковое место в списке номером не является.
  const parsed = parseResult(
    result({
      sources: [
        { n: 2, source: 'a.md', section: '', score: 0.7, text: 'т' },
        { n: 7, source: 'b.md', section: '', score: 0.6, text: 'т' },
        { n: 3, source: 'c.md', section: '', score: 0.5, text: 'т' },
      ],
    }),
  )
  assert.deepEqual(
    parsed.sources.map((s) => s.n),
    [2, 7, 3],
  )
  // Номера не пришло — его нет, а не «первый по счёту».
  assert.equal(parseResult(result({ sources: [{ source: 'a.md' }] })).sources[0].n, null)
})

test('исход читается полем, а не выводится из того, что источников нет', () => {
  assert.equal(parseResult(result({ outcome: 'unknown_filter' })).outcome, 'unknown_filter')
  assert.equal(parseResult(result({ outcome: 'answered' })).outcome, 'answered')
  for (const raw of [undefined, null, 'что-то', 7])
    assert.equal(parseResult(result({ outcome: raw })).outcome, null, String(raw))
})

// ——— лента: три вызова модели различаются только по `data.purpose` ———

test('вызовы модели подписаны по назначению, а не одинаково', () => {
  const rows = steps([
    { stage: 'received', at: at(0), data: { mode: 'rewrite', strategy: 'structural', limit: 10 } },
    { stage: 'rpc', at: at(1), data: { request: '{}', response: '{}', status: 200 } },
    { stage: 'planning', at: at(1), data: { sources: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } },
    { stage: 'llm_call', at: at(2), data: { purpose: 'rewrite' } },
    { stage: 'llm_result', at: at(2), data: { purpose: 'rewrite', usage: { inputTokens: 100, outputTokens: 20 } } },
    { stage: 'planning', at: at(3), data: { rewritten: 'инвариант I-4', found: 7 } },
    { stage: 'llm_call', at: at(3), data: { purpose: 'rerank' } },
    { stage: 'llm_result', at: at(4), data: { purpose: 'rerank', usage: { inputTokens: 900, outputTokens: 60 } } },
    { stage: 'planning', at: at(4), data: { kept: 3, candidates: 10 } },
    { stage: 'llm_call', at: at(5), data: {} },
    { stage: 'llm_result', at: at(7), data: { usage: { inputTokens: 2000, outputTokens: 300 } } },
  ]).map((r) => r.label)

  assert.deepEqual(rows, [
    'ПРИНЯТ ВОПРОС',
    'ПОИСК ПО ПРОЕКТУ',
    'ФРАГМЕНТЫ ПОЛУЧЕНЫ',
    'ПЕРЕПИСЫВАНИЕ ВОПРОСА',
    'ЗАПРОС ПЕРЕПИСАН',
    'ИТОГ ПЕРЕПИСЫВАНИЯ',
    'ОЦЕНКА КАНДИДАТОВ',
    'КАНДИДАТЫ ОЦЕНЕНЫ',
    'ОТБОР',
    'СБОРКА ПРОМПТА',
    'ВЫЗОВ МОДЕЛИ',
    'ОТВЕТ МОДЕЛИ',
  ])
})

test('«сборка промпта» рисуется один раз, а не перед каждым из трёх вызовов', () => {
  const rows = steps([
    { stage: 'received', at: at(0), data: { mode: 'rerank' } },
    { stage: 'planning', at: at(1), data: { sources: [1, 2] } },
    { stage: 'llm_call', at: at(2), data: { purpose: 'rerank' } },
    { stage: 'llm_call', at: at(3), data: {} },
    { stage: 'llm_call', at: at(4), data: {} },
  ]).filter((r) => r.label === 'СБОРКА ПРОМПТА')
  assert.equal(rows.length, 1, `записей сборки промпта ${rows.length}`)
})

test('итог отбора в ленте называет оба числа', () => {
  const row = steps([
    { stage: 'received', at: at(0), data: { mode: 'rerank' } },
    { stage: 'planning', at: at(1), data: { kept: 3, candidates: 10 } },
  ]).at(-1)
  assert.equal(row.label, 'ОТБОР')
  assert.equal(row.meta, 'оставлено 3 из 10')
})

test('отказ реранкера по схеме — оплаченный, и страница про деньги не врёт', () => {
  const f = failure({ code: 'rerank_invalid', message: 'ответ не по схеме', paidNothing: false })
  assert.match(f.lead, /вызов модели при этом состоялся/)
  assert.equal(f.words, 'ответ не по схеме')
  // Отказы поиска — наоборот: они наступают ДО первого вызова модели.
  for (const code of ['search_unavailable', 'search_failed', 'search_empty'])
    assert.match(failure({ code, message: 'сломалось', paidNothing: true }).lead, /Поиск недоступен/)
})

// ——— что стоит в блоке «Ответ»: решает правило, а не обработчик ———

/** Ровно то, что отдаёт агент при `unknown_filter`: ответа нет, `refused` стоит. */
const unknown = (over = {}) =>
  parseResult(
    result({
      mode: 'rerank',
      outcome: 'unknown_filter',
      answer: null,
      refused: true,
      sources: [],
      candidates: cands.map((c) => ({ ...c, relevance: 0, kept: false })),
      ...over,
    }),
  )

test('блок ответа несёт слова ИСХОДА, и они приходят полем', () => {
  // Четыре исхода — четыре разных текста, и каждый берётся по полю `outcome`.
  for (const [outcome, note] of Object.entries(OUTCOME_NOTE)) {
    const block = answerBlock(parseResult(result({ outcome, answer: 'Текст.' })))
    assert.equal(block.note, note, outcome)
  }
  // Исхода не пришло — страница говорит об этом, а не выбирает исход сама.
  assert.equal(answerBlock(parseResult(result({ outcome: undefined }))).note, OUTCOME_NONE)
  assert.equal(answerBlock(parseResult(result({ outcome: 'что-то' }))).note, OUTCOME_NONE)
})

test('тексты четырёх исходов дословные и ни один не назван сбоем', () => {
  assert.deepEqual(Object.keys(OUTCOME_NOTE), [
    'answered',
    'unknown_filter',
    'unknown_model',
    'unsupported',
  ])
  // Оба «не знаю» названы исходом ПРЯМО: в дне 22 честный отказ читался как
  // сбой, и это тот самый долг, который закрывает форма дня 24.
  for (const key of ['unknown_filter', 'unknown_model'])
    assert.match(OUTCOME_NOTE[key], /исход[^.]*, а не сбой/i, key)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ про расход: при пустом отборе вызов БЫЛ (решение
  // владельца Р5(б)), и исход обязан это сказать, а не умолчать.
  assert.match(OUTCOME_NOTE.unknown_filter, /вызов состоялся/)
  // «Ответ без подтверждения» не назван ни верным, ни выдуманным: сверка
  // ловит форму, а не правду.
  assert.ok(!/выдум|солгал|неверн/i.test(OUTCOME_NOTE.unsupported), OUTCOME_NOTE.unsupported)
  assert.match(OUTCOME_NOTE.unsupported, /проверить этот ответ по источникам нечем/)
  // И ни один из четырёх не пуст: дословность проверяется по длине тоже.
  for (const [key, text] of Object.entries(OUTCOME_NOTE)) assert.ok(text.length > 40, key)
  assert.equal(outcomeNote('answered'), OUTCOME_NOTE.answered)
})

test('пустой ответ при состоявшемся вызове — по-прежнему «вызов состоялся»', () => {
  const block = answerBlock(parseResult(result({ answer: '   ' })))
  assert.equal(block.kind, 'blank')
  assert.match(block.text, /Вызов при этом состоялся/)
  // Слова исхода остаются и здесь: текста нет, а исход был.
  assert.equal(block.note, OUTCOME_NOTE.answered)
})

// ——— добавка дня 24: схема, цитаты, проверки ———

test('поля схемы разбираются по одному, и чужое значение полем не становится', () => {
  const parsed = parseResult(result())
  assert.equal(parsed.status, 'answered')
  assert.deepEqual(parsed.cited, [
    {
      n: 1,
      source: 'agent_docs/invariants.md',
      section: 'Расход средств › I-4',
      claimedSource: 'agent_docs/invariants.md',
      claimedSection: 'Расход средств › I-4',
    },
  ])
  // `truncated: false` у цитаты, в ответе которой поля нет вовсе: запуск шёл
  // до обрезки, и это молчание, а не «обрезана».
  assert.deepEqual(parsed.quotes, [{ n: 1, text: 'строка', verified: true, truncated: false }])
  assert.deepEqual(parsed.checks, {
    sources_present: true,
    quotes_present: true,
    quotes_verbatim: true,
    cited_exact: true,
  })
  for (const bad of ['refused', '', null, 7])
    assert.equal(parseResult(result({ status: bad })).status, null, String(bad))
  // Пустая `clarification` — то же, что её нет: показывать пустой вопрос нечем.
  for (const bad of ['', '   ', null, 7])
    assert.equal(parseResult(result({ clarification: bad })).clarification, null, String(bad))
  assert.equal(parseResult(result({ clarification: 'Какую единицу?' })).clarification, 'Какую единицу?')
  // Проверок не пришло — `null`, а НЕ три «нет»: непришедшее не проваленное.
  assert.equal(parseResult(result({ checks: undefined })).checks, null)
  assert.deepEqual(parseResult(result({ checks: { sources_present: 'да' } })).checks, {
    sources_present: null,
    quotes_present: null,
    quotes_verbatim: null,
    cited_exact: null,
  })
  // `verified` приходит полем и строго `true`: всё прочее — «не нашлась».
  for (const bad of ['true', 1, undefined])
    assert.equal(parseResult(result({ quotes: [{ n: 1, text: 'т', verified: bad }] })).quotes[0].verified, false, String(bad))
})

test('признак проверки знает ТРИ состояния, а не два', () => {
  assert.equal(checkWord(true), 'да')
  assert.equal(checkWord(false), 'нет')
  // «Сервер не сказал» — отдельное слово: назвать непришедшее «нет» значило бы
  // объявить проверку проваленной, не имея на это ничего (I-8).
  assert.equal(checkWord(null), 'сервер не сказал')
  assert.deepEqual(
    CHECK_ROWS.map(([key]) => key),
    ['sources_present', 'quotes_present', 'quotes_verbatim', 'cited_exact'],
  )
  assert.match(VERBATIM_NOTE, /все цитаты до единой/)
  assert.ok(CHECKS_NONE.length > 10)
})

test('сверка цитаты — слово-наблюдение, а не вердикт', () => {
  assert.equal(quoteWord(true), QUOTE_VERIFIED)
  assert.equal(quoteWord(false), QUOTE_UNVERIFIED)
  // Ни «соврала», ни «выдумала»: цитата может не найтись и у верного ответа,
  // если фрагмент обрезан на выдаче.
  assert.ok(!/выдум|солгал|ошиб/i.test(QUOTE_UNVERIFIED), QUOTE_UNVERIFIED)
  assert.match(UNVERIFIED_NOTE, /не выбрасывается/)
  assert.ok(QUOTE_EMPTY.length > 10)
})

test('строка над цитатами считает подтверждённые по пришедшему', () => {
  const two = [{ n: 1, text: 'а', verified: true }, { n: 2, text: 'б', verified: false }]
  assert.equal(quotesTally(two), 'Цитат: 2. Нашлись во фрагменте дословно: 1.')
  assert.equal(quotesTally([]), null, 'строка о цитатах без цитат')
})

test('пустые cited и quotes при пустом отборе объясняются построением, а не упрёком', () => {
  const answered = parseResult(result({ cited: [], quotes: [] }))
  assert.equal(citedNote(answered), CITED_NONE)
  assert.equal(quotesNote(answered), QUOTES_NONE)
  // А при пустом отборе ссылаться и цитировать было НЕ НА ЧТО по построению —
  // и «модель не сослалась» прозвучало бы упрёком вместо описания.
  const filtered = unknown({ cited: [], quotes: [] })
  assert.equal(citedNote(filtered), CITED_NONE_FILTER)
  assert.equal(quotesNote(filtered), QUOTES_NONE_FILTER)
  // Есть цитаты — строки нет вовсе: её место занимает список.
  assert.equal(quotesNote(parseResult(result())), null)
  assert.equal(citedNote(parseResult(result())), null)
  assert.ok(CLARIFY_LABEL.length > 0)
})

// ДЕФЕКТ, НАЙДЕННЫЙ ГЕЙТАМИ ДНЯ 23 И ПЕРЕНЕСЁННЫЙ СЮДА КОПИЕЙ. Событие итога
// переписывания приходит БЕЗ поля `rewritten`, когда нового запроса не вышло
// (контракт дня 23: `rewriteSearch: "skipped"`). Прежняя ветвь различала эти
// события по наличию строки `rewritten` и роняла такое событие в
// «ФРАГМЕНТЫ ПОЛУЧЕНЫ» с пустой подписью: лента объявляла пройденным шаг,
// которого не было, и теряла шаг, который был.
test('итог переписывания без нового запроса не выдаётся за выдачу поиска', () => {
  const rows = steps([
    { stage: 'received', at: at(0), data: { mode: 'rewrite', strategy: 'structural', limit: 10 } },
    { stage: 'planning', at: at(1), data: { sources: [1, 2, 3] } },
    { stage: 'planning', at: at(2), data: { rewritten: null, rewriteSearch: 'skipped' } },
  ])
  assert.deepEqual(
    rows.map((r) => r.label),
    ['ПРИНЯТ ВОПРОС', 'ФРАГМЕНТЫ ПОЛУЧЕНЫ', 'ИТОГ ПЕРЕПИСЫВАНИЯ'],
  )
  // И подпись говорит, ЧТО именно случилось, а не молчит пустотой.
  assert.equal(rows[2].meta, 'нового запроса не вышло — искали только исходный')
})

test('каждое состояние второго поиска названо своим словом', () => {
  assert.equal(rewriteSearchWord('skipped'), 'нового запроса не вышло — искали только исходный')
  // «Нашёл ноль» и «запроса не вышло» — РАЗНЫЕ вещи, и обе не сбой запуска.
  assert.equal(rewriteSearchWord('empty'), 'по переписанному не нашлось ничего')
  assert.equal(rewriteSearchWord('failed'), 'поиск по переписанному не удался')
  assert.equal(rewriteSearchWord('ok', 7), '7 фрагментов')
  assert.equal(rewriteSearchWord('ok', 1), '1 фрагмент')
  // Числа не пришло — подписи нет, а не «0 фрагментов» (I-8).
  assert.equal(rewriteSearchWord('ok', null), '')
  // Незнакомый код показывается как пришёл: выдумывать ему перевод нельзя.
  assert.equal(rewriteSearchWord('что-то'), 'что-то')
})

// ДЕФЕКТ ТОЙ ЖЕ ПАРТИИ: стадия `planning` приходит до трёх раз, и прежняя
// строка обработчика стирала уже известное число фрагментов каждым следующим
// событием. Последствие видно на экране: поток, оборванный ПОСЛЕ отбора,
// получал «поток оборвался раньше, чем поиск что-то вернул» — ложь про шаг,
// который прошёл.
test('число фрагментов не стирается событиями, у которых своих чисел нет', () => {
  // Выдача поиска: число стало известно.
  const none = { found: null, kept: null }
  assert.deepEqual(fragmentsFromPlanning({ sources: [1, 2, 3] }, none), { found: 3, kept: null })
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: итог переписывания своих `sources` не несёт, и прежнее
  // число обязано уцелеть — иначе строка обрыва солжёт.
  const afterSearch = { found: 3, kept: null }
  assert.deepEqual(fragmentsFromPlanning({ rewritten: 'запрос', found: 7 }, afterSearch), afterSearch)
  assert.deepEqual(fragmentsFromPlanning({ rewriteSearch: 'skipped' }, afterSearch), afterSearch)
  // ДВА ЧИСЛА, А НЕ ОДНО: итог отбора кладётся в `kept` и НЕ затирает `found`.
  // Прежняя редакция держала одно поле, и «поиск вернул 3» после отбора
  // превращалось в «поиск вернул 2» — ложь про чужой шаг (находка гейтов дня 23).
  assert.deepEqual(fragmentsFromPlanning({ kept: 2, candidates: 10 }, afterSearch), { found: 3, kept: 2 })
  // Ноль оставленных — это ноль, а не «неизвестно»: исход «не знаю» тоже факт.
  assert.deepEqual(fragmentsFromPlanning({ kept: 0 }, afterSearch), { found: 3, kept: 0 })
  // Ничего не пришло — прежнее знание не меняется, в том числе пустое.
  assert.deepEqual(fragmentsFromPlanning({}, afterSearch), afterSearch)
  assert.deepEqual(fragmentsFromPlanning(undefined, none), none)
})

test('строка состояния называет РАЗНОЕ до отбора и после — и разными словами', () => {
  // «Поиск вернул N» верно только до отбора. После него на экране обязано
  // стоять, сколько ОСТАЛОСЬ: одно число на два смысла и было находкой.
  assert.equal(statusFor({ found: 10, kept: null }), 'Поиск вернул 10 фрагментов. Отбираю…')
  assert.equal(statusFor({ found: 1, kept: null }), 'Поиск вернул 1 фрагмент. Отбираю…')
  assert.equal(statusFor({ found: 10, kept: 2 }), 'Отбор оставил 2. Спрашиваю модель…')
  // Ноль оставленных — тоже число: исход «не знаю» не прячется за «спрашиваю».
  assert.equal(statusFor({ found: 10, kept: 0 }), 'Отбор оставил 0. Спрашиваю модель…')
  // Чисел не было — общая фраза, а не «Поиск вернул 0» (I-8).
  assert.equal(statusFor({ found: null, kept: null }), STATUS.askingPlain)
  assert.equal(statusFor(undefined), STATUS.askingPlain)
})

// НАХОДКА `design-review`: обе секции ставили «Поиск отказал» и «Отбора не
// было» на ЛЮБОЙ отказ — в том числе на те, что наступают ПОСЛЕ удавшегося
// поиска и отбора, которые видны в ленте выше.
test('при отказе секции говорят про шаги то, что конвейер успел доложить', () => {
  // Поиск не доложился — и только тогда про него сказано «не доложился».
  assert.deepEqual(failedSections({ found: null, kept: null }), FAILED_BEFORE_SEARCH)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: поиск доложился, отбор — нет (например, реранкер
  // ответил не по схеме). Прежние слова объявили бы непройденным поиск.
  const midway = failedSections({ found: 10, kept: null })
  assert.match(midway.srcs, /Поиск вернул 10 фрагментов/)
  assert.ok(!/не доложился/.test(midway.srcs), midway.srcs)
  assert.match(midway.pick, /Отбор не доложился/)
  // И третий случай: оба шага прошли, не состоялся сам ответ.
  const late = failedSections({ found: 10, kept: 2 })
  assert.match(late.srcs, /Отбор оставил 2 из 10/)
  assert.match(late.pick, /Отбор прошёл и оставил 2 из 10/)
  assert.ok(!/не было|отказал/.test(late.pick), late.pick)
})

test('оборванный после отбора поток говорит, что поиск УСПЕЛ доложиться', () => {
  // Та самая сцена дефекта, собранная из событий: поиск доложился, отбор
  // доложился, поток оборвался.
  let counts = { found: null, kept: null }
  for (const data of [{ sources: [1, 2, 3] }, { rewriteSearch: 'skipped' }, { kept: 2, candidates: 3 }])
    counts = fragmentsFromPlanning(data, counts)
  assert.deepEqual(counts, { found: 3, kept: 2 })
  // Секция источников спрашивает про ПОИСК, то есть про `found`, — не про то,
  // что оставил отбор.
  assert.equal(tornSrcsNote('rewrite', counts.found), SRCS_TORN_AFTER)
  // А оборвись поток до выдачи поиска — слова были бы другими, и это
  // различающий случай, а не та же строка на оба.
  assert.equal(tornSrcsNote('rewrite', fragmentsFromPlanning({}, undefined).found), SRCS_TORN_BEFORE)
})

// НАХОДКА `design-review` ДНЯ 23, перенесённая сюда копией: подпись «токенов»
// называла полным расходом число, которое считает только вызов ответа.
test('подпись токенов говорит, что это токены ОТВЕТА, а не всего запуска', () => {
  const meta = answerMeta(parseResult(result()))
  assert.match(meta, /токенов ответа: 4312/)
  // Старая подпись не должна вернуться: именно она читалась как весь расход.
  assert.ok(!/·\s*токенов: /.test(meta), meta)
  // Числа не пришло — куска нет вовсе, а не «токенов ответа: 0» (I-8).
  assert.ok(!/токенов/.test(answerMeta(parseResult(result({ tokens: undefined })))))
})

// БЛОКИРУЮЩАЯ `compliance` к PR #315. Контракт агента (#314) отдаёт путь из
// ОТБОРА по номеру, а заявленное моделью — отдельными полями `claimed*` с
// признаком `checks.cited_exact`. Страница их роняла: при `cited_exact: false`
// экран показывал три «да» и выдавал чужой путь за названный моделью.

test('четвёртая проверка есть, и без неё три первых врут вместе', () => {
  assert.deepEqual(
    CHECK_ROWS.map(([key]) => key),
    ['sources_present', 'quotes_present', 'quotes_verbatim', 'cited_exact'],
  )
  // Ярлык называет, КТО назвал путь: признак про ответ модели, а не про отбор.
  assert.match(CHECK_ROWS[3][1], /назван моделью точно/)
  // Признак приходит полем и знает те же три состояния, что остальные.
  assert.equal(parseResult(result({ checks: { cited_exact: false } })).checks.cited_exact, false)
  assert.equal(parseResult(result({ checks: { cited_exact: 'нет' } })).checks.cited_exact, null)
  // И подпись под проверками говорит, что сравнение ТОЧНОЕ, а не по подстроке:
  // подстрочная механика дня 22 ошибалась в обе стороны (q72, q57).
  assert.match(VERBATIM_NOTE, /сравнивает пути точно, знак в знак/)
  assert.ok(!/подстрок/.test(VERBATIM_NOTE.replace('а не ищет путь подстрокой в тексте ответа.', '')))
})

test('заявленный моделью путь едет рядом и показывается ТОЛЬКО при расхождении', () => {
  const parsed = parseResult(result())
  // Совпало — строки нет: «модель назвала: тот же путь» было бы шумом.
  assert.equal(claimedNote(parsed.cited[0]), null)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: модель назвала чужой путь. Без этой строки расхождение
  // видно одной клеткой «нет» в проверках — без имени.
  const wrong = parseResult(
    result({
      cited: [{ n: 1, source: 'agent_docs/invariants.md', section: '', claimedSource: 'agent_docs/выдумка.md' }],
    }),
  )
  assert.equal(claimedNote(wrong.cited[0]), `${CLAIMED_PREFIX}agent_docs/выдумка.md`)
  // Поля не было или оно пусто — это НЕ «совпало», но и показывать нечего:
  // «модель пути не называла» и «назвала тот же» — разные вещи (I-8).
  for (const bad of [undefined, null, '', 7]) {
    const q = parseResult(result({ cited: [{ n: 1, source: 'a.md', section: '', claimedSource: bad }] }))
    assert.equal(q.cited[0].claimedSource, typeof bad === 'string' ? bad : null, String(bad))
    assert.equal(claimedNote(q.cited[0]), null, String(bad))
  }
})

test('подпись секции говорит, откуда взят путь, и не обещает ответа модели', () => {
  assert.match(CITED_RULE, /Модель называет номер фрагмента/)
  assert.match(CITED_RULE, /взяты из отбора по этому номеру, а не из её ответа/)
  // И названа причина, а не правило без причины: иначе подтверждённая цитата
  // стояла бы под придуманным путём.
  assert.match(CITED_RULE, /стояла бы под путём, который модель\s+придумала/)
})

// ——— обрезанная цитата не выдаётся за целую (PR #321, образец — день 25) ———

test('строка об обрезке — те же слова, что у дня 25, и число согласовано', () => {
  // Слова проверяются ДОСЛОВНО: предмет один с днём 25, и двумя разными
  // фразами он читался бы как два разных события (I-13).
  assert.equal(
    quoteCutNote(300),
    'Цитату обрезал агент при сверке: показаны первые 300 знаков.',
  )
  assert.match(quoteCutNote(1), /первые 1 знак\./)
  assert.match(quoteCutNote(2), /первые 2 знака\./)
  assert.match(quoteCutNote(5), /первые 5 знаков\./)
  assert.match(quoteCutNote(11), /первые 11 знаков\./)
})

test('признак обрезки цитаты читается строго: нет поля — страница молчит', () => {
  const quotesOf = (q) => parseResult(result({ quotes: [q] })).quotes[0]
  // Поля нет вовсе — запуск шёл до обрезки. Это молчание, а не «обрезана».
  assert.equal(quotesOf({ n: 1, text: 'т', verified: true }).truncated, false)
  assert.equal(quotesOf({ n: 1, text: 'т', verified: true, truncated: false }).truncated, false)
  assert.equal(quotesOf({ n: 1, text: 'т', verified: true, truncated: true }).truncated, true)
  // Чужое «похожее на правду» значение признаком не становится: иначе строка
  // об обрезке появилась бы у цитаты, которую никто не резал.
  for (const bad of ['true', 1, {}, 'да'])
    assert.equal(quotesOf({ n: 1, text: 'т', verified: true, truncated: bad }).truncated, false, String(bad))
})
