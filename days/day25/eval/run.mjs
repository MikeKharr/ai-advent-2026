#!/usr/bin/env node
// Прогон двух длинных сценариев дня 25 ЧЕРЕЗ ПУБЛИЧНЫЙ АДРЕС ДНЯ (ADR
// 2026-10-05-0544, п. 3). Node 22, без зависимостей.
//
// ПОЧЕМУ ЧЕРЕЗ ПУБЛИЧНЫЙ АДРЕС, А НЕ МИМО. Локальной связки с ключом у прогона
// нет и не будет (I-3): он ходит тем же путём, что посетитель, — профиль,
// диалог, `POST /api/answer` и поток событий, — поэтому мерит то, что видит
// посетитель, и не заводит ни второго способа позвать модель, ни ещё одной
// копии ключа. Ключей этот скрипт не читает вовсе: единственное, что он
// знает, — адрес страницы.
//
// ЭТО СТОИТ ДЕНЕГ, и числа названы до запуска. Ход дня 25 — `4 + 2×кругов`
// вызовов модели и два эмбеддинга; прогон ставит пределу кругов ЕДИНИЦУ (см.
// `REVIEW_ROUNDS` ниже), то есть 6 вызовов на ход. Два сценария по 11 ходов —
// 22 хода: 132 вызова модели, 44 эмбеддинга из суточных 500 службы `rag` и 22
// слота из 50 суточных дня. По счёту ADR, п. 4 (≈ $0,027 за ход) это ≈ $0,6.
// Повтор прогона тратит столько же ещё раз и даёт другие тексты, поэтому
// готовый файл результата по умолчанию НЕ ЗАТИРАЕТСЯ: нужен `--force`.
//
// КЛЮЧ ОПЕРАТОРА (ADR 2026-10-05-1130). Один ключ прогон всё-таки знает —
// `EVAL_KEY` дня, и только его: ключей к модели, к роутеру, к службе поиска и
// к сервису агентов у него нет по-прежнему (I-3). Ключ читается из ФАЙЛА, путь
// которого даёт `EVAL_KEY_FILE` (умолчание `~/.config/advent/eval.key`), и
// уходит заголовком `x-eval-key` при создании хода. Он снимает окна «в
// минуту/в час» НА АДРЕС — и только их: СУТОЧНЫЙ ПОТОЛОК ДНЯ ОСТАЁТСЯ. Файла
// нет — прогон идёт как раньше, под окнами. Значение не печатается ни при
// каком исходе: в вывод идёт «есть» или «нет».
//
// ПОЧЕМУ ПРЕДЕЛ КРУГОВ ПО УМОЛЧАНИЮ — ЕДИНИЦА, А НЕ ДВА, КАК У ДНЯ. День
// занимает `reviewRounds` слотов НА ХОД, и слоты эти уходят во все три окна
// сразу (`days/day25/limits.js`, `reserve`): при умолчании 2 окно часа (30)
// пускает 15 ходов, а прогону нужно 24 — часть набора получила бы 429 и
// обнулилась. Поэтому предел кругов прогона — флаг `--rounds`, по умолчанию 1,
// и БОЛЬШЕ ОДНОГО ОН ПРИНИМАЕТ ТОЛЬКО С КЛЮЧОМ ОПЕРАТОРА: без ключа окно часа
// такой прогон не пустит, и обнаружить это на пятнадцатом ходе — значит
// заплатить за четырнадцать впустую.
//
// ЧЕСТНАЯ ГРАНИЦА, которую надо называть вместе с `--rounds 1`: круг тогда
// всегда один, и признак `rounds` в файле ничего не различает — цикл проверки
// такой прогон не мерит вовсе.
//
// СУТОЧНЫЙ ПОТОЛОК КЛЮЧ НЕ СНИМАЕТ, и он ОБЩИЙ НА ВСЕХ посетителей дня
// (`limits.js`, `callsToday` — один счётчик, не по адресам). Поэтому прогон
// печатает, сколько слотов ему нужно, ДО первого платного хода: 24 хода ×
// `--rounds`. Сколько уже потрачено сегодня, прогон узнать не может — проба
// живости дня счётчиков не отдаёт намеренно (решение владельца Р8), — и это
// названо вслух, а не домыслено.
//
// РИТМ. У дня 5 запусков в минуту на адрес и 30 в час (`days/day25/env.js`), у
// службы `rag` — 10 в минуту на весь хост. Поэтому ходы идут строго по одному
// с паузой `SPACING_MS`: залп получил бы 429 и обнулил часть набора. С ключом
// окна дня сняты, но окно службы `rag` остаётся, и паузу задаёт оно: у хода
// дня 25 ДВА поиска (реплика и переписанный запрос), то есть 10 в минуту — это
// 5 ходов, 12 с на ход. Ускорения ключ дню 25 почти не даёт, и это сказано
// числом, а не словом: он нужен ради окна часа, то есть ради `--rounds 2`.
//
// ЧЕГО ЗДЕСЬ НЕТ: вердиктов и текстов ответов. Судейство дней 24–25 владелец
// отложил, и мера дня — механика хода (`mechanics.mjs`, шапка).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from '../env.js'
import { EVAL_HEADER } from '../limits.js'
import { buildReport, checkReport, readFailure, readTurn, summarize } from './mechanics.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCENARIOS = join(here, 'scenarios.json')
const OUT = join(here, '..', 'public', 'eval.json')

