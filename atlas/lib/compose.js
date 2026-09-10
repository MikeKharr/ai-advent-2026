// Узкий парсер подмножества compose.yml: только то, из чего строится граф —
// имена сервисов, образ, `depends_on`, `volumes`, `env_file` и верхний блок
// `volumes:`. Полноценный YAML не нужен и означал бы зависимость
// (ADR 2026-09-07-1525). Расширение файла за подмножество ловит тест-страж
// в `test/compose.test.js`, а не молчаливое обеднение графа.

/** Отрезает хвостовой комментарий: `- v:/data   # тома переживают пересоздание`. */
function stripComment(s) {
  const m = s.match(/^(.*?)\s+#.*$/)
  return (m ? m[1] : s).trim()
}

/**
 * @param {string} text содержимое compose.yml
 * @returns {{services: Array<{name:string,image:string|null,dependsOn:string[],
 *   volumes:Array<{source:string,target:string,named:boolean}>,envFiles:string[]}>,
 *   volumes: string[]}}
 */
export function parseCompose(text) {
  const services = []
  const volumeNames = []

  let section = null // 'services' | 'volumes' | null
  let service = null // текущий сервис
  let key = null // текущий ключ внутри сервиса

  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue

    const top = raw.match(/^([a-z_]+):\s*$/)
    if (top) {
      section = top[1] === 'services' || top[1] === 'volumes' ? top[1] : null
      service = null
      key = null
      continue
    }

    const second = raw.match(/^ {2}([a-z0-9_.-]+):\s*$/)
    if (second) {
      if (section === 'services') {
        service = { name: second[1], image: null, dependsOn: [], volumes: [], envFiles: [] }
        services.push(service)
        key = null
      } else if (section === 'volumes') {
        volumeNames.push(second[1])
      }
      continue
    }

    if (!service) continue

    const field = raw.match(/^ {4}([a-z_]+):\s*(.*)$/)
    if (field) {
      key = field[1]
      const inline = stripComment(field[2])
      if (key === 'image' && inline) service.image = inline
      continue
    }

    const item = raw.match(/^ {6}- (.+)$/)
    if (item) {
      const value = stripComment(item[1])
      if (key === 'depends_on') service.dependsOn.push(value)
      else if (key === 'env_file') {
        const path = value.match(/^path:\s*(.+)$/)
        service.envFiles.push(path ? path[1] : value)
      } else if (key === 'volumes') {
        // `источник:цель[:режим]`; именованный том — тот, чей источник не путь.
        const parts = value.replace(/^"|"$/g, '').split(':')
        const source = parts[0]
        const target = parts[1] ?? ''
        service.volumes.push({ source, target, named: !source.startsWith('.') && !source.startsWith('/') })
      }
      continue
    }

    // `env_file` в длинной форме: `- path: ./x.env` и следом `  required: false`.
    if (key === 'env_file' && /^ {8}required:/.test(raw)) continue
  }

  // Признак `named` верен только относительно верхнего блока volumes:
  // источник без точки и слэша, которого нет в блоке, — не наш том.
  for (const s of services) {
    for (const v of s.volumes) v.named = v.named && volumeNames.includes(v.source)
  }

  return { services, volumes: volumeNames }
}
