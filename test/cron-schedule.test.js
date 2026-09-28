// Расписание планировщика существует в двух копиях по природе: исполняет его
// busybox crond по deploy/cron/crontabs/root, а страница дня 18 показывает
// «следующий срок» по agents/config/jobs.json — контейнер времени и сервис
// агентов не видят файлов друг друга (ADR 2026-09-28-0736, п. 6). Свести их в
// один файл нечем, поэтому сверка механическая, как у закрытого списка
// (ADR 2026-09-24-1230, A6).
//
// Из какого отказа: правка каденции в одном файле оставляет второй прежним, и
// страница обещает посетителю срок, которого не будет. Расхождение при этом
// не ломает ничего на вид — тики идут, страница отвечает.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CRONTAB = 'deploy/cron/crontabs/root'
const JOBS = 'agents/config/jobs.json'

/**
 * Строки заданий таблицы: [{ schedule, command }]. Комментарии и пустые строки
 * отброшены. Пустой результат — провал: таблица без заданий это не «сверять
 * нечего», а снятое расписание, и тест обязан это назвать.
 */
export function parseCrontab(text) {
  const rows = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line)
    assert.ok(m, `${CRONTAB}: строка не похожа на задание cron: ${line}`)
    rows.push({ schedule: m[1].replace(/\s+/g, ' '), command: m[2] })
  }
  assert.notEqual(rows.length, 0, `${CRONTAB}: заданий нет — расписание снято`)
  return rows
}

const crontab = parseCrontab(readFileSync(join(ROOT, CRONTAB), 'utf8'))
const jobs = JSON.parse(readFileSync(join(ROOT, JOBS), 'utf8')).jobs

test('у каждой работы из jobs.json есть строка в таблице crond, и каденция та же', () => {
  assert.notEqual(jobs.length, 0, `${JOBS}: работ нет`)
  for (const job of jobs) {
    const row = crontab.find((r) => r.command.split(/\s+/).includes(job.id))
    assert.ok(row, `${CRONTAB}: нет строки, дёргающей работу «${job.id}»`)
    assert.equal(
      job.scheduleUtc,
      row.schedule,
      `каденция работы «${job.id}» в ${JOBS} и в ${CRONTAB} разошлась`,
    )
  }
})

test('в таблице нет строк, дёргающих работу, которой нет в jobs.json', () => {
  const ids = new Set(jobs.map((j) => j.id))
  for (const row of crontab) {
    const arg = row.command.split(/\s+/).at(-1)
    assert.ok(ids.has(arg), `${CRONTAB}: строка дёргает работу «${arg}», которой нет в ${JOBS}`)
  }
})

// Потолок стартов должен оставаться запасом СВЕРХУ, а не тем, во что упирается
// нормальная работа: иначе ровная каденция сама выбирает суточный лимит, и
// отличить «всё идёт как задумано» от «упёрлись» на странице нельзя.
test('суточный потолок стартов не ниже числа сроков в сутки', () => {
  for (const job of jobs) {
    const hours = job.scheduleUtc.split(' ')[1]
    const step = /^\*\/(\d+)$/.exec(hours)
    const perDay = step ? Math.ceil(24 / Number(step[1])) : hours.split(',').length
    assert.ok(
      job.maxRunsPerDay >= perDay,
      `работа «${job.id}»: сроков в сутки ${perDay}, а maxRunsPerDay ${job.maxRunsPerDay}`,
    )
  }
})
