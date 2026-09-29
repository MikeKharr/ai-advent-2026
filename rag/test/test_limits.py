"""Окна на адрес и суточный потолок вызовов эмбеддинга.

Образец — `mcp/test/limits.test.js`. Здесь дополнительно держится то, чего в
той единице нет вовсе: суточный потолок, живущий в томе и переживающий
перезапуск контейнера.
"""

import json
import tempfile
import threading
import unittest
from pathlib import Path

import limits


class Clock:
    """Часы, которыми управляет тест. Реальное время сюда не приходит."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def make_limiter(clock, per_min=3, per_hour=5, refusal_signal=2):
    return limits.Limiter(now=clock, per_min=per_min, per_hour=per_hour, refusal_signal=refusal_signal)


class WindowTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.limiter = make_limiter(self.clock)

    def test_минутное_окно_закрывается_на_превышении(self):
        for _ in range(3):
            self.assertTrue(self.limiter.reserve("1.1.1.1")[0])
        ok, reason, words = self.limiter.reserve("1.1.1.1")
        self.assertFalse(ok)
        self.assertEqual(reason, "minute")
        self.assertIn("минуту", words)

    def test_минутное_окно_открывается_через_минуту(self):
        for _ in range(3):
            self.limiter.reserve("1.1.1.1")
        self.clock.advance(61)
        self.assertTrue(self.limiter.reserve("1.1.1.1")[0])

    def test_часовое_окно_закрывается_поверх_минутного(self):
        # Пять за час при трёх в минуту: минутное окно каждый раз пустое,
        # упирается именно часовое. Иначе проверка ничего не различала бы.
        for i in range(5):
            self.clock.advance(61)
            self.assertTrue(self.limiter.reserve("1.1.1.1")[0], i)
        self.clock.advance(61)
        ok, reason, _ = self.limiter.reserve("1.1.1.1")
        self.assertFalse(ok)
        self.assertEqual(reason, "hour")

    def test_окна_у_каждого_адреса_свои(self):
        for _ in range(3):
            self.limiter.reserve("1.1.1.1")
        self.assertFalse(self.limiter.reserve("1.1.1.1")[0])
        self.assertTrue(self.limiter.reserve("2.2.2.2")[0], "чужое окно закрыло соседа")

    def test_пачка_занимает_все_слоты_или_ни_одного(self):
        self.assertTrue(self.limiter.reserve("1.1.1.1", 2)[0])
        # Остался один слот минуты, просят два — не должно пройти ни одного.
        self.assertFalse(self.limiter.reserve("1.1.1.1", 2)[0])
        self.assertTrue(self.limiter.reserve("1.1.1.1", 1)[0], "отказ пачки съел свободный слот")

    def test_замолчавший_адрес_убирается_из_памяти(self):
        # I-10: связка «кто» не живёт дольше часа.
        self.limiter.reserve("1.1.1.1")
        self.assertEqual(self.limiter.stats()["trackedIps"], 1)
        self.clock.advance(3601 + 61)
        self.limiter.reserve("2.2.2.2")
        self.assertEqual(self.limiter.stats()["trackedIps"], 1)

    def test_проверка_и_учёт_идут_под_одним_замком(self):
        """Второй запрос не входит в участок, пока в нём первый.

        `ThreadingHTTPServer` даёт по потоку на соединение, и раздельные
        «проверить» и «посчитать» пропускали бы залп мимо предела.

        Держится не залпом, а остановкой ВНУТРИ участка: залп из двадцати
        потоков ничего не различал бы — снятие `with self._lock` оставляло
        его зелёным, потому что переключение потока почти никогда не
        приходится на такой короткий участок (мутация М3, поймана и
        исправлена здесь). `_sweep_ip` зовётся уже за замком, поэтому
        заминка в нём — это заминка в критическом участке.
        """
        limiter = make_limiter(self.clock, per_min=1, per_hour=1)
        entered, release = threading.Event(), threading.Event()
        original, first = limiter._sweep_ip, []

        def hooked(table, ip, t):
            if not first:
                first.append(1)
                entered.set()
                release.wait(5)
            return original(table, ip, t)

        limiter._sweep_ip = hooked
        answers = []
        a = threading.Thread(target=lambda: answers.append(limiter.reserve("1.1.1.1")))
        a.start()
        self.assertTrue(entered.wait(5), "первый запрос не дошёл до критического участка")

        b = threading.Thread(target=lambda: answers.append(limiter.reserve("1.1.1.1")))
        b.start()
        b.join(0.5)
        self.assertTrue(b.is_alive(), "второй запрос вошёл в участок, пока в нём первый")

        release.set()
        a.join(5)
        b.join(5)
        self.assertEqual([ok for ok, _r, _w in answers], [True, False], "предел обойдён")


class RefusalTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.limiter = make_limiter(self.clock)

    def test_сигнал_один_за_окно_а_не_на_каждом_отказе(self):
        self.assertEqual(self.limiter.note_refusal("1.1.1.1"), (1, False))
        self.assertEqual(self.limiter.note_refusal("1.1.1.1"), (2, True))
        self.assertEqual(self.limiter.note_refusal("1.1.1.1"), (2, False))

    def test_отметки_дальше_порога_не_копятся(self):
        # Вето compliance по PR #220: хранить их значило бы цену одного
        # отказа, линейную по накопленному, то есть квадратичный поток на
        # публичном бесключевом пути.
        for _ in range(200):
            self.limiter.note_refusal("1.1.1.1")
        self.assertEqual(self.limiter.stats()["refusalMarks"], 2)

    def test_счётчик_отказов_ничего_не_запрещает(self):
        # У перебирающего годного ключа нет по определению; запрет достался
        # бы только тем, у кого он есть.
        for _ in range(50):
            self.limiter.note_refusal("1.1.1.1")
        self.assertTrue(self.limiter.reserve("1.1.1.1")[0])


class DailyCapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "usage.json"
        self.day = ["2026-09-30"]
        self.journal = []

    def cap(self, limit=3):
        return limits.DailyCap(self.path, limit=limit, today=lambda: self.day[0], log=self.journal.append)

    def test_потолок_закрывается_на_превышении(self):
        cap = self.cap()
        for _ in range(3):
            self.assertTrue(cap.take()[0])
        ok, remaining = cap.take()
        self.assertFalse(ok)
        self.assertEqual(remaining, 0)

    def test_счёт_переживает_перезапуск_контейнера(self):
        # Ради этого потолок и живёт в томе: контейнер перезапускается на
        # каждом мерже документа, и счётчик в памяти обнулялся бы ровно в те
        # дни, когда вокруг больше всего работы.
        self.cap().take(2)
        fresh = self.cap()  # другой объект — как после рестарта процесса
        self.assertEqual(fresh.state()["used"], 2)
        self.assertTrue(fresh.take()[0])
        self.assertFalse(fresh.take()[0])

    def test_новые_сутки_обнуляют_счёт(self):
        cap = self.cap()
        for _ in range(3):
            cap.take()
        self.assertFalse(cap.take()[0])
        self.day[0] = "2026-10-01"
        self.assertTrue(cap.take()[0])
        self.assertEqual(cap.state()["used"], 1)

    def test_битый_файл_читается_как_ноль_и_пишет_строку_в_журнал(self):
        # Осознанный fail-open, названный в ADR п. 4: потолок стережёт ядро
        # общей машины, а не деньги, и остановить поиск из-за битого JSON
        # дороже, чем пропустить один день учёта.
        self.path.write_text("{это не json", encoding="utf-8")
        cap = self.cap()
        self.assertTrue(cap.take()[0])
        self.assertEqual([e["event"] for e in self.journal], ["usage_unreadable"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {"date": "2026-09-30", "count": 1})

    def test_чужая_форма_файла_не_принимается_за_счёт(self):
        # Иначе отрицательное или строковое `count` открывало бы потолок.
        for raw in ('{"date": "2026-09-30", "count": -100}', '{"date": 1, "count": 1}', '{"count": 1}', "[]"):
            self.path.write_text(raw, encoding="utf-8")
            self.assertEqual(self.cap(limit=1).state()["used"], 0, raw)

    def test_в_файле_нет_адреса_и_быть_не_может(self):
        # I-10: файл переживает и сутки, и перезапуск, то есть хранил бы
        # адрес дольше любого окна.
        self.cap().take()
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(sorted(raw.keys()), ["count", "date"])

    def test_состояние_не_занимает_слотов(self):
        cap = self.cap()
        for _ in range(5):
            cap.state()
        self.assertEqual(cap.state()["used"], 0)
        self.assertEqual(cap.state()["remaining"], 3)


if __name__ == "__main__":
    unittest.main()
