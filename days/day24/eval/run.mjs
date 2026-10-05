#!/usr/bin/env node
// Прогон 10 контрольных вопросов ЧЕРЕЗ ПУБЛИЧНЫЙ API ДНЯ 24 (ADR
// 2026-10-05-0544, п. 2.5). Node 22, без зависимостей.
//
// ПОЧЕМУ ЧЕРЕЗ ПУБЛИЧНЫЙ АДРЕС, А НЕ МИМО. Локальной связки с ключами у
// прогона нет и не будет (I-3): он ходит тем же путём, что посетитель, — `POST
// /api/runs` и поток событий, — поэтому мерит то, что видит посетитель, и не
// заводит ни лишней копии ключа, ни второго способа позвать модель. Ключей
// этот скрипт не читает вовсе: единственное, что он знает, — адрес страницы.
//
// НАБОР ВОПРОСОВ — ФАЙЛ ДНЯ 22 (`days/day22/eval/questions.json`), читается
// как есть и не копируется сюда. Так велит ADR («те же, что в дне 22»), и так
// же говорит страница (`days/day24/public/evalview.js`, шапка). Вторая копия
// набора разъехалась бы с первой, и сравнивать дни стало бы нельзя.
//
// ЭТО СТОИТ ДЕНЕГ, и числа названы до запуска: 10 запусков из 50 суточных дня,
// по 2–3 вызова модели каждый, около $0,15 по ценам router/config/providers.json,
// 10–20 эмбеддингов из 500 суточных службы `rag` (ADR, п. 4). Повтор прогона
// тратит столько же ещё раз и даёт другие тексты, поэтому готовый файл
// результата по умолчанию НЕ ЗАТИРАЕТСЯ: нужен `--force`.
//
// РИТМ. У дня 5 запусков в минуту на адрес (`days/day24/env.js`), у службы
// `rag` — 10 в минуту на весь хост. Поэтому запуски идут строго по одному с
// паузой `SPACING_MS` между ними: залп получил бы 429 и обнулил часть набора.
//
// ПЕРВЫЙ ЗАПУСК — ДЫМОВОЙ, и его отказ останавливает весь прогон (см.
// `runAll`). День 24 первым зовёт модель со схемой JSON, и схема к провайдеру
// ещё не ездила (ADR, «Что проверено лично и что нет»). Если провайдер её
// отклонил, остальные девять запусков отклонятся так же — и заплатить за это
// придётся девять раз.
//
// РЕЖИМ ПРОГОНА НЕ ЗАДАЁТСЯ ЗДЕСЬ. Его называет сервер дня переменной
// `RUN_MODE` (`days/day24/env.js`), и тело запроса поле `mode` не несёт вовсе:
// день его не читает (`days/day24/server.js`, `handleRun`), а послать его
// значило бы написать в файл результата режим, которым прогон, возможно, и не
// шёл. Режим берётся из ответа запуска — полем `result.mode`.
//
// ЧЕГО ЗДЕСЬ НЕТ: вердиктов. Прогон собирает механику и тексты ответов. В дне
// 24 судейства не было вовсе (решение владельца 2026-10-05), и подпись файла
// говорит это словами (`score.mjs`, `NOTE`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, checkReport, pendingVerdicts, scoreRun } from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUESTIONS = join(here, '..', '..', 'day22', 'eval', 'questions.json')
const OUT = join(here, '..', 'public', 'eval.json')

/** Публичный адрес дня. Прогон идёт по нему и ни по какому другому. */
export const BASE = 'https://challenge.zpq.ai/day24'

/**
 * Пауза между запусками. 12,0 с хватило бы ровно на 5 в минуту, 13 с оставляет
 * запас на расхождение часов и на то, что окно считает время прихода запроса,
 * а не ухода ответа.
 */
export const SPACING_MS = 13_000

/** Создание запуска — быстрый вызов. Ответ модели ждём отдельно, в потоке. */
const CREATE_TIMEOUT_MS = 15_000
/** Потолок ожидания одного ответа: у дня 24 до трёх вызовов модели на запуск. */
const ANSWER_TIMEOUT_MS = 180_000

const sleepReal = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Разбор потока событий. Нужен только один кадр — `end`: он несёт
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
 * Один вопрос. Возвращает `{result}` либо `{failure}` — и никогда не бросает:
 * отказ формы ответа, отказ службы поиска, 429 лимитера и обрыв сети это
 * РЕЗУЛЬТАТ прогона, а не его авария, и он обязан доехать до файла.
 *
 * Тело запроса — ровно `{question}`. Поля `mode` в нём нет: см. шапку файла.
 */
