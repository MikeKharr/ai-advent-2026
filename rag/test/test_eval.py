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

    def test_сто_вопросов_с_разными_идентификаторами(self):
        self.assertEqual(len(self.queries), 100)
        ids = [q["id"] for q in self.queries]
        self.assertEqual(len(set(ids)), 100)

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


class РазборПоВопросу(unittest.TestCase):
    """Разбор, который покажет страница итогов, не вправе расходиться с метрикой.

    Таблица по вопросам и сводный MRR@10 считаются из одних и тех же
    найденных чанков: если ранг в таблице и обратный ранг в MRR разойдутся,
    страница будет показывать одно, а цифры — другое.
    """

    def hits(self, sources):
        return [(1.0 - i / 10, {"source": s, "section": f"§{i}", "text": f"текст {s} номер {i} " * 30})
                for i, s in enumerate(sources)]

    def test_ранг_первого_верного_документа(self):
        import eval.run as run
        q = {"id": "q", "question": "?", "expected": ["нужный.md"]}
        d = run.detail_for(q, self.hits(["a.md", "b.md", "нужный.md", "нужный.md"]))
        self.assertEqual(d["rank"], 3)

    def test_нет_в_первых_k_значит_ранга_нет(self):
        import eval.run as run
        q = {"id": "q", "question": "?", "expected": ["нужный.md"]}
        self.assertIsNone(run.detail_for(q, self.hits(["a.md", "b.md"]))["rank"])

    def test_ранг_сходится_с_обратным_рангом_метрики(self):
        import eval.run as run
        q = {"id": "q", "question": "?", "expected": ["нужный.md"]}
        for sources in (["нужный.md"], ["a.md", "нужный.md"], ["a.md", "b.md", "c.md", "нужный.md"], ["a.md"]):
            d = run.detail_for(q, self.hits(sources))
            rr = metrics.reciprocal_rank(sources, q["expected"])
            self.assertEqual(rr, 0.0 if d["rank"] is None else 1 / d["rank"], sources)

    def test_выдержка_обрезана_и_трёх_найденных_хватает(self):
        import eval.run as run
        q = {"id": "q", "question": "?", "expected": ["x.md"]}
        d = run.detail_for(q, self.hits(["a.md", "b.md", "c.md", "d.md", "e.md"]))
        self.assertEqual(len(d["top"]), 3)
        self.assertTrue(all(len(t["excerpt"]) <= run.EXCERPT for t in d["top"]))

    def test_статистика_нарезки_тем_же_правилом_что_сборка(self):
        # Страница и журнал сборки обязаны показывать одну медиану одного индекса:
        # оба считают len(text), а не длину текста для эмбеддинга.
        import eval.run as run
        meta = [{"text": "а" * n} for n in (10, 30, 20, 40)]
        self.assertEqual(run.chunk_summary(meta), {"chunks": 4, "len_median": 25, "len_max": 40})
        self.assertEqual(run.chunk_summary([]), {"chunks": 0, "len_median": 0, "len_max": 0})


class ПолныйПрогонСРазбором(unittest.TestCase):
    """Шапка и поля, которые читает страница итогов дня 21, держатся прогоном.

    Без этого выкинутый из вывода `commit` или `label` оставлял зелёным весь
    набор (находка reviewer к #294), а страница при этом теряла бы подвал или
    подписи стратегий молча.
    """

    def test_прогон_с_разбором_несёт_шапку_и_поля_страницы(self):
        import json
        import tempfile

        import numpy as np

        import eval.run as run
        from embed import OllamaEmbedder
        from index import VectorIndex
        from test.fakeollama import FakeOllama

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            texts = ["первый раздел про лимиты", "второй раздел про выкатку"]
            vecs = FakeOllama.deterministic({"input": texts})["embeddings"]
            for strategy in run.STRATEGIES:
                meta = [{"source": f"d{i}.md", "section": f"§{i}", "text": t,
                         "commit": "abcdef1234", "strategy": strategy}
                        for i, t in enumerate(texts)]
                VectorIndex.build(strategy, meta, np.asarray(vecs, dtype="float32"), "m").save(tmp)
            qpath = tmp / "q.json"
            qpath.write_text(json.dumps({"queries": [
                {"id": "q1", "question": texts[0], "expected": ["d0.md"]},
            ]}, ensure_ascii=False), encoding="utf-8")
            with FakeOllama({"/api/embed": (200, FakeOllama.deterministic)}) as fake:
                out = run.run(tmp, qpath, OllamaEmbedder(fake.url, "m"), detail=True)

        self.assertEqual(out["commit"], "abcdef1")
        self.assertEqual(out["model"], "m")
        self.assertEqual(out["corpus"], {"files": 2})
        self.assertRegex(out["generated"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        for strategy in run.STRATEGIES:
            for key in ("label", "about", "chunks", "len_median", "len_max", "recall@5", "mrr@10"):
                self.assertIn(key, out[strategy], f"{strategy}.{key}")
        self.assertEqual([q["id"] for q in out["queries"]], ["q1"])
        self.assertEqual(out["queries"][0]["fixed"]["rank"], 1)
