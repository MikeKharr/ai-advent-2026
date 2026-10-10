// Вердикт страницы дня 29 — site/day29/verdict.js, тот же файл, которым
// страница строит фразу «Итога». Тест лежит вне site/: каталог отдаётся Caddy
// целиком как корень сайта (так же устроены test/day21-verdict.test.js и
// test/day28-verdict.test.js).
//
// Правило, которое здесь держится: страница не утверждает больше, чем
// считает. «После» выбирается правилом, а не вкусом; ось с испорченными
// счётчиками скорости показывает «нет данных», а не своё среднее; сборка без
// отказов не входит в «после» ни при каких числах (спецификация дней 26–30,
// тело дня 29).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import '../site/day29/verdict.js'

const { NO_DATA, SPEED_SUSPECT, isSuspect, noise, diffWord, axisRows, suspectLine,
  changedLine, gainRows, afterRule, verdictText, quantRows, quantNames, stability,
  limitIdsLine } = globalThis.DAY29_VERDICT

const DATA = () => JSON.parse(readFileSync(new URL('../site/day29/results.json', import.meta.url), 'utf8'))

/** Синтетика: база и оси заданы числами, остального конверта счёт не трогает. */
function synth({ base = {}, after = {}, axes = [], quant = null } = {}) {
  return {
    day: 29,
    base: { score_avg: 1.8, answers: 10, time_s_mean: 90, retrieved: 6, cited: 8, refused: 4, ...base },
    after: { score_avg: 1.8, answers: 10, time_s_mean: 90, retrieved: 6, cited: 8, refused: 4, ...after },
    axes: axes,
    quant: quant,
  }
}

test('настоящие данные: вывод называет шум по оценке и число вопросов', () => {
  const text = verdictText(DATA())
  assert.match(text, /^Оптимизация не изменила оценку: разница в пределах шума\./)
  assert.match(text, /Считано по 10 вопросам: 1,80 против 1,70/)
  assert.match(text, /порог шума — два вопроса из 10 \(0,20\)/)
  assert.match(text, /порога шума у времени нет/)
})

test('ни одна ось не вошла в «после» — и страница говорит, что это два прогона одной конфигурации', () => {
  const data = DATA()
  const rule = afterRule(data)
  assert.deepEqual(rule.kept, [])
  assert.match(rule.text, /^В «после» не вошла ни одна ось: «после» — повторный прогон базовой конфигурации/)
  assert.equal(rule.rejected.length, data.axes.length, 'причина названа не у каждой оси')
  assert.match(verdictText(data), /это два прогона одной и той же конфигурации/)
  // Ради чего: без этой фразы разница 1,80 → 1,70 читалась бы как результат
  // оптимизации, а не как цена повтора.
  assert.match(verdictText(data), /цена повтора, а не выигрыш оптимизации/)
})

test('правило отбора работает, когда числа позволяют: оценка не ниже и ответ быстрее', () => {
  const data = synth({
    base: { score_avg: 1.5, tps: 6 },
    axes: [
      { name: 'temperature 1 → 0,5', score_avg: 1.6, tps: 8, changed: 1 },
      { name: 'num_predict 800 → 400', score_avg: 1.2, tps: 9, changed: 1 },
      { name: 'num_ctx 16384 → 8192', score_avg: 1.7, tps: 5, changed: 1 },
      { name: 'квантование Q4_K_M → Q6_K (сборка без отказов)', score_avg: 2, tps: 99, changed: 1 },
    ],
  })
  const rule = afterRule(data)
  assert.deepEqual(rule.kept.map((k) => k.name), ['temperature 1 → 0,5'])
  const why = new Map(rule.rejected.map((r) => [r.name, r.why]))
  assert.match(why.get('num_predict 800 → 400'), /оценка ниже базовой/)
  assert.match(why.get('num_ctx 16384 → 8192'), /быстрее базы не стало/)
  assert.match(why.get('квантование Q4_K_M → Q6_K (сборка без отказов)'),
    /не входит в «после» ни при каких числах/)
  assert.match(rule.text, /^В «после» вошли 1 ось: «temperature 1 → 0,5»\./)
})

test('сборка без отказов не входит в «после» даже при лучших числах во всём', () => {
  const rule = afterRule(synth({
    base: { score_avg: 1, tps: 1 },
    axes: [{ name: 'квантование Q4_K_M → Q6_K (сборка без отказов)', score_avg: 2, tps: 100, changed: 1 }],
  }))
  assert.deepEqual(rule.kept, [])
})

