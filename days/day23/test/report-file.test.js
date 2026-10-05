// Файл итогов, ЛЕЖАЩИЙ В РЕПОЗИТОРИИ, против эталона и против читателя.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО. `score.test.js` прогоняет `checkReport` по отчётам,
// собранным в памяти, а `run-stub.test.js` — по отчётам, собранным против
// стенда. Между ними дыра ровно в один файл: экран читает
// `public/eval.json`, и того, что лежит именно в нём, не держит никто. На дне
// 22 дыра сработала — копия вопросов в `public/eval.json` разошлась с набором
// внутри одной ветки, прогон дал код 0, а разъезд закрыли руками (находка
// `reviewer` к PR #304).
//
// Поэтому предмет здесь — ФАЙЛ НА ДИСКЕ, и проверяется он с двух сторон:
// формой (`checkReport` против отбора по эталону) и чтением (`parseEval` и
// `verdict` страницы — то, что посетитель на самом деле увидит).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  EVAL_MODES,
  formatMetric,
  hasRun,
  limitsText,
  parseEval,
  RECALL_EXPECTED,
  verdict,
} from '../public/evalview.js'
import { checkReport, MODES, PICK_COUNT, pendingRuns, selectQuestions } from '../eval/score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUERIES = join(here, '..', '..', '..', 'rag', 'eval', 'queries.json')
const REPORT = join(here, '..', 'public', 'eval.json')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

const questions = selectQuestions(read(QUERIES).queries)
const report = read(REPORT)

test('файл итогов прочитан и не пуст — иначе проверки ниже ничего не проверят', () => {
  // Пустой или переехавший файл обнулил бы всё ниже молча: цикл по нулю
  // записей зелёный, а `checkReport` ругнулся бы лишь на число вопросов.
  assert.equal(questions.length, PICK_COUNT, 'отбор по эталону дал не 30 вопросов')
  assert.equal(report.questions.length, PICK_COUNT, 'в файле итогов не 30 вопросов')
})

test('форма файла цела: вопросы те же, что даёт отбор, и сводка равна строкам', () => {
  const problems = checkReport(report, questions)
  assert.deepEqual(problems, [], `форма файла итогов: ${problems.join('; ')}`)
})

test('сверка файла действительно сверяет, а не проходит на чём угодно', () => {
  // ЧТО ЭТО ДЕРЖИТ: проверку выше. Она зелена и на `checkReport`, который
  // сверял бы одно поле из трёх, — именно так дыра дня 22 и прожила. Поэтому
  // каждое утверждение ломается по очереди, и сверка обязана это увидеть.
  const breaks = {
    'текст вопроса разошёлся': (r) => (r.questions[0].question = 'подменённый вопрос'),
    'верные документы разошлись': (r) => (r.questions[0].expect = ['agent_docs/NOT-A-FILE.md']),
    'сводка': (r) => {
      const mode = MODES.find((m) => r.modes[m] !== null)
      r.modes[mode].after.mrr10 = 0.999
    },
  }
  for (const [expected, breakIt] of Object.entries(breaks)) {
    const copy = structuredClone(report)
    breakIt(copy)
    const problems = checkReport(copy, questions)
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `подмена «${expected}» прошла молча: ${problems.join('; ') || 'претензий нет'}`,
    )
  }
})

test('страница читает этот файл как прогон, а не как пустое место', () => {
  const parsed = parseEval(report)
  assert.equal(hasRun(parsed), true, 'страница не признала файл прогоном и скажет «прогона не было»')
  assert.equal(parsed.total, PICK_COUNT)
  assert.ok(parsed.index?.commit, 'коммита индекса на экране не будет')
  assert.ok(parsed.note, 'строки о прогоне на экране не будет')
  // Фраза вывода собирается из чисел — значит, числа в файле для неё есть.
  const said = verdict(parsed)
  assert.ok(said, 'из файла не вышло ни одного вывода: сводки не хватает чисел')
  assert.match(limitsText(parsed), /Вопросов в прогоне 30/)
})

