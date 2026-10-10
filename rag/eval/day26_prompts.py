"""День 26 — запросы разной сложности к локальной модели.

Перенос прогона 2026-10-09 из `…-measurements/scripts/day26.py` (ADR
2026-10-09-1335, п. 1.4: «скрипты переезжают сюда этим же PR»). Набор и
параметры здесь ТЕ ЖЕ, что в состоявшемся прогоне, — именно поэтому числа,
которые уже собраны, этим файлом воспроизводятся.

РАСХОЖДЕНИЕ С П. 2 ADR, И ОНО НАЗВАНО ВСЛУХ. Пункт 2 проектировал шесть
запросов по три повтора при `temperature` 1. Состоявшийся прогон сделал восемь
запросов по одному при `temperature` 0 и `seed` 42. Переписать набор под п. 2
значило бы обесценить уже собранные числа, а держать два набора — завести
второй источник. Выбран перенос состоявшегося; повторяемость при этом
проверяется не повтором с температурой, а тем, что `seed` фиксирован (разброс
одного и того же запроса между прогонами — 3,2 %, журнал замеров).

Единые параметры на все запросы нужны, чтобы разница во времени объяснялась
запросом, а не перезагрузкой модели: Ollama поднимает новый экземпляр модели
на каждое изменение `num_ctx` и перечитывает 17 ГБ весов.

Запуск:

    EVAL_OLLAMA_URL=http://127.0.0.1:11435 python3 -B eval/day26_prompts.py \\
      --out ~/Projects/ai-advent-2026-measurements/runs/day26-results.json

`-B` и чистка `__pycache__` обязательны, `-I` — нет: он включает
изолированный режим, каталог скрипта в `sys.path` не попадает, и прогон
падает с `ModuleNotFoundError`. Байт-код отключает `-B`.

Прогон пишет СЫРОЙ вывод в каталог замеров. Файл страницы по
спецификации раскладки делает отдельный шаг:
`python3 -B eval/to_page.py --day 26 --in <сырой> --out ../site/day26/results.json`.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import checks  # noqa: E402
import features  # noqa: E402
import ollama_client as client  # noqa: E402
import prompt as prompts  # noqa: E402
import report  # noqa: E402

OPTIONS = {"num_ctx": 16384, "temperature": 0, "seed": 42}

# Документ длинного входа — файл репозитория, а не копия: правка архитектуры
# меняет вход замера, и это верно. Длина входа пишется в файл результата.
LONG_DOC = prompts.ROOT / "agent_docs" / "architecture.md"

JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "sphere": {"type": "string"},
        "items": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "company": {"type": "string"},
                    "year": {"type": "integer"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "company", "year", "tags"],
            },
        },
    },
    "required": ["sphere", "items"],
}


def tasks(document: str) -> list[dict]:
    """Восемь запросов по пяти ступеням сложности — дословно как в прогоне."""
    return [
        {
            "id": "t1_fact", "complexity": 1, "label": "факт одной фразой (EN)",
            "text": "In what year was the Eiffel Tower completed? "
                    "Answer in one short sentence, nothing else.",
            "expected": "1889", "check": "contains",
            "how": "сверка факта подстрокой",
        },
        {
            "id": "t2_translate", "complexity": 2, "label": "перевод абзаца EN→RU",
            "text": "Переведи на русский язык следующий абзац. "
                    "Выдай только перевод, без комментариев.\n\n"
                    "Rate limiting is the practice of capping how many requests a "
                    "client may send in a given window of time. A public endpoint "
                    "backed by a paid API key needs it not as a nicety but as a "
                    "budget control: without a cap, a single visitor with a script "
                    "can exhaust a daily allowance in minutes. The usual answer is "
                    "a counter keyed by client address, checked before the upstream "
                    "call is made rather than after, so that a rejected request "
                    "costs nothing but a database read.",
            "expected": None, "check": None,
            "how": "смысловая сверка перевода — судья",
        },
        {
            "id": "t3_arithmetic", "complexity": 3,
            "label": "рассуждение в несколько шагов и арифметика",
            "text": "Склад получил 1250 ящиков. 18% из них повреждены и списаны. "
                    "Из оставшихся ящиков 2/5 отправлены в филиал А, остальные — в "
                    "филиал Б. Каждый ящик в филиале Б содержит 24 единицы товара, "
                    "из которых 5% — брак. Сколько исправных единиц товара в "
                    "филиале Б? В последней строке напиши только целое число.",
            "expected": "14022", "check": "contains",
            "how": "арифметика сверена независимым расчётом",
        },
        {
            "id": "t4_calendar", "complexity": 3, "label": "календарная арифметика",
            "text": "Какая дата будет через 100 дней после 9 октября 2026 года? "
                    "Назови дату и день недели. В последней строке — только дату в "
                    "формате ГГГГ-ММ-ДД и день недели через запятую.",
            "expected": "2027-01-17, воскресенье", "check": "contains",
            "how": "сверено с календарём: 2026-10-09 — пятница",
        },
        {
            "id": "t5_code_js", "complexity": 4,
            "label": "функция на JS с проверкой запуском",
            "text": "Напиши на JavaScript функцию `compress(input)`, которая "
                    "выполняет run-length encoding строки: подряд идущие "
                    "одинаковые символы заменяются на символ и число повторов, "
                    "но одиночный символ остаётся без числа. "
                    'Примеры: compress("aaabccddd") === "a3bc2d3"; '
                    'compress("abc") === "abc"; compress("") === "". '
                    "Выдай только код функции, объявленной как "
                    "`function compress(input) { ... }`, без пояснений, без "
                    "markdown-разметки, без примеров использования.",
            "expected": None, "check": "js",
            "how": "запуск в Node против восьми наборов, включая краевые",
        },
        {
            "id": "t6_summarize", "complexity": 5,
            "label": "выжимка длинного документа",
            "text": "Ниже — документ об архитектуре проекта. Сделай выжимку: "
                    "ровно 5 пунктов списка, каждый не длиннее двух строк, только "
                    "о том, что реально сказано в документе. Не добавляй ничего, "
                    "чего в тексте нет.\n\n---\n\n" + document,
            "expected": None, "check": None,
            "how": "сверка каждого пункта с документом — судья",
            # Длинный вход в файл результата не идёт целиком: страница
            # показывала бы 60 КБ чужого документа вместо замера.
            "text_shown": "Ниже — документ об архитектуре проекта. Сделай выжимку: "
                          "ровно 5 пунктов списка… [документ целиком: "
                          f"agent_docs/architecture.md, {len(document)} знаков]",
        },
        {
            "id": "t7_json", "complexity": 4, "label": "JSON по схеме",
            "text": "Придумай три вымышленных новости о стартапах в сфере "
                    "fintech и верни их строго по заданной JSON-схеме. "
                    "Год — целое число. Ответ — только JSON.",
            "expected": None, "check": "schema", "format": JSON_SCHEMA,
            "how": "разбор и проверка по схеме программой",
        },
        {
            "id": "t8_ru_question", "complexity": 3,
            "label": "предметный вопрос по-русски",
            "text": "Чем отличается HTTP-код 429 от 503? Ответь двумя короткими "
                    "абзацами: когда уместен каждый и что должен сделать клиент.",
            "expected": None, "check": None,
            "how": "сверка по смыслу — судья",
        },
    ]


def check_answer(task: dict, answer: str, run=None) -> dict | None:
    """Механическая проверка по виду задачи. Нет вида — нет проверки."""
    kind = task.get("check")
    if kind == "contains":
        return checks.contains(answer, task["expected"])
    if kind == "schema":
        return checks.by_schema(answer, task["format"])
    if kind == "js":
        return checks.by_running_js(answer) if run is None else checks.by_running_js(answer, run)
    return None


def by_complexity(rows: list[dict]) -> list[dict]:
    """Сводка по ступеням сложности — вторая таблица страницы.

    Отвечает на вопрос, которого построчная таблица не отвечает: растёт ли
    задержка со сложностью. Медиана, а не среднее: один холодный запуск с
    загрузкой весов сдвинул бы среднее.
    """
    out = []
    for level in sorted({row["complexity"] for row in rows}):
        same = [row for row in rows if row["complexity"] == level]
        out.append({
            "complexity": level,
            "count": len(same),
            "ttft_s_median": features.median_or_none([row["ttft_s"] for row in same]),
            "tps_median": features.median_or_none([row["tps"] for row in same]),
        })
    return out


def run(model: str, runner: str, commit: str, document: str,
        generate=client.generate, js_run=None, limit: int = 0) -> dict:
    chosen = tasks(document)
    if limit > 0:
        chosen = chosen[:limit]
    rows = []
    for at, task in enumerate(chosen):
        print(f"[{at + 1}/{len(chosen)}] {task['id']} — {task['label']}", flush=True)
        got = generate(model, task["text"], options=OPTIONS, think=False,
                       fmt=task.get("format"))
        answer = client.strip_think(got["response"])
        check = None if got["error"] else check_answer(task, answer, js_run)
        metrics = got["metrics"]
        rows.append({
            "id": task["id"],
            "label": task["label"],
            "text": task.get("text_shown", task["text"]),
            "complexity": task["complexity"],
            "verdict": checks.verdict_of(check),
            "reason": task["how"],
            "check": check,
            "answer": answer,
            "expected": task["expected"],
            "failed": got["error"] is not None,
            "error": got["error"],
            "done_reason": got["done_reason"],
            "ttft_s": report.seconds(metrics["ttft_ms"]),
            # Время до первого токена ВИДИМОГО ответа — отдельно от времени до
            # первого токена любого вида: при включённом рассуждении они
            # расходятся в разы, и страница дня 26 показывает оба.
            "ttft_answer_s": report.seconds(metrics["ttft_answer_ms"]),
            "tps": metrics["gen_tokens_per_s"],
            "time_s": report.seconds(metrics["wall_ms"]),
            "prompt_eval_count": metrics["prompt_eval_count"],
            "eval_count": metrics["eval_count"],
            # Три длительности движка ПОРОЗНЬ, а не только их сумма. Без них
            # нельзя отделить холодный запуск от обработки длинного входа: у
            # первого запроса после выгрузки `load_duration` — секунды, и
            # время до первого токена у него объясняется чтением весов, а не
            # моделью. Раскрывающееся пояснение страницы «откуда берутся ток/с
            # и время до первого токена» (спецификация раскладки, «День 26»,
            # п. 5) опирается ровно на это разделение, а скорость обработки
            # входа выводится из `prompt_eval_*`, а не из настенного времени.
            "load_duration_ms": metrics["load_duration_ms"],
            "prompt_eval_duration_ms": metrics["prompt_eval_duration_ms"],
            "eval_duration_ms": metrics["eval_duration_ms"],
            "prompt_tokens_per_s": metrics["prompt_tokens_per_s"],
        })
        print(f"    {rows[-1]['ttft_s']} с до токена, {rows[-1]['tps']} ток/с, "
              f"вердикт {rows[-1]['verdict']}", flush=True)

    return {
        **report.envelope(26, model, runner, commit, notes=[
            "Один прогон на запрос при temperature 0 и фиксированном seed: "
            "повторяемость даёт seed, а не повторы.",
            "Машина была в обычной работе владельца, а не изолированным стендом: "
            "числа воспроизводимы, но потолком железа не являются.",
            "Вердикт «частично» ставит только судья: механическая проверка "
            "различает прошло и не прошло.",
        ]),
        "judge": {"name": None, "rubric": features.RUBRIC},
        "options": OPTIONS,
        "queries": rows,
        "by_complexity": by_complexity(rows),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="День 26: запросы разной сложности")
    parser.add_argument("--model", default=client.Q4)
    parser.add_argument("--out", default=str(prompts.ROOT / "site" / "day26" / "results.json"))
    parser.add_argument("--commit", default="unknown",
                        help="коммит дерева, по которому мерено (его читает подвал страницы)")
    parser.add_argument("--limit", type=int, default=0,
                        help="взять только первые N запросов (короткая проверка обвязки)")
    args = parser.parse_args(argv)

    document = LONG_DOC.read_text(encoding="utf-8")
    client.unload(args.model)
    started = time.monotonic()
    import day28_local_rag as day28  # версия рунера читается одним местом

    with client.RssPeak() as peak:
        payload = run(args.model, day28.runner_version(), args.commit, document,
                      limit=args.limit)
    payload["memory"] = {**peak.report(), "ps": client.ps()}
    payload["wall_s"] = round(time.monotonic() - started, 1)
    out = report.write_results(Path(args.out), payload)
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