/** Публичный адрес дня. Прогон идёт по нему и ни по какому другому. */
export const BASE = 'https://challenge.zpq.ai/day25'

/**
 * Пределы дня — у ДНЯ, а не второй копией здесь: суточный потолок и окна
 * читаются из `env.js` умолчаниями (`parseEnv({})`). Второе число в файле
 * прогона разошлось бы с настоящим молча, и в отчёте стояло бы не то, под чем
 * прогон шёл (находка `reviewer` к PR #325).
 *
 * Ошибки разбора здесь не смотрятся намеренно: ключа сервиса агентов у прогона
 * нет и быть не должно, а умолчания чисел от него не зависят.
 */
export const DAY_LIMITS = parseEnv({}).env

/** Предел кругов проверки по умолчанию — см. шапку. */
export const REVIEW_ROUNDS = 1

/**
 * Пауза между ходами БЕЗ ключа оператора. 12,0 с хватило бы ровно на 5 в
 * минуту при одном слоте, 13 с оставляет запас на расхождение часов и на то,
 * что окно считает время прихода запроса, а не ухода ответа.
 */
export const SPACING_MS = 13_000

/**
 * Пауза С ключом оператора. Окна дня сняты, связывает окно службы `rag`: 10
 * запросов в минуту на весь хост, два поиска на ход — 5 ходов в минуту.
 * 12,5 с — те же 12 с плюс запас на расхождение часов.
 */
export const SPACING_WITH_KEY_MS = 12_500

/**
 * Заголовок ключа оператора берётся У ДНЯ (`limits.js`), а не объявляется
 * здесь второй строкой: день сверяет ключ по этому же имени, и разойдясь, две
 * копии дали бы прогон, который ключ посылает, а день его не видит (I-13).
 */
export { EVAL_HEADER }

/** Умолчание пути к файлу ключа оператора. */
export const EVAL_KEY_FILE = join(homedir(), '.config', 'advent', 'eval.key')

/**
 * Ключ оператора из файла, либо `null`, если файла нет, он не читается или
 * пуст. Отсутствие — НЕ ошибка: прогон тогда идёт под окнами дня.
 *
 * Значение из этой функции не печатается нигде: единственный его потребитель —
 * заголовок запроса. Ошибка чтения глотается молча — текст исключения `fs`
 * несёт путь, а путь к файлу ключа в выводе не нужен.
 */
export function readEvalKey({
  file = process.env.EVAL_KEY_FILE || EVAL_KEY_FILE,
  read = readFileSync,
} = {}) {
  let text
  try {
    text = read(file, 'utf8')
  } catch {
    return null
  }
  const value = String(text).trim()
  return value === '' ? null : value
}

/** Параметры хода. Стратегия «липкие факты» — память разговора без сжатия:
 *  сводка завела бы седьмой вызов сверх формулы хода (контракт хода). */
