// Три инструмента единицы `mcpstore` (ADR 2026-09-28-0736, п. 3). Сети у
// единицы нет вовсе: наружу она не ходит ни разу, `fetch` здесь не вызывается.
// Единственное состояние — SQLite на именованном томе (`src/store.js`).

import { ArgError, parser } from './args.js'
import { MAX_FILE_BYTES } from './store.js'

/**
 * Здесь — только тип и обрезка пробелов. Годность имени проверяет ОДНА
 * строка — `validName` в `store.js`, у самой записи. Вторая копия проверки
 * стояла здесь и снята намеренно: при двух копиях мутация «убрать проверку»
 * оставляла прогон зелёным (проверено прогоном M5), то есть у правила не
 * было держателя — это ровно то, что запрещает I-14.
 */
function name(value) {
  if (typeof value !== 'string') throw new ArgError('name: ожидалась строка')
  return value.trim()
}

function content(value) {
  if (typeof value !== 'string') throw new ArgError('content: ожидалась строка')
  if (Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
    throw new ArgError(`content: больше ${MAX_FILE_BYTES} байт`)
  }
  return value
}

/** Порядок фиксирован: `tools/list` обязан быть детерминирован. */
export function buildTools({ store }) {
  return [
    {
      name: 'file.save',
      title: 'Сохранить файл',
      description:
        'Кладёт текст под именем в хранилище на 30 часов. До 64 КБ на файл и 200 файлов. Возвращает sha256 сохранённого.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 64, description: 'Имя файла: буквы, цифры, точка, дефис, подчёркивание.' },
          content: { type: 'string', maxLength: MAX_FILE_BYTES, description: 'Текст файла, до 64 КБ.' },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
      parse: parser((args) => ({ name: name(args.name), content: content(args.content) })),
      run: (value) => store.save(value.name, value.content),
    },
    {
      name: 'file.read',
      title: 'Прочитать файл',
      description: 'Возвращает текст файла и его sha256. Отсутствие файла — не ошибка: в ответе found: false.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', maxLength: 64 } },
        required: ['name'],
        additionalProperties: false,
      },
      parse: parser((args) => ({ name: name(args.name) })),
      run: (value) => store.read(value.name),
    },
    {
      name: 'file.list',
      title: 'Список файлов',
      description: 'Имена, размеры, sha256 и сроки всех живых файлов по возрастанию имени. Содержимого не возвращает.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      parse: parser(() => ({})),
      run: () => store.list(),
    },
  ]
}
