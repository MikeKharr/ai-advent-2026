// Входы атласа — явный список путей, а не обход дерева. Это не стиль, а
// граница публикуемого (I-1…I-3): `deploy/*.env`, `.env*`, `temp/`, `logs/`
// и `data/` не читаются никогда, поэтому и попасть в граф не могут.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Явный список входов. Каталоги перечисляются нерекурсивно, по маске файлов. */
export const INPUTS = {
  adrDir: 'agent_docs/adr',
  historyDir: 'agent_docs/development-history',
  designDir: 'agent_docs/design',
  guidesDir: 'agent_docs/guides',
  rootGuides: ['agent_docs/architecture.md', 'agent_docs/index.md', 'agent_docs/glossary.md', 'AGENTS.md'],
  invariants: 'agent_docs/invariants.md',
  rolesDir: '.claude/agents',
  skillsDir: '.agents/skills',
  skillsLock: 'skills-lock.json',
  daysDir: 'days',
  compose: 'deploy/compose.yml',
  caddyfile: 'deploy/Caddyfile',
  landing: 'site/index.html',
  providers: 'router/config/providers.json',
  overlay: 'atlas/overlay.json',
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8')

/** Файлы `*.md` каталога, кроме README. */
function markdownFiles(root, dir) {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => ({ key: basename(f, '.md'), path: `${dir}/${f}`, text: read(root, `${dir}/${f}`) }))
}

/**
 * Читает все входы графа из корня репозитория.
 * @param {string} root корень репозитория
 */
export function readSources(root) {
  const days = readdirSync(join(root, INPUTS.daysDir))
    .filter((d) => /^day\d+$/.test(d))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))

  const skillsDir = join(root, INPUTS.skillsDir)
  const skills = readdirSync(skillsDir)
    .filter((d) => existsSync(join(skillsDir, d, 'SKILL.md')))
    .sort()
    .map((d) => ({ key: d, path: `${INPUTS.skillsDir}/${d}/SKILL.md`, text: read(root, `${INPUTS.skillsDir}/${d}/SKILL.md`) }))

  const roles = readdirSync(join(root, INPUTS.rolesDir))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ key: basename(f, '.md'), path: `${INPUTS.rolesDir}/${f}`, text: read(root, `${INPUTS.rolesDir}/${f}`) }))

  const guides = [
    ...markdownFiles(root, INPUTS.guidesDir),
    ...INPUTS.rootGuides.map((p) => ({ key: basename(p, '.md').toLowerCase(), path: p, text: read(root, p) })),
  ]

  return {
    root,
    adr: markdownFiles(root, INPUTS.adrDir),
    history: markdownFiles(root, INPUTS.historyDir),
    design: markdownFiles(root, INPUTS.designDir),
    guides,
    roles,
    skills,
    days,
    invariants: read(root, INPUTS.invariants),
    composeText: read(root, INPUTS.compose),
    caddyText: read(root, INPUTS.caddyfile),
    landingText: read(root, INPUTS.landing),
    providers: JSON.parse(read(root, INPUTS.providers)),
    skillsLock: JSON.parse(read(root, INPUTS.skillsLock)),
    overlayText: read(root, INPUTS.overlay),
    overlay: JSON.parse(read(root, INPUTS.overlay)),
  }
}

/** Существует ли файл входа — для проверки ссылок. */
export function inputExists(root, rel) {
  return existsSync(join(root, rel))
}

/** Имена файлов каталога — для разрешения цитат по идентификатору. */
export function listNames(root, dir) {
  const abs = join(root, dir)
  return existsSync(abs) ? readdirSync(abs) : []
}
