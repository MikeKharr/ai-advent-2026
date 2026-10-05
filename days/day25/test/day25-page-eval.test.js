// Секция итогов двух сценариев на экране входа дня 25: что она говорит и чего
// не говорит.
//
// Метод — тот же, что в `day25-page-rag.test.js`: правила показа вынесены в
// странице в выделяемый блок без DOM, тест ВЫРЕЗАЕТ ЭТОТ БЛОК ИЗ СТРАНИЦЫ и
// исполняет его. Проверяется исходный текст страницы, а не копия в тесте;
// живой браузер этим не заменяется.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { OUTCOMES } from '../eval/mechanics.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

const rules = (() => {
  const from = page.indexOf(
    '/* --- Выделяемый блок: его извлекает и исполняет test/day25-page-eval.test.js.',
  )
  assert.notEqual(from, -1, 'блок правил итогов обязан остаться выделяемым')
  const to = page.indexOf('/* --- конец выделяемого блока итогов --- */', from)
  assert.notEqual(to, -1, 'у блока правил итогов обязан быть конец')
  return new Function(`${page.slice(from, to)}
    return { EV_WORD, EV_ORDER, EV_UNKNOWN, EV_NONE, EV_UNREADABLE, EV_BROKEN, evJoin,
             evShortCommit };`)()
})()

test('исходы на экране — те же четыре, что в механике прогона, и ни одним больше', () => {
  // Два списка в двух файлах: разойдясь, они дали бы на экране исход без
  // слова — то есть пустое место там, где предмет дня (I-13 про одно имя).
  assert.deepEqual([...rules.EV_ORDER].sort(), [...OUTCOMES].sort())
  assert.deepEqual(Object.keys(rules.EV_WORD).sort(), [...OUTCOMES].sort())
  // Четыре РАЗНЫХ слова: «не знаю» от отбора и «не знаю» от модели — разные
  // вещи, и один текст на оба скрывал бы, кто именно не нашёл ответа.
  assert.equal(new Set(Object.values(rules.EV_WORD)).size, 4)
})

test('исход, которого страница не знает, не выдаётся за ответ по корпусу', () => {
  assert.equal(rules.EV_WORD.какой_то_новый, undefined)
  assert.ok(rules.EV_UNKNOWN.length > 0, 'о неизвестном исходе сказать нечем')
  assert.notEqual(rules.EV_UNKNOWN, rules.EV_WORD.answered)
})

test('три пустых состояния — три РАЗНЫЕ строки: нет файла, не прочитан, форма не та', () => {
  // Пустое место под заголовком читается как «всё в порядке» (I-8), а одна
  // строка на три случая врала бы в двух из трёх: «не прогоняли» и «сборка
  // отдала файл с ошибкой» — разные новости для посетителя.
  assert.equal(new Set([rules.EV_NONE, rules.EV_UNREADABLE, rules.EV_BROKEN]).size, 3)
  assert.match(rules.EV_NONE, /не прогоняли/)
  assert.match(rules.EV_UNREADABLE, /не прочитан/)
  assert.match(rules.EV_BROKEN, /форма не та/)
})

test('404 и прочие отказы ведут к РАЗНЫМ строкам, а не к одной', () => {
  // Предмет — развилка в коде, а не наличие двух строк: пока ветвь по 404 не
  // стояла, оба случая приходили в EV_NONE и «файл битый» читался как
  // «не прогоняли» (находка `reviewer` к PR #325).
  assert.match(
    page,
    /if \(r\.status === 404\) \{\s*\n\s*say\(\$\('ev-state'\), EV_NONE\);/,
    'ветвь по 404 обязана отдавать именно EV_NONE',
  )
  assert.match(page, /\} catch \(error\) \{\s*\n\s*say\(\$\('ev-state'\), EV_UNREADABLE\);/)
})

test('строка механики не печатает пустых мест на месте непришедшего', () => {
  assert.equal(rules.evJoin(['исход', null, '', 'источников 5']), 'исход · источников 5')
  assert.equal(rules.evJoin([null, '']), '')
})

test('секция итогов стоит на экране входа и читает файл рядом со страницей', () => {
  const gate = page.slice(page.indexOf('<section class="gate"'), page.indexOf('</section>\n\n<div class="layout"'))
  assert.ok(gate.includes('id="ev-h"'), 'секция итогов не на экране входа: в пульт попадают с профилем')
  assert.ok(page.includes("fetch('./eval.json'"), 'итоги читаются не из файла рядом со страницей')
})

test('коммит индекса на экране короткий, а полный уходит в title', () => {
  // ПРЕДМЕТ — УЗКАЯ ШИРИНА. Сорок знаков sha — одно слово без пробелов, и на
  // вьюпорте 320 оно уносило страницу в горизонтальную прокрутку: замер
  // `design-review` к PR #325, `scrollWidth` 444 при `clientWidth` 320.
  // Здесь проверяется правило, а не пиксели: живой замер тест не заменяет.
  const full = '7900d264083a7ad926c1adada1c4fa9700c8d6de'
  assert.equal(rules.evShortCommit(full), '7900d26')
  assert.equal(rules.evShortCommit(full).length, 7)
  // Нет коммита — нет и строки о нём: прочерк на этом месте читался бы как
  // «индекс неизвестен», а это разные вещи.
  assert.equal(rules.evShortCommit(''), null)
  assert.equal(rules.evShortCommit(undefined), null)
  // Полный sha обязан остаться достижимым — тем же способом, которым на этой
  // странице подписаны имя профиля и название темы.
  assert.match(page, /commit\.title = data\.index\.commit/, 'полный коммит никуда не уходит')
  assert.equal(
    page.includes('`индекс ${data.index.commit}`'),
    false,
    'полный коммит снова печатается строкой',
  )
})

test('вторичные строки итогов держат полосу чтения 52ch', () => {
  // Правило корпуса для вторичного текста. Без него строка механики тянулась
  // бы во всю ширину экрана входа.
  assert.match(page, /\.ev-sum \{[^}]*max-width:52ch;/)
  assert.match(page, /\.ev-mech \{[^}]*max-width:52ch;/)
})

test('ни одного innerHTML на странице', () => {
  // Правило дня 25 (`day25-page-rag.test.js`) распространяется и на новый
  // код: секция итогов собирается узлами, а не разметкой из файла.
  assert.equal(page.includes('innerHTML'), false)
})
