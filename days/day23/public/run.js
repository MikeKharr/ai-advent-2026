// Правила показа ЗАПУСКА дня 23 — чистые функции без DOM. База раскладки —
// день 22 (`agent_docs/design/2026-10-04-1003-day22-rag-modes-layout.md`,
// пп. 5–8); добавки дня 23 (три режима, секция «Отбор», переписанный вопрос)
// названы ADR `2026-10-05-0544`, пп. 1.2–1.5, и отдельной фазы раскладки у
// них нет — решение владельца о режиме скорости. Проверяются исполнением в test/run.test.js;
// DOM живёт в app.js.
//
// Что здесь НЕ делается — и это требование, а не вкус:
//   текст ответа и текст фрагмента не разбираются, не режутся и не
//   сокращаются: предмет показа — то, что видела модель (п. 16.12);
//   отсутствующее поле не подставляется заглушкой «—» или нулём (I-8): его
//   место занимает слово о том, что поля не было, либо строки нет вовсе;
//   фраза отказа по подстроке не ищется: признак приходит полем `refused`
//   (п. 5.3).

import { formatMs } from './rpc.js'

/**
 * Имя режима словом. Режимов ровно три, и `norag` среди них нет: его показал
 * день 22 (ADR 2026-10-05-0544, п. 1.4).
 *
 * Слова называют, ЧТО СДЕЛАНО С ВЫДАЧЕЙ, а не как называется код: предмет
 * сравнения дня — выдача до отбора и после него.
 */
export const MODE_WORD = {
  rag: 'без отбора',
  rerank: 'с отбором',
  rewrite: 'с переписыванием и отбором',
}
export const MODES = ['rag', 'rerank', 'rewrite']

/**
 * Имя стратегии нарезки СЛОВОМ — те же слова, что на странице дня 21 (I-13).
 * Незнакомый код не переводится и не прячется: показывается как пришёл, иначе
 * страница выдумала бы имя стратегии, которой не знает.
 */
const STRATEGY_WORD = { structural: 'структурная', fixed: 'фиксированная' }
export const strategyWord = (code) =>
  typeof code === 'string' && code !== '' ? (STRATEGY_WORD[code] ?? code) : null

/** Склонение после числа: 1 знак, 2 знака, 5 знаков. */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b > 1 && b < 5) return few
  return many
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Разбор результата запуска (`agents/src/rag/retrieve.js` через
 * `rerank-agent`, `runs.finish`): поля дня 22 плюс три поля дня 23 —
 * `candidates` (выдача ДО отбора), `rewritten` и `outcome`. Форма — контракт
 * `agent_docs/guides/day23-rerank-contract.md` (ветка `feat/day23-agent`).
 *
 * ПОРОГА КОСИНУСА СРЕДИ ПОЛЕЙ НЕТ, и страница его не рисует. ADR (п. 1.1)
 * называл его числом на экране, но агент этого числа не отдаёт; выставить
 * сюда литерал значило бы показать число, которое никто не считал, — а оно
 * как раз про доверие к отбору. Поэтому строки нет вовсе.
 *
 * Поля проверяются по одному: результат приходит с сервера, но ответ модели и
 * текст фрагментов внутри него — недоверенные данные, и разбор их не обязан
 * удаваться.
 */
