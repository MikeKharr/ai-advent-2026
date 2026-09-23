// Три инструмента дня 16 (ADR 2026-09-23-1227, п. 6). Ключей не требует ни
// один. Ни один аргумент не является URL, хостом или путём: хосты зашиты
// здесь, аргументы — строки с пределом длины и запретом на адресные символы.
// Это условие вето `compliance`, а не вкус: фильтр адресов писать руками
// спецификация прямо не советует, SSRF закрывается построением.

import { z } from 'zod'
import { getJson } from './net.js'

/** Хосты — константы модуля. Ни один из них не приходит аргументом. */
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const WIKI_HOST = 'https://ru.wikipedia.org'

/**
 * Символы, из которых строят адрес: схема, путь, запрос, якорь, учётные
 * данные. Аргумент с любым из них отвергается схемой — до вызова инструмента.
 */
const ADDRESS_LIKE = /[:/\\?#@]/

const plainArg = (max, what) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !ADDRESS_LIKE.test(value), {
      message: `${what}: это название, а не адрес — символы : / \\ ? # @ не принимаются`,
    })

/** Строка из ответа поставщика: обрезается, прежде чем попасть в наш JSON. */
const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)

function coordinate(value, limit) {
  const n = Number(value)
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new Error('поставщик вернул негодные координаты')
  return n.toFixed(4)
}

async function clockNow(_args, { now }) {
  const at = new Date(now())
  return { iso: at.toISOString(), epochMs: at.getTime(), timezone: 'UTC' }
}

async function weatherCurrent({ city }, { fetchImpl }) {
  const geo = await getJson(
    `${GEOCODING}?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`,
    { fetchImpl },
  )
  const place = Array.isArray(geo?.results) ? geo.results[0] : null
  if (!place) return { found: false, city: cut(city, 80) }

  // Координаты пришли от поставщика — в адрес они идут только после
  // проверки числом: строка отсюда иначе дописала бы свой параметр.
  const latitude = coordinate(place.latitude, 90)
  const longitude = coordinate(place.longitude, 180)

  const forecast = await getJson(
    `${FORECAST}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m`,
    { fetchImpl },
  )
  const current = forecast?.current ?? {}
  return {
    found: true,
    place: { name: cut(place.name, 120), country: cut(place.country, 120), latitude, longitude },
    observedAt: cut(current.time, 40),
    temperatureC: Number.isFinite(Number(current.temperature_2m)) ? Number(current.temperature_2m) : null,
    windKmh: Number.isFinite(Number(current.wind_speed_10m)) ? Number(current.wind_speed_10m) : null,
  }
}

async function wikiSummary({ title }, { fetchImpl }) {
  const data = await getJson(`${WIKI_HOST}/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
    fetchImpl,
  })
  const canonical = cut(data?.titles?.canonical, 200)
  return {
    title: cut(data?.title, 200),
    extract: cut(data?.extract, 1500),
    // Ссылку собираем сами из зашитого хоста: адрес из ответа поставщика
    // наружу не переносится даже проверенным.
    url: canonical ? `${WIKI_HOST}/wiki/${encodeURIComponent(canonical)}` : null,
    lang: 'ru',
  }
}

/**
 * Определения инструментов. Порядок фиксирован: `tools/list` обязан быть
 * детерминирован, иначе тест на него ничего не значит.
 */
export const TOOLS = [
  {
    name: 'clock.now',
    config: {
      title: 'Текущее время',
      description: 'Время сервера в UTC. Сети не требует — это контроль механизма: отличает «MCP не работает» от «интернет не работает».',
      inputSchema: {},
    },
    run: clockNow,
  },
  {
    name: 'weather.current',
    config: {
      title: 'Погода сейчас',
      description: 'Температура и ветер в городе по данным Open-Meteo. Аргумент — название города, не адрес.',
      inputSchema: { city: plainArg(80, 'city') },
    },
    run: weatherCurrent,
  },
  {
    name: 'wiki.summary',
    config: {
      title: 'Выдержка из Википедии',
      description: 'Заголовок, выдержка и ссылка на статью русской Википедии. Аргумент — название статьи, не адрес.',
      inputSchema: { title: plainArg(200, 'title') },
    },
    run: wikiSummary,
  },
]

/**
 * Регистрация на сервере MCP. Ответ инструмента — наш собранный JSON:
 * сырой текст поставщика наружу не уходит.
 */
export function registerTools(server, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, async (args) => {
      try {
        const result = await tool.run(args ?? {}, { fetchImpl, now })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: String(error?.message ?? 'сбой инструмента') }) }],
        }
      }
    })
  }
}
