import unittest

import chunking


class FixedTest(unittest.TestCase):
    def test_окно_не_длиннее_1500_знаков(self):
        text = "\n\n".join("абзац " + "я" * 300 for _ in range(30))
        chunks = chunking.chunk_fixed("a.md", text)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c.text), chunking.WINDOW)

    def test_граница_идёт_по_концу_абзаца(self):
        text = "\n\n".join(["П" * 300] * 12)
        chunks = chunking.chunk_fixed("a.md", text)
        self.assertGreater(len(chunks), 2)
        # Правый край чанка — конец абзаца (левый сдвинут перекрытием).
        for c in chunks:
            self.assertEqual(len(c.text.split("\n\n")[-1]), 300, c.text[-80:])

    def test_без_границы_в_пределах_отступа_режется_жёстко(self):
        # Абзац длиннее LOOKBACK: конца абзаца рядом с краем окна нет, и
        # окно закрывается по краю. Это поведение, а не дефект.
        text = "\n\n".join(["П" * 700] * 6)
        chunks = chunking.chunk_fixed("a.md", text)
        self.assertTrue(any(len(c.text) == chunking.WINDOW for c in chunks))

    def test_граница_по_концу_строки_когда_абзаца_рядом_нет(self):
        text = "".join("С" * 120 + "\n" for _ in range(40))
        for c in chunking.chunk_fixed("a.md", text):
            self.assertTrue(all(len(l) == 120 for l in c.text.splitlines()[1:]))

    def test_перекрытие_200_знаков(self):
        text = "".join(f"строка {i:04d} " + "ц" * 60 + "\n" for i in range(120))
        chunks = chunking.chunk_fixed("a.md", text)
        self.assertGreater(len(chunks), 2)
        tail = chunks[0].text[-chunking.OVERLAP :]
        self.assertIn(tail.strip().splitlines()[-1], chunks[1].text)

    def test_заголовки_не_учитываются(self):
        text = "# Заголовок\n\nтело\n\n## Раздел\n\nещё\n"
        chunks = chunking.chunk_fixed("a.md", text)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].section, "")
        self.assertEqual(chunks[0].embed_text, chunks[0].text)
        self.assertIn("## Раздел", chunks[0].text)

    def test_нарезка_конечна_на_тексте_без_переводов_строк(self):
        chunks = chunking.chunk_fixed("a.md", "ю" * 5000)
        self.assertEqual(len(chunks), 4)

    def test_chunk_id_нумеруется_подряд(self):
        chunks = chunking.chunk_fixed("dir/a.md", "ю" * 5000)
        self.assertEqual([c.chunk_id for c in chunks], [f"dir/a.md#{i}" for i in range(4)])


class StructuralTest(unittest.TestCase):
    def test_чанк_на_заголовок_с_цепочкой(self):
        text = "# Док\n\nвступление\n\n## Решение\n\nтело\n\n### Пункт 5\n\nдеталь\n"
        chunks = chunking.chunk_structural("a.md", text)
        self.assertEqual([c.section for c in chunks], ["Док", "Док › Решение", "Док › Решение › Пункт 5"])

    def test_цепочка_уходит_в_эмбеддинг_а_в_тексте_её_нет(self):
        text = "# Док\n\n## Решение\n\nтело\n"
        chunk = chunking.chunk_structural("a.md", text)[0]
        self.assertEqual(chunk.text, "тело")
        self.assertEqual(chunk.embed_text, "Док › Док › Решение\n\nтело")

    def test_заголовок_того_же_уровня_сбрасывает_хвост_цепочки(self):
        text = "# Док\n\n## А\n\nа\n\n### А1\n\nа1\n\n## Б\n\nб\n"
        sections = [c.section for c in chunking.chunk_structural("a.md", text)]
        self.assertEqual(sections[-1], "Док › Б")

    def test_длинный_раздел_режется_по_абзацам_с_той_же_цепочкой(self):
        body = "\n\n".join("Ю" * 500 for _ in range(10))
        chunks = chunking.chunk_structural("a.md", f"# Док\n\n## Р\n\n{body}\n")
        self.assertGreater(len(chunks), 1)
        self.assertEqual({c.section for c in chunks}, {"Док › Р"})
        for c in chunks:
            self.assertLessEqual(len(c.text), chunking.SECTION_LIMIT)

    def test_код_короче_3000_знаков_идёт_файлом_целиком(self):
        code = "const a = 1\n\nfunction b() {\n  return a\n}\n"
        chunks = chunking.chunk_structural("src/a.js", code)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].section, "a.js")
        self.assertEqual(chunks[0].text, code.strip())

    def test_длинный_код_режется_по_пустым_строкам_верхнего_уровня(self):
        block = "function f{i}() {{\n  const x = '{pad}'\n  return x\n}}"
        code = "\n\n".join(block.format(i=i, pad="п" * 400) for i in range(10))
        chunks = chunking.chunk_structural("src/a.js", code)
        self.assertGreater(len(chunks), 1)
        # Ни одна функция не разорвана: число `function` равно числу `}` в конце.
        for c in chunks:
            self.assertEqual(c.text.count("function f"), c.text.count("\n}"))

    def test_пустая_строка_с_отступом_не_граница(self):
        code = "function f() {\n  const a = 1\n\n  const b = 2\n}\n" + "\n" + "const c = 3\n"
        parts = chunking._split_top_level(code, 20)
        self.assertEqual(len(parts), 2)
        self.assertIn("const b = 2", parts[0])


