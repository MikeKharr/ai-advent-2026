#!/usr/bin/env node
// Прогон 10 контрольных вопросов × 2 режима ЧЕРЕЗ ПУБЛИЧНЫЙ API ДНЯ (ADR
// 2026-10-04-0735, п. 6). Node 22, без зависимостей.
//
// ПОЧЕМУ ЧЕРЕЗ ПУБЛИЧНЫЙ АДРЕС, А НЕ МИМО. Локальной связки с ключом у прогона
// нет и не будет (I-3): он ходит тем же путём, что посетитель, — `POST
// /api/runs` и поток событий, — поэтому мерит то, что видит посетитель, и не
// заводит ни четвёртой копии ключа, ни второго способа позвать модель. Ключей
// этот скрипт не читает вовсе: единственное, что он знает, — адрес страницы.
//
// ЭТО СТОИТ ДЕНЕГ, и числа названы до запуска: 20 запусков, 10 из них с
// поиском, около $0,14 по ценам router/config/providers.json, 10 эмбеддингов
// из 500 суточных службы `rag` и 20 из 50 суточных вызовов дня (ADR, п. 4).
// Повтор прогона тратит столько же ещё раз и даёт другие тексты, поэтому
// готовый файл результата по умолчанию НЕ ЗАТИРАЕТСЯ: нужен `--force`.
//
// РИТМ. У дня 5 запусков в минуту на адрес (`days/day22/env.js`), у службы
// `rag` — 10 в минуту на весь хост (ADR, п. 4, развилка Р6(а)). Поэтому
// запуски идут строго по одному с паузой `SPACING_MS` между ними: залп получил
// бы 429 и обнулил часть набора. 20 запусков × 13 с ≈ 4,5 минуты плюс время
// ответов модели.
//
// ЧЕГО ЗДЕСЬ НЕТ: вердиктов. Прогон собирает механику и тексты ответов, а
// вердикт 0/1/2 по рубрике ставит отдельный экземпляр роли `reviewer` после
// прогона (ADR, п. 6, развилка Р4(а)) — он же вписывает своё имя в
// `judge.name`. `--check` после этого сверяет форму файла.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, checkReport, MODES, pendingVerdicts, scoreRun } from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUESTIONS = join(here, 'questions.json')
const OUT = join(here, '..', 'public', 'eval.json')

/** Публичный адрес дня. Прогон идёт по нему и ни по какому другому. */
export const BASE = 'https://challenge.zpq.ai/day22'

/**
 * Пауза между запусками. 12,0 с хватило бы ровно на 5 в минуту, 13 с оставляет
 * запас на расхождение часов и на то, что окно считает время прихода запроса,
 * а не ухода ответа.
 */
export const SPACING_MS = 13_000

/** Создание запуска — быстрый вызов. Ответ модели ждём отдельно, в потоке. */
const CREATE_TIMEOUT_MS = 15_000
/** Потолок ожидания одного ответа. Больше минуты запуск дня не живёт даже с поиском. */
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
 * Один вопрос в одном режиме. Возвращает `{result}` либо `{failure}` — и
 * никогда не бросает: отказ службы поиска, 429 лимитера и обрыв сети это
 * РЕЗУЛЬТАТ прогона, а не его авария, и он обязан доехать до файла.
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
    for (const mode of MODES) {
      if (!first) await sleep(spacingMs)
      first = false
      const got = await runOne({ base, question, mode, fetchImpl })
      runs.set(`${question.id}:${mode}`, got)
      if (got.failure) log(`${question.id}/${mode}: отказ ${got.failure.code} — ${got.failure.message}`)
      else {
        const m = scoreRun(question, mode, got.result)
        log(
          `${question.id}/${mode}: ответ ${m.answer.length} знаков, ` +
            `источник ${m.retrieved}, назван ${m.cited}, фраза ${m.key}, отказ ${m.refused}`,
        )
      }
    }
  }
  return runs
}

/** Коммит и стратегия индекса — из первой удачной выдачи поиска, а не из догадки. */
export function indexOf(runs) {
  for (const got of runs.values()) {
    const index = got.result?.index
    if (index && typeof index.commit === 'string')
      return { commit: index.commit, strategy: index.strategy }
  }
  return { commit: null, strategy: null }
}

const readQuestions = (file) => JSON.parse(readFileSync(file, 'utf8')).questions

/**
 * Точка входа. Два дела и ничего больше:
 *   без флагов — прогон по проду и запись файла результата;
 *   `--check`  — сверка формы уже лежащего файла (после судейства).
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
    const pending = pendingVerdicts(report)
    if (pending > 0) log(`вердиктов без судьи: ${pending}`)
    if (report.judge?.name === null) log('имя судьи не вписано (judge.name)')
    return problems.length === 0 ? 0 : 1
  }

  // Готовый файл не затирается молча: повтор прогона — это ещё $0,14 и ещё 10
  // эмбеддингов, и решение повторить обязано быть сказано вслух.
  if (existsSync(out) && !flag('--force')) {
    log(`${out} уже есть — повтор прогона стоит денег; нужен --force`)
    return 1
  }

  const base = value('--base', BASE)
  log(`прогон: ${questions.length} вопросов × ${MODES.length} режима через ${base}`)
  const runs = await runAll({ base, questions, fetchImpl, sleep, log })
  const report = buildReport({
    questions,
    runs,
    ranAt: now().toISOString(),
    index: indexOf(runs),
  })
  const problems = checkReport(report, questions)
  for (const problem of problems) log(`форма: ${problem}`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  log(`записан ${out}: отказов ${report.failures.length}, вердиктов ждёт ${pendingVerdicts(report)}`)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main({ argv: process.argv.slice(2) })
