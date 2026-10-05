// Файл результата, ЛЕЖАЩИЙ В РЕПОЗИТОРИИ, против набора сценариев.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО. `eval-run.test.js` прогоняет механику по отчётам,
// собранным в памяти из поддельных ответов; предмет здесь — ФАЙЛ НА ДИСКЕ,
// который читает экран. Между ними ровно та дыра, которая сработала в дне 22:
// `public/eval.json` — ВТОРАЯ копия реплик из `eval/scenarios.json`, и
// равенство копий там не держал никто, пока они не разъехались внутри одной
// ветки (находка `reviewer` к PR #304).

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseEnv } from '../env.js'
import { checkReport, summarize } from '../eval/mechanics.mjs'
import { main, PROD_GAP } from '../eval/run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SET = join(here, '..', 'eval', 'scenarios.json')
const REPORT = join(here, '..', 'public', 'eval.json')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

const set = read(SET)
const report = read(REPORT)

test('файл результата прочитан и не пуст — иначе проверки ниже ничего не проверят', () => {
  // Пустой или переехавший файл обнулил бы всё ниже молча: цикл по нулю
  // записей зелёный, а `checkReport` по пустому отчёту ругнулся бы лишь на
  // число сценариев.
  assert.equal(set.scenarios.length, 2, 'в наборе не два сценария')
  assert.equal(report.scenarios.length, 2, 'в файле результата не два сценария')
  for (const [at, scenario] of report.scenarios.entries()) {
    const turns = scenario.turns.length
    assert.ok(
      turns >= set.minTurns && turns <= set.maxTurns,
      `сценарий ${at + 1}: ходов ${turns}, а сценарий — ${set.minTurns}–${set.maxTurns}`,
    )
  }
})

test('форма файла цела, и реплики в нём равны eval/scenarios.json', () => {
  const problems = checkReport(report, set)
  assert.deepEqual(problems, [], `форма файла результата: ${problems.join('; ')}`)
})

test('сверка действительно сверяет копию набора и механику, а не только число сценариев', () => {
  // ЧТО ЭТО ДЕРЖИТ: проверку выше. Она была бы зелёной и у сверки, которая
  // смотрит два поля из десяти, — именно так дыра и прожила в дне 22. Поэтому
  // каждое поле ломается ПО ОЧЕРЕДИ и адресуется местом в файле, а не поиском
  // по тексту: подмена обязана попасть в ту запись, которую имели в виду.
  // Претензия сверяется ПО ТЕКСТУ, а не по непустоте списка. Разница не
  // теоретическая: пока утверждение было «список претензий не пуст», мутация
  // «снять сверку реплик» оставляла тест зелёным — список был непуст по другой
  // причине (цель хода, число ходов), и держателя у снятой строки не было
  // вовсе. Найдено прогоном мутаций, а не чтением.
  const breaks = [
    ['реплика', (c) => (c.scenarios[0].turns[0].prompt = 'подменённая реплика'), 'текст реплики разошёлся'],
    ['назначение хода', (c) => (c.scenarios[0].turns[1].purpose = 'подменённое назначение'), 'назначение хода разошлось'],
    ['название сценария', (c) => (c.scenarios[1].title = 'подменённое название'), 'название разошлось'],
    ['номер хода', (c) => (c.scenarios[0].turns[2].n = 99), 'номера ходов идут не по порядку'],
    ['коммит индекса', (c) => (c.index.commit = ''), 'нет коммита индекса'],
    ['заметка о прогоне', (c) => (c.note = '   '), 'нет заметки о прогоне'],
    ['сводка сценария', (c) => (c.scenarios[0].summary.withSources += 1), 'сводка в файле разошлась'],
    ['число ходов', (c) => c.scenarios[1].turns.pop(), 'ходов'],
    ['цель задачи', (c) => (c.scenarios[0].turns[3].task.goal = false), 'цель задачи пуста'],
    ['источники без исхода', (c) => (c.scenarios[0].turns[0].sources = 0), 'источников нет'],
  ]
  for (const [what, breakIt, expected] of breaks) {
    const copy = structuredClone(report)
    breakIt(copy)
    assert.notDeepEqual(
      JSON.stringify(copy),
      JSON.stringify(report),
      `подмена «${what}» ничего не изменила — проверено не то`,
    )
    const problems = checkReport(copy, set)
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `подмена «${what}» не дала претензии про «${expected}»: ${problems.join('; ')}`,
    )
  }
})

