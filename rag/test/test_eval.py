"""Набор вопросов сверяется с настоящим корпусом, а не с представлением автора.

Мера бесполезна, если ожидаемого документа в индексе нет вовсе или фразы
нет в файле: тогда показатель меряет опечатку, а не стратегию.
"""

import unittest
from pathlib import Path

import corpus
import metrics

RAG = Path(__file__).resolve().parent.parent
ROOT = RAG.parent
QUERIES = RAG / "eval" / "queries.json"


class QueriesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Тест смотрит на дерево репозитория. Его отсутствие — не повод
        # пропустить проверку молча.
        if not (ROOT / "AGENTS.md").is_file():
            raise AssertionError(f"корень репозитория не найден: {ROOT}")
        cls.queries = metrics.load_queries(QUERIES)
        cls.corpus = {str(p) for p in corpus.collect(ROOT)}

    def test_тридцать_вопросов_с_разными_идентификаторами(self):
        self.assertEqual(len(self.queries), 30)
        ids = [q["id"] for q in self.queries]
        self.assertEqual(len(set(ids)), 30)

    def test_у_каждого_вопроса_есть_текст_и_ожидаемые_документы(self):
        for q in self.queries:
            self.assertTrue(q["question"].strip(), q["id"])
            self.assertTrue(q["expected"], q["id"])

    def test_каждый_ожидаемый_документ_есть_в_корпусе(self):
        missing = [(q["id"], e) for q in self.queries for e in q["expected"] if e not in self.corpus]
        self.assertEqual(missing, [])

    def test_каждая_фраза_есть_в_своём_документе(self):
        missing = []
        for q in self.queries:
            phrase = q.get("phrase")
            if not phrase:
                continue
            found = any(
                metrics._norm(phrase) in metrics._norm((ROOT / e).read_text(encoding="utf-8", errors="replace"))
                for e in q["expected"]
            )
            if not found:
                missing.append((q["id"], phrase))
        self.assertEqual(missing, [])

    def test_фраза_есть_хотя_бы_у_части_вопросов(self):
        with_phrase = [q for q in self.queries if q.get("phrase")]
        self.assertGreaterEqual(len(with_phrase), 5)


if __name__ == "__main__":
    unittest.main()
