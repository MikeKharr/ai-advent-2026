// Формы ответов провайдеров — как их отдают реальные API, а не как удобно
// тестам. Anthropic Messages API и родной /api/generate Ollama.

export function anthropicMessage({
  text = 'ответ',
  stop = 'end_turn',
  input = 120,
  output = 40,
} = {}) {
  return {
    id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: text === '' ? [] : [{ type: 'text', text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  }
}

export function ollamaGenerate({ text = 'ответ', done = 'stop', input = 120, output = 40 } = {}) {
  return {
    model: 'qwen3.8:27b',
    created_at: '2026-09-08T10:00:00.000Z',
    response: text,
    done: true,
    done_reason: done,
    total_duration: 12_345_678_901,
    load_duration: 9_876_543_210,
    prompt_eval_count: input,
    prompt_eval_duration: 600_000_000,
    eval_count: output,
    eval_duration: 6_250_000_000,
  }
}

export const PROVIDERS = [
  {
    id: 'mac-qwen3',
    revision: 1,
    kind: 'ollama',
    tier: 'self-hosted',
    baseUrl: 'http://laptop.test:11434',
    model: 'qwen3.8:27b',
    profile: 'laptop',
    capabilities: ['json_schema'],
    contextWindow: 131072,
    jurisdiction: 'local',
    dataClasses: ['public', 'internal', 'personal'],
    maxConcurrency: 1,
    thinking: { none: true, low: true, medium: true, high: true },
    price: { inputPerMTok: 0, outputPerMTok: 0 },
  },
  {
    id: 'anthropic-haiku',
    revision: 1,
    kind: 'anthropic',
    tier: 'cloud-frontier',
    baseUrl: 'https://api.anthropic.test',
    model: 'claude-haiku-4-5',
    profile: 'cloud',
    capabilities: ['json_schema', 'web_search', 'tools'],
    contextWindow: 200000,
    jurisdiction: 'us',
    dataClasses: ['public'],
    maxConcurrency: 8,
    thinking: { none: true, low: 1024, medium: 4096, high: 16384 },
    secretEnv: 'ANTHROPIC_API_KEY',
    price: { inputPerMTok: 1, outputPerMTok: 5 },
  },
]

export const ENV = {
  ANTHROPIC_API_KEY: 'sk-test',
  ROUTER_ADMIN_KEY: 'admin-test',
  APP_KEY_SMOKE: 'app-smoke',
}

/** Ответ на HTTP-уровне, как его видит адаптер через fetch. */
export function httpJson(status, json, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => json,
  }
}

/**
 * fetch по сценарию: `byHost` — функция или список ответов на хост.
 * Транспортная ошибка — как у undici: TypeError('fetch failed') с cause.code.
 */
export function scriptedFetch(byHost, { calls = [] } = {}) {
  return async (url, options) => {
    const host = new URL(url).host
    const body = JSON.parse(options.body)
    calls.push({ host, body, url })
    const handler = byHost[host]
    if (!handler) throw unreachable('ENOTFOUND')
    const step =
      typeof handler === 'function'
        ? handler
        : handler.shift
          ? () => {
              const next = handler.shift()
              if (!next) throw new Error(`сценарий для ${host} исчерпан`)
              return next
            }
          : () => handler
    const out = await step(body, options)
    if (out instanceof Error) throw out
    return out
  }
}

export function unreachable(code) {
  const error = new TypeError('fetch failed')
  error.cause = Object.assign(new Error(code), { code })
  return error
}
