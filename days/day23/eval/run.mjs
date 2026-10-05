#!/usr/bin/env node
// Прогон 30 вопросов эталона × 2 режима ЧЕРЕЗ ПУБЛИЧНЫЙ API ДНЯ
// (ADR 2026-10-05-0544, п. 1.5). Node 22, без зависимостей.
//
// ПОЧЕМУ ЧЕРЕЗ ПУБЛИЧНЫЙ АДРЕС, А НЕ МИМО. Локальной связки с ключом у прогона
// нет и не будет (I-3): он ходит тем же путём, что посетитель, — `POST
// /api/runs` и поток событий, — поэтому мерит то, что видит посетитель, и не
// заводит ни второго способа позвать модель, ни ещё одной копии ключа. Ключей
// этот скрипт не читает вовсе: единственное, что он знает, — адрес страницы.
//
// ЭТО СТОИТ ДЕНЕГ, и числа названы до запуска: до 60 запусков, из них 30 с
// двумя вызовами модели (`rerank`) и 30 с тремя (`rewrite`), около $0,65 по
// верхней оценке дня; эмбеддингов до 90 из 500 суточных службы `rag`.
// Готовый файл результата по умолчанию НЕ ЗАТИРАЕТСЯ: нужен `--resume`
// (дописать недостающее) или `--force` (начать заново).
//
// ПОЧЕМУ ДВА ПРИЁМА. Суточный потолок дня — 50 запусков на всё приложение
// (`days/day23/env.js`, `MAX_DAILY_CALLS`), а набор требует 60. Поэтому первый
// приём идёт, пока потолок не кончится, а остальное дописывает второй приём
// после полуночи UTC — тем же раннером с `--resume`. Признак конца потолка —
// 429 БЕЗ `retryAfterSec`: у суточного потолка секунд до повтора нет вовсе, и
// `null` там значит «не раньше следующих суток» (`days/day23/limits.js`,
// `reserve`). Этим он и отличается от 429 окна на адрес, который надо
// переждать, а не считать концом прогона.
//
// РИТМ. Окон на адрес два, и оба связывают: 5 запусков в минуту и 30 в час
// (`days/day23/env.js`). Минутное окно задаёт паузу между запусками, часовое —
// обязательную остановку после каждых тридцати: тридцать первый запуск за час
// получит 429, и прогон его ПЕРЕЖДЁТ по `retryAfterSec`, а не потеряет вопрос.
// Служба `rag` отдельно держит 10 поисков в минуту на весь хост, а режим
// `rewrite` делает два поиска на запуск — поэтому пауза у него своя и шире.
//
// ЧЕГО ЗДЕСЬ НЕТ: судьи и вердиктов. Мера дня 23 механическая целиком
// (ADR, п. 0.3) — считаются ранги по эталону, и считать их умеет `score.mjs`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildReport,
  checkReport,
  mergeReports,
  MODES,
  pendingRuns,
  scoreRun,
  selectQuestions,
} from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUERIES = join(here, '..', '..', '..', 'rag', 'eval', 'queries.json')
const OUT = join(here, '..', 'public', 'eval.json')

/** Публичный адрес дня. Прогон идёт по нему и ни по какому другому. */
export const BASE = 'https://challenge.zpq.ai/day23'

/**
 * Пауза между запусками, по режиму.
 *
 * `rerank` — 13 с: окно дня 5 в минуту даёт 12 с на запуск, лишняя секунда —
 * запас на расхождение часов и на то, что окно считает время прихода запроса.
 *
 * `rewrite` — 16 с, и это не осторожность, а другое окно: режим делает ДВА
 * поиска на запуск, а служба `rag` держит 10 поисков в минуту на весь хост
 * (ADR 2026-10-04-0735, п. 4). 2 поиска за 16 с — 7,5 в минуту, за 13 с было
 * бы 9,2, то есть впритык к чужому окну, которое отсюда не поднять.
 */
export const SPACING_MS = { rerank: 13_000, rewrite: 16_000 }

/**
 * Сколько ждать по просьбе лимитера, самое большее. Часовое окно на адрес
 * просит до 3600 с — его надо переждать, иначе вопрос потерян; всё, что просит
 * больше, прогон считает концом приёма и записывает сделанное.
 */
export const MAX_WAIT_MS = 3_900_000
/** Сколько раз пережидать отказ окна на одном вопросе. */
const RETRIES = 3

/** Создание запуска — быстрый вызов. Ответ модели ждём отдельно, в потоке. */
const CREATE_TIMEOUT_MS = 15_000
/** Потолок ожидания одного ответа. Три вызова модели и два поиска укладываются. */
const ANSWER_TIMEOUT_MS = 240_000

