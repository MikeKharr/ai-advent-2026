import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from index import VectorIndex, normalize

META = [
    {"sha256": "aa", "source": "a.md", "text": "про лимитер"},
    {"sha256": "bb", "source": "b.md", "text": "про Caddy"},
    {"sha256": "cc", "source": "c.md", "text": "про атлас"},
]
VECS = np.asarray([[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype="float32")


def built() -> VectorIndex:
    return VectorIndex.build("fixed", META, VECS)


class BuildTest(unittest.TestCase):
    def test_ближайший_вектор_первый_и_оценка_это_косинус(self):
        hits = built().search(np.asarray([1.0, 0.0]), k=3)
        self.assertEqual(hits[0][1]["source"], "a.md")
        self.assertAlmostEqual(hits[0][0], 1.0, places=5)
        self.assertAlmostEqual(hits[1][0], 2 ** -0.5, places=5)

    def test_оценки_убывают(self):
        scores = [s for s, _ in built().search(np.asarray([0.3, 1.0]), k=3)]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_k_больше_числа_векторов_не_падает(self):
        self.assertEqual(len(built().search(np.asarray([1.0, 0.0]), k=99)), 3)

    def test_число_метаданных_обязано_совпасть_с_числом_векторов(self):
        with self.assertRaises(ValueError):
            VectorIndex.build("fixed", META[:2], VECS)

    def test_нулевой_вектор_не_даёт_nan(self):
        got = normalize(np.asarray([[0.0, 0.0]], dtype="float32"))
        self.assertFalse(np.isnan(got).any())

    def test_пустой_плоский_массив_не_падает_на_оси(self):
        # normalize берёт длину по оси 1; на `np.asarray([])` это AxisError,
        # и охранники `if len(vectors)` ниже были мёртвыми (нит reviewer).
        empty = VectorIndex.build("fixed", [], np.asarray([], dtype="float32"))
        self.assertEqual(empty.index.ntotal, 0)
        self.assertEqual(empty.search(np.asarray([1.0, 0.0]), 5), [])

    def test_поиск_в_пустом_индексе_возвращает_пусто(self):
        self.assertEqual(VectorIndex.build("fixed", [], np.zeros((0, 2), "float32")).search(np.asarray([1.0, 0.0]), 5), [])


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_сохранение_и_чтение_дают_тот_же_ответ(self):
        built().save(self.dir)
        loaded = VectorIndex.load(self.dir, "fixed")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.search(np.asarray([0.0, 1.0]), 1)[0][1]["source"], "b.md")

    def test_векторы_достаются_из_тома_по_sha256(self):
        built().save(self.dir)
        by_sha = VectorIndex.load(self.dir, "fixed").vectors_by_sha()
        self.assertEqual(sorted(by_sha), ["aa", "bb", "cc"])
        np.testing.assert_allclose(by_sha["aa"], normalize(VECS)[0], atol=1e-6)

    def test_индекса_нет_когда_нет_файлов(self):
        self.assertIsNone(VectorIndex.load(self.dir, "fixed"))

    def test_разъехавшаяся_пара_читается_как_отсутствие_индекса(self):
        built().save(self.dir)
        _, meta_path = VectorIndex.paths(self.dir, "fixed")
        meta_path.write_text(json.dumps({"strategy": "fixed", "chunks": META[:1]}), encoding="utf-8")
        self.assertIsNone(VectorIndex.load(self.dir, "fixed"))

    def test_стратегии_лежат_раздельно(self):
        built().save(self.dir)
        VectorIndex.build("structural", META[:1], VECS[:1]).save(self.dir)
        self.assertEqual(VectorIndex.load(self.dir, "fixed").index.ntotal, 3)
        self.assertEqual(VectorIndex.load(self.dir, "structural").index.ntotal, 1)


if __name__ == "__main__":
    unittest.main()


class ИндексПомнитМодель(unittest.TestCase):
    """Векторы разных моделей одной размерности — смесь не даёт ни ошибки, ни признака."""

    def setUp(self):
        self.каталог = Path(tempfile.mkdtemp())
        self.мета = [{"sha256": "a" * 64, "source": "x.md", "section": "x", "text": "t"}]
        self.векторы = np.asarray([[0.1, 0.2, 0.3]], dtype="float32")

    def test_имя_модели_попадает_в_метаданные(self):
        VectorIndex.build("fixed", self.мета, self.векторы, "модель-1").save(self.каталог)
        _, meta_path = VectorIndex.paths(self.каталог, "fixed")
        self.assertEqual(json.loads(meta_path.read_text(encoding="utf-8"))["model"],
                         "модель-1")

    def test_индекс_своей_модели_читается(self):
        VectorIndex.build("fixed", self.мета, self.векторы, "модель-1").save(self.каталог)
        self.assertIsNotNone(VectorIndex.load(self.каталог, "fixed", "модель-1"))

    def test_индекс_чужой_модели_читается_как_отсутствующий(self):
        VectorIndex.build("fixed", self.мета, self.векторы, "модель-1").save(self.каталог)
        self.assertIsNone(VectorIndex.load(self.каталог, "fixed", "модель-2"))

    def test_индекс_без_имени_модели_считается_чужим(self):
        # Индексы, собранные до этой правки, имени не несут — переиспользовать
        # их нельзя: какой моделью они собраны, установить нечем.
        VectorIndex.build("fixed", self.мета, self.векторы).save(self.каталог)
        self.assertIsNone(VectorIndex.load(self.каталог, "fixed", "модель-1"))

    def test_без_запроса_модели_читается_любой(self):
        # Совместимость для вызовов, которым модель не важна (поиск по готовому).
        VectorIndex.build("fixed", self.мета, self.векторы, "модель-1").save(self.каталог)
        self.assertIsNotNone(VectorIndex.load(self.каталог, "fixed"))
