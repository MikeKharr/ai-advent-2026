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
  RECALL_BASE,
  RECALL_EXPECTED,
  recallText,
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

test('падение Recall@5 названо числами, а не оставлено одной таблице', () => {
  // ЗАЧЕМ ЭТО ЗДЕСЬ. Режим выбирается по MRR@10 — так велит ADR (п. 2.4), — и
  // фраза вывода говорит «поднял». Recall@5 при этом может упасть: отбор
  // выбрасывает из пятёрки верные документы, которые до него в ней стояли.
  // Тогда «лучший режим» назван на фоне падения второй метрики, и молчать об
  // этом фраза не вправе — ожидание дня было ровно обратным (ADR, п. 1.2).
  const both = verdict(
    parseEval(
      report({
        modes: { rerank: mode([0.6, 0.3], [0.5, 0.36]), rewrite: mode([0.7, 0.3], [0.6, 0.31]) },
      }),
    ),
  )
  assert.match(both.lead, /поднял MRR@10/)
  assert.match(both.text, /«с отбором» 0,600 → 0,500/)
  assert.match(both.text, /«с переписыванием» 0,700 → 0,600/)
  // НЕ ПОДТВЕРДИЛОСЬ НАПРАВЛЕНИЕ, А НЕ УРОВЕНЬ: ожидание было «отбор поднимает
  // Recall@5 с ≈0,48 до ≈0,58», и названы обязаны быть ОБА числа — без базы
  // 0,580 читается как уровень, которого надо достичь (находка design-review
  // к PR #327).
  assert.match(both.text, /о направлении/)
  assert.match(both.text, /0,480/, 'база ожидания не названа числом')
  assert.match(both.text, /0,580/, 'ожидание дня не названо числом')
  assert.match(both.text, /В названных режимах направления мера не подтвердила/)

  // Уровень не взят ни одним режимом — про уровень строка молчит вовсе, а не
  // объявляет его недостигнутым: предмет ожидания был не в нём.
  const low = recallText(
    parseEval(report({ modes: { rerank: mode([0.5, 0.3], [0.4, 0.36]), rewrite: null } })),
  )
  assert.match(low, /В названных режимах направления мера не подтвердила/)
  assert.ok(!low.includes('уровня'), low)

  // СМЕШАННЫЙ СЛУЧАЙ, и он не умозрительный: в одном режиме отбор метрику
  // опустил, в другом поднял, и у поднявшего «после» тоже выше 0,580.
  // Предложение про уровень говорит «взят не отбором: до отбора там стояло
  // больше» — и это верно ТОЛЬКО про упавший режим, поэтому поднявший в него
  // попасть не может (находка `reviewer` к PR #327: уровень считался по всем
  // прогнанным режимам, и фраза врала про поднявший).
  const mixed = recallText(
    parseEval(
      report({
        modes: { rerank: mode([0.7, 0.3], [0.63, 0.36]), rewrite: mode([0.55, 0.3], [0.6, 0.31]) },
      }),
    ),
  )
  assert.match(mixed, /опустил: «с отбором» 0,700 → 0,630\./)
  assert.ok(
    !mixed.includes('опустил: «с отбором» 0,700 → 0,630, «с переписыванием»'),
    `поднявший режим назван упавшим: ${mixed}`,
  )
  assert.match(mixed, /Поднял он её в режиме «с переписыванием» 0,550 → 0,600/)
  const level = mixed.slice(mixed.indexOf('Самого уровня'))
  assert.match(level, /«с отбором» 0,630/, 'уровень взят упавшим режимом, а он не назван')
  assert.ok(
    !level.includes('переписыванием'),
    `поднявший режим попал в предложение «взят не отбором»: ${level}`,
  )
  assert.ok(RECALL_BASE < RECALL_EXPECTED, 'ожидание дня перестало быть ростом')

  // Не опустил — строки нет вовсе: выдумывать падение страница не вправе.
  assert.equal(recallText(parseEval(report())), '')
  // Непрогнанный режим в строку не попадает: у него нет чисел, а не есть ноль.
  const one = recallText(
    parseEval(report({ modes: { rerank: mode([0.6, 0.3], [0.5, 0.36]), rewrite: null } })),
  )
  assert.match(one, /«с отбором» 0,600 → 0,500/)
  assert.ok(!one.includes('переписыванием'), one)
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
