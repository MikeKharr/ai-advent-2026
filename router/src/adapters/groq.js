// Транспорт к GroqCloud: OpenAI-совместимый /openai/v1/chat/completions.
// Формы сверены с console.groq.com 2026-09-08.
//
// Диалект размышлений у Groq зависит от семейства модели, поэтому он описан
// в конфигурации провайдера, а не зашит здесь (ADR п. 3, поле `thinking` —
// «имена уровней в диалекте провайдера»):
//
//   thinking[уровень]  — значение `reasoning_effort`; `true` означает
//                        «уровень поддерживается, параметр не отправлять»
//                        (модели без размышлений, например классификатор).
//   reasoningControl   — как спрятать рассуждения из ответа:
//                        "format"  → reasoning_format: hidden (Qwen, MiniMax);
//                        "include" → include_reasoning: false (GPT-OSS).
//   reasoningFloorTokens — сколько токенов добавить к потолку выхода, когда
//                        уровень none отображён на реальное усилие: у GPT-OSS
//                        значения none нет вовсе, рассуждения неизбежны и
//                        съели бы весь бюджет ответа.
//
// Один ключ обслуживает любое число моделей: каждая модель — своя запись
// провайдера с тем же `secretEnv`, различаются `id` и `model`.

import { readJson } from './http.js'
import { readQuota } from './quota.js'

export async function call(
  {
    provider,
    model,
    prompt,
    system,
    schema,
    stop = [],
    tools = [],
    thinking,
    maxOutputTokens,
    temperature,
    signal,
  },
  { fetchImpl, env, now = Date.now },
) {
  // Возможность, которую роутер потребовал, обязана уйти в запрос. Серверных
  // инструментов у этого адаптера нет, поэтому падаем громко, а не отвечаем
  // из памяти модели.
  if (tools.length > 0)
    throw new Error(`groq: инструмент ${tools.join(', ')} не поддерживается адаптером`)

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const body = { model, messages, stream: false, max_completion_tokens: maxOutputTokens }
  if (temperature !== undefined) body.temperature = temperature
  if (stop.length > 0) body.stop = stop

  const effort = thinking.value
  if (typeof effort === 'string') {
    body.reasoning_effort = effort
    if (provider.reasoningControl === 'format') body.reasoning_format = 'hidden'
    if (provider.reasoningControl === 'include') body.include_reasoning = false
    // Уровень none, отображённый на реальное усилие: роутер бюджета на
    // размышления не заложил, добавляем объявленный провайдером.
    if (thinking.level === 'none') body.max_completion_tokens += provider.reasoningFloorTokens ?? 0
  }

  if (schema) {
    const json_schema = { name: 'response', schema }
    // Без strict Groq обещает схему «по возможности»: JSON вернётся, но может
    // не соответствовать схеме. Включается там, где модель это поддерживает.
    if (provider.strictSchema) json_schema.strict = true
    body.response_format = { type: 'json_schema', json_schema }
  }

  const response = await fetchImpl(`${provider.baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env[provider.secretEnv]}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  const quota = readQuota(response.headers, 'groq', now())
  const json = await readJson(response, 'groq', quota)
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
    quota,
    stopReason: choice.finish_reason === 'length' ? 'length' : (choice.finish_reason ?? 'stop'),
  }
}
