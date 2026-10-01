import unittest

from embed import EmbedError, OllamaEmbedder
from test.fakeollama import FakeOllama

TWO = {"embeddings": [[1.0, 0.0], [0.0, 1.0]]}


class EmbedTest(unittest.TestCase):
    def test_запрос_несёт_модель_и_список_текстов(self):
        with FakeOllama({"/api/embed": (200, TWO)}) as fake:
            got = OllamaEmbedder(fake.url, "embeddinggemma").embed(["а", "б"])
            self.assertEqual(got, TWO["embeddings"])
            path, payload = fake.requests[0]
            self.assertEqual(path, "/api/embed")
            self.assertEqual(payload, {"model": "embeddinggemma", "input": ["а", "б"]})

    def test_пустой_список_не_ходит_в_сеть(self):
        with FakeOllama({}) as fake:
            e = OllamaEmbedder(fake.url, "m")
            self.assertEqual(e.embed([]), [])
            self.assertEqual(fake.requests, [])
            self.assertEqual(e.calls, 0)

    def test_считает_вызовы_и_векторы(self):
        with FakeOllama({"/api/embed": (200, TWO)}) as fake:
            e = OllamaEmbedder(fake.url, "m")
            e.embed(["а", "б"])
            e.embed(["а", "б"])
            self.assertEqual((e.calls, e.vectors), (2, 4))

    def test_векторов_меньше_чем_текстов_это_отказ(self):
        with FakeOllama({"/api/embed": (200, {"embeddings": [[1.0]]})}) as fake:
            with self.assertRaises(EmbedError):
                OllamaEmbedder(fake.url, "m").embed(["а", "б"])

    def test_разная_размерность_это_отказ(self):
        body = {"embeddings": [[1.0, 0.0], [0.0]]}
        with FakeOllama({"/api/embed": (200, body)}) as fake:
            with self.assertRaises(EmbedError):
                OllamaEmbedder(fake.url, "m").embed(["а", "б"])

    def test_ответ_без_поля_embeddings_это_отказ(self):
        with FakeOllama({"/api/embed": (200, {"error": "model not found"})}) as fake:
            with self.assertRaises(EmbedError):
                OllamaEmbedder(fake.url, "m").embed(["а"])

    def test_http_500_это_отказ(self):
        with FakeOllama({"/api/embed": (500, {"error": "boom"})}) as fake:
            with self.assertRaises(EmbedError):
                OllamaEmbedder(fake.url, "m").embed(["а"])

    def test_тело_отказа_попадает_в_текст_исключения(self):
        """Иначе `400` от службы выглядит одинаково при любой причине.

        На этом и сорвались два диагноза подряд по стратегии `structural`:
        код печатал «HTTP 400» и выбрасывал тело, а причину приходилось
        угадывать по косвенным признакам.
        """
        тело = {"error": "input length exceeds the context length"}
        with FakeOllama({"/api/embed": (400, тело)}) as fake:
            with self.assertRaises(EmbedError) as поймано:
                OllamaEmbedder(fake.url, "m").embed(["а"])
        текст = str(поймано.exception)
        self.assertIn("HTTP 400", текст)
        self.assertIn("input length exceeds the context length", текст,
                      "тело ответа выброшено — причина отказа невосстановима")
        # Что тело НЕ уходит наружу, держат два теста на `main`, которые этот
        # PR не трогает: `test_serve.PublicReasonTest` (набор причин закрыт и
        # каждая в нём) и `test_адрес_эмбеддера_не_попадает_в_ответ_ручки` —
        # второй держит весь путь `run_build` → `/healthz`, то есть сильнее
        # прямого вызова `reason`. Свой тест здесь был бы со-расположением, а
        # не держателем: мутацию `reason` он красит третьим, после них
        # (находка reviewer и compliance к #287).

    def test_длинное_тело_обрезается(self):
        with FakeOllama({"/api/embed": (400, {"error": "я" * 5000})}) as fake:
            with self.assertRaises(EmbedError) as поймано:
                OllamaEmbedder(fake.url, "m").embed(["а"])
        self.assertLess(len(str(поймано.exception)), 600)


    def test_ответ_не_json_это_отказ(self):
        with FakeOllama({"/api/embed": (200, b"not json")}) as fake:
            with self.assertRaises(EmbedError):
                OllamaEmbedder(fake.url, "m").embed(["а"])

    def test_службы_нет_это_отказ_а_не_пустой_список(self):
        with FakeOllama({}) as fake:
            url = fake.url
        with self.assertRaises(EmbedError):
            OllamaEmbedder(url, "m", timeout=2).embed(["а"])


class TagsTest(unittest.TestCase):
    def test_модель_с_тегом_latest_считается_той_же(self):
        body = {"models": [{"name": "embeddinggemma:latest"}, {"name": "qwen3:8b"}]}
        with FakeOllama({"/api/tags": (200, body)}) as fake:
            self.assertTrue(OllamaEmbedder(fake.url, "embeddinggemma").has_model())
            self.assertFalse(OllamaEmbedder(fake.url, "bge-m3").has_model())

    def test_tags_без_связи_это_отказ(self):
        with FakeOllama({}) as fake:
            url = fake.url
        with self.assertRaises(EmbedError):
            OllamaEmbedder(url, "m").tags()

    def test_pull_без_success_это_отказ(self):
        with FakeOllama({"/api/pull": (200, {"status": "pulling"})}) as fake:
            with self.assertRaises(EmbedError):
                OllamaEmbedder(fake.url, "m").pull()

    def test_pull_шлёт_имя_модели(self):
        with FakeOllama({"/api/pull": (200, {"status": "success"})}) as fake:
            OllamaEmbedder(fake.url, "embeddinggemma").pull()
            self.assertEqual(fake.requests[0][1]["model"], "embeddinggemma")


if __name__ == "__main__":
    unittest.main()


class ИмяМоделиСверяетсяЦеликом(unittest.TestCase):
    """Сравнение до двоеточия делало смену модели молчаливым no-op."""

    def эмбеддер(self, заказ, теги):
        e = OllamaEmbedder("http://x", заказ)
        e.tags = lambda: теги
        return e

    def test_чужой_тег_той_же_модели_не_считается_своим(self):
        e = self.эмбеддер("embeddinggemma:300m-qat-q4_0", ["embeddinggemma:latest"])
        self.assertFalse(e.has_model())

    def test_свой_тег_считается_своим(self):
        e = self.эмбеддер("embeddinggemma:300m-qat-q4_0",
                          ["embeddinggemma:latest", "embeddinggemma:300m-qat-q4_0"])
        self.assertTrue(e.has_model())

    def test_имя_без_тега_разворачивается_в_latest(self):
        self.assertTrue(self.эмбеддер("embeddinggemma", ["embeddinggemma:latest"]).has_model())
        self.assertFalse(self.эмбеддер("embeddinggemma", ["embeddinggemma:300m-bf16"]).has_model())
