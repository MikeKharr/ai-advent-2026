// Инструмент: хост зашит, потолок длины один на единицу, ответ поставщика —
// недоверенные данные, а исчерпанная квота отличима от прочих отказов.
// Формы ответов поставщика взяты из прогона 2026-09-28 (README).

import assert from 'node:assert/strict'
import test from 'node:test'
import { TEXT_LIMIT } from '../src/args.js'
import { OUTPUT_LIMIT } from '../src/tools.js'
import { call, ok, recorder, rpc, startService, toolPayload } from './helpers.js'

/** Отказ MyMemory: HTTP 200, а `responseStatus` — СТРОКА «403». Так на самом деле. */
const refusal = (details) => ({
  status: 200,
  body: {
    responseData: { translatedText: details },
    quotaFinished: null,
    responseDetails: details,
    responseStatus: '403',
    matches: '',
  },
})

/** Исчерпанная квота: HTTP 429 и `responseStatus` числом 429. Так на самом деле. */
const QUOTA_TEXT =
  'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN  20 HOURS 02 MINUTES 24 SECONDS VISIT HTTPS://MYMEMORY.TRANSLATED.NET/DOC/USAGELIMITS.PHP TO TRANSLATE MORE'
const quota = () => ({
  status: 429,
  body: { responseData: { translatedText: QUOTA_TEXT }, responseDetails: QUOTA_TEXT, responseStatus: 429, matches: '' },
})

test('запрос уходит на зашитый хост, текст в URL-кодировке, пара языков сырым |', async (t) => {
  const { urls, fetchImpl } = recorder([ok('fintech startups')])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  await call(service.base, 'text.translate', { text: 'финтех стартапы', from: 'ru', to: 'en' })

  assert.equal(urls.length, 1)
  const url = new URL(urls[0])
  assert.equal(url.origin, 'https://api.mymemory.translated.net')
  assert.equal(url.pathname, '/get')
  assert.equal(url.searchParams.get('q'), 'финтех стартапы')
  // Сырой `|` — ровно та форма, что проверена прогоном у поставщика, и
  // ровно та, что Node отправляет по проводу (он её не кодирует).
  assert.equal(urls[0].endsWith('&langpair=ru|en'), true, 'пара языков уходит сырым |')
})

test('текст с адресными символами не дописывает параметров поставщику', async (t) => {
  const { urls, fetchImpl } = recorder([ok('переведено')])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  // `text` — полезная нагрузка, а не адрес, и `? : /` в нём законны. Это
  // держатель решения из `args.js`: запрета адресных символов у `text` нет,
  // и вот почему его отсутствие ничего не открывает.
  const text = 'Как дела? see http://evil.example/x&langpair=xx|yy&q=подмена'
  await call(service.base, 'text.translate', { text, from: 'ru', to: 'en' })

  const url = new URL(urls[0])
  // Красная ветвь: снять `encodeURIComponent` вокруг `text` в `src/tools.js` —
  // аргумент дописывает свои параметры, `langpair` приходит дважды, и пара
  // языков, которую задали мы, обойдена.
  assert.deepEqual(url.searchParams.getAll('langpair'), ['ru|en'], 'пару языков задаём мы, а не аргумент')
  assert.deepEqual(url.searchParams.getAll('q'), [text], 'текст уходит целиком одним значением')
  assert.equal(url.origin, 'https://api.mymemory.translated.net', 'хост зашит и аргументом не меняется')
})

test('код языка — белый список: адресоподобный аргумент наружу не выпускает', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.translate', { text: 'привет', to: 'http://169.254.169.254/' })).json()
  // Красная ветвь: ослабить регулярное выражение в `langCode` (`args.js`) —
  // аргумент проходит, инструмент исполняется, и `urls` перестаёт быть пустым.
  assert.equal(body.result.isError, true)
  assert.deepEqual(urls, [], 'запроса наружу быть не должно')
})

test('потолок длины один на единицу: схема объявляет ровно то, что проверка держит', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const list = (await rpc(service.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
  // Двух копий потолка быть не должно: в `mcpstore` именно две копии стали
  // блокирующей находкой обоих гейтов — ни одна по отдельности не краснела.
  assert.equal(list.result.tools[0].inputSchema.properties.text.maxLength, TEXT_LIMIT)

  const okBody = (await call(service.base, 'text.translate', { text: 'я'.repeat(TEXT_LIMIT), to: 'en' })).json()
  assert.equal(okBody.result.isError, undefined, 'ровно потолок обязан проходить')
  urls.length = 0

  const overBody = (await call(service.base, 'text.translate', { text: 'я'.repeat(TEXT_LIMIT + 1), to: 'en' })).json()
  assert.equal(overBody.result.isError, true, 'на знак больше — отказ, а не обрезка')
  assert.match(JSON.parse(overBody.result.content[0].text).error, new RegExp(String(TEXT_LIMIT)))
  assert.deepEqual(urls, [], 'текст сверх потолка наружу не уходит вовсе')
})

test('исчерпанная квота отличима: reason quota_exhausted, а не общий сбой', async (t) => {
  const { fetchImpl } = recorder([quota()])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.translate', { text: 'привет', from: 'ru', to: 'en' })).json()
  // Не `isError`: цепочке надо идти дальше, а посетителю — увидеть причину.
  assert.equal(body.result.isError, undefined)
  const payload = toolPayload(body)
  assert.equal(payload.translated, false)
  assert.equal(payload.reason, 'quota_exhausted')
  // Исходный текст возвращается, чтобы цепочка продолжилась на нём.
  assert.equal(payload.text, 'привет')
})

test('предупреждение поставщика не выдаётся за перевод', async (t) => {
  const { fetchImpl } = recorder([quota()])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'text.translate', { text: 'привет', to: 'en' })).json())
  // Поставщик кладёт СВОЮ ошибку в `translatedText`. Отдай мы это поле не
  // глядя — посетитель прочёл бы рекламу MyMemory вместо своего текста, и
  // она же ушла бы в выжимку. Красная ветвь: сверять `responseStatus` до
  // взятия текста перестать — утверждение ниже краснеет.
  assert.equal(payload.text.includes('MYMEMORY'), false, 'текст поставщика наружу не уходит')
  assert.equal(payload.text.includes('TRANSLATIONS FOR TODAY'), false)
})

