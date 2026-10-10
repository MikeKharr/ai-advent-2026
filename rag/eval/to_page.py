"""Сырой вывод прогона → `site/dayNN/results.json` по спецификации раскладки.

ЗАЧЕМ ОТДЕЛЬНЫЙ ШАГ, А НЕ ФОРМА ПРЯМО В ПРОГОНЕ. Прогон стоит часы GPU и
запускается один раз; форма публичного файла — предмет спецификации раскладки
и ревью облика, и она меняется. Пока это один код, правка одной запятой в
форме страницы означает перезапуск замера. Поэтому прогон пишет всё, что
снял, а этот модуль приводит снятое к узкому набору полей, которые читает
страница. Второе следствие: форму страницы можно починить на уже собранных
числах, не трогая GPU.

Источник истины о форме — `agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md`,
раздел «Файл данных». Поля ниже названы ровно так, как там.

ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Он не считает ничего, что спецификация оставила
странице: ни текста вывода дня, ни порога шума, ни слов колонки «Разница», ни
отбора вопросов с совпавшим поиском, ни фразы о числе изменённых осей. Он не
ставит вердиктов: `score` и `verdict` приходят файлом `--verdicts` от судьи
либо остаются `null`. И он не выдумывает чисел: поле, за которым нет замера,
остаётся `null`, а причина уходит строкой в `notes`.

Оба стража записи стоят и здесь: файл пишет `report.write_results`.

Запуск:

    R=~/Projects/ai-advent-2026-measurements/runs
    python3 -B eval/to_page.py --day 28 --in $R/day28-results.json \\
      --cloud ~/Projects/ai-advent-2026-measurements/raw/day28-cloud-eval.json \\
      --out ../site/day28/results.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import features  # noqa: E402
import report  # noqa: E402

# Дни, у которых файл данных есть. У дня 27 его нет вовсе — и это не пустой
# файл, а отсутствие: пустой `results.json` страница была бы обязана показать
# состоянием «пусто», то есть пообещать числа, которых не будет.
DAYS = (26, 28, 29, 30)

# Повторов на вопрос — решение владельца Р5. Поле читается страницей, а не
# подразумевается: сделает прогон когда-нибудь три — страница скажет «три».
REPEATS = 1

MIB = 1024


def mib(kib) -> float | None:
    return None if not kib else round(kib / MIB, 1)


def envelope(day: int, raw: dict, judge: str | None, notes: list[str],
             stability_ids: list[str] | None = None, judged: bool = True,
             memory_shown: bool = True) -> dict:
    """Общий конверт четырёх страниц с числами.

    `host` берётся КОНСТАНТОЙ, а не из сырого файла: это подпись машины
    словами, а не измеренная величина, и спецификация задаёт её текст. Сырой
    файл прогона, снятого до правки подписи, не должен из-за этого показывать
    на странице другую машину, чем соседний день.

    `judge` — строка с именем судьи; `null` значит «оценки ещё нет». У дня,
    где оценка механическая целиком, поля НЕТ ВОВСЕ (`judged=False`):
    спецификация говорит «отсутствует там, где оценка механическая», и
    `null` там читался бы как «судья не дошёл».
    """
    out = {
        "day": day,
        "generated": raw.get("generated") or report.utc_now(),
        "commit": raw.get("commit") or "unknown",
        "host": report.HOST_WORDS,
        "model": raw.get("model"),
        "runner": raw.get("runner"),
        "repeats": REPEATS,
    }
    if judged:
        out["judge"] = judge
    if stability_ids is not None:
        out["stability_ids"] = list(stability_ids)
    merged = list(raw.get("notes") or [])
    for note in notes:
        if note not in merged:
            merged.append(note)
    if not memory_shown:
        # Страница этого дня числа памяти не показывает — оговорка о его
        # составе ссылалась бы на число, которого на экране нет.
        merged = [note for note in merged if note != report.RSS_NOTE]
    elif report.RSS_NOTE not in merged and _has_rss(raw):
        merged.append(report.RSS_NOTE)
    if merged:
        out["notes"] = merged
    return out


def _has_rss(raw: dict) -> bool:
    return bool((raw.get("memory") or {}).get("peak_rss_kib"))


def verdicts_of(path: Path | None) -> dict:
    """Файл судьи → таблицы оценок и его слов.

    Форму пишет судья, а не этот модуль, и она такая:

        {"judge": "<имя>", "rubric": "0/1/2",
         "local":  [{"id": "q08", "run": 1, "verdict": 2, "note": "…"}, …],
         "cloud":  [{"id": "q08", "verdict": 2, "note": "…"}, …],
         "notes":  ["граница меры словами", …]}       # необязательно

    `run` есть только у локальной стороны и только потому, что три вопроса
    стабильности прогнаны трижды: у них судья оценивает КАЖДЫЙ ответ, и
    `runs[].verdict` страницы — это его оценки, а не повтор одной.

    Принимается и короткая форма `{"local": {id: 0|1|2}}` — ею удобно
    подставлять оценки руками для одного дня. Обе формы сводятся к одним
    таблицам, чтобы остальной модуль о различии не знал.

    Отсутствие файла — не ошибка, а штатное состояние до судейства: `score`,
    `verdict` и `judge` останутся `null`, и страница скажет это строкой, а не
    покажет ноль.
    """
    if path is None:
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    out = {
        # `judge` — и «judge», и «судья»: имя поля задаёт судья, и спорить с
        # ним из-за языка ключа дороже, чем принять оба.
        "judge": raw.get("judge") or raw.get("судья"),
        "rubric": raw.get("rubric"),
        "notes": list(raw.get("notes") or []),
        "scores": {},
        "runs": {},
        "notes_by": {},
    }
    for side in ("local", "cloud", "base", "after", "quant", "temperature",
                 "num_predict", "num_ctx", "think", "prompt"):
        table = raw.get(side)
        if isinstance(table, dict):
            out["scores"][side] = {qid: value for qid, value in table.items()
                                   if value in (0, 1, 2)}
            continue
        if not isinstance(table, list):
            continue
        scores: dict[str, int] = {}
        for row in table:
            qid = row.get("id")
            verdict = row.get("verdict")
            if qid is None or verdict not in (0, 1, 2):
                continue
            run = row.get("run")
            if run is None or int(run) == 1:
                # Основной ответ вопроса — первый прогон. Он и попадает в
                # таблицу по вопросам и в среднюю оценку стороны.
                scores[qid] = verdict
                if row.get("note"):
                    out["notes_by"].setdefault(side, {})[qid] = row["note"]
            if run is not None:
                out["runs"][(side, qid, int(run))] = verdict
        out["scores"][side] = scores
    return out


def _score(table: dict, side: str, question_id: str):
    value = (table.get("scores") or {}).get(side, {}).get(question_id)
    return value if value in (0, 1, 2) else None


def _run_score(table: dict, side: str, question_id: str, run: int):
    value = (table.get("runs") or {}).get((side, question_id, run))
    return value if value in (0, 1, 2) else None


def _judge_note(table: dict, side: str, question_id: str):
    return (table.get("notes_by") or {}).get(side, {}).get(question_id)


# ---------- день 26 ----------

def day26(raw: dict, verdicts: dict) -> dict:
    """`prompts[]` по спецификации; массива `runs` нет — прогон один.

    `scored_by` берётся из того, БЫЛА ли механическая проверка, а не из слова
    в сыром файле: разница между «проверено запуском» и «оценила модель» —
    это и есть ответ на вопрос «можно ли верить числу», и выводить её надо из
    факта проверки.

    `mode` у всех записей `null`: ступень, меренная дважды (рассуждение
    включено и выключено), в этом прогоне не делалась — см. расхождение в
    `rag/README.md`. `null` здесь значит «режима у записи нет», и страница
    покажет одну строку на запрос, а не припишет режим молча.
    """
    rows = []
    for row in raw.get("queries") or []:
        scored = row.get("check") is not None
        rows.append({
            "id": row["id"],
            "label": row["label"],
            "level": row.get("complexity"),
            "mode": None,
            "verdict": row.get("verdict"),
            "scored_by": "механически" if scored else "судья",
            "reason": row.get("reason"),
            "prompt": row.get("text"),
            "answer": row.get("answer"),
            "expected": row.get("expected"),
            "ttft_s": row.get("ttft_s"),
            "ttft_answer_s": row.get("ttft_answer_s"),
            "tps": row.get("tps"),
            "prompt_tokens": row.get("prompt_eval_count"),
            "answer_tokens": row.get("eval_count"),
            "done_reason": row.get("done_reason"),
        })
    for row in rows:
        if row["scored_by"] == "судья":
            value = _score(verdicts, "local", row["id"])
            if value is not None:
                row["verdict"] = features.quality_word(value)
    notes = [
        "Ступень, меренную дважды (рассуждение включено и выключено), этот прогон "
        "не делал: цена рассуждения мерена отдельно, в прогоне параметров движка.",
    ]
    return {**envelope(26, raw, verdicts.get("judge"), notes), "prompts": rows}


# ---------- день 28 ----------

def side_summary(rows: list[dict]) -> dict:
    """Сторона сравнения: `{score_avg, retrieved, cited, refused, time_s_mean, answers}`.

    СРЕДНЕЕ, А НЕ МЕДИАНА, и это не вкусовщина: спецификация требует среднего
    по десяти РАЗНЫМ вопросам и обязывает подпись столбца это сказать. Медиана
    живёт в сыром выводе прогона, странице она не показывается нигде.

    `score_avg` считается только по вопросам, где вердикт есть. Нет ни одного —
    `null`, а не ноль: «ноль из двух» и «судья не смотрел» на экране разные
    строки.
    """
    return {
        "score_avg": features.mean_or_none([row.get("score") for row in rows]),
        "retrieved": sum(1 for row in rows if row.get("retrieved") is True),
        "cited": sum(1 for row in rows if row.get("cited") is True),
        "refused": sum(1 for row in rows if row.get("refused") is True),
        "time_s_mean": features.mean_or_none([row.get("time_s") for row in rows]),
        "answers": len(rows),
    }


def _sources(fragments) -> list[dict]:
    return [{"path": item.get("source"), "section": item.get("section")}
            for item in (fragments or [])]


def day28(raw: dict, cloud_raw: dict | None, verdicts: dict,
          times: dict | None) -> dict:
    stability_ids = [row["id"] for row in raw.get("stability") or []]
    runs_by_id = {row["id"]: row.get("runs") or [] for row in raw.get("stability") or []}
    cloud_by_id = {}
    if cloud_raw:
        cloud_by_id = {item["id"]: item for item in cloud_raw.get("questions") or []}

    questions = []
    local_rows = []
    cloud_rows = []
    for row in raw.get("questions") or []:
        qid = row["id"]
        local_raw = row.get("local") or {}
        local_score = _score(verdicts, "local", qid)
        local = {
            "score": local_score,
            "verdict": features.quality_word(local_score),
            "time_s": local_raw.get("time_s"),
            "refused": local_raw.get("refused"),
            "sources": _sources(row.get("fragments")),
            "answer": local_raw.get("answer"),
            "judge_note": _judge_note(verdicts, "local", qid),
            # Признаки механики нужны сводке стороны; страница их не печатает,
            # но «ответов с найденным верным документом» в «Итоге» — это они.
            "retrieved": local_raw.get("retrieved"),
            "cited": local_raw.get("cited"),
        }
        # `runs` ровно у трёх вопросов стабильности, и только у локальной
        # стороны: остальным это поле не положено (спецификация, «День 28»).
        if qid in runs_by_id:
            # Вердикт КАЖДОГО повтора — его собственный: у трёх вопросов
            # стабильности судья оценивал все три ответа, и подставить сюда
            # оценку первого было бы подменой («вердикты не расходились» при
            # разошедшихся вердиктах — ровно то, что секция обязана показать).
            local["runs"] = [
                {"verdict": features.quality_word(
                    _run_score(verdicts, "local", qid, at + 1)),
                 "time_s": one.get("time_s"),
                 "done_reason": one.get("done_reason")}
                for at, one in enumerate(runs_by_id[qid])
            ]

        got = (cloud_by_id.get(qid, {}).get("modes") or {}).get("rag") or {}
        cloud_score = _score(verdicts, "cloud", qid)
        if cloud_score is None and got.get("verdict") in (0, 1, 2):
            # Вердикты облачной стороны могут уже стоять в файле прогона
            # дня 22 — тот же судья, та же рубрика. Второй раз их не просят.
            cloud_score = got["verdict"]
        cloud = {
            "score": cloud_score,
            "verdict": features.quality_word(cloud_score),
            "time_s": (times or {}).get(qid),
            "refused": got.get("refused"),
            # Выдачи поиска облачной стороны в файле прогона дня 22 нет вовсе:
            # он записывает признаки и ответ, а не найденные фрагменты. Пустой
            # список здесь значит «не записано», и это сказано в `notes`.
            "sources": [],
            "answer": got.get("answer"),
            "judge_note": _judge_note(verdicts, "cloud", qid),
            "retrieved": got.get("retrieved"),
            "cited": got.get("cited"),
        }
        questions.append({
            "id": qid,
            "text": row.get("text"),
            # Верный документ нашли ОБА — только на таких вопросах сравнение
            # честно, и именно по этому полю страница отбирает вопросы для
            # вывода дня. У общего вопроса верного документа нет вовсе, и
            # здесь `null`, а не `false`: нечего совпадать.
            "retrieved_match": _retrieved_match(local, cloud),
            "local": local,
            "cloud": cloud,
        })
        local_rows.append({**local, "score": local_score})
        cloud_rows.append({**cloud, "score": cloud_score})

    notes = [
        "Выдачи поиска облачной стороны в файле нет: прогон дня 22 записывает "
        "признаки и ответ, а не найденные фрагменты. Поэтому «поиск совпал» "
        "считается по признаку верного документа, а не по списку путей.",
        # Находка судьи по q09, сказанная как свойство меры, а не как случай:
        # признак про ДОКУМЕНТ, и совпадение документа не значит, что в
        # найденный фрагмент попал нужный раздел.
        "«Поиск совпал» означает, что совпал ДОКУМЕНТ, а не фрагмент: нужного "
        "раздела в найденных фрагментах могло не быть у обеих сторон.",
        # Вторая находка судьи, тоже обобщённая: признаки ловят форму.
        "Признаки «путь назван» и «ключевая фраза есть» ловят форму, а не смысл: "
        "путь сверяется подстрокой, а ссылка видом «[1]» без пути признаком не "
        "становится. Поэтому они местами расходятся с оценкой судьи — оценку "
        "ставит он, а не признак.",
    ]
    if not any(row.get("time_s") is not None for row in cloud_rows):
        notes.append("Время облачной стороны не измерено: прогон дня 22 времени "
                     "запуска не записывает, а сданный день не правится.")
    notes.extend(_derived_notes(raw))
    notes.extend(verdicts.get("notes") or [])
    return {
        **envelope(28, raw, verdicts.get("judge"), notes, stability_ids,
                   memory_shown=False),
        "summary": {"local": side_summary(local_rows), "cloud": side_summary(cloud_rows)},
        "questions": questions,
    }


def _derived_notes(raw: dict) -> list[str]:
    """Границы меры, которые ВЫВОДЯТСЯ из чисел прогона, а не пишутся руками.

    Обе — находки судейства дня 28, и обе здесь считаются, а не повторяются
    текстом: вписанные руками они относились бы к одному прогону и врали бы
    на следующем.

    1. Ответ, упёршийся в потолок `num_predict` (`done_reason == "length"`),
       оценивается как обрезанный, и это не свойство модели.
    2. Первый повтор вопроса стабильности может нести загрузку весов: время до
       первого токена у него кратно больше, чем у соседних повторов, и в
       разброс это входит как холодный старт, а не как разброс модели.
    """
    out = []
    truncated = [row["id"] for row in raw.get("questions") or []
                 if (row.get("local") or {}).get("done_reason") == "length"]
    if truncated:
        out.append(
            f"Локальный ответ упёрся в потолок num_predict на вопросах: "
            f"{', '.join(truncated)}. Такой ответ обрезан, и низкая оценка на нём — "
            "следствие потолка, а не незнания модели.")
    cold = []
    for row in raw.get("stability") or []:
        runs = row.get("runs") or []
        first = (runs[0] or {}).get("ttft_s") if runs else None
        rest = [one.get("ttft_s") for one in runs[1:] if one.get("ttft_s")]
        if first and rest and first > 2 * min(rest):
            cold.append(f"{row['id']} ({_ru(first)} с против {_ru(min(rest))} с)")
    if cold:
        out.append(
            f"Первый повтор нёс загрузку весов: {', '.join(cold)}. Это холодный "
            "старт, а не разброс модели, и в разбросе времени его надо читать "
            "отдельно.")
    return out


def _ru(number) -> str:
    """Число для текста страницы: десятичная запятая, как во всей неделе."""
    return str(number).replace(".", ",")


def _retrieved_match(local: dict, cloud: dict):
    if local.get("retrieved") is None or cloud.get("retrieved") is None:
        return None
    return bool(local["retrieved"]) and bool(cloud["retrieved"])


# ---------- день 29 ----------

# Подпись значения оси «до»/«после» для таблицы «Оси». У промпта в ячейке
# слово, а не текст: два абзаца промпта в ячейке таблицы нечитаемы.
AXIS_LABELS = {
    "prompt": ("полный", "компактный"),
    "quant": ("Q4_K_M", "Q6_K"),
    "think": ("выключено", "включено"),
}


def axis_values(axis: dict, base_options: dict) -> tuple:
    """Значения «до» и «после» одной оси — из её собственного отличия от базы."""
    known = AXIS_LABELS.get(axis["id"])
    if known:
        return known
    options = axis.get("options") or {}
    for key, value in options.items():
        if base_options.get(key) != value:
            return base_options.get(key), value
    return None, None


def axis_changes(axis: dict, base_options: dict) -> int:
    """Сколько осей менялось в этом прогоне. У метода дня — одна за раз.

    Считается по фактическому отличию, а не по обещанию: ось квантования
    меняет две вещи (сборку и отсутствие рассуждения, которого у неё нет), и
    страница обязана сказать «менялось 2 оси разом», а не промолчать.
    """
    options = axis.get("options") or {}
    changed = sum(1 for key, value in options.items() if base_options.get(key) != value)
    if axis.get("model") and axis["model"] != axis.get("base_model"):
        changed += 1
    if axis.get("forced"):
        changed += 1
    return max(changed, 1)


def day29(raw: dict, verdicts: dict, memory: dict | None) -> dict:
    base_options = (raw.get("base") or {}).get("options") or {}
    base_model = raw.get("model")
    memory = memory or {}

    axes = []
    quant = None
    for variant in raw.get("variants") or []:
        rows = variant.get("answers") or []
        before, after = axis_values({**variant, "base_model": base_model}, base_options)
        mem = memory.get(variant["id"])
        axes.append({
            "name": variant.get("label"),
            "before": before,
            "after": after,
            "score_avg": features.mean_or_none(
                [_score(verdicts, variant["id"], row["id"]) for row in rows]),
            "tps": features.mean_or_none([row.get("tps") for row in rows]),
            "ttft_s": features.mean_or_none([row.get("ttft_s") for row in rows]),
            "mem_mib": mib(mem),
            "changed": axis_changes({**variant, "base_model": base_model}, base_options),
        })
        if variant.get("numbers_only"):
            quant = _quant(raw, variant, verdicts, memory)

    notes = []
    if not any(axis["mem_mib"] is not None for axis in axes):
        notes.append("Память по осям не мерена: пик RSS снят на весь прогон, а не на "
                     "каждую ось. Числа памяти по сборкам — в прогоне квантования "
                     "каталога замеров.")
    if not any(axis["score_avg"] is not None for axis in axes):
        notes.append("Оценок судьи по осям ещё нет: прогон вердиктов не ставит.")
    stability = [row["id"] for row in raw.get("stability") or []]
    if not stability:
        notes.append("Три вопроса стабильности в этом прогоне не повторялись: их "
                     "разброс мерен в дне 28, на той же базовой конфигурации.")

    out = {
        **envelope(29, raw, verdicts.get("judge"), notes, stability),
        "base": _day29_side(raw.get("base") or {}, verdicts, "base"),
        "after": _day29_side(raw.get("after") or {}, verdicts, "after"),
        "axes": axes,
        "prompts": raw.get("prompts") or {"before": None, "after": None},
    }
    if quant is not None:
        out["quant"] = quant
    return out


def _day29_side(side: dict, verdicts: dict, key: str) -> dict:
    rows = [{**row, "score": _score(verdicts, key, row["id"])}
            for row in side.get("answers") or []]
    return side_summary(rows)


def _quant(raw: dict, variant: dict, verdicts: dict, memory: dict) -> dict:
    """`quant: {a, b}` — И НИЧЕГО БОЛЬШЕ.

    У стороны `b` в файле нет ни `answer`, ни `prompt`, ни `judge_note`: это
    сборка без отказов, её тексты не публикуются (вето ADR 2026-10-07-1349).
    Набор полей здесь закрытый и перечислен явно, а не собран из записи
    варианта: собранный из записи он однажды привёз бы в файл лишнее поле,
    которое страж поймал бы уже после прогона.
    """
    base_rows = (raw.get("base") or {}).get("answers") or []
    rows = variant.get("answers") or []
    return {
        "a": _quant_side("Q4_K_M", raw.get("model"), base_rows,
                         [_score(verdicts, "base", row["id"]) for row in base_rows],
                         memory.get("base")),
        "b": _quant_side("Q6_K", variant.get("model"), rows,
                         [_score(verdicts, "quant", row["id"]) for row in rows],
                         memory.get(variant["id"])),
    }


def _quant_side(label: str, model: str | None, rows: list[dict],
                scores: list, mem) -> dict:
    return {
        "label": label,
        "model": model,
        "ttft_s": features.mean_or_none([row.get("ttft_s") for row in rows]),
        "tps": features.mean_or_none([row.get("tps") for row in rows]),
        "mem_mib": mib(mem),
        # «Верных из {N}»: верным считается вердикт 2 рубрики. Вердиктов нет —
        # `null`, а не ноль.
        "correct": (sum(1 for score in scores if score == 2)
                    if any(score is not None for score in scores) else None),
        "of": len(rows),
    }


# ---------- день 30 ----------

def day30(raw: dict) -> dict:
    """`access`, `burst[]`, `limits[]`. Текстов ответов нет ни в одном поле."""
    burst = []
    for row in raw.get("concurrency") or []:
        if (row.get("parallel") or 0) < 2:
            continue
        reasons = [text for text in (row.get("reasons") or []) if text]
        burst.append({
            # Путь берётся ИЗ ЗАПИСИ прогона. Выводить его из числа
            # параллельности нельзя: обе пробы идут по три запроса, и страница
            # перепутала бы строки «через публичный API» и «напрямую».
            "path": row.get("path"),
            "requests": row.get("requests"),
            "served": (None if row.get("requests") is None or row.get("failures") is None
                       else row["requests"] - row["failures"]),
            "refused": row.get("failures"),
            "reason": reasons[0] if reasons else None,
            "total_s": row.get("wall_s"),
        })
    limits = [{"name": row.get("name"), "value": row.get("value"),
               "fired": row.get("fired"), "client_saw": row.get("client_saw")}
              for row in raw.get("limits") or []]
    return {
        # Судьи у дня 30 нет вовсе: оценка механическая — коды ответов и
        # времена, а не смысл текста. Поэтому поля `judge` в файле нет.
        **envelope(30, raw, None, [], judged=False),
        "access": raw.get("access") or {},
        "burst": burst,
        "limits": limits,
    }


BUILDERS = {26: "day26", 28: "day28", 29: "day29", 30: "day30"}


def build(day: int, raw: dict, cloud: dict | None = None, verdicts: dict | None = None,
          times: dict | None = None, memory: dict | None = None) -> dict:
    """Сырой вывод → тело страницы. День сверяется с полем `day` сырого файла.

    Несовпадение — отказ, а не предупреждение: четыре одинаковых по форме
    файла в четырёх каталогах, и перепутанный вход показал бы чужие числа как
    свои ровно так же, как перепутанный выход.
    """
    verdicts = verdicts or {}
    if day not in DAYS:
        raise SystemExit(f"файла данных у дня {day} нет; есть у дней {', '.join(map(str, DAYS))}")
    if raw.get("day") != day:
        raise SystemExit(f"сырой файл от дня {raw.get('day')}, а просят день {day}")
    if day == 26:
        return day26(raw, verdicts)
    if day == 28:
        return day28(raw, cloud, verdicts, times)
    if day == 29:
        return day29(raw, verdicts, memory)
    return day30(raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Сырой вывод прогона → файл страницы по спецификации раскладки")
    parser.add_argument("--day", type=int, required=True, choices=DAYS)
    parser.add_argument("--in", dest="source", required=True, help="сырой вывод прогона")
    parser.add_argument("--out", required=True, help="site/dayNN/results.json")
    parser.add_argument("--cloud", default=None,
                        help="день 28: файл прогона дня 22 (облачная сторона)")
    parser.add_argument("--cloud-times", default=None,
                        help="день 28: JSON {id: секунды} — время облачных запусков")
    parser.add_argument("--verdicts", default=None,
                        help='файл судьи: {"judge": "имя", "local": [{id, run, '
                             'verdict, note}], "cloud": [{id, verdict, note}]}')
    parser.add_argument("--memory", default=None,
                        help="день 29: JSON {ось: КиБ} — пик памяти по осям")
    parser.add_argument("--force", action="store_true",
                        help="перезаписать уже лежащий файл страницы")
    args = parser.parse_args(argv)

    # ГОТОВЫЙ ФАЙЛ СТРАНИЦЫ НЕ ЗАТИРАЕТСЯ МОЛЧА. Причина не в осторожности
    # вообще: `site/day26/results.json` уже лежит в проде (PR #339) и несёт
    # поля, которых это преобразование НЕ ПРОИЗВОДИТ — `access`,
    # `speed_vs_content`, `speculative`, а у записей `note` и `series`.
    # Прогон поверх него оставил бы страницу без половины таблиц, и заметил бы
    # это только посетитель. Поэтому перезапись — решение вслух, флагом.
    out_path = Path(args.out)
    if out_path.exists() and not args.force:
        print(f"{out_path} уже есть. Преобразование производит не все поля, "
              "которые может читать страница (у дня 26 — access, "
              "speed_vs_content, speculative): перезапись затрёт их молча. "
              "Нужен --force.")
        return 1

    read = lambda path: json.loads(Path(path).read_text(encoding="utf-8"))  # noqa: E731
    payload = build(
        args.day,
        read(args.source),
        cloud=read(args.cloud) if args.cloud else None,
        verdicts=verdicts_of(Path(args.verdicts) if args.verdicts else None),
        times=read(args.cloud_times) if args.cloud_times else None,
        memory=read(args.memory) if args.memory else None,
    )
    out = report.write_results(Path(args.out), payload)
    print(f"-> {out}")
    _print_matched(payload)
    return 0


def _print_matched(payload: dict) -> None:
    """Средняя оценка по вопросам с совпавшим поиском — В ВЫВОД, НЕ В ФАЙЛ.

    Число нужно человеку сразу: именно по нему день 28 делает вывод. Но в
    файл оно не идёт, и это не забывчивость — спецификация раскладки прямо
    относит «отбор вопросов с совпавшим поиском» к тому, что СТРАНИЦА СЧИТАЕТ
    САМА, «иначе файл сможет сказать „локальная не хуже“ при числах,
    говорящих обратное». В файле лежит то, из чего страница это посчитает:
    `questions[].retrieved_match` и `score` каждой стороны.
    """
    questions = [row for row in payload.get("questions") or []
                 if row.get("retrieved_match") is True]
    if not questions:
        return
    for side in ("local", "cloud"):
        average = features.mean_or_none([row[side].get("score") for row in questions])
        print(f"   по совпавшему поиску ({len(questions)} вопросов), {side}: "
              f"средняя оценка {average}")


if __name__ == "__main__":
    raise SystemExit(main())
