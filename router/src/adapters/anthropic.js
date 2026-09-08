// Транспорт к Messages API. Адаптер знает только форму запроса и ответа
// провайдера и возвращает нормализованный результат; выбор, дедлайны и
// здоровье — дело роутера. Формы сверены с platform.claude.com 2026-09-08:
// структурированный вывод — `output_config.format` без beta-заголовка,
// поиск — серверный инструмент `web_search_20250305`.

import { readJson } from "./http.js";

const API_VERSION = "2023-06-01";
const WEB_SEARCH_MAX_USES = 3;

export async function call(
  {
    provider,
    model,
    prompt,
    system,
    schema,
    tools = [],
    thinking,
    answerTokens,
    maxOutputTokens,
    temperature,
    signal,
  },
  { fetchImpl, env },
) {
  const body = { model, messages: [{ role: "user", content: prompt }] };
  if (system) body.system = system;
  let maxTokens = maxOutputTokens;
  if (thinking.level !== "none") {
    // Модели до 4.6 принимают только явный бюджет; он берётся из конфигурации
    // провайдера, а max_tokens обязан его превышать.
    const budget = thinking.value;
    body.thinking = { type: "enabled", budget_tokens: budget };
    maxTokens = Math.max(maxOutputTokens, answerTokens + budget);
  } else if (temperature !== undefined) {
    // С включёнными размышлениями API не принимает temperature.
    body.temperature = temperature;
  }
  body.max_tokens = maxTokens;
  if (schema) body.output_config = { format: { type: "json_schema", schema } };
  // Возможность, которую роутер потребовал от провайдера, должна реально
  // уйти в запрос — иначе класс rank_news получит ответ из памяти модели.
  if (tools.includes("web_search"))
    body.tools = [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: WEB_SEARCH_MAX_USES,
      },
    ];

  const response = await fetchImpl(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env[provider.secretEnv],
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  });

  const json = await readJson(response, `anthropic`);

  const text = (json.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
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
    stopReason:
      json.stop_reason === "max_tokens"
        ? "length"
        : (json.stop_reason ?? "stop"),
  };
}
