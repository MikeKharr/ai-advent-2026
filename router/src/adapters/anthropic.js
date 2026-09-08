// Транспорт к Messages API. Адаптер знает только форму запроса и ответа
// провайдера и возвращает нормализованный результат; выбор, дедлайны и
// здоровье — дело роутера.

const API_VERSION = '2023-06-01'

export async function call(
  {
    provider,
    model,
    prompt,
    system,
    schema,
    thinking,
    answerTokens,
    maxOutputTokens,
    temperature,
    signal,
  },
  { fetchImpl, env },
) {
  const body = { model, messages: [{ role: 'user', content: prompt }] }
  if (system) body.system = system
  let maxTokens = maxOutputTokens
  if (thinking.level !== 'none') {
    // Модели до 4.6 принимают только явный бюджет; он берётся из конфигурации
    // провайдера, а max_tokens обязан его превышать.
    const budget = thinking.value
    body.thinking = { type: 'enabled', budget_tokens: budget }
    maxTokens = Math.max(maxOutputTokens, answerTokens + budget)
  } else if (temperature !== undefined) {
    // С включёнными размышлениями API не принимает temperature.
    body.temperature = temperature
  }
  body.max_tokens = maxTokens
  if (schema) body.output_config = { format: { type: 'json_schema', schema } }

  const response = await fetchImpl(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env[provider.secretEnv],
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  })

  const json = await response.json()
  if (!response.ok) {
    const error = new Error(`anthropic ${response.status}: ${json?.error?.type ?? 'unknown'}`)
    error.status = response.status
    error.retryAfterMs = retryAfterMs(response)
    throw error
  }

  const text = (json.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

  return {
    text,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
    metrics: { loadMs: null, promptEvalMs: null, evalMs: null, tokPerSec: null },
    stopReason: json.stop_reason === 'max_tokens' ? 'length' : (json.stop_reason ?? 'stop'),
  }
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}
