// Вердикт страницы итогов дня 21 — site/day21/verdict.js, тот же файл, которым
// страница строит фразу «Итога». Тест лежит вне site/: каталог отдаётся Caddy
// целиком как корень сайта (так же устроен test/progress-data.test.js).
//
// Правило, которое здесь держится: страница не утверждает больше, чем считает.
// Оно ломалось дважды, и оба раза ловилось ревью, а не CI: сначала «Лучше X»
// при недоказанном перевесе (design-review), затем «Перевес доказан» за
// сторону, проигравшую по вопросам 10 : 30 (reviewer).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import '../site/day21/verdict.js'

const { deltas, headToHead, signTestP, verdictText, noneText } = globalThis.DAY21_VERDICT

const say = (data) => verdictText(data, deltas(data)) + noneText(data)

/** Данные с заданными средними и счётом по вопросам: s — побед structural, f — fixed, t — ничьих. */
function synth({ recall = [0.4, 0.5], mrr = [0.3, 0.4], phrase = [0.2, 0.3], s = 0, f = 0, t = 0, none = 0 }) {
  const side = (i, label) => ({
    label, queries: 100, phrase_queries: 78,
    'recall@5': recall[i], 'mrr@10': mrr[i], phrase_in_first_chunk: phrase[i],
  })
  const q = []
  const row = (fr, sr) => q.push({ id: 'q' + q.length, fixed: { rank: fr }, structural: { rank: sr } })
  for (let i = 0; i < s; i += 1) row(2, 1)
  for (let i = 0; i < f; i += 1) row(1, 2)
  for (let i = 0; i < t; i += 1) row(1, 1)
  for (let i = 0; i < none; i += 1) row(null, null)
  return { fixed: side(0, 'По размеру'), structural: side(1, 'По структуре'), queries: q }
}

test('настоящие данные: направление, не превосходство, и p знакового теста', () => {
  const data = JSON.parse(readFileSync(new URL('../site/day21/results.json', import.meta.url), 'utf8'))
  const h = headToHead(data)
  assert.deepEqual([h.structural, h.fixed, h.tie, h.none, h.n], [28, 20, 52, 32, 100])
  const text = say(data)
  assert.match(text, /^Направление за «по структуре»/)
  assert.match(text, /Перевес не доказан/)
  assert.match(text, /вероятностью 0\.31/)
  assert.doesNotMatch(text, /Лучше/)
})

test('средние за одну сторону, счёт по вопросам — за другую: «доказан» не печатается', () => {
  // Находка reviewer к #295: знаковый тест двусторонний, и без сверки
  // направлений страница объявляла «Перевес доказан» за проигравшую сторону.
  const text = say(synth({ s: 10, f: 30 }))
  assert.doesNotMatch(text, /Перевес доказан/)
  assert.match(text, /разные стороны/)
  assert.match(text, /впереди «по размеру»: 30 из 40/)
})

test('ровный счёт по вопросам при средних в одну сторону — тоже не доказан', () => {
  const text = say(synth({ s: 15, f: 15, t: 70 }))
  assert.doesNotMatch(text, /Перевес доказан/)
  assert.match(text, /счёт ровный: 15 : 15/)
  assert.doesNotMatch(text, /разные стороны/)
})

test('доказанный перевес достижим и называется доказанным', () => {
  const text = say(synth({ s: 32, f: 16, t: 52 }))
  assert.match(text, /Перевес доказан: по отдельным вопросам «по структуре» впереди в 32 из 48/)
  assert.match(text, /p = 0\.03/)
})

test('все вопросы — ничьи: нет «0 из 0» и нет «вероятностью 1.00»', () => {
  const text = say(synth({ t: 100 }))
  assert.match(text, /не разошлись ни разу/)
  assert.doesNotMatch(text, /0 из 0|1\.00/)
})

test('без разбора по вопросам — так и сказано, вердикт по средним остаётся направлением', () => {
  const data = synth({}); delete data.queries
  const text = say(data)
  assert.match(text, /не разбирался/)
  assert.doesNotMatch(text, /доказан:/)
})

test('разница в пределах шума — стратегии неразличимы', () => {
  const text = say(synth({ recall: [0.45, 0.46], mrr: [0.35, 0.355], phrase: [0.2, 0.21] }))
  assert.match(text, /^Стратегии неразличимы/)
})

test('число вопросов, не найденных ни одной стратегией, попадает в итог', () => {
  assert.match(say(synth({ s: 20, f: 10, none: 3 })), /У 3 вопросов из 33 ни одна стратегия/)
})

test('знаковый тест точен: сверка с точным перебором на BigInt', () => {
  const exact = (a, b) => {
    const n = BigInt(a + b), k = BigInt(Math.max(a, b))
    let c = 1n, tail = 0n
    for (let i = 0n; i <= n; i += 1n) { if (i >= k) tail += c; c = c * (n - i) / (i + 1n) }
    return Math.min(1, Number(2n * tail * 1000000000n / (1n << n)) / 1e9)
  }
  for (let n = 1; n <= 40; n += 1) {
    for (let a = 0; a <= n; a += 1) {
      assert.ok(Math.abs(signTestP(a, n - a) - exact(a, n - a)) < 1e-8, `${a}:${n - a}`)
    }
  }
})
