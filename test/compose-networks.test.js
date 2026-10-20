// Изоляция служб в отдельных сетях compose — ADR 2026-09-23-1227, п. 5 (служба
// MCP) и ADR 2026-09-29-1639, п. 4 (индекс проекта), оба — условие вето
// compliance. Страж — .github/scripts/compose-networks.mjs, он же шаг
// «Изоляция сетей mcp и rag» в ci.yml. Здесь он показан и зелёным на
// настоящем deploy/compose.yml, и красным на приманках: правила «mcp не видит
// router» и «до ollama не дотянуться ниоткуда, кроме caddy и agents» должны
// ломаться на правке файла, а не держаться комментарием.
//
// Приманок про `cron`, `tools`, день 16 и день 20 здесь больше нет: самих
// служб нет в compose (ADR 2026-10-20-0737). Роль «посторонняя служба,
// которую пустили в изолированную сеть» играет `router` — он остался и ему
// там по-прежнему нечего делать.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { COMPOSE, parseServices, problems } from '../.github/scripts/compose-networks.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEXT = readFileSync(join(ROOT, COMPOSE), 'utf8')

/**
 * Правка внутри блока одной службы. Без привязки к имени приманка попала бы в
 * первую попавшуюся службу с тем же куском текста — у `rag` и `ollama` блоки
 * networks одинаковые, и приманка «испортили ollama» молча портила бы rag.
 */
function inService(text, name, from, to) {
  const marker = `\n  ${name}:\n`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `службы ${name} нет в ${COMPOSE}`)
  const rest = text.slice(start + marker.length)
  const next = rest.search(/^ {2}[A-Za-z0-9_.-]+:\s*$/m)
  const end = next === -1 ? text.length : start + marker.length + next
  const block = text.slice(start, end)
  const patched = block.replace(from, to)
  assert.notEqual(patched, block, `приманка не подставилась в блок ${name}`)
  return text.slice(0, start) + patched + text.slice(end)
}

test('настоящий compose.yml: нарушений нет', () => {
  assert.deepEqual(problems(TEXT), [])
})

test('разбор видит сети там, где они есть, и их отсутствие там, где их нет', () => {
  const services = parseServices(TEXT)
  assert.deepEqual(services.get('mcp'), ['mcp'])
  // Вход — в четырёх сетях: по default он ходит в сервис агентов, по mcp
  // публикует /mcp, по rag — /rag и /rag/healthz, по edge к нему приходит
  // вход zpq.
  assert.deepEqual(services.get('caddy'), ['default', 'mcp', 'rag', 'edge'])
  // Ключа networks нет — значит сеть по умолчанию, вместе с secrets.env.
  assert.equal(services.get('router'), null)
  // agents в трёх сетях: по default уходит запрос в роутер, по mcp он ходит
  // в службу MCP, по rag — в индекс проекта (ADR 2026-10-04-0735, п. 1).
  assert.deepEqual(services.get('agents'), ['default', 'mcp', 'rag'])
})

test('приманка: у mcp убрали ключ networks — он оказался в сети по умолчанию', () => {
  const decoy = inService(TEXT, 'mcp', / {4}networks:\n {6}- mcp\n/, '')
  assert.match(problems(decoy).join('\n'), /нет ключа networks/)
})

test('приманка: mcp добавили в сеть по умолчанию вдобавок к своей', () => {
  const decoy = inService(TEXT, 'mcp', / {4}networks:\n {6}- mcp\n/, '    networks:\n      - mcp\n      - default\n')
  assert.match(problems(decoy).join('\n'), /только в сети mcp/)
})

// Связь agents↔mcp — не терпимость, а условие работы третьего сервера
// (ADR 2026-09-29-0236, п. 5). Две пары ниже держат её с обеих сторон: снятая
// связь и связь, расширенная не туда.
test('приманка: у agents убрали сеть mcp — служба MCP стала недостижима', () => {
  const decoy = inService(TEXT, 'agents', / {6}mcp:\n/, '')
  assert.deepEqual(parseServices(decoy).get('agents'), ['default', 'rag'], 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба agents обязана быть в сети mcp/)
})

test('приманка: agents вовсе без ключа networks — сеть mcp потеряна вместе с остальными', () => {
  const decoy = inService(TEXT, 'agents', / {4}networks:\n(?: {6}.*\n)+/, '')
  assert.equal(parseServices(decoy).get('agents'), null, 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба agents обязана быть в сети mcp.*\(сеть по умолчанию\)/)
})