export const PARAMS = {
  maxTokens: 1024,
  strategy: 'facts',
  window: 10,
  factsTokens: 600,
}

const CALL_TIMEOUT_MS = 20_000
/** Потолок ожидания одного ответа: ход дня 25 — шесть вызовов модели и поиск. */
const ANSWER_TIMEOUT_MS = 240_000

const sleepReal = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Склад cookie. Профиль и диалог день держит в `HttpOnly`-cookie, и прогон
 * обязан вести себя как браузер: иначе второй ход начал бы новый диалог, и
 * «память между ходами» мерилась бы на пустом месте.
 */
export function createJar() {
  const store = new Map()
  return {
    header: () =>
      [...store.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    take(response) {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';')
        const at = pair.indexOf('=')
        if (at === -1) continue
        const name = pair.slice(0, at).trim()
        const value = pair.slice(at + 1).trim()
        // Пустое значение — стирание: день так уносит указатель на диалог.
        if (value === '') store.delete(name)
        else store.set(name, value)
      }
    },
  }
}

/**
 * Запрос к дню с cookie. Отказы возвращаются значением, а не исключением.
 *
 * `key` — ключ оператора; уходит заголовком только там, где его передали, то
 * есть при создании хода. На чтения он не нужен: окна снимаются у платной
 * ручки, а лишний заголовок на каждой — лишний путь утечки.
 */
async function call({ base, path, method = 'GET', body, jar, fetchImpl, key = null }) {
  const headers = {}
  const cookie = jar.header()
  if (cookie !== '') headers.cookie = cookie
  if (key !== null) headers[EVAL_HEADER] = key
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  jar.take(response)
  const json = await response.json().catch(() => null)
  return { status: response.status, json }
}

/**
 * Разбор потока событий. Нужен только кадр `end`: он несёт
 * `{status, result, error}` (`agents/src/service.js`, `streamEvents`).
 * Остальные кадры прогону не нужны, их предмет — монитор на экране.
 */
export function parseEnd(chunkText, state) {
  state.buffer += chunkText
  for (;;) {
    const at = state.buffer.indexOf('\n\n')
    if (at === -1) return null
    const frame = state.buffer.slice(0, at)
    state.buffer = state.buffer.slice(at + 2)
    let name = null
    let data = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (name !== 'end') continue
    try {
      return JSON.parse(data)
    } catch {
      return { status: 'failed', error: { code: 'bad_end_frame', message: 'кадр end не разбирается' } }
    }
  }
}

/**
 * Один ход. Возвращает `{result}` либо `{failure}` — и никогда не бросает:
 * отказ поиска, 429 лимитера и обрыв сети это РЕЗУЛЬТАТ прогона, а не его
 * авария, и он обязан доехать до файла.
 */
export async function runTurn({ base, prompt, jar, fetchImpl = fetch, key = null }) {
  let created
  try {
    created = await call({
      base,
      path: '/api/answer',
      method: 'POST',
      body: { ...PARAMS, prompt },
      jar,
      fetchImpl,
      key,
    })
  } catch (error) {
    return { failure: { code: 'answer_failed', message: String(error?.message ?? error) } }
  }
  if (created.status !== 202 || typeof created.json?.runId !== 'string') {
    return {
      failure: {
        code: `http_${created.status}`,
        message: String(created.json?.error ?? 'ход не начат'),
        // Слово самого дня о слоте сильнее кода ответа — то же правило, что
        // у страницы: 4xx слот не занимал, `slot: 'free'` говорит об этом
        // прямо, а у 5xx знания нет и признак остаётся неизвестным.
        paidNothing:
          created.json?.slot === 'free' || created.status < 500 ? true : undefined,
      },
    }
  }

  let stream
  try {
    stream = await fetchImpl(`${base}/api/runs/${created.json.runId}/events`, {
      headers: jar.header() === '' ? {} : { cookie: jar.header() },
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    })
  } catch (error) {
    return { failure: { code: 'events_failed', message: String(error?.message ?? error) } }
  }
  if (!stream.ok || !stream.body)
    return { failure: { code: `events_http_${stream.status}`, message: 'поток событий не открылся' } }

  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  const state = { buffer: '' }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const end = parseEnd(decoder.decode(value, { stream: true }), state)
      if (end === null) continue
      if (end.status === 'succeeded' && end.result) return { result: end.result }
      return {
        failure: {
          code: String(end.error?.code ?? end.status ?? 'unknown'),
          message: String(end.error?.message ?? 'ход не удался'),
          paidNothing: end.error?.paidNothing,
        },
      }
    }
  } catch (error) {
    return { failure: { code: 'stream_broken', message: String(error?.message ?? error) } }
  } finally {
    reader.cancel().catch(() => {})
  }
  return { failure: { code: 'no_end', message: 'поток кончился без кадра end' } }
}

