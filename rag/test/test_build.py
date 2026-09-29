import tempfile
import unittest
from pathlib import Path

import build
import chunking
import corpus
from embed import OllamaEmbedder
from test.fakeollama import FakeOllama

ROUTES = {"/api/embed": (200, FakeOllama.deterministic)}


def corpus_tree(root: Path) -> None:
    (root / "agent_docs").mkdir(parents=True)
    (root / "AGENTS.md").write_text("# Правила\n\nтело правил\n", encoding="utf-8")
    (root / "agent_docs" / "invariants.md").write_text(
        "# Инварианты\n\n## I-4\n\nлимит до вызова\n", encoding="utf-8"
    )
    (root / "COMMIT").write_text("deadbeef\n", encoding="utf-8")


class ReadChunksTest(unittest.TestCase):
    def test_чанки_несут_коммит_корпуса_и_путь_источника(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            corpus_tree(root)
            chunks = build.read_chunks(root, "structural")
            self.assertTrue(chunks)
            self.assertEqual({c.commit for c in chunks}, {"deadbeef"})
            self.assertEqual({c.source for c in chunks}, {"AGENTS.md", "agent_docs/invariants.md"})
            self.assertEqual({c.strategy for c in chunks}, {"structural"})


class IncrementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "corpus"
        self.index = Path(self.tmp.name) / "index"
        corpus_tree(self.root)

    def build_once(self, fake) -> dict:
        embedder = OllamaEmbedder(fake.url, "m")
        chunks = build.read_chunks(self.root, "fixed")
        return build.build_strategy("fixed", chunks, embedder, self.index)

    def test_первая_сборка_эмбеддит_все_чанки(self):
        with FakeOllama(ROUTES) as fake:
            stats = self.build_once(fake)
            self.assertEqual(stats["embedded"], stats["count"])
            self.assertEqual(stats["reused"], 0)
            self.assertGreater(stats["embed_calls"], 0)

    def test_повтор_без_правок_не_зовёт_эмбеддер_вовсе(self):
        with FakeOllama(ROUTES) as fake:
            first = self.build_once(fake)
            second = self.build_once(fake)
        self.assertEqual(second["embedded"], 0)
        self.assertEqual(second["embed_calls"], 0)
        self.assertEqual(second["reused"], first["count"])

    def test_правка_документа_переэмбеддит_только_изменившееся(self):
        with FakeOllama(ROUTES) as fake:
            first = self.build_once(fake)
            (self.root / "AGENTS.md").write_text("# Правила\n\nдругое тело\n", encoding="utf-8")
            second = self.build_once(fake)
        self.assertEqual(second["embedded"], 1)
        self.assertEqual(second["reused"], first["count"] - 1)

    def test_размер_пачки_задаёт_число_вызовов(self):
        with FakeOllama(ROUTES) as fake:
            embedder = OllamaEmbedder(fake.url, "m")
            chunks = build.read_chunks(self.root, "fixed")
            stats = build.build_strategy("fixed", chunks, embedder, self.index, batch=1)
        self.assertEqual(stats["embed_calls"], stats["count"])


class StatsTest(unittest.TestCase):
    def test_статистика_чанков_считает_медиану_и_долю_разрезанных(self):
        chunks = [
            chunking.Chunk("a.md", "t", "", "a.md#0", "fixed", "```js\nconst a = 1"),
            chunking.Chunk("a.md", "t", "", "a.md#1", "fixed", "```\nхвост"),
            chunking.Chunk("b.md", "t", "", "b.md#0", "fixed", "целый текст"),
        ]
        stats = build.chunk_stats(chunks)
        self.assertEqual(stats["count"], 3)
        self.assertEqual(stats["median_chars"], len("целый текст"))
        self.assertAlmostEqual(stats["cut_blocks_share"], 2 / 3, places=3)

    def test_пустой_набор_не_делит_на_ноль(self):
        self.assertEqual(build.chunk_stats([])["count"], 0)


if __name__ == "__main__":
    unittest.main()
