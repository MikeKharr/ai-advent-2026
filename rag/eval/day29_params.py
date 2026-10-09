"""День 29 — параметры движка на общих запросах: перенос прогона 2026-10-09.

Перенос из `…-measurements/scripts/day29_params.py` (ADR 2026-10-09-1335,
п. 1.4). Четыре блока: `num_ctx`, `temperature`, `num_predict`, `think`.

Чем отличается от `day29_tuning.py` и зачем нужен отдельно. Этот файл мерит
ПАРАМЕТРЫ ДВИЖКА на коротких общих запросах: сколько памяти стоит окно
контекста, что именно ограничивает `num_predict`, от чего зависит
повторяемость. `day29_tuning.py` мерит ТУ ЖЕ ЗАДАЧУ ДНЯ 28 по осям и выбирает
«после». Первый объясняет, почему оси выбраны такие; второй отвечает на
задание дня. Числа этого файла на страницу идут через раскрывающиеся
пояснения, а не в главную таблицу.

Перед каждым замером `num_ctx` модель выгружается: окно задаётся только при
загрузке, и без выгрузки Ollama подняла бы второй экземпляр, смешав замер с
предыдущим.

Запуск (один блок или все):

    EVAL_OLLAMA_URL=http://127.0.0.1:11435 python3 -I eval/day29_params.py \\
      --blocks ctx,temp,predict,think --out /tmp/day29-params.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ollama_client as client  # noqa: E402

BENCH_PROMPT = ("Опиши назначение ограничения частоты запросов в публичном "
                "веб-приложении. Пиши связным текстом, без списков.")
STABILITY_PROMPT = ("Одним предложением объясни, зачем публичному API нужен "
                    "лимит запросов.")
LONG_PROMPT = ("Подробно опиши, как устроен обратный прокси и зачем он нужен. "
               "Пиши связным текстом.")


def block_num_ctx(model: str, generate=client.generate, unload=client.unload) -> list[dict]:
    """A. Окно контекста: память, время загрузки, скорость.

    Три значения, а не два: с двумя точками любая разница выглядит
    закономерностью. `num_predict` фиксирован, чтобы ток/с сравнивались на
    равном числе выходных токенов.
    """
    rows = []
    for window in (2048, 8192, 32768):
        unload(model)
        options = {"num_ctx": window, "temperature": 0, "seed": 7, "num_predict": 256}
        with client.RssPeak() as peak:
            run = generate(model, BENCH_PROMPT, options=options, think=False)
            loaded = client.ps()
        rows.append({
            "num_ctx": window,
            "options": options,
            "metrics": run["metrics"],
            "error": run["error"],
            "ps": loaded,
            "memory": peak.report(),
        })
        print(f"  num_ctx={window}: загрузка {run['metrics']['load_duration_ms']} мс, "
              f"{run['metrics']['gen_tokens_per_s']} ток/с", flush=True)
    return rows


def block_temperature(model: str, generate=client.generate) -> list[dict]:
    """B. Повторяемость: её даёт `seed`, а не нулевая температура.

    Третий случай — ровно про это: `temperature` 0,7 с одним и тем же `seed`
    повторяется токен в токен. Без него вывод «температура делает ответ
    случайным» выглядел бы доказанным, а он неверен.
    """
    cases = [
        {"label": "temperature=0, без seed", "options": {"temperature": 0, "num_ctx": 8192}},
        {"label": "temperature=0.7, без seed", "options": {"temperature": 0.7, "num_ctx": 8192}},
        {"label": "temperature=0.7, seed=123 один и тот же",
         "options": {"temperature": 0.7, "num_ctx": 8192, "seed": 123}},
    ]
    out = []
    for case in cases:
        runs = [generate(model, STABILITY_PROMPT, options=case["options"], think=False)
                for _ in range(3)]
        texts = [client.strip_think(run["response"]).strip() for run in runs]
        out.append({
            "label": case["label"],
            "options": case["options"],
            "responses": texts,
            "all_identical": len(set(texts)) == 1,
            "distinct_count": len(set(texts)),
            "metrics": [run["metrics"] for run in runs],
        })
        print(f"  {case['label']}: различных {out[-1]['distinct_count']}", flush=True)
    return out


def block_num_predict(model: str, generate=client.generate) -> list[dict]:
    """C. `num_predict` — потолок выхода, не скорость.

    Причина останова (`done_reason`) здесь важнее времени: `length` против
    `stop` отвечает на вопрос, уперлась ли модель в потолок или кончила сама.
    """
    out = []
    for ceiling in (64, 256, 1024):
        options = {"num_ctx": 8192, "temperature": 0, "seed": 7, "num_predict": ceiling}
        run = generate(model, LONG_PROMPT, options=options, think=False)
        out.append({"num_predict": ceiling, "options": options,
                    "metrics": run["metrics"], "done_reason": run["done_reason"],
                    "error": run["error"]})
        print(f"  num_predict={ceiling}: {run['metrics']['eval_count']} токенов, "
              f"останов {run['done_reason']}", flush=True)
    return out


THINK_TASKS = [
    {"id": "t3_arithmetic", "expected": "14022",
     "text": "Склад получил 1250 ящиков. 18% из них повреждены и списаны. "
             "Из оставшихся ящиков 2/5 отправлены в филиал А, остальные — в "
             "филиал Б. Каждый ящик в филиале Б содержит 24 единицы товара, "
             "из которых 5% — брак. Сколько исправных единиц товара в "
             "филиале Б? В последней строке напиши только целое число."},
    {"id": "t4_calendar", "expected": "2027-01-17, воскресенье",
     "text": "Какая дата будет через 100 дней после 9 октября 2026 года? "
             "Назови дату и день недели. В последней строке — только дату в "
             "формате ГГГГ-ММ-ДД и день недели через запятую."},
    {"id": "t1_fact", "expected": "1889",
     "text": "In what year was the Eiffel Tower completed? "
             "Answer in one short sentence, nothing else."},
]


def block_think(model: str, generate=client.generate) -> list[dict]:
    """D. Цена рассуждения: время против верности, на тех же трёх задачах.

    Токены рассуждения движок отдельно не считает, поэтому его объём меряется
    знаками относительно видимого ответа — это оценка, а не счёт токенов, и
    так она и названа в файле.
    """
    out = []
    for task in THINK_TASKS:
        for think in (False, True):
            options = {"num_ctx": 16384, "temperature": 0, "seed": 42}
            run = generate(model, task["text"], options=options, think=think)
            answer = client.strip_think(run["response"])
            out.append({
                "task_id": task["id"],
                "think": think,
                "expected": task["expected"],
                "expected_in_answer": " ".join(task["expected"].split()).lower()
                                      in " ".join(answer.split()).lower(),
                "answer": answer,
                "thinking_chars": run["metrics"]["thinking_chars"],
                "metrics": run["metrics"],
                "error": run["error"],
            })
            print(f"  {task['id']} think={think}: рассуждение "
                  f"{run['metrics']['thinking_chars']} знаков, эталон в ответе "
                  f"{out[-1]['expected_in_answer']}", flush=True)
    return out


BLOCKS = {"ctx": block_num_ctx, "temp": block_temperature,
          "predict": block_num_predict, "think": block_think}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="День 29: параметры движка")
    parser.add_argument("--model", default=client.Q4)
    parser.add_argument("--blocks", default="ctx,temp,predict,think")
    parser.add_argument("--out", required=True,
                        help="куда положить JSON прогона (это не файл страницы)")
    args = parser.parse_args(argv)

    chosen = [name for name in args.blocks.split(",") if name.strip()]
    unknown = [name for name in chosen if name not in BLOCKS]
    if unknown:
        parser.error(f"неизвестные блоки: {', '.join(unknown)}; есть {', '.join(BLOCKS)}")

    out = {
        "day": 29,
        "section": "параметры движка",
        "model": args.model,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "prompts": {"bench": BENCH_PROMPT, "stability": STABILITY_PROMPT,
                    "long": LONG_PROMPT},
    }
    for name in chosen:
        print(f"блок {name}", flush=True)
        out[name] = BLOCKS[name](args.model)
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"-> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
