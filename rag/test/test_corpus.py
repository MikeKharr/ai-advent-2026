import contextlib
import io
import re
import tempfile
import unittest
from pathlib import Path

import corpus


def tree(root: Path, paths: list[str]) -> None:
    for rel in paths:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x\n", encoding="utf-8")


class CollectTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_берёт_документы_корня_и_agent_docs(self):
        tree(self.root, ["AGENTS.md", "README.md", "agent_docs/invariants.md", "agent_docs/adr/a.md"])
        got = {str(p) for p in corpus.collect(self.root)}
        self.assertEqual(got, {"AGENTS.md", "README.md", "agent_docs/invariants.md", "agent_docs/adr/a.md"})

    def test_в_agent_docs_только_markdown(self):
        tree(self.root, ["agent_docs/a.md", "agent_docs/guides/single-source.tsv", "agent_docs/x.json"])
        self.assertEqual([str(p) for p in corpus.collect(self.root)], ["agent_docs/a.md"])

    def test_сданные_дни_и_чужие_скиллы_не_берутся(self):
        tree(self.root, ["days/day1/server.js", ".agents/skills/x/SKILL.md", "router/src/service.js"])
        self.assertEqual([str(p) for p in corpus.collect(self.root)], ["router/src/service.js"])

    def test_node_modules_и_lock_файлы_не_берутся(self):
        tree(self.root, ["mcp/node_modules/z/index.js", "mcp/package-lock.json", "mcp/package.json"])
        self.assertEqual([str(p) for p in corpus.collect(self.root)], ["mcp/package.json"])

    def test_тесты_единиц_не_берутся_а_корневой_test_берётся(self):
        tree(self.root, ["agents/test/a.test.js", "agents/src/a.js", "test/secrets-step.test.js"])
        got = {str(p) for p in corpus.collect(self.root)}
        self.assertEqual(got, {"agents/src/a.js", "test/secrets-step.test.js"})

    def test_файлы_без_расширения_только_из_списка(self):
        tree(self.root, ["deploy/Caddyfile", "deploy/Dockerfile", "deploy/notes", "deploy/bootstrap.sh"])
        got = {str(p) for p in corpus.collect(self.root)}
        self.assertEqual(got, {"deploy/Caddyfile", "deploy/Dockerfile", "deploy/bootstrap.sh"})

    def test_readme_единиц_вне_списка_кода(self):
        tree(self.root, ["atlas/README.md", "atlas/build.js", "rag/README.md"])
        got = {str(p) for p in corpus.collect(self.root)}
        self.assertEqual(got, {"atlas/README.md", "rag/README.md"})

    def test_пустое_дерево_даёт_пустой_список(self):
        self.assertEqual(corpus.collect(self.root), [])