/**
 * ПРОБА ПЕРЕД ДЕНЬГАМИ. Платный прогон не начинается, пока не видно, что день
 * жив и что профиль заводится: 22 хода — это полчаса и $0,6, и узнавать на
 * пятнадцатом ходе, что мест под профиль нет, слишком дорого.
 *
 * Обе ручки бесплатны: проба живости вне окон, список профилей — чтение.
 */
export async function smoke({ base, jar, fetchImpl = fetch }) {
  const health = await call({ base, path: '/healthz', jar, fetchImpl })
  if (health.status !== 200) return { ok: false, why: `проба живости ответила ${health.status}` }
  const list = await call({ base, path: '/api/profiles', jar, fetchImpl })
  if (list.status !== 200) return { ok: false, why: `список профилей ответил ${list.status}` }
  const profiles = Array.isArray(list.json?.profiles) ? list.json.profiles : []
  const cap = Number.isInteger(list.json?.cap) ? list.json.cap : 5
  if (profiles.length >= cap)
    return {
      ok: false,
      why: `мест под профиль нет: ${profiles.length} из ${cap} — освободите одно и повторите`,
    }
  return { ok: true, profiles: profiles.length, cap }
}

/** Профиль прогона: заводится, выбирается, получает предел кругов. */
export async function setup({ base, jar, name, fetchImpl = fetch, rounds = REVIEW_ROUNDS }) {
  const made = await call({ base, path: '/api/profile', method: 'POST', body: { name }, jar, fetchImpl })
  if (made.status !== 200 || typeof made.json?.profile?.id !== 'string')
    return { ok: false, why: `профиль не создан: ${made.status} ${made.json?.error ?? ''}` }
  const chosen = await call({
    base,
    path: '/api/profile/select',
    method: 'POST',
    body: { id: made.json.profile.id },
    jar,
    fetchImpl,
  })
  if (chosen.status !== 200) return { ok: false, why: `профиль не выбран: ${chosen.status}` }
  const settings = await call({
    base,
    path: '/api/settings',
    method: 'PUT',
    body: { reviewRounds: rounds },
    jar,
    fetchImpl,
  })
  if (settings.status !== 200)
    return { ok: false, why: `предел кругов не выставлен: ${settings.status}` }
  return { ok: true, profileId: made.json.profile.id, name }
}

/**
 * Профиль прогона убирается за собой. Мест под профиль у дня пять, и каждый
 * прогон занимал бы одно навсегда: через четыре прогона посетитель не смог бы
 * создать свой (находка `reviewer` к PR #325).
 *
 * Исход возвращается значением и ничего не валит: прогон уже отработал, и
 * неудавшаяся уборка — повод сказать о ней вслух, а не потерять файл.
 */
export async function teardown({ base, jar, profileId, fetchImpl = fetch }) {
  try {
    const gone = await call({
      base,
      path: '/api/profile',
      method: 'DELETE',
      body: { id: profileId },
      jar,
      fetchImpl,
    })
    return gone.status === 200
      ? { ok: true }
      : { ok: false, why: `день ответил ${gone.status} ${gone.json?.error ?? ''}` }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  }
}

/** Новый диалог под сценарий: у каждого сценария своё состояние задачи. */
async function openSession({ base, jar, fetchImpl }) {
  const made = await call({ base, path: '/api/session', method: 'POST', body: {}, jar, fetchImpl })
  if (made.status !== 200 || typeof made.json?.sessionId !== 'string') return null
  return made.json.name ?? made.json.sessionId.slice(0, 8)
}

