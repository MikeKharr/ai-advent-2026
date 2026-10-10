"""Преобразование «сырой вывод → файл страницы» против принятой спецификации.

ЧТО ЭТИ ТЕСТЫ ДЕРЖАТ. Форма публичного файла задана спецификацией раскладки
(`agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md`,
«Файл данных»), и расхождение с ней страница не покажет ошибкой — она просто
НЕ НАЙДЁТ поле и встанет в «пусто» либо в «частичный результат». То есть
расхождение формы молчит на экране, а значит обязано краснеть здесь.

Набор полей читается ИЗ САМОЙ СПЕЦИФИКАЦИИ (`ПоляИзСпецификации`), а не из
памяти автора: список в тесте разъехался бы с принятым документом так же
молча, как и код. Там, где спецификация задаёт закрытый набор («и ничего
больше» у стороны `b` дня 29), проверяется именно закрытость.

Живой Ollama и сети здесь нет вовсе: вход — словари, выход — словарь.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

RAG = Path(__file__).resolve().parent.parent
ROOT = RAG.parent
sys.path.insert(0, str(RAG / "eval"))

import features  # noqa: E402
import ollama_client as client  # noqa: E402
import report  # noqa: E402
import to_page  # noqa: E402

SPEC = (ROOT / "agent_docs" / "design"
        / "2026-10-09-1335-days26-30-local-llm-day-pages.md")


def normalize(raw: dict) -> dict:
    """Файл судьи → таблицы, тем же кодом, что и прогон.

    Тесты не подсовывают внутреннее представление: они отдают ФОРМУ ФАЙЛА и
    прогоняют её через `verdicts_of`. Иначе проверялось бы согласие теста с
    самим собой, а разбор настоящего файла судьи остался бы непроверенным.
    """
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "verdicts.json"
        path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        return to_page.verdicts_of(path)


def spec_text() -> str:
    text = SPEC.read_text(encoding="utf-8")
    at = text.index("## Файл данных")
    return text[at:text.index("## Состояния контента", at)]


# ---------- входы ----------

def raw26() -> dict:
    return {
        "day": 26, "generated": "2026-10-09T20:00:00Z", "commit": "abcdef1",
        "host": "ноутбук владельца", "model": client.Q4, "runner": "ollama 0.33.3",
        "notes": ["оговорка прогона"],
        "queries": [
            {"id": "t1_fact", "label": "факт одной фразой", "text": "промпт один",
             "complexity": 1, "verdict": "верно", "reason": "сверка факта",
             "check": {"kind": "подстрока", "ok": True}, "answer": "1889",
             "expected": "1889", "failed": False, "error": None,
             "done_reason": "stop", "ttft_s": 3.4, "tps": 10.5, "time_s": 4.0,
             "prompt_eval_count": 31, "eval_count": 14,
             "load_duration_ms": 2845.1, "prompt_eval_duration_ms": 240.0,
             "eval_duration_ms": 1300.0, "prompt_tokens_per_s": 129.1},
            {"id": "t2_translate", "label": "перевод абзаца", "text": "промпт два",
             "complexity": 2, "verdict": None, "reason": "смысловая сверка — судья",
             "check": None, "answer": "перевод", "expected": None,
             "failed": False, "error": None, "done_reason": "stop",
             "ttft_s": 1.2, "tps": 6.7, "time_s": 20.0,
             "prompt_eval_count": 128, "eval_count": 143,
             "load_duration_ms": None, "prompt_eval_duration_ms": 1000.0,
             "eval_duration_ms": 21000.0, "prompt_tokens_per_s": 128.0},
        ],
    }


def side(answer="ответ", **over) -> dict:
    base = {"answer": answer, "failed": False, "error": None, "done_reason": "stop",
            "time_s": 90.0, "ttft_s": 40.0, "tps": 8.1, "prompt_eval_count": 4300,
            "eval_count": 700, "quality": None, "retrieved": True, "cited": True,
            "key": True, "refused": False, "verdict": None}
    return {**base, **over}


def raw28() -> dict:
    return {
        "day": 28, "generated": "2026-10-09T21:00:00Z", "commit": "7900d26",
        "host": "ноутбук владельца", "model": client.Q4, "runner": "ollama 0.33.3",
        "notes": [],
        "memory": {"peak_rss_kib": 18_862_816, "peak_processes": [], "samples": 34},
        "questions": [
            {"id": "q08", "set": "first", "text": "что входит в DoD",
             "expect": "эталон", "key": "snapshot.md",
             "sources": ["agent_docs/guides/dod.md"],
             "fragments": [{"n": 1, "source": "agent_docs/guides/dod.md",
                            "section": "## Минимум", "score": 0.73}],
             "local": side()},
            {"id": "q94", "set": "missed", "text": "второй вопрос",
             "expect": "эталон", "key": "500", "sources": ["deploy/compose.yml"],
             "fragments": [{"n": 1, "source": "AGENTS.md", "section": "",
                            "score": 0.4}],
             "local": side(retrieved=False, time_s=110.0)},
            {"id": "m01", "set": "general", "text": "общий вопрос",
             "expect": "эталон", "key": None, "sources": [],
             "fragments": [], "local": side(retrieved=None, cited=None, key=None,
                                            refused=True, time_s=70.0)},
        ],
        "stability": [
            {"id": "q08", "set": "first", "runs": [
                {"time_s": 111.9, "ttft_s": 40.0, "tps": 8.15, "refused": False,
                 "done_reason": "stop", "answer": "раз"},
                {"time_s": 76.9, "ttft_s": 38.0, "tps": 7.98, "refused": False,
                 "done_reason": "stop", "answer": "два"},
                {"time_s": 82.0, "ttft_s": 39.0, "tps": 8.16, "refused": False,
                 "done_reason": "stop", "answer": "три"},
             ], "distinct_answers": 3},
            {"id": "m01", "set": "general", "runs": [
                {"time_s": 70.0, "ttft_s": 30.0, "tps": 8.0, "refused": True,
                 "done_reason": "stop", "answer": "отказ"},
                {"time_s": 71.0, "ttft_s": 31.0, "tps": 8.1, "refused": True,
                 "done_reason": "stop", "answer": "отказ"},
                {"time_s": 72.0, "ttft_s": 32.0, "tps": 8.2, "refused": True,
                 "done_reason": "stop", "answer": "отказ"},
             ], "distinct_answers": 1},
        ],
        "incidents": [],
    }


def cloud22() -> dict:
    return {"questions": [
        {"id": "q08", "modes": {"rag": {"answer": "облачный ответ", "retrieved": True,
                                        "cited": True, "key": True, "refused": False,
                                        "verdict": 2}}},
        {"id": "q94", "modes": {"rag": {"answer": "облачный два", "retrieved": True,
                                        "cited": False, "key": False, "refused": False,
                                        "verdict": 1}}},
        {"id": "m01", "modes": {"rag": {"answer": "отказ", "retrieved": None,
                                        "cited": None, "key": None, "refused": True,
                                        "verdict": None}}},
    ]}


def variant(axis_id, label, group, options, rows, model=client.Q4, **over) -> dict:
    return {"id": axis_id, "label": label, "group": group, "options": options,
            "model": model, "numbers_only": False, "summary": {}, "answers": rows,
            **over}


def raw29() -> dict:
    base_options = {"num_predict": 800, "temperature": 1, "num_ctx": 16384}
    rows = [{"id": "q08", **side()}, {"id": "q94", **side()}]
    quant_rows = [{"id": "q08", "model": client.Q6, "answer_chars": 420,
                   "time_s": 150.0, "ttft_s": 55.0, "tps": 6.1, "refused": False,
                   "retrieved": True, "cited": True, "key": True, "quality": None,
                   "verdict": None, "failed": False, "done_reason": "stop"}]
    return {
        "day": 29, "generated": "2026-10-10T01:00:00Z", "commit": "7900d26",
        "host": "ноутбук владельца", "model": client.Q4, "runner": "ollama 0.33.3",
        "notes": [], "memory": {"peak_rss_kib": 18_862_816},
        "prompts": {"before": "реестровый промпт", "after": "компактный промпт"},
        "base": {"options": base_options, "summary": {}, "answers": rows},
        "after": {"options": base_options, "think": False, "summary": {},
                  "answers": rows, "chosen": {"axes": [], "reasons": []}},
        "variants": [
            variant("temperature", "temperature 1 → 0,2", "параметры",
                    {**base_options, "temperature": 0.2}, rows),
            variant("think", "think false → true", "параметры", base_options, rows,
                    think=True),
            variant("prompt", "промпт реестра → компактный", "промпт", base_options,
                    rows, system="компактный промпт"),
            variant("quant", "квантование Q4_K_M → Q6_K", "квантизация", base_options,
                    quant_rows, model=client.Q6, numbers_only=True, think=None,
                    forced="think не просим"),
        ],
    }


def raw30() -> dict:
    return {
        "day": 30, "generated": "2026-10-10T05:00:00Z", "commit": "abcdef1",
        "host": "ноутбук владельца", "model": client.Q4, "runner": "ollama 0.33.3",
        "access": {"how": "частная сеть", "without": "не доходит",
                   "where_key": "на сервере"},
        "concurrency": [
            {"path": "напрямую в Ollama", "parallel": 1, "requests": 1,
             "tps_total": 8.0, "ttft_s_median": 40.0, "wall_s": 90.0, "failures": 0},
            {"path": "напрямую в Ollama", "parallel": 3, "requests": 3,
             "tps_total": 9.0, "ttft_s_median": 120.0, "wall_s": 240.0, "failures": 0},
            {"path": "через публичный API дня 5", "parallel": 3, "requests": 3,
             "tps_total": None, "ttft_s_median": None, "wall_s": 12.0, "failures": 2,
             "statuses": [200, 503, 503], "reasons": ["ёмкость хоста исчерпана"]},
        ],
        "limits": [
            {"name": "запусков в минуту на адрес — 5", "value": "5", "fired": True,
             "client_saw": "429, retry-after 41", "statuses": [200] * 5 + [429]},
            {"name": "maxRequestTokens — 6000", "value": "6000", "fired": None,
             "client_saw": "не проверялся: провайдер недоступен"},
        ],
    }


# ---------- тесты ----------

class ПоляИзСпецификации(unittest.TestCase):
    """Набор полей сверяется с принятым документом, а не со списком в тесте.

    Иначе копия списка разъехалась бы со спецификацией молча — тем же
    образом, каким расходятся две копии кода.
    """

    def fields_of(self, pattern: str, inline: bool = False) -> set[str]:
        """Имена полей из фрагмента спецификации.

        `inline` — для перечислений вида `{ id, text, local: {...} }`: имена
        берутся через запятую, а вложенные объекты и списки выбрасываются,
        иначе `path` и `section` из `sources: [{path, section}]` попали бы в
        набор полей самой стороны.
        """
        text = spec_text()
        match = re.search(pattern, text, re.S)
        self.assertIsNotNone(match, f"в спецификации не найдено: {pattern}")
        body = match.group(1)
        if not inline:
            return set(re.findall(r"`([a-z_]+)`", body))
        flat = re.sub(r"\[[^\]]*\]", "", re.sub(r"\{[^{}]*\}", "", body))
        names = {part.split(":")[0].strip(" `\n") for part in flat.split(",")}
        found = {name for name in names if re.fullmatch(r"[a-z_]+", name)}
        self.assertTrue(found, f"из спецификации не извлеклось ни одного поля: {pattern}")
        return found

    def test_конверт_несёт_все_поля_спецификации(self):
        want = self.fields_of(r"### Общий конверт.*?```json(.*?)```")
        # `judge` и `notes` спецификация объявляет необязательными; остальное
        # обязано быть в каждом файле.
        required = want - {"judge", "notes", "stability_ids"}
        for day, payload in (
            (26, to_page.build(26, raw26())),
            (28, to_page.build(28, raw28(), cloud=cloud22())),
            (29, to_page.build(29, raw29())),
            (30, to_page.build(30, raw30())),
        ):
            with self.subTest(day=day):
                self.assertTrue(required <= set(payload), required - set(payload))

    def test_день_26_поля_записи_запроса(self):
        want = self.fields_of(r"\*\*День 26\.\*\* `prompts\[\]`: `\{(.*?)\}`", inline=True)
        got = set(to_page.build(26, raw26())["prompts"][0])
        self.assertTrue(want <= got, want - got)

    def test_день_28_поля_сводки_и_вопроса(self):
        payload = to_page.build(28, raw28(), cloud=cloud22())
        want = self.fields_of(r"в каждом —\s*`\{(.+?)\}`", inline=True)
        self.assertTrue(want <= set(payload["summary"]["local"]),
                        want - set(payload["summary"]["local"]))
        want_q = self.fields_of(r"`questions\[\]`: `\{(.+?)\}`", inline=True)
        self.assertTrue(want_q <= set(payload["questions"][0]),
                        want_q - set(payload["questions"][0]))
        want_side = self.fields_of(r"каждой стороне — `\{(.+?)\}`", inline=True)
        self.assertTrue(want_side <= set(payload["questions"][0]["local"]),
                        want_side - set(payload["questions"][0]["local"]))

    def test_день_29_поля_оси_и_квантования(self):
        payload = to_page.build(29, raw29())
        want = self.fields_of(r"`axes\[\]`:\s*`\{(.+?)\}`", inline=True)
        self.assertTrue(want <= set(payload["axes"][0]), want - set(payload["axes"][0]))
        want_quant = self.fields_of(r"`quant`: `\{ a: \{(.+?)\}", inline=True)
        self.assertTrue(want_quant <= set(payload["quant"]["a"]),
                        want_quant - set(payload["quant"]["a"]))

    def test_день_30_поля_залпа_и_ограничений(self):
        payload = to_page.build(30, raw30())
        want = self.fields_of(r"`burst\[\]`: `\{(.+?)\}`", inline=True)
        self.assertTrue(want <= set(payload["burst"][0]), want - set(payload["burst"][0]))
        want_limits = self.fields_of(r"`limits\[\]`: `\{(.+?)\}`", inline=True)
        self.assertTrue(want_limits <= set(payload["limits"][0]),
                        want_limits - set(payload["limits"][0]))


class КонвертСтраницы(unittest.TestCase):
    def test_повторов_на_вопрос_один_и_это_поле_а_не_слово(self):
        # Страница печатает `repeats` в границах меры, а не зашивает словом:
        # сделает прогон когда-нибудь три — страница скажет «три».
        self.assertEqual(to_page.build(28, raw28())["repeats"], 1)

    def test_вопросы_стабильности_названы_в_конверте(self):
        payload = to_page.build(28, raw28(), cloud=cloud22())
        self.assertEqual(payload["stability_ids"], ["q08", "m01"])

    def test_у_дня_30_судьи_нет_вовсе_а_не_null(self):
        # «Отсутствует там, где оценка механическая»: `null` читался бы как
        # «судья не дошёл», а у дня 30 судьи не бывает по природе замера.
        self.assertNotIn("judge", to_page.build(30, raw30()))
        self.assertIn("judge", to_page.build(28, raw28()))

    def test_имя_судьи_приходит_файлом_а_не_выдумывается(self):
        payload = to_page.build(28, raw28(), cloud=cloud22())
        self.assertIsNone(payload["judge"])
        judged = to_page.build(28, raw28(), cloud=cloud22(),
                               verdicts=normalize({"judge": "экземпляр роли reviewer",
                                                   "local": {"q08": 2}}))
        self.assertEqual(judged["judge"], "экземпляр роли reviewer")

    def test_машина_подписана_словами_и_одинаково_у_всех_дней(self):
        hosts = {to_page.build(day, raw)["host"] for day, raw in
                 ((26, raw26()), (28, raw28()), (29, raw29()), (30, raw30()))}
        self.assertEqual(hosts, {report.HOST_WORDS})
        self.assertNotRegex(report.HOST_WORDS, r"\d+\.\d+\.\d+\.\d+")

    def test_оговорка_про_пик_rss_приезжает_в_каждый_файл_с_памятью(self):
        # Сумма берётся по ВСЕМ процессам Ollama, а служб на ноутбуке две.
        # Без этой строки число читалось бы как «столько занимает модель».
        self.assertIn(report.RSS_NOTE, to_page.build(28, raw28())["notes"])
        self.assertIn(report.RSS_NOTE, to_page.build(29, raw29())["notes"])
        # У дня 30 пика RSS в сыром файле нет — и оговорки быть не должно.
        self.assertNotIn(report.RSS_NOTE, to_page.build(30, raw30()).get("notes", []))

    def test_перепутанный_день_это_отказ_а_не_чужие_числа(self):
        with self.assertRaises(SystemExit):
            to_page.build(28, raw29())

    def test_у_дня_27_файла_данных_нет_вовсе(self):
        self.assertNotIn(27, to_page.DAYS)
        with self.assertRaises(SystemExit):
            to_page.build(27, {"day": 27})


class ДеньДвадцатьШесть(unittest.TestCase):
    def test_способ_оценки_выводится_из_факта_проверки(self):
        rows = to_page.build(26, raw26())["prompts"]
        self.assertEqual(rows[0]["scored_by"], "механически")
        self.assertEqual(rows[0]["verdict"], "верно")
        # Где механической проверки не было — оценка судьи, и до судейства
        # вердикта нет вовсе.
        self.assertEqual(rows[1]["scored_by"], "судья")
        self.assertIsNone(rows[1]["verdict"])

    def test_вердикт_судьи_подставляется_только_туда_где_судья(self):
        payload = to_page.build(26, raw26(),
                                verdicts=normalize({"judge": "имя",
                                            "local": {"t1_fact": 0, "t2_translate": 1}}))
        rows = {row["id"]: row for row in payload["prompts"]}
        # Механическую проверку судья не перебивает: она сильнее мнения модели.
        self.assertEqual(rows["t1_fact"]["verdict"], "верно")
        self.assertEqual(rows["t2_translate"]["verdict"], "частично")

    def test_токены_и_причина_остановки_доезжают(self):
        row = to_page.build(26, raw26())["prompts"][0]
        self.assertEqual((row["prompt_tokens"], row["answer_tokens"]), (31, 14))
        self.assertEqual(row["done_reason"], "stop")
        self.assertEqual(row["level"], 1)

    def test_массива_runs_у_дня_26_нет(self):
        # «Массива `runs` нет: прогон один» — спецификация, «День 26».
        self.assertNotIn("runs", to_page.build(26, raw26())["prompts"][0])

    def test_ступень_меренная_дважды_помечена_отсутствием_а_не_молчанием(self):
        payload = to_page.build(26, raw26())
        self.assertTrue(all(row["mode"] is None for row in payload["prompts"]))
        self.assertTrue(any("рассуждение" in note for note in payload["notes"]))


class ДеньДвадцатьВосемь(unittest.TestCase):
    def payload(self, **over):
        return to_page.build(28, raw28(), cloud=cloud22(), **over)

    def test_среднее_а_не_медиана_и_по_разным_вопросам(self):
        got = self.payload()["summary"]["local"]
        self.assertEqual(got["answers"], 3)
        self.assertEqual(got["time_s_mean"], features.mean_or_none([90.0, 110.0, 70.0]))
        # Медианы на страницах нет ни у одного дня — спецификация запрещает
        # подписи вроде «медиана» и требует среднее по десяти разным вопросам.
        self.assertNotIn("time_s_median", got)

    def test_счётчики_признаков_в_сводке(self):
        got = self.payload()["summary"]["local"]
        self.assertEqual(got["retrieved"], 1)
        self.assertEqual(got["cited"], 2)
        self.assertEqual(got["refused"], 1)

    def test_средняя_оценка_без_судьи_это_нет_данных_а_не_ноль(self):
        self.assertIsNone(self.payload()["summary"]["local"]["score_avg"])
        judged = self.payload(verdicts=normalize(
            {"judge": "имя", "local": {"q08": 2, "q94": 1}}))
        self.assertEqual(judged["summary"]["local"]["score_avg"], 1.5)

    def test_вердикты_облака_берутся_из_файла_дня_22(self):
        # Тот же судья и та же рубрика: второй раз их не просят.
        cloud = self.payload()["summary"]["cloud"]
        self.assertEqual(cloud["score_avg"], features.mean_or_none([2, 1]))
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertEqual(questions["q08"]["cloud"]["verdict"], "верно")
        self.assertEqual(questions["q94"]["cloud"]["verdict"], "частично")

    def test_поиск_совпал_только_когда_верный_документ_нашли_оба(self):
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertIs(questions["q08"]["retrieved_match"], True)
        # Локально не нашли, в облаке нашли — не совпал, и вывод дня этот
        # вопрос не берёт.
        self.assertIs(questions["q94"]["retrieved_match"], False)
        # У общего вопроса верного документа нет вовсе: нечего совпадать.
        self.assertIsNone(questions["m01"]["retrieved_match"])

    def test_runs_ровно_у_вопросов_стабильности_и_ровно_три(self):
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertEqual(len(questions["q08"]["local"]["runs"]), 3)
        self.assertEqual(len(questions["m01"]["local"]["runs"]), 3)
        # Остальным это поле не положено — ни локально, ни в облаке.
        self.assertNotIn("runs", questions["q94"]["local"])
        for row in self.payload()["questions"]:
            self.assertNotIn("runs", row["cloud"])

    def test_время_облака_без_замера_остаётся_пустым_и_сказано_словами(self):
        payload = self.payload()
        self.assertTrue(all(row["cloud"]["time_s"] is None
                            for row in payload["questions"]))
        self.assertTrue(any("Время облачной стороны не измерено" in note
                            for note in payload["notes"]))
        timed = self.payload(times={"q08": 12.5})
        questions = {row["id"]: row for row in timed["questions"]}
        self.assertEqual(questions["q08"]["cloud"]["time_s"], 12.5)

    def test_выдачи_поиска_облака_нет_и_это_названо_а_не_пусто_молча(self):
        payload = self.payload()
        questions = {row["id"]: row for row in payload["questions"]}
        self.assertEqual(questions["q08"]["local"]["sources"],
                         [{"path": "agent_docs/guides/dod.md", "section": "## Минимум"}])
        self.assertEqual(questions["q08"]["cloud"]["sources"], [])
        self.assertTrue(any("Выдачи поиска облачной стороны в файле нет" in note
                            for note in payload["notes"]))

    def test_облачной_стороны_нет_вовсе_страница_не_ломается(self):
        payload = to_page.build(28, raw28())
        self.assertEqual(payload["summary"]["cloud"]["answers"], 3)
        self.assertIsNone(payload["summary"]["cloud"]["score_avg"])
        self.assertTrue(all(row["cloud"]["answer"] is None
                            for row in payload["questions"]))


class ВердиктыСудьи(unittest.TestCase):
    """Разбор файла судьи в той форме, в какой он его пишет.

    Форма — его, а не наша: `local` список записей с `run`, `cloud` список без
    `run`. Проверяется разбор именно её, потому что подмена формы в тесте
    оставила бы настоящий файл непроверенным, а на экране это выглядело бы как
    «судья не дошёл» при готовых вердиктах.
    """

    JUDGED = {
        "judge": "reviewer (экземпляр-судья)", "rubric": "0/1/2",
        "local": [
            {"id": "q08", "run": 1, "verdict": 2, "note": "слова судьи раз"},
            {"id": "q08", "run": 2, "verdict": 1, "note": "слова судьи два"},
            {"id": "q08", "run": 3, "verdict": 0, "note": "слова судьи три"},
            {"id": "q94", "run": 1, "verdict": 1, "note": "про q94"},
            {"id": "m01", "run": 1, "verdict": 2, "note": "про m01"},
            {"id": "m01", "run": 2, "verdict": 2, "note": ""},
            {"id": "m01", "run": 3, "verdict": 2, "note": ""},
        ],
        "cloud": [
            {"id": "q08", "verdict": 2, "note": "облачные слова"},
            {"id": "q94", "verdict": 0, "note": "облачные слова два"},
        ],
        "notes": ["граница меры от судьи"],
    }

    def payload(self):
        return to_page.build(28, raw28(), cloud=cloud22(),
                             verdicts=normalize(self.JUDGED))

    def test_имя_и_рубрика_судьи_читаются(self):
        table = normalize(self.JUDGED)
        self.assertEqual(table["judge"], "reviewer (экземпляр-судья)")
        self.assertEqual(table["rubric"], "0/1/2")
        self.assertEqual(self.payload()["judge"], "reviewer (экземпляр-судья)")

    def test_основной_ответ_вопроса_это_первый_прогон(self):
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertEqual(questions["q08"]["local"]["score"], 2)
        self.assertEqual(questions["q08"]["local"]["verdict"], "верно")

    def test_у_каждого_повтора_свой_вердикт_а_не_копия_первого(self):
        # Секция стабильности обязана показать РАСХОЖДЕНИЕ вердиктов; копия
        # первого вердикта во все три повтора прятала бы ровно это.
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertEqual([one["verdict"] for one in questions["q08"]["local"]["runs"]],
                         ["верно", "частично", "неверно"])
        self.assertEqual([one["verdict"] for one in questions["m01"]["local"]["runs"]],
                         ["верно", "верно", "верно"])

    def test_слова_судьи_доезжают_до_обеих_сторон(self):
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertEqual(questions["q08"]["local"]["judge_note"], "слова судьи раз")
        self.assertEqual(questions["q08"]["cloud"]["judge_note"], "облачные слова")

    def test_вердикт_судьи_сильнее_вердикта_из_файла_дня_22(self):
        # В файле дня 22 у q94 стоит 1, судья этого прогона поставил 0. Берётся
        # оценка судьи ЭТОГО прогона: иначе сравнение несло бы разницу судей,
        # а не разницу сторон (ADR недели, п. 3.4).
        questions = {row["id"]: row for row in self.payload()["questions"]}
        self.assertEqual(questions["q94"]["cloud"]["score"], 0)

    def test_средняя_оценка_по_сторонам_из_вердиктов(self):
        payload = self.payload()
        self.assertEqual(payload["summary"]["local"]["score_avg"],
                         features.mean_or_none([2, 1, 2]))
        self.assertEqual(payload["summary"]["cloud"]["score_avg"],
                         features.mean_or_none([2, 0]))

    def test_границы_меры_от_судьи_доезжают_до_notes(self):
        self.assertIn("граница меры от судьи", self.payload()["notes"])

    def test_вердикт_вне_рубрики_не_принимается(self):
        table = normalize({"judge": "имя",
                           "local": [{"id": "q08", "run": 1, "verdict": "2"},
                                     {"id": "q94", "run": 1, "verdict": 5}]})
        self.assertEqual(table["scores"]["local"], {})

    def test_средняя_по_совпавшему_поиску_в_файл_не_идёт(self):
        # Спецификация относит отбор вопросов с совпавшим поиском к тому, что
        # страница считает САМА: «иначе файл сможет сказать „локальная не
        # хуже“ при числах, говорящих обратное». Поэтому в файле лежит то, из
        # чего страница это посчитает, а не готовый вывод.
        flat = json.dumps(self.payload(), ensure_ascii=False)
        self.assertNotIn("score_avg_matched", flat)
        self.assertNotIn("matched", flat)
        # Перенос строки в документе различием не считается.
        self.assertIn("отбор вопросов с совпавшим поиском",
                      " ".join(spec_text().split()))


class ГраницыМерыИзЧисел(unittest.TestCase):
    """Находки судейства, которые ВЫВОДЯТСЯ из прогона, а не вписываются.

    Вписанные руками, они относились бы к одному прогону и врали бы на
    следующем: обрезанный ответ и холодный старт бывают у разных вопросов.
    """

    def test_обрезанный_по_потолку_ответ_назван_вопросом(self):
        raw = raw28()
        raw["questions"][1]["local"]["done_reason"] = "length"
        notes = to_page.build(28, raw)["notes"]
        found = [note for note in notes if "потолок num_predict" in note]
        self.assertEqual(len(found), 1)
        self.assertIn("q94", found[0])
        # У прогона без обрезок этой строки быть не должно: иначе страница
        # оговаривалась бы о том, чего не было.
        self.assertFalse([note for note in to_page.build(28, raw28())["notes"]
                          if "потолок num_predict" in note])

    def test_без_холодного_старта_строки_нет(self):
        # У вопроса стабильности в наборе времена 40 / 38 / 39 с — это
        # разброс, а не холодный старт, и оговорки о загрузке весов быть не
        # должно: иначе страница объясняла бы разброс тем, чего не было.
        self.assertFalse([note for note in to_page.build(28, raw28())["notes"]
                          if "загрузку весов" in note])

    def test_холодный_старт_ловится_когда_он_есть(self):
        raw = raw28()
        raw["stability"][0]["runs"][0]["ttft_s"] = 31.74
        raw["stability"][0]["runs"][1]["ttft_s"] = 0.33
        raw["stability"][0]["runs"][2]["ttft_s"] = 0.34
        found = [note for note in to_page.build(28, raw)["notes"]
                 if "загрузку весов" in note]
        self.assertEqual(len(found), 1)
        self.assertIn("q08", found[0])
        self.assertIn("31.74", found[0])

    def test_признаки_ловят_форму_и_это_сказано_словами(self):
        notes = to_page.build(28, raw28())["notes"]
        self.assertTrue(any("ловят форму, а не смысл" in note for note in notes))
        self.assertTrue(any("совпал ДОКУМЕНТ, а не фрагмент" in note for note in notes))


class ДеньДвадцатьДевять(unittest.TestCase):
    def test_оси_названы_значениями_до_и_после(self):
        axes = {axis["name"]: axis for axis in to_page.build(29, raw29())["axes"]}
        self.assertEqual(axes["temperature 1 → 0,2"]["before"], 1)
        self.assertEqual(axes["temperature 1 → 0,2"]["after"], 0.2)
        # У промпта в ячейке слово, а не текст: два абзаца промпта в ячейке
        # таблицы нечитаемы.
        self.assertEqual(
            (axes["промпт реестра → компактный"]["before"],
             axes["промпт реестра → компактный"]["after"]),
            ("полный", "компактный"))
        self.assertEqual((axes["think false → true"]["before"],
                          axes["think false → true"]["after"]),
                         ("выключено", "включено"))

    def test_число_изменённых_осей_считается_а_не_обещается(self):
        axes = {axis["name"]: axis for axis in to_page.build(29, raw29())["axes"]}
        self.assertEqual(axes["temperature 1 → 0,2"]["changed"], 1)
        # Ось квантования меняет две вещи — сборку и отсутствие рассуждения,
        # которого у неё нет. Страница обязана сказать «менялось 2 оси разом»,
        # а не промолчать.
        self.assertEqual(axes["квантование Q4_K_M → Q6_K"]["changed"], 2)

    def test_память_по_осям_без_замера_пуста_и_сказано_словами(self):
        payload = to_page.build(29, raw29())
        self.assertTrue(all(axis["mem_mib"] is None for axis in payload["axes"]))
        self.assertTrue(any("Память по осям не мерена" in note
                            for note in payload["notes"]))
        fed = to_page.build(29, raw29(), memory={"temperature": 18_862_816})
        axes = {axis["name"]: axis for axis in fed["axes"]}
        self.assertEqual(axes["temperature 1 → 0,2"]["mem_mib"], 18420.7)

    def test_у_стороны_b_квантования_только_числа_и_ничего_больше(self):
        quant = to_page.build(29, raw29())["quant"]
        self.assertEqual(set(quant["b"]),
                         {"label", "model", "ttft_s", "tps", "mem_mib", "correct", "of"})
        # Спецификация говорит «и ничего больше»: ни `answer`, ни `prompt`, ни
        # `judge_note` у этой стороны в файле нет.
        for forbidden in ("answer", "prompt", "judge_note", "answers", "response"):
            self.assertNotIn(forbidden, quant["b"])
        self.assertEqual(quant["b"]["model"], client.Q6)
        self.assertEqual(quant["a"]["label"], "Q4_K_M")

    def test_верных_из_n_без_судьи_это_нет_данных_а_не_ноль(self):
        quant = to_page.build(29, raw29())["quant"]
        self.assertIsNone(quant["b"]["correct"])
        self.assertEqual(quant["b"]["of"], 1)
        judged = to_page.build(29, raw29(),
                               verdicts=normalize(
                                   {"judge": "имя", "quant": {"q08": 2}}))["quant"]
        self.assertEqual(judged["b"]["correct"], 1)

    def test_промпты_только_базовой_модели(self):
        payload = to_page.build(29, raw29())
        self.assertEqual(payload["prompts"],
                         {"before": "реестровый промпт", "after": "компактный промпт"})

    def test_повторов_стабильности_в_дне_29_не_было_и_это_сказано(self):
        payload = to_page.build(29, raw29())
        self.assertEqual(payload["stability_ids"], [])
        self.assertTrue(any("не повторялись" in note for note in payload["notes"]))

    def test_база_и_после_имеют_форму_стороны(self):
        payload = to_page.build(29, raw29())
        for key in ("base", "after"):
            self.assertEqual(set(payload[key]),
                             {"score_avg", "retrieved", "cited", "refused",
                              "time_s_mean", "answers"})


class ДеньТридцать(unittest.TestCase):
    def test_залп_берёт_путь_из_записи_а_не_угадывает(self):
        burst = to_page.build(30, raw30())["burst"]
        # Одиночный запрос в залп не идёт: «три запроса разом» — две строки.
        self.assertEqual([row["path"] for row in burst],
                         ["напрямую в Ollama", "через публичный API дня 5"])

    def test_обслужено_и_отказано_числами_и_причина_словами(self):
        burst = {row["path"]: row for row in to_page.build(30, raw30())["burst"]}
        api = burst["через публичный API дня 5"]
        self.assertEqual((api["requests"], api["served"], api["refused"]), (3, 1, 2))
        self.assertEqual(api["reason"], "ёмкость хоста исчерпана")
        self.assertEqual(api["total_s"], 12.0)
        direct = burst["напрямую в Ollama"]
        self.assertEqual((direct["served"], direct["refused"]), (3, 0))

    def test_непроверенное_ограничение_помечено_третьим_случаем(self):
        limits = {row["name"]: row for row in to_page.build(30, raw30())["limits"]}
        self.assertIs(limits["запусков в минуту на адрес — 5"]["fired"], True)
        # «Не проверялось» — честный третий случай, а не пустая ячейка:
        # защита без отрицательной пробы не защита.
        self.assertIsNone(limits["maxRequestTokens — 6000"]["fired"])
        self.assertEqual(set(limits["maxRequestTokens — 6000"]),
                         {"name", "value", "fired", "client_saw"})

    def test_текстов_ответов_в_файле_дня_30_нет_ни_в_одном_поле(self):
        payload = to_page.build(30, raw30())
        flat = json.dumps(payload, ensure_ascii=False)
        for forbidden in ('"answer"', '"response"', '"prompt"'):
            self.assertNotIn(forbidden, flat)


class ГотовыйФайлСтраницыНеЗатирается(unittest.TestCase):
    """Перезапись файла страницы — решение вслух, а не побочный эффект.

    Повод конкретный: `site/day26/results.json` уже выкачен (PR #339) и несёт
    поля, которых это преобразование не производит вовсе. Прогон поверх него
    оставил бы страницу без половины таблиц, и заметил бы это посетитель, а
    не прогон: `site/` не единица CI, и файл данных не проверяет ничто.
    """

    def test_существующий_файл_без_force_не_перезаписывается(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            out.write_text('{"день": "чужой файл"}', encoding="utf-8")
            source = Path(tmp) / "raw.json"
            source.write_text(json.dumps(raw28(), ensure_ascii=False), encoding="utf-8")
            code = to_page.main(["--day", "28", "--in", str(source), "--out", str(out)])
            self.assertEqual(code, 1)
            # Файл цел: ни одного байта не тронуто.
            self.assertEqual(out.read_text(encoding="utf-8"), '{"день": "чужой файл"}')
            # С флагом — перезаписывается.
            self.assertEqual(to_page.main(["--day", "28", "--in", str(source),
                                           "--out", str(out), "--force"]), 0)
            self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["day"], 28)

    def test_поля_выкаченной_страницы_дня_26_не_теряются_молча(self):
        """Что именно потерялось бы — названо числом, а не словом «что-то».

        Тест читает ВЫКАЧЕННЫЙ файл дня 26 и перечисляет поля, которых
        преобразование не производит. Если список опустеет (преобразование
        догнало страницу) — тест упадёт и скажет, что оговорку о `--force`
        пора сузить. Если вырастет — скажет, что выросла и цена перезаписи.
        """
        shipped = ROOT / "site" / "day26" / "results.json"
        if not shipped.is_file():
            raise AssertionError(f"выкаченного файла дня 26 нет: {shipped}")
            # Отсутствие файла — не повод пропустить проверку молча: страница
            # дня 26 в проде, и её пропажа сама по себе находка.
        live = json.loads(shipped.read_text(encoding="utf-8"))
        made = to_page.build(26, raw26())
        missing = sorted(set(live) - set(made))
        self.assertEqual(missing, ["access", "options", "speculative",
                                   "speed_vs_content", "think"])
        # А вот поля записи запроса преобразование производит почти все:
        # расхождение здесь означало бы, что страница читает то, чего прогон
        # не снимает.
        live_row = set(live["prompts"][0])
        made_row = set(made["prompts"][0])
        self.assertEqual(sorted(live_row - made_row), ["note", "series"])


class ЗаписьТолькоЧерезСтражей(unittest.TestCase):
    """Публичный файл страницы пишется теми же двумя стражами.

    Преобразование — второе место, где публичный файл рождается, и обойти
    стражей здесь было бы ровно так же дорого, как в прогоне: тексты сборки
    без отказов и адрес стенда уехали бы на страницу.
    """

    def test_файл_страницы_пишется_через_write_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            source = Path(tmp) / "raw.json"
            source.write_text(json.dumps(raw28(), ensure_ascii=False), encoding="utf-8")
            self.assertEqual(to_page.main(["--day", "28", "--in", str(source),
                                           "--out", str(out)]), 0)
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(payload["day"], 28)

    def test_текст_сборки_без_отказов_на_страницу_не_попадает_из_сырого_файла(self):
        raw = raw29()
        # Текст под записью сборки без отказов — ровно та утечка, которой
        # нельзя доехать до публичной страницы. Прогон его туда не кладёт, но
        # сырой файл может прийти и от черновых скриптов каталога замеров, где
        # тексты собирались.
        raw["variants"][-1]["answers"][0]["answer"] = "текст сборки без отказов"
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            source = Path(tmp) / "raw.json"
            source.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(to_page.main(["--day", "29", "--in", str(source),
                                           "--out", str(out)]), 0)
            written = out.read_text(encoding="utf-8")
        # Защита здесь ПОСТРОЕНИЕМ, а не стражем: от этой оси в файл страницы
        # идёт закрытый набор числовых полей, записи ответов не переносятся
        # вовсе, и стражу на выходе ловить уже нечего. Поэтому проверяется
        # результат, а не исключение — утверждать «страж поймал» было бы
        # неверно.
        self.assertNotIn("текст сборки без отказов", written)
        payload = json.loads(written)
        self.assertEqual(set(payload["quant"]["b"]),
                         {"label", "model", "ttft_s", "tps", "mem_mib", "correct", "of"})

    def test_страж_текстов_стоит_и_на_пути_страницы(self):
        # Отдельно от предыдущего: начни преобразование когда-нибудь
        # переносить записи оси целиком — запись файла обязана упасть, а не
        # отдать текст на публичную страницу.
        payload = {**to_page.build(29, raw29()),
                   "variants": [{"model": client.Q6, "answer": "текст сборки"}]}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            with self.assertRaises(ValueError):
                report.write_results(out, payload)
            self.assertFalse(out.exists())

    def test_адрес_в_сыром_файле_валит_запись_страницы(self):
        raw = raw30()
        raw["access"]["how"] = "ходи на 100.77.87.97:11434"
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "results.json"
            source = Path(tmp) / "raw.json"
            source.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(ValueError):
                to_page.main(["--day", "30", "--in", str(source), "--out", str(out)])
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
