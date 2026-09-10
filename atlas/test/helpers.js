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
