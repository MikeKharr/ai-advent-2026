// Каденция планировщика — ОДНА строка в одном файле: `scheduleUtc` работы в
// `agents/config/jobs.json`. Копий больше нет. Таблицу для busybox crond
// собирает из того же файла `deploy/cron/crontab.sh` на старте контейнера
// времени, а сервис агентов читает его же, когда обещает экрану дня 18
// «следующий срок».
//
// Из какого отказа. Раньше файлов было два — таблица и `jobs.json`, — и
// правка частоты в одном оставляла второй прежним: страница обещала
// посетителю срок, которого не будет, а на вид не ломалось ничего. Сверка
// двух копий это ловила, но копии не убирала. Теперь ловить нечего, и
// предмет проверки другой: что таблица, собранная строчным разбором в
// alpine, — это ровно то, что даёт `JSON.parse` того же файла, и что второй
// копии не завелось снова.
//
// Чего этот файл НЕ проверяет: что busybox awk понимает `jobs.json` так же,
// как awk раннера. Это другой предмет и другая машина — шаг CI «Образ cron
// умеет crond и wget --post-data» поднимает настоящий образ и сверяет
// таблицу из его журнала с той же выкладкой по `JSON.parse`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
// Настоящие разборщики сервиса агентов, а не их пересказ. Переписанная от
// руки копия правил здесь была бы третьим разборщиком одного файла — ровно
// тем, из-за чего каденция с диапазоном проходила все проверки зелёной
// (находка compliance к PR #236). Оба модуля без побочных действий на
// загрузке: `node:crypto` и соседний файл.
import { loadJobs } from '../agents/src/jobs/index.js'
import { parseSchedule, slotsPerDay } from '../agents/src/jobs/schedule.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const JOBS = 'agents/config/jobs.json'
const GEN = 'deploy/cron/crontab.sh'
const COMPOSE = 'deploy/compose.yml'

const jobs = JSON.parse(readFileSync(join(ROOT, JOBS), 'utf8')).jobs

