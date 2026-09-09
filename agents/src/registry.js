// Реестр агентов — данные, а не код (ADR 2026-09-10-1000, п. 1). Битая
// запись валит процесс на старте: агент с пустым промптом или неизвестным
// инструментом не должен принимать запуски.

import { MODELS } from './params.js'

const KNOWN_TOOLS = new Set(['archive'])
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
    for (const field of ['name', 'version', 'purpose', 'taskClass']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        fail(id, `${field}: ожидалась непустая строка`)
    }
    if (
      !Array.isArray(entry.systemPrompt) ||
      entry.systemPrompt.length === 0 ||
      entry.systemPrompt.some((line) => typeof line !== 'string' || line.trim() === '')
    )
      fail(id, 'systemPrompt: ожидался список непустых строк')
    if (!Array.isArray(entry.tools) || entry.tools.some((t) => !KNOWN_TOOLS.has(t)))
      fail(id, `tools: допустимы только ${[...KNOWN_TOOLS].join(', ')}`)

    const d = entry.defaults
    if (!d || typeof d !== 'object') fail(id, 'defaults: ожидался объект')
    if (!MODELS.some((m) => m.id === d.model)) fail(id, `defaults.model: неизвестная модель`)
    for (const field of ['maxTokens', 'perSource', 'articles']) {
      if (!Number.isInteger(d[field]) || d[field] <= 0)
        fail(id, `defaults.${field}: ожидалось положительное целое`)
    }
    if (!Number.isFinite(d.temperature) || d.temperature < 0 || d.temperature > 1)
      fail(id, 'defaults.temperature: число от 0 до 1')

    agents.set(id, {
      id,
      name: entry.name,
      version: entry.version,
      purpose: entry.purpose,
      taskClass: entry.taskClass,
      tools: [...entry.tools],
      // Промпт хранится строками ради читаемости JSON, в модель уходит
      // одной строкой — ровно так, как показывает окно передачи.
      systemPrompt: entry.systemPrompt.join(' '),
      defaults: { ...d },
    })
  }
  return agents
}