export function parseResult(raw) {
  const d = isObject(raw) ? raw : {}
  const index = isObject(d.index) ? d.index : null
  return {
    mode: MODES.includes(d.mode) ? d.mode : null,
    answer: str(d.answer),
    // Признак отказа строгого промпта — ПОЛЕ сервера, а не сверка страницы.
    refused: d.refused === true,
    sources: Array.isArray(d.sources)
      ? d.sources.filter(isObject).map((s, at) => ({
          // Номер НЕ перенумеровывается и не выдумывается: он присвоен при
          // объединении выдач и под ним же стоит в тексте ответа (контракт,
          // «Нумерация»). У оставшихся после отбора номера идут с пропусками —
          // `[2], [7], [3]` — и это верно. Поля нет — номера нет: порядковое
          // место в списке номером фрагмента не является.
          n: num(s.n),
          source: str(s.source),
          section: str(s.section),
          score: num(s.score),
          relevance: num(s.relevance),
          from: str(s.from) || null,
          // `null` и пустая строка — РАЗНЫЕ случаи, и они не сливаются:
          // поля не было вовсе (свёртки нет, п. 10) против пустого текста
          // (свёртка есть, внутри слова о пустоте).
          text: typeof s.text === 'string' ? s.text : null,
          truncated: s.truncated === true,
        }))
      : [],
    index: index
      ? {
          commit: str(index.commit) || null,
          strategy: str(index.strategy) || null,
          chunks: num(index.chunks),
        }
      : null,
    // ДО отбора. Порядок не пересортировывается: агент отдал его в порядке
    // косинуса, и менять его здесь значило бы показать не то, что он видел.
    candidates: Array.isArray(d.candidates)
      ? d.candidates.filter(isObject).map((c) => ({
          n: num(c.n),
          source: str(c.source),
          section: str(c.section),
          score: num(c.score),
          // 0/1/2 реранкера. Поля не было — `null`, и это не ноль: «не
          // оценивал» и «оценил нулём» — разные вещи (I-8).
          relevance: num(c.relevance),
          // `kept` приходит полем, а не выводится страницей из `relevance`:
          // порог «не меньше 1 и не больше пяти» держит агент, и повторять
          // его здесь значило бы завести второе правило отбора.
          kept: c.kept === true,
          // Откуда кандидат пришёл: исходный запрос, переписанный или оба.
          // В режиме `rewrite` это и есть ответ на вопрос «что дало
          // переписывание».
          from: str(c.from) || null,
          // Первые 400 знаков — РОВНО ТО, что видел реранкер. Полного текста
          // у кандидата нет намеренно, и страница его не достраивает.
          snippet: typeof c.snippet === 'string' ? c.snippet : null,
        }))
      : [],
    rewritten: typeof d.rewritten === 'string' && d.rewritten.trim() !== '' ? d.rewritten : null,
    // Исход приходит ПОЛЕМ. Вывести его из «кандидаты есть, источников нет»
    // можно, но тогда страница утверждала бы за агента, вызывалась ли модель.
    outcome: d.outcome === 'answered' || d.outcome === 'unknown_filter' ? d.outcome : null,
    rpc: isObject(d.rpc) ? d.rpc : null,
    tokens: num(d.tokens),
    budgetLeftUsd: num(d.budgetLeftUsd),
    truncated: d.truncated === true,
    durationMs: num(d.durationMs),
  }
}

/** Деньги — два знака, как в дне 18: там же и слово «остаток». */
export const formatUsd = (v) => `$${v.toFixed(2).replace('.', ',')}`

/**
 * Строка меры над ответом (п. 5.2). Ни одно число не стоит литералом в
 * разметке — все приходят из запуска; чего не пришло, того в строке нет.
 *
 * `budgetLeftUsd` назван ОСТАТКОМ, а не ценой запроса, и это не вольность:
 * роутер считает в этом поле остаток суточного потолка приложения
 * (`router/src/service.js`, `budgetLeft`), а не стоимость вызова. Раскладка в
 * примере п. 5.2 подписала его «≈ $0,009», то есть ценой — подпись была бы
 * ложной, а слово «остаток» уже занято днём 18 (I-13).
 */
export function answerMeta(result) {
  const parts = []
  if (result.mode) parts.push(`режим: ${MODE_WORD[result.mode]}`)
  if (result.candidates.length > 0)
    parts.push(`кандидатов: ${result.candidates.length} → оставлено: ${result.sources.length}`)
  else parts.push(`фрагментов: ${result.sources.length}`)
  if (result.tokens !== null) parts.push(`токенов: ${result.tokens}`)
  if (result.budgetLeftUsd !== null)
    parts.push(`бюджет дня: остаток ${formatUsd(result.budgetLeftUsd)}`)
  return parts.join(' · ')
}

/** Шапка секции источников (п. 6.2). Коммит показывается всегда, когда поиск был. */
export function indexMeta(result) {
  if (result.index === null) return ''
  const parts = []
  if (result.index.commit) parts.push(`индекс ${result.index.commit.slice(0, 7)}`)
  const word = strategyWord(result.index.strategy)
  if (word) parts.push(`стратегия ${word}`)
  parts.push(`фрагментов ${result.sources.length}`)
  return parts.join(' · ')
}

