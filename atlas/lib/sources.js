// Входы атласа — явный список путей, а не обход дерева. Это не стиль, а
// граница публикуемого (I-1…I-3): `deploy/*.env`, `.env*`, `temp/`, `logs/`
// и `data/` не читаются никогда, поэтому и попасть в граф не могут.
//
// Битый или пропавший вход не роняет обязательную проверку голым стеком:
// он возвращается находкой, как и битая ссылка.

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

const DECLARED = Object.values(INPUTS).flat()
/** Каталог, который только перечисляется: содержимое приложений не читается. */
const LIST_ONLY = new Set([INPUTS.daysDir])

/**
 * Разрешено ли читать этот файл. Через проверку проходит каждое чтение:
 * список описывает намерение, а гарантию даёт то, что мимо него ничего не
 * читается. `days/` в чтение не входит — оттуда берутся только имена.
 */
export function isDeclaredInput(rel) {
  return DECLARED.some((d) => !LIST_ONLY.has(d) && (rel === d || rel.startsWith(`${d}/`)))
}

/** Разрешено ли перечислять этот каталог. */
export function isDeclaredDir(rel) {
  return DECLARED.includes(rel)
}

/**
 * Читает все входы графа из корня репозитория.
 * @param {string} root корень репозитория
 */
export function readSources(root) {
  const findings = []
  // Абсолютный путь раннера в сообщении бесполезен: файл уже назван в
  // поле `file`, а корень у каждой машины свой.
  const fail = (rel, error) =>
    findings.push({ file: rel, line: 1, message: `вход не читается: ${error.message.replaceAll(`${root}/`, '')}` })

  const text = (rel, fallback = '') => {
    if (!isDeclaredInput(rel)) throw new Error(`чтение мимо списка входов: ${rel}`)
    try {
      return readFileSync(join(root, rel), 'utf8')
    } catch (error) {
      fail(rel, error)
      return fallback
    }
  }
  const json = (rel, fallback) => {
    const raw = text(rel, null)
    if (raw === null) return fallback
    try {
      return JSON.parse(raw)
    } catch (error) {
      findings.push({ file: rel, line: 1, message: `вход не разбирается как JSON: ${error.message}` })
      return fallback
    }
  }
  const names = (rel) => {
    if (!isDeclaredDir(rel)) throw new Error(`перечисление мимо списка входов: ${rel}`)
    try {
      return readdirSync(join(root, rel))
    } catch (error) {
      fail(rel, error)
      return []
    }
  }

  /** Файлы `*.md` каталога, кроме README. */
  const markdownFiles = (dir) =>
    names(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .sort()
      .map((f) => ({ key: basename(f, '.md'), path: `${dir}/${f}`, text: text(`${dir}/${f}`) }))

  const days = names(INPUTS.daysDir)
    .filter((d) => /^day\d+$/.test(d))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))

  const skills = names(INPUTS.skillsDir)
    .filter((d) => existsSync(join(root, INPUTS.skillsDir, d, 'SKILL.md')))
    .sort()
    .map((d) => ({ key: d, path: `${INPUTS.skillsDir}/${d}/SKILL.md`, text: text(`${INPUTS.skillsDir}/${d}/SKILL.md`) }))

  const roles = names(INPUTS.rolesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ key: basename(f, '.md'), path: `${INPUTS.rolesDir}/${f}`, text: text(`${INPUTS.rolesDir}/${f}`) }))

  const guides = [
    ...markdownFiles(INPUTS.guidesDir),
    ...INPUTS.rootGuides.map((p) => ({ key: basename(p, '.md').toLowerCase(), path: p, text: text(p) })),
  ]

  const overlayText = text(INPUTS.overlay, '{}')
  // Пустые разделы overlay — не отсутствие полей, а честный «ничего нет»:
  // иначе битый overlay падал бы стеком вместо находки.
  const EMPTY_OVERLAY = { classes: [], phases: [], externals: [], calls: [], publishes: [], about: {} }
  let overlay = EMPTY_OVERLAY
  try {
    overlay = { ...EMPTY_OVERLAY, ...JSON.parse(overlayText) }
  } catch (error) {
    findings.push({ file: INPUTS.overlay, line: 1, message: `вход не разбирается как JSON: ${error.message}` })
  }

  return {
    root,
    findings,
    adr: markdownFiles(INPUTS.adrDir),
    history: markdownFiles(INPUTS.historyDir),
    design: markdownFiles(INPUTS.designDir),
    guides,
    roles,
    skills,
    days,
    invariants: text(INPUTS.invariants),
    composeText: text(INPUTS.compose),
    caddyText: text(INPUTS.caddyfile),
    landingText: text(INPUTS.landing),
    providers: json(INPUTS.providers, []),
    skillsLock: json(INPUTS.skillsLock, { skills: {} }),
    overlayText,
    overlay,
  }
}

/** Существует ли файл входа — для проверки ссылок. */
export function inputExists(root, rel) {
  return existsSync(join(root, rel))
}
