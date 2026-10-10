"""День 30 — приватный сервис: пробы через прод и напрямую в локальную Ollama.

Что мерит (ADR 2026-10-09-1335, п. 6): доступ по сети, несколько запросов
разом и срабатывание ограничений. Три ограничения — частота (шестой запрос в
минуту через день 5 → `429` с `retry-after`), размер запроса (отказ роутера
выше `maxRequestTokens` ДО вызова провайдера) и окно контекста (прямой запрос
длиннее `num_ctx`, с заданным окном и без него).

ПРЕДУСЛОВИЕ — Tailscale на ноутбуке включён, и это действие владельца
(решение Р4: включить на окно проверки и выключить после). Пока он остановлен,
все пробы через прод дают один и тот же ответ «провайдер недоступен» и не
различают ни одной гипотезы. Поэтому прогон сначала проверяет доступность
провайдера и, не увидев её, НЕ ИДЁТ дальше по пробам через прод: иначе файл
результата нёс бы десять одинаковых отказов, выглядящих как замер.

Расход — ноль: цена записи `mac-qwen3` нулевая, и явный выбор провайдера в
облако не падает (`explicitOnly`). Тратятся слоты дня 5 — около десяти из
пятидесяти суточных, общих с посетителями.

Тексты ответов на страницу дня 30 не идут — только времена и коды.

Запуск (сначала с `--dry-run`, он ничего не отправляет):

    EVAL_OLLAMA_URL=http://127.0.0.1:11435 python3 -B eval/day30_probe.py \\
      --out ~/Projects/ai-advent-2026-measurements/runs/day30-results.json

`-B` и чистка `__pycache__` обязательны, `-I` — нет: он включает
изолированный режим, каталог скрипта в `sys.path` не попадает, и прогон
падает с `ModuleNotFoundError`. Байт-код отключает `-B`.

Прогон пишет СЫРОЙ вывод в каталог замеров. Файл страницы по
спецификации раскладки делает отдельный шаг:
`python3 -B eval/to_page.py --day 30 --in <сырой> --out ../site/day30/results.json`.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import features  # noqa: E402
import ollama_client as client  # noqa: E402
import prompt as prompts  # noqa: E402
import report  # noqa: E402

# Публичный адрес дня 5 — тот же путь, которым идёт посетитель. Другого пути
# к проду у этого прогона нет.
DAY5 = "https://challenge.zpq.ai/day5/api/answer"

# Провайдер локальной модели в роутере (`router/config/providers.json`).
PROVIDER = "mac-qwen3"

# Окно запусков дня 5 — 5 в минуту на адрес (`days/day5/env.js`). Шестой и
# проверяет частоту.
RATE_WINDOW = 5

# Потолок запроса у записи провайдера. Выше него роутер отказывает ДО вызова.
MAX_REQUEST_TOKENS = 6000


def ask_day5(prompt_text: str, base: str = DAY5, max_tokens: int = 64,
             timeout: float = 180, opener=urllib.request.urlopen) -> dict:
    """Один запрос через публичный API дня 5. Возвращает код, время и причину.

    Текст ответа НЕ ВОЗВРАЩАЕТСЯ вовсе: на страницу дня 30 идут времена и
    коды, и текст, которого в записи нет, утечь не может.
    """
    body = json.dumps({"prompt": prompt_text, "model": PROVIDER,
                       "maxTokens": max_tokens}).encode("utf-8")
    request = urllib.request.Request(base, data=body,
                                     headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    try:
        with opener(request, timeout=timeout) as response:  # noqa: S310
            payload = json.load(response)
            return {
                "status": response.status,
                "time_s": round(time.perf_counter() - started, 3),
                "answer_chars": len(str(payload.get("text") or payload.get("answer") or "")),
                "reason": None,
                "retry_after": response.headers.get("retry-after"),
            }
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        reason = text
        try:
            reason = json.loads(text).get("error") or text
        except ValueError:
            pass
        return {
            "status": error.code,
            "time_s": round(time.perf_counter() - started, 3),
            "answer_chars": None,
            "reason": str(reason)[:300],
            "retry_after": error.headers.get("retry-after"),
        }
    except (OSError, urllib.error.URLError, ValueError) as error:
        return {
            "status": None,
            "time_s": round(time.perf_counter() - started, 3),
            "answer_chars": None,
            "reason": f"{type(error).__name__}: {error}",
            "retry_after": None,
        }


def parallel_direct(model: str, count: int, generate=client.generate) -> dict:
    """`count` одновременных запросов НАПРЯМУЮ в локальную Ollama.

    Показывает цену `OLLAMA_NUM_PARALLEL`: полное время набора против времени
    одиночного запроса. Очередь — это результат, а не дефект, и суммарные
    ток/с считаются по сумме выходных токенов на полное время набора, а не
    средним по запросам: среднее по запросам, стоящим в очереди, завысило бы
    пропускную способность.
    """
    text = "Объясни одним абзацем, зачем публичному API нужен лимит запросов."
    options = {"num_ctx": 8192, "temperature": 0, "seed": 11, "num_predict": 128}
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        runs = list(pool.map(
            lambda _: generate(model, text, options=options, think=False),
            range(count)))
    wall = time.perf_counter() - started
    tokens = sum(run["metrics"]["eval_count"] or 0 for run in runs)
    return {
        # Путь — ПОЛЕ записи, а не догадка по числу параллельности: страница
        # показывает две строки, «через публичный API» и «напрямую в Ollama»,
        # и перепутать их местами она не вправе.
        "path": "напрямую в Ollama",
        "parallel": count,
        "requests": count,
        "tps_total": round(tokens / wall, 2) if wall > 0 else None,
        "ttft_s_median": features.median_or_none(
            [report.seconds(run["metrics"]["ttft_ms"]) for run in runs]),
        "wall_s": round(wall, 3),
        "failures": sum(1 for run in runs if run["error"] is not None),
    }


def parallel_day5(count: int, ask=ask_day5) -> dict:
    """`count` одновременных запросов через день 5.

    Ожидание — один обслужен, остальные отказаны роутером с причиной «ёмкость
    хоста исчерпана» (`maxConcurrency: 1`). Это явный выбор конфигурации, а не
    дефект, и отказ здесь — измеряемый результат.
    """
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        rows = list(pool.map(
            lambda _: ask("Одним предложением: зачем серверу лимит запросов?"),
            range(count)))
    return {
        "path": "через публичный API дня 5",
        "parallel": count,
        "requests": count,
        "tps_total": None,
        "ttft_s_median": None,
        "wall_s": round(time.perf_counter() - started, 3),
        "failures": sum(1 for row in rows if row["status"] != 200),
        "statuses": [row["status"] for row in rows],
        "reasons": [row["reason"] for row in rows if row["reason"]],
    }


def limit_rate(ask=ask_day5, sleep=time.sleep) -> dict:
    """Частота: шесть запросов подряд, шестой обязан получить `429`.

    Пять первых занимают окно, шестой его проверяет. Запись несёт `retry-after`
    дословно: без числа секунд отказ не отличить от сбоя.
    """
    rows = [ask("Одним словом: да.") for _ in range(RATE_WINDOW + 1)]
    last = rows[-1]
    return {
        "name": f"запусков в минуту на адрес — {RATE_WINDOW}",
        "value": str(RATE_WINDOW),
        "fired": last["status"] == 429,
        "client_saw": f"{last['status']}, retry-after {last['retry_after']}, "
                      f"{last['reason']}",
        "statuses": [row["status"] for row in rows],
    }


def limit_request_size(ask=ask_day5) -> dict:
    """Размер запроса: выше `maxRequestTokens` роутер отказывает ДО вызова.

    Длина берётся с запасом над потолком в токенах: знаков на токен по-русски
    меньше четырёх, поэтому потолок заведомо превышен. Точного числа токенов
    запроса прогон не знает — и не обязан: проверяется факт отказа и его
    слова, а не граница с точностью до токена.
    """
    long_prompt = "лимит " * (MAX_REQUEST_TOKENS * 2)
    row = ask(long_prompt)
    return {
        "name": f"maxRequestTokens провайдера {PROVIDER} — {MAX_REQUEST_TOKENS}",
        "value": str(MAX_REQUEST_TOKENS),
        "fired": row["status"] not in (200, None),
        "client_saw": f"{row['status']}, {row['reason']}",
        "prompt_chars": len(long_prompt),
    }


def limit_context(model: str, generate=client.generate) -> list[dict]:
    """Окно контекста: тот же длинный вход с заданным `num_ctx` и без него.

    Обрезка видна по `prompt_eval_count`: если он заметно меньше числа токенов
    входа, вход обрезан. Это та же проверка, что первый замер дня 29, но здесь
    она про ограничение сервиса, а не про настройку.
    """
    long_prompt = ("Перескажи этот текст одним предложением.\n\n"
                   + "ограничение частоты запросов. " * 1200)
    out = []
    for label, options in (("num_ctx задан (2048)", {"num_ctx": 2048, "num_predict": 32}),
                           ("num_ctx не задан", {"num_predict": 32})):
        client.unload(model)
        run = generate(model, long_prompt, options=options, think=False)
        loaded = client.ps()
        window = next((item.get("context_length") for item in loaded.get("models", [])
                       if item.get("name") == model), None)
        out.append({
            "name": f"окно контекста напрямую: {label}",
            "value": str(options.get("num_ctx", "умолчание")),
            "fired": None if run["error"] else True,
            "client_saw": f"prompt_eval_count {run['metrics']['prompt_eval_count']}, "
                          f"окно загрузки {window}, останов {run['done_reason']}",
            "prompt_chars": len(long_prompt),
            "context_length_loaded": window,
            "prompt_eval_count": run["metrics"]["prompt_eval_count"],
        })
    return out


def provider_reachable(ask=ask_day5) -> dict:
    """Доступен ли провайдер через прод — одна проба перед всеми остальными.

    Нужна потому, что при выключенном Tailscale все пробы через прод
    возвращают один и тот же отказ и не различают гипотез (память проекта:
    «проверка обязана различать гипотезы»).
    """
    row = ask("Одним словом: да.")
    return {"reachable": row["status"] == 200, **row}


def run(model: str, runner: str, commit: str, through_prod: bool,
        probe=None, generate=client.generate, ask=ask_day5) -> dict:
    access = {
        "how": "частная сеть Tailscale до ноутбука; Ollama слушает только адрес этой "
               "сети, а не все интерфейсы машины. Через прод — публичный API дня 5 "
               f"с явным выбором провайдера {PROVIDER}",
        "without": "посетитель без частной сети до локальной модели не доходит вовсе: "
                   "адрес ноутбука из интернета не отвечает, запрос идёт только "
                   "через публичный адрес сайта",
        "where_key": "ключ провайдера на сервере в .env и в GitHub Secrets; "
                     "у локальной модели ключа нет вовсе — её закрывает сеть",
    }
    concurrency = [parallel_direct(model, count, generate) for count in (1, 3)]
    limits = limit_context(model, generate)
    notes = [
        "Замер идёт на ноутбуке владельца, под обычной рабочей нагрузкой: числа "
        "воспроизводимы, но потолком железа не являются.",
        "Отказ на параллельных запросах — явный выбор конфигурации (ёмкость хоста 1), "
        "а не дефект сервиса.",
        "Тексты ответов на эту страницу не идут: только времена и коды.",
    ]
    if through_prod:
        if probe is None:
            probe = provider_reachable(ask)
        if probe["reachable"]:
            concurrency.append(parallel_day5(3, ask))
            limits = [limit_rate(ask), limit_request_size(ask), *limits]
        else:
            notes.append(
                "Пробы через прод не делались: провайдер недоступен "
                f"({probe['status']}, {probe['reason']}). При выключенной частной "
                "сети они дают один и тот же отказ и не различают гипотез."
            )
            limits = [
                {"name": f"запусков в минуту на адрес — {RATE_WINDOW}",
                 "value": str(RATE_WINDOW), "fired": None,
                 "client_saw": "не проверялся: провайдер недоступен"},
                {"name": f"maxRequestTokens провайдера {PROVIDER} — {MAX_REQUEST_TOKENS}",
                 "value": str(MAX_REQUEST_TOKENS), "fired": None,
                 "client_saw": "не проверялся: провайдер недоступен"},
                *limits,
            ]
    else:
        notes.append("Пробы через прод в этом прогоне не запускались (--direct-only).")

    return {
        **report.envelope(30, model, runner, commit, notes),
        "access": access,
        "provider_probe": probe,
        "concurrency": concurrency,
        "limits": limits,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="День 30: приватный сервис")
    parser.add_argument("--model", default=client.Q4)
    parser.add_argument("--out", default=str(prompts.ROOT / "site" / "day30" / "results.json"))
    parser.add_argument("--commit", default="unknown")
    parser.add_argument("--direct-only", action="store_true",
                        help="только пробы напрямую в локальную Ollama, прод не трогать")
    parser.add_argument("--dry-run", action="store_true",
                        help="ничего не отправлять: напечатать, что прогон сделал бы")
    args = parser.parse_args(argv)

    if args.dry_run:
        print("прямые пробы: 1 и 3 одновременных запроса, окно контекста заданное и нет")
        print(f"через прод: доступность, 3 одновременных, {RATE_WINDOW + 1} запрос в минуту, "
              f"запрос выше {MAX_REQUEST_TOKENS} токенов")
        print(f"слотов дня 5 будет занято около {RATE_WINDOW + 1 + 3 + 2} из 50 суточных; "
              "расход 0")
        return 0

    import day28_local_rag as day28

    payload = run(args.model, day28.runner_version(), args.commit,
                  through_prod=not args.direct_only)
    out = report.write_results(Path(args.out), payload)
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
