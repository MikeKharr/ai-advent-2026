// Файл результата, ЛЕЖАЩИЙ В РЕПОЗИТОРИИ, против набора вопросов.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО. `score.test.js` прогоняет `checkReport` по отчётам,
// собранным в памяти, а `questions-match.test.js` сверяет `eval/questions.json`
// с эталоном `rag/`. Между ними была дыра ровно в один файл: экран читает
// `public/eval.json` — ВТОРУЮ копию тех же полей, — и равенство копий не держал
// никто. Дыра срабатывала: на `e3e26d2` этой же ветки `expect` m02 в
// `public/eval.json` был новой редакцией, а в `eval/questions.json` — ещё
// отвергнутой на дне 21; `node --test` дал 157/157, `--check` — код 0, а
// разъезд закрыли руками следующим коммитом (находка `reviewer` к PR #304).
//
// Поэтому предмет здесь — ФАЙЛ НА ДИСКЕ, а не отчёт из фикстуры.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkReport, pendingVerdicts } from '../eval/score.mjs'
import { main } from '../eval/run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUESTIONS = join(here, '..', 'eval', 'questions.json')
const REPORT = join(here, '..', 'public', 'eval.json')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

const questions = read(QUESTIONS).questions
const report = read(REPORT)

test('файл результата прочитан и не пуст — иначе проверки ниже ничего не проверят', () => {
  // Пустой или переехавший файл обнулил бы всё ниже молча: цикл по нулю
  // записей зелёный, а `checkReport` по пустому отчёту ругнулся бы лишь на
  // число вопросов.
  assert.equal(questions.length, 10, 'набор вопросов не десять')
  assert.equal(report.questions.length, 10, 'в файле результата не десять вопросов')
})

test('копия набора в public/eval.json равна eval/questions.json во всех пяти полях', () => {
  const problems = checkReport(report, questions)
  assert.deepEqual(problems, [], `форма файла результата: ${problems.join('; ')}`)
})

test('сверка копий действительно сверяет каждое из пяти полей', () => {
  // ЧТО ЭТО ДЕРЖИТ: проверку выше. Она зелёная и на `checkReport`, который
  // сверяет два поля из пяти, — именно так дыра и прожила до PR #304. Поэтому
  // каждое поле ломается по очереди и `checkReport` обязан это увидеть.
  const broken = {
    set: 'missed',
    question: 'подменённый вопрос',
    expect: 'подменённый выверенный ответ',
    key: 'подменённая ключевая фраза',
    sources: ['agent_docs/NOT-A-FILE.md'],
  }
  for (const [field, value] of Object.entries(broken)) {
    const copy = structuredClone(report)
    const target = copy.questions.find((q) => q[field] !== value)
    assert.ok(target, `${field}: подмена совпала с настоящим значением — проверено не то`)
    target[field] = value
    const problems = checkReport(copy, questions)
    assert.notDeepEqual(problems, [], `подмена поля ${field} в public/eval.json прошла молча`)
  }
})

test('--check падает на забытом вердикте и не падает на законном null у отказа', async () => {
  // Предмет — КОД ВОЗВРАТА, а не строка вывода: до PR #304 `--check` печатал
  // «вердиктов без судьи: N» и отдавал 0 при любом N, то есть забытый вердикт
  // был просто другой цифрой в выводе.
  const lines = []
  const log = (line) => lines.push(String(line))

  const clean = await main({ argv: ['--check', '--questions', QUESTIONS, '--out', REPORT], log })
  assert.equal(clean, 0, `сверка лежащего файла падает: ${lines.join(' | ')}`)

  // Законный null у отказа в файле ЕСТЬ — иначе проверка выше зелена впустую.
  const refusals = report.questions.flatMap((q) =>
    ['rag', 'norag'].filter((m) => q.modes[m]?.refused === true && q.modes[m]?.verdict === null),
  )
  assert.ok(refusals.length > 0, 'в файле нет ни одного отказа с null — случай не проверен')
  assert.equal(pendingVerdicts(report), 0, 'отказ посчитан ждущим судьи')
})

