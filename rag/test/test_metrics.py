import unittest

import metrics


def hits(sources: list[str], texts: list[str] | None = None) -> list[dict]:
    texts = texts or ["" for _ in sources]
    return [{"source": s, "text": t} for s, t in zip(sources, texts)]


class RecallTest(unittest.TestCase):
    def test_оба_ожидаемых_документа_в_первых_пяти(self):
        got = metrics.recall_at_k(["a", "x", "b", "y", "z"], ["a", "b"])
        self.assertEqual(got, 1.0)

    def test_один_из_двух_даёт_половину(self):
        self.assertEqual(metrics.recall_at_k(["a", "x", "y", "z", "w"], ["a", "b"]), 0.5)

    def test_шестая_позиция_уже_не_считается(self):
        self.assertEqual(metrics.recall_at_k(["x", "x", "x", "x", "x", "a"], ["a"]), 0.0)

    def test_повтор_документа_не_надувает_recall(self):
        self.assertEqual(metrics.recall_at_k(["a", "a", "a", "a", "a"], ["a", "b"]), 0.5)


class MrrTest(unittest.TestCase):
    def test_первая_позиция_даёт_единицу(self):
        self.assertEqual(metrics.reciprocal_rank(["a", "b"], ["a"]), 1.0)

    def test_третья_позиция_даёт_треть(self):
        self.assertAlmostEqual(metrics.reciprocal_rank(["x", "y", "a"], ["a"]), 1 / 3)

    def test_за_десятой_позицией_ноль(self):
        self.assertEqual(metrics.reciprocal_rank(["x"] * 10 + ["a"], ["a"]), 0.0)


class PhraseTest(unittest.TestCase):
    def test_перенос_строки_и_неразрывный_пробел_не_мешают(self):
        self.assertTrue(metrics.phrase_in_first(["проверка лимита\nпредшествует вызову"], "Проверка лимита предшествует вызову"))

    def test_фраза_во_втором_чанке_не_засчитывается(self):
        self.assertFalse(metrics.phrase_in_first(["другое", "нужная фраза"], "нужная фраза"))

    def test_пустая_выдача_не_падает(self):
        self.assertFalse(metrics.phrase_in_first([], "что угодно"))


class ScoreTest(unittest.TestCase):
    def test_сводка_считает_все_четыре_числа(self):
        results = [
            ({"expected": ["a.md"], "phrase": "нужное"}, hits(["a.md", "b.md"], ["нужное тут", ""])),
            ({"expected": ["c.md"], "phrase": None}, hits(["x.md", "c.md"])),
        ]
        got = metrics.score(results)
        self.assertEqual(got["queries"], 2)
        self.assertEqual(got["recall@5"], 1.0)
        self.assertEqual(got["mrr@10"], 0.75)
        self.assertEqual(got["phrase_queries"], 1)
        self.assertEqual(got["phrase_in_first_chunk"], 1.0)

    def test_без_вопросов_с_фразой_доля_не_выдумывается(self):
        got = metrics.score([({"expected": ["a.md"], "phrase": None}, hits(["a.md"]))])
        self.assertIsNone(got["phrase_in_first_chunk"])


if __name__ == "__main__":
    unittest.main()
