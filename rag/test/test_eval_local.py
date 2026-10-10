"""Обвязка замеров дней 26–30: метрики, признаки, промпт и два стража записи.

Что здесь проверяется и чего здесь нет. Нет живой Ollama: все вызовы идут в
подложную (`test/fakeollama.py`) либо в подставленную функцию. Непроверенным
остаётся только собственный контракт Ollama — ровно та граница, что у
остальных тестов этой единицы.

Четыре группы стоят отдельно и названы прямо, потому что они и есть
«что держит» этого PR:

* `СтражТекстовБезОтказов` — тексты сборки Q6_K не уходят в публичный файл;
* `СтражАдресов` — адрес и имя машины частной сети не уходят туда же;
* `РендерФрагментовСходитсяСАгентом` — вторая копия промпта на Python не
  разъехалась с `buildRagInput` агента дня 22;
* `НормализацияСходитсяСДнём22` — нормализация сверки по фразе та же, что у
  `flatten` в `score.mjs`.

Последние две запускают настоящий Node против настоящих файлов дня 22 и
агентов. Node в этой единице уже используется шагом «Синтаксис» в `ci.yml`
(`node --check` по каждому `.js`), поэтому отдельного условия на его наличие
здесь нет: отсутствие Node — красный прогон со внятным текстом, а не молчаливый
пропуск.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RAG = Path(__file__).resolve().parent.parent
ROOT = RAG.parent
sys.path.insert(0, str(RAG / "eval"))

import checks  # noqa: E402
import day26_prompts  # noqa: E402
import day28_local_rag as day28  # noqa: E402
import day29_params  # noqa: E402
import day29_tuning as day29  # noqa: E402
import day30_probe as day30  # noqa: E402
import features  # noqa: E402
import ollama_client as client  # noqa: E402
import prompt as prompts  # noqa: E402
import report  # noqa: E402

from test.fakeollama import FakeOllama  # noqa: E402


def node(source: str) -> str:
    """Выполнить модуль Node из корня репозитория и вернуть его вывод.

    Корень — рабочий каталог намеренно: модули агента импортируются по
    относительным путям, и запуск из `rag/` нашёл бы не те файлы.

    Команда — просто `node`. Прежняя редакция писала
    `sys.executable and "node"`: выражение всегда давало `"node"`, то есть
    работало, но читалось как попытка взять интерпретатор Python и сбивала с
    толку (находка `reviewer` к PR #338).
    """
    done = subprocess.run(["node", "--input-type=module", "-e", source],
                          capture_output=True, text=True, cwd=ROOT, check=False)
    if done.returncode != 0:
        raise AssertionError(f"node не отработал: {done.stderr.strip()[:800]}")
    return done.stdout


class МетрикиВызова(unittest.TestCase):
    """Скорость генерации считается по `eval_duration`, а не по настенному времени.

    Это главная арифметика клиента и единственная, которую легко испортить
    молча: на первом запросе после выгрузки настенное время включает чтение
    17 ГБ весов, и скорость, посчитанная по нему, занижена втрое. Обратная
    ошибка — делить токены `usage` (вместе с рассуждением) на время после
    первого видимого токена — завышает втрое.
    """

    def test_скорость_по_длительности_генерации_а_не_по_настенному_времени(self):
        final = {"eval_count": 100, "eval_duration": 10_000_000_000,
                 "prompt_eval_count": 50, "prompt_eval_duration": 1_000_000_000}
        got = client.metrics_of(final, ttft=0.4, ttft_answer=0.9, wall=99.0,
                                thinking="", response="ответ")
        self.assertEqual(got["gen_tokens_per_s"], 10.0)
        self.assertEqual(got["prompt_tokens_per_s"], 50.0)
        self.assertEqual(got["wall_ms"], 99000.0)

    def test_два_времени_до_первого_токена_не_подменяют_друг_друга(self):
        got = client.metrics_of({}, ttft=0.4, ttft_answer=8.9, wall=9.0,
                                thinking="рассуждение", response="ответ")
        self.assertEqual(got["ttft_ms"], 400.0)
        self.assertEqual(got["ttft_answer_ms"], 8900.0)
        self.assertEqual(got["thinking_chars"], len("рассуждение"))

    def test_нет_чисел_от_движка_значит_нет_скорости_а_не_ноль(self):
        got = client.metrics_of({}, ttft=None, ttft_answer=None, wall=1.0,
                                thinking="", response="")
        self.assertIsNone(got["gen_tokens_per_s"])
        self.assertIsNone(got["ttft_ms"])
        self.assertEqual(got["eval_count"], 0)


class ПотокОтвета(unittest.TestCase):
    """Разбор потока `/api/generate` — против настоящего HTTP, а не мока клиента."""

    def ndjson(self, *frames: dict) -> bytes:
        return b"".join(json.dumps(frame).encode("utf-8") + b"\n" for frame in frames)

    def test_рассуждение_и_ответ_приходят_раздельно_и_оба_записаны(self):
        body = self.ndjson(
            {"thinking": "думаю"},
            {"response": "первая "},
            {"response": "часть"},
            {"done": True, "done_reason": "stop", "eval_count": 4,
             "eval_duration": 2_000_000_000, "prompt_eval_count": 7,
             "prompt_eval_duration": 1_000_000_000},
        )
        with FakeOllama({"/api/generate": (200, body)}) as fake:
            client.OLLAMA_URL = fake.url
            got = client.generate("m", "вопрос", options={"num_ctx": 8}, think=True)
        self.assertEqual(got["response"], "первая часть")
        self.assertEqual(got["thinking"], "думаю")
        self.assertEqual(got["done_reason"], "stop")
        self.assertEqual(got["metrics"]["gen_tokens_per_s"], 2.0)
        path, request = fake.requests[0]
        self.assertEqual(path, "/api/generate")
        # Окно контекста уходит в запрос явно: умолчание Ollama неизвестно, и
        # при его превышении вход обрезается молча.
        self.assertEqual(request["options"]["num_ctx"], 8)
        self.assertTrue(request["stream"])
        self.assertIs(request["think"], True)

    def test_think_не_уходит_в_запрос_когда_не_задан(self):
        body = self.ndjson({"response": "да"}, {"done": True})
        with FakeOllama({"/api/generate": (200, body)}) as fake:
            client.OLLAMA_URL = fake.url
            client.generate("m", "вопрос")
        self.assertNotIn("think", fake.requests[0][1])

    def test_отказ_движка_ложится_полем_а_не_исключением(self):
        body = self.ndjson({"error": "model requires more system memory"})
        with FakeOllama({"/api/generate": (200, body)}) as fake:
            client.OLLAMA_URL = fake.url
            got = client.generate("m", "вопрос")
        self.assertIn("system memory", got["error"])
        self.assertEqual(got["response"], "")

    def test_недоступная_служба_это_результат_замера_а_не_авария(self):
        client.OLLAMA_URL = "http://127.0.0.1:1"
        got = client.generate("m", "вопрос", timeout=2)
        self.assertIsNotNone(got["error"])
        self.assertEqual(got["response"], "")

    def tearDown(self):
        client.OLLAMA_URL = "http://127.0.0.1:11435"


class УтёкшееРассуждение(unittest.TestCase):
    """Рассуждение, вытекшее в видимый ответ, режется по ПОСЛЕДНЕЙ метке.

    У сборки без отказов шаблон чата дописывает `<think>` сам, способности
    `thinking` она не объявляет, и рассуждение приходит прямо в `response` —
    часто с непарной закрывающей меткой. Признаки, посчитанные по такому
    тексту, мерили бы рассуждение, а не ответ.
    """

    def test_непарная_закрывающая_метка_отрезает_всё_до_себя(self):
        self.assertEqual(client.strip_think("сначала думаю</think>\n\nответ"), "ответ")

    def test_режется_по_последней_метке_а_не_по_первой(self):
        self.assertEqual(
            client.strip_think("а</think>б</think>настоящий ответ"), "настоящий ответ")

    def test_без_метки_текст_не_меняется(self):
        self.assertEqual(client.strip_think("обычный ответ"), "обычный ответ")


class ПамятьПрогона(unittest.TestCase):
    def test_пик_по_api_ps_берётся_по_нужной_модели(self):
        samples = [
            {"models": [{"name": "m", "size_vram_bytes": 10}]},
            {"models": [{"name": "другая", "size_vram_bytes": 999},
                        {"name": "m", "size_vram_bytes": 30}]},
            {"models": [{"name": "m", "size_vram_bytes": 20}]},
        ]
        self.assertEqual(client.peak_model(samples, "m")["size_vram_bytes"], 30)

    def test_модели_не_было_в_выборках_значит_пика_нет(self):
        self.assertIsNone(client.peak_model([{"models": []}], "m"))

    def test_веса_живут_в_llama_server_и_он_засчитывается(self):
        # Главное число памяти: на живой машине 18,7 ГБ весов держит процесс
        # `llama-server` внутри бандла Ollama, а не процесс с именем `ollama`
        # (проверено `ps` 2026-10-09). Матчер только по имени `ollama*` давал
        # пик 177 МиБ при занятых 18,7 ГБ, то есть мерил мимо модели.
        out = ("  61000 /opt/homebrew/opt/ollama/bin/ollama\n"
               "18689888 /opt/homebrew/Cellar/ollama/0.33.3/libexec/lib/ollama/llama-server\n"
               "  38000 ollama\n"
               " 500000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n")
        done = subprocess.CompletedProcess([], 0, stdout=out, stderr="")
        got = client.ollama_rss(run=lambda *a, **k: done)
        self.assertEqual(got["total_kib"], 61_000 + 18_689_888 + 38_000)
        self.assertEqual([item["name"] for item in got["processes"]],
                         ["ollama", "llama-server", "ollama"])

    def test_чужой_llama_server_не_засчитывается(self):
        # Отдельно поставленный `llama-server` к этому замеру не относится:
        # иначе пик включал бы чужой стенд на той же машине.
        self.assertFalse(client.is_ollama_process("/usr/local/bin/llama-server"))
        self.assertTrue(client.is_ollama_process(
            "/opt/homebrew/Cellar/ollama/0.33.3/libexec/lib/ollama/llama-server"))

    def test_ни_одного_процесса_ollama_значит_не_измерено_а_не_ноль(self):
        done = subprocess.CompletedProcess([], 0, stdout="  500 Chrome\n", stderr="")
        self.assertIsNone(client.ollama_rss(run=lambda *a, **k: done))

    def test_пик_rss_это_максимум_выборок_с_разбивкой_а_без_выборок_его_нет(self):
        values = iter([
            {"total_kib": 100, "processes": [{"name": "ollama", "rss_kib": 100}]},
            {"total_kib": 900, "processes": [{"name": "llama-server", "rss_kib": 900}]},
            {"total_kib": 300, "processes": [{"name": "ollama", "rss_kib": 300}]},
        ])
        last = {"total_kib": 300, "processes": []}
        peak = client.RssPeak(interval=0.001, sample=lambda: next(values, last))
        with peak:
            while len(peak.samples) < 3:
                pass
        self.assertEqual(peak.peak_kib, 900)
        # Разбивка пишется в файл рядом с суммой: без неё число нельзя
        # проверить, а на машине может работать вторая служба Ollama.
        self.assertEqual(peak.report()["peak_processes"],
                         [{"name": "llama-server", "rss_kib": 900}])
        self.assertIsNone(client.RssPeak(interval=0.001, sample=lambda: None).peak_kib)


class ПризнакиОтвета(unittest.TestCase):
    """Четыре признака дня 22 на ответах локальной модели.

    Где признака нет — там `None`, а не `False`: у общего вопроса верного
    источника не бывает вовсе, и `cited: false` читалось бы как упрёк за
    несуществующее требование.
    """

    QUESTION = {"id": "q08", "key": "snapshot.md",
                "sources": ["agent_docs/guides/dod.md"]}
    GENERAL = {"id": "m01", "key": None, "sources": []}

    def test_верный_источник_среди_найденных_сравнивается_точно(self):
        got = features.features_for(self.QUESTION, "ответ",
                                    ["agent_docs/guides/dod.md", "AGENTS.md"])
        self.assertIs(got["retrieved"], True)
        # Подстрока пути верным источником не считается: иначе
        # `agent_docs/guides/dod.md.bak` сошёл бы за него.
        self.assertIs(
            features.features_for(self.QUESTION, "о", ["agent_docs/guides/dod.md.bak"])["retrieved"],
            False)

    def test_путь_назван_в_ответе_подстрокой_после_нормализации(self):
        answer = "Смотри\n[1]  AGENT_DOCS/GUIDES/DOD.MD — там список"
        self.assertIs(features.features_for(self.QUESTION, answer, [])["cited"], True)

    def test_ключевая_фраза_и_отказ_считаются_по_форме(self):
        got = features.features_for(self.QUESTION, "нужен snapshot.md и тесты", [])
        self.assertIs(got["key"], True)
        self.assertIs(got["refused"], False)
        refused = features.features_for(
            self.QUESTION, "В найденных фрагментах ответа нет; нашлось другое", [])
        self.assertIs(refused["refused"], True)

    def test_у_общего_вопроса_источника_и_фразы_нет_вовсе(self):
        got = features.features_for(self.GENERAL, "не знаю", [])
        self.assertIsNone(got["retrieved"])
        self.assertIsNone(got["cited"])
        self.assertIsNone(got["key"])

    def test_вердикт_прогон_не_ставит_никогда(self):
        self.assertIsNone(features.features_for(self.QUESTION, "любой ответ", [])["verdict"])

    def test_слово_оценки_ровно_из_спецификации(self):
        # Слова — те, что просит принятая спецификация раскладки: «верно /
        # частично / неверно». «Совпало / не совпало» были в черновике, и в
        # принятой редакции их нет (находка `reviewer` к PR #338).
        self.assertEqual(features.quality_word(2), "верно")
        self.assertEqual(features.quality_word(1), "частично")
        self.assertEqual(features.quality_word(0), "неверно")
        self.assertIsNone(features.quality_word(None))
        self.assertIsNone(features.quality_word("2"))
        spec = (ROOT / "agent_docs" / "design"
                / "2026-10-09-1335-days26-30-local-llm-day-pages.md").read_text(encoding="utf-8")
        # Слова сверяются с самой спецификацией, а не с памятью автора: иначе
        # копия слов разъехалась бы с принятым документом молча.
        self.assertIn('`verdict` — ровно `"верно" | "частично" | "неверно"`', spec)

    def test_медиана_без_чисел_это_нет_данных_а_не_ноль(self):
        self.assertEqual(features.median_or_none([3, 1, 2]), 2)
        self.assertIsNone(features.median_or_none([None, None]))
        self.assertIsNone(features.median_or_none([]))


class НормализацияСходитсяСДнём22(unittest.TestCase):
    """Нормализация сверки по фразе — та же, что `flatten` в `score.mjs`.

    Без этой сверки вторая копия признаков могла бы нормализовать мягче
    (скажем, выкидывать знаки), и `key: true` стал бы дешевле на локальной
    стороне, чем на облачной: сравнение дня 28 мерило бы разницу
    нормализаций. Проверяется на краевых парах, а не на одной строке.
    """

    CASES = [
        "  Два\n\nпробела  ",
        "РЕГИСТР и ёлка",
        "путь/к/Файлу.MD",
        "табы\tи\r\nпереносы",
        "",
    ]

    def test_flatten_совпадает_знак_в_знак(self):
        out = node(
            "import {flatten} from './days/day22/eval/score.mjs'\n"
            f"const cases = {json.dumps(self.CASES, ensure_ascii=False)}\n"
            "console.log(JSON.stringify(cases.map(flatten)))\n"
        )
        self.assertEqual(json.loads(out), [features.flatten(case) for case in self.CASES])

    def test_рубрика_судьи_одна_и_та_же(self):
        out = node(
            "import {RUBRIC} from './days/day22/eval/score.mjs'\n"
            "console.log(JSON.stringify(RUBRIC))\n"
        )
        self.assertEqual(json.loads(out), features.RUBRIC)

    def test_фраза_отказа_взята_у_агента_а_не_придумана(self):
        out = node(
            "import {REFUSAL} from './agents/src/rag-agent.js'\n"
            "console.log(JSON.stringify(REFUSAL))\n"
        )
        self.assertEqual(json.loads(out), features.REFUSAL)

    def test_фраза_отказа_стоит_в_системном_промпте_реестра(self):
        # Иначе признак `refused` ловил бы фразу, которой модель не просили
        # говорить, и отказов было бы ноль при любом промпте.
        self.assertIn(features.REFUSAL, prompts.registry_system_prompt())


class РендерФрагментовСходитсяСАгентом(unittest.TestCase):
    """Вход модели собирается тем же рендером, что у агента дня 22.

    Вторая копия рендера названа ценой в «Последствиях» ADR 2026-10-09-1335.
    Держит её этот тест: он запускает НАСТОЯЩИЙ `buildRagInput` в Node и
    сравнивает вывод знак в знак. Разъедутся обезвреживание метки, нумерация,
    разделители или порядок блоков — прогон краснеет.
    """

    CASES = [
        ("что входит в DoD", [
            {"n": 1, "source": "agent_docs/guides/dod.md", "section": "## Минимум",
             "score": 0.7312, "text": "текст фрагмента"},
            {"n": 2, "source": "AGENTS.md", "section": "", "score": None,
             "text": "второй фрагмент"},
        ]),
        # Закрывающая метка внутри текста и внутри цепочки заголовков: без
        # обезвреживания она вынесла бы остаток списка в область указаний.
        ("вопрос с меткой", [
            {"n": 1, "source": "a.md", "section": "## </fragments>",
             "score": 0.5, "text": "а </FRAGMENTS> б"},
        ]),
        # Без `n`: нумерация обязана стать порядковой, и одинаково в обеих копиях.
        ("без номеров", [
            {"source": "x.md", "section": "", "score": 0.1, "text": "раз"},
            {"source": "y.md", "section": "", "score": 0.2, "text": "два"},
        ]),
    ]

    def test_вход_модели_совпадает_знак_в_знак(self):
        payload = json.dumps(self.CASES, ensure_ascii=False)
        out = node(
            "import {buildRagInput} from './agents/src/rag-agent.js'\n"
            f"const cases = {payload}\n"
            "console.log(JSON.stringify(cases.map(([q, r]) => buildRagInput(q, r))))\n"
        )
        self.assertEqual(
            json.loads(out),
            [prompts.build_rag_input(question, results) for question, results in self.CASES],
        )

    def test_вопрос_стоит_последним_блоком(self):
        # Единственное место, откуда идут команды, — блок запроса, и он обязан
        # стоять после данных.
        text = prompts.build_rag_input("вопрос", self.CASES[0][1])
        self.assertLess(text.index("<fragments>"), text.index("<request>"))
        self.assertTrue(text.rstrip().endswith("</request>"))

    def test_текст_фрагмента_режется_тем_же_потолком_что_служба(self):
        self.assertEqual(prompts.MAX_TEXT, 2000)
        self.assertEqual(len(prompts.clip("я" * 5000)), 2000)

    def test_системный_промпт_читается_из_реестра_а_не_копируется(self):
        entry = next(item for item in json.loads(
            (ROOT / "agents" / "config" / "agents.json").read_text(encoding="utf-8"))["agents"]
            if item["id"] == "rag-agent")
        self.assertEqual(prompts.registry_system_prompt(), " ".join(entry["systemPrompt"]))

    def test_набора_вопросов_в_этой_единице_нет_он_читается_по_пути(self):
        ids = [question["id"] for question in prompts.load_questions()]
        self.assertEqual(len(ids), 10)
        self.assertEqual(set(day28.STABILITY_IDS) - set(ids), set())
        # Копии набора в единице `rag` быть не должно: она разъехалась бы молча.
        self.assertEqual(list((RAG / "eval").glob("questions*.json")), [])


class СтражТекстовБезОтказов(unittest.TestCase):
    """Тексты сборки Q6_K не уходят в публичный файл — ни на одном уровне.

    Это вето `compliance` (ADR 2026-10-07-1349), и держит его страж записи, а
    не внимательность автора прогона. Проверяются обе формы утечки: текст
    прямо в записи с меткой модели и текст в списке ВНУТРИ такой записи —
    вторая и есть форма файла дня 29.
    """

    def payload(self, extra: dict) -> dict:
        return {**report.envelope(29, client.Q4, "ollama 0.33.3", "abcdef1"),
                "variants": [{"id": "quant", "model": client.Q6, **extra}]}

    def test_текст_прямо_в_записи_оси_валит_запись(self):
        with self.assertRaises(ValueError) as caught:
            report.check_no_abliterated_texts(self.payload({"answer": "ответ сборки"}))
        self.assertIn("2026-10-07-1349", str(caught.exception))

    def test_текст_в_списке_внутри_оси_валит_запись_тоже(self):
        with self.assertRaises(ValueError):
            report.check_no_abliterated_texts(
                self.payload({"answers": [{"id": "q08", "answer": "ответ сборки"}]}))

    def test_только_числа_под_осью_проходят(self):
        report.check_no_abliterated_texts(self.payload({
            "answers": [{"id": "q08", "answer_chars": 420, "tps": 7.1, "cited": True}]}))

    def test_ось_квантования_прогона_текстов_не_собирает_вовсе(self):
        rows = day29.run_variant(
            [{"id": "q08", "question": "в?", "key": None, "sources": []}],
            {"q08": [{"n": 1, "source": "a.md", "section": "", "score": 0.1, "text": "т"}]},
            client.Q6, "системный", {"num_ctx": 8}, None,
            generate=fake_generate("секретный текст сборки"), numbers_only=True)
        self.assertNotIn("answer", rows[0])
        self.assertEqual(rows[0]["answer_chars"], len("секретный текст сборки"))
        self.assertEqual(rows[0]["model"], client.Q6)
        report.check_no_abliterated_texts({"variants": [{"answers": rows}]})

    def test_запись_файла_не_обходит_стража_и_прогон_не_теряет(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            with self.assertRaises(ValueError) as caught:
                report.write_results(out, self.payload({"answer": "ответ сборки"}))
            self.assertFalse(out.exists())
            # Прогон стоит часа GPU: он уходит в каталог временных файлов ОС,
            # а не в репозиторий, и путь напечатан в тексте отказа.
            self.assertIn("он здесь:", str(caught.exception))


class СтражАдресов(unittest.TestCase):
    """Ни адреса, ни имени машины частной сети в публичном файле (I-1, I-3).

    Граница проверяется обеими сторонами: адрес в служебном поле валит запись,
    выдуманный моделью IPv4 в тексте ответа — нет. Без второй половины страж
    падал бы на пересказе документа и прогон запускали бы мимо него.
    """

    def base(self) -> dict:
        return report.envelope(28, client.Q4, "ollama 0.33.3", "abcdef1")

    def test_адрес_в_служебном_поле_валит_запись(self):
        with self.assertRaises(ValueError) as caught:
            report.check_no_private_addresses({**self.base(), "host_url": "http://100.77.87.97:11434"})
        self.assertIn("I-1", str(caught.exception))

    def test_имя_машины_частной_сети_валит_запись(self):
        with self.assertRaises(ValueError):
            report.check_no_private_addresses({**self.base(), "service": "ai.zpq.ollama-tailnet"})
        with self.assertRaises(ValueError):
            report.check_no_private_addresses({**self.base(), "note": "узел laptop.tail1234.ts.net"})

    def test_адрес_в_тексте_ошибки_сети_тоже_валит(self):
        with self.assertRaises(ValueError):
            report.check_no_private_addresses(
                {**self.base(),
                 "questions": [{"local": {"error": "connect 127.0.0.1:11435 refused"}}]})

    def test_выдуманный_моделью_адрес_в_ответе_запись_не_валит(self):
        report.check_no_private_addresses(
            {**self.base(),
             "questions": [{"local": {"answer": "например, 10.0.0.1 — адрес шлюза"}}]})

    def test_имя_частной_сети_в_ответе_модели_валит_и_там(self):
        with self.assertRaises(ValueError):
            report.check_no_private_addresses(
                {**self.base(), "questions": [{"local": {"answer": "ходи на x.y.ts.net"}}]})

    def test_машина_в_конверте_названа_словами(self):
        envelope = self.base()
        # Слова, а не адрес; модель процессора словами же — спецификация
        # раскладки просит «ноутбук владельца, Apple M3 Max», потому что
        # читателю нужно знать железо, а модель адресом не является.
        self.assertEqual(envelope["host"], "ноутбук владельца, Apple M3 Max")
        report.check_no_private_addresses(envelope)

    def test_запись_файла_не_обходит_стража_адресов(self):
        # Отдельно от проверки самой функции: мутация «убрать вызов из
        # `write_results`» оставляла прогон зелёным, пока этого теста не было
        # (мутация М2 при подготовке PR). Проверка функции не держит её вызов.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            with self.assertRaises(ValueError):
                report.write_results(out, {**self.base(),
                                           "service": "ai.zpq.ollama-tailnet"})
            self.assertFalse(out.exists())

    def test_слово_tailscale_не_запрещено(self):
        # Название сети стоит в публичных ADR и в описании проекта; запрет на
        # него заставлял бы объяснять устройство доступа иносказаниями.
        report.check_no_private_addresses(
            {**self.base(), "access": {"how": "частная сеть Tailscale до ноутбука"}})


class КонвертФайлаРезультата(unittest.TestCase):
    """Шапка, которую читает страница дня, — её поля держатся здесь.

    Без этого выкинутое `commit` или `runner` оставляло бы прогон зелёным, а
    подвал страницы терялся бы молча (тот же урок, что у дня 21, PR #294).
    """

    def test_все_поля_шапки_на_месте(self):
        got = report.envelope(28, "qwen3.8:27b", "ollama 0.33.3", "abcdef1",
                              notes=["оговорка"])
        for key in ("day", "generated", "commit", "host", "model", "runner", "notes"):
            self.assertIn(key, got, key)
        self.assertEqual(got["day"], 28)
        self.assertRegex(got["generated"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_без_оговорок_поля_notes_нет_вовсе(self):
        self.assertNotIn("notes", report.envelope(27, "m", "r", "c"))

    def test_сводка_стороны_считается_по_слову_а_не_по_баллу(self):
        rows = [
            {"quality": "верно", "time_s": 10, "failed": False},
            {"quality": "верно", "time_s": 20, "failed": False},
            {"quality": "частично", "time_s": 30, "failed": False},
            {"quality": "неверно", "time_s": None, "failed": True},
            {"quality": None, "time_s": 40, "failed": False},
        ]
        got = report.side_summary(rows)
        self.assertEqual(got["matched"], 2)
        self.assertEqual(got["partial"], 1)
        self.assertEqual(got["missed"], 1)
        self.assertEqual(got["failures"], 1)
        self.assertEqual(got["queries"], 5)
        # Вопрос без вердикта ни в одну корзину не попал, но из `queries` не исчез.
        self.assertEqual(got["matched"] + got["partial"] + got["missed"], 4)
        self.assertEqual(got["time_s_median"], 25)

    def test_миллисекунды_переводятся_в_секунды_а_отсутствие_остаётся_отсутствием(self):
        self.assertEqual(report.seconds(1234.5), 1.234)
        self.assertIsNone(report.seconds(None))


def fake_generate(answer: str, error=None, wall_ms=1000.0, tps=7.5):
    """Подставная модель: отвечает заданным текстом с заданными метриками."""

    def generate(model, text, options=None, think=None, system=None, **_kw):
        return {
            "model": model, "options": options or {}, "think": think,
            "error": error, "response": answer, "thinking": "",
            "done_reason": "stop",
            "metrics": {"ttft_ms": 500.0, "ttft_answer_ms": 500.0, "wall_ms": wall_ms,
                        "prompt_eval_count": 4321, "prompt_eval_cached_count": 0,
                        "eval_count": 120, "thinking_chars": 0,
                        "response_chars": len(answer), "load_duration_ms": None,
                        "prompt_eval_duration_ms": 100.0, "eval_duration_ms": 900.0,
                        "total_duration_ms": wall_ms, "gen_tokens_per_s": tps,
                        "prompt_tokens_per_s": 128.0},
        }

    return generate


def fake_index(tmp: Path, embedder, texts: list[str]):
    """Индекс FAISS в каталоге, собранный тем же кодом, что сборка прода."""
    import numpy as np

    from index import VectorIndex

    vectors = FakeOllama.deterministic({"input": texts})["embeddings"]
    meta = [{"source": f"agent_docs/guides/dod.md" if at == 0 else f"d{at}.md",
             "section": f"§{at}", "text": text, "commit": "abcdef1234567",
             "strategy": day28.STRATEGY}
            for at, text in enumerate(texts)]
    VectorIndex.build(day28.STRATEGY, meta, np.asarray(vectors, dtype="float32"),
                      embedder.model).save(tmp)


class ПрогонДня28(unittest.TestCase):
    """Форма файла дня 28 и повтор трёх вопросов стабильности — под прогоном.

    Прогон идёт целиком: настоящий индекс FAISS, настоящий поиск, подложная
    Ollama для эмбеддингов и подставная модель для ответов. Что это держит:
    число ответов (10 вопросов + по два повтора у трёх) и поля, которые читает
    страница. Без этого «один повтор на вопрос» и три вопроса стабильности
    остались бы словами ADR.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.fake = FakeOllama({"/api/embed": (200, FakeOllama.deterministic)}).__enter__()
        from embed import OllamaEmbedder

        self.embedder = OllamaEmbedder(self.fake.url, "эмбеддер")
        fake_index(self.dir, self.embedder, ["что входит в Definition of Done проекта",
                                             "второй документ про выкатку"])

    def tearDown(self):
        self.fake.__exit__()
        self.tmp.cleanup()

    def test_десять_вопросов_и_три_повтора_у_трёх_вопросов(self):
        calls = []

        def counting(model, text, **kw):
            calls.append(text)
            return fake_generate("ответ по agent_docs/guides/dod.md, нужен snapshot.md")(
                model, text, **kw)

        got = day28.run(self.dir, self.embedder, client.Q4, "ollama 0.33.3",
                        generate=counting)
        self.assertEqual(len(got["questions"]), 10)
        # 10 вопросов по одному разу плюс по два лишних у трёх вопросов.
        self.assertEqual(len(calls), 10 + 2 * len(day28.STABILITY_IDS))
        self.assertEqual([row["id"] for row in got["stability"]],
                         list(day28.STABILITY_IDS))
        for row in got["stability"]:
            self.assertEqual(len(row["runs"]), day28.STABILITY_RUNS)

    def test_поля_страницы_на_месте_и_вердиктов_прогон_не_ставит(self):
        got = day28.run(self.dir, self.embedder, client.Q4, "ollama 0.33.3",
                        generate=fake_generate("В найденных фрагментах ответа нет"))
        self.assertEqual(got["day"], 28)
        self.assertEqual(got["judge"], {"name": None, "rubric": features.RUBRIC})
        for side in ("local", "cloud"):
            for key in ("matched", "partial", "missed", "time_s_median", "failures", "queries"):
                self.assertIn(key, got["summary"][side], f"{side}.{key}")
        first = got["questions"][0]
        for key in ("id", "set", "text", "sources", "fragments", "local", "cloud"):
            self.assertIn(key, first, key)
        self.assertIsNone(first["local"]["quality"])
        self.assertIs(first["local"]["refused"], True)
        # Фрагменты в файл идут без текста: страница показывает путь и близость,
        # а 10 КБ корпуса на вопрос раздули бы файл за 200 КБ.
        self.assertEqual(set(first["fragments"][0]), {"n", "source", "section", "score"})
        report.check_no_abliterated_texts(got)
        report.check_no_private_addresses(got)

    def test_отказ_модели_ложится_происшествием_и_набор_не_обрывается(self):
        got = day28.run(self.dir, self.embedder, client.Q4, "ollama 0.33.3",
                        generate=fake_generate("", error="timed out"))
        self.assertEqual(len(got["questions"]), 10)
        self.assertEqual(len(got["incidents"]), 10 + 2 * len(day28.STABILITY_IDS))
        self.assertIs(got["questions"][0]["local"]["failed"], True)
        self.assertEqual(got["summary"]["local"]["failures"], 10)

    def test_облачная_сторона_берётся_из_файла_дня_22_а_не_запрашивается(self):
        questions = prompts.load_questions()
        cloud = {"questions": [
            {"id": questions[0]["id"], "modes": {"rag": {"verdict": 2, "retrieved": True,
                                                         "cited": True, "key": True,
                                                         "refused": False}}},
        ]}
        got = day28.run(self.dir, self.embedder, client.Q4, "ollama 0.33.3",
                        cloud=cloud, times={questions[0]["id"]: 12.5},
                        generate=fake_generate("ответ"))
        self.assertEqual(got["questions"][0]["cloud"]["quality"], "верно")
        self.assertEqual(got["questions"][0]["cloud"]["time_s"], 12.5)
        # Вопрос, которого в облачном файле нет, остаётся без слова качества —
        # и это «нет данных», а не «неверно».
        self.assertIsNone(got["questions"][1]["cloud"]["quality"])
        self.assertIsNone(got["questions"][1]["cloud"]["time_s"])

    def test_без_времён_облака_в_оговорки_попадает_честная_строка(self):
        got = day28.run(self.dir, self.embedder, client.Q4, "ollama 0.33.3",
                        generate=fake_generate("ответ"))
        self.assertTrue(any("Время облачной стороны не измерено" in note
                            for note in got["notes"]))


class ВыборПослеДня29(unittest.TestCase):
    """«После» выбирается правилом, а не вкусом, и правило проверяется числами.

    Это место, где страница дня 29 могла бы соврать молча: подобрав сочетание
    осей под желаемый вывод. Поэтому правило — код, а не абзац, и у него есть
    отрицательные ветви на каждое условие.
    """

    BASE = {"cited": 8, "key": 7, "refused": 1, "time_s_median": 20.0, "failed": 0}

    def better(self, **over):
        return {**self.BASE, "time_s_median": 15.0, **over}

    def test_признаки_не_упали_и_время_не_выросло_ось_годится(self):
        self.assertTrue(day29.axis_qualifies(self.BASE, self.better()))

    def test_меньше_названных_путей_ось_не_годится(self):
        self.assertFalse(day29.axis_qualifies(self.BASE, self.better(cited=7)))

    def test_меньше_ключевых_фраз_ось_не_годится(self):
        self.assertFalse(day29.axis_qualifies(self.BASE, self.better(key=6)))

    def test_больше_отказов_ось_не_годится(self):
        self.assertFalse(day29.axis_qualifies(self.BASE, self.better(refused=2)))

    def test_время_выросло_ось_не_годится(self):
        self.assertFalse(day29.axis_qualifies(self.BASE, self.better(time_s_median=25.0)))

    def test_времени_нет_значит_быстрее_утверждать_нечем(self):
        self.assertFalse(day29.axis_qualifies(self.BASE, self.better(time_s_median=None)))
        self.assertFalse(day29.axis_qualifies({**self.BASE, "time_s_median": None},
                                              self.better()))

    def test_отказ_прогона_оси_закрывает_её_для_после(self):
        self.assertFalse(day29.axis_qualifies(self.BASE, self.better(failed=1)))

    def test_ось_квантования_в_после_не_входит_ни_при_каких_числах(self):
        all_axes = day29.axes(day28.BASE_OPTIONS)
        summaries = {axis["id"]: self.better() for axis in all_axes}
        choice = day29.choose_after(self.BASE, summaries, all_axes)
        self.assertNotIn("quant", choice["axes"])
        why = next(item for item in choice["reasons"] if item["axis"] == "quant")
        self.assertIn("та же модель, что в проде", why["why"])
        # Остальные пять при тех же числах войти обязаны: иначе тест прошёл бы
        # потому, что не годится вообще ничто.
        self.assertEqual(set(choice["axes"]),
                         {axis["id"] for axis in all_axes if axis["id"] != "quant"})

    def test_сочетание_накладывается_на_базу_а_не_заменяет_её(self):
        all_axes = day29.axes(day28.BASE_OPTIONS)
        options, think, system = day29.combined(day28.BASE_OPTIONS, "реестровый",
                                                ["temperature", "think", "prompt"], all_axes)
        self.assertEqual(options["temperature"], 0.2)
        # `num_predict` базы не потерялся, хотя ось его не касалась.
        self.assertEqual(options["num_predict"], day28.BASE_OPTIONS["num_predict"])
        self.assertIs(think, True)
        self.assertEqual(system, day29.COMPACT_SYSTEM)

    def test_каждая_ось_отличается_от_базы_ровно_одним(self):
        base = dict(day28.BASE_OPTIONS)
        forced = 0
        for axis in day29.axes(base):
            changes = len(axis.get("options") or {})
            changes += 1 if "think" in axis else 0
            changes += 1 if axis.get("system") else 0
            changes += 1 if axis.get("model") else 0
            # Второе отличие допускается ТОЛЬКО объявленным полем `forced` с
            # причиной: иначе лишняя правка в оси прошла бы молча, и ось
            # мерила бы две вещи разом.
            allowed = 2 if axis.get("forced") else 1
            self.assertEqual(changes, allowed, axis["id"])
            forced += 1 if axis.get("forced") else 0
        # Вынужденное отличие есть ровно у одной оси, и это ось квантования.
        self.assertEqual(forced, 1)

    def test_признак_retrieved_в_сводку_оси_не_входит(self):
        # Поиск у всех осей один индекс и один `k`: признак от генерации не
        # зависит, и сравнение осей по нему было бы сравнением по константе.
        got = day29.axis_summary([{"retrieved": True, "cited": True, "key": False,
                                   "refused": False, "time_s": 1, "ttft_s": 1, "tps": 2}])
        self.assertNotIn("retrieved", got)


class ШаблонПромптаДословно(unittest.TestCase):
    """Компактный промпт оси «промпт» — предмет замера, и его слова прибиты.

    ADR 2026-10-09-1335, п. 4.3 требует трёх правил вместо семи и примера
    формата ссылки. Молчаливая правка слов обесценила бы ось: страница
    показывала бы разницу, полученную на другом шаблоне.
    """

    def test_три_правила_и_пример_ссылки(self):
        text = day29.COMPACT_SYSTEM
        # Правила считаются по границам предложений («. » плюс точка в конце), а
        # не по числу точек: точка в `dod.md» ` границей предложения не является.
        self.assertTrue(text.endswith("."))
        self.assertEqual(text.count(". ") + 1, 3, "правил должно быть ровно три")
        self.assertIn("«[2] agent_docs/guides/dod.md»", text)
        self.assertIn(features.REFUSAL, text)

    def test_шаблон_короче_реестрового(self):
        self.assertLess(len(day29.COMPACT_SYSTEM), len(prompts.registry_system_prompt()))


class МеханическиеПроверки(unittest.TestCase):
    """Вердикт, который можно посчитать, не зависит от модели-судьи."""

    def test_подстрока_без_учёта_регистра_и_переносов(self):
        self.assertTrue(checks.contains("Итого:\n  14022\n", "14022")["ok"])
        self.assertFalse(checks.contains("итого 14023", "14022")["ok"])

    def test_схема_ловит_лишнее_поле_и_нецелый_год(self):
        schema = day26_prompts.JSON_SCHEMA
        good = {"sphere": "fintech", "items": [
            {"title": "т", "company": "к", "year": 2026, "tags": ["а"]}] * 3}
        self.assertTrue(checks.by_schema(json.dumps(good), schema)["ok"])
        extra = {**good, "лишнее": 1}
        self.assertFalse(checks.by_schema(json.dumps(extra), schema)["ok"])
        wrong = {"sphere": "f", "items": [
            {"title": "т", "company": "к", "year": True, "tags": []}] * 3}
        # `bool` — подкласс `int`, и без отдельной проверки `true` прошло бы
        # за целое.
        self.assertFalse(checks.by_schema(json.dumps(wrong), schema)["ok"])

    def test_схема_ловит_нехватку_элементов(self):
        few = {"sphere": "f", "items": [
            {"title": "т", "company": "к", "year": 2026, "tags": []}]}
        self.assertFalse(checks.by_schema(json.dumps(few), day26_prompts.JSON_SCHEMA)["ok"])

    def test_обрамление_кода_снимается(self):
        self.assertEqual(checks.strip_fences("```js\nfunction f(){}\n```"), "function f(){}")

    def test_не_json_это_не_пройденная_схема_а_не_исключение(self):
        got = checks.by_schema("вот вам JSON, честное слово", day26_prompts.JSON_SCHEMA)
        self.assertFalse(got["ok"])
        self.assertTrue(got["problems"])

    def test_запуск_в_node_тесты_не_зовут_настоящий_node(self):
        done = subprocess.CompletedProcess(
            [], 0, stdout=json.dumps({"passed": 8, "total": 8, "cases": []}), stderr="")
        got = checks.by_running_js("function compress(s){return s}", run=lambda *a, **k: done)
        self.assertTrue(got["ok"])
        half = subprocess.CompletedProcess(
            [], 0, stdout=json.dumps({"passed": 5, "total": 8, "cases": []}), stderr="")
        self.assertFalse(checks.by_running_js("x", run=lambda *a, **k: half)["ok"])

    def test_нет_проверки_значит_нет_вердикта_а_не_неверно(self):
        self.assertIsNone(checks.verdict_of(None))
        self.assertEqual(checks.verdict_of({"ok": True}), "верно")
        self.assertEqual(checks.verdict_of({"ok": False}), "неверно")


class ПрогонДня26(unittest.TestCase):
    """Форма файла дня 26 и сводка по сложности."""

    def test_поля_страницы_и_вердикт_механикой(self):
        got = day26_prompts.run(client.Q4, "ollama 0.33.3", "abcdef1", "документ",
                                generate=fake_generate("Построена в 1889 году."),
                                limit=1)
        self.assertEqual(got["day"], 26)
        row = got["queries"][0]
        for key in ("id", "label", "text", "complexity", "verdict", "reason",
                    "answer", "expected", "ttft_s", "tps"):
            self.assertIn(key, row, key)
        self.assertEqual(row["verdict"], "верно")
        self.assertEqual(row["ttft_s"], 0.5)

    def test_неверный_ответ_не_становится_верным(self):
        got = day26_prompts.run(client.Q4, "ollama 0.33.3", "abcdef1", "документ",
                                generate=fake_generate("Построена в 1887 году."), limit=1)
        self.assertEqual(got["queries"][0]["verdict"], "неверно")

    def test_сводка_по_сложности_медианами(self):
        rows = [{"complexity": 1, "ttft_s": 1.0, "tps": 10},
                {"complexity": 1, "ttft_s": 3.0, "tps": 20},
                {"complexity": 5, "ttft_s": 35.0, "tps": 5}]
        got = day26_prompts.by_complexity(rows)
        self.assertEqual([row["complexity"] for row in got], [1, 5])
        self.assertEqual(got[0]["ttft_s_median"], 2.0)
        self.assertEqual(got[0]["count"], 2)

    def test_длинный_документ_в_файл_целиком_не_идёт(self):
        document = "я" * 50_000
        row = next(task for task in day26_prompts.tasks(document)
                   if task["id"] == "t6_summarize")
        self.assertLess(len(row["text_shown"]), 400)
        self.assertIn("50000", row["text_shown"])


class ПрогонПараметровДвижка(unittest.TestCase):
    """Запись прогона параметров и отказ мерить им сборку без отказов.

    Прежняя редакция писала файл сама, мимо обоих стражей, — и утверждение
    `report.py` «ни одна запись файла стражей не обходит» было ложным
    (находка `reviewer` к PR #338). Второе: `--model` принимал сборку без
    отказов, а этот прогон СОБИРАЕТ ТЕКСТЫ по построению (блок `temp`
    сравнивает три ответа дословно), то есть положил бы её тексты в файл.
    """

    def test_сборка_без_отказов_этим_прогоном_не_меряется(self):
        with self.assertRaises(SystemExit):
            day29_params.main(["--model", client.Q6, "--blocks", "temp",
                               "--out", "/dev/null"])

    def test_отказ_стоит_до_первого_вызова_модели(self):
        # Порядок тот же, что у лимитера в I-4: отказ раньше вызова, а не
        # после. Иначе прогон успел бы собрать тексты и упасть на записи.
        calls = []
        saved = day29_params.BLOCKS["temp"]
        day29_params.BLOCKS["temp"] = lambda *a, **k: calls.append(1) or []
        try:
            with self.assertRaises(SystemExit):
                day29_params.main(["--model", client.Q6, "--blocks", "temp",
                                   "--out", "/dev/null"])
        finally:
            day29_params.BLOCKS["temp"] = saved
        self.assertEqual(calls, [])

    def test_файл_прогона_пишется_через_стражей(self):
        saved = day29_params.BLOCKS["temp"]
        day29_params.BLOCKS["temp"] = lambda *a, **k: [
            {"label": "temperature=0", "options": {}, "responses": ["а"],
             "all_identical": True, "distinct_count": 1, "metrics": []}]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "day29-params.json"
                self.assertEqual(day29_params.main(
                    ["--blocks", "temp", "--out", str(out)]), 0)
                self.assertTrue(out.exists())
                # А теперь утечка адреса в собранных данных: запись обязана
                # упасть, а не положить адрес стенда в файл.
                day29_params.BLOCKS["temp"] = lambda *a, **k: [
                    {"label": "x", "error": "connect 100.77.87.97:11434 refused"}]
                broken = Path(tmp) / "broken.json"
                with self.assertRaises(ValueError):
                    day29_params.main(["--blocks", "temp", "--out", str(broken)])
                self.assertFalse(broken.exists())
        finally:
            day29_params.BLOCKS["temp"] = saved


class ПробыДня30(unittest.TestCase):
    """Пробы дня 30: тексты не собираются, а недоступность не выдаёт себя за замер."""

    def test_текста_ответа_в_записи_пробы_нет_вовсе(self):
        class Response:
            status = 200
            headers = {}

            def read(self):
                return json.dumps({"text": "ответ модели"}).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

        got = day30.ask_day5("вопрос", opener=lambda *a, **k: Response())
        self.assertEqual(set(got), {"status", "time_s", "answer_chars", "reason", "retry_after"})
        self.assertEqual(got["answer_chars"], len("ответ модели"))

    def test_запрос_к_дню_5_несёт_тему_в_поле_sphere(self):
        """День 5 принимает тему в `sphere`; иное поле — 400 «Поле sphere…»."""
        seen = {}

        class Response:
            status = 200
            headers = {}

            def read(self):
                return b"{}"

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

        def opener(request, **_kw):
            seen.update(json.loads(request.data.decode("utf-8")))
            return Response()

        day30.ask_day5("финтех", opener=opener)
        self.assertEqual(seen.get("sphere"), "финтех")
        self.assertNotIn("prompt", seen)

    def test_частота_проверяется_одновременными_запросами(self):
        """Шесть одновременных: пятеро в окне, шестой — 429; иначе «не сработал»."""
        import threading
        lock = threading.Lock()
        count = {"n": 0}

        def ask(_text):
            with lock:
                count["n"] += 1
                n = count["n"]
            if n > day30.RATE_WINDOW:
                return {"status": 429, "time_s": 0.01, "answer_chars": None,
                        "reason": "Слишком часто. Подождите минуту.", "retry_after": None}
            return {"status": 200, "time_s": 1.0, "answer_chars": 1,
                    "reason": None, "retry_after": None}

        got = day30.limit_rate(ask=ask)
        self.assertTrue(got["fired"])
        self.assertEqual(len(got["statuses"]), day30.RATE_WINDOW + 1)
        self.assertIn("Подождите минуту", got["client_saw"])
        hour = day30.limit_rate(ask=lambda _t: {"status": 429, "time_s": 0.01,
                                                "answer_chars": None,
                                                "reason": "Лимит на час исчерпан",
                                                "retry_after": None})
        self.assertFalse(hour["fired"])

        quiet = day30.limit_rate(ask=lambda _t: {"status": 200, "time_s": 1.0,
                                                 "answer_chars": 1, "reason": None,
                                                 "retry_after": None})
        self.assertFalse(quiet["fired"])

    def test_проба_длины_темы_проверяет_именно_длину_темы(self):
        """61 знак: на один больше границы, тело далеко от предела 64 КБ дня 5."""
        sent = []

        def ask(text):
            sent.append(text)
            return {"status": 400, "time_s": 0.01, "answer_chars": None,
                    "reason": "Слишком длинно: не больше 60 символов", "retry_after": None}

        got = day30.limit_request_size(ask=ask)
        self.assertEqual(len(sent[0]), 61)
        body = json.dumps({"sphere": sent[0], "model": day30.PROVIDER, "maxTokens": 64})
        self.assertLess(len(body.encode("utf-8")), 64 * 1024)
        self.assertTrue(got["fired"])
        self.assertEqual(got["value"], "60")

    def test_недоступный_провайдер_останавливает_пробы_через_прод(self):
        def ask(*_a, **_kw):
            return {"status": 503, "time_s": 0.1, "answer_chars": None,
                    "reason": "провайдер недоступен", "retry_after": None}

        got = day30.run(client.Q4, "ollama 0.33.3", "abcdef1", through_prod=True,
                        generate=fake_generate("ответ"), ask=ask)
        self.assertTrue(any("не различают гипотез" in note for note in got["notes"]))
        # Лимиты через прод помечены «не проверялся», а не «не сработал»:
        # защита без проверки — не защита, и ложного «нет» на странице нет.
        fired = {row["name"]: row["fired"] for row in got["limits"]}
        self.assertIsNone(fired[f"запусков в минуту на адрес — {day30.RATE_WINDOW}"])

    def test_суммарные_ток_с_считаются_по_полному_времени_набора(self):
        got = day30.parallel_direct(client.Q4, 3, generate=fake_generate("ответ"))
        self.assertEqual(got["parallel"], 3)
        self.assertEqual(got["requests"], 3)
        self.assertIsNotNone(got["tps_total"])
        self.assertEqual(got["failures"], 0)

    def test_частота_считается_сработавшей_только_по_429(self):
        codes = iter([200, 200, 200, 200, 200, 429])

        def ask(*_a, **_kw):
            code = next(codes)
            return {"status": code, "time_s": 0.1, "answer_chars": 1,
                    "reason": "Слишком часто. Подождите минуту." if code == 429 else None,
                    "retry_after": None}

        got = day30.limit_rate(ask=ask)
        self.assertTrue(got["fired"])
        # Заголовка retry-after день 5 не отдаёт: различитель — слова отказа.
        self.assertIn("Подождите минуту", got["client_saw"])


if __name__ == "__main__":
    unittest.main()