test('режим прогнан хотя бы один, и непрогнанное названо непрогнанным', () => {
  const parsed = parseEval(report)
  const ran = MODES.filter((mode) => parsed.modes[mode] !== null)
  assert.ok(ran.length > 0, 'в файле нет ни одного прогнанного режима')
  // Приём 1 мог не вместить второй режим в суточный потолок. Это законно, но
  // обязано быть видно ЧИСЛОМ, а не домыслом: столько пар ещё не измерено.
  const pending = pendingRuns(report)
  assert.equal(
    pending,
    PICK_COUNT * MODES.length - MODES.reduce((sum, mode) => sum + (report.modes[mode]?.ran ?? 0), 0),
    'число неизмеренных пар не сходится со сводками',
  )
})

test('пустой отбор посчитан отдельным числом, а не только нулями в строках', () => {
  // Долг дня 22: честный отказ и выдумка давали один вердикт 0. Здесь исход
  // «отбор ничего не оставил» обязан быть виден числом сводки.
  for (const mode of MODES) {
    const summary = report.modes[mode]
    if (summary === null) continue
    const counted = report.questions.filter((q) => q[mode]?.empty === true).length
    assert.equal(summary.emptyPicks, counted, `${mode}: число пустых отборов разошлось со строками`)
    for (const q of report.questions)
      if (q[mode]?.empty === true)
        assert.equal(q[mode].kept, 0, `${q.id}/${mode}: «отбор пуст», а оставленные есть`)
  }
})

test('строка о прогоне говорит про ТОТ индекс, по которому он считан', () => {
  // Непустой `note` держит проверка выше; здесь — что он про ЭТОТ файл.
  // Строка пишется руками (у раннера это флаг `--note`), поэтому легко
  // переживает прогон и остаётся словами о прошлом индексе. Сверяется не
  // фраза, а число: короткий коммит индекса из этого же файла.
  const parsed = parseEval(report)
  assert.ok(
    parsed.note.includes(parsed.index.commit.slice(0, 7)),
    `строка о прогоне не называет индекс ${parsed.index.commit.slice(0, 7)}: ${parsed.note}`,
  )
})

test('упавшую метрику вывод на экране называет, а не оставляет одной таблице', () => {
  // ЧТО ЭТО ДЕРЖИТ. Фраза вывода выбирает режим по MRR@10 (ADR, п. 2.4) и на
  // этом файле говорит «поднял». Recall@5 при этом упал в обоих режимах —
  // ожидание дня было обратным (ADR, п. 1.2), — и посетитель обязан прочитать
  // это во фразе, а не только вычесть сам в таблице сводки. Какие режимы
  // упали, тест не знает заранее: он считает это по файлу.
  const parsed = parseEval(report)
  const said = verdict(parsed)
  for (const [mode, label] of EVAL_MODES) {
    const m = parsed.modes[mode]
    if (m === null || m.after.recall5 === null || m.after.recall5 >= m.before.recall5) continue
    const numbers = `${formatMetric(m.before.recall5)} → ${formatMetric(m.after.recall5)}`
    assert.ok(
      said.text.includes(numbers),
      `${mode}: Recall@5 упал (${numbers}), а вывод на экране об этом молчит: ${said.text}`,
    )
    // Не подтвердилось НАПРАВЛЕНИЕ, а не уровень: у этого файла «после» у
    // режима с переписыванием (0,633) выше ожидания 0,58, и фраза, сказавшая
    // «уровня не достигли», противоречила бы соседним числам на том же экране
    // (находка design-review к PR #327).
    assert.match(said.text, /о направлении/)
    assert.match(said.text, /Направления мера не подтвердила/)
    if (m.after.recall5 >= RECALL_EXPECTED)
      assert.ok(
        said.text.includes(`«${label}» ${formatMetric(m.after.recall5)}`),
        `${mode}: уровень ожидания взят (${formatMetric(m.after.recall5)}), а вывод этого не говорит: ${said.text}`,
      )
  }
})

test('у каждого отказа в файле вопрос в этом режиме так и не измерен', () => {
  // Файл собран тремя приёмами, и слияние обязано убирать отказ, который
  // следующий приём домерил: иначе на экране остался бы отказ рядом с
  // числами того же вопроса.
  for (const failure of report.failures ?? []) {
    const row = report.questions.find((q) => q.id === failure.id)
    assert.ok(row, `отказ ${failure.id}/${failure.mode}: такого вопроса в наборе нет`)
    assert.equal(
      row[failure.mode] ?? null,
      null,
      `${failure.id}/${failure.mode}: отказ остался в файле, хотя пара измерена`,
    )
  }
})
