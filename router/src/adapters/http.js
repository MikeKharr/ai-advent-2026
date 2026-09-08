/**
 * Разбор ответа провайдера: сначала статус, потом тело. Тело у 429 или 502
 * бывает HTML от прокси — оно не должно превращаться в SyntaxError и терять
 * статус, иначе 429 попадёт в предохранитель вопреки ADR §7.
 */
export async function readJson(response, who) {
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail =
      json?.error?.type ??
      json?.error ??
      (raw ? raw.slice(0, 80) : "пустое тело");
    const error = new Error(`${who} ${response.status}: ${detail}`);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs(response);
    throw error;
  }
  if (json === null || typeof json !== "object")
    throw new Error(`${who}: тело ответа не JSON`);
  return json;
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
