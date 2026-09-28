// Реестр агентов — данные, а не код (ADR 2026-09-09-0854, п. 1). Битая
// запись валит процесс на старте: агент с пустым промптом или неизвестным
// инструментом не должен принимать запуски.

import { LAYERED_MODELS, MODELS, REVIEW_ROUNDS } from './params.js'

const KNOWN_TOOLS = new Set(['archive', 'mcp'])
const ID = /^[a-z][a-z0-9-]{1,40}$/

function fail(id, message) {
  throw new Error(`реестр агентов${id ? ` (${id})` : ''}: ${message}`)
}

/** Проверяет реестр и возвращает агентов по идентификатору. */
export function loadRegistry(raw) {
  if (!raw || !Array.isArray(raw.agents) || raw.agents.length === 0)
    fail(null, 'ожидался непустой список agents')

  const agents = new Map()
  for (const entry of raw.agents) {
    const id = entry?.id
    if (typeof id !== 'string' || !ID.test(id)) fail(id, 'id: латиница, цифры и дефис')
    if (agents.has(id)) fail(id, 'идентификатор повторяется')
    for (const field of ['name', 'version', 'purpose']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        fail(id, `${field}: ожидалась непустая строка`)
    }
    if (!Array.isArray(entry.tools) || entry.tools.some((t) => !KNOWN_TOOLS.has(t)))
      fail(id, `tools: допустимы только ${[...KNOWN_TOOLS].join(', ')}`)

    const d = entry.defaults
    if (!d || typeof d !== 'object') fail(id, 'defaults: ожидался объект')

    // Агент без модели: цепочка дня 19 идёт в коде, модель не спрашивается
    // вовсе (ADR 2026-09-28-0736, п. 8). Класс задачи, потолок ответа,
    // температура и окно контекста — параметры вызова модели, и требовать их
    // от такого агента значило бы заставлять выдумывать числа, которые никуда
    // не уйдут. Признак — отсутствие `defaults.model`; заданная модель
    // возвращает все прежние требования, включая `taskClass`.
    const modelless = d.model === undefined
    if (modelless) {
      for (const field of ['maxTokens', 'temperature', 'contextTokens', 'reviewModel', 'reviewRounds'])
        if (d[field] !== undefined) fail(id, `defaults.${field}: у агента без модели не бывает`)
      if (entry.taskClass !== undefined) fail(id, 'taskClass: у агента без модели не бывает')
    } else if (typeof entry.taskClass !== 'string' || entry.taskClass.trim() === '') {
      fail(id, 'taskClass: ожидалась непустая строка')
    }

    // Промпт — тоже параметр вызова модели: у агента без модели его нет.
    if (!modelless) {
      if (
        !Array.isArray(entry.systemPrompt) ||
        entry.systemPrompt.length === 0 ||
        entry.systemPrompt.some((line) => typeof line !== 'string' || line.trim() === '')
      )
        fail(id, 'systemPrompt: ожидался список непустых строк')
    } else if (entry.systemPrompt !== undefined) {
      fail(id, 'systemPrompt: у агента без модели не бывает')
    }

    if (!modelless && !MODELS.some((m) => m.id === d.model)) fail(id, `defaults.model: неизвестная модель`)
    if (!modelless && (!Number.isInteger(d.maxTokens) || d.maxTokens <= 0))
      fail(id, 'defaults.maxTokens: ожидалось положительное целое')
    // Статей с источника у агента без архива не бывает (день 11), поэтому
    // поле необязательно; заданное проверяется как прежде.
    if (d.perSource !== undefined && (!Number.isInteger(d.perSource) || d.perSource <= 0))
      fail(id, 'defaults.perSource: ожидалось положительное целое или отсутствие')
    if (!modelless && (!Number.isFinite(d.temperature) || d.temperature < 0 || d.temperature > 1))
      fail(id, 'defaults.temperature: число от 0 до 1')
    // Число статей в умолчаниях необязательно: без него подборку набирает
    // агент под предел входа модели.
    if (d.articles !== undefined && (!Number.isInteger(d.articles) || d.articles <= 0))
      fail(id, 'defaults.articles: ожидалось положительное целое или отсутствие')
    // Ноль законен: агент без памяти о разговоре.
    if (!modelless && (!Number.isInteger(d.contextTokens) || d.contextTokens < 0))
      fail(id, 'defaults.contextTokens: ожидалось целое не меньше нуля')
    // Круг проверки дня 13: у агентов без него этих полей не бывает, а
    // заданные проверяются теми же границами, что вход запуска и настройки.
    if (d.reviewModel !== undefined && !LAYERED_MODELS.some((m) => m.id === d.reviewModel))
      fail(id, 'defaults.reviewModel: неизвестная модель')
    if (
      d.reviewRounds !== undefined &&
      (!Number.isInteger(d.reviewRounds) ||
        d.reviewRounds < REVIEW_ROUNDS.min ||
        d.reviewRounds > REVIEW_ROUNDS.max)
    )
      fail(id, `defaults.reviewRounds: целое от ${REVIEW_ROUNDS.min} до ${REVIEW_ROUNDS.max}`)

    agents.set(id, {
      id,
      name: entry.name,
      version: entry.version,
      purpose: entry.purpose,
      taskClass: entry.taskClass ?? null,
      modelless,
      tools: [...entry.tools],
      // Промпт хранится строками ради читаемости JSON, в модель уходит
      // одной строкой — ровно так, как показывает окно передачи.
      systemPrompt: modelless ? null : entry.systemPrompt.join(' '),
      defaults: { ...d },
    })
  }
  return agents
}