/**
 * Весь прогон. Ходы строго последовательны и с паузой — это не медлительность,
 * а условие прохождения окон (см. шапку).
 *
 * ФАЙЛ ПИШЕТСЯ ПОСЛЕ КАЖДОГО ХОДА, а не в конце: ход стоит денег, и обрыв на
 * девятнадцатом не должен стирать восемнадцать оплаченных.
 */
export async function runAll({
  base,
  set,
  jar,
  note,
  save,
  fetchImpl = fetch,
  sleep = sleepReal,
  spacingMs = SPACING_MS,
  rounds = REVIEW_ROUNDS,
  key = null,
  log = console.log,
  now = () => new Date(),
}) {
  const ranAt = now().toISOString()
  const scenarios = []
  let first = true
  for (const source of set.scenarios) {
    const sessionName = await openSession({ base, jar, fetchImpl })
    const scenario = {
      id: source.id,
      title: source.title,
      sessionName: sessionName ?? 'диалог не создан',
      turns: [],
    }
    scenarios.push(scenario)
    if (sessionName === null) log(`${source.id}: диалог не создан — ходы пойдут в новый диалог дня`)
    for (const turn of source.turns) {
      if (!first) await sleep(spacingMs)
      first = false
      const startedAt = Date.now()
      const got = await runTurn({ base, prompt: turn.prompt, jar, fetchImpl, key })
      const latencyMs = Date.now() - startedAt
      const record = got.failure
        ? readFailure({ turn, failure: got.failure, latencyMs })
        : readTurn({ turn, result: got.result, latencyMs })
      scenario.turns.push(record)
      save(
        buildReport({
          ranAt,
          note,
          limits: limitsOf(set, rounds),
          params: PARAMS,
          scenarios,
          mixedReason: MIXED_REASON,
        }),
      )
      if (record.failure)
        log(`${source.id}/${turn.n}: отказ ${record.failure.code} — ${record.failure.message}`)
      else
        log(
          `${source.id}/${turn.n}: исход ${record.outcome}, источников ${record.sources}, ` +
            `цитат ${record.quotesVerified} из ${record.quotes} дословно, ` +
            `путей разошлось ${record.citedMismatch}, круги ${record.rounds}, ` +
            `состояние ${record.task?.stored === true ? 'легло' : 'не легло'}, ${record.latencyMs} мс`,
        )
    }
  }
  return { ranAt, scenarios }
}

/**
 * Пределы, под которыми шёл прогон. Числа дня берутся у дня (`DAY_LIMITS`), а
 * не ставятся здесь второй копией: в отчёте обязано стоять то, под чем прогон
 * шёл на самом деле.
 */
const limitsOf = (set, rounds = REVIEW_ROUNDS) => ({
  dailyCap: DAY_LIMITS.MAX_DAILY_CALLS,
  perMinute: DAY_LIMITS.RATE_LIMIT_PER_MIN,
  perHour: DAY_LIMITS.RATE_LIMIT_PER_HOUR,
  callsPerTurn: '4 + 2×кругов',
  reviewRounds: rounds,
  slotsPerTurn: rounds,
  slotsNeeded: set.scenarios.reduce((n, s) => n + s.turns.length, 0) * rounds,
  minTurns: set.minTurns,
  maxTurns: set.maxTurns,
})

const readSet = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * Заметка о прогоне. Обязательное поле файла, и вот зачем: прогон идёт по
 * ПРОДУ, а прод не равен `main`. На момент этого прогона в проде нет PR #321
 * (обрезка длинной цитаты в `agents/`) — значит пометки дословности измерены
 * ДО него, и сравнивать их с числами после выкатки нельзя молча.
 */
/**
 * Чем прод отличается от `main` на момент прогона. ПРАВИТСЯ РУКОЙ ПЕРЕД
 * ПРОГОНОМ — вывести это из кода нечем: прогон знает адрес дня и больше
 * ничего, а разницу «что слито, но не выкачено» знает только тот, кто прогон
 * запускает. Пустая строка здесь означала бы «прод равен main», и проверить
 * это по файлу было бы нечем.
 */
