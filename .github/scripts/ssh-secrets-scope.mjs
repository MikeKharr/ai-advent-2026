// Область видимости SSH-секретов продового деплой-ключа.
//
// Что держит. `SSH_KEY`, `SSH_HOST` и `SSH_USER` — доступ к проду. Пока они
// лежали секретами УРОВНЯ РЕПОЗИТОРИЯ, их читал любой job любого workflow,
// запущенного на `pull_request` из ветки этого же репозитория: достаточно
// завести в ветке новый workflow с `echo "${{ secrets.SSH_KEY }}" | base64`,
// и ключ уезжает в журнал прогона, который мержить никто не обязан (находка
// compliance к PR #349). Поэтому секреты переехали на уровень ОКРУЖЕНИЯ
// `production`, а у него политика веток — только `main`
// (`deployment_branch_policy.custom_branch_policies`, запись `main`).
//
// Чего это НЕ держит само по себе. Секрет окружения job без `environment:`
// не получает вовсе — и получает пустую строку, а не отказ. То есть забытая
// строка `environment: production` даёт не красную выкатку, а выкатку,
// которая идёт к `$SSH_USER@$SSH_HOST` с пустыми значениями и падает
// невнятно. Ровно так же молча вернулась бы и дыра: новый job с
// `secrets.SSH_*` и без окружения читал бы репо-уровневый секрет, если его
// однажды заведут снова. Этот страж — то место, где такая правка краснеет.
//
// Правило одно: КАЖДАЯ ссылка на `secrets.SSH_*` обязана стоять в job,
// который объявил `environment: production`. Не «в deploy.yml» и не «в job
// с именем deploy»: предмет — окружение, потому что именно оно и есть
// граница доступа к секрету.
//
// Запуск из корня репозитория: node .github/scripts/ssh-secrets-scope.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const WORKFLOWS = '.github/workflows'
export const ENVIRONMENT = 'production'

// `+`, а не `*`: `SSH_[A-Z0-9_]*` совпадал бы и с прозой «secrets.SSH_*» в
// комментарии workflow, и страж краснел бы на собственном объяснении — то
// есть на тексте, который никакого секрета не читает.
const SECRET = /\bsecrets\.(SSH_[A-Z0-9_]+)/g
const COMMENT = /^\s*#/

/**
 * Разбор ровно того, что нужно: к какому job относится каждая строка и какое
 * окружение этот job объявил. Не YAML-парсер — подмножество, на котором
 * написаны workflow этого репозитория: `jobs:` на отступе 0, имена job на 2,
 * их ключи на 4.
 *
 * Форма `environment:` отображением (`environment:` + `name: production`
 * ниже) тоже разбирается: иначе страж молчал бы на правке, которая от
 * одиночной строки к отображению переходит законно.
 *
 * Неизвестная форма — исключение, а не тихий пропуск: страж, не понявший
 * файл, обязан покраснеть.
 */
export function parseJobs(text, file) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'jobs:')
  if (start === -1) throw new Error(`${file}: не найден блок jobs:`)

  /** @type {{name: string, environment: string|null, line: number}[]} */
  const jobs = []
  // Номер строки (1-based) -> job, которому она принадлежит. Строки до первого
  // job в отображение не попадают: ссылка на секрет там — тоже нарушение, и
  // ниже она разбирается как «вне job».
  const owner = new Map()
  let job = null
  let inEnvironment = false

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.search(/\S/)
    if (indent === 0) break // конец блока jobs

    if (indent === 2 && !COMMENT.test(line)) {
      const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
      if (!name) throw new Error(`${file}: непонятная строка job: ${line}`)
      job = { name: name[1], environment: null, line: i + 1 }
      jobs.push(job)
      inEnvironment = false
    } else if (job && indent === 4 && !COMMENT.test(line)) {
      const env = /^ {4}environment:\s*(\S.*)?$/.exec(line)
      if (env) {
        if (env[1] === undefined) {
          inEnvironment = true // отображение, имя строкой ниже
        } else {
          job.environment = env[1].trim().replace(/^['"]|['"]$/g, '')
          inEnvironment = false
        }
      } else {
        inEnvironment = false
      }
    } else if (job && inEnvironment && indent === 6 && !COMMENT.test(line)) {
      const name = /^ {6}name:\s*(\S.*)$/.exec(line)
      if (name) job.environment = name[1].trim().replace(/^['"]|['"]$/g, '')
    }

    if (job) owner.set(i + 1, job)
  }

  if (jobs.length === 0) throw new Error(`${file}: в блоке jobs не найдено ни одного job`)
  return { jobs, owner }
}

/**
 * Нарушения области видимости — списком строк. Пусто — каждая ссылка на
 * `secrets.SSH_*` стоит в job с окружением `production`.
 *
 * Комментарии из разбора НЕ исключаются намеренно: `# ${{ secrets.SSH_KEY }}`
 * секрета не читает, но строка в комментарии — ровно то, что переносят в
 * рабочий шаг копированием. Дешевле покраснеть на комментарии, чем объяснять
 * пропущенную правку. Упоминание имени секрета прозой (как в комментариях
 * deploy.yml про `SSH_HOST`) под `secrets.` не попадает и стража не трогает.
 */
export function problems(files) {
  const found = []

  for (const { file, text } of files) {
    if (!SECRET.test(text)) continue
    SECRET.lastIndex = 0
    const { owner } = parseJobs(text, file)

    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(SECRET)) {
        const no = index + 1
        const job = owner.get(no)
        const where = `${file}:${no}: secrets.${match[1]}`
        if (!job) {
          found.push(`${where} — вне job: секрет окружения читает только job, объявивший окружение`)
        } else if (job.environment !== ENVIRONMENT) {
          found.push(
            `${where} — в job ${job.name}, у которого environment: ${job.environment ?? '(нет)'}; ` +
              `нужно environment: ${ENVIRONMENT}`,
          )
        }
      }
    })
  }
  return found
}

/** Файлы workflow, отсортированные по имени. */
export function readWorkflows(root) {
  const dir = join(root, WORKFLOWS)
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
    .sort()
  if (names.length === 0) throw new Error(`${WORKFLOWS}: не найдено ни одного файла workflow`)
  return names.map((name) => ({
    file: `${WORKFLOWS}/${name}`,
    text: readFileSync(join(dir, name), 'utf8'),
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = readWorkflows(process.cwd())
  const found = problems(files)
  for (const problem of found) console.log(`::error::${problem}`)
  if (found.length) {
    console.log(
      `::error::SSH-секреты читаются вне окружения ${ENVIRONMENT} — ADR 2026-10-18-1300-ssh-secrets-environment-scope`,
    )
    process.exit(1)
  }

  const refs = files.flatMap(({ file, text }) =>
    text
      .split('\n')
      .flatMap((line, index) => [...line.matchAll(SECRET)].map((m) => `${file}:${index + 1} secrets.${m[1]}`)),
  )
  if (refs.length === 0) {
    console.log(`::error::ни одной ссылки на secrets.SSH_* не найдено — страж проверяет пустоту`)
    process.exit(1)
  }
  console.log(`ok: ${refs.length} ссылок на secrets.SSH_*, все в job с environment: ${ENVIRONMENT}`)
  for (const ref of refs) console.log(`  ${ref}`)
}