/**
 * Ссылка на файл репозитория НА ТОМ КОММИТЕ, который назван в шапке (п. 6.3).
 * Коммита нет — ссылки нет: путь останется текстом, а не поведёт в никуда.
 */
const REPO = 'https://github.com/MikeKharr/ai-advent-2026/blob'
/** Путь — недоверенные данные, и он уезжает в адрес: кодируется посегментно. */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/')

export function sourceUrl(path, commit) {
  if (typeof path !== 'string' || path === '') return null
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) return null
  return `${REPO}/${commit}/${encodePath(path)}`
}

/**
 * Ссылка на файл в `main` — для путей из файла итогов: коммита индекса у них
 * нет, они названы эталоном (ADR, п. 5). Кодирование здесь ТО ЖЕ, что у
 * `sourceUrl`: две соседние ветви одного показа расходились без причины
 * (находка `reviewer` к PR #303).
 */
export function repoUrl(path) {
  if (typeof path !== 'string' || path === '') return null
  return `${REPO}/main/${encodePath(path)}`
}

/** Близость — три знака после запятой (п. 6.3). Не измерено — строки нет. */
export const formatScore = (v) => v.toFixed(3).replace('.', ',')

/** Сводка свёртки текста фрагмента (п. 6.3). Длину считает страница. */
export const FRAGMENT_EMPTY = 'Служба отдала фрагмент без текста.'
export function fragmentSummary(text) {
  if (typeof text !== 'string') return null
  if (text === '') return 'текст фрагмента · пусто'
  const n = [...text].length
  return `текст фрагмента · ${n} ${plural(n, 'знак', 'знака', 'знаков')}`
}

/** Строка о том, что текст пришёл не у всех фрагментов (п. 10, частичный результат). */
export function fragmentTextNote(sources) {
  if (sources.length === 0) return null
  const withText = sources.filter((s) => s.text !== null).length
  if (withText === sources.length) return null
  if (withText === 0) return 'Текста фрагментов в этом ответе не пришло.'
  return `Текст пришёл у ${withText} фрагментов из ${sources.length}.`
}

/**
 * Потолок вопроса. То же число, что `MAX_QUESTION` сервера дня и
 * `MAX_QUESTION_CHARS` агента; здесь оно нужно строке отказа, а защиту держит
 * сервер.
 */
export const MAX_QUESTION = 600

/**
 * Нашлось меньше, чем просили (п. 10, частичный результат).
 *
 * Только для режима `rag`: там у поиска один потолок и он равен пяти. В
 * режимах с отбором пятёрка — это ПОТОЛОК ОТБОРА, а не недобор поиска, и
 * «нашлось 3, а не 5» было бы ложью про чужой шаг. Что там произошло,
 * говорит секция «Отбор».
 */
export const SEARCH_LIMIT = 5
export const CANDIDATE_LIMIT = 10
export function shortSearchNote(result) {
  if (result.mode !== 'rag') return null
  const n = result.sources.length
  return n > 0 && n < SEARCH_LIMIT ? `Фрагментов нашлось ${n}, а не ${SEARCH_LIMIT}.` : null
}

// ——— лента конвейера (п. 7) ———

/** Тела протокола пришли, а ответного нет: вызов оборвался. Единственное --danger ленты. */
export const RPC_BROKEN = 'Ответ не пришёл: вызов оборвался.'
/** Служба ответила, но байтов не прислала. Не авария — состояние (п. 10). */
export const RPC_EMPTY = 'Служба ответила, байтов в ответе нет.'
/** События с телами не пришло вовсе (п. 10). */
export const RPC_ABSENT = 'Тел вызова в этом запуске не записано.'
/**
 * Первая строка ленты в режиме без отбора (п. 7.1 раскладки дня 22, тот же
 * приём). Режим `rag` — это ровно день 22: поиск один, отбора нет, и модель
 * вызывается один раз.
 */
export const RAG_NOTE =
  'Отбора в этом режиме нет — это день 22 как он есть: пять фрагментов поиска идут в ' +
  'модель без второй ступени.'
