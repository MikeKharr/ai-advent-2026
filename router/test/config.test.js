// Продовая конфигурация — такой же источник отказа на старте, как код, но до
// сих пор её не читал ни один тест (находка гейтов по PR #140). Здесь она
// грузится настоящим loadConfig на фиктивных ключах.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadConfig, orderedCandidates, PROFILE_DEFAULTS } from '../src/config.js'
import { createStaticRegistry } from '../src/registry.js'
import { createRouter } from '../src/router.js'

const read = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'))
const providers = read('providers.json')
const classes = read('classes.json')
const apps = read('apps.json')

// Ключи фиктивные: проверяется полнота конфигурации, а не доступ к провайдеру.
const ENV_PROD = {
  ANTHROPIC_API_KEY: 'ci-dummy',
  GROQ_API_KEY: 'ci-dummy',
  KIMI_API_KEY: 'ci-dummy',
  ROUTER_ADMIN_KEY: 'ci-dummy',
  APP_KEY_SMOKE: 'ci-dummy',
  APP_KEY_DAY5: 'ci-dummy',
  APP_KEY_AGENTS: 'ci-dummy',
}

const kimi = providers.filter((p) => p.kind === 'kimi')

test('продовая конфигурация загружается: роутер с записями Kimi стартует', () => {
  const config = loadConfig({ providers, classes, apps, env: ENV_PROD })
  assert.equal(config.providers.length, providers.length)
})

test('четыре записи Kimi на одном ключе и одной ёмкости', () => {
  assert.deepEqual(
    kimi.map((p) => p.id),
    ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
  )
  for (const p of kimi) {
    assert.equal(p.secretEnv, 'KIMI_API_KEY', `${p.id}: общий секрет`)
    assert.equal(p.maxConcurrency, 15, `${p.id}: одна ёмкость на хост`)
    assert.equal(p.explicitOnly, true, `${p.id}: только явный выбор`)
    // Поле выражает оркестрацию, а не границу выхода данных (PR #140).
    assert.deepEqual(p.dataClasses, ['public', 'internal', 'personal'], p.id)
  }
})

test('без KIMI_API_KEY роутер не стартует целиком, а не теряет один класс', () => {
  assert.throws(
    () => loadConfig({ providers, classes, apps, env: { ...ENV_PROD, KIMI_API_KEY: '' } }),
    /KIMI_API_KEY/,
  )
})

test('Kimi не участвует в политике ни одного класса, но доступен по имени', () => {
  for (const [name, cls] of Object.entries(classes)) {
    const policy = orderedCandidates(cls, providers).map((p) => p.id)
    assert.deepEqual(
      policy.filter((id) => id.startsWith('kimi-')),
      [],
      `класс ${name}: автоматическая маршрутизация Kimi не берёт`,
    )
  }
  // Явный выбор допустим там, где класс включает ярус cloud-frontier.
  const explicit = orderedCandidates(classes.other, providers, { explicit: true }).map((p) => p.id)
  assert.deepEqual(explicit.filter((id) => id.startsWith('kimi-')), kimi.map((p) => p.id))
})

const agents = apps.apps.find((a) => a.id === 'agents')

test('лимиты agents — та пара, что решена владельцем 2026-09-16', () => {
  assert.deepEqual(agents.limits, { dailyTokens: 10_000_000, dailyCostUsd: 10 })
})

// Роутер на продовой конфигурации. Сеть не нужна: и список моделей, и отказ по
// потолку ответа решаются до обращения к провайдеру, поэтому fetch здесь падает —
// если он всё же будет вызван, тест покраснеет, а не сходит наружу.
function prodRouter() {
  const config = loadConfig({ providers, classes, apps, env: ENV_PROD })
  return createRouter({
    config,
    registry: createStaticRegistry(config.providers),
    fetchImpl: () => {
      throw new Error('в этом тесте провайдеров не вызывают')
    },
    env: ENV_PROD,
  })
}

// Класс дня 11 (ADR 2026-09-15-2024, п. 8.1). Поля сверяются целиком: у класса
// нет «неважных» полей — каждое из них двигает либо выбор модели, либо цену.
test('класс layered_dialogue — поля, решённые ADR 2026-09-15-2024', () => {
  assert.deepEqual(classes.layered_dialogue, {
    tiers: ['self-hosted', 'cloud-cheap', 'cloud-frontier'],
    requires: ['text_generation'],
    thinking: 'none',
    answerTokens: 1024,
    // Поднят до 32 000 ради агента дня 15 (ADR 2026-09-23-0646, п. 5).
    // Дни 11–14 выше 2048 по-прежнему не ходят: их держат собственные
    // разборщики (`LAYERED_MAX_TOKENS` в `agents/src/params.js`), и класс
    // для них — второй рубеж, а не первый.
    maxAnswerTokens: 32000,
    dataClass: 'public',
  })
})

