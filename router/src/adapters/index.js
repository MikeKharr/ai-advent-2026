import * as anthropic from "./anthropic.js";
import * as ollama from "./ollama.js";

/** Адаптер по `kind` провайдера. Новый провайдер существующего kind — только конфигурация. */
export const ADAPTERS = { anthropic, ollama };
