// Область видимости SSH-секретов продового деплой-ключа.
//
// Что держит. `SSH_KEY`, `SSH_HOST` и `SSH_USER` — доступ к проду. Секретами
// УРОВНЯ РЕПОЗИТОРИЯ их читает любой job любого workflow, запущенного на
// `pull_request` из ветки этого же репозитория: достаточно завести в ветке
// новый workflow с `echo "${{ secrets.SSH_KEY }}" | base64`, и ключ уезжает в
// журнал прогона, который мержить никто не обязан (находка compliance к
// PR #349). Поэтому секреты ПЕРЕЕЗЖАЮТ на уровень ОКРУЖЕНИЯ `production`, а у
// него политика веток — только `main`
// (`deployment_branch_policy.custom_branch_policies`, запись `main`).
//
// Переезд делает владелец, и до удаления репо-уровневых записей он НЕ
// завершён: этот страж описывает правило и ловит его нарушения, но сам
// область видимости секрета не меняет. Фактическое состояние — не из этого
// комментария, а из `gh secret list` (см. agent_docs/operations.md).
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

// ИМЕНОВАННЫЙ доступ к SSH-секрету — две формы, и обе законные в Actions:
// точечная `secrets.SSH_KEY` и скобочная `secrets['SSH_KEY']` (кавычки любые,
// пробелы внутри скобок допустимы). Первая редакция стража видела только
// точечную, то есть обходилась переписыванием одной строки в скобочную форму
// без всякой маскировки (Consider обоих гейтов к PR #352).
//
// `+`, а не `*`: `SSH_[A-Z0-9_]*` совпадал бы и с прозой «secrets.SSH_*» в
// комментарии workflow, и страж краснел бы на собственном объяснении — то
// есть на тексте, который никакого секрета не читает.
const NAMED = [
  /\bsecrets\.(SSH_[A-Z0-9_]+)/g,
  /\bsecrets\[\s*['"](SSH_[A-Z0-9_]+)['"]\s*\]/g,
]

// ОПТОВЫЙ доступ: формы, которые берут секреты НЕ ПО ИМЕНИ, а все сразу.
//   - `toJSON(secrets)` (в Actions и `toJson`, регистр функции свободный) —
//     разворачивает весь контекст секретов в строку;
//   - `secrets: inherit` — передаёт вызываемому workflow все секреты
//     вызывающего.
//
// Такие формы краснеют В ЛЮБОМ job, включая job с окружением production, и
// это не перестраховка: страж не может сказать, попал ли в выгрузку SSH-ключ,
// потому что имени в тексте нет вовсе. Правило «ссылка стоит в нужном job»
// к безымянной ссылке неприменимо — применимо только «так не делают».
// Таких форм в репозитории нет ни одной; шаг заводит их запрет заранее,
// потому что иначе обход правила стоит одной строки.
const BULK = [
  { re: /\bto_?json\s*\(\s*secrets\s*\)/gi, what: 'toJSON(secrets)' },
  { re: /^\s*secrets:\s*inherit\s*$/gim, what: 'secrets: inherit' },
]

const COMMENT = /^\s*#/

/** Имена SSH-секретов, названные в строке любой из законных форм доступа. */
export function namedIn(line) {
  const names = []
  for (const re of NAMED) {
    re.lastIndex = 0
    for (const m of line.matchAll(re)) names.push(m[1])
  }
  return names
}

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
  // `jobs:` с хвостовым комментарием — законная строка YAML, и первая редакция
  // искала точное совпадение, то есть падала на ней «не найден блок jobs:»
  // (nit обоих гейтов к PR #352).
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l))
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

  // Отступ назван прямо: самый частый случай пустого разбора — имена job не на
  // 2 пробелах, и сообщение «не найдено ни одного job» уводило бы искать
  // пропавший job вместо правки отступа.
  if (jobs.length === 0) {
    throw new Error(`${file}: в блоке jobs не найдено ни одного job — имена job ожидаются с отступом 2 пробела`)
  }
  return { jobs, owner }
}

/**
 * Нарушения области видимости — списком строк. Пусто — каждая именованная
 * ссылка на SSH-секрет стоит в job с окружением `production`, и оптовых форм
 * нет вовсе.
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
    const lines = text.split('\n')

    // Оптовые формы судятся БЕЗ разбора job: правило к ним не про место.
    lines.forEach((line, index) => {
      for (const { re, what } of BULK) {
        re.lastIndex = 0
        if (!re.test(line)) continue
        found.push(
          `${file}:${index + 1}: ${what} — берёт секреты не по имени, то есть все сразу, ` +
            `и SSH-ключ уходит мимо правила об окружении; назовите нужный секрет явно`,
        )
      }
    })

    // Разбор job нужен только файлам с именованными ссылками: иначе на разборе
    // падали бы файлы, к правилу отношения не имеющие.
    if (!lines.some((l) => namedIn(l).length > 0)) continue
    const { owner } = parseJobs(text, file)

    lines.forEach((line, index) => {
      for (const name of namedIn(line)) {
        const no = index + 1
        const job = owner.get(no)
        const where = `${file}:${no}: secrets.${name}`
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
  // Непонятый файл обязан краснеть — но внятно. Первая редакция выпускала
  // исключение наружу, и шаг CI печатал стек Node вместо указания на строку:
  // отказ стража выглядел бы поломкой стража, а не находкой (nit обоих гейтов
  // к PR #352). Код выхода тот же, меняется только читаемость.
  const fail = (message) => {
    console.log(`::error::${message}`)
    process.exit(1)
  }

  let files
  let found
  try {
    files = readWorkflows(process.cwd())
    found = problems(files)
  } catch (error) {
    fail(`страж не разобрал workflow: ${error.message}`)
  }

  for (const problem of found) console.log(`::error::${problem}`)
  if (found.length) {
    fail(
      `SSH-секреты читаются вне окружения ${ENVIRONMENT} — ADR 2026-10-18-1300-ssh-secrets-environment-scope`,
    )
  }

  const refs = files.flatMap(({ file, text }) =>
    text
      .split('\n')
      .flatMap((line, index) => namedIn(line).map((name) => `${file}:${index + 1} secrets.${name}`)),
  )
  // Пустота — тоже отказ: иначе удаление job выкатки давало бы зелёную
  // проверку, которой нечего проверять.
  if (refs.length === 0) fail('ни одной ссылки на SSH-секрет не найдено — страж проверяет пустоту')

  console.log(`ok: ${refs.length} ссылок на SSH-секреты, все в job с environment: ${ENVIRONMENT}`)
  console.log(`ok: оптовых форм (${BULK.map((b) => b.what).join(', ')}) нет ни в одном workflow`)
  for (const ref of refs) console.log(`  ${ref}`)
}