test('приманка: router пустили в сеть mcp', () => {
  const decoy = TEXT.replace(
    /( {2}router:\n)( {4}image:)/,
    '$1    networks:\n      - default\n      - mcp\n$2',
  )
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /служба router в сети mcp/)
})

test('службы mcp нет вовсе — это тоже нарушение, а не «ok»', () => {
  const decoy = TEXT.replace(/\n {2}mcp:\n(?: {4}.*\n| {6,}.*\n|\n)*/, '\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /службы mcp нет/)
})

test('непонятный файл — исключение, а не пустой список нарушений', () => {
  assert.throws(() => problems('version: "3"\n'), /не найден блок services/)
})

// --- Сеть rag (ADR 2026-09-29-1639, п. 4) -------------------------------------
// Эмбеддер стоит ядра общей машины, а ни ключа, ни лимитера своего у него нет.
// Единственное, чем он закрыт, — что имя `ollama` не разрешается у router.
// Строка `networks: - rag` и есть вся защита, поэтому её снятие обязано
// краснеть.

test('разбор видит сети новых служб', () => {
  const services = parseServices(TEXT)
  assert.deepEqual(services.get('ollama'), ['rag'])
  assert.deepEqual(services.get('rag'), ['rag'])
})

test('приманка: у ollama убрали ключ networks — эмбеддер в сети по умолчанию', () => {
  const decoy = inService(TEXT, 'ollama', / {4}networks:\n {6}- rag\n/, '')
  assert.equal(parseServices(decoy).get('ollama'), null, 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /у службы ollama нет ключа networks/)
})

test('приманка: ollama добавили в сеть по умолчанию — до него дотянулся router', () => {
  const decoy = inService(TEXT, 'ollama', / {4}networks:\n {6}- rag\n/, '    networks:\n      - rag\n      - default\n')
  assert.deepEqual(parseServices(decoy).get('ollama'), ['rag', 'default'], 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба ollama должна быть только в сети rag/)
})

// До дня 22 здесь стояло ПРОТИВОПОЛОЖНОЕ: `agents` в сети `rag` был
// нарушением. Решение принято (ADR 2026-10-04-0735, п. 1) — проверка
// развёрнута, а не снята: теперь краснеет пропажа связи. Названная цена
// решения в том же ADR: из `agents` разрешается имя `ollama`, то есть единица
// с деревом npm дотягивается до эмбеддера напрямую, минуя ключ и потолки
// службы `rag`. Страж этого больше не держит и держать не может — держат
// только ключ и лимитер самой службы.
test('приманка: у agents убрали сеть rag — поиск по корпусу стал недостижим', () => {
  const decoy = inService(TEXT, 'agents', / {6}rag:\n/, '')
  assert.deepEqual(parseServices(decoy).get('agents'), ['default', 'mcp'], 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба agents обязана быть в сети rag/)
})

// Посторонняя служба в сети `rag` — та же приманка, что была у дня 20, на
// единственной оставшейся посторонней службе. Без неё правило «в сети rag
// только caddy, rag, ollama и agents» держалось бы с одной стороны: пропажу
// нужной связи ловил бы тест выше, а лишнюю — никто.
test('приманка: router пустили в сеть rag напрямую', () => {
  const decoy = TEXT.replace(
    /( {2}router:\n)( {4}image:)/,
    '$1    networks:\n      - default\n      - rag\n$2',
  )
  assert.notEqual(decoy, TEXT)
  assert.ok(parseServices(decoy).get('router').includes('rag'), 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба router в сети rag/)
})

test('приманка: у caddy убрали сеть rag — /rag/healthz перестал доходить', () => {
  const decoy = inService(TEXT, 'caddy', / {6}rag:\n/, '')
  assert.deepEqual(parseServices(decoy).get('caddy'), ['default', 'mcp', 'edge'], 'приманка не собралась')
  assert.match(problems(decoy).join('\n'), /служба caddy обязана быть в сети rag/)
})

test('службы ollama нет вовсе — это тоже нарушение, а не «ok»', () => {
  const decoy = TEXT.replace(/\n {2}ollama:\n(?: {4}.*\n| {6,}.*\n|\n)*/, '\n')
  assert.notEqual(decoy, TEXT)
  assert.match(problems(decoy).join('\n'), /службы ollama нет/)
})
