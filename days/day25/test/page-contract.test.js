// Контракт страницы против НАСТОЯЩЕГО ответа сервиса.
//
// Почему этот файл существует. Строка журнала под ответом агента не появлялась
// вовсе: страница искала идентификатор запуска в сводке (`meta.runId`), а
// сервис кладёт его на само сообщение (`message.runId`). Дефект пережил три
// гейта и сорок три теста — ровно потому, что поддельный сервис в тестах писал
// идентификатор туда, куда смотрел код. Заглушка проверяла представление автора
// о контракте, а не контракт.
//
// Поэтому фикстура ниже — не выдумка, а **запись живого ответа**
// `GET /api/chat` от `agents/src/staged.js` (прогон 2026-09-22, два круга
// проверки). Числа и формы полей взяты как есть; вырезаны только длинные
// тексты. Менять её можно лишь по новой записи с живого сервиса.
//
// Проверяется не копия правила, а сам исходный текст страницы: функция
// `runIdOf` извлекается из `public/index.html` и исполняется. Если правило
// вернуть к чтению одной лишь сводки, тест краснеет.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')

/**
 * Живая запись ответа агента из переписки. Ключевое здесь — ЧЕГО НЕТ:
 * в `meta` нет ни `runId`, ни `marked`. Оба поля страница когда-то там искала.
 */
const LIVE_AGENT_MESSAGE = {
  id: 2,
  role: 'agent',
  text: 'Первое. Второе. Третье. Четвёртое. Пятое.',
  tokens: 320,
  at: '2026-09-22T03:03:10.682Z',
  runId: '34560b58-2445-4801-aaff-1378cc30f264',
  parentId: 1,
  meta: {
    model: 'anthropic-haiku',
    provider: 'anthropic-haiku',
    profileId: '74117c09-ff1b-4f86-89f8-449d6522a178',
    topicId: null,
    rules: 0,
    rulesTokens: 0,
    topicFacts: 0,
    topicTokens: 0,
    inputTokens: 1803,
    outputTokens: 320,
    totalTokens: 2123,
    durationMs: 16,
    budgetTokens: 40000,
    capTokens: 32000,
    contextUsed: 15,
    contextEffective: 3000,
    contextRequested: 3000,
    contextMessages: 1,
    truncated: false,
    systemOverridden: false,
    maxTokens: 1024,
    temperature: 1,
    stopSequences: 0,
    reviewModel: 'kimi-k2.6',
    reviewRounds: 2,
    rounds: 2,
    stagesPassed: 9,
    review: {
      verdict: 'rejected',
      remarks: 'ответ длиннее одного слова — перечислены пять пунктов.',
      rounds: 2,
      reason: 'rejected',
    },
    strategy: 'summary',
    summarizeAt: 2000,
  },
}

/** Правило из живого исходника страницы, а не его копия в тесте. */
const loadRule = (name) => {
  const found = page.match(new RegExp(`\\n\\s*const ${name} = [^\\n]*\\n`))
  assert.ok(found, `на странице нет правила ${name} — его переименовали или убрали`)
  // eslint-disable-next-line no-eval
  return eval(`(${found[0].trim().replace(new RegExp(`^const ${name} = `), '').replace(/;$/, '')})`)
}

test('живой ответ сервиса действительно не несёт runId в сводке', () => {
  // Если сервис однажды начнёт класть его в сводку, эта проверка упадёт — и
  // тогда фикстуру надо переснять, а не поправить на глазок.
  assert.equal(LIVE_AGENT_MESSAGE.meta.runId, undefined)
  assert.equal(LIVE_AGENT_MESSAGE.meta.marked, undefined)
  assert.equal(typeof LIVE_AGENT_MESSAGE.runId, 'string')
})

test('страница берёт идентификатор запуска с сообщения, а не только из сводки', () => {
  const runIdOf = loadRule('runIdOf')
  assert.equal(
    runIdOf(LIVE_AGENT_MESSAGE),
    '34560b58-2445-4801-aaff-1378cc30f264',
    'без этого строка «журнал: смотреть CSV» не появляется ни под ответом, ни после перезагрузки',
  )
})

test('сводка, если однажды понесёт своё поле, окажется точнее', () => {
  const runIdOf = loadRule('runIdOf')
  const both = { ...LIVE_AGENT_MESSAGE, meta: { ...LIVE_AGENT_MESSAGE.meta, runId: 'из-сводки' } }
  assert.equal(runIdOf(both), 'из-сводки')
})

test('без идентификатора нигде правило отдаёт null, а не выдумывает строку', () => {
  const runIdOf = loadRule('runIdOf')
  const { runId, ...noRunId } = LIVE_AGENT_MESSAGE
  assert.equal(runIdOf(noRunId), null)
  assert.equal(runIdOf(undefined), null)
  assert.equal(runIdOf({}), null)
})

test('карточка ответа зовёт правило, а не читает сводку напрямую', () => {
  // Проверка структурная, и это названо прямо: правило можно оставить верным и
  // перестать его звать — следствие будет тем же, строки журнала не будет.
  // Поведенческий тест выше этого не ловит: он проверяет правило, а дефект был
  // в проводке. Именно такой разрыв «правило верное, зовут не там» и пережил
  // прошлые круги.
  assert.match(
    page,
    /addJournal\(li,[^)]*runId: runIdOf\(m\)/,
    'карточка ответа обязана брать идентификатор запуска через runIdOf(m)',
  )
})

test('подпись строки журнала называет проходы этапов, а не этапы', () => {
  // `stagesPassed` живого прогона — 9 при двух кругах, а этапов на экране шесть.
  assert.equal(LIVE_AGENT_MESSAGE.meta.stagesPassed, 9)
  assert.equal(LIVE_AGENT_MESSAGE.meta.rounds, 2)
  assert.match(
    page,
    /Проходов этапов: \$\{meta\.stagesPassed\}/,
    'подпись «Этапы: 9» рядом с машиной из шести этапов читается как ошибка экрана',
  )
  assert.equal(
    /`Этапы: \$\{meta\.stagesPassed\}`/.test(page),
    false,
    'прежняя подпись не должна вернуться',
  )
})

test('пометка проверки берётся по вердикту: булева marked в сводке нет', () => {
  // Та же природа, что и у runId: поле есть в результате запуска, но не в
  // сводке сообщения, которую читает карточка ответа.
  assert.equal(LIVE_AGENT_MESSAGE.meta.marked, undefined)
  assert.equal(LIVE_AGENT_MESSAGE.meta.review.reason, 'rejected')
  assert.match(page, /MARKED\.has\(review\.verdict\)/)
})