export const PROD_GAP =
  'Прогон начат на проде = main 84178a08 (правка потолка шестого вызова, PR #328, ADR ' +
  '2026-10-05-1543, и ключ оператора, PR #326). ПОСРЕДИ ПРОГОНА в main слились и выкатились ' +
  'PR #327 и #329, корпус переиндексировался, и индекс сменился на a2a93b9b: сценарий s1 и ' +
  'ход s2/2 измерены на 84178a08, ходы s2/3–s2/12 — на a2a93b9b. Какой ход на каком, ' +
  'говорит поле indexCommit каждого хода; сверка индекса это и поймала. ' +
  'Прошлый прогон 2026-10-05T11:38Z шёл ДО правки потолка и намерил именно её отсутствие: ' +
  'шестой вызов обрезался, и правка состояния задачи не легла на 13 ходах из 18 ' +
  '(признак stored). Цель при этом оставалась прежней — состояние несёт предыдущее, а не ' +
  'пустое, — поэтому механическая проверка цели того дефекта не показывала; показывал ' +
  'именно stored. Непослитым в проде остаётся только сам этот PR — прогон и секция итогов, ' +
  'на поведение агента они не влияют.'

/**
 * Почему смешанный индекс этого прогона принят. ПРАВИТСЯ РУКОЙ, как и
 * `PROD_GAP`: причину переиндексации посреди прогона код знать не может.
 *
 * Пустая строка — объявления нет, и смешанный индекс валит `--check`. Это
 * умолчание: принять смешение можно только сказав, почему.
 */
export const MIXED_REASON =
  'Выкатка PR #327 и #329 в main (a2a93b9) пришлась на окно прогона: корпус ' +
  'переиндексировался между ходами s2/2 и s2/3. Разница корпусов между 84178a0 и a2a93b9 — ' +
  'содержимое этих двух PR (мера дня 23 на 30 вопросах и умолчание RUN_MODE дня 24), то есть ' +
  'документы и код дней 23 и 24, не дня 25. Решение принять замер, а не выбрасывать его, — ' +
  'владельца (2026-10-05): третий прогон в тот же день упирался в суточный потолок (47 из 50).'

export const noteFor = ({ rounds, keyUsed }) =>
  `Прогон по проду. ${PROD_GAP} ` +
  (rounds === 1
    ? 'Предел кругов проверки — 1 на весь прогон (без ключа оператора окно часа не пустило бы 24 хода), ' +
      'поэтому признак rounds здесь ничего не различает: цикл проверки этот прогон не мерит. '
    : `Предел кругов проверки — ${rounds}, умолчание дня; окна минуты и часа сняты ключом оператора. `) +
  (keyUsed
    ? 'Ход создавался с ключом оператора: окна «в минуту/в час» на адрес сняты, суточный потолок дня — нет. '
    : 'Ключа оператора не было: прогон шёл под окнами дня. ') +
  'Вердиктов и текстов ответов в файле нет — судейство дней 24–25 владелец отложил, ' +
  'мера дня 25 — механика хода.'

/**
 * Точка входа. Два дела и ничего больше:
 *   без флагов — прогон по проду и запись файла результата;
 *   `--check`  — сверка формы уже лежащего файла.
 */
