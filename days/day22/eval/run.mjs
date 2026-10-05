#!/usr/bin/env node
// Прогон 10 контрольных вопросов × 2 режима ЧЕРЕЗ ПУБЛИЧНЫЙ API ДНЯ (ADR
// 2026-10-04-0735, п. 6). Node 22, без зависимостей.
//
// ПОЧЕМУ ЧЕРЕЗ ПУБЛИЧНЫЙ АДРЕС, А НЕ МИМО. Пути мимо дня у прогона нет и не
// будет: он ходит тем же путём, что посетитель, — `POST /api/runs` и поток
// событий, — поэтому мерит то, что видит посетитель, и не заводит второго
// способа позвать модель.
//
// КЛЮЧ ОПЕРАТОРА (ADR 2026-10-05-1130). Один ключ прогон всё-таки знает —
// `EVAL_KEY` дня, и только его: ключей к модели, к роутеру, к службе поиска и к
// сервису агентов у него нет по-прежнему (I-3). Ключ читается из ФАЙЛА, путь
// которого даёт `EVAL_KEY_FILE` (умолчание `~/.config/advent/eval.key`), и
// уходит заголовком `x-eval-key` при создании запуска. Он снимает окна «в
// минуту/в час» НА АДРЕС — и только их: суточный потолок дня и бюджет
// приложения остаются. Файла нет — прогон идёт как раньше, под окнами.
// Значение не печатается ни при каком исходе: в вывод идёт «есть» или «нет».
//
// ЭТО СТОИТ ДЕНЕГ, и числа названы до запуска: 20 запусков, 10 из них с
// поиском, около $0,14 по ценам router/config/providers.json, 10 эмбеддингов
// из 500 суточных службы `rag` и 20 из 50 суточных вызовов дня (ADR, п. 4).
// Повтор прогона тратит столько же ещё раз и даёт другие тексты, поэтому
// готовый файл результата по умолчанию НЕ ЗАТИРАЕТСЯ: нужен `--force`.
//
// РИТМ. У дня 5 запусков в минуту на адрес (`days/day22/env.js`), у службы
// `rag` — 10 в минуту на весь хост (ADR, п. 4, развилка Р6(а)). Поэтому
// запуски идут строго по одному с паузой между ними: залп получил бы 429 и
// обнулил часть набора. Без ключа оператора пауза `SPACING_MS` — 20 запусков ×
// 13 с ≈ 4,5 минуты плюс время ответов модели. С ключом окна дня сняты, но
// окно службы `rag` остаётся, и паузу задаёт оно: `SPACING_WITH_KEY_MS`.
//
// ЧЕГО ЗДЕСЬ НЕТ: вердиктов. Прогон собирает механику и тексты ответов, а
// вердикт 0/1/2 по рубрике ставит отдельный экземпляр роли `reviewer` после
// прогона (ADR, п. 6, развилка Р4(а)) — он же вписывает своё имя в
// `judge.name`. `--check` после этого сверяет форму файла.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, checkReport, MODES, pendingVerdicts, scoreRun } from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUESTIONS = join(here, 'questions.json')
const OUT = join(here, '..', 'public', 'eval.json')

/** Публичный адрес дня. Прогон идёт по нему и ни по какому другому. */
export const BASE = 'https://challenge.zpq.ai/day22'

/**
 * Пауза между запусками БЕЗ ключа оператора. 12,0 с хватило бы ровно на 5 в
 * минуту, 13 с оставляет запас на расхождение часов и на то, что окно считает
 * время прихода запроса, а не ухода ответа.
 */
export const SPACING_MS = 13_000

/**
 * Пауза между запусками С ключом оператора (ADR 2026-10-05-1130, п. 9). Окна
 * дня сняты, и связывает теперь окно службы `rag` — 10 запросов в минуту на
 * весь хост, то есть 6,0 с на запрос с поиском. Запуск с поиском в наборе
 * КАЖДЫЙ ВТОРОЙ (режимы `rag` и `norag` идут парой), поэтому 6,5 с паузы дают
 * 13 с между обращениями к службе — тот же запас, что и раньше.
 *
 * Это не «быстрее в любом месте»: прогон ускоряется вдвое, а не становится
 * мгновенным, и причина названа числом, а не словом.
 */
export const SPACING_WITH_KEY_MS = 6_500

/** Заголовок ключа оператора. Тот же, что у дня (`days/day22/limits.js`). */
export const EVAL_HEADER = 'x-eval-key'

/** Умолчание пути к файлу ключа оператора. */
export const EVAL_KEY_FILE = join(homedir(), '.config', 'advent', 'eval.key')

/**
 * Ключ оператора из файла, либо `null`, если файла нет, он не читается или
 * пуст. Отсутствие — НЕ ошибка: прогон тогда идёт под окнами, как до ADR
 * 2026-10-05-1130.
 *
 * Значение из этой функции не печатается нигде: единственный его потребитель —
 * заголовок запроса. Поэтому и ошибка чтения глотается молча — текст
 * исключения `fs` несёт путь, а путь к файлу ключа в выводе не нужен.
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
export async function runOne({ base, question, mode, fetchImpl = fetch, key = null }) {
  let created
  try {
    created = await fetchImpl(`${base}/api/runs`, {
      method: 'POST',
      // Ключ оператора — только здесь, у создания запуска: окна «в минуту/в
      // час» стоят на нём. Поток событий идёт под окном чтений (600 в час), и
      // прогону из 20 чтений оно не мешает — предъявлять там нечего.
      headers: { 'content-type': 'application/json', ...(key ? { [EVAL_HEADER]: key } : {}) },
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
  key = null,
  // Пауза задаётся КЛЮЧОМ, а не вызывающим: с ключом связывает окно службы
  // `rag`, без ключа — окно дня, и это две разные величины, а не настройка.
  spacingMs = key ? SPACING_WITH_KEY_MS : SPACING_MS,
  log = console.log,
}) {
  const runs = new Map()
  let first = true
  for (const question of questions) {
    for (const mode of MODES) {
      if (!first) await sleep(spacingMs)
      first = false
      const got = await runOne({ base, question, mode, fetchImpl, key })
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
  // Ключ оператора читается здесь, а не внутри прогона: тесту нужно уметь
  // сказать «ключа нет», не завися от того, что лежит на машине запуска.
  key = readEvalKey(),
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
    // Потерянный вердикт ВАЛИТ сверку, а не остаётся строчкой в выводе: ровно
    // для этого `--check` и заведён (см. шапку `checkReport`). Законный `null`
    // у отказа ошибкой не считается — его `pendingVerdicts` не берёт.
    const pending = pendingVerdicts(report)
    if (pending > 0) log(`вердиктов без судьи: ${pending}`)
    if (report.judge?.name === null) log('имя судьи не вписано (judge.name)')
    return problems.length === 0 && pending === 0 ? 0 : 1
  }

  // Готовый файл не затирается молча: повтор прогона — это ещё $0,14 и ещё 10
  // эмбеддингов, и решение повторить обязано быть сказано вслух.
  if (existsSync(out) && !flag('--force')) {
    log(`${out} уже есть — повтор прогона стоит денег; нужен --force`)
    return 1
  }

  const base = value('--base', BASE)
  // В вывод идёт ФАКТ, а не значение: «есть» или «нет».
  log(`прогон: ${questions.length} вопросов × ${MODES.length} режима через ${base}`)
  log(`ключ оператора: ${key ? 'есть — окна дня на адрес сняты' : 'нет — прогон идёт под окнами дня'}`)
  const runs = await runAll({ base, questions, fetchImpl, sleep, key, log })
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
