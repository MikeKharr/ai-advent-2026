"""Два окна на адрес и суточный потолок вызовов эмбеддинга.

Форма окон — копия `mcp/src/limits.js` (ADR 2026-09-29-2139, п. 5): минута,
час, отдельный счётчик отказов по ключу с одной строкой в журнал за окно.
Проверка и учёт — один шаг под одним замком, без уступки потока между ними:
раздельные «проверить» и «посчитать» пропускали бы залп параллельных
запросов мимо предела, а `ThreadingHTTPServer` даёт по потоку на соединение.

Звать ДО исполнения `tools/call`, а не после (I-4 по духу: проверка
предшествует расходу).

Адрес в журнал не уходит — только число (I-10). Журнал контейнера
(`json-file`, 10 МБ × 3) переживает часовое окно, и адрес в нём хранился бы
дольше окна. Сигнал отвечает «перебирают ли», а не «кто»; связка «кто»
живёт только в памяти процесса и не дольше часа.

Суточный потолок — третья защита и единственная из трёх, живущая не в
памяти, а в томе (`/data/usage.json`). Причина именно в томе: контейнер
`rag` перезапускается на каждом мерже документа (ADR 2026-09-29-1639, п. 3),
и счётчик в памяти обнулялся бы ровно в те дни, когда вокруг больше всего
работы. В файле — дата и число, БЕЗ адреса: файл переживает и сутки, и
перезапуск, то есть хранил бы адрес дольше любого окна.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

MINUTE = 60.0
HOUR = 3600.0

RATE_LIMIT_PER_MIN = int(os.environ.get("RAG_RATE_LIMIT_PER_MIN", "10"))
RATE_LIMIT_PER_HOUR = int(os.environ.get("RAG_RATE_LIMIT_PER_HOUR", "100"))
REFUSAL_SIGNAL_PER_HOUR = int(os.environ.get("RAG_REFUSAL_SIGNAL_PER_HOUR", "20"))

# Сколько вызовов эмбеддинга запроса служба делает за сутки UTC.
#
# ЧИСЛО НЕ ИЗМЕРЕНО. Сколько стоит один эмбеддинг запроса на одном ядре VPS —
# не мерено ни разу (ADR 2026-09-29-2139, «Что проверено лично и что нет»),
# и 500 взято как начальное, а не посчитано. Что его поправит: первые сутки
# работы. Смотреть на `project.status` → `daily.used` в конце суток UTC и на
# время ответа `project.search`, пока идёт сборка. Упёрлись в потолок, а
# машина не страдала — число мало. Машина страдала задолго до потолка —
# число велико, и тогда его правит не потолок, а мера времени ответа.
DAILY_EMBEDS = int(os.environ.get("RAG_DAILY_EMBEDS", "500"))

USAGE_FILE = Path(os.environ.get("RAG_INDEX", "/data")) / "usage.json"


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class DailyCap:
    """Суточный потолок вызовов эмбеддинга. Дата и число в томе.

    Нечитаемый файл читается как ноль и переписывается заново. Выбор
    осознанный и назван в ADR (п. 4): этот потолок стережёт ядро общей
    машины, а не деньги, и остановить поиск из-за битого JSON дороже, чем
    пропустить один день учёта. О потере учёта в журнал уходит строка.
    """

    def __init__(self, path: Path = USAGE_FILE, limit: int = DAILY_EMBEDS, today=_today, log=lambda _e: None) -> None:
        self.path = Path(path)
        self.limit = limit
        self._today = today
        self._log = log
        self._lock = threading.Lock()

    def _read(self) -> tuple[str, int]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            date, count = raw["date"], raw["count"]
            if not isinstance(date, str) or not isinstance(count, int) or count < 0:
                raise ValueError("не та форма")
            return date, count
        except FileNotFoundError:
            # Первый запуск и первый день после создания тома — не поломка.
            return self._today(), 0
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            self._log({"event": "usage_unreadable"})
            return self._today(), 0

    def _write(self, date: str, count: int) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"date": date, "count": count}), encoding="utf-8")
        except OSError:
            # Том только для чтения или кончилось место: поиск из-за этого не
            # останавливаем, но и молчать нельзя — иначе учёт исчезает без следа.
            self._log({"event": "usage_unwritable"})

    def take(self, count: int = 1) -> tuple[bool, int]:
        """Занять `count` вызовов. Возвращает `(разрешено, остаток после)`.

        Занимает ДО вызова эмбеддера: иначе потолок значил бы «столько плюс
        всё, что успело начаться».
        """
        with self._lock:
            today = self._today()
            date, used = self._read()
            if date != today:
                date, used = today, 0
            if used + count > self.limit:
                return False, max(self.limit - used, 0)
            used += count
            self._write(date, used)
            return True, self.limit - used

    def state(self) -> dict:
        """Для `project.status`. Ничего не занимает и ничего не пишет."""
        with self._lock:
            date, used = self._read()
            if date != self._today():
                used = 0
            return {"limit": self.limit, "used": used, "remaining": max(self.limit - used, 0)}


class Limiter:
    """Окна на адрес: минута и час на вызовы инструментов, плюс отказы по ключу."""

    def __init__(self, now=None, per_min: int = RATE_LIMIT_PER_MIN, per_hour: int = RATE_LIMIT_PER_HOUR,
                 refusal_signal: int = REFUSAL_SIGNAL_PER_HOUR) -> None:
        self._now = now or time.monotonic
        self.per_min = per_min
        self.per_hour = per_hour
        self.refusal_signal = refusal_signal
        self._hits: dict[str, list[float]] = {}
        self._refusals: dict[str, list[float]] = {}
        self._swept_at = float("-inf")
        self._lock = threading.Lock()

    def _sweep_ip(self, table: dict, ip: str, t: float) -> list[float]:
        """Уборка одного адреса: отметки лежат по возрастанию, режем голову."""
        times = table.get(ip)
        if not times:
            return []
        stale = 0
        while stale < len(times) and t - times[stale] >= HOUR:
            stale += 1
        if stale:
            del times[:stale]
        if not times:
            table.pop(ip, None)
            return []
        return times

    def _sweep_all(self, t: float) -> None:
        """Полный обход обеих карт — он и удаляет замолчавшие адреса.

        Цена линейна по числу адресов, поэтому не чаще раза в минуту: на
        публичном пути работа, растущая с числом гостей, — ровно тот дефект,
        из-за которого в `mcp/src/limits.js` появилась эта же развязка.
        Плата названа: отметки замолчавшего адреса живут до часа плюс минута.
        """
        if t - self._swept_at < MINUTE:
            return
        self._swept_at = t
        for table in (self._hits, self._refusals):
            for ip in list(table.keys()):
                self._sweep_ip(table, ip, t)

    def reserve(self, ip: str, count: int = 1) -> tuple[bool, str, str]:
        """Занять `count` вызовов инструментов. Либо все, либо ни одного.

        Возвращает `(разрешено, причина, слова для посетителя)`.
        """
        need = count if isinstance(count, int) and count > 0 else 1
        with self._lock:
            t = self._now()
            self._sweep_all(t)
            times = self._sweep_ip(self._hits, ip, t)
            if len([x for x in times if t - x < MINUTE]) + need > self.per_min:
                return False, "minute", "Слишком часто. Подождите минуту."
            if len(times) + need > self.per_hour:
                return False, "hour", "Слишком много вызовов за час. Попробуйте позже."
            times.extend([t] * need)
            self._hits[ip] = times
            return True, "", ""

    def note_refusal(self, ip: str) -> tuple[int, bool]:
        """Отметить отказ по ключу. На ответ не влияет — влияет на журнал.

        Ключ сверяется ВСЕГДА, и годный обслуживается всегда: блокировать по
        этому счётчику нельзя, у перебирающего годного ключа нет, и запрет
        достался бы только тем, у кого он есть (снято у службы дня 16
        2026-09-23, см. `mcp/src/limits.js`).

        Дальше порога отметки НЕ копятся: вопрос «набралось ли столько за
        час» уже отвечен, а каждая лишняя отметка — память и работа, которых
        поток отказов может попросить сколько угодно.
        """
        with self._lock:
            t = self._now()
            self._sweep_all(t)
            times = self._sweep_ip(self._refusals, ip, t)
            if len(times) >= self.refusal_signal:
                return len(times), False
            times.append(t)
            self._refusals[ip] = times
            return len(times), len(times) == self.refusal_signal

    def stats(self) -> dict:
        with self._lock:
            return {
                "trackedIps": len(self._hits),
                "refusedIps": len(self._refusals),
                "refusalMarks": sum(len(v) for v in self._refusals.values()),
                "perMinute": self.per_min,
                "perHour": self.per_hour,
                "refusalSignalPerHour": self.refusal_signal,
            }
