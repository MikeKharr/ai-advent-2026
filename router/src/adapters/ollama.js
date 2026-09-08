// Транспорт к Ollama через родной API (/api/generate), а не через слой
// совместимости с OpenAI: только родной отдаёт метрики (load_duration,
// eval_count…) и принимает `think` (ADR 2026-09-08-1748, п. 8).

import { readJson } from "./http.js";

const NS_PER_MS = 1_000_000;

export async function call(
  {
    provider,
    model,
    prompt,
    system,
    schema,
    thinking,
    maxOutputTokens,
    temperature,
    signal,
  },
  { fetchImpl },
) {
  const body = {
    model,
    prompt,
    stream: false,
    // Бюджет размышлений входит в num_predict: модель не получает
    // «бесплатных» токенов сверх дедлайна.
    options: { num_predict: maxOutputTokens },
  };
  if (system) body.system = system;
  if (temperature !== undefined) body.options.temperature = temperature;
  // Значение `think` берётся из конфигурации провайдера: у qwen3 это
  // булево, у gpt-oss — строка low|medium|high. Роутер этого не знает.
  body.think = thinking.level === "none" ? false : thinking.value;
  if (schema) body.format = schema;
  if (provider.keepAlive) body.keep_alive = provider.keepAlive;

  const response = await fetchImpl(`${provider.baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const json = await readJson(response, "ollama");

  const evalMs = (json.eval_duration ?? 0) / NS_PER_MS;
  const outputTokens = json.eval_count ?? 0;
  return {
    text: json.response ?? "",
    usage: {
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens,
      webSearches: 0,
    },
    metrics: {
      loadMs: Math.round((json.load_duration ?? 0) / NS_PER_MS),
      promptEvalMs: Math.round((json.prompt_eval_duration ?? 0) / NS_PER_MS),
      evalMs: Math.round(evalMs),
      tokPerSec:
        evalMs > 0
          ? Math.round((outputTokens / evalMs) * 1000 * 10) / 10
          : null,
    },
    stopReason: json.done_reason ?? "stop",
  };
}
