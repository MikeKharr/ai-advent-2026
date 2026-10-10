"""Запись файлов замера: общий конверт сырого вывода и два стража.

ЧТО ЭТОТ МОДУЛЬ ПИШЕТ, А ЧТО НЕТ. Он пишет **сырой вывод прогона** — всё, что
прогон снял, включая поля, которых странице не нужно. Форму публичного
`site/dayNN/results.json` задаёт спецификация раскладки
(`agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md`,
«Файл данных»), и она НЕ РАВНА форме сырого вывода; приводит одну к другой
отдельный шаг `eval/to_page.py`. Разделение намеренное: правка формы страницы
иначе стоила бы часов GPU на перезапуск прогона.

ДВА СТРАЖА ЗАПИСИ, и они здесь не для красоты — это единственное место, где
публичный файл можно испортить необратимо:

1. `check_no_abliterated_texts` — тексты сборки без отказов на страницу и в
   файл не идут ни при каких числах (ADR, п. 1.3 и 4.3; вето `compliance`
   ADR 2026-10-07-1349). Её ответы судья читает с ноутбука, а в файл от этой
   оси попадают только числа.
2. `check_no_private_addresses` — адреса и имени машины частной сети в файле
   нет (I-1, I-3; спецификация раскладки, «Чего в файле нет никогда»).
   `host` — слова («ноутбук владельца»), а не адрес.

**Граница второго стража названа точно, потому что прежняя формулировка
обещала больше, чем проверяет.** Он не ищет «ключ»: значения ключей выглядят
как произвольная строка, и отличить их от текста ответа нечем — ключей в этих
прогонах не бывает по построению (локальная Ollama их не требует, а ключ
оператора дня 22 читает прогон дня 22, не этот код). Ищутся именно адрес и
имя машины — то, по чему до стенда можно постучаться. У прогона дня 30,
единственного, где ключ рядом есть, ключ не попадает в запись вовсе: запись
пробы несёт код ответа и время, а тела запроса в ней нет.

Оба стража вызываются из `write_results`, и ни одна запись файла замера их не
обходит: `eval/to_page.py` пишет публичный файл тем же `write_results`, а
`day29_params.py` — им же. Красят это тесты `СтражТекстовБезОтказов`,
`СтражАдресов` и `ЗаписьТолькоЧерезСтражей` в `rag/test/test_eval_local.py`:
снять вызов — краснеет прогон.
"""

from __future__ import annotations

import datetime
import json
import re
import tempfile
from pathlib import Path

import features
from ollama_client import Q6

# Машина замера СЛОВАМИ. Адреса и имени в сети в файле быть не может.
# Модель машины названа: спецификация раскладки просит «ноутбук владельца,
# Apple M3 Max» — читателю нужно знать, на каком железе числа получены, а
# модель процессора адресом не является.
HOST_WORDS = "ноутбук владельца, Apple M3 Max"

# Оговорка о пике RSS. Нужна в КАЖДОМ файле, где есть `peak_rss_kib`: сумма
# берётся по всем процессам Ollama на машине, а на ноутбуке их две службы —
# своя для замеров и своя для сайта. Веса в сумму попадают один раз (их
# держит `llama-server` загруженной модели), но сервер второй службы в неё
# входит десятками мегабайт. Без этой строки число читалось бы как «столько
# занимает модель», и завышение в несколько десятков МиБ выглядело бы частью
# модели.
RSS_NOTE = (
    "Пик RSS — сумма по всем процессам Ollama на машине. Служб на ноутбуке "
    "две (замеры и сайт), и сервер второй службы входит в сумму десятками "
    "мегабайт; разбивка по процессам лежит рядом с числом."
)

# Ключи, в значениях которых может оказаться текст ответа модели.
TEXT_KEYS = ("answer", "response", "thinking", "text", "before", "after",
             "prompt", "expected", "reason")

# Поля, куда кладётся текст, который написала МОДЕЛЬ. В них страж адресов
# ищет только имена частной сети: выдуманный моделью IPv4 — не утечка.
MODEL_TEXT_KEYS = ("answer", "response", "thinking")

# Имя машины в частной сети и имя службы сайта на ноутбуке. СЛОВО «Tailscale»
# здесь НЕ ЗАПРЕЩЕНО намеренно: название сети стоит в публичных ADR и в
# описании проекта, секретом не является, и запрет на него заставлял бы
# объяснять устройство доступа иносказаниями. Запрещены адрес и имя — то, по
# чему до машины можно постучаться.
#
# `127.0.0.1` — петля, а не частная сеть, но и она в файл данных не идёт:
# исключения для неё в проверке IPv4 ниже нет.
PRIVATE_HINTS = (".ts.net", "ollama-tailnet")
IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


def utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def envelope(day: int, model: str, runner: str, commit: str,
             notes: list[str] | None = None, generated: str | None = None) -> dict:
    """Конверт, одинаковый у всех пяти страниц.

    `commit` — коммит ИНДЕКСА или прогона, а не дерева ветки: мера описывает
    то, по чему искала (ADR, п. 1.7). Передаёт его вызывающий прогон; выдумать
    его здесь нечем.
    """
    out = {
        "day": day,
        "generated": generated or utc_now(),
        "commit": commit,
        "host": HOST_WORDS,
        "model": model,
        "runner": runner,
    }
    if notes:
        out["notes"] = list(notes)
    return out