test('ось с испорченными счётчиками показывает «нет данных», а не своё среднее', () => {
  const data = DATA()
  const names = data.axes.map((a) => a.name)
  const suspectNames = Object.keys(SPEED_SUSPECT)
  // Ради чего: оговорка привязана к названию оси. Переименуют ось в прогоне —
  // красным станет этот тест, а не страница, показавшая испорченное число.
  for (const n of suspectNames) {
    assert.ok(names.includes(n), 'в results.json нет оси «' + n + '», к которой привязана оговорка')
  }
  const rows = axisRows(data)
  const bad = rows.filter((r) => r.suspect)
  assert.equal(bad.length, suspectNames.length)
  for (const r of bad) assert.equal(r.tps, NO_DATA, 'испорченный счётчик попал на экран')
  for (const r of rows.filter((r) => !r.suspect)) {
    assert.notEqual(r.tps, NO_DATA, 'у годной оси ток/с пропал')
  }
  assert.match(suspectLine(data), /счётчики скорости у этой оси испорчены/)
  assert.match(suspectLine(data), /на остальные оси это не переносится/)
  assert.ok(isSuspect(suspectNames[0]) && !isSuspect('think false → true'))
})

test('порог шума — два вопроса из набора, а не константа', () => {
  assert.equal(noise(10), 2 / 10)
  assert.equal(noise(6), 2 / 6)
  assert.equal(noise(0), null)
})

test('слово к знаку: равенство названо равенством, шум — шумом', () => {
  assert.equal(diffWord(0, 0.2, 'выше после', 'ниже после'), 'столько же')
  assert.equal(diffWord(-0.1, 0.2, 'выше после', 'ниже после'), 'в пределах шума')
  assert.equal(diffWord(-0.5, 0.2, 'выше после', 'ниже после'), 'ниже после')
  assert.equal(diffWord(null, 0.2, 'a', 'b'), NO_DATA)
})

test('оценка ниже порога шума: сторона названа, и названа та, что ниже', () => {
  const text = verdictText(synth({ base: { score_avg: 1.8 }, after: { score_avg: 1.2 } }))
  assert.match(text, /^После оптимизации оценка ниже на 0,60\./)
  assert.doesNotMatch(text, /в пределах шума/)
})

test('метрики расходятся: оценка выше, а время дольше', () => {
  const text = verdictText(synth({
    base: { score_avg: 1.2, time_s_mean: 60 },
    after: { score_avg: 1.8, time_s_mean: 120 },
  }))
  assert.match(text, /^Метрики расходятся: оценка выше после, а время — дольше/)
  assert.match(text, /одного ответа числа не дают/)
})

test('одна сторона из двух: вывод не считается вовсе', () => {
  const data = synth({})
  delete data.after
  const text = verdictText(data)
  assert.match(text, /Сравнивать нечего: измерена одна сторона из двух — «до»/)
  assert.match(text, /Вывод будет после полного прогона/)
})

test('непомеренное — «нет данных», а не нуль: скорость и память по конфигурациям', () => {
  const rows = gainRows(DATA())
  for (const name of ['Ток/с', 'До 1-го токена, с', 'Память, МиБ']) {
    const r = rows.find((x) => x.name === name)
    assert.ok(r, 'строки «' + name + '» в таблице нет, и отсутствие стало незаметным')
    assert.equal(r.a, null)
    assert.equal(r.b, null)
    assert.equal(r.word, NO_DATA)
  }
  const quant = quantRows(DATA())
  const correct = quant.find((r) => /^Верных из/.test(r.name))
  assert.equal(correct.b, null, 'у сборки без отказов появилась верность, которой в данных нет')
  assert.equal(correct.word, NO_DATA)
  const mem = quant.find((r) => r.name === 'Память, МиБ')
  assert.equal(mem.word, NO_DATA)
})

test('фраза о числе изменённых осей вычисляется, а не пишется руками', () => {
  assert.match(changedLine(DATA()), /^В каждом прогоне менялась одна ось/)
  const two = changedLine(synth({ axes: [{ name: 'сжатие и рассуждение', changed: 2 }] }))
  assert.match(two, /менялось 2 оси разом: какой из них принадлежит выигрыш, этот замер не говорит/)
})

test('имя сборки без отказов берётся из данных и названо словом', () => {
  const [a, b] = quantNames(DATA())
  assert.equal(a.label, 'Q4_K_M')
  assert.equal(b.label, 'Q6_K')
  assert.ok(b.model.length > 0 && b.model !== NO_DATA)
  assert.equal(b.note, 'сборка без отказов')
})

test('секция стабильности не исчезает: отсутствие повторов сказано словами', () => {
  assert.match(stability(DATA()), /^Повторов в этом прогоне нет/)
  assert.match(limitIdsLine(DATA()), /^Разброс в этом прогоне не измерен/)
  const withIds = { stability_ids: ['q08', 'q72', 'm01'] }
  assert.match(limitIdsLine(withIds), /Разброс измерен только на 3 вопросах: q08, q72, m01\./)
})
