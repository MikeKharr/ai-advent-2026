// Страница итогов дня 21 грузит два обычных скрипта в одну глобальную область:
// сначала site/day21/verdict.js, затем site/day21/app.js. Этот тест повторяет
// именно это — vm.Script в общем контексте, нестрогий режим, Annex B действует,
// — а не импорт модуля, как тест вердикта.
//
// Ради чего: голый блок `{ function plural(){} }` в verdict.js выпускал
// функции в глобальную область, и `const { plural } = …` в app.js падал с
// SyntaxError — страница вечно «читала результаты» (находка design-review к
// #295). test/day21-verdict.test.js этого не видел: в Node импорт — модуль, и
// Annex B там не действует, а app.js не участвовал вовсе.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

function loadPage() {
  // Минимум окружения: app.js на верхнем уровне только объявляет и зовёт fetch.
  // fetch не завершается — рендер здесь не проверяется, проверяется загрузка.
  const ctx = vm.createContext({ fetch: () => new Promise(() => {}), console })
  new vm.Script(read('../site/day21/verdict.js'), { filename: 'verdict.js' }).runInContext(ctx)
  new vm.Script(read('../site/day21/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return ctx
}

test('verdict.js и app.js грузятся вместе без ошибки', () => {
  assert.doesNotThrow(loadPage)
})

test('verdict.js не выпускает в глобальную область ничего, кроме DAY21_VERDICT', () => {
  const ctx = vm.createContext({})
  new vm.Script(read('../site/day21/verdict.js')).runInContext(ctx)
  const leaked = Object.keys(ctx).filter((k) => k !== 'DAY21_VERDICT')
  assert.deepEqual(leaked, [], 'функции утекли в глобальную область: ' + leaked.join(', '))
})

test('index.html грузит verdict.js раньше app.js', () => {
  const html = read('../site/day21/index.html')
  const v = html.indexOf('src="verdict.js"'), a = html.indexOf('src="app.js"')
  assert.ok(v !== -1 && a !== -1 && v < a, 'порядок скриптов нарушен')
})
