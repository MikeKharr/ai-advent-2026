// Инструмент единицы `mcptranslate`. Ключа не требует: MyMemory работает
// анонимно. Ни один аргумент не является URL, хостом или путём — хост зашит
// здесь, аргументы проверены в `args.js` до вызова.

import { ArgError, AUTODETECT, langCode, parser, translatable, TEXT_LIMIT } from './args.js'
import { getJson } from './net.js'

/** Хост — константа модуля. Аргументом он не приходит никогда. */
const MYMEMORY = 'https://api.mymemory.translated.net/get'

/**
 * Потолок ОТВЕТА поставщика. К `TEXT_LIMIT` отношения не имеет и второй его
 * копией не является: то — предел ввода (сколько мы вправе отправить), это —
 * граница правдоподобия для недоверенных данных. Вход не длиннее 500 знаков,
 * и перевод в четыре раза длиннее оригинала переводом уже не является.
 */
export const OUTPUT_LIMIT = TEXT_LIMIT * 4

/**
 * Ответ поставщика — НЕДОВЕРЕННЫЕ данные, и здесь это не формальность.
 * Прогон 2026-09-28 показал: при исчерпании квоты, при негодной паре языков
 * и при слишком длинном тексте MyMemory кладёт СВОЮ ЖЕ ошибку в поле
 * `translatedText` — «MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE
 * TRANSLATIONS FOR TODAY…». Отдай мы это поле не глядя — посетитель увидел
 * бы рекламное предупреждение поставщика вместо своего текста, а выжимка
 * построилась бы по нему. Поэтому текст берётся ТОЛЬКО при
 * `responseStatus === 200`, и только пройдя эту проверку.
 *
 * Это здешний аналог `safeUrl` из `mcpnews`: там негодная ссылка заменялась
 * собранной нами, здесь негодный перевод не подменяется ничем — возвращается
 * исходный текст с честным `translated: false`.
 */
function safeText(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
  if (cleaned.length === 0) return null
  // Длиннее потолка — не перевод. Пропускать нельзя: это уйдёт на экран.
  if (cleaned.length > OUTPUT_LIMIT) return null
  return cleaned
}

/** Определённый поставщиком язык — тоже недоверенные данные: тот же белый список. */
function safeLang(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[a-z]{2}(-[a-z]{2})?$/i.test(trimmed)) return null
  const [base, region] = trimmed.split('-')
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase()
}

/**
 * Перевод через MyMemory.
 *
 * Установлено прогоном 2026-09-28 (подробности — README, «Поведение
 * поставщика»), и от этого зависит весь разбор ниже:
 *   1) исчерпание суточной квоты — HTTP 429 и `responseStatus: 429`;
 *   2) прочие отказы поставщика (негодная пара, длинный текст) приходят
 *      с HTTP 200 и `responseStatus: "403"` СТРОКОЙ — отсюда `String()`
 *      при сверке: сверять `=== 200` числом значило бы принять отказ за
 *      успех;
 *   3) `Autodetect` в паре языков работает и добавляет `detectedLanguage`.
 *
 * Поэтому неудача перевода — НЕ `isError`, а обычный результат с
 * `translated: false` и причиной. Так цепочка идёт дальше на исходном
 * тексте, а посетитель видит разное: «квота поставщика на сегодня кончилась»
 * и «перевод не вышел» — это разные новости. `isError` остаётся за негодным
 * аргументом: там ошибся вызывающий, и поправить её должен он.
 */
async function textTranslate({ text, from, to }, { fetchImpl }) {
  // Обе части пары прошли белый список `langCode`, поэтому `|` здесь свой, а
  // не пришедший из аргумента. Уходит он сырым — ровно так, как проверено
  // прогоном (принимает ли поставщик `%7C`, не установлено, и гадать незачем).
  const url = `${MYMEMORY}?q=${encodeURIComponent(text)}&langpair=${from}|${to}`

  const asked = from === AUTODETECT ? null : from
  const failed = (reason) => ({ text, from: asked, to, detected: false, translated: false, chars: text.length, reason })

  let data
  try {
    data = await getJson(url, { fetchImpl })
  } catch (error) {
    // Квоту отличаем от прочего по коду — иначе посетителю нечего сказать.
    return failed(error?.status === 429 ? 'quota_exhausted' : 'provider_unavailable')
  }

  const status = String(data?.responseStatus ?? '')
  if (status !== '200') {
    return failed(status === '429' ? 'quota_exhausted' : 'provider_refused')
  }

  const translated = safeText(data?.responseData?.translatedText)
  if (!translated) return failed('unusable_translation')

  const detectedLang = safeLang(data?.responseData?.detectedLanguage)
  const actualFrom = asked ?? detectedLang

  return {
    text: translated,
    from: actualFrom,
    to,
    detected: asked === null && detectedLang !== null,
    translated: true,
    chars: text.length,
  }
}

/**
 * Определения инструментов. Порядок фиксирован: `tools/list` обязан быть
 * детерминирован, иначе тест на него ничего не значит.
 */
export function buildTools({ fetchImpl = fetch } = {}) {
  return [
    {
      name: 'text.translate',
      title: 'Перевод текста',
      description:
        'Переводит текст с языка на язык через MyMemory (без ключа). Язык источника можно не указывать — он определится сам. ' +
        `Предел — ${TEXT_LIMIT} знаков за вызов; текст длиннее отвергается, а не режется. ` +
        'Ответ всегда несёт признак translated: при false в text лежит ИСХОДНЫЙ текст, а причина — в reason.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            // Потолок один на единицу — константа `TEXT_LIMIT`. Второго
            // числа здесь нет намеренно: схема и проверка обязаны меняться
            // вместе, иначе повторится находка `mcpstore`.
            maxLength: TEXT_LIMIT,
            description: `Текст на перевод, до ${TEXT_LIMIT} знаков. Не адрес и не имя хоста.`,
          },
          to: {
            type: 'string',
            description: 'Куда переводить: код языка из двух букв, например en, ru, de. Допустим вид zh-CN.',
          },
          from: {
            type: 'string',
            description: `Язык источника тем же кодом. Можно не указывать или передать ${AUTODETECT} — тогда язык определит поставщик.`,
          },
        },
        required: ['text', 'to'],
        additionalProperties: false,
      },
      parse: parser((args) => {
        const value = {
          text: translatable(args.text, { what: 'text' }),
          to: langCode(args.to, { what: 'to' }),
          from: langCode(args.from, { what: 'from', allowAuto: true }),
        }
        if (value.from !== AUTODETECT && value.from === value.to) {
          throw new ArgError('from и to совпадают: переводить не во что')
        }
        return value
      }),
      run: (value) => textTranslate(value, { fetchImpl }),
    },
  ]
}