/** Переписывания нет в режимах `rag` и `rerank` — вопрос ищется как задан. */
export const REWRITE_NOTE = 'Вопрос в этом режиме не переписывался — искали ровно то, что спросили.'

/**
 * Записи ленты из событий запуска. Метки заранее известны: конвейер
 * детерминированный, и лента показывает ПРОЙДЕННЫЕ шаги, а не решения модели.
 *
 * «СБОРКА ПРОМПТА» — запись, которой СВОЕГО СОБЫТИЯ НЕТ: стадии живут в
 * `agents/src/runs.js` и общие для дней 6–20, новая стадия ради одной строки
 * расширяла бы общий контракт (раскладка, п. 18.1; то же решение записано в
 * `agents/src/rag-agent.js`). Страница рисует её между «фрагменты получены» и
 * «вызов модели», и время у неё — время вызова: другого момента страница не
 * знает и выдумывать его не станет. Сказано это СЛОВАМИ на экране один раз на
 * секцию, а не подписью у каждой записи.
 */
export function steps(events) {
  const seen = events.filter((e) => isObject(e) && typeof e.stage === 'string')
  if (seen.length === 0) return []
  const t0 = Date.parse(seen[0].at ?? '')
  const at = (e) => {
    const t = Date.parse(e.at ?? '')
    return Number.isFinite(t) && Number.isFinite(t0) ? formatMs(Math.max(0, t - t0)) : null
  }

  const out = []
  let fragments = null
  // Стратегия и число фрагментов приходят событием `received`, а НЕ событием
  // `rpc`: в трейсе лежат только имя сервера, метод, тела и статус
  // (`agents/src/mcp/pipeline.js`, `rpcEvent`). Поэтому они переносятся сюда
  // из первой записи, а не читаются из той, у которой их нет.
  let asked = { strategy: null, limit: null }
  for (const e of seen) {
    const data = isObject(e.data) ? e.data : {}
    if (e.stage === 'received') {
      asked = { strategy: str(data.strategy) || null, limit: num(data.limit) }
      out.push({ label: 'ПРИНЯТ ВОПРОС', time: at(e), meta: '', kind: 'received' })
      continue
    }
    if (e.stage === 'rpc') {
      const meta = ['project.search по MCP', strategyWord(asked.strategy), asked.limit]
        .filter((p) => p !== null && p !== undefined && p !== '')
        .join(' · ')
      out.push({
        label: 'ПОИСК ПО ПРОЕКТУ',
        time: at(e),
        meta,
        kind: 'rpc',
        rpc: {
          request: typeof data.request === 'string' ? data.request : null,
          response: typeof data.response === 'string' ? data.response : null,
          status: num(data.status),
          clipped: data.clipped === true,
        },
      })
      continue
    }
    if (e.stage === 'planning') {
      // Стадия `planning` в дне 23 приходит ТРИ раза и говорит разное
      // (контракт, «Стадии и события»): выдача поиска, итог переписывания,
      // итог отбора. Различаются они по тому, какие поля в них лежат, —
      // новых стадий агент не заводил.
      const kept = num(data.kept)
      if (kept !== null) {
        const total = num(data.candidates) ?? (Array.isArray(data.candidates) ? data.candidates.length : null)
        fragments = kept
        out.push({
          label: 'ОТБОР',
          time: at(e),
          meta: total === null ? `оставлено ${kept}` : `оставлено ${kept} из ${total}`,
          kind: 'planning',
        })
        continue
      }
      if (typeof data.rewritten === 'string' && data.rewritten !== '') {
        const found = num(data.found)
        out.push({
          label: 'ПОИСК ПО ПЕРЕПИСАННОМУ',
          time: at(e),
          meta: found === null ? '' : `${found} ${plural(found, 'фрагмент', 'фрагмента', 'фрагментов')}`,
          kind: 'planning',
        })
        continue
      }
      const sources = Array.isArray(data.sources) ? data.sources.length : null
      fragments = sources
      out.push({
        label: 'ФРАГМЕНТЫ ПОЛУЧЕНЫ',
        time: at(e),
        meta:
          sources === null
            ? ''
            : `${sources} ${plural(sources, 'фрагмент', 'фрагмента', 'фрагментов')}`,
        kind: 'planning',
      })
      continue
    }
    if (e.stage === 'llm_call') {
      // Вызовов модели в дне 23 до трёх, и различает их ТОЛЬКО `data.purpose`
      // (контракт, «Стадии и события»): у вызова ответа этого поля нет.
      // Подписать их одинаково значило бы показать три одинаковых шага там,
      // где произошли три разных, — и скрыть, за что именно заплачено.
      const purpose = str(data.purpose)
      if (purpose === 'rewrite' || purpose === 'rerank') {
        out.push({
          label: purpose === 'rewrite' ? 'ПЕРЕПИСЫВАНИЕ ВОПРОСА' : 'ОЦЕНКА КАНДИДАТОВ',
          time: at(e),
          meta: '',
          kind: 'llm_call',
        })
        continue
      }
      // Запись «сборка промпта» рисуется ОДИН раз, перед вызовом ответа:
      // второй её экземпляр объявил бы пройденным шаг, которого не было.
      if (fragments !== null) {
        out.push({
          label: 'СБОРКА ПРОМПТА',
          time: at(e),
          meta: `${fragments} ${plural(fragments, 'фрагмент', 'фрагмента', 'фрагментов')} в контекст`,
          kind: 'prompt',
        })
        fragments = null
      }
      out.push({ label: 'ВЫЗОВ МОДЕЛИ', time: at(e), meta: '', kind: 'llm_call' })
      continue
    }
    if (e.stage === 'llm_result') {
      const purpose = str(data.purpose)
      const usage = isObject(data.usage) ? data.usage : {}
      const input = num(usage.inputTokens)
      const output = num(usage.outputTokens)
      out.push({
        label:
          purpose === 'rewrite'
            ? 'ЗАПРОС ПЕРЕПИСАН'
            : purpose === 'rerank'
              ? 'КАНДИДАТЫ ОЦЕНЕНЫ'
              : 'ОТВЕТ МОДЕЛИ',
        time: at(e),
        meta: input === null || output === null ? '' : `токенов ${input + output}`,
        kind: 'llm_result',
      })
    }
  }
  return out
}

