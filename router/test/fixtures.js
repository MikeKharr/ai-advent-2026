// Формы ответов провайдеров — как их отдают реальные API, а не как удобно
// тестам: Anthropic Messages API, родной /api/generate Ollama и
// OpenAI-совместимый /openai/v1/chat/completions Groq.

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

export function groqCompletion({
  text = 'ответ',
  finish = 'stop',
  input = 120,
  output = 40,
  model = 'meta-llama/llama-prompt-guard-2-22m',
} = {}) {
  return {
    id: 'chatcmpl-3f6a2b1c',
    object: 'chat.completion',
    created: 1_788_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        logprobs: null,
        finish_reason: finish,
      },
    ],
    usage: {
      queue_time: 0.021,
      prompt_tokens: input,
      prompt_time: 0.008,
      completion_tokens: output,
      completion_time: 0.16,
      total_tokens: input + output,
      total_time: 0.168,
    },
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
    capabilities: ['text_generation', 'json_schema'],
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
    capabilities: ['text_generation', 'json_schema', 'web_search', 'tools'],
    contextWindow: 200000,
    jurisdiction: 'us',
    dataClasses: ['public'],
    maxConcurrency: 8,
    thinking: { none: true, low: 1024, medium: 4096, high: 16384 },
    secretEnv: 'ANTHROPIC_API_KEY',
    price: { inputPerMTok: 1, outputPerMTok: 5, perWebSearch: 0.01 },
  },
  {
    id: 'groq-prompt-guard',
    revision: 1,
    kind: 'groq',
    tier: 'cloud-cheap',
    baseUrl: 'https://api.groq.test',
    model: 'meta-llama/llama-prompt-guard-2-22m',
    profile: 'cloud',
    capabilities: ['prompt_guard'],
    contextWindow: 512,
    jurisdiction: 'us',
    dataClasses: ['public'],
    maxConcurrency: 4,
    thinking: { none: true },
    secretEnv: 'GROQ_API_KEY',
    price: { inputPerMTok: 0.03, outputPerMTok: 0.03 },
  },
]

/** Вторая модель Groq на том же ключе — генеративная. */
export const GROQ_CHAT = {
  id: 'groq-gpt-oss-20b',
  revision: 1,
  kind: 'groq',
  tier: 'cloud-cheap',
  baseUrl: 'https://api.groq.test',
  model: 'openai/gpt-oss-20b',
  profile: 'cloud',
  capabilities: ['text_generation', 'json_schema'],
  contextWindow: 131072,
  jurisdiction: 'us',
  dataClasses: ['public'],
  maxConcurrency: 4,
  thinking: { none: true, low: 'low', medium: 'medium', high: 'high' },
  secretEnv: 'GROQ_API_KEY',
  price: { inputPerMTok: 0.075, outputPerMTok: 0.3 },
}

export const ENV = {
  ANTHROPIC_API_KEY: 'sk-test',
  GROQ_API_KEY: 'gsk-test',
  ROUTER_ADMIN_KEY: 'admin-test',
  APP_KEY_SMOKE: 'app-smoke',
}

/** Ответ на HTTP-уровне, как его видит адаптер через fetch. */
export function httpJson(status, json, headers = {}) {
  return httpText(status, JSON.stringify(json), headers)
}

export function httpText(status, text, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text,
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
    calls.push({ host, body, url, headers: options.headers })
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
    // Как настоящий fetch: прерывание по сигналу отклоняет промис.
    const aborted = new Promise((_, reject) => {
      const fail = () =>
        reject(
          Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          }),
        )
      if (options.signal?.aborted) fail()
      else options.signal?.addEventListener('abort', fail, { once: true })
    })
    const out = await Promise.race([step(body, options), aborted])
    if (out instanceof Error) throw out
    return out
  }
}

export function unreachable(code) {
  const error = new TypeError('fetch failed')
  error.cause = Object.assign(new Error(code), { code })
  return error
}
