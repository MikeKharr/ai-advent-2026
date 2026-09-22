// Три косметические правки экрана (решение владельца 2026-09-22) проверяются
// по исходному тексту страницы, а не по описанию правила в тесте.
//
// Проверка структурная и названа прямо: она ловит возврат прежнего поведения
// (постоянная подпись, `aria-pressed`, этап без цвета, значок currentColor), но
// не заменяет живого замера в браузере — высота полосы и контраст меряются там.
//
// Путь к файлу задан от каталога теста: тесты дня запускаются `node --test` из
// `days/day14`, и относительный путь от cwd сломался бы при запуске из корня.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

test('подпись кнопки паузы переключается «Пауза» ↔ «Продолжить»', () => {
  assert.match(
    page,
    /pauseBtn\.textContent = resume \? 'Продолжить' : 'Пауза'/,
    'подпись обязана называть действие: при снятой паузе — «Пауза», при стоящей — «Продолжить»',
  )
})

test('на кнопке паузы нет aria-pressed ни в разметке, ни в коде', () => {
  // «Продолжить, нажато» — противоречие для программы чтения с экрана: подпись
  // уже сообщает состояние. Отменяет п. 9 ADR 2026-09-21-1747.
  assert.equal(
    /aria-pressed=/.test(page),
    false,
    'атрибут не должен вернуться в разметку',
  )
  assert.equal(
    /setAttribute\('aria-pressed'/.test(page),
    false,
    'атрибут не должен вернуться и через код',
  )
})

test('состояние кнопки несут две подсказки: подпись и цвет из своей палитры', () => {
  assert.match(page, /\.pause-toggle\.is-pause \{ color:var\(--danger\); \}/)
  assert.match(page, /\.pause-toggle\.is-resume \{ color:var\(--acc\); \}/)
  assert.match(
    page,
    /pauseBtn\.classList\.toggle\('is-resume', resume\)/,
    'класс обязан переключаться вместе с подписью, иначе цвет разойдётся со словом',
  )
})

test('ширина кнопки закреплена по самой длинной подписи', () => {
  // Без этого смена подписи двигала бы полосу, а перенос ряда менял бы её высоту.
  assert.match(page, /\.pause-toggle \{ min-width:[\d.]+rem; \}/)
})

test('пройденные этапы зелёные, жирный — только у текущего', () => {
  assert.match(page, /\.stage\.is-past \.stage-name[^{]*\{ color:var\(--acc\); \}/)
  assert.match(page, /\.stage\.is-now \.stage-name \{ color:var\(--acc\); font-weight:600; \}/)
  // Начертание пройденного этапа не задаётся — оно остаётся обычным, 400.
  assert.equal(
    /\.stage\.is-past \.stage-name[^{]*\{[^}]*font-weight:600/.test(page),
    false,
    'жирным должен быть только текущий этап',
  )
  // Исключение одно: «Выдача» при неотданном ответе акцента не получает —
  // он читался бы как удача (находка design-review к PR #204).
  assert.match(
    page,
    /if \(position === 'past' && !withheldHere\) li\.classList\.add\('is-past'\)/,
    'без класса правило не на чем сработать',
  )
})

test('знаки состояния этапа остались: цвет не единственный носитель смысла', () => {
  // Нарушенное цветовосприятие не должно стирать разницу «пройден / идёт /
  // пауза / остановлен / пропущен».
  for (const sign of ['✓', '‖', '×', '–']) {
    assert.ok(page.includes(`return '${sign}'`), `знак ${sign} пропал из stageMark`)
  }
})

test('значок окна настроек нарисован своим токеном, а не currentColor', () => {
  assert.match(page, /\.float svg \{[^}]*stroke:var\(--attn\)/)
  assert.equal(
    /\.float svg \{[^}]*stroke:currentColor/.test(page),
    false,
    'прежняя заливка не должна вернуться',
  )
})

test('жёлтый токен заведён локально в дне 13 и в обеих темах', () => {
  // Корпус жёлтого не содержит; значение живёт только здесь (решение владельца).
  const decls = page.match(/--attn:#[0-9a-f]{6};/g) ?? []
  assert.equal(decls.length, 2, 'ровно два объявления: светлая тема и тёмная')
  assert.notEqual(decls[0], decls[1], 'в тёмной теме значение обязано отличаться')
})