/**
 * Строка состояния (п. 8.3). Тексты дословные; число фрагментов приходит из
 * события, а не из разметки.
 */
export const STATUS = {
  idle: '',
  sent: 'Вопрос ушёл…',
  searching: 'Ищу фрагменты по проекту…',
  asking: (n) => `Фрагментов: ${n}. Спрашиваю модель…`,
  askingPlain: 'Спрашиваю модель…',
  done: (ms) => `Готово за ${formatMs(ms)}.`,
  empty: 'Не отправлено: поле пустое.',
  long: `Не отправлено: вопрос длиннее ${MAX_QUESTION} знаков.`,
  silent: 'Не отправлено: сервер дня не ответил.',
  torn: 'Поток событий оборвался. Показано то, что успело прийти.',
}

// ——— четыре отказа (п. 8.1) ———

/**
 * Отказ запуска словами, и КАЖДЫЙ говорит про деньги (п. 8.1): иначе
 * посетитель не отличает «сломалось» от «не дали».
 *
 * Слова службы не пересказываются, а показываются отдельной строкой — в них
 * единственное достоверное число. Строка эта приходит из ЧУЖОЙ ЕДИНИЦЫ
 * (`rag/limits.py` через `rpcErrorMessage` агента), поэтому страница кладёт её
 * `textContent` и на короткую не рассчитывает: своего потолка длины у неё нет,
 * сверху её держит только обрезка тела трейса в 64 КБ
 * (`agents/src/mcp/client.js`). Это требование гейтов PR 1, а не вкус.
 *
 * `words` возвращается ОТДЕЛЬНЫМ полем, а не склеивается с `lead`: раскладка
 * (п. 8.1) ставит слова службы внутрь фразы, но фраза агента уже кончается
 * словами «Модель не вызывалась.», и склейка сказала бы это дважды.
 */
