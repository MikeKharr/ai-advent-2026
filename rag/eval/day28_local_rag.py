"""День 28 — RAG полностью локально: поиск и генерация на ноутбуке.

Что делает прогон (ADR 2026-10-09-1335, п. 3): читает локальную копию индекса
FAISS, ищет пять фрагментов по каждому из 10 контрольных вопросов дня 22,
собирает промпт тем же рендером, что агент дня 22, и один раз спрашивает
локальную модель. Три вопроса — `q08`, `q72`, `m01`, по одному из частей
`first`, `missed` и `general` — прогоняются ещё дважды: один повтор на вопрос
(решение владельца Р5), а разброс виден на этих трёх.

Чего прогон НЕ делает: не ставит вердиктов. Признаки — четыре, те же, что у
дня 22; вердикт 0/1/2 по рубрике ставит отдельный экземпляр роли `reviewer`
после прогона и вписывает своё имя в `judge.name`.

Облачная сторона сюда не вызывается и стоить ничего не может: она приходит
готовым файлом дня 22 через `--cloud`. Второго способа позвать облачную
модель этот прогон не заводит.

Запуск (окно контекста задано явно — см. шапку `ollama_client`):

    OLLAMA_URL=http://127.0.0.1:11435 EVAL_OLLAMA_URL=http://127.0.0.1:11435 \\
      RAG_INDEX=<каталог локального индекса> python3 -I eval/day28_local_rag.py \\
      --out ../site/day28/results.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import features  # noqa: E402
import ollama_client as client  # noqa: E402
import prompt as prompts  # noqa: E402
import report  # noqa: E402
from build import INDEX_DIR, MODEL, OLLAMA_URL  # noqa: E402
from embed import OllamaEmbedder  # noqa: E402
from index import VectorIndex  # noqa: E402

# Три вопроса стабильности — по одному из каждой части набора (ADR, п. 3.3).
# Прибиты именами, а не выбираются из набора правилом: правило («первый из
# части») молча сменило бы вопросы при правке набора, и разброс считался бы
# по другим трём.
STABILITY_IDS = ("q08", "q72", "m01")

# Сколько РАЗ ВСЕГО отвечает модель на вопрос стабильности: один общий прогон
# плюс два повтора.
STABILITY_RUNS = 3

# Параметры базы дня 28 — запись `rag-agent` реестра (`defaults.maxTokens` 800,
# `temperature` 1). `num_ctx` задан явно и с запасом на пять фрагментов по
# 2000 знаков по-русски: умолчание Ollama неизвестно, и при его превышении
# вход обрезается молча (ADR, п. 4.2).
BASE_OPTIONS = {"num_predict": 800, "temperature": 1, "num_ctx": 16384}

STRATEGY = "structural"


def search_hits(index: VectorIndex, vector) -> list[dict]:
    """Выдача поиска в той же форме, в какой её отдаёт служба дня 22.

    Текст режется до `MAX_TEXT` — так же, как режет служба (`rag/tools.py`).
    Локальный прогон читает индекс напрямую, мимо службы, и без этой строки
    отдал бы модели более длинный текст, чем видит прод: сравнение мерило бы
    разную длину контекста.
    """
    out = []
    for at, (score, meta) in enumerate(index.search(vector, prompts.SEARCH_LIMIT)):
        out.append({
            "n": at + 1,
            "source": meta["source"],
            "section": meta.get("section", ""),
            "score": round(float(score), 4),
            "text": prompts.clip(meta["text"]),
        })
    return out


def answer_once(question: dict, hits: list[dict], model: str, system: str,
                options: dict, generate=client.generate) -> dict:
    """Один ответ локальной модели на один вопрос — запись для файла.

    Рассуждение, вытекшее в видимый ответ, отрезается ДО счёта признаков
    (`strip_think`): у сборки без отказов шаблон дописывает `<think>` сам, и
    признаки, посчитанные вместе с рассуждением, мерили бы рассуждение.
    """
    text = prompts.build_rag_input(question["question"], hits)
    run = generate(model, text, options=options, think=False, system=system)
    answer = client.strip_think(run["response"])
    metrics = run["metrics"]
    return {
        "answer": answer,
        "failed": run["error"] is not None,
        "error": run["error"],
        "done_reason": run["done_reason"],
        "time_s": report.seconds(metrics["wall_ms"]),
        "ttft_s": report.seconds(metrics["ttft_ms"]),
        "tps": metrics["gen_tokens_per_s"],
        "prompt_eval_count": metrics["prompt_eval_count"],
        "eval_count": metrics["eval_count"],
        # Вердикт ставит судья; слово качества страница берёт из него.
        "quality": None,
        **features.features_for(question, answer, [hit["source"] for hit in hits]),
    }


def cloud_side(questions: list[dict], cloud: dict | None,
               times: dict | None) -> dict[str, dict]:
    """Облачная сторона из готового файла прогона дня 22, режим `rag`.

    Время запуска в этом файле ОТСУТСТВУЕТ: прогон дня 22 его не записывает, а
    сданный день не правится. Поэтому `time_s` берётся из отдельного файла
    `--cloud-times` (его пишет тот, кто мерил прогон снаружи), а без него
    остаётся `None` — и страница печатает «нет данных», а не выдуманный ноль.
    """
    out: dict[str, dict] = {}
    by_id = {}
    if cloud:
        by_id = {item["id"]: item for item in cloud.get("questions", [])}
    for question in questions:
        got = by_id.get(question["id"], {}).get("modes", {}).get("rag")
        if got is None:
            out[question["id"]] = {"quality": None, "time_s": None, "failed": None}
            continue
        out[question["id"]] = {
            "quality": features.quality_word(got.get("verdict")),
            "verdict": got.get("verdict"),
            "time_s": (times or {}).get(question["id"]),
            "failed": False,
            "retrieved": got.get("retrieved"),
            "cited": got.get("cited"),
            "key": got.get("key"),
            "refused": got.get("refused"),
        }
    return out


def run(index_dir: Path, embedder: OllamaEmbedder, model: str, runner: str,
        questions: list[dict] | None = None, cloud: dict | None = None,
        times: dict | None = None, generate=client.generate,
        options: dict | None = None, rss=None) -> dict:
    """Весь прогон одной стороной: 10 вопросов плюс два повтора у трёх.

    Отказ поиска или модели не обрывает набор: он ложится записью со словами
    отказа (`incidents`), и остальные вопросы продолжают идти. Недоступность
    ноутбука — результат замера, а не дефект прогона (ADR, п. 3.5).
    """
    questions = questions if questions is not None else prompts.load_questions()
    options = options or dict(BASE_OPTIONS)
    system = prompts.registry_system_prompt()
    index = VectorIndex.load(index_dir, STRATEGY, embedder.model)
    if index is None:
        raise SystemExit(f"индекса {STRATEGY} нет в {index_dir}: сначала rag/build.py")

    commit = next((meta.get("commit", "") for meta in index.meta if meta.get("commit")), "")
    vectors = embedder.embed([question["question"] for question in questions])

    rows: list[dict] = []
    incidents: list[dict] = []
    stability: list[dict] = []
    for question, vector in zip(questions, vectors):
        hits = search_hits(index, vector)
        repeats = STABILITY_RUNS if question["id"] in STABILITY_IDS else 1
        answers = []
        for attempt in range(repeats):
            got = answer_once(question, hits, model, system, options, generate)
            answers.append(got)
            if got["failed"]:
                incidents.append({
                    "what": f"отказ локальной модели: {got['error']}",
                    "when": report.utc_now(),
                    "question_id": question["id"],
                    "outcome": f"повтор {attempt + 1} из {repeats} без ответа",
                })
            print(f"  {question['id']} #{attempt + 1}: {got['time_s']} с, "
                  f"{got['tps']} ток/с, отказ модели {got['refused']}", flush=True)
        first = answers[0]
        rows.append({
            "id": question["id"],
            "set": question["set"],
            "text": question["question"],
            "expect": question["expect"],
            "key": question["key"],
            "sources": question["sources"],
            "fragments": [
                {key: hit[key] for key in ("n", "source", "section", "score")}
                for hit in hits
            ],
            "local": first,
        })
        if repeats > 1:
            stability.append({
                "id": question["id"],
                "set": question["set"],
                "runs": [
                    {"time_s": one["time_s"], "ttft_s": one["ttft_s"], "tps": one["tps"],
                     "refused": one["refused"], "retrieved": one["retrieved"],
                     "cited": one["cited"], "key": one["key"], "quality": one["quality"],
                     "answer": one["answer"]}
                    for one in answers
                ],
                "time_s_spread": features.median_or_none([one["time_s"] for one in answers]),
                "distinct_answers": len({one["answer"] for one in answers}),
            })

    cloud_rows = cloud_side(questions, cloud, times)
    for row in rows:
        row["cloud"] = cloud_rows[row["id"]]

    notes = [
        "Один повтор на вопрос (решение владельца Р5); разброс виден только на "
        f"трёх вопросах стабильности — {', '.join(STABILITY_IDS)}.",
        "Индексы двух сторон разные: локальный собран на ноутбуке, облачный — "
        "на сервере. Сравнение честно там, где верный источник нашли оба.",
        "Судья — модель, вопросов десять, статистики нет: разница в один-два "
        "вопроса может быть шумом температуры 1.",
    ]
    if not any(row["cloud"].get("time_s") is not None for row in rows):
        notes.append(
            "Время облачной стороны не измерено: прогон дня 22 времени запуска не "
            "записывает, а сданный день не правится."
        )

    payload = {
        **report.envelope(28, model, runner, commit[:7] or "unknown", notes),
        "judge": {"name": None, "rubric": features.RUBRIC},
        "index": {"strategy": STRATEGY, "commit": commit, "embedder": embedder.model},
        "options": options,
        "summary": {
            "local": report.side_summary([row["local"] for row in rows]),
            "cloud": report.side_summary([row["cloud"] for row in rows]),
        },
        "questions": [
            {
                "id": row["id"],
                "set": row["set"],
                "text": row["text"],
                "expect": row["expect"],
                "key": row["key"],
                "sources": row["sources"],
                "fragments": row["fragments"],
                "local": row["local"],
                "cloud": row["cloud"],
            }
            for row in rows
        ],
        "stability": stability,
        "incidents": incidents,
    }
    if rss is not None:
        payload["memory"] = rss
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="День 28: RAG с локальной генерацией")
    parser.add_argument("--index", default=str(INDEX_DIR))
    parser.add_argument("--model", default=client.Q4)
    parser.add_argument("--out", default=str(prompts.ROOT / "site" / "day28" / "results.json"))
    parser.add_argument("--cloud", default=None,
                        help="файл прогона дня 22 (days/day22/public/eval.json или его копия)")
    parser.add_argument("--cloud-times", default=None,
                        help="JSON {id: секунды} — время облачных запусков, мереное снаружи")
    parser.add_argument("--limit", type=int, default=0,
                        help="взять только первые N вопросов (короткая проверка обвязки)")
    args = parser.parse_args(argv)

    cloud = json.loads(Path(args.cloud).read_text(encoding="utf-8")) if args.cloud else None
    times = json.loads(Path(args.cloud_times).read_text(encoding="utf-8")) if args.cloud_times else None
    questions = prompts.load_questions()
    if args.limit > 0:
        questions = questions[: args.limit]

    started = time.monotonic()
    # Пик RSS снимается на ВЕСЬ прогон, а не на вызов: модель грузится один
    # раз на набор, и пик приходится на загрузку весов (ADR, п. 4.4).
    with client.RssPeak() as peak:
        payload = run(Path(args.index), OllamaEmbedder(OLLAMA_URL, MODEL), args.model,
                      runner_version(), questions=questions, cloud=cloud, times=times)
    payload["memory"] = {**peak.report(), "ps": client.ps()}
    payload["wall_s"] = round(time.monotonic() - started, 1)
    out = report.write_results(Path(args.out), payload)
    print(f"-> {out}")
    return 0


def runner_version() -> str:
    """Версия Ollama для подвала страницы. Недоступна — так и сказано словом."""
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(f"{client.OLLAMA_URL}/api/version", timeout=10) as response:  # noqa: S310
            return "ollama " + json.load(response).get("version", "неизвестно")
    except (OSError, urllib.error.URLError, ValueError):
        return "ollama (версия не прочитана)"


if __name__ == "__main__":
    raise SystemExit(main())