class MetaTest(unittest.TestCase):
    def test_sha256_различает_стратегии(self):
        text = "# Док\n\nтело\n"
        a = chunking.chunk_fixed("a.md", text)[0]
        b = chunking.chunk_structural("a.md", text)[0]
        self.assertNotEqual(a.sha256, b.sha256)

    def test_sha256_меняется_вместе_с_текстом(self):
        a = chunking.chunk_fixed("a.md", "тело")[0]
        b = chunking.chunk_fixed("a.md", "тело.")[0]
        self.assertNotEqual(a.sha256, b.sha256)

    def test_title_из_h1_иначе_имя_файла(self):
        self.assertEqual(chunking.doc_title("d/a.md", "# Мой док\n\nx"), "Мой док")
        self.assertEqual(chunking.doc_title("d/a.md", "текст без H1"), "a.md")
        self.assertEqual(chunking.doc_title("d/a.js", "# не заголовок"), "a.js")

    def test_метаданные_полные_у_обеих_стратегий(self):
        want = {"source", "title", "section", "chunk_id", "strategy", "sha256", "commit", "text"}
        for cut in (chunking.chunk_fixed, chunking.chunk_structural):
            meta = cut("a.md", "# Док\n\nтело\n", commit="abc123")[0].as_meta()
            self.assertEqual(set(meta), want)
            self.assertEqual(meta["commit"], "abc123")


class CutsBlockTest(unittest.TestCase):
    def test_нечётное_число_оград_режет_блок_кода(self):
        c = chunking.Chunk("a.md", "t", "", "a.md#0", "fixed", "текст\n```js\nconst a = 1")
        self.assertTrue(chunking.cuts_block(c, None))

    def test_целый_блок_кода_не_считается_разрезанным(self):
        c = chunking.Chunk("a.md", "t", "", "a.md#0", "fixed", "```js\nconst a = 1\n```")
        self.assertFalse(chunking.cuts_block(c, None))

    def test_список_разъехавшийся_по_двум_чанкам(self):
        a = chunking.Chunk("a.md", "t", "", "a.md#0", "fixed", "- раз\n- два")
        b = chunking.Chunk("a.md", "t", "", "a.md#1", "fixed", "- три\n- четыре")
        self.assertTrue(chunking.cuts_block(a, b))

    def test_соседний_чанк_другого_файла_список_не_режет(self):
        a = chunking.Chunk("a.md", "t", "", "a.md#0", "fixed", "- раз")
        b = chunking.Chunk("b.md", "t", "", "b.md#0", "fixed", "- три")
        self.assertFalse(chunking.cuts_block(a, b))


if __name__ == "__main__":
    unittest.main()


class HardSplitTest(unittest.TestCase):
    def test_структурный_чанк_не_длиннее_3000_знаков(self):
        # Сплющенный JSON: ни пустых строк, ни абзацев — один блок.
        flat = "{" + ",".join(f'"k{i}":"{"з" * 50}"' for i in range(200)) + "}"
        chunks = chunking.chunk_structural("config/a.json", flat)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c.text), chunking.SECTION_LIMIT)

    def test_длинный_абзац_markdown_тоже_дорезается(self):
        chunks = chunking.chunk_structural("a.md", "# Док\n\n## Р\n\n" + "Ю" * 9000)
        self.assertGreater(len(chunks), 1)
        self.assertEqual({c.section for c in chunks}, {"Док › Р"})
        for c in chunks:
            self.assertLessEqual(len(c.text), chunking.SECTION_LIMIT)

    def test_дорезка_идёт_по_строкам_пока_можно(self):
        body = "\n".join("С" * 100 for _ in range(60))
        parts = chunking._hard_split(body, 1000)
        self.assertGreater(len(parts), 1)
        for part in parts:
            self.assertTrue(all(len(l) == 100 for l in part.splitlines()))