export function failure(error, { status = null } = {}) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = str(error?.message)
  // ТРИ состояния, а не два: «денег не стоил», «стоил» и «неизвестно».
  // Прежняя редакция писала `error?.paidNothing !== false`, то есть отсутствие
  // поля превращала в утверждение «вызов не состоялся, денег не стоил» —
  // страница говорила про деньги там, где не знала ничего (находка
  // `compliance` к PR #303). Сегодня путь почти недостижим (`runs.js` всегда
  // кладёт `error`, а `fail()` агента всегда ставит поле), но «почти» — не
  // основание утверждать за посетителя, сколько он потратил.
  const paidNothing = typeof error?.paidNothing === 'boolean' ? error.paidNothing : null

  if (code === 'search_refused' && status === 429)
    return {
      kind: 'rag_window',
      lead:
        'Поиск отказал: окно службы поиска исчерпано. Оно общее на всех посетителей этого ' +
        'дня, поэтому могли исчерпать не вы. Модель не вызывалась — вопрос денег не стоил.',
      words: message || null,
      paidNothing,
    }
  if (
    code === 'search_refused' ||
    code === 'search_failed' ||
    code === 'search_unavailable' ||
    code === 'search_empty'
  )
    return {
      kind: 'search_down',
      lead: 'Поиск недоступен:',
      words: message || null,
      tail:
        'В режиме с RAG отвечать не по чему, и модель не вызывалась. Тот же вопрос можно ' +
        'задать в режиме без RAG — но сверить ответ будет нечем.',
      paidNothing,
    }
  // Отказ не из поиска: три исхода, и третий — «неизвестно». Молчать про
  // деньги там, где их могли потратить, нельзя; утверждать, что не потратили,
  // не зная этого, — тоже.
  const LEAD = {
    free: 'Запуск не состоялся. Вызов модели не случился — вопрос денег не стоил.',
    paid: 'Запуск не довёл дело до конца, и вызов модели при этом состоялся: вопрос стоил денег.',
    unknown:
      'Запуск не состоялся. Был ли вызов модели оплачен, сервер не сказал — ' +
      'поэтому и страница этого не утверждает.',
  }
  return {
    kind: 'other',
    lead: paidNothing === null ? LEAD.unknown : paidNothing ? LEAD.free : LEAD.paid,
    words: message || null,
    paidNothing,
  }
}

/** Отказ 429 от сервера ДНЯ: суточный предел и окна на адрес (п. 8.1). */
export const DAY_LIMIT_NOTE =
  'Вопрос не ушёл: суточный предел вопросов исчерпан. Число и срок сброса — в сообщении выше.'

/**
 * Что поставить в блоке ответа под отказом 429 сервера дня — или `null`, если
 * ставить нечего.
 *
 * ОТКАЗОВ 429 У ДНЯ ТРИ (`days/day22/limits.js`): суточный потолок, минутное
 * окно и часовое. Строка про суточный предел верна только для первого, и
 * различитель приходит в ответе сервера: у потолка `retryAfterSec` равен
 * `null` (секунд до повтора у него нет и взяться им неоткуда), у обоих окон —
 * число. У окон блок ответа не трогается вовсе: достоверные слова уже стоят в
 * строке состояния, и пересказывать их вторично незачем.
 *
 * ВЫНЕСЕНО РАДИ ДЕРЖАТЕЛЯ. Прежняя редакция ставила строку на ЛЮБОЙ 429, и
 * экран противоречил сам себе: «слишком часто» в строке состояния и «суточный
 * предел исчерпан» под ней при `callsToday` 1 из 3 (находка `design-review`).
 * Первая правка условие вернула на место, но держателя у него не было:
 * `compliance` показал мутацией, что снятие `&& retryAfterSec === null`
 * оставляет все 315 тестов зелёными. Отдельная функция даёт правилу держателя,
 * который исполняется, а не сверяет исходный текст.
 *
 * Сравнение строгое (`=== null`), и это выбор: при неразобранном теле и при
 * пропавшем поле страница не утверждает причину, а молчит — та же сторона, в
 * которую смотрит `paidNothing` выше.
 */
export function dayLimitNote(status, retryAfterSec) {
  if (status !== 429) return null
  return retryAfterSec === null ? DAY_LIMIT_NOTE : null
}

