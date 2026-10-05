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
// ПОЧЕМУ ПРЕДЕЛ КРУГОВ — ЕДИНИЦА, И ЭТО НЕ ЭКОНОМИЯ РАДИ ЭКОНОМИИ. День
// занимает `reviewRounds` слотов НА ХОД, и слоты эти уходят во все три окна
// сразу (`days/day25/limits.js`, `reserve`): при умолчании 2 окно часа (30)
// пускает 15 ходов, а прогону нужно 22 — часть набора получила бы 429 и
// обнулилась. Предел кругов живёт только в настройках профиля, поэтому прогон
// ставит его ручкой `PUT /api/settings` и пишет в файл. ЧЕСТНАЯ ГРАНИЦА,
// которую надо называть вместе с этим: при пределе 1 круг всегда один, и
// признак `rounds` в файле ничего не различает — цикл проверки этот прогон не
// мерит вовсе.
//
// РИТМ. У дня 5 запусков в минуту на адрес и 30 в час (`days/day25/env.js`), у
// службы `rag` — 10 в минуту на весь хост. Поэтому ходы идут строго по одному
// с паузой `SPACING_MS`: залп получил бы 429 и обнулил часть набора.
//
// ЧЕГО ЗДЕСЬ НЕТ: вердиктов и текстов ответов. Судейство дней 24–25 владелец
// отложил, и мера дня — механика хода (`mechanics.mjs`, шапка).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, checkReport, readFailure, readTurn, summarize } from './mechanics.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCENARIOS = join(here, 'scenarios.json')
const OUT = join(here, '..', 'public', 'eval.json')

/** Публичный адрес дня. Прогон идёт по нему и ни по какому другому. */
export const BASE = 'https://challenge.zpq.ai/day25'

/** Предел кругов проверки на весь прогон — см. шапку. */
export const REVIEW_ROUNDS = 1

/**
 * Пауза между ходами. 12,0 с хватило бы ровно на 5 в минуту при одном слоте,
 * 13 с оставляет запас на расхождение часов и на то, что окно считает время
 * прихода запроса, а не ухода ответа.
 */
export const SPACING_MS = 13_000

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

/** Запрос к дню с cookie. Отказы возвращаются значением, а не исключением. */
async function call({ base, path, method = 'GET', body, jar, fetchImpl }) {
  const headers = {}
  const cookie = jar.header()
  if (cookie !== '') headers.cookie = cookie
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
export async function runTurn({ base, prompt, jar, fetchImpl = fetch }) {
  let created
  try {
    created = await call({
      base,
      path: '/api/answer',
      method: 'POST',
      body: { ...PARAMS, prompt },
      jar,
      fetchImpl,
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
export async function setup({ base, jar, name, fetchImpl = fetch }) {
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
    body: { reviewRounds: REVIEW_ROUNDS },
    jar,
    fetchImpl,
  })
  if (settings.status !== 200)
    return { ok: false, why: `предел кругов не выставлен: ${settings.status}` }
  return { ok: true, profileId: made.json.profile.id, name }
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
      const got = await runTurn({ base, prompt: turn.prompt, jar, fetchImpl })
      const latencyMs = Date.now() - startedAt
      const record = got.failure
        ? readFailure({ turn, failure: got.failure, latencyMs })
        : readTurn({ turn, result: got.result, latencyMs })
      scenario.turns.push(record)
      save(buildReport({ ranAt, note, limits: limitsOf(set), params: PARAMS, scenarios }))
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

const limitsOf = (set) => ({
  dailyCap: 50,
  callsPerTurn: '4 + 2×кругов',
  reviewRounds: REVIEW_ROUNDS,
  slotsPerTurn: REVIEW_ROUNDS,
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
export const NOTE =
  'Прогон по проду. PR #321 (обрезка длинной цитаты в agents/) на момент прогона НЕ выкачен, ' +
  'поэтому пометки дословности цитат измерены до него. Предел кругов проверки — 1 на весь ' +
  'прогон (иначе окно часа не пустило бы 22 хода), поэтому признак rounds здесь ничего не ' +
  'различает: цикл проверки этот прогон не мерит. Вердиктов и текстов ответов в файле нет — ' +
  'судейство дней 24–25 владелец отложил, мера дня 25 — механика хода.'

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

  // Готовый файл не затирается молча: повтор прогона — это ещё $0,6 и ещё 44
  // эмбеддинга, и решение повторить обязано быть сказано вслух.
  if (existsSync(out) && !flag('--force')) {
    log(`${out} уже есть — повтор прогона стоит денег; нужен --force`)
    return 1
  }

  const base = value('--base', BASE)
  const jar = createJar()
  const probe = await smoke({ base, jar, fetchImpl })
  if (!probe.ok) {
    log(`проба не прошла: ${probe.why} — денег не потрачено`)
    return 1
  }
  log(`проба прошла: профилей ${probe.profiles} из ${probe.cap}`)

  const name = `замер ${now().toISOString().slice(5, 16).replace('T', ' ')}`
  const ready = await setup({ base, jar, name, fetchImpl })
  if (!ready.ok) {
    log(`подготовка не прошла: ${ready.why} — денег не потрачено`)
    return 1
  }
  log(`профиль «${name}»: предел кругов ${REVIEW_ROUNDS}`)

  mkdirSync(dirname(out), { recursive: true })
  const save = (report) => writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  const turns = set.scenarios.reduce((n, s) => n + s.turns.length, 0)
  log(`прогон: ${set.scenarios.length} сценария, ${turns} ходов через ${base}`)

  const done = await runAll({
    base,
    set,
    jar,
    note: NOTE,
    save,
    fetchImpl,
    sleep,
    log,
    now,
  })
  const report = buildReport({
    ranAt: done.ranAt,
    note: NOTE,
    limits: limitsOf(set),
    params: PARAMS,
    scenarios: done.scenarios,
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
