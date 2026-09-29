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
