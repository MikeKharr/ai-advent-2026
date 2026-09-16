// Чтение книги расхода и метрик роутера изнутри контейнера прода
// (ADR 2026-09-16-0907). Ключ администратора берётся только из окружения
// процесса: в командной строке его нет и быть не может.
//
// Закрытое множество аргументов заперто здесь, а не только в списке
// разрешённых команд: скрипт обязан быть безопасным при вызове чем угодно.
// Единственный метод — GET; путь берётся из таблицы по ключу, поэтому
// строка запроса не содержит ни байта из argv.

import { readFileSync } from 'node:fs'

const PATHS = { spend: '/v1/spend', metrics: '/v1/metrics' }

// Имя переменной — из конфигурации, как его читает service.js.
const apps = JSON.parse(readFileSync(new URL('./config/apps.json', import.meta.url), 'utf8'))
const secretEnv = apps.admin.secretEnv

// Object.hasOwn, а не `in`: `constructor` и прочее из прототипа не проходит.
if (process.argv.length !== 3 || !Object.hasOwn(PATHS, process.argv[2])) {
  process.stderr.write('Использование: node admin.js spend|metrics\n')
  process.exit(2)
}

const value = process.env[secretEnv]
if (!value) {
  // Единственное место, где печатается имя переменной, — здесь.
  process.stderr.write(`${secretEnv} не задан\n`)
  process.exit(2)
}

// Утечка живёт в диагностике, а не в штатном выводе: через scrub идёт каждая
// запись и в stdout, и в stderr — включая тело ответа, в которое сервер мог
// вернуть полученный заголовок эхом.
const scrub = (text) => text.split(value).join('[скрыто]')

const url = new URL(PATHS[process.argv[2]], `http://127.0.0.1:${process.env.PORT ?? 8081}`)

try {
  const response = await fetch(url, { headers: { authorization: `Bearer ${value}` } })
  const body = await response.text()
  if (!response.ok) {
    process.stderr.write(scrub(`${response.status} ${body}\n`))
    process.exit(1)
  }
  process.stdout.write(scrub(body))
} catch (error) {
  process.stderr.write(scrub(`${error.message}\n`))
  process.exit(1)
}
