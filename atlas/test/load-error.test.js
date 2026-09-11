import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { GRAPH_BLOCKS, GRAPH_BUTTONS, outcomeNote, retryPhase } from '../web/app.js'

// Сбой загрузки схемы — agent_docs/design/2026-09-14-1730-atlas-load-error.md.
// Чистая часть: что говорит `#live` на каждый исход попытки, как выглядит
// повтор и что недоступно или скрыто, пока графа нет. Геометрия, фокус и
// обход `Tab` — только в браузере.

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const tagOf = (id) => HTML.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0]

// ── Объявления ─────────────────────────────────────────────────────────

test('первый отказ: заголовок блока и причина через точку', () => {
  const note = outcomeNote({ head: 'Схему не удалось загрузить', reason: 'На graph.json пришёл ответ 404.', attempt: 1 })
  assert.equal(note, 'Схему не удалось загрузить. На graph.json пришёл ответ 404.')
})

test('отказ повтора несёт номер попытки: одинаковый отказ всё равно звучит', () => {
  const reason = 'Файл graph.json не получен: сети нет или адрес не отвечает.'
  const second = outcomeNote({ head: 'Схему не удалось загрузить', reason, attempt: 2 })
  const third = outcomeNote({ head: 'Схему не удалось загрузить', reason, attempt: 3 })
  assert.equal(second, `Попытка 2: схему не удалось загрузить. ${reason}`)
  assert.equal(third, `Попытка 3: схему не удалось загрузить. ${reason}`)
})

test('успех после повтора называет загрузку и вид', () => {
  assert.equal(outcomeNote({ attempt: 2, line: 'Цикл дня: 10 фаз' }), 'Схема загружена. Вид: Цикл дня: 10 фаз')
})

test('успех с первой попытки — как раньше: только вид', () => {
  assert.equal(outcomeNote({ attempt: 1, line: 'Цикл дня: 10 фаз' }), 'Вид: Цикл дня: 10 фаз')
})

test('отказ перерисовки: свой заголовок и сообщение исключения', () => {
  const note = outcomeNote({ head: 'Схему не удалось показать', reason: 'boom', attempt: 1 })
  assert.equal(note, 'Схему не удалось показать. boom')
})

// ── Повтор ─────────────────────────────────────────────────────────────

test('до первого нажатия «Попробовать снова» строки попытки нет, кнопка обычная', () => {
  assert.deepEqual(retryPhase('error', 1), { busy: false, line: null })
})

test('пока идёт попытка, кнопка aria-disabled, под действиями — чтение схемы', () => {
  assert.deepEqual(retryPhase('loading', 2), { busy: true, line: 'Читаю схему проекта…' })
})

test('неудачная попытка: кнопка снова обычная, число попыток вместе с первой', () => {
  assert.deepEqual(retryPhase('error', 2), { busy: false, line: 'Попыток: 2' })
  assert.deepEqual(retryPhase('error', 3), { busy: false, line: 'Попыток: 3' })
})

// ── Пока графа нет ─────────────────────────────────────────────────────

test('без графа недоступны «Карта», «−», «+» и «Сбросить вид»', () => {
  assert.deepEqual([...GRAPH_BUTTONS].sort(), ['map-open', 'view-reset', 'zoom-in', 'zoom-out'])
})

test('без графа скрыты «Фильтры и вид» и «Узлы в этом виде»', () => {
  assert.deepEqual([...GRAPH_BLOCKS].sort(), ['nodelist', 'tools'])
})

test('кнопки по графу недоступны уже в разметке: до запуска скрипта они не нажимаются', () => {
  for (const id of GRAPH_BUTTONS) assert.match(tagOf(id) ?? '', /\sdisabled[\s>]/, id)
})

test('блоки по графу скрыты уже в разметке: загрузка ничего не мигает', () => {
  for (const id of GRAPH_BLOCKS) assert.match(tagOf(id) ?? '', /\shidden[\s>]/, id)
})

test('живая область одна — #live; у строки на канве роли нет', () => {
  assert.doesNotMatch(tagOf('canvas-msg'), /role=|aria-live/)
  const live = HTML.match(/<[a-z]+[^>]*(role="(status|alert)"|aria-live=)[^>]*>/g)
  assert.deepEqual(live.map((t) => t.match(/id="([^"]+)"/)[1]), ['live'])
})
