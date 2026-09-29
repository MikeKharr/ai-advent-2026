"""Обход корпуса: что индексируется и что нет.

Список буквальный, из ADR 2026-09-29-1352, п. 2: то, чем пользуется агент
при разработке, а не «всё». Правило здесь одно на два применения — сбор
копии в образ (CI, `--out`) и обход при сборке индекса, — чтобы список
не разъехался между ними.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

# Документы корня. `CLAUDE.md` не берём: он состоит из одной директивы
# включения AGENTS.md, и в индексе был бы дублем.
ROOT_FILES = ("AGENTS.md", "README.md")

# Каталоги документации целиком.
DOC_DIRS = ("agent_docs",)

# Код живых единиц. `days/**` нет намеренно: сданные дни не поддерживаются
# (правило владельца 2026-09-08), искать в них нечего.
CODE_DIRS = ("router", "agents", "mcp", "mcpnews", "mcpstore", "deploy", ".github", "test")

# README единиц, код которых в корпус не идёт.
UNIT_READMES = ("atlas/README.md", "rag/README.md", "site/README.md")

# Каталоги, которые не обходим нигде: чужой vendored-набор, установленные
# пакеты, сборка витрины, временные файлы и собственная копия корпуса.
SKIP_DIRS = frozenset(
    {".git", "node_modules", "dist", "coverage", "__pycache__", "corpus", "temp", ".venv", "venv"}
)

# Расширения текстовых файлов кода и документов.
CODE_SUFFIXES = frozenset({".js", ".mjs", ".cjs", ".sh", ".mts", ".yml", ".yaml", ".json", ".md", ".py"})

# Файлы без расширения, которые всё равно код.
BARE_NAMES = frozenset({"Dockerfile", "Caddyfile"})

# Машинные файлы: содержимое не отвечает ни на один вопрос, а объём заметный.
SKIP_NAMES = frozenset({"package-lock.json", "skills-lock.json"})

# Тесты единиц — не в первом заходе (ADR 2026-09-29-1352, п. 2): 40 тысяч
# строк ради вопросов вида «есть ли тест на X». Корневой `test/` при этом
# берётся целиком — он в CODE_DIRS и сам является каталогом тестов проекта.
UNIT_TEST_PARTS = ("test", "tests")


def _wanted(rel: Path) -> bool:
    name = rel.name
    if name in SKIP_NAMES:
        return False
    if name in BARE_NAMES:
        return True
    return rel.suffix in CODE_SUFFIXES


def _walk(base: Path, root: Path, docs_only: bool) -> list[Path]:
    out: list[Path] = []
    for path in sorted(base.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        # Тесты единиц отсекаются, корневой test/ — нет: у него нет
        # каталога-единицы перед `test`.
        if len(rel.parts) > 1 and any(part in UNIT_TEST_PARTS for part in rel.parts[1:-1]):
            continue
        if docs_only and rel.suffix != ".md":
            continue
        if not _wanted(rel):
            continue
        out.append(rel)
    return out


def collect(root: Path) -> list[Path]:
    """Пути корпуса относительно `root`, отсортированные и без повторов."""
    root = Path(root)
    found: list[Path] = []
    for name in ROOT_FILES:
        if (root / name).is_file():
            found.append(Path(name))
    for name in DOC_DIRS:
        if (root / name).is_dir():
            found.extend(_walk(root / name, root, docs_only=True))
    for name in CODE_DIRS:
        if (root / name).is_dir():
            found.extend(_walk(root / name, root, docs_only=False))
    for name in UNIT_READMES:
        if (root / name).is_file():
            found.append(Path(name))
    return sorted(set(found))


def _commit(root: Path) -> str:
    try:
        done = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return done.stdout.strip() if done.returncode == 0 else "unknown"


def read_commit(corpus_dir: Path) -> str:
    marker = Path(corpus_dir) / "COMMIT"
    return marker.read_text(encoding="utf-8").strip() if marker.is_file() else "unknown"


def copy_to(root: Path, out: Path) -> int:
    """Копия корпуса в `out` с сохранением путей. Возвращает число файлов."""
    root, out = Path(root), Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    files = collect(root)
    for rel in files:
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / rel, dest)
    (out / "COMMIT").write_text(_commit(root) + "\n", encoding="utf-8")
    return len(files)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Сбор корпуса проекта")
    parser.add_argument("--root", default=".")
    parser.add_argument("--out", help="каталог копии; без него — только список")
    args = parser.parse_args(argv)
    if args.out:
        count = copy_to(Path(args.root), Path(args.out))
        print(f"корпус: {count} файлов в {args.out}")
        if count == 0:
            print("::error::корпус пуст — индексировать нечего", file=sys.stderr)
            return 1
        return 0
    for rel in collect(Path(args.root)):
        print(rel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