export async function main({
  argv = [],
  fetchImpl = fetch,
  sleep = sleepReal,
  log = console.log,
  now = () => new Date(),
  readKey = readEvalKey,
} = {}) {
  const flag = (name) => argv.includes(name)
  const value = (name, fallback) => {
    const at = argv.indexOf(name)
    return at === -1 || at + 1 >= argv.length ? fallback : argv[at + 1]
  }
  const setFile = resolve(value('--scenarios', SCENARIOS))
  const out = resolve(value('--out', OUT))
  const set = readSet(setFile)

  if (flag('--check')) {
    if (!existsSync(out)) {
      log(`файла ${out} нет — сверять нечего`)
      return 1
    }
    const problems = checkReport(JSON.parse(readFileSync(out, 'utf8')), set)
    for (const problem of problems) log(`форма: ${problem}`)
    return problems.length === 0 ? 0 : 1
  }

  // Готовый файл не затирается молча: повтор прогона — это ещё деньги и ещё
  // эмбеддинги, и решение повторить обязано быть сказано вслух.
  if (existsSync(out) && !flag('--force')) {
    log(`${out} уже есть — повтор прогона стоит денег; нужен --force`)
    return 1
  }

  // Предел кругов и ключ разбираются ДО единого запроса: оба решают, сколько
  // прогон потратит, и ошибиться здесь дешевле, чем на пятнадцатом ходе.
  const key = readKey()
  const rounds = Number(value('--rounds', REVIEW_ROUNDS))
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
    log(`--rounds должен быть целым от 1 до 3, получено ${JSON.stringify(value('--rounds', null))}`)
    return 1
  }
  if (rounds > 1 && key === null) {
    // Без ключа окно часа (30 слотов) не пустит 24 хода по два слота. Узнать
    // это на пятнадцатом ходе — значит заплатить за четырнадцать впустую.
    log(
      `--rounds ${rounds} без ключа оператора не пройдёт окно часа ` +
        `(${DAY_LIMITS.RATE_LIMIT_PER_HOUR} слотов на адрес) — денег не потрачено`,
    )
    return 1
  }
  const limits = limitsOf(set, rounds)
  const note = noteFor({ rounds, keyUsed: key !== null })

  const base = value('--base', BASE)
  const jar = createJar()
  const probe = await smoke({ base, jar, fetchImpl })
  if (!probe.ok) {
    log(`проба не прошла: ${probe.why} — денег не потрачено`)
    return 1
  }
  log(`проба прошла: профилей ${probe.profiles} из ${probe.cap}`)
  log(`ключ оператора: ${key === null ? 'нет' : 'есть'}`)
  // Суточный потолок ключ не снимает и он ОБЩИЙ НА ВСЕХ посетителей дня;
  // сколько уже потрачено сегодня, прогон узнать не может — проба живости
  // счётчиков не отдаёт намеренно. Поэтому числа названы, а вывод не сделан.
  log(
    `нужно слотов суточного потолка: ${limits.slotsNeeded} из ${limits.dailyCap}; ` +
      'потолок общий на всех, остаток снаружи не виден',
  )

  const name = `замер ${now().toISOString().slice(5, 16).replace('T', ' ')}`
  const ready = await setup({ base, jar, name, fetchImpl, rounds })
  if (!ready.ok) {
    log(`подготовка не прошла: ${ready.why} — денег не потрачено`)
    return 1
  }
  log(`профиль «${name}»: предел кругов ${rounds}`)

  mkdirSync(dirname(out), { recursive: true })
  const save = (report) => writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  const turns = set.scenarios.reduce((n, s) => n + s.turns.length, 0)
  log(`прогон: ${set.scenarios.length} сценария, ${turns} ходов через ${base}`)

  const done = await runAll({
    base,
    set,
    jar,
    note,
    save,
    fetchImpl,
    sleep,
    spacingMs: key === null ? SPACING_MS : SPACING_WITH_KEY_MS,
    rounds,
    key,
    log,
    now,
  })
  // Профиль убирается ЗДЕСЬ, а не после сверки формы: мест под профиль пять, и
  // уборка не должна зависеть от того, цел ли файл.
  const swept = await teardown({ base, jar, profileId: ready.profileId, fetchImpl })
  log(swept.ok ? `профиль «${name}» удалён` : `профиль «${name}» НЕ удалён: ${swept.why}`)

  const report = buildReport({
    ranAt: done.ranAt,
    note,
    limits,
    params: PARAMS,
    scenarios: done.scenarios,
    mixedReason: MIXED_REASON,
  })
  save(report)
  for (const scenario of report.scenarios) {
    const s = summarize(scenario.turns)
    log(
      `${scenario.id}: ходов ${s.turns}, отказов ${s.failed}, с источниками ${s.withSources}, ` +
        `цитат ${s.quotesVerified}/${s.quotes} дословно, путей разошлось ${s.citedMismatch}, ` +
        `состояние легло ${s.taskStored} раз, токенов ${s.tokens}, среднее ${s.latencyMs} мс`,
    )
  }
  const problems = checkReport(report, set)
  for (const problem of problems) log(`форма: ${problem}`)
  log(`записан ${out}`)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main({ argv: process.argv.slice(2) })
