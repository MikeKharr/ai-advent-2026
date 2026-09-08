// Транспорт к GroqCloud: OpenAI-совместимый /openai/v1/chat/completions.
// Формы сверены с console.groq.com 2026-09-08: ключ в заголовке
// Authorization, потолок выхода — `max_completion_tokens` (не `max_tokens`),
// схема — `response_format.json_schema` с обязательным `name`,
// уровень размышлений — `reasoning_effort`.
//
// Один ключ обслуживает любое число моделей: каждая модель — своя запись
// провайдера с тем же `secretEnv`, различаются `id` и `model`.

import { readJson } from './http.js'

export async function call(
  { provider, model, prompt, system, schema, thinking, maxOutputTokens, temperature, signal },
  { fetchImpl, env },
) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const body = { model, messages, stream: false, max_completion_tokens: maxOutputTokens }
  if (temperature !== undefined) body.temperature = temperature
  // `reasoning_effort` принимают не все модели, поэтому при уровне none
  // параметр не отправляется вовсе — иначе классификатор ответит 400.
  if (thinking.level !== 'none') body.reasoning_effort = thinking.value
  if (schema)
    body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema } }

  const response = await fetchImpl(`${provider.baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env[provider.secretEnv]}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  const json = await readJson(response, 'groq')
  const choice = json.choices?.[0] ?? {}
  const usage = json.usage ?? {}
  const completionSec = usage.completion_time ?? 0

  return {
    text: choice.message?.content ?? '',
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      webSearches: 0,
    },
    metrics: {
      // Очередь у Groq — то же по смыслу, что загрузка модели у Ollama:
      // время до начала счёта, не зависящее от длины ответа.
      loadMs: Math.round((usage.queue_time ?? 0) * 1000),
      promptEvalMs: Math.round((usage.prompt_time ?? 0) * 1000),
      evalMs: Math.round(completionSec * 1000),
      tokPerSec:
        completionSec > 0
          ? Math.round(((usage.completion_tokens ?? 0) / completionSec) * 10) / 10
          : null,
    },
    stopReason: choice.finish_reason === 'length' ? 'length' : (choice.finish_reason ?? 'stop'),
  }
}
