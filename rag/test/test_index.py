import json
import shutil
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
    return VectorIndex.build("fixed", META, VECS, "модель:latest")


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
            VectorIndex.build("fixed", META[:2], VECS, "модель:latest")

    def test_нулевой_вектор_не_даёт_nan(self):
        got = normalize(np.asarray([[0.0, 0.0]], dtype="float32"))
        self.assertFalse(np.isnan(got).any())

    def test_пустой_плоский_массив_не_падает_на_оси(self):
        # normalize берёт длину по оси 1; на `np.asarray([])` это AxisError,
        # и охранники `if len(vectors)` ниже были мёртвыми (нит reviewer).
        empty = VectorIndex.build("fixed", [], np.asarray([], dtype="float32"), "модель:latest")
        self.assertEqual(empty.index.ntotal, 0)
        self.assertEqual(empty.search(np.asarray([1.0, 0.0]), 5), [])

    def test_поиск_в_пустом_индексе_возвращает_пусто(self):
        self.assertEqual(VectorIndex.build("fixed", [], np.zeros((0, 2), "float32"), "м").search(np.asarray([1.0, 0.0]), 5), [])


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_сохранение_и_чтение_дают_тот_же_ответ(self):
        built().save(self.dir)
        loaded = VectorIndex.load(self.dir, "fixed", "модель:latest")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.search(np.asarray([0.0, 1.0]), 1)[0][1]["source"], "b.md")

    def test_векторы_достаются_из_тома_по_sha256(self):
        built().save(self.dir)
        by_sha = VectorIndex.load(self.dir, "fixed", "модель:latest").vectors_by_sha()
        self.assertEqual(sorted(by_sha), ["aa", "bb", "cc"])
        np.testing.assert_allclose(by_sha["aa"], normalize(VECS)[0], atol=1e-6)

    def test_индекса_нет_когда_нет_файлов(self):
        self.assertIsNone(VectorIndex.load(self.dir, "fixed", "модель:latest"))

    def test_разъехавшаяся_пара_читается_как_отсутствие_индекса(self):
        built().save(self.dir)
        _, meta_path = VectorIndex.paths(self.dir, "fixed")
        # Поле `model` обязательно: сверка модели стоит ВЫШЕ сверки длин, и без
        # него тест уходил бы по модельному гейту, не доходя до своей ветви.
        # Находка compliance к PR #286: держатель был жив на main и умер здесь.
        meta_path.write_text(
            json.dumps({"strategy": "fixed", "model": "модель:latest", "chunks": META[:1]}),
            encoding="utf-8")
        self.assertIsNone(VectorIndex.load(self.dir, "fixed", "модель:latest"))

    def test_стратегии_лежат_раздельно(self):
        built().save(self.dir)
        VectorIndex.build("structural", META[:1], VECS[:1], "модель:latest").save(self.dir)
        self.assertEqual(VectorIndex.load(self.dir, "fixed", "модель:latest").index.ntotal, 3)
        self.assertEqual(VectorIndex.load(self.dir, "structural", "модель:latest").index.ntotal, 1)


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
        """Это состояние тома в проде на момент выкатки, а не край.

        Индекс там собран до появления поля `model`, имени не несёт, и какой
        моделью собран — установить нечем. Прежняя редакция теста строила
        индекс С моделью и была дублем соседнего: находка reviewer.
        """
        VectorIndex.build("fixed", self.мета, self.векторы, "модель-1").save(self.каталог)
        _, meta_path = VectorIndex.paths(self.каталог, "fixed")
        сырое = json.loads(meta_path.read_text(encoding="utf-8"))
        сырое.pop("model")
        meta_path.write_text(json.dumps(сырое, ensure_ascii=False), encoding="utf-8")
        self.assertIsNone(VectorIndex.load(self.каталог, "fixed", "модель-1"))

    def test_загруженный_индекс_помнит_свою_модель(self):
        # Модель служащего индекса видна снаружи через project.status —
        # см. test_tools, состояние несёт поле `model`.
        VectorIndex.build("fixed", self.мета, self.векторы, "модель-1").save(self.каталог)
        self.assertEqual(VectorIndex.load(self.каталог, "fixed", "модель-1").model,
                         "модель-1")


class МодельОбязательнаВезде(unittest.TestCase):
    """Держатель на класс, а не на место: проводку проверяли в сборке, и она
    держалась, а поиск и мера грузили индекс без модели — молча и часами.
    """

    def test_все_места_загрузки_передают_модель(self):
        import ast
        import pathlib

        корень = pathlib.Path(__file__).resolve().parent.parent
        мест = 0
        for файл in list(корень.glob("*.py")) + list((корень / "eval").glob("*.py")):
            дерево = ast.parse(файл.read_text(encoding="utf-8"))
            for узел in ast.walk(дерево):
                if not isinstance(узел, ast.Call):
                    continue
                ф = узел.func
                if not (isinstance(ф, ast.Attribute) and ф.attr == "load"
                        and isinstance(ф.value, ast.Name) and ф.value.id == "VectorIndex"):
                    continue
                мест += 1
                аргументы = узел.args + [к.value for к in узел.keywords]
                self.assertGreaterEqual(
                    len(аргументы), 3,
                    f"{файл.name}:{узел.lineno} грузит индекс без модели")
                модель = аргументы[-1]
                # «Аргумент передан» мало: `load(d, s, "")` это проходил бы,
                # а пустая строка снова пропускает любой индекс.
                self.assertFalse(
                    isinstance(модель, ast.Constant) and not модель.value,
                    f"{файл.name}:{узел.lineno} передаёт пустую модель")
        self.assertGreaterEqual(мест, 3, "мест загрузки стало меньше — проверка выродилась")

    def test_модель_нельзя_не_передать(self):
        # Умолчание `model: str = ""` пропускало любой индекс и дало выжить
        # мутации «проводка снята». Аргумент обязателен.
        каталог = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, каталог, True)
        with self.assertRaises(TypeError):
            VectorIndex.load(каталог, "fixed")