test('отказ поставщика строкой «403» при HTTP 200 не принимается за успех', async (t) => {
  const { fetchImpl } = recorder([refusal('QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS')])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'text.translate', { text: 'привет', to: 'en' })).json())
  // Красная ветвь: заменить `String(data?.responseStatus ?? '') !== '200'` на
  // `data?.responseStatus !== 200` в `src/tools.js` — строка «403» пройдёт
  // сверку как не-200 по-прежнему, а вот успех со строкой «200» отвалится;
  // мутация же `!== '200'` → `=== '200'` красит этот тест прямо.
  assert.equal(payload.translated, false)
  assert.equal(payload.reason, 'provider_refused')
  assert.equal(payload.text, 'привет', 'наружу уходит наш текст, а не жалоба поставщика')
})

test('успех приходит и тогда, когда responseStatus у поставщика строка «200»', async (t) => {
  const reply = ok('hello')
  reply.body.responseStatus = '200'
  const { fetchImpl } = recorder([reply])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  // Поставщик непоследователен в типе поля: 200 числом на успехе, «403»
  // строкой на отказе (прогон). Сверка через `String()` переживает оба.
  const payload = toolPayload((await call(service.base, 'text.translate', { text: 'привет', to: 'en' })).json())
  assert.equal(payload.translated, true)
  assert.equal(payload.text, 'hello')
})

test('без from язык определяет поставщик: Autodetect в паре и detected в ответе', async (t) => {
  const { urls, fetchImpl } = recorder([ok('fintech startups', { detectedLanguage: 'ru' })])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'text.translate', { text: 'финтех стартапы', to: 'en' })).json())
  assert.equal(urls[0].endsWith('&langpair=Autodetect|en'), true)
  assert.equal(payload.detected, true)
  assert.equal(payload.from, 'ru', 'пара языков в ответе — фактическая, а не запрошенная')
  assert.equal(payload.to, 'en')
})

test('определённый поставщиком язык — тоже недоверенные данные', async (t) => {
  const { fetchImpl } = recorder([ok('hello', { detectedLanguage: '../../etc/passwd' })])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'text.translate', { text: 'привет', to: 'en' })).json())
  // Красная ветвь: вернуть `value.trim()` из `safeLang` минуя проверку —
  // мусор поставщика станет «фактическим языком» и уедет на экран.
  assert.equal(payload.from, null)
  assert.equal(payload.detected, false)
  assert.equal(payload.translated, true, 'сам перевод при этом состоялся')
})

test('явный from главнее: определение поставщика фактическую пару не подменяет', async (t) => {
  const { fetchImpl } = recorder([ok('hello', { detectedLanguage: 'uk' })])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload(
    (await call(service.base, 'text.translate', { text: 'привет', from: 'ru', to: 'en' })).json(),
  )
  assert.equal(payload.from, 'ru')
  assert.equal(payload.detected, false)
})

test('перевод длиннее потолка вывода переводом не считается', async (t) => {
  const { fetchImpl } = recorder([ok('д'.repeat(OUTPUT_LIMIT + 1))])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const payload = toolPayload((await call(service.base, 'text.translate', { text: 'привет', to: 'en' })).json())
  assert.equal(payload.translated, false)
  assert.equal(payload.reason, 'unusable_translation')
  assert.equal(payload.text, 'привет')
})

test('недоступный поставщик — provider_unavailable, и его текст наружу не идёт', async (t) => {
  const fetchImpl = async () => new Response('внутренности поставщика', { status: 503 })
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.translate', { text: 'привет', to: 'en' })).json()
  const payload = toolPayload(body)
  assert.equal(payload.reason, 'provider_unavailable')
  assert.equal(body.result.content[0].text.includes('внутренности поставщика'), false)
})

test('совпадающие языки — отказ инструмента, а не пустой поход наружу', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.translate', { text: 'привет', from: 'ru', to: 'ru' })).json()
  assert.equal(body.result.isError, true)
  assert.deepEqual(urls, [])
})

test('управляющие знаки из текста вырезаются до похода наружу', async (t) => {
  const { urls, fetchImpl } = recorder([ok('hello')])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  await call(service.base, 'text.translate', { text: 'при\u0000вет\u001b', to: 'en' })
  assert.equal(new URL(urls[0]).searchParams.get('q').includes('\u0000'), false)
  assert.equal(new URL(urls[0]).searchParams.get('q').includes('\u001b'), false)
})

test('пустой текст — отказ инструмента, наружу не ходим', async (t) => {
  const { urls, fetchImpl } = recorder([])
  const service = await startService({ fetchImpl })
  t.after(() => service.close())

  const body = (await call(service.base, 'text.translate', { text: '   ', to: 'en' })).json()
  assert.equal(body.result.isError, true)
  assert.deepEqual(urls, [])
})
