// Прогон функции `compress()`, которую написала модель, против восьми наборов.
// Запуск: node rle_test.js <путь-к-файлу-с-функцией>
//
// Перенос из `…-measurements/scripts/rle_test.js` (прогон 2026-10-09, задача
// `t5_code_js` дня 26). Исполняется только руками владельца на ноутбуке:
// `rag/eval/checks.py` зовёт этот файл из `by_running_js`, а тесты единицы
// `rag` подставляют подложный `run` и до node не доходят.
//
// Наборы: три примера из задания и пять краевых — один символ, ровно два,
// двузначный счётчик, повтор символа после перерыва, пробелы как символы.
// Краевые нужны потому, что три примера задания проходит и неверная
// реализация: без них 8/8 значило бы «совпало с примерами».
//
// CommonJS, а не модуль: шаг «Синтаксис» в `ci.yml` проверяет каждый `.js`
// единицы командой `node --check`, а она читает `.js` как CommonJS, и
// `import` в нём был бы синтаксической ошибкой.
const { readFileSync } = require('node:fs')

const source = readFileSync(process.argv[2], 'utf8')
let compress
try {
  // eslint-disable-next-line no-new-func
  compress = new Function(`${source}; return compress;`)()
} catch (error) {
  console.log(JSON.stringify({ passed: 0, total: 8, cases: [], loadError: String(error) }))
  process.exit(0)
}

const cases = [
  ['aaabccddd', 'a3bc2d3', 'пример из задания'],
  ['abc', 'abc', 'пример из задания'],
  ['', '', 'пример из задания: пустая строка'],
  ['a', 'a', 'один символ'],
  ['aa', 'a2', 'ровно два'],
  ['aaaaaaaaaaa', 'a11', 'счётчик из двух цифр'],
  ['aabbaa', 'a2b2a2', 'повтор символа после перерыва'],
  ['  a', ' 2a', 'пробелы как символы'],
]

let passed = 0
const out = []
for (const [input, expected, note] of cases) {
  let got = null
  let error = null
  try {
    got = compress(input)
  } catch (caught) {
    error = String(caught)
  }
  const ok = error === null && got === expected
  if (ok) passed += 1
  out.push({ input, expected, got, error, ok, note })
}
console.log(JSON.stringify({ passed, total: cases.length, cases: out }, null, 2))
