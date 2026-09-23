// Приёмка задания владельца по дню 15 (пункты 1, 3 и части 4): промпты
// профиля правятся из окна «Об агенте», системного промпта в настройках нет,
// полоса этапов — семь, потолок ответа приходит с сервера.
//
// Проверки выведены из задания, а не из кода: каждая называет то, что владелец
// потребовал, и краснеет при возврате прежнего поведения.
//
// Метод: правила, решающие судьбу промпта, вынесены в странице в выделяемый
// блок без DOM. Тест ВЫРЕЗАЕТ ЭТОТ БЛОК ИЗ СТРАНИЦЫ и исполняет его — то есть
// проверяется сам исходный текст, а не его копия в тесте. DOM-окружения в дне
// нет, поэтому раскладка и живой браузер этими тестами не заменяются.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

/** Вырезанный из страницы блок правил промптов, исполнённый как есть. */
const rules = (() => {
  const from = page.indexOf('/* --- Выделяемый блок: его извлекает и исполняет test/day15-page-prompts.test.js.')
  const to = page.indexOf('/* --- конец выделяемого блока --- */', from)
  assert.notEqual(from, -1, 'блок правил промптов обязан остаться выделяемым')
  assert.notEqual(to, -1, 'у блока правил промптов обязан быть конец')
  const body = page.slice(from, to)
  return new Function(`${body}
    return { PROMPT_MAX, SYSTEM_PROMPT_ID, DRAFT_PROMPT_ID, promptIdOf, promptViewOf,
             withoutPrompt, loadProfilePrompts, savePrompt, resetPrompt };`)()
})()

const REGISTRY = {
  'stage.answer': 'умолчание системного промпта',
  'stage.summary': 'умолчание сводки',
  'stage.verify.invariants': 'умолчание проверки',
  'stage.replenish': 'умолчание пополнения',
  'invariant.draft': 'умолчание формулировщика',
}

/** Поддельный сервис: он и хранит промпты профиля, как настоящий. */
const fakeService = (stored = {}) => {
  const calls = []
  const state = { ...stored }
  const api = async (path, options) => {
    const method = options?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    if (path === './api/profile') return { profile: { prompts: { ...state } } }
    const m = path.match(/^\.\/api\/prompts\/(.+)$/)
    if (!m) throw new Error(`неизвестный путь ${path}`)
    const id = decodeURIComponent(m[1])
    if (method === 'PUT') {
      state[id] = JSON.parse(options.body).text
      return { ok: true }
    }
    if (method === 'DELETE') {
      if (!(id in state)) {
        // Второе нажатие «Вернуть умолчание»: строки уже нет.
        const error = new Error('промпт не найден')
        error.status = 404
        throw error
      }
      delete state[id]
      return { ok: true }
    }
    throw new Error(`неизвестный метод ${method}`)
  }
  return { api, calls, state }
}

test('правка промпта живёт в профиле и видна после перезагрузки страницы', async () => {
  const service = fakeService()
  await rules.savePrompt(service.api, 'stage.verify.invariants', 'мой промпт проверки')

  // Перезагрузка страницы — это новый разбор промптов из того же источника.
  const afterReload = await rules.loadProfilePrompts(service.api)
  const view = rules.promptViewOf('stage.verify.invariants', REGISTRY, afterReload)
  assert.equal(view.text, 'мой промпт проверки')
  assert.equal(view.source, 'profile', 'строка источника обязана назвать промпт профиля')
  assert.equal(view.chars, 'мой промпт проверки'.length)

  // Прочие промпты правка не трогает.
  assert.equal(rules.promptViewOf('stage.summary', REGISTRY, afterReload).text, 'умолчание сводки')
  assert.deepEqual(service.calls, [
    'PUT ./api/prompts/stage.verify.invariants',
    'GET ./api/profile',
    'GET ./api/profile',
  ], 'правда о профиле перечитывается с сервиса, а не достраивается по памяти')
})

