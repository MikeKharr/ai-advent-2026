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
 * Держатель выверенного ответа m02 — общего вопроса «что такое Recall@5».
 *
 * У общих вопросов `origin: null`, эталонной записи в `rag/eval/queries.json`
 * нет, и `questions-match.test.js` их текст не держит: мутация «вернуть
 * отвергнутую на дне 21 редакцию» оставалась зелёной в обеих копиях (находка
 * `reviewer` к PR #304).
 *
 * ЧТО ДЕРЖИТСЯ ЗДЕСЬ ЧЕСТНО: не смысл формулы — его проверить тестом нельзя, —
 * а СВЯЗЬ двух файлов. Текст утверждает про `rag/metrics.py` две вещи:
 * (1) доля считается по верным документам ВОПРОСА — `len([...]) / len(expected)`
 * в `recall_at_k`; (2) результат усредняется ПО ВОПРОСАМ — `sum(recalls) / n` в
 * `score`. Обе строки проверяются в исходнике. Сменится механика — покраснеет
 * проверка, и текст придётся пересмотреть, а не оставить вчерашним.
 * Отвергнутая редакция («хотя бы один верный документ в первых пяти») запрещена
 * отдельно: именно её и правил последний коммит PR.
 */
test('выверенный ответ m02 описывает Recall@5 так, как его считает rag/metrics.py', () => {
  const metrics = readFileSync(join(here, '..', '..', '..', 'rag', 'metrics.py'), 'utf8')
  assert.match(metrics, /RECALL_K = 5/, 'срез k в rag/metrics.py не 5')
  assert.match(
    metrics,
    /def recall_at_k[\s\S]*?len\(\[e for e in expected if e in top\]\) \/ len\(expected\)/,
    'recall_at_k считает уже не долю верных документов вопроса',
  )
  assert.match(metrics, /"recall@\{RECALL_K\}": round\(sum\(recalls\) \/ n, 4\)/, 'score усредняет уже не по вопросам')

  const m02 = questions.find((q) => q.id === 'm02')
  assert.ok(m02, 'вопроса m02 в наборе нет')
  assert.match(m02.expect, /доля верных документов вопроса/, 'ответ m02 не говорит, по чему считается доля')
  assert.match(m02.expect, /усреднённая по вопросам/, 'ответ m02 не говорит про усреднение по вопросам')
  assert.match(m02.expect, /rag\/metrics\.py/, 'ответ m02 не называет, чья это реализация')
  assert.doesNotMatch(
    m02.expect,
    /хотя бы один верный документ оказался в первых пяти/,
    'ответ m02 вернулся к отвергнутой на дне 21 редакции',
  )

  // Копия на экране — та же. Без этого держатель стоял бы на файле, которого
  // посетитель не читает.
  const shown = report.questions.find((q) => q.id === 'm02')
  assert.equal(shown.expect, m02.expect, 'выверенный ответ m02 на экране разошёлся с набором')
})
