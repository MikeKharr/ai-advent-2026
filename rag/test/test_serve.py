import json
import threading
import unittest
import urllib.error
import urllib.request

import serve


class HealthzTest(unittest.TestCase):
    def setUp(self):
        self.status = serve.Status()
        self.server = serve.make_server(self.status, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path: str):
        with urllib.request.urlopen(f"{self.url}{path}", timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_healthz_отвечает_200_и_называет_состояние(self):
        status, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "starting")

    def test_healthz_остаётся_200_когда_сборка_не_удалась(self):
        # Выкатка не должна ждать часы первой сборки: 200 значит «единица
        # поднялась», состояние индекса — в теле.
        self.status.update(state="failed", error="EmbedError: нет связи")
        status, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "failed")
        self.assertIn("нет связи", body["error"])

    def test_маршрут_за_caddy_тот_же(self):
        self.assertEqual(self.get("/rag/healthz")[0], 200)

    def test_прочие_пути_дают_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/tools/call")
        self.assertEqual(caught.exception.code, 404)

    def test_состояние_читается_и_пишется_из_разных_потоков(self):
        done = threading.Event()

        def writer():
            for i in range(200):
                self.status.update(state=f"building-{i}")
            done.set()

        threading.Thread(target=writer, daemon=True).start()
        for _ in range(50):
            self.assertIn("state", self.status.read())
        done.wait(5)
        self.assertTrue(done.is_set())


if __name__ == "__main__":
    unittest.main()