/** Отказ модели — результат, а не сбой (п. 5.3). */
export const REFUSED_NOTE =
  'Это не сбой: фрагменты нашлись, ответа на вопрос в них не оказалось. Что именно нашлось — ниже.'

/** Ответ оборвался потолком токенов (п. 10, частичный результат). */
export const ANSWER_CUT = 'Ответ оборван: показано то, что успело прийти.'

/**
 * Запуск удался, а текста в ответе нет. Пустое место на месте главного
 * предмета экрана — то же самое, что заглушка (I-8): страница говорит прямо,
 * что показывать нечего, и оставляет строку меры — токены-то потратились.
 *
 * Пробельный ответ — тот же случай: `"\n  \n"` даёт не состояние, а пустую
 * полосу (приём дня 20, `isSilent`).
 */
export const ANSWER_BLANK = 'Модель вернула пустой ответ: показывать нечего. Вызов при этом состоялся.'
export const isBlank = (text) => typeof text !== 'string' || text.trim() === ''

/**
 * Поток событий оборвался раньше, чем пришёл ответ.
 *
 * Пустое место под заголовком «Ответ» — то же, что заглушка (I-8): блок
 * главного предмета экрана обязан сказать словами, что ответа нет и почему
 * (блокирующая `design-review` к PR #303 — замер показывал `#answer` высотой
 * 0 px рядом с красной строкой об обрыве).
 *
 * Про деньги здесь не утверждается ничего: был ли вызов модели оплачен, с
 * оборванного потока не видно, и выдумывать это страница не станет — тот же
 * выбор, что у `paidNothing`.
 */
export const ANSWER_TORN =
  'Ответа нет: поток событий оборвался раньше, чем он пришёл. Что успело прийти — в конвейере ниже.'

/**
 * Секция «Источники» при обрыве потока. Два случая, и они НЕ сливаются:
 * число фрагментов успело прийти против «не успело». Пустой результат — не
 * наблюдение отсутствия, и страница не называет вторым первое.
 *
 * Различитель назван именно так, а не «стадия `planning` пришла»: это не одно
 * и то же. `fragmentsFound` остаётся `null` и когда стадии не было, и когда
 * она пришла с `sources` не-массивом (находка `reviewer` к PR #303). С
 * нынешним агентом вторая ветвь недостижима — `sources` всегда массив, — но
 * обещать в комментарии больше, чем сверяет код, нельзя.
 */
export const SRCS_TORN_AFTER = 'Поиск успел доложиться, а сами фрагменты не дошли: поток событий оборвался.'
export const SRCS_TORN_BEFORE = 'Фрагменты не дошли: поток оборвался раньше, чем поиск что-то вернул.'

/**
 * Что секция «Источники» говорит при обрыве потока. `null` — не трогать то,
 * что там стоит.
 *
 * Правило живёт ЗДЕСЬ, а не в странице, и держится исполнением: в прошлом
 * круге того же PR `compliance` показал, что правило, оставленное в
 * обработчике, обойти можно не тронув ни одной проверенной строки. Страница
 * своего сравнения не содержит — она спрашивает.
 *
 * `null` для режима без RAG — не умолчание, а решение: там `resetRun`
 * поставил `SRCS_NORAG`, и обрыв этого не меняет. Любой режим, кроме `rag`,
 * сюда же: выдумывать слова про поиск для режима, которого страница не знает,
 * нельзя.
 */
export function tornSrcsNote(mode, fragmentsFound) {
  // Поиск идёт во ВСЕХ трёх режимах дня 23 — режима без поиска здесь нет
  // (ADR 2026-10-05-0544, п. 1.4). Незнакомый режим — по-прежнему `null`:
  // выдумывать слова про поиск для режима, которого страница не знает, нельзя.
  if (!MODES.includes(mode)) return null
  return fragmentsFound === null ? SRCS_TORN_BEFORE : SRCS_TORN_AFTER
}

// ——— отбор второй ступенью (ADR 2026-10-05-0544, пп. 1.2–1.4) ———

