"""День 29 — оптимизация задачи дня 28: одна ось за раз, затем «после».

База — конфигурация дня 28 (`day28_local_rag.BASE_OPTIONS` и системный промпт
реестра). «До» — её 10 ответов. Каждая ось меняет РОВНО ОДНО и прогоняется по
тем же 10 вопросам один раз (решение владельца Р5).

Оси (ADR 2026-10-09-1335, п. 4.3): `temperature`, `num_predict`, `num_ctx`,
`think`, промпт-шаблон и квантование. Ось квантования — установленная
`qwen3.8:27b` Q4_K_M против установленной сборки без отказов Q6_K, без
скачиваний, и от неё в файл идут ТОЛЬКО ЧИСЛА: тексты её ответов не попадают
ни в `results.json`, ни на страницу (вето ADR 2026-10-07-1349). Держит это не
обещание, а страж `report.check_no_abliterated_texts`.

Оговорка, которая обязана стоять на странице рядом с числами этой оси: сборка
без отказов дообучена снятием отказов, и разница между ней и Q4_K_M — не
только сжатие. Разница скорости и памяти переносится на квантование честно,
разница верности — нет.

«После» выбирается ПРАВИЛОМ (`choose_after`), а не вкусом: ось входит в
сочетание, если её признаки не упали, а медиана времени не выросла. Правило
записано кодом и под тестом, чтобы «после» нельзя было подобрать под желаемый
вывод.

Запуск:

    OLLAMA_URL=http://127.0.0.1:11435 EVAL_OLLAMA_URL=http://127.0.0.1:11435 \\
      RAG_INDEX=<каталог> python3 -B eval/day29_tuning.py --index index \\
      --out ~/Projects/ai-advent-2026-measurements/runs/day29-results.json

`-B` и чистка `__pycache__` обязательны, `-I` — нет: он включает
изолированный режим, каталог скрипта в `sys.path` не попадает, и прогон
падает с `ModuleNotFoundError`. Байт-код отключает `-B`.

Прогон пишет СЫРОЙ вывод в каталог замеров. Файл страницы по
спецификации раскладки делает отдельный шаг:
`python3 -B eval/to_page.py --day 29 --in <сырой> --out ../site/day29/results.json`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import day28_local_rag as day28  # noqa: E402
import features  # noqa: E402
import ollama_client as client  # noqa: E402
import prompt as prompts  # noqa: E402
import report  # noqa: E402
from build import INDEX_DIR, MODEL, OLLAMA_URL  # noqa: E402
from embed import OllamaEmbedder  # noqa: E402
from index import VectorIndex  # noqa: E402

# Компактный промпт-шаблон оси «промпт» (ADR, п. 4.3): фрагменты первыми,
# вопрос последним, ТРИ правила вместо семи, пример формата ссылки. Хранится
# строкой с тестом на дословность (`ШаблонПромптаДословно`): шаблон — предмет
# замера, и молчаливая правка его слов обесценила бы ось.
COMPACT_SYSTEM = (
    "Отвечай на вопрос о проекте ai-advent-2026 только по данным фрагментам корпуса. "
    "На каждое утверждение ставь номер фрагмента и путь файла, например «[2] agent_docs/guides/dod.md». "
    "Если ответа во фрагментах нет — ответь ровно фразой «В найденных фрагментах ответа нет»."
)


def axes(base_options: dict) -> list[dict]:
    """Шесть осей: каждая — ровно одно отличие от базы.

    `options` оси накладывается НА базу, а не заменяет её: иначе ось
    `temperature` молча потеряла бы `num_predict` и мерила бы две правки.
    """
    return [
        {"id": "temperature", "group": "параметры",
         "label": "temperature 1 → 0,2", "options": {"temperature": 0.2}},
        {"id": "num_predict", "group": "параметры",
         "label": "num_predict 800 → 400", "options": {"num_predict": 400}},
        {"id": "num_ctx", "group": "параметры",
         "label": f"num_ctx {base_options['num_ctx']} → 8192", "options": {"num_ctx": 8192}},
        {"id": "think", "group": "параметры",
         "label": "think false → true", "think": True},
        {"id": "prompt", "group": "промпт",
         "label": "промпт реестра → компактный", "system": COMPACT_SYSTEM},
        # Единственная ось, от которой публикуются только числа, и
        # единственная, у которой отличий от базы ДВА, а не одно. Второе
        # отличие вынужденное и названо полем `forced`: у сборки без отказов
        # нет объявленной способности `thinking`, и просить её — получить
        # отказ движка вместо ответа. Поле читает тест
        # `test_каждая_ось_отличается_от_базы_ровно_одним`: без него вторая
        # правка в любой оси проходила бы молча.
        {"id": "quant", "group": "квантизация",
         "label": "квантование Q4_K_M → Q6_K (сборка без отказов)",
         "model": client.Q6, "numbers_only": True, "think": None,
         "forced": "think не просим: у сборки Q6_K нет объявленной способности thinking"},
    ]


def axis_summary(rows: list[dict]) -> dict:
    """Сводка оси по признакам и времени — то, на чём работает `choose_after`.

    `retrieved` здесь НЕ СЧИТАЕТСЯ: поиск у всех осей один и тот же индекс и
    тот же `k`, и признак не зависит от генерации. Включить его — значит
    сравнивать оси по числу, которое у них равно по построению.
    """
    return {
        "answers": len(rows),
        "cited": sum(1 for row in rows if row.get("cited") is True),
        "key": sum(1 for row in rows if row.get("key") is True),
        "refused": sum(1 for row in rows if row.get("refused") is True),
        "failed": sum(1 for row in rows if row.get("failed")),
        "time_s_median": features.median_or_none([row.get("time_s") for row in rows]),
        "ttft_s_median": features.median_or_none([row.get("ttft_s") for row in rows]),
        "tps_median": features.median_or_none([row.get("tps") for row in rows]),
    }


def axis_qualifies(base: dict, axis: dict) -> bool:
    """Ось годится для «после», если признаки не упали, а время не выросло.

    Три условия, и все три обязательны: названных путей не меньше, ключевых
    фраз не меньше, отказов не больше. Четвёртое — медиана времени не выше
    базовой. Нет времени ни у базы, ни у оси — ось не годится: «быстрее»
    нельзя утверждать, не измерив.
    """
    if axis.get("failed"):
        return False
    if axis["cited"] < base["cited"] or axis["key"] < base["key"]:
        return False
    if axis["refused"] > base["refused"]:
        return False
    if base["time_s_median"] is None or axis["time_s_median"] is None:
        return False
    return axis["time_s_median"] <= base["time_s_median"]


def choose_after(base: dict, summaries: dict[str, dict], all_axes: list[dict]) -> dict:
    """Сочетание осей для «после» — и причина по каждой оси словами.

    Ось квантования в сочетание НЕ ВХОДИТ ни при каких числах: «после» — это
    конфигурация той модели, что стоит в проде (ADR, п. 4.5). Это не
    настройка: условие стоит до проверки чисел.
    """
    taken = []
    why = []
    for axis in all_axes:
        summary = summaries.get(axis["id"])
        if summary is None:
            why.append({"axis": axis["id"], "taken": False, "why": "ось не прогонялась"})
            continue
        if axis.get("numbers_only"):
            why.append({"axis": axis["id"], "taken": False,
                        "why": "ось квантования в «после» не входит: «после» — та же "
                               "модель, что в проде"})
            continue
        if axis_qualifies(base, summary):
            taken.append(axis["id"])
            why.append({"axis": axis["id"], "taken": True,
                        "why": "признаки не упали, медиана времени не выросла"})
        else:
            why.append({"axis": axis["id"], "taken": False,
                        "why": "признаки упали либо время выросло"})
    return {"axes": taken, "reasons": why}


def combined(base_options: dict, base_system: str, taken: list[str],
             all_axes: list[dict]) -> tuple[dict, bool, str]:
    """Параметры, `think` и системный промпт сочетания «после»."""
    options = dict(base_options)
    think = False
    system = base_system
    for axis in all_axes:
        if axis["id"] not in taken:
            continue
        options.update(axis.get("options") or {})
        if "think" in axis:
            think = axis["think"]
        if axis.get("system"):
            system = axis["system"]
    return options, think, system


def run_variant(questions, hits_by_id, model, system, options, think, generate,
                numbers_only=False) -> list[dict]:
    """Один вариант (база, ось или «после») по всем вопросам, по одному ответу.

    `numbers_only` срезает текст ответа и текст ошибки ещё здесь, а не при
    записи файла: до стража `report` текст не доезжает вовсе, и утечь ему
    негде даже в промежуточном выводе на терминал.
    """
    rows = []
    for question in questions:
        hits = hits_by_id[question["id"]]
        got = day28.answer_once(question, hits, model, system, options, generate)
        if numbers_only:
            # Длина ответа — число, и она остаётся; сам текст и текст ошибки
            # срезаются ЗДЕСЬ, до записи файла и до вывода на терминал.
            # `model` ставится на каждую запись намеренно: страж записи ищет
            # метку сборки, и запись без метки он бы не проверил.
            got = {"model": model, "answer_chars": len(got["answer"]),
                   **{key: value for key, value in got.items()
                      if key not in ("answer", "error")}}
        print(f"  {question['id']}: {got.get('time_s')} с, {got.get('tps')} ток/с",
              flush=True)
        rows.append({"id": question["id"], **got})
    return rows


def probe_default_context(model: str, generate=client.generate, ps=client.ps) -> dict:
    """Окно контекста Ollama по умолчанию — первый замер дня 29 (ADR, п. 4.2).

    Зачем отдельно от осей. `/api/show` у `qwen3.8:27b` окна не задаёт, а
    умолчание Ollama 0.33.3 неизвестно. Если оно ниже промпта дня 28 (пять
    фрагментов по 2000 знаков по-русски, порядка 4–6 тысяч токенов), Ollama
    МОЛЧА ОБРЕЗАЕТ ВХОД — и то же самое происходит сегодня в проде через
    `mac-qwen3`, потому что адаптер роутера `num_ctx` не передаёт.

    Поэтому вызов идёт БЕЗ `num_ctx` вовсе, а окно читается из `/api/ps`
    загруженной модели. Подтвердится обрезка — это находка, и правка адаптера
    отдельный класс A, не этой недели.
    """
    client.unload(model)
    run = generate(model, "Ответь одним словом: да.", options={}, think=False)
    loaded = ps()
    window = None
    for item in loaded.get("models", []):
        if item.get("name") == model:
            window = item.get("context_length")
    return {
        "context_length_default": window,
        "prompt_eval_count": run["metrics"]["prompt_eval_count"],
        "error": run["error"],
        "note": "окно читается из /api/ps после вызова без num_ctx: в /api/show его нет",
    }


def run(index_dir: Path, embedder: OllamaEmbedder, model: str, runner: str,
        questions: list[dict] | None = None, generate=client.generate,
        probe: dict | None = None) -> dict:
    questions = questions if questions is not None else prompts.load_questions()
    base_system = prompts.registry_system_prompt()
    base_options = dict(day28.BASE_OPTIONS)
    index = VectorIndex.load(index_dir, day28.STRATEGY, embedder.model)
    if index is None:
        raise SystemExit(f"индекса {day28.STRATEGY} нет в {index_dir}: сначала rag/build.py")
    commit = next((meta.get("commit", "") for meta in index.meta if meta.get("commit")), "")

    # Поиск один раз на вопрос: оси меняют генерацию, а не индекс и не `k`.
    # Повторный поиск дал бы те же фрагменты и добавил бы к каждой оси время
    # эмбеддинга, которого в сравнении быть не должно.
    vectors = embedder.embed([question["question"] for question in questions])
    hits_by_id = {
        question["id"]: day28.search_hits(index, vector)
        for question, vector in zip(questions, vectors)
    }

    all_axes = axes(base_options)
    print("база", flush=True)
    base_rows = run_variant(questions, hits_by_id, model, base_system, base_options,
                            False, generate)
    summaries = {}
    variants = []
    for axis in all_axes:
        print(f"ось {axis['id']}", flush=True)
        axis_model = axis.get("model", model)
        if axis_model != model:
            # Две модели по 17 и 22 ГБ рядом делят GPU: вторая мерила бы
            # тесноту, а не себя.
            client.unload(model)
        options = {**base_options, **(axis.get("options") or {})}
        rows = run_variant(questions, hits_by_id, axis_model,
                           axis.get("system") or base_system, options,
                           axis["think"] if "think" in axis else False,
                           generate, numbers_only=bool(axis.get("numbers_only")))
        if axis_model != model:
            client.unload(axis_model)
        summaries[axis["id"]] = axis_summary(rows)
        variants.append({
            "id": axis["id"],
            "group": axis["group"],
            "label": axis["label"],
            "model": axis_model,
            "options": options,
            "numbers_only": bool(axis.get("numbers_only")),
            "summary": summaries[axis["id"]],
            "answers": rows,
        })

    base_summary = axis_summary(base_rows)
    choice = choose_after(base_summary, summaries, all_axes)
    after_options, after_think, after_system = combined(base_options, base_system,
                                                        choice["axes"], all_axes)
    print("после", flush=True)
    after_rows = run_variant(questions, hits_by_id, model, after_system, after_options,
                             after_think, generate)
    after_summary = axis_summary(after_rows)

    # `changed` — сколько ГРУПП менялось в «после». Из него страница печатает
    # оговорку о том, чему принадлежит выигрыш, и считает её сама.
    changed = sorted({axis["group"] for axis in all_axes if axis["id"] in choice["axes"]})

    payload = {
        **report.envelope(29, model, runner, commit[:7] or "unknown", notes=[
            "Один прогон на ось, один повтор на вопрос (решение владельца Р5): "
            "разница в один-два вопроса между осями может быть шумом.",
            "Ось квантования сравнивает не только сжатие: сборка Q6_K дообучена "
            "снятием отказов. Скорость и память переносятся на квантование честно, "
            "верность — нет.",
            "Тексты ответов сборки без отказов не публикуются: от этой оси в файле "
            "только числа.",
            "Замер на ноутбуке — не замер прода: прод ходит в другой процесс той же "
            "машины через частную сеть.",
            report.RSS_NOTE,
        ]),
        "judge": {"name": None, "rubric": features.RUBRIC},
        "index": {"strategy": day28.STRATEGY, "commit": commit, "embedder": embedder.model},
        "default_context_probe": probe,
        "changed": changed,
        "params": [
            {"name": "temperature", "before": base_options["temperature"],
             "after": after_options["temperature"]},
            {"name": "num_predict", "before": base_options["num_predict"],
             "after": after_options["num_predict"]},
            {"name": "num_ctx", "before": base_options["num_ctx"],
             "after": after_options["num_ctx"]},
            {"name": "think", "before": False, "after": after_think},
            {"name": "квантизация", "before": "Q4_K_M", "after": "Q4_K_M"},
            {"name": "промпт", "before": "реестровый",
             "after": "компактный" if after_system != base_system else "реестровый"},
        ],
        "metrics": [
            {"name": "путь источника назван", "unit": f"из {len(questions)}",
             "before": base_summary["cited"], "after": after_summary["cited"]},
            {"name": "ключевая фраза в ответе", "unit": f"из {len(questions)}",
             "before": base_summary["key"], "after": after_summary["key"]},
            {"name": "отказов", "unit": f"из {len(questions)}",
             "before": base_summary["refused"], "after": after_summary["refused"]},
            {"name": "до 1-го токена", "unit": "с (медиана)",
             "before": base_summary["ttft_s_median"], "after": after_summary["ttft_s_median"]},
            {"name": "скорость генерации", "unit": "ток/с (медиана)",
             "before": base_summary["tps_median"], "after": after_summary["tps_median"]},
            {"name": "время ответа", "unit": "с (медиана)",
             "before": base_summary["time_s_median"], "after": after_summary["time_s_median"]},
        ],
        "prompts": {"before": base_system, "after": after_system},
        "base": {"options": base_options, "summary": base_summary, "answers": base_rows},
        "after": {"options": after_options, "think": after_think,
                  "summary": after_summary, "answers": after_rows,
                  "chosen": choice},
        "variants": variants,
    }
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="День 29: оси оптимизации и «после»")
    parser.add_argument("--index", default=str(INDEX_DIR))
    parser.add_argument("--model", default=client.Q4)
    parser.add_argument("--out", default=str(prompts.ROOT / "site" / "day29" / "results.json"))
    parser.add_argument("--limit", type=int, default=0,
                        help="взять только первые N вопросов (короткая проверка обвязки)")
    parser.add_argument("--skip-probe", action="store_true",
                        help="не мерить окно контекста по умолчанию (он выгружает модель)")
    args = parser.parse_args(argv)

    questions = prompts.load_questions()
    if args.limit > 0:
        questions = questions[: args.limit]

    probe = None if args.skip_probe else probe_default_context(args.model)
    started = time.monotonic()
    with client.RssPeak() as peak:
        payload = run(Path(args.index), OllamaEmbedder(OLLAMA_URL, MODEL), args.model,
                      day28.runner_version(), questions=questions, probe=probe)
    payload["memory"] = {**peak.report(), "ps": client.ps()}
    payload["wall_s"] = round(time.monotonic() - started, 1)
    out = report.write_results(Path(args.out), payload)
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
