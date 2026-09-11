import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusesPanel, selectNote } from '../web/app.js'

// Фокус после шага — agent_docs/design/2026-09-14-1500-atlas-focus-after-step.md,
// таблица «Куда встаёт фокус» и раздел «Объявления». Чистая часть: куда
// встаёт фокус по источнику шага и что говорит `#live`. Остальное — только в
// браузере.

// ── Цель фокуса ────────────────────────────────────────────────────────

test('шаг ссылкой ставит фокус на заголовок панели, даже если ссылка пережила шаг', () => {
  // Результат поиска при шаге не перерисовывается — правило то же.
  assert.equal(focusesPanel('link', false), true)
  assert.equal(focusesPanel('link', true), true)
})

test('щелчок по канве фокус не переносит', () => {
  assert.equal(focusesPanel('canvas', false), false)
  assert.equal(focusesPanel('canvas', true), false)
})

test('касание карты фокус не переносит: его возвращает на «Карту» закрытие диалога', () => {
  assert.equal(focusesPanel('map', false), false)
})

test('стрелка фазы оставляет фокус на элементе, пережившем перерисовку', () => {
  assert.equal(focusesPanel('arrow', false), false)
})

test('стрелка фазы ставит фокус на заголовок, если перерисовка удалила элемент с фокусом', () => {
  assert.equal(focusesPanel('arrow', true), true)
})

// ── Текст объявления ───────────────────────────────────────────────────

const LINE = 'Соседи узла 9. Выкатка, 1 шаг: 2 узла, 1 связь'

test('при фокусе на заголовке объявление — тип и вид, без имени и без «Выбран»', () => {
  const said = selectNote({ title: 'Выкатка', type: 'Фаза цикла', line: LINE, focused: true })
  assert.equal(said, `Фаза цикла. Вид: ${LINE}`)
  assert.doesNotMatch(said, /Выбран/)
})

test('без переноса фокуса — прежнее «Выбран узел: …»', () => {
  const said = selectNote({ title: 'Выкатка', type: 'Фаза цикла', line: LINE, focused: false })
  assert.equal(said, `Выбран узел: Выкатка, фаза цикла. Вид: ${LINE}`)
})

test('строчной становится только первая буква типа: «решение — ADR», не «решение — adr»', () => {
  const said = selectNote({ title: 'Роли и гейты', type: 'Решение — ADR', line: LINE, focused: false })
  assert.equal(said, `Выбран узел: Роли и гейты, решение — ADR. Вид: ${LINE}`)
})

test('возврат по звену говорит «Вернулись к узлу» с тем же типом', () => {
  const said = selectNote({ title: 'Роли и гейты', type: 'Решение — ADR', line: LINE, returned: true })
  assert.equal(said, `Вернулись к узлу: Роли и гейты, решение — ADR. Вид: ${LINE}`)
})

test('суффикс объёма приходит вместе с полосой вида и не теряется', () => {
  const said = selectNote({ title: 'compliance', type: 'Роль', line: `${LINE} · объём`, focused: true })
  assert.equal(said, `Роль. Вид: ${LINE} · объём`)
})