/** Запуск сборщика таблицы над произвольным файлом. */
function build(path) {
  const r = spawnSync('sh', [join(ROOT, GEN), path], { encoding: 'utf8' })
  assert.equal(r.error, undefined, `${GEN}: запустить не удалось`)
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** Временный jobs.json из объекта. */
function fixture(value) {
  const dir = mkdtempSync(join(tmpdir(), 'cron-cadence-'))
  const path = join(dir, 'jobs.json')
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

const expected = (list) => list.map((j) => `${j.scheduleUtc} /cron/tick.sh ${j.id}`).join('\n') + '\n'

// Главное, чего не хватало: настоящий `agents/config/jobs.json` не проходил
// через настоящий разборщик ни в одном тесте — ни здесь (свой наивный разбор),
// ни в `agents/test/jobs.test.js` (переписанная от руки копия). В эту щель
// пролез диапазон `9-17`: сборщик таблицы его принимал, `loadJobs` отвергал,
// реестр работ не грузился целиком, каждый тик получал 404 no_jobs — и все
// проверки оставались зелёными. Этот тест ловит класс, а не случай: любое
// поле, которое сервис агентов не примет, краснеет здесь.
test('настоящий jobs.json проходит настоящий loadJobs сервиса агентов', () => {
  const loaded = loadJobs(JSON.parse(readFileSync(join(ROOT, JOBS), 'utf8')))
  assert.notEqual(loaded.size, 0, `${JOBS}: loadJobs не вернул ни одной работы`)
  for (const job of jobs) assert.ok(loaded.has(job.id), `${JOBS}: работа «${job.id}» не загрузилась`)
})

// Обратная сторона той же щели: сборщик таблицы обязан ОТКАЗАТЬ ровно там,
// где откажет сервис агентов. Диапазон — первое, что пролезло; проверяется он,
// а не «какой-нибудь мусор», потому что диапазон выглядит законной правкой
// настройки и пишется руками чаще прочего.
test('каденцию, которую отвергнет сервис агентов, отвергает и сборщик таблицы', () => {
  for (const scheduleUtc of ['0 9-17 * * *', '0 0-23 * * *', '0 8-20/2 * * *']) {
    assert.throws(
      () => parseSchedule(scheduleUtc),
      `${scheduleUtc}: сервис агентов расписание принял — образец для проверки негоден`,
    )
    const { code, out, err } = build(fixture({ jobs: [{ id: 'alpha', scheduleUtc }] }))
    assert.notEqual(code, 0, `сборщик принял «${scheduleUtc}», которое не примет сервис агентов`)
    assert.equal(out, '')
    assert.match(err, /знак вне \[0-9\*\/,]/)
  }
})

test('таблица crond собирается из jobs.json ровно по scheduleUtc и id', () => {
  assert.notEqual(jobs.length, 0, `${JOBS}: работ нет`)
  const { code, out, err } = build(join(ROOT, JOBS))
  assert.equal(code, 0, `${GEN} отказал на настоящем ${JOBS}: ${err}`)
  assert.equal(out, expected(jobs))
})

// Предыдущая проверка одна зеленела бы и у сборщика, который печатает
// запомненную строку: настоящая каденция сегодня та же, что была. Эта
// отвечает на другой вопрос — читает ли он файл: и каденция, и число работ,
// и имена здесь другие.
test('сборщик читает каденцию из файла, а не помнит её', () => {
  const path = fixture({
    jobs: [
      { id: 'alpha', scheduleUtc: '17 3,15 * * *', agentId: 'pipeline-agent' },
      { id: 'beta-2', scheduleUtc: '0 * * * *', agentId: 'pipeline-agent' },
    ],
  })
  const { code, out, err } = build(path)
  assert.equal(code, 0, `${GEN} отказал на подменённом jobs.json: ${err}`)
  assert.equal(out, '17 3,15 * * * /cron/tick.sh alpha\n0 * * * * /cron/tick.sh beta-2\n')
})

// Пустая таблица — это снятое расписание, а не «сверять нечего»: контейнер
// с ней выглядит работающим планировщиком, у которого просто не настал срок.
test('файл без работ — отказ сборки, а не пустая таблица', () => {
  const { code, out, err } = build(fixture({ jobs: [] }))
  assert.notEqual(code, 0, 'сборщик принял файл без работ')
  assert.equal(out, '')
  // Именно этот отказ, а не любой: без разбора сообщения проверку зеленил бы
  // и отказ по следующей строке, и снятие разбора пустого списка прошло бы
  // незамеченным.
  assert.match(err, /не найдено ни одной работы/)
})

// Строки таблицы исполняет root. Белый список знаков — не про «файл же наш»,
// а про то, что подстановка в неё чего угодно обрывается на сборке.
test('расписание или имя работы со знаком вне белого списка — отказ сборки', () => {
  // Полей ровно пять в обоих случаях: иначе отказ давала бы проверка числа
  // полей, и белый список знаков можно было бы снять, не покраснев.
  for (const [what, job, why] of [
    ['расписание', { id: 'alpha', scheduleUtc: '0 */6 * * *;touch' }, /знак вне \[0-9\*\/,]/],
    ['имя работы', { id: 'al;pha', scheduleUtc: '0 */6 * * *' }, /знак вне \[a-z0-9-]/],
  ]) {
    const { code, out, err } = build(fixture({ jobs: [job] }))
    assert.notEqual(code, 0, `сборщик принял ${what} со знаком вне белого списка`)
    assert.equal(out, '', `сборщик успел напечатать строку при негодном поле «${what}»`)
    assert.match(err, why)
  }
})

// Второй адрес каденции — тот самый отказ, ради которого копию и убирали.
test('в deploy/cron нет второй таблицы расписания', () => {
  assert.equal(
    existsSync(join(ROOT, 'deploy/cron/crontabs')),
    false,
    'deploy/cron/crontabs вернулся: каденция снова живёт в двух местах',
  )
})

// Без этой строки контейнер времени не увидит jobs.json и не поднимется
// вовсе, но заметить это можно было бы только на проде: шаг CI монтирует
// файл сам и о compose.yml ничего не знает.
test('compose монтирует jobs.json контейнеру времени', () => {
  const text = readFileSync(join(ROOT, COMPOSE), 'utf8')
  const cron = text.slice(text.indexOf('\n  cron:\n'))
  const service = cron.slice(0, cron.indexOf('\n  router:'))
  assert.ok(service.includes('cron:'), `${COMPOSE}: служба cron не найдена`)
  assert.ok(
    service.includes('../agents/config/jobs.json:/jobs.json:ro'),
    `${COMPOSE}: службе cron не примонтирован ${JOBS} — таблицу собирать не из чего`,
  )
})

// Потолок стартов должен оставаться запасом СВЕРХУ, а не тем, во что упирается
// нормальная работа: иначе ровная каденция сама выбирает суточный лимит, и
// отличить «всё идёт как задумано» от «упёрлись» на странице нельзя.
// То же требует `agents/src/jobs/index.js` от конфигурации на загрузке.
test('суточный потолок стартов не ниже числа сроков в сутки', () => {
  for (const job of jobs) {
    const perDay = slotsPerDay(parseSchedule(job.scheduleUtc))
    assert.ok(
      job.maxRunsPerDay >= perDay,
      `работа «${job.id}»: сроков в сутки ${perDay}, а maxRunsPerDay ${job.maxRunsPerDay}`,
    )
  }
})

// Часовой слот: `409 slot_taken` пропускает не больше одного старта в час
// (`agents/src/jobs/index.js`, проверка `slotTaken`). Каденция чаще часовой
// поэтому не ускоряет работу, а даёт отказ на каждом лишнем тике — при живом
// контейнере и растущем счётчике отказов, то есть тихо. Правило проверяется
// здесь, до мержа, а не в проде.
test('каденция не чаще одного срока в час', () => {
  for (const job of jobs) {
    const minute = job.scheduleUtc.split(' ')[0]
    assert.ok(
      /^\d+$/.test(minute),
      `работа «${job.id}»: поле минут «${minute}» даёт больше одного срока в час, а часовой слот пропустит только первый (409 slot_taken)`,
    )
  }
})