def _walk(node, path=()):
    """Обход дерева JSON парами (путь, значение) — основа обоих стражей."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk(value, path + (str(key),))
    elif isinstance(node, list):
        for at, value in enumerate(node):
            yield from _walk(value, path + (str(at),))
    else:
        yield path, node


def check_no_abliterated_texts(payload) -> None:
    """Ветвь, помеченная сборкой без отказов, не вправе нести ни одного текста.

    Проверяется НЕ одна запись, а ВСЁ ПОДДЕРЕВО под ней: ось квантования
    пишется объектом варианта с `model`, а ответы лежат списком внутри, и
    проверка только верхней записи пропустила бы ровно то, что обязана
    поймать. Текст здесь — нарушение вето ADR 2026-10-07-1349, и запись файла
    падает исключением, а не предупреждением: публичный файл после записи уже
    утёк бы.
    """
    offenders = sorted(set(_texts_under_q6(payload)))
    if offenders:
        raise ValueError(
            "тексты сборки без отказов в файл не идут (ADR 2026-10-07-1349): "
            + ", ".join(offenders)
        )


def _texts_under_q6(node, path="$", inside=False):
    """Пути всех непустых текстов в поддереве, помеченном сборкой без отказов."""
    if isinstance(node, dict):
        inside = inside or node.get("model") == Q6
        if inside:
            for key in TEXT_KEYS:
                value = node.get(key)
                if isinstance(value, str) and value.strip() != "":
                    yield f"{path}.{key}"
        for key, value in node.items():
            yield from _texts_under_q6(value, f"{path}.{key}", inside)
    elif isinstance(node, list):
        for at, value in enumerate(node):
            yield from _texts_under_q6(value, f"{path}[{at}]", inside)


def check_no_private_addresses(payload) -> None:
    """Ни адреса частной сети, ни имени машины в ней, ни IPv4 в файле.

    Почему шире, чем «не писать `host`»: адрес протекает не из конверта, а из
    случайного поля — текста ошибки сети, значения `options`, скопированной
    команды. Поэтому проверяется КАЖДАЯ строка дерева.

    ГРАНИЦА, И ОНА НАМЕРЕННАЯ. В полях, куда кладётся текст МОДЕЛИ
    (`MODEL_TEXT_KEYS`), ищутся только имена частной сети, а не любой IPv4.
    Причина различения: `10.0.0.1` в пересказе документа — выдумка модели, а
    не утечка адреса стенда, и падение записи на ней стоило бы часа GPU и
    ничего бы не защитило. Имя частной сети в ответе модели так не появляется
    — его туда может принести только наш же промпт или наша же ошибка.
    """
    offenders = []
    for path, value in _walk(payload):
        if not isinstance(value, str):
            continue
        low = value.lower()
        model_text = bool(path) and path[-1] in MODEL_TEXT_KEYS
        if any(hint in low for hint in PRIVATE_HINTS):
            offenders.append(".".join(path) or "$")
        elif not model_text and IPV4.search(value):
            offenders.append(".".join(path) or "$")
    if offenders:
        raise ValueError(
            "адрес или имя машины частной сети в файле результата (I-1, I-3): "
            + ", ".join(sorted(set(offenders)))
        )


def write_results(path: Path, payload: dict) -> Path:
    """Записать файл результата, пройдя оба стража.

    Стражи стоят ДО записи, а не после: файл, уже лёгший на диск, попадает в
    коммит страницы, и проверка после записи ловила бы утечку, которая уже
    случилась. Тот же порядок, что у лимитера в I-4, и по той же причине.

    Отказ стража не выбрасывает собранный прогон: payload уходит в каталог
    временных файлов ОС (не в репозиторий и не в `site/`), путь печатается, и
    исключение поднимается дальше. Иначе цена ложного срабатывания — час GPU,
    и прогон начали бы запускать мимо стража.
    """
    try:
        check_no_abliterated_texts(payload)
        check_no_private_addresses(payload)
    except ValueError as error:
        quarantine = Path(tempfile.mkdtemp(prefix="rag-eval-rejected-")) / path.name
        quarantine.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8")
        raise ValueError(f"{error}\nпрогон не потерян, он здесь: {quarantine}") from error
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return path


def seconds(milliseconds) -> float | None:
    return None if milliseconds is None else round(milliseconds / 1000, 3)


def side_summary(rows: list[dict]) -> dict:
    """Сводка одной стороны сравнения дня 28 — форма из спецификации раскладки.

    `matched`/`partial`/`missed` считаются по СЛОВУ качества, а не по баллу:
    балл по десяти вопросам даёт ложную точность, и страница его не
    показывает. Вопрос без вердикта судьи не попадает ни в одну из трёх
    корзин — он остаётся в `queries` и виден как недостающий.
    """
    words = [row.get("quality") for row in rows]
    return {
        "queries": len(rows),
        "matched": words.count("верно"),
        "partial": words.count("частично"),
        "missed": words.count("неверно"),
        "time_s_median": features.median_or_none([row.get("time_s") for row in rows]),
        "failures": sum(1 for row in rows if row.get("failed")),
    }
