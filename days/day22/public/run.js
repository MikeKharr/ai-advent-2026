// Правила показа ЗАПУСКА дня 22 — чистые функции без DOM (раскладка
// 2026-10-04-1003, пп. 5–8). Проверяются исполнением в test/run.test.js;
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

/** Имя режима словом. Двух режимов ровно два, третьего нет (ADR, п. 2). */
export const MODE_WORD = { rag: 'с RAG', norag: 'без RAG' }

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
 * Разбор результата запуска (`agents/src/rag-agent.js`, `runs.finish`):
 * `{mode, answer, refused, sources, index, rpc, tokens, budgetLeftUsd,
 *   truncated, model, durationMs}`.
 *
 * Поля проверяются по одному: результат приходит с сервера, но ответ модели и
 * текст фрагментов внутри него — недоверенные данные, и разбор их не обязан
 * удаваться.
 */
export function parseResult(raw) {
  const d = isObject(raw) ? raw : {}
  const index = isObject(d.index) ? d.index : null
  return {
    mode: d.mode === 'rag' || d.mode === 'norag' ? d.mode : null,
    answer: str(d.answer),
    // Признак отказа строгого промпта — ПОЛЕ сервера, а не сверка страницы.
    refused: d.refused === true,
    sources: Array.isArray(d.sources)
      ? d.sources.filter(isObject).map((s, at) => ({
          n: num(s.n) ?? at + 1,
          source: str(s.source),
          section: str(s.section),
          score: num(s.score),
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
  if (result.mode === 'rag') parts.push(`фрагментов: ${result.sources.length}`)
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

/** Нашлось меньше, чем просили (п. 10, частичный результат). */
export const SEARCH_LIMIT = 5
export function shortSearchNote(sources) {
  return sources.length > 0 && sources.length < SEARCH_LIMIT
    ? `Фрагментов нашлось ${sources.length}, а не ${SEARCH_LIMIT}.`
    : null
}

// ——— лента конвейера (п. 7) ———

/** Тела протокола пришли, а ответного нет: вызов оборвался. Единственное --danger ленты. */
export const RPC_BROKEN = 'Ответ не пришёл: вызов оборвался.'
/** Служба ответила, но байтов не прислала. Не авария — состояние (п. 10). */
export const RPC_EMPTY = 'Служба ответила, байтов в ответе нет.'
/** События с телами не пришло вовсе (п. 10). */
export const RPC_ABSENT = 'Тел вызова в этом запуске не записано.'
/** Первая строка ленты в режиме без RAG (п. 7.1). */
export const NORAG_NOTE = 'Поиска в этом режиме нет — конвейер короче на два шага.'

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
      if (fragments !== null)
        out.push({
          label: 'СБОРКА ПРОМПТА',
          time: at(e),
          meta: `${fragments} ${plural(fragments, 'фрагмент', 'фрагмента', 'фрагментов')} в контекст`,
          kind: 'prompt',
        })
      out.push({ label: 'ВЫЗОВ МОДЕЛИ', time: at(e), meta: '', kind: 'llm_call' })
      continue
    }
    if (e.stage === 'llm_result') {
      const usage = isObject(data.usage) ? data.usage : {}
      const input = num(usage.inputTokens)
      const output = num(usage.outputTokens)
      out.push({
        label: 'ОТВЕТ МОДЕЛИ',
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
  if (mode !== 'rag') return null
  return fragmentsFound === null ? SRCS_TORN_BEFORE : SRCS_TORN_AFTER
}
