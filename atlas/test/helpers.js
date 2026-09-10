import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Корень репозитория: тесты читают те же входы, что и сборка. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Временные файлы — в `temp/` проекта (agent_docs/guides/archiving-and-temp.md). */
const TEMP = join(ROOT, 'temp')

const COPY = [
  'agent_docs',
  '.claude/agents',
  '.agents/skills',
  'skills-lock.json',
  'AGENTS.md',
  'deploy/compose.yml',
  'deploy/Caddyfile',
  'site/index.html',
  'router/config/providers.json',
  'atlas/overlay.json',
]

/**
 * Копия входов графа во временном корне: тесты ломают входы и подкладывают
 * секреты, не трогая репозиторий. Возвращает путь и функцию уборки.
 */
export function makeFixture() {
  mkdirSync(TEMP, { recursive: true })
  const root = mkdtempSync(join(TEMP, 'atlas-'))
  for (const rel of COPY) {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    cpSync(join(ROOT, rel), join(root, rel), { recursive: true })
  }
  // Дни — только имена каталогов: содержимое приложений в граф не входит.
  for (let n = 1; n <= 8; n += 1) mkdirSync(join(root, 'days', `day${n}`), { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Заполненность раскладки — одно определение на все тесты и отчёты. Три
 * независимых замера этапа 3 разошлись (162, 148 и 172 узла из 176) ровно
 * потому, что нормировали сетку по-разному; спорить было не о чем, но
 * повторить друг друга не вышло. Поэтому определение записано словами:
 *
 * - **Считаются все узлы графа**, включая изолированные: их место в картинке
 *   такое же, как у прочих, и прятать их из метрики нельзя.
 * - **Сетка нормируется по полю**, а не по габариту узлов: ячейка — это
 *   `1/cells` единичного квадрата `0…1`, начало координат в `(0, 0)`, размер
 *   поля всегда 1×1 независимо от того, где легли крайние узлы. Нормировка по
 *   габариту растягивала бы сетку вслед за выбросом — то есть мерила бы не
 *   то же самое от сборки к сборке.
 * - **Номер ячейки** — `Math.floor(координата × cells)`, значение `1.0`
 *   относится к последней ячейке (`cells - 1`), а не к несуществующей
 *   `cells`.
 * - **`filled`** — доля узлов, попавших каждый в свою ячейку: число занятых
 *   ячеек, делённое на число узлов (или на число ячеек, если узлов больше).
 *   Доля именно от узлов: порог должен ловить слипание, а не зависеть от
 *   того, сколько документов в проекте.
 * - **`median`** — медиана расстояния от узла до ближайшего соседа в тех же
 *   единицах `0…1`; при чётном числе узлов берётся верхний из двух средних.
 *
 * @param {Array<{x:number, y:number}>} points все узлы раскладки
 * @param {number} cells сторона сетки в ячейках
 */
export function density(points, cells = 20) {
  const cell = (v) => Math.min(cells - 1, Math.floor(v * cells))
  const busy = new Set()
  for (const p of points) busy.add(`${cell(p.x)},${cell(p.y)}`)

  const nearest = points
    .map((a) => Math.min(...points.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))))
    .sort((a, b) => a - b)

  return {
    busy: busy.size,
    filled: busy.size / Math.min(points.length, cells * cells),
    median: nearest[Math.floor(nearest.length / 2)],
  }
}
