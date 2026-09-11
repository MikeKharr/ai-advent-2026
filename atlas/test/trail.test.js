import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph } from '../lib/extract.js'
import { readSources } from '../lib/sources.js'
import { addressOf, addressTable, count, foldTrail, indexGraph, restoreTrail, stepTrail, trailMore } from '../web/app.js'
import { ROOT } from './helpers.js'

// Путь посещений — agent_docs/design/2026-09-10-1548-atlas-visit-trail.md,
// раздел «Что проверит ревью», критерии `qa`. Путь — список идентификаторов
// без корня: корень стоит первым всегда, и хранить его незачем.

const graph = buildGraph(readSources(ROOT))
const index = indexGraph(graph)
const addresses = addressTable(graph.nodes)
const ids = graph.nodes.map((n) => n.id)

// ── 1. Шаг ─────────────────────────────────────────────────────────────

test('шаг в новый узел добавляет его в конец', () => {
  assert.deepEqual(stepTrail([], 'role/compliance'), ['role/compliance'])
  assert.deepEqual(stepTrail(['role/compliance'], 'history/x'), ['role/compliance', 'history/x'])
})

test('выбор узла из середины отрезает хвост после него', () => {
  assert.deepEqual(stepTrail(['a', 'b', 'c', 'd'], 'b'), ['a', 'b'])
})

test('выбор текущего узла путь не меняет', () => {
  assert.deepEqual(stepTrail(['a', 'b', 'c'], 'c'), ['a', 'b', 'c'])
})

test('выбор корня оставляет один корень', () => {
  assert.deepEqual(stepTrail(['a', 'b', 'c'], null), [])
})

test('шаг не меняет переданный путь', () => {
  const trail = ['a', 'b']
  stepTrail(trail, 'c')
  stepTrail(trail, 'a')
  assert.deepEqual(trail, ['a', 'b'])
})

test('повторов в пути не бывает: сто случайных шагов по реальному графу', () => {
  // Детерминированный генератор: упавшую последовательность можно повторить.
  let seed = 20260914
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed % n
  }
  let trail = []
  for (let i = 0; i < 100; i += 1) {
    const at = trail[trail.length - 1]
    const near = at ? [...index.near.get(at)] : []
    const kind = rand(4)
    // Ссылка панели, поиск, звено пути, корень — все способы выбрать место.
    let next
    if (kind === 0 && near.length > 0) next = near[rand(near.length)]
    else if (kind === 1 || (kind === 0 && near.length === 0)) next = ids[rand(ids.length)]
    else if (kind === 2 && trail.length > 0) next = trail[rand(trail.length)]
    else next = rand(5) === 0 ? null : ids[rand(ids.length)]
    trail = stepTrail(trail, next)
    assert.equal(new Set(trail).size, trail.length, `шаг ${i}: повтор в ${trail.join(' › ')}`)
    if (next !== null) assert.equal(trail[trail.length - 1], next, `шаг ${i}: текущее место — не последнее звено`)
    else assert.deepEqual(trail, [])
  }
})

// ── 2. Восстановление ──────────────────────────────────────────────────

const [x, y, z] = ['role/compliance', 'role/reviewer', 'role/design'].filter((id) => addresses.has(addressOf(id)))

test('сохранённый путь, кончающийся на узле адреса, восстанавливается', () => {
  assert.deepEqual(restoreTrail([y, z, x], addressOf(x), addresses), [y, z, x])
})

test('звенья, которых нет в этой сборке, выбрасываются', () => {
  assert.deepEqual(restoreTrail([y, 'adr/2026-01-01-0000', x], addressOf(x), addresses), [y, x])
})

test('путь, кончающийся не на узле адреса, заменяется корнем и узлом', () => {
  assert.deepEqual(restoreTrail([y, z], addressOf(x), addresses), [x])
  assert.deepEqual(restoreTrail([], addressOf(x), addresses), [x])
  assert.deepEqual(restoreTrail(null, addressOf(x), addresses), [x])
})

test('конец пути сверяется после выброса отсутствующих звеньев', () => {
  // Хвост из узла, которого нет в сборке, выброшен — путь кончается на X.
  assert.deepEqual(restoreTrail([y, x, 'adr/2026-01-01-0000'], addressOf(x), addresses), [y, x])
  // После выброса последнее уже не X — корень и X.
  assert.deepEqual(restoreTrail([x, y, 'adr/2026-01-01-0000'], addressOf(x), addresses), [x])
})

test('без адреса узла — один корень, что бы ни было сохранено', () => {
  assert.deepEqual(restoreTrail([y, x], '', addresses), [])
})

test('мёртвый адрес — один корень: текущим звеном станет «узла нет»', () => {
  assert.deepEqual(restoreTrail([y, x], 'adr-2026-01-01-0000', addresses), [])
})

test('испорченное хранилище не роняет восстановление', () => {
  for (const junk of [undefined, 42, 'строка', { 0: x }, [1, null, x]]) {
    const got = restoreTrail(junk, addressOf(x), addresses)
    assert.equal(got[got.length - 1], x, JSON.stringify(junk))
  }
})

// ── 3. Свёртка ─────────────────────────────────────────────────────────

// Ширины — стоимость звена в строке, вместе с разделителем и зазором.
// Кнопка «… ещё N» шире при двузначном N — так она и мерится на экране.
const more = (n) => (n < 10 ? 77 : 83)

test('всё помещается — ничего не скрыто', () => {
  assert.equal(foldTrail(70, [100, 100, 100], more, 400), 0)
})

test('звенья скрываются от старых к новым, пока строка не встанет', () => {
  // 70 + 77 + 100 + 100 = 347: двух скрытых хватает, одного — нет.
  assert.equal(foldTrail(70, [100, 100, 100, 100], more, 350), 2)
  assert.equal(foldTrail(70, [100, 100, 100, 100], more, 450), 1)
})

test('число на кнопке равно числу скрытых: ширина кнопки считается от него', () => {
  // Десять скрытых — кнопка «… ещё 10» шириной 83: 70 + 83 + 3 × 20 = 213
  // в 210 не встаёт, хотя с однозначной кнопкой (207) встала бы. Значит,
  // ширина кнопки берётся от того числа, которое на ней будет написано.
  const links = Array.from({ length: 13 }, () => 20)
  assert.equal(foldTrail(70, links, more, 210), 11)
  assert.equal(foldTrail(70, links, () => 77, 210), 10)
  assert.equal(foldTrail(70, links, more, 192), 11, 'обязательные не скрываются, даже если не встают')
})

test('корень, предыдущее и текущее не скрываются никогда', () => {
  assert.equal(foldTrail(70, [300, 300], more, 100), 0)
  assert.equal(foldTrail(70, [300], more, 10), 0)
  assert.equal(foldTrail(70, [], more, 10), 0)
  assert.equal(foldTrail(70, [300, 300, 300, 300], more, 10), 2)
})

// ── 4. Тексты ──────────────────────────────────────────────────────────

test('ярлык «… ещё N» и невидимое продолжение согласуются с числом', () => {
  for (const [n, want] of [
    [1, '1 узел'],
    [3, '3 узла'],
    [5, '5 узлов'],
    [11, '11 узлов'],
    [21, '21 узел'],
  ]) {
    const { shown, rest } = trailMore(n)
    assert.equal(shown, `… ещё ${n}`)
    assert.equal(`${shown}${rest}`, `… ещё ${want} пути`)
    assert.equal(`${shown}${rest}`, `… ещё ${count(n, 'узел', 'узла', 'узлов')} пути`)
  }
})