class CopyTest(unittest.TestCase):
    def test_копия_сохраняет_пути_и_пишет_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "src"
            out = Path(tmp) / "out"
            tree(root, ["AGENTS.md", "agent_docs/a.md"])
            count = corpus.copy_to(root, out)
            self.assertEqual(count, 2)
            self.assertTrue((out / "agent_docs/a.md").is_file())
            self.assertEqual(corpus.read_commit(out), "unknown")

    def test_повторная_копия_не_оставляет_удалённого_файла(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, out = Path(tmp) / "src", Path(tmp) / "out"
            tree(root, ["AGENTS.md", "agent_docs/a.md"])
            corpus.copy_to(root, out)
            (root / "agent_docs/a.md").unlink()
            corpus.copy_to(root, out)
            self.assertFalse((out / "agent_docs/a.md").exists())

    def test_пустой_корпус_даёт_ненулевой_код_возврата(self):
        with tempfile.TemporaryDirectory() as tmp:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = corpus.main(["--root", tmp, "--out", f"{tmp}/out"])
            self.assertEqual(code, 1)


class ReadCommitTest(unittest.TestCase):
    """Граница `read_commit` — долг захода 3 (ADR 2026-09-29-2139, п. 9).

    До этой правки функция отдавала содержимое файла как есть. Значение
    уходит на ОТКРЫТЫЙ `/rag/healthz` и в каждый результат поиска, и дальше
    его никто не проверяет — то есть что угодно любой длины, попавшее в
    `COMMIT` тома или образа, печаталось бы в публичный ответ дословно.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, text: str) -> str:
        (self.dir / "COMMIT").write_text(text, encoding="utf-8")
        return corpus.read_commit(self.dir)

    def test_годная_форма_проходит_как_есть(self):
        self.assertEqual(self.write("a1b2c3d\n"), "a1b2c3d")
        self.assertEqual(self.write("0" * 40 + "\n"), "0" * 40)

    def test_нет_файла_это_unknown(self):
        self.assertEqual(corpus.read_commit(self.dir), "unknown")

    def test_короче_семи_знаков_не_коммит(self):
        self.assertEqual(self.write("a1b2c3"), "unknown")

    def test_длиннее_сорока_знаков_не_коммит(self):
        self.assertEqual(self.write("a" * 41), "unknown")

    def test_не_шестнадцатеричное_не_коммит(self):
        for bad in ("ZZZZZZZZ", "A1B2C3D", "a1b2c3d-dirty", "../../etc/passwd"):
            self.assertEqual(self.write(bad), "unknown", bad)

    def test_чужой_файл_целиком_в_публичный_ответ_не_уезжает(self):
        # Ровно та форма, ради которой граница и заводится: в `COMMIT`
        # оказался не коммит, а содержимое чужого файла — и без границы оно
        # печаталось бы в публичный ответ дословно и целиком.
        #
        # Образец нарочно НЕ похож на настоящий ключ: шаг «Секреты не попали
        # в репозиторий» (docs-guard.yml) ловит образцы ключей в файлах
        # репозитория, и первая редакция этого теста его покраснила. Предмет
        # проверки от этого не меняется — он в длине и в форме, а не в том,
        # что именно за текст.
        self.assertEqual(self.write("строка чужого файла, не коммит\n" * 200), "unknown")

    def test_несколько_строк_не_склеиваются_в_годную_форму(self):
        self.assertEqual(self.write("a1b2c3d\ne4f5a6b\n"), "unknown")

    def test_unknown_от_git_остаётся_unknown(self):
        # `_commit` пишет ровно это слово, когда `git rev-parse` не сработал.
        self.assertEqual(self.write("unknown\n"), "unknown")


if __name__ == "__main__":
    unittest.main()


class CiRegexTest(unittest.TestCase):
    """Копии списка корпуса вне corpus.py покрывают его и совпадают между собой.

    Копий две, и у них разные роли:

    * `rag='…'` в `.github/workflows/ci.yml` решает, ПЕРЕСОБИРАТЬ ли образ;
    * `rag='…'` в `.github/scripts/deploy-units.sh` решает, ВЫКАТЫВАТЬ ли его.

    Держатель требуемого 3 ревьюера к PR #278: без него правка файла,
    который в корпусе есть, а в регулярке нет (так было с atlas/README.md),
    не запускает единицу rag — индекс стареет молча, и заметить это можно
    только чтением диффа. Вторая копия заведена заходом 3: без неё правка
    документа собирала бы образ в CI и не выкатывала его, то есть обещание
    «свежесть держится выкаткой» (ADR 2026-09-29-1639, п. 3) держалось бы
    на словах при зелёном прогоне.
    """

    ROOT = Path(__file__).resolve().parent.parent.parent
    CI = ROOT / ".github" / "workflows" / "ci.yml"
    DEPLOY = ROOT / ".github" / "scripts" / "deploy-units.sh"

    @staticmethod
    def _regex(path: Path) -> str:
        if not path.is_file():
            raise AssertionError(f"файл не найден: {path}")
        found = re.search(r"^\s*rag='(.+)'\s*$", path.read_text(encoding="utf-8"), re.MULTILINE)
        if not found:
            raise AssertionError(f"в {path.name} нет строки rag='…' — регулярку корпуса не с чем сверять")
        return found.group(1)

    @classmethod
    def setUpClass(cls) -> None:
        cls.ci_source = cls._regex(cls.CI)
        cls.deploy_source = cls._regex(cls.DEPLOY)
        # Регулярка живёт в YAML внутри shell: `\\.` там — экранированная
        # точка для grep, в Python это `\.`.
        cls.pattern = re.compile(cls.ci_source.replace("\\\\", "\\"))
        cls.corpus = corpus.collect(cls.ROOT)

    def test_сборка_и_выкатка_смотрят_на_одну_регулярку(self):
        # Разойтись им есть куда: файла два, правят их порознь. Разойдясь, они
        # дают самый тихий отказ из возможных — образ собран, выкатка зелёная,
        # а на машине старый индекс.
        self.assertEqual(self.ci_source, self.deploy_source)

    def test_регулярка_из_ci_покрывает_каждый_путь_корпуса(self):
        missed = [str(p) for p in self.corpus if not self.pattern.search(str(p))]
        self.assertEqual(missed, [])

    def test_корпус_не_пуст_иначе_проверка_ничего_не_значит(self):
        self.assertGreater(len(self.corpus), 100)

    def test_путь_вне_корпуса_регуляркой_не_ловится(self):
        # Иначе «покрывает всё» выполнялось бы регуляркой `^` — и шаг
        # запускал бы rag на любой правке, а тест выше был бы зелёным.
        for alien in ("days/day1/server.js", ".agents/skills/x/SKILL.md", "atlas/build.js"):
            self.assertIsNone(self.pattern.search(alien), alien)