test('обещание дня проверяется по файлу: либо источники, либо «не знаю» от отбора', () => {
  // Утверждение контракта хода («Результат хода»): третьего нет. Здесь оно
  // сверяется по ЗАМЕРУ, а не по тексту документа.
  const done = report.scenarios.flatMap((s) => s.turns).filter((t) => t.failure === null)
  assert.ok(done.length > 0, 'в файле нет ни одного удавшегося хода — проверено не то')
  for (const t of done) {
    if (t.sources === 0) assert.equal(t.outcome, 'unknown_filter', `ход без источников: исход ${t.outcome}`)
    else assert.notEqual(t.outcome, 'unknown_filter', 'исход «не знаю от отбора» при наличии источников')
  }
})

test('сводка в файле — та же арифметика, что в mechanics.mjs, а не копия в разметке', () => {
  // Держатель того, что страница печатает НЕ свою арифметику: числа сводки
  // лежат в файле, и равенство их собственным ходам проверяется здесь.
  for (const scenario of report.scenarios)
    assert.deepEqual(scenario.summary, summarize(scenario.turns), `${scenario.id}: сводка не из ходов`)
})

test('--check проходит по лежащему файлу и падает на испорченной копии', async () => {
  // Предмет — КОД ВОЗВРАТА, а не строка вывода.
  const lines = []
  const clean = await main({
    argv: ['--check', '--scenarios', SET, '--out', REPORT],
    log: (line) => lines.push(String(line)),
  })
  assert.equal(clean, 0, `сверка лежащего файла падает: ${lines.join(' | ')}`)

  const copy = structuredClone(report)
  copy.scenarios[0].turns[0].prompt = 'подменённая реплика'
  // Копия пишется во временный каталог: файл в репозитории правиться не
  // должен даже на время прогона.
  const dir = mkdtempSync(join(tmpdir(), 'day25-check-'))
  const file = join(dir, 'eval.json')
  writeFileSync(file, `${JSON.stringify(copy, null, 2)}\n`)
  try {
    const out = []
    const code = await main({
      argv: ['--check', '--scenarios', SET, '--out', file],
      log: (line) => out.push(String(line)),
    })
    assert.equal(code, 1, 'разъехавшаяся копия реплики не валит сверку')
    assert.ok(
      out.some((line) => line.includes('текст реплики разошёлся')),
      `причина не названа вслух: ${out.join(' | ')}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('заметка файла называет, чего в проде на момент прогона не было', () => {
  // Прогон идёт по ПРОДУ, а прод не равен main. Пустая или общая заметка
  // означала бы «прод равен main», и проверить это по файлу было бы нечем.
  //
  // Предмет здесь — СВЯЗЬ заметки с константой `PROD_GAP`, которую правят
  // рукой перед прогоном, а не номер конкретного PR: номер устаревает в день
  // выкатки, и тест на него краснел бы от правды.
  assert.ok(PROD_GAP.trim() !== '', 'PROD_GAP пуст: «прод равен main» проверить нечем')
  assert.ok(
    report.note.includes(PROD_GAP),
    'заметка в файле не несёт разницу прода с main из PROD_GAP',
  )
  assert.match(report.note, /судейств/, 'заметка не говорит, что вердиктов в файле нет')
  assert.match(report.note, /кругов проверки/, 'заметка не называет предел кругов прогона')
  assert.ok(Number.isInteger(report.limits.reviewRounds), 'предел кругов в файле не назван числом')
})

test('пределы в файле — те же, что у дня: суточный потолок не вписан руками', () => {
  const { env } = parseEnv({})
  assert.equal(report.limits.dailyCap, env.MAX_DAILY_CALLS)
  assert.equal(
    report.limits.slotsNeeded,
    report.scenarios.reduce((n, s) => n + s.turns.length, 0) * report.limits.reviewRounds,
    'нужное число слотов в файле не сходится с числом ходов',
  )
})
