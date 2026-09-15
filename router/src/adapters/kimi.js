// Транспорт к Moonshot AI (Kimi): OpenAI-совместимый /v1/chat/completions.
// Формы сверены с platform.kimi.ai 2026-09-15 (ADR 2026-09-15-1448, п. 1).
//
// Отдельный адаптер, а не ветка в Groq: путь без префикса /openai, другой
// диалект рассуждений, запрет температуры, другой состав usage.
//
// Диалект рассуждений описан в конфигурации провайдера (`thinking[уровень]`),
// потому что у моделей Kimi он разный:
//
//   "none"      → thinking: {type: "disabled"} — выключить (k2.6);
//   "enabled"   → ничего не слать: рассуждения у модели неотключаемы (k2.7);
//   "low"|"high"→ reasoning_effort (k3);
//   true        → уровень есть, параметр не отправлять.
//
// Температура не отправляется никогда: у всех четырёх моделей она
// фиксирована или «не менять», и запрос с ней получил бы 400 вместо ответа.
// `n` не отправляется — он фиксирован в 1.
//
// Один ключ обслуживает все модели: каждая — своя запись провайдера с тем
// же `secretEnv`, различаются `id` и `model`.

import { readJson } from './http.js'
import { readQuota } from './quota.js'

export async function call(
  { provider, model, prompt, system, schema, stop = [], tools = [], thinking, maxOutputTokens, signal },
  { fetchImpl, env, now = Date.now },
) {
  // Возможность, которую роутер потребовал, обязана уйти в запрос. Ни
  // серверных инструментов, ни схемы этот адаптер не умеет, поэтому падаем
  // громко, а не отвечаем из памяти модели.
  if (tools.length > 0)
    throw new Error(`kimi: инструмент ${tools.join(', ')} не поддерживается адаптером`)
  if (schema) throw new Error('kimi: структурированный вывод не поддерживается адаптером')

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  // max_tokens у Kimi устарел — потолок выхода называется max_completion_tokens.
  const body = { model, messages, stream: false, max_completion_tokens: maxOutputTokens }
  if (stop.length > 0) body.stop = stop

  const effort = thinking.value
  if (effort === 'none') body.thinking = { type: 'disabled' }
  else if (typeof effort === 'string' && effort !== 'enabled') body.reasoning_effort = effort
  // Уровень none, отображённый на реальное усилие (у k3 и k2.7 рассуждения не
  // выключаются): роутер бюджета на них не заложил, добавляем объявленный.
  if (thinking.level === 'none' && typeof effort === 'string' && effort !== 'none')
    body.max_completion_tokens += provider.reasoningFloorTokens ?? 0

  const response = await fetchImpl(`${provider.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env[provider.secretEnv]}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  // Заголовков остатка квоты документация Kimi не описывает: ожидаем null,
  // но читаем — если они появятся, роутер начнёт их учитывать сам.
  const quota = readQuota(response.headers, 'kimi', now())
  const json = await readJson(response, 'kimi', quota)
  const choice = json.choices?.[0] ?? {}
  const usage = json.usage ?? {}

  return {
    // Рассуждения приходят отдельным полем reasoning_content и в ответ не идут.
    text: choice.message?.content ?? '',
    usage: {
      // Учёт по ставке промаха кэша: cached_tokens намеренно не вычитается.
      // Журнал может завысить расход, но никогда не занизит (ADR, п. 5).
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      webSearches: 0,
    },
    // Времени выполнения в usage у Kimi нет.
    metrics: { loadMs: null, promptEvalMs: null, evalMs: null, tokPerSec: null },
    quota,
    stopReason: choice.finish_reason === 'length' ? 'length' : (choice.finish_reason ?? 'stop'),
  }
}