test('промпты профиля хранит сервис, а не браузер', () => {
  // Хранение в браузере не пережило бы ни другой вкладки, ни другого
  // посетителя того же профиля — а правка обязана действовать для профиля.
  assert.equal(
    /localStorage|sessionStorage/.test(page),
    false,
    'ни промпты, ни что-либо ещё страница в браузере не хранит',
  )
  assert.match(page, /const loadProfilePrompts = async \(request\) => \{/)
  assert.match(page, /await request\('\.\/api\/profile'\)/)
})

test('«Вернуть умолчание» идемпотентно: второе нажатие отвечает тем же', async () => {
  const service = fakeService({ 'stage.summary': 'мой промпт сводки' })

  const first = await rules.resetPrompt(service.api, 'stage.summary')
  const second = await rules.resetPrompt(service.api, 'stage.summary')

  assert.deepEqual(first, second, 'карта промптов после второго сброса обязана совпасть')
  const view = (own) => rules.promptViewOf('stage.summary', REGISTRY, own)
  assert.deepEqual(view(first), view(second))
  assert.equal(view(second).text, 'умолчание сводки')
  assert.equal(view(second).source, 'registry')
})

test('сброс — удаление строки, а не пустой текст', async () => {
  // Пустой промпт сервис отвергает разбором (`parseSystem`), и сброс пустым
  // текстом молча ничего не менял бы.
  const service = fakeService({ 'stage.replenish': 'мой промпт' })
  await rules.resetPrompt(service.api, 'stage.replenish')
  assert.deepEqual(service.calls.slice(0, 1), ['DELETE ./api/prompts/stage.replenish'])
  assert.equal('stage.replenish' in service.state, false)
})

test('промпт профиля поверх умолчания: пустой текст профиля не бывает правкой', () => {
  assert.equal(rules.promptViewOf('stage.answer', REGISTRY, {}).source, 'registry')
  assert.equal(rules.promptViewOf('stage.answer', REGISTRY, { 'stage.answer': '   ' }).source, 'registry')
  assert.equal(rules.withoutPrompt({ a: 1, b: 2 }, 'a').b, 2)
  assert.equal('a' in rules.withoutPrompt({ a: 1 }, 'a'), false)
})

test('редактируемых промптов пять и они названы ADR', () => {
  const ids = ['stage.summary', 'stage.answer', 'stage.verify.invariants',
    'stage.replenish', 'invariant.draft']
  const bound = new Set([
    rules.promptIdOf({ id: 'assemble' }),
    rules.promptIdOf({ id: 'answer' }),
    rules.promptIdOf({ id: 'verify' }),
    rules.promptIdOf({ id: 'replenish' }),
    rules.DRAFT_PROMPT_ID,
  ])
  assert.deepEqual([...bound].sort(), [...ids].sort())
  // Этапы без вызова модели промпта не имеют и править их нечего.
  assert.equal(rules.promptIdOf({ id: 'intake' }), null)
  assert.equal(rules.promptIdOf({ id: 'prepare' }), null)
  assert.equal(rules.promptIdOf({ id: 'deliver' }), null)
  // Таблицу этапов задаёт сервис: его `promptId` сильнее запасной таблицы.
  assert.equal(rules.promptIdOf({ id: 'assemble', promptId: 'stage.other' }), 'stage.other')
  // Предел разбора сервиса — на поле, а не «сколько влезет».
  assert.equal(rules.PROMPT_MAX, 4000)
  assert.match(page, /area\.maxLength = PROMPT_MAX;/)
})

test('у каждого редактора есть «Сохранить» и «Вернуть умолчание»', () => {
  assert.match(page, /save\.textContent = 'Сохранить';/)
  assert.match(page, /reset\.textContent = 'Вернуть умолчание';/)
  assert.match(page, /save\.onclick = \(\) => writePrompt\(el, 'save'\);/)
  assert.match(page, /reset\.onclick = \(\) => writePrompt\(el, 'reset'\);/)
  // Четыре состояния содержимого у нового блока: загрузка, готово, ошибка с
  // «Повторить», отсутствие промпта у этапа.
  assert.match(page, /Загружаю промпты профиля…/)
  assert.match(page, /id="dlg-pr-retry"/)
  assert.match(page, /\$\('dlg-pr-retry'\)\.onclick = loadPrompts;/)
  assert.match(page, /Промпты профиля не загрузились/)
})

test('в настройках агента системного промпта больше нет', () => {
  // Два места, правящих один текст, расходятся молча (задание, п. 3).
  assert.equal(/p-system/.test(page), false, 'поля системного промпта в настройках быть не должно')
  assert.equal(
    /Свой системный промпт/.test(page),
    false,
    'подпись поля не должна вернуться даже в режиме чтения',
  )
  // И в тело настроек, и в тело запуска промпт больше не кладётся.
  assert.equal(/out\.system = /.test(page), false)
  assert.equal(/params\.system = /.test(page), false)
})

test('верхняя граница лимита ответа приходит с сервера, 32 000 принимается', () => {
  const source = page.match(/const applyMaxCap = \(cap\) => \{[\s\S]*?\n {2}\};/)
  assert.notEqual(source, null, 'правило потолка обязано жить отдельной функцией')
  const field = { max: '2048', nextElementSibling: { textContent: '' } }
  const applyMaxCap = new Function('$', 'fmtInt',
    `${source[0]} return applyMaxCap;`)(() => field, (n) => Number(n).toLocaleString('ru-RU'))

  applyMaxCap(32000)
  assert.equal(field.max, '32000', 'поле обязано принять 32 000')
  assert.equal(
    Number('32001') > Number(field.max),
    true,
    'всё, что больше потолка, поле обязано отвергнуть',
  )
  // Число не зашито: пришло другое — поле и подсказка говорят другое.
  applyMaxCap(2048)
  assert.equal(field.max, '2048')
  assert.match(field.nextElementSibling.textContent, /1–2\s048/)
  assert.equal(/max="32000"|1–32\s?000/.test(page), false, 'потолок не должен быть зашит в страницу')
})

test('подсказка лимита не обещает, что длинный ответ успеет', () => {
  // Скорость генерации не замерена (ADR 2026-09-23-0646, п. 5): обещать её
  // экран не вправе, а обрыв по таймауту оплачен.
  const hint = page.match(/const applyMaxCap[\s\S]*?\n {2}\};/)[0]
  assert.match(hint, /не успеть до таймаута/)
  assert.match(hint, /скорость генерации мы не замеряли/)
  assert.match(hint, /уже оплачено/)
})

test('в полосе семь этапов, «Подготовка промпта» — между сборкой и вызовом', () => {
  const source = page.match(/const FALLBACK_STAGES = \[[\s\S]*?\n {2}\];/)
  assert.notEqual(source, null)
  const list = new Function(`${source[0]} return FALLBACK_STAGES;`)()
  assert.deepEqual(list.map((x) => x.id), [
    'intake', 'assemble', 'prepare', 'answer', 'verify', 'replenish', 'deliver',
  ])
  const prepare = list.find((x) => x.id === 'prepare')
  assert.equal(prepare.title, 'Подготовка промпта')
  assert.equal(prepare.prompt, null, 'у этапа без вызова модели промпта нет')
  assert.match(prepare.rule, /уйдёт модели/)
  // Число этапов на экранах не зашито числом там, где оно может разойтись.
  assert.match(page, /\$\('dlg-stages-h'\)\.textContent = `Этапы запуска: \$\{stages\.length\}`;/)
})