const sleepReal = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Разбор потока событий. Нужен только кадр `end`: он несёт
 * `{status, result, error}` (`agents/src/service.js`, `streamEvents`). Остальные
 * кадры прогону не нужны, их предмет — экран.
 *
 * Строки-комментарии (`: ping`) и `id:` пропускаются молча: это служебное
 * оформление SSE, а не данные.
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
 * Один вопрос в одном режиме. Возвращает `{result}` либо `{failure}` — и
 * никогда не бросает: отказ службы поиска, 429 лимитера и обрыв сети это
 * РЕЗУЛЬТАТ прогона, а не его авария, и он обязан доехать до файла.
 *
 * У отказа лимитера дня в `failure` кладётся `retryAfterSec` — по нему
 * вызывающий отличает окно на адрес (переждать) от суточного потолка (конец
 * приёма). Своей копии этих правил здесь нет: число приносит сам день.
 */
export async function runOne({ base, question, mode, fetchImpl = fetch }) {
  let created
  try {
    created = await fetchImpl(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: question.question, mode }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })
  } catch (error) {
    return { failure: { code: 'create_failed', message: String(error?.message ?? error) } }
  }
  const body = await created.json().catch(() => null)
  if (created.status !== 202 || typeof body?.runId !== 'string')
    return {
      failure: {
        code: `http_${created.status}`,
        message: String(body?.error ?? 'запуск не создан'),
        ...(created.status === 429
          ? { retryAfterSec: typeof body?.retryAfterSec === 'number' ? body.retryAfterSec : null }
          : {}),
      },
    }

  let stream
  try {
    stream = await fetchImpl(`${base}/api/runs/${body.runId}/events`, {
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
          message: String(end.error?.message ?? 'запуск не удался'),
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

/** Суточный потолок исчерпан: 429, у которого секунд до повтора нет вовсе. */
export const isDailyLimit = (failure) =>
  failure?.code === 'http_429' && (failure.retryAfterSec === null || failure.retryAfterSec === undefined)

/**
 * Весь набор, режим за режимом: сначала все 30 `rerank`, потом все 30
 * `rewrite` (ADR, п. 1.5). Запуски строго последовательны и с паузой — это не
 * медлительность, а условие прохождения окон (см. шапку).
 *
 * `done` — пары `${id}:${mode}`, уже измеренные прошлым приёмом: второй приём
 * их не повторяет и денег за них второй раз не платит.
 *
 * Возвращает `{runs, stopped}`. `stopped` — суточный потолок кончился: это не
 * авария, а конец приёма, и сделанное обязано доехать до файла.
 *
 * `save` — запись файла ПОСЛЕ КАЖДОГО ЗАПУСКА, а не в конце приёма. Причина
 * названа ценой: прогон идёт больше часа (паузы под окна плюс ожидание
 * часового окна на границе режимов), и обрыв на середине терял бы ВСЁ
 * измеренное — то есть десятки оплаченных запусков, которые потом пришлось бы
 * оплатить заново. Проверено на деле: первый приём дня 23 пришлось прервать на
 * пятнадцати измеренных вопросах, и они пропали. Теперь обрыв не теряет
 * ничего: файл цел на любом шаге, а `--resume` продолжает с него.
 */
export async function runAll({
  base,
  questions,
  done = new Set(),
  fetchImpl = fetch,
  sleep = sleepReal,
  spacing = SPACING_MS,
  maxWaitMs = MAX_WAIT_MS,
  save = null,
  log = console.log,
}) {
  const runs = new Map()
  let stopped = null
  let first = true
  for (const mode of MODES) {
    for (const question of questions) {
      const key = `${question.id}:${mode}`
      if (done.has(key)) continue
      if (stopped) continue
      for (let attempt = 1; ; attempt += 1) {
        if (!first) await sleep(spacing[mode])
        first = false
        const got = await runOne({ base, question, mode, fetchImpl })
        if (got.failure && isDailyLimit(got.failure)) {
          stopped = { at: key, message: got.failure.message }
          log(`${key}: суточный потолок дня исчерпан — остальное вторым приёмом после 00:00 UTC`)
          break
        }
        // Окно на адрес: его надо переждать, а не записать потерей. Часовое
        // окно (30 запусков) срабатывает ровно на границе между режимами.
        if (got.failure?.code === 'http_429' && attempt <= RETRIES) {
          const waitMs = got.failure.retryAfterSec * 1000 + 1000
          if (waitMs <= maxWaitMs) {
            log(`${key}: окно на адрес — ждём ${got.failure.retryAfterSec} с и повторяем`)
            await sleep(waitMs)
            continue
          }
          stopped = { at: key, message: `окно просит ${got.failure.retryAfterSec} с — дольше предела приёма` }
          log(`${key}: ${stopped.message}`)
          break
        }
        runs.set(key, got)
        if (got.failure) log(`${key}: отказ ${got.failure.code} — ${got.failure.message}`)
        else {
          const m = scoreRun(question, got.result)
          log(
            `${key}: кандидатов ${m.candidates}, оставлено ${m.kept}` +
              `${m.empty ? ' (отбор пуст)' : ''}, recall@5 ${m.before.recall5}→${m.after.recall5}, ` +
              `mrr@10 ${m.before.mrr10}→${m.after.mrr10}`,
          )
        }
        // Запись сразу, а не в конце: см. `save` в шапке. Отказ записи валит
        // прогон намеренно — молча тратить потолок, не сохраняя результат,
        // хуже, чем остановиться.
        if (save) await save(runs, stopped)
        break
      }
    }
  }
  if (save) await save(runs, stopped)
  return { runs, stopped }
}

/** Индекс — из первой удачной выдачи поиска, а не из догадки. */
export function indexOf(runs, previous = null) {
  for (const got of runs.values()) {
    const index = got.result?.index
    if (index && typeof index.commit === 'string')
      return { commit: index.commit, strategy: index.strategy, chunks: index.chunks ?? null }
  }
  // Второй приём мог не сделать ни одного запуска: тогда индекс берётся из
  // прошлого приёма, а не обнуляется. Выдумать его здесь нечем.
  if (previous?.commit) return previous
  return { commit: null, strategy: null, chunks: null }
}

const readQueries = (file) => JSON.parse(readFileSync(file, 'utf8')).queries

/** Какие пары уже измерены прошлым приёмом — по самому файлу, а не по памяти. */
export function measuredPairs(report) {
  const done = new Set()
  for (const row of Array.isArray(report?.questions) ? report.questions : [])
    for (const mode of MODES) if ((row?.[mode] ?? null) !== null) done.add(`${row.id}:${mode}`)
  return done
}

/**
 * Точка входа. Три дела и ничего больше:
 *   без флагов  — прогон по проду и запись файла результата;
 *   `--resume`  — дописать недостающее, не затирая сделанного;
 *   `--check`   — сверка формы уже лежащего файла.
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
  const queriesFile = resolve(value('--queries', QUERIES))
  const out = resolve(value('--out', OUT))
  const questions = selectQuestions(readQueries(queriesFile))

  if (flag('--check')) {
    if (!existsSync(out)) {
      log(`файла ${out} нет — сверять нечего`)
      return 1
    }
    const report = JSON.parse(readFileSync(out, 'utf8'))
    const problems = checkReport(report, questions)
    for (const problem of problems) log(`форма: ${problem}`)
    const pending = pendingRuns(report)
    if (pending > 0) log(`запусков ещё не сделано: ${pending}`)
    return problems.length === 0 ? 0 : 1
  }

  const resuming = flag('--resume')
  let previous = null
  if (existsSync(out)) {
    if (!resuming && !flag('--force')) {
      log(`${out} уже есть — повтор прогона стоит денег; нужен --resume (дописать) или --force (заново)`)
      return 1
    }
    if (resuming) previous = JSON.parse(readFileSync(out, 'utf8'))
  }
  const done = resuming ? measuredPairs(previous) : new Set()

  const base = value('--base', BASE)
  log(
    `прогон: ${questions.length} вопросов × ${MODES.length} режима через ${base}` +
      (done.size > 0 ? `; ${done.size} пар уже измерено прошлым приёмом` : ''),
  )
  /**
   * Сборка и запись файла. Одна дорога и у записи после каждого запуска, и у
   * записи в конце приёма: двух сборок отчёта в одном раннере быть не должно —
   * они разъехались бы, и файл на середине прогона отличался бы от итогового.
   */
  const note = value('--note', null)
  const writeOut = (runs, stopped) => {
    const fresh = buildReport({
      questions,
      runs,
      at: now().toISOString(),
      index: indexOf(runs, previous?.index),
      note,
    })
    const report = previous ? mergeReports(previous, fresh) : fresh
    // Почему приём кончился — В ФАЙЛЕ, а не только в выводе терминала: второй
    // приём и ревью читают файл, а вывод первого приёма к тому времени потерян.
    if (stopped) {
      const [id, mode] = stopped.at.split(':')
      report.failures.push({ id, mode, code: 'day_limit', message: stopped.message })
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    return report
  }

  const { runs, stopped } = await runAll({ base, questions, done, fetchImpl, sleep, save: writeOut, log })
  const report = writeOut(runs, stopped)

  const problems = checkReport(report, questions)
  for (const problem of problems) log(`форма: ${problem}`)
  log(`записан ${out}: отказов ${report.failures.length}, запусков ещё не сделано ${pendingRuns(report)}`)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main({ argv: process.argv.slice(2) })