test('--check падает, когда вердикт потерян у ответа без отказа', async () => {
  const copy = structuredClone(report)
  const target = copy.questions.find((q) => q.modes.norag?.refused === false)
  assert.ok(target, 'в файле нет ответа без отказа — проверено не то')
  target.modes.norag.verdict = null

  // Копия пишется во временный каталог: предмет — код возврата `--check`, а
  // файл в репозитории правиться не должен даже на время прогона.
  const dir = mkdtempSync(join(tmpdir(), 'day22-check-'))
  const file = join(dir, 'eval.json')
  writeFileSync(file, `${JSON.stringify(copy, null, 2)}\n`)
  try {
    const lines = []
    const code = await main({
      argv: ['--check', '--questions', QUESTIONS, '--out', file],
      log: (line) => lines.push(String(line)),
    })
    assert.equal(code, 1, 'потерянный вердикт не валит сверку')
    assert.ok(
      lines.some((line) => line.includes('вердиктов без судьи: 1')),
      `причина не названа вслух: ${lines.join(' | ')}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Держатель общих вопросов: их выверенный ответ обязан быть ОБЩИМ знанием.
 *
 * ЧТО СТОЯЛО ЗДЕСЬ ДО ЭТОГО и почему ушло. Прежний держатель сверял выверенный
 * ответ m02 («что такое Recall@5») с `rag/metrics.py`. Эта связь и была
 * признаком дефекта: общий вопрос — тот, ответа на который в проекте НЕТ, а его
 * выверенный ответ ссылался на файл проекта, и на прогоне 2026-10-04 поиск
 * нашёл ответ в корпусе и получил вердикт 2 (`public/eval.json`, m02/rag) —
 * строгий промпт отказать не мог, потому что отказывать было не на чем. Оба
 * общих вопроса заменены (решение владельца 2026-10-05), и держатель с ними не
 * переезжает: привязывать общий ответ к исходнику проекта — ровно то, чего
 * делать нельзя.
 *
 * ЧТО ДЕРЖИТСЯ ЗДЕСЬ ЧЕСТНО: не смысл ответа — его тестом не проверить, — а то,
 * что ответ не стал знанием проекта. Пути единиц, имя проекта и номер ADR в
 * выверенном ответе общего вопроса означают, что вопрос перестал быть общим, и
 * пометка `general` («вопроса в проекте нет») стала ложной молча.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: доказательства отсутствия ответа в корпусе. Его даёт прогон
 * поиска по живому индексу (описание PR), а не тест: грепом семантическое
 * отсутствие не проверяется, и пустой греп отсутствием не является.
 */
test('выверенный ответ общего вопроса не ссылается на проект — иначе вопрос не общий', () => {
  const general = questions.filter((q) => q.set === 'general')
  // Число названо, а не выведено из файла: подмена `set` у обоих оставила бы
  // цикл пустым и зелёным.
  assert.equal(general.length, 2, 'общих вопросов в наборе не два')

  // Приметы знания проекта: путь единицы, имя проекта, номер ADR.
  const marks = [
    /agent_docs\//,
    /\brag\//,
    /router\//,
    /agents\//,
    /mcpnews\/|mcpstore\/|mcp\//,
    /deploy\//,
    /days\/day\d+/,
    /AGENTS\.md/,
    /ai-advent-2026/,
    /\b20\d\d-\d\d-\d\d-\d{4}\b/,
  ]
  for (const q of general) {
    assert.ok(q.expect.length > 0, `${q.id}: выверенный ответ пуст`)
    for (const mark of marks)
      assert.doesNotMatch(q.expect, mark, `${q.id}: выверенный ответ общего вопроса ссылается на проект`)
    assert.doesNotMatch(q.question, /ai-advent-2026/, `${q.id}: сам вопрос назван про этот проект`)
  }
})