test('layered_dialogue разрешён приложению agents и только ему', () => {
  assert.ok(agents.classes.includes('layered_dialogue'))
  for (const a of apps.apps.filter((x) => x.id !== 'agents'))
    assert.equal(a.classes.includes('layered_dialogue'), false, `${a.id}: класс дня 11 не его`)
})

// Восемь, а не четыре (критерий 12 ADR). Четыре — это длина списка MODELS в
// agents/src/params.js, подмножество, которое предлагает страница. Роутер же
// отдаёт всех кандидатов явного выбора: providerLimits зовёт orderedCandidates с
// explicit: true, и записи Kimi входят туда по ADR 2026-09-15-1448. Число здесь
// намеренно больше того, что показывает страница: зелёный тест нельзя получить
// сужением tiers или добавлением deny — и то, и другое отрезало бы явный выбор
// Kimi и Groq, а список ниже стал бы короче.
test('/v1/models по классу layered_dialogue отдаёт восемь моделей для явного выбора', () => {
  const ids = prodRouter().providerLimits('layered_dialogue').map((p) => p.id)
  assert.deepEqual(ids, [
    'mac-qwen3',
    'groq-gpt-oss-20b',
    'groq-qwen3.6-27b',
    'anthropic-haiku',
    'kimi-k3',
    'kimi-k2.6',
    'kimi-k2.7-code',
    'kimi-k2.7-code-highspeed',
  ])
  assert.equal(ids.length, 8)
  // Классификатор инъекций не генеративный — в списке для выбора ему не место.
  assert.equal(ids.includes('groq-prompt-guard'), false)
})

// Потолок ответа — граница расхода: на Kimi k3 выход по $15 за миллион, и
// каждая лишняя тысяча токенов стоит денег. Отказ приходит до выбора провайдера.
test('layered_dialogue отвергает ответ выше 32 000 токенов, не обращаясь к провайдеру', async () => {
  const refused = await prodRouter().route({
    taskClass: 'layered_dialogue',
    input: 'привет',
    answerTokens: 32_001,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'refused')
  // Число в сообщении — из класса, а не константа роутера.
  assert.match(refused.message, /от 1 до 32000/)
})

// Потолок дня 15 проходит до провайдера: поле страницы обещает 32 000, и
// класс обязан это принять — иначе обещание рвалось бы отказом роутера
// (ADR 2026-09-23-0646, п. 5).
// Таймаут вызова ответа у сервиса агентов считается дедлайном роутера для
// профиля `cloud` — его формулой и этими числами (`agents/src/llm.js`,
// `ROUTER_CLOUD_DEADLINE`). Копия там нужна потому, что агент не читает
// конфигурацию роутера; чтобы копия не разошлась с оригиналом молча, числа
// закреплены здесь: правка профиля без правки агента вернёт ровно тот дефект,
// ради которого таймаут переписан, — вызывающий обрывает раньше роутера, и
// сгенерированное оплачено впустую (находки reviewer и compliance к PR #218).
test('профиль cloud: числа дедлайна, по которым считает таймаут сервис агентов', () => {
  assert.deepEqual(PROFILE_DEFAULTS.cloud, {
    loadMs: 0,
    promptEvalTps: 2000,
    genTpsFloor: 40,
    margin: 1.25,
    minMs: 60_000,
  })
})

test('layered_dialogue принимает ровно 32 000 токенов ответа', async () => {
  const answer = await prodRouter().route({
    taskClass: 'layered_dialogue',
    input: 'привет',
    answerTokens: 32_000,
  })
  assert.equal(answer.ok, false)
  // `all_failed`, а не `refused`: запрос прошёл проверку потолка и дошёл до
  // вызова провайдеров — а звать их в этом тесте нечем, `fetch` бросает.
  // При потолке 2048 тот же запрос возвращал бы `refused` до всякого вызова,
  // поэтому исход различает гипотезы.
  assert.equal(answer.code, 'all_failed')
})

// Дефект, ради которого заведена эта проверка: денежный потолок работает только
// тогда, когда токенный не упирается раньше. Пара «$10 при 2 млн токенов»
// этого не давала — фактический предел оставался около $2,8. Проверяется связь,
// а не равенство: при возврате `dailyTokens` к 2 млн тест обязан краснеть.
test('у agents денежный лимит упирается раньше токенного по ставке Haiku', () => {
  const haiku = providers.find((p) => p.id === 'anthropic-haiku')
  const { dailyCostUsd, dailyTokens } = agents.limits
  // Чистый вход — самая дешёвая возможная смесь, поэтому это верхняя граница
  // числа токенов, которые вообще можно купить на суточные деньги.
  const affordable = (dailyCostUsd / haiku.price.inputPerMTok) * 1e6
  assert.ok(
    dailyTokens >= affordable,
    `токенный лимит ${dailyTokens} упирается раньше денежного $${dailyCostUsd}: ` +
      `по ставке Haiku на эти деньги приходится до ${affordable} токенов`,
  )
})
