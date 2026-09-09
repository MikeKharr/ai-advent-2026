// Общие заготовки: окружение, реестр, статьи и поддельный роутер.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from '../src/env.js'
import { loadRegistry } from '../src/registry.js'

const here = dirname(fileURLToPath(import.meta.url))

export const ENV = parseEnv({
  AGENT_KEY: 'agent-key',
  ROUTER_APP_KEY: 'app-agents',
  ROUTER_URL: 'http://router.test:8081',
  STORE_FILE: '',
}).env

export const REGISTRY = loadRegistry(
  JSON.parse(readFileSync(join(here, '..', 'config', 'agents.json'), 'utf8')),
)
export const NEWS = REGISTRY.get('news-analyst')

export const ITEMS = [
  {
    url: 'https://techcrunch.com/a',
    title: 'Fintech raises 20M',
    source: 'TechCrunch',
    region: 'США',
    date: '2026-09-09T10:00:00.000Z',
    text: 'полный текст статьи про финтех',
  },
  {
    url: 'https://inc42.com/b',
    title: 'India payments',
    source: 'Inc42',
    region: 'Индия',
    date: '2026-09-08T10:00:00.000Z',
    textOmitted: true,
    summary: 'анонс',
  },
]

/** Архив-заглушка: отдаёт заданные статьи, помнит аргументы вызова. */
export function fakeArchive({ items = ITEMS, refresh, total } = {}) {
  const calls = []
  return {
    name: 'archive',
    calls,
    describe: () => ({ name: 'archive', description: 'заглушка', args: [] }),
    state: () => ({
      total: total ?? items.length,
      capacity: 1000,
      quota: 125,
      bySource: {},
      lastRefresh: null,
      refreshEveryMinutes: 15,
      sources: [],
    }),
    all: () => items,
    size: () => total ?? items.length,
    skippedOnLoad: () => 0,
    async run(args) {
      calls.push(args)
      return {
        refresh: refresh ?? {
          attempted: false,
          refreshed: false,
          added: 0,
          dropped: 0,
          failed: [],
        },
        total: total ?? items.length,
        items,
        matched: items.length,
      }
    },
  }
}

export const ROUTER_MODELS = {
  taskClass: 'news_answer',
  providers: [
    { id: 'anthropic-haiku', model: 'claude-haiku-4-5', maxRequestTokens: 200_000, quota: null },
    {
      id: 'groq-qwen3.6-27b',
      model: 'qwen/qwen3.6-27b',
      maxRequestTokens: 5000,
      quota: { limitTokens: 7000, remainingTokens: 1500, resetAt: null, stale: false },
    },
  ],
}

export const ROUTER_ANSWER = {
  ok: true,
  text: 'Ответ модели: https://techcrunch.com/a и https://evil.example/x',
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 900,
  usage: { inputTokens: 500, outputTokens: 40 },
}

/**
 * fetch, отвечающий как роутер: `/v1/models` и `/v1/route`. Записывает
 * отправленные тела и позволяет подменить ответ вызова.
 */
export function fakeRouter({ models = ROUTER_MODELS, route = ROUTER_ANSWER, status = 200 } = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    const u = String(url)
    if (u.includes('/v1/models')) {
      return { ok: true, status: 200, json: async () => models }
    }
    if (u.includes('/v1/route')) {
      calls.push({ url: u, headers: options.headers, body: JSON.parse(options.body) })
      if (route instanceof Error) throw route
      return { ok: status >= 200 && status < 300, status, json: async () => route }
    }
    throw new Error(`неожиданный адрес ${u}`)
  }
  impl.calls = calls
  return impl
}
