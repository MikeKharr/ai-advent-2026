// Транспорт к Messages API. Адаптер знает только форму запроса и ответа
// провайдера и возвращает нормализованный результат; выбор, дедлайны и
// здоровье — дело роутера. Формы сверены с platform.claude.com 2026-09-08:
// структурированный вывод — `output_config.format` без beta-заголовка,
// поиск — серверный инструмент `web_search_20250305`.
// Формы блоков `tool_use`/`tool_result` и определения инструментов
// (`name`/`description`/`input_schema`) сверены с документацией Anthropic
// 2026-09-28: ответ несёт `content[]` с блоками `{type: 'tool_use', id,
// name, input}` и `stop_reason: 'tool_use'`, результат возвращается блоком
// `{type: 'tool_result', tool_use_id, content}` в сообщении роли `user`.

import { readJson } from './http.js'
import { readQuota } from './quota.js'

const API_VERSION = '2023-06-01'
const WEB_SEARCH_MAX_USES = 3

export async function call(
  {
    provider,
    model,
    prompt,
    messages,
    system,
    schema,
    stop = [],
    tools = [],
    toolDefs = [],
    thinking,
    answerTokens,
    maxOutputTokens,
    temperature,
    signal,
  },
  { fetchImpl, env, now = Date.now },
) {
  // Диалог вызывающего уходит провайдеру как есть: блоки `tool_use` и
  // `tool_result` внутри `content` — часть контракта Messages API, склеивать
  // их в текст нельзя. Прежняя форма (одна строка `prompt`) сохранена для
  // вызывающих без `messages`.
  const body = {
    model,
    messages: messages ?? [{ role: 'user', content: prompt }],
  }
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
  if (stop.length > 0) body.stop_sequences = stop
  if (schema) body.output_config = { format: { type: 'json_schema', schema } }
  // Возможность, которую роутер потребовал от провайдера, должна реально
  // уйти в запрос — иначе класс rank_news получит ответ из памяти модели.
  const requestTools = []
  if (tools.includes('web_search'))
    requestTools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES,
    })
  // Инструменты вызывающего — обычные пользовательские определения: исполняет
  // их вызывающий, провайдер только называет имя и вход.
  for (const t of toolDefs)
    requestTools.push({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })
  if (requestTools.length > 0) body.tools = requestTools

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

  // Остаток квоты приходит в заголовках каждого ответа — и успешного,
  // и отказного. Роутер запоминает его, чтобы не звать впустую.
  const quota = readQuota(response.headers, 'anthropic', now())
  const json = await readJson(response, 'anthropic', quota)

  const content = json.content ?? []
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

  return {
    text,
    // Блоки ответа отдаются вызывающему как пришли: `tool_use` он обязан
    // видеть блоком, а не строкой.
    content,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      webSearches: json.usage?.server_tool_use?.web_search_requests ?? 0,
    },
    metrics: {
      loadMs: null,
      promptEvalMs: null,
      evalMs: null,
      tokPerSec: null,
    },
    quota,
    stopReason: json.stop_reason === 'max_tokens' ? 'length' : (json.stop_reason ?? 'stop'),
  }
}