export async function runOne({ base, question, fetchImpl = fetch }) {
  let created
  try {
    created = await fetchImpl(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: question.question }),
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

/**
 * Весь набор. Запуски строго последовательны и с паузой между ними — это не
 * медлительность, а условие прохождения окон (см. шапку).
 *
 * ПЕРВЫЙ ОТКАЗ ОСТАНАВЛИВАЕТ ПРОГОН, и это про деньги, а не про аккуратность.
 * Отказ самого первого запуска значит, что сломан путь, а не вопрос: схему
 * отклонил провайдер (`answer_invalid`), день отверг тело (`http_400`), служба
 * поиска недоступна, лимитер держит окно. Все эти отказы одинаковы для всех
 * десяти вопросов, и девять следующих запусков заплатили бы за тот же ответ
 * девять раз. Возвращается `{runs, aborted}`; при `aborted` файл НЕ пишется —
 * прогона не было.
 *
 * ЧЕСТНАЯ ГРАНИЦА: останавливает только отказ ПЕРВОГО запуска. Отказ второго и
 * дальше не останавливает ничего — он едет в `failures` и остаётся виден на
 * странице строкой «не прогнан». Одиночный отказ посередине — это свойство
 * набора, а не поломка пути, и обрывать из-за него остальные вопросы значило бы
 * выбрасывать уже оплаченное.
 */
export async function runAll({
  base,
  questions,
  fetchImpl = fetch,
  sleep = sleepReal,
  spacingMs = SPACING_MS,
  log = console.log,
}) {
  const runs = new Map()
  let first = true
  for (const question of questions) {
    if (!first) await sleep(spacingMs)
    const got = await runOne({ base, question, fetchImpl })
    runs.set(question.id, got)
    if (got.failure) log(`${question.id}: отказ ${got.failure.code} — ${got.failure.message}`)
    else {
      const m = scoreRun(question, got.result)
      log(
        `${question.id}: исход ${m.outcome}, ответ ${m.answer.length} знаков, ` +
          `источники ${m.has_sources}, цитаты ${m.has_quotes}, ` +
          `дословны ${m.quotes_verified}, путь эталона ${m.cited_exact}`,
      )
    }
    if (first && got.failure) {
      log(
        `дымовой запуск (${question.id}) отказал: ${got.failure.code} — ${got.failure.message}. ` +
          'Прогон остановлен, остальные девять запусков не потрачены.',
      )
      return { runs, aborted: got.failure }
    }
    first = false
  }
  return { runs, aborted: null }
}

/** Режим и индекс — из первой удачной выдачи, а не из догадки. */
export function contextOf(runs) {
  let mode = null
  let index = { commit: null, strategy: null }
  for (const got of runs.values()) {
    if (mode === null && typeof got.result?.mode === 'string') mode = got.result.mode
    const gotIndex = got.result?.index
    if (index.commit === null && gotIndex && typeof gotIndex.commit === 'string')
      index = { commit: gotIndex.commit, strategy: gotIndex.strategy }
  }
  return { mode, index }
}

const readQuestions = (file) => JSON.parse(readFileSync(file, 'utf8')).questions

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
  const questionsFile = resolve(value('--questions', QUESTIONS))
  const out = resolve(value('--out', OUT))
  const questions = readQuestions(questionsFile)

  if (flag('--check')) {
    if (!existsSync(out)) {
      log(`файла ${out} нет — сверять нечего`)
      return 1
    }
    const report = JSON.parse(readFileSync(out, 'utf8'))
    const problems = checkReport(report, questions)
    for (const problem of problems) log(`форма: ${problem}`)
    // Пустые вердикты — ЧИСЛО В ВЫВОДЕ, а не повод упасть: судейства в этом дне
    // не было по решению владельца, и красный `--check` был бы красным по
    // плану. Граница этого послабления названа в `score.mjs`, `pendingVerdicts`.
    log(`вердиктов не стоит: ${pendingVerdicts(report)}`)
    return problems.length === 0 ? 0 : 1
  }

  // Готовый файл не затирается молча: повтор прогона — это ещё $0,15 и ещё
  // десять запусков суточного потолка, и решение повторить обязано быть
  // сказано вслух.
  if (existsSync(out) && !flag('--force')) {
    log(`${out} уже есть — повтор прогона стоит денег; нужен --force`)
    return 1
  }

  const base = value('--base', BASE)
  log(`прогон: ${questions.length} вопросов через ${base}; первый — дымовой`)
  const { runs, aborted } = await runAll({ base, questions, fetchImpl, sleep, log })
  if (aborted !== null) {
    log('файл результата не записан: прогона не было')
    return 1
  }
  const { mode, index } = contextOf(runs)
  const report = buildReport({ questions, runs, ranAt: now().toISOString(), mode, index })
  const problems = checkReport(report, questions)
  for (const problem of problems) log(`форма: ${problem}`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  log(`записан ${out}: отказов ${report.failures.length}, режим ${mode}`)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main({ argv: process.argv.slice(2) })
