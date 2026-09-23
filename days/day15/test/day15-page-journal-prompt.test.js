// Приёмка задания владельца по дню 15, пункт 4: в окне журнала у строки
// седьмого этапа раскрывается итоговый текст промпта.
//
// Как и в day15-page-prompts.test.js, правила вырезаются из самой страницы и
// исполняются: копия правила в тесте доказывала бы только саму себя. Текст
// промпта бывает в сотню килобайт, поэтому проверяется и то, что он грузится
// по раскрытию, а не вместе с журналом.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

const rules = (() => {
  const from = page.indexOf('/* --- Выделяемый блок: его извлекает test/day15-page-journal-prompt.test.js --- */')
  const to = page.indexOf('/* --- конец выделяемого блока --- */', from)
  assert.notEqual(from, -1, 'блок правил журнала обязан остаться выделяемым')
  assert.notEqual(to, -1)
  return new Function(`${page.slice(from, to)}
    return { PREPARE_STAGE, hasPromptText, promptOfRound, loadRunPrompts };`)()
})()

test('текст промпта есть только у седьмого этапа', () => {
  assert.equal(rules.PREPARE_STAGE, 'prepare')
  assert.equal(rules.hasPromptText('prepare'), true)
  for (const state of ['intake', 'assemble', 'answer', 'verify', 'replenish', 'deliver']) {
    assert.equal(rules.hasPromptText(state), false, `у этапа ${state} текста промпта нет`)
  }
})

test('в журнале раскрывается текст промпта того круга, у чьей строки он стоит', async () => {
  // `prepare` проходит на каждом круге и пишет свою строку (ADR, п. 4):
  // строка второго круга обязана раскрыть промпт второго круга.
  const records = [
    { round: 1, system: 'системный первого круга', input: 'вход первого', sha8: 'aaaaaaaa', tokens: 12 },
    { round: 2, system: 'системный второго круга', input: 'вход второго', sha8: 'bbbbbbbb', tokens: 34 },
  ]
  const calls = []
  const api = async (path) => {
    calls.push(path)
    return { prompts: records }
  }

  const loaded = await rules.loadRunPrompts(api, 'run-7/7')
  assert.deepEqual(calls, ['./api/runs/run-7%2F7/prompts'], 'идентификатор запуска экранируется')
  // Круг приходит из CSV строкой, а запись — числом: сравнение обязано это пережить.
  assert.equal(rules.promptOfRound(loaded, '2').system, 'системный второго круга')
  assert.equal(rules.promptOfRound(loaded, 1).input, 'вход первого')
  assert.equal(rules.promptOfRound(loaded, '3'), null, 'записи нет — и это честный пустой исход')
  assert.equal(rules.promptOfRound(undefined, '1'), null)
})

test('«текста нет» и «не загрузилось» — разные исходы', async () => {
  // 404 служба отдаёт, когда текста нет: у старого запуска, после «очистить».
  // «Повторить» здесь ничего не починит, и обещать починку нельзя.
  const gone = async () => {
    const error = new Error('Текст промпта не найден')
    error.status = 404
    throw error
  }
  assert.deepEqual(await rules.loadRunPrompts(gone, 'run'), [])

  const broken = async () => {
    const error = new Error('ответ 500')
    error.status = 500
    throw error
  }
  await assert.rejects(() => rules.loadRunPrompts(broken, 'run'), /500/)
})

test('ряд с текстом промпта встаёт под строкой этапа', () => {
  assert.match(
    page,
    /if \(hasPromptText\(get\('state'\)\)\) tbody\.append\(promptRow\(get\('round'\), JL_COLUMNS\.length\)\);/,
    'без этого вызова правило осталось бы верным и неприменённым',
  )
  assert.match(page, /summary\.textContent = `текст промпта · круг \$\{round \|\| 1\}`;/)
})

test('сотня килобайт не грузится раньше раскрытия и не растягивает окно', () => {
  // Текст берётся из SQLite отдельной ручкой, а не из CSV, и запрашивается
  // один раз — при первом раскрытии.
  assert.match(page, /d\.addEventListener\('toggle', \(\) => \{\s*\n\s*if \(!d\.open \|\| loaded\) return;/)
  assert.match(page, /loaded = true;\s*\n\s*fillPromptText\(box, round\);/)
  assert.match(page, /\.jl-pre \{[\s\S]*?max-height:calc\(6 \* var\(--s-6\)\);[\s\S]*?overflow:auto;/)
  // Текст — текст, а не разметка: промпт приходит из чужой правки промпта.
  assert.match(page, /pre\.textContent = String\(record\.system \?\? ''\)|pre\.textContent = String\(text \?\? ''\);/)
})

test('у текста промпта четыре состояния: загрузка, готово, пусто, ошибка с «Повторить»', () => {
  assert.match(page, /state\.textContent = 'Загружаю текст промпта…';/)
  assert.match(page, /none\.textContent = 'Текста промпта нет: запуск его не сохранил\.';/)
  assert.match(page, /err\.textContent = 'Текст промпта не загрузился';/)
  assert.match(page, /again\.onclick = \(\) => fillPromptText\(box, round\);/)
})

test('страница называет срок хранения текста промпта', () => {
  // Требование и механизм обязаны совпадать вслух: текст живёт с профилем и
  // уходит по «очистить» (ADR 2026-09-23-0646, п. 4).
  assert.match(page, /id="jl-ttl"/)
  assert.match(page, /Текст промпта хранится \$\{days\} — столько же, сколько профиль/)
  assert.match(page, /уходит ` \+\s*'по «очистить» вместе с перепиской\. В CSV его нет — только размер\.'/)
})

test('число колонок в подписи журнала берётся из файла, а не из памяти', () => {
  // В CSV прибавилась колонка размера промпта: подпись «23 колонки» стала бы
  // враньём в тот же день.
  assert.equal(/В файле 23 колонки/.test(page), false)
  const source = page.match(/const columnsNote = \(head\) =>[\s\S]*?;\n/)
  assert.notEqual(source, null)
  const columnsNote = new Function('plural',
    `${source[0]} return columnsNote;`)((n, one, few, many) => (n === 1 ? one : n < 5 ? few : many))
  assert.match(columnsNote(new Array(24).fill('x')), /В файле 24 колонок/)
  assert.match(columnsNote(new Array(23).fill('x')), /В файле 23 колонок/)
})
