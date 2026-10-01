// Тег у RAG_MODEL несущий: без него Ollama подставит `:latest`, и уже лежащие
// в томе веса другой квантизации сойдут за заказанную модель. Отказ при этом
// тихий — служба поднимется и будет считать векторы не той моделью.
//
// Держателя на эту строку не было: `compose-limits.mjs` сверяет только потолки,
// а в тестах единицы `RAG_MODEL` не упоминался нигде (находка compliance к #286).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

const COMPOSE = "deploy/compose.yml";
const строки = readFileSync(COMPOSE, "utf8").split("\n");
// Комментарий с подстрокой RAG_MODEL= перехватил бы проверку, поэтому
// берём строку переменной окружения, а не любую упоминающую.
const строка = строки.find((с) => /^\s*-\s*RAG_MODEL=/.test(с));

test("RAG_MODEL задан", () => {
  assert.ok(строка, `в ${COMPOSE} нет строки RAG_MODEL=`);
});

test("у RAG_MODEL есть тег", () => {
  const значение = строка.split("RAG_MODEL=")[1].trim();
  assert.ok(
    значение.includes(":"),
    `RAG_MODEL=${значение} без тега: Ollama подставит :latest, и веса другой ` +
      `квантизации из тома сойдут за эту модель — отказ тихий`,
  );
});

test("умолчание в коде тоже с тегом", () => {
  const код = readFileSync("rag/build.py", "utf8");
  const м = код.match(/RAG_MODEL",\s*"([^"]+)"/);
  assert.ok(м, "в rag/build.py нет умолчания RAG_MODEL");
  assert.ok(
    м[1].includes(":"),
    `умолчание ${м[1]} без тега — та же дыра, что и в compose`,
  );
});
