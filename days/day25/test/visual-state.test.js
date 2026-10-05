// Три косметические правки экрана (решение владельца 2026-09-22) проверяются
// по исходному тексту страницы, а не по описанию правила в тесте.
//
// Проверка структурная и названа прямо: она ловит возврат прежнего поведения
// (постоянная подпись, `aria-pressed`, этап без цвета, значок currentColor), но
// не заменяет живого замера в браузере — высота полосы и контраст меряются там.
//
// Путь к файлу задан от каталога теста: тесты дня запускаются `node --test` из
// `days/day25`, и относительный путь от cwd сломался бы при запуске из корня.

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
  // Корпус жёлтого не содержит; значение живёт только здесь. Решение владельца
  // есть у дня 15 и НЕТ у дня 25: отклонение названо в шапке страницы и в
  // описании PR, и этот тест держит только то, что токен не расползся по
  // корпусу и объявлен в обеих темах.
  const decls = page.match(/--attn:#[0-9a-f]{6};/g) ?? []
  assert.equal(decls.length, 2, 'ровно два объявления: светлая тема и тёмная')
  assert.notEqual(decls[0], decls[1], 'в тёмной теме значение обязано отличаться')
})

// --- находки `design-review` к PR #318 --------------------------------------

test('узкая раскладка сжимается: у сетки и колонок нет min-width:auto', () => {
  // Воспроизведение дефекта: на вьюпорте 320 после первого же хода с
  // предупреждением страница становилась 405 px шириной — у элемента сетки
  // `min-width` равен `auto`, и дорожка не сжималась ниже min-content
  // содержимого (внутри есть `white-space:nowrap` у `.run-status`).
  //
  // Проверяется ИСХОДНИК, а не браузер: DOM-окружения в дне нет, и живой
  // замер остаётся в описании PR (там же названо, почему мерить надо без
  // мобильной эмуляции — она расширяет layout viewport и прокрутку скрывает).
  const layout = page.match(/\n  \.layout \{([\s\S]*?)\}/)
  assert.notEqual(layout, null, 'блок .layout не найден')
  assert.match(
    layout[1],
    /grid-template-columns:minmax\(0,1fr\)/,
    'узкая раскладка снова на `1fr`: дорожка не сожмётся ниже min-content',
  )
  // И колонкам разрешено сжиматься: без этого min-content держит уже сама
  // колонка, а не дорожка.
  assert.match(page, /\n  \.col \{ min-width:0; \}/)
  // Широкая раскладка свой minmax имела с самого начала — он не потерян.
  assert.match(page, /grid-template-columns: minmax\(0,1fr\) 24rem;/)
})

test('отказ списка профилей объявляется словами, а не «Профилей: 0»', () => {
  // Находка `design-review`: при отказе службы в живую область уходило
  // «Экран выбора профиля. Профилей: 0.» — для того, кто строки не видит, это
  // ложь: список не пуст, он не загрузился.
  assert.match(page, /const GATE_FAILED = 'Список профилей не загрузился\. Проверьте связь и повторите\.';/)
  // Один текст на видимую строку и на объявление: две копии разъехались бы.
  assert.match(page, /say\(\$\('gate-msg'\), GATE_FAILED\);/)
  assert.match(page, /: `Экран выбора профиля\. \$\{GATE_FAILED\}`,/)
  // И признак успеха действительно возвращается загрузчиком, иначе ветвиться
  // было бы не по чему.
  assert.match(page, /renderGate\(\{ focus \}\);\n      return true;/)
  assert.match(page, /if \(focus\) \$\('gate-retry'\)\.focus\(\);\n      return false;/)
})

test('служебные строки под источниками — по ширине чтения, номера — табличные', () => {
  // Корпус: ширина чтения 52ch у служебного текста, 68ch — у текста ответа.
  assert.match(page, /\.rag \.sum \{ max-width:52ch; \}/)
  // Номер фрагмента в пометке цитаты — число в столбик.
  const mark = page.match(/\n  \.quote-mark \{([\s\S]*?)\}/)
  assert.notEqual(mark, null)
  assert.match(mark[1], /font-variant-numeric:tabular-nums/)
})
