// Правила показа итогов прогона дня 23 — исполнением, а не чтением исходника.
// Файл итогов собирает прогон (PR 3); здесь проверяется, что страница делает
// с тем, что в нём лежит, и, главное, чего она НЕ делает с честным исходом
// «отбор ничего не оставил» (долг дня 22, развилка Р8 ADR 2026-10-05-0544).

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  delta,
  EMPTY_PICK,
  EVAL_MODES,
  formatMetric,
  hasRun,
  limitsText,
  METRICS,
  NOTABLE,
  parseEval,
  verdict,
} from '../public/evalview.js'

const side = (recall5, mrr10) => ({ recall5, mrr10 })
const mode = (b, a, extra = {}) => ({ before: side(...b), after: side(...a), ran: 30, ...extra })

const report = (over = {}) => ({
  at: '2026-10-05T12:00:00.000Z',
  index: { commit: '57a5cd7abc', strategy: 'structural', chunks: 1200 },
  questionsTotal: 30,
  modes: {
    rerank: mode([0.48, 0.31], [0.52, 0.35], { emptyPicks: 3 }),
    rewrite: mode([0.49, 0.32], [0.5, 0.33], { emptyPicks: 2 }),
  },
  questions: [
    {
      id: 'q01',
      question: 'где держится инвариант I-4',
      expect: ['agent_docs/invariants.md'],
      rerank: { before: side(1, 0.5), after: side(1, 1), candidates: 10, kept: 3, empty: false },
      rewrite: { before: side(1, 0.5), after: side(0, 0), candidates: 10, kept: 0, empty: true },
    },
  ],
  note: 'прогон 2026-10-05, индекс 57a5cd7',
  ...over,
})

test('числа берутся из файла, а чего в нём нет — остаётся null, а не нулём (I-8)', () => {
  const parsed = parseEval(report())
  assert.equal(parsed.total, 30)
  assert.equal(parsed.modes.rerank.after.mrr10, 0.35)
  assert.equal(parsed.index.commit, '57a5cd7abc')

  const bare = parseEval({})
  assert.equal(bare.total, null)
  assert.equal(bare.index, null)
  assert.deepEqual(bare.questions, [])
  for (const [key] of EVAL_MODES) assert.equal(bare.modes[key], null, `${key} выдуман из пустого файла`)
})

test('мусор вместо файла не валит разбор и не превращается в числа', () => {
  for (const raw of [null, 'строка', 42, [], { modes: 'нет' }]) {
    const parsed = parseEval(raw)
    assert.equal(hasRun(parsed), false, `из ${JSON.stringify(raw)} вышел прогон`)
  }
})

test('пустой отбор приходит ПОЛЕМ и не выводится из нуля оставленных', () => {
  const parsed = parseEval(report())
  const q = parsed.questions[0]
  assert.equal(q.rewrite.empty, true)
  assert.equal(q.rerank.empty, false)
  // `kept: 0` без поля `empty` — НЕ «не знаю»: числа могло не прийти вовсе, и
  // страница не вправе достроить за прогон его вывод.
  const silent = parseEval(
    report({
      questions: [{ id: 'q02', question: 'в', expect: [], rerank: { kept: 0 }, rewrite: null }],
    }),
  )
  assert.equal(silent.questions[0].rerank.empty, false)
  assert.equal(silent.questions[0].rerank.candidates, null)
  assert.equal(silent.questions[0].rewrite, null, 'режима не было — это не «пустой отбор»')
})

test('честный исход назван своими словами, и слова эти не про промах', () => {
  assert.match(EMPTY_PICK, /не знаю/)
  assert.ok(!/выдум|врёт|ошиб|провал/i.test(EMPTY_PICK), EMPTY_PICK)
})

test('доля печатается тремя знаками, а не измеренного не печатается вовсе', () => {
  assert.equal(formatMetric(0.5), '0,500')
  assert.equal(formatMetric(0.3456), '0,346')
  assert.equal(formatMetric(null), '', 'на месте неизмеренного появился ноль (I-8)')
})

test('разность показывается со знаком, и ноль печатается нулём', () => {
  assert.equal(delta(0.31, 0.35), '+0,040')
  assert.equal(delta(0.35, 0.31), '−0,040')
  assert.equal(delta(0.3, 0.3), '±0,000', '«разницы нет» — результат, а не пустая клетка')
  assert.equal(delta(null, 0.3), '')
  assert.equal(delta(0.3, null), '')
})

test('фраза вывода собирается из чисел: рост, падение и «разницы нет»', () => {
  const up = verdict(parseEval(report()))
  assert.match(up.lead, /Отбор поднял MRR@10 на 0,040/)

  const flat = verdict(
    parseEval(
      report({
        modes: {
          rerank: mode([0.31, 0.31], [0.32, 0.315]),
          rewrite: mode([0.31, 0.31], [0.32, 0.32]),
        },
      }),
    ),
  )
  assert.match(flat.lead, /Разницы нет/)
  assert.match(flat.text, /результат дня/, 'отсутствие разницы названо недоделкой')

  const down = verdict(
    parseEval(report({ modes: { rerank: mode([0.4, 0.4], [0.3, 0.3]), rewrite: null } })),
  )
  assert.match(down.lead, /Отбор опустил MRR@10 на 0,100/)

  assert.equal(verdict(parseEval({})), null, 'вывод сделан без единого числа')
})

test('порог заметности — одно число на весь день, и это число ADR', () => {
  assert.equal(NOTABLE, 0.02)
  // Ровно на пороге — уже «поднял»: правило ADR говорит «не меньше чем на 0,02».
  const edge = verdict(parseEval(report({ modes: { rerank: mode([0.3, 0.3], [0.32, 0.32]), rewrite: null } })))
  assert.match(edge.lead, /поднял/)
})

test('границы метода называют объём прогона и коммит индекса', () => {
  const text = limitsText(parseEval(report()))
  assert.match(text, /судьи нет/)
  assert.match(text, /Вопросов в прогоне 30/)
  assert.match(text, /57a5cd7/)
  // Чего в файле нет — о том строка молчит, а не выдумывает.
  const bare = limitsText(parseEval({}))
  assert.ok(!/Вопросов в прогоне/.test(bare))
  assert.ok(!/Индекс/.test(bare))
})

test('метрик ровно две и режимов меры ровно два: `rag` в прогон не идёт', () => {
  assert.deepEqual(
    METRICS.map(([k]) => k),
    ['recall5', 'mrr10'],
  )
  assert.deepEqual(
    EVAL_MODES.map(([k]) => k),
    ['rerank', 'rewrite'],
    'в прогон попал режим `rag` — он и есть «до» внутри каждого запуска',
  )
})