/**
 * ЧЕСТНОЕ «НЕ ЗНАЮ» — исход отбора, а не отказ и не пустое место.
 *
 * Реранкер не признал относящимся к вопросу ни одного кандидата. Это
 * отдельный исход поиска, и день 23 обязан назвать его своим именем:
 * «поиск отказал» было бы неправдой (поиск отработал и что-то нашёл),
 * пустая секция — заглушкой (I-8), а дорисовывать до пяти фрагментов ради
 * симметрии нельзя тем более.
 *
 * Это и есть долг дня 22, закрываемый здесь (развилка Р8, решение владельца;
 * пункт «Владельцу» в `agent_docs/backlog.md`: честное «не знаю» и выдумка
 * попадали в дне 22 в один вердикт). Разделение исходов на мере — день 24
 * (ADR, п. 2.3); на экране оно начинается здесь.
 */
export function selectNone(found) {
  const n = typeof found === 'number' && Number.isFinite(found) ? found : null
  const head =
    n === null
      ? 'Не знаю: ни один из найденных фрагментов к вопросу не относится.'
      : `Не знаю: ни один из ${n} ${plural(n, 'найденного фрагмента', 'найденных фрагментов', 'найденных фрагментов')} к вопросу не относится.`
  return (
    `${head} Модель ответа не вызывалась — отвечать было не по чему. Это честный исход ` +
    'поиска, а не сбой: кандидаты со своими оценками перечислены выше, их можно не ' +
    'принять на веру.'
  )
}
/** Тот же исход там, где числа кандидатов под рукой нет. */
export const SELECT_NONE = selectNone(null)

/** Режим без отбора: кандидатов нет по построению, и это не пропажа. */
export const CANDIDATES_RAG =
  'В этом режиме второй ступени нет: что нашёл поиск, то и ушло в модель. Сравнивать ' +
  'здесь нечего — для этого есть два других режима.'
/** Отбор был, а списка кандидатов не пришло (п. 10). */
export const CANDIDATES_NONE = 'Списка кандидатов в этом ответе не пришло.'
/** Переписывание было, а переписанного вопроса не пришло (п. 10). */
export const REWRITTEN_NONE = 'Переписанного вопроса в этом ответе не пришло.'

/** Релевантность реранкера словом. Не оценивал — строки нет, а не ноль (I-8). */
const RELEVANCE_WORD = { 0: 'не относится', 1: 'относится', 2: 'отвечает' }
export function relevanceWord(value) {
  if (value === null) return ''
  return RELEVANCE_WORD[value] ?? String(value)
}

/** Оставлен или отброшен — то, ради чего таблица кандидатов и существует. */
export const keptWord = (kept) => (kept ? 'оставлен' : 'отброшен')

/**
 * Строка над таблицей кандидатов: сколько было и сколько осталось. Числа
 * считаются по тому, что пришло, а не по потолку из разметки.
 */
export function selectionNote(result) {
  if (result.candidates.length === 0) return null
  const kept = result.candidates.filter((c) => c.kept).length
  return `Кандидатов: ${result.candidates.length}. Оставлено отбором: ${kept}.`
}

/**
 * Подпись под таблицей кандидатов: чем отбирали. Порога косинуса среди чисел
 * ЗДЕСЬ НЕТ и быть не может — агент его не отдаёт, а ADR (п. 1.1) отверг его
 * как фильтр счётом по 100 вопросам дня 21: 0,55 срезает 32 промаха из 40 и
 * 19 попаданий из 31. Сказать это словами можно, напечатать число — нет.
 */
export const PICK_RULE =
  'Отбирает релевантность реранкера, а не близость: по близости порог резал верные ' +
  'ответы наравне с промахами, и фильтром он здесь не служит.'

/** Откуда кандидат пришёл — слово. Незнакомый код показывается как пришёл. */
const FROM_WORD = { original: 'исходный запрос', rewritten: 'переписанный', both: 'оба запроса' }
export function fromWord(code) {
  if (code === null) return ''
  return FROM_WORD[code] ?? code
}

/** Сводка свёртки выдержки кандидата: ровно то, что видел реранкер. */
export function snippetSummary(text) {
  if (typeof text !== 'string') return null
  if (text === '') return 'выдержка для реранкера · пусто'
  const n = [...text].length
  return `выдержка для реранкера · ${n} ${plural(n, 'знак', 'знака', 'знаков')}`
}
