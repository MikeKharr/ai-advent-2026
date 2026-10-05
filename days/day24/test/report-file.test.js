// Файл результата, ЛЕЖАЩИЙ В РЕПОЗИТОРИИ, против набора вопросов дня 22.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО. `score.test.js` прогоняет `checkReport` по отчётам,
// собранным в памяти, а `run-stub.test.js` — по отчёту, который прогон написал
// на стенде. Между ними дыра ровно в один файл: экран читает
// `public/eval.json` — ВТОРУЮ копию полей набора, — и равенство копий не держал
// бы никто. Дыра срабатывала в дне 22: на `e3e26d2` его ветки копия в
// `public/eval.json` разошлась с `eval/questions.json`, `node --test` дал
// 157/157, `--check` — код 0, а разъезд закрыли руками (находка `reviewer` к
// PR #304).
//
// Поэтому предмет здесь — ФАЙЛ НА ДИСКЕ, а не отчёт из фикстуры.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkReport, judgedVerdicts, MODES, OUTCOMES } from '../eval/score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUESTIONS = join(here, '..', '..', 'day22', 'eval', 'questions.json')
const REPORT = join(here, '..', 'public', 'eval.json')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

const questions = read(QUESTIONS).questions
const report = read(REPORT)

test('файл результата прочитан и не пуст — иначе проверки ниже ничего не проверят', () => {
  // Пустой или переехавший файл обнулил бы всё ниже молча: цикл по нулю записей
  // зелёный, а `checkReport` по пустому отчёту ругнулся бы лишь на число.
  assert.equal(questions.length, 10, 'набор вопросов не десять')
  assert.equal(report.questions.length, 10, 'в файле результата не десять вопросов')
})

test('копия набора в public/eval.json равна questions.json дня 22', () => {
  const problems = checkReport(report, questions)
  assert.deepEqual(problems, [], `форма файла результата: ${problems.join('; ')}`)
})

test('сверка копий действительно сверяет каждое из трёх полей', () => {
  // ЧТО ЭТО ДЕРЖИТ: проверку выше. Она была бы зелёной и у `checkReport`,
  // который сверяет одно поле из трёх, — именно так дыра и прожила до PR #304
  // в дне 22. Поэтому каждое поле ломается по очереди, и `checkReport` обязан
  // это увидеть.
  const broken = {
    set: 'missed',
    question: 'подменённый вопрос',
    expect: ['agent_docs/NOT-A-FILE.md'],
  }
  for (const [field, value] of Object.entries(broken)) {
    const copy = structuredClone(report)
    const target = copy.questions.find((q) => JSON.stringify(q[field]) !== JSON.stringify(value))
    assert.ok(target, `${field}: подмена совпала с настоящим значением — проверено не то`)
    target[field] = value
    assert.notDeepEqual(
      checkReport(copy, questions),
      [],
      `${field}: разъезд копии с questions.json прошёл молча`,
    )
  }
})

test('прогон состоялся целиком: у каждого вопроса есть исход из четырёх', () => {
  // Непрогнанный вопрос файлу не запрещён — страница скажет «не прогнан». Но
  // ЭТОТ файл собран полным прогоном, и неполнота в нём означала бы потерю
  // запуска между прогоном и коммитом.
  assert.deepEqual(report.failures, [], `в прогоне есть отказы: ${JSON.stringify(report.failures)}`)
  for (const q of report.questions) {
    assert.notEqual(q.run, null, `${q.id}: запуска нет, а отказов в файле нет`)
    assert.ok(OUTCOMES.includes(q.run.outcome), `${q.id}: исход ${q.run.outcome} не из четырёх`)
  }
})

test('режим и коммит индекса записаны: без них числа не к чему отнести', () => {
  assert.ok(MODES.includes(report.mode), `режим прогона ${report.mode} не из двух`)
  assert.match(report.index.commit, /^[0-9a-f]{7,40}$/, 'коммит индекса не похож на коммит')
  assert.equal(report.index.strategy, 'structural')
})

test('судейства не было, и файл не притворяется, будто было', () => {
  // Решение владельца 2026-10-05: день 24 сдаёт только механику. Вердикт,
  // появившийся здесь без имени судьи, валит `checkReport` — это и есть
  // граница, которую держит сверка.
  assert.equal(judgedVerdicts(report), 0, 'в файле стоят вердикты, которых никто не ставил')
  assert.equal(report.judge.name, null)
  assert.equal(report.judge.rubric, null)
  assert.match(report.note, /судейство не проводилось/i)
})
