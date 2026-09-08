// Конфигурация роутера — данные, а не код (ADR 2026-09-08-1748, п. 3).
// Битая конфигурация падает здесь, на старте, а не в рантайме.

export const TIERS = ["self-hosted", "cloud-cheap", "cloud-frontier"];
export const LEVELS = ["none", "low", "medium", "high"];
export const PROFILES = ["laptop", "server", "cloud"];
export const KINDS = ["anthropic", "ollama"];

/** Умолчания профилей для вывода дедлайна («Таймауты» ADR). */
export const PROFILE_DEFAULTS = {
  laptop: {
    loadMs: 20_000,
    promptEvalTps: 200,
    genTpsFloor: 6.4,
    margin: 1.25,
    minMs: 0,
  },
  server: {
    loadMs: 0,
    promptEvalTps: 500,
    genTpsFloor: 25,
    margin: 1.25,
    minMs: 0,
  },
  cloud: {
    loadMs: 0,
    promptEvalTps: 2000,
    genTpsFloor: 40,
    margin: 1.25,
    minMs: 60_000,
  },
};

/** Бюджет токенов размышлений по уровню — из замеров с запасом. */
export const THINKING_TOKENS = { none: 0, low: 1500, medium: 2500, high: 5000 };

export class ConfigError extends Error {}

function fail(msg) {
  throw new ConfigError(`конфигурация роутера: ${msg}`);
}

function requireString(obj, field, where) {
  if (typeof obj[field] !== "string" || obj[field].length === 0)
    fail(`${where}: поле ${field} должно быть непустой строкой`);
}

export function validateProviders(providers, env) {
  if (!Array.isArray(providers) || providers.length === 0)
    fail("providers: ожидается непустой массив");
  const ids = new Set();
  const hostCapacity = new Map();
  for (const p of providers) {
    const where = `провайдер ${p?.id ?? "?"}`;
    for (const f of [
      "id",
      "kind",
      "tier",
      "baseUrl",
      "model",
      "profile",
      "jurisdiction",
    ])
      requireString(p, f, where);
    if (ids.has(p.id)) fail(`${where}: id повторяется`);
    ids.add(p.id);
    if (!KINDS.includes(p.kind)) fail(`${where}: неизвестный kind ${p.kind}`);
    if (!TIERS.includes(p.tier)) fail(`${where}: неизвестный tier ${p.tier}`);
    if (!PROFILES.includes(p.profile))
      fail(`${where}: неизвестный profile ${p.profile}`);
    try {
      new URL(p.baseUrl);
    } catch {
      fail(`${where}: baseUrl не разбирается`);
    }
    if (!Number.isInteger(p.maxConcurrency) || p.maxConcurrency < 1)
      fail(`${where}: maxConcurrency должен быть целым ≥ 1`);
    if (!Array.isArray(p.capabilities)) fail(`${where}: capabilities — массив`);
    if (!Array.isArray(p.dataClasses) || p.dataClasses.length === 0)
      fail(`${where}: dataClasses — непустой массив`);
    if (!Number.isInteger(p.contextWindow) || p.contextWindow < 1)
      fail(`${where}: contextWindow — целое ≥ 1`);
    if (
      !p.thinking ||
      typeof p.thinking !== "object" ||
      p.thinking.none !== true
    )
      fail(`${where}: thinking должен поддерживать уровень none`);
    if (!Number.isInteger(p.revision ?? 1)) fail(`${where}: revision — целое`);
    if (p.secretEnv && !env[p.secretEnv])
      fail(`${where}: переменная секрета ${p.secretEnv} не задана`);
    const host = p.hostId ?? new URL(p.baseUrl).host;
    if (hostCapacity.has(host) && hostCapacity.get(host) !== p.maxConcurrency)
      fail(
        `${where}: у хоста ${host} уже другая ёмкость (${hostCapacity.get(host)})`,
      );
    hostCapacity.set(host, p.maxConcurrency);
  }
}

export function validateClasses(classes, providers) {
  if (!classes || typeof classes !== "object")
    fail("classes: ожидается объект");
  if (!classes.other)
    fail("classes: класс other обязателен — он ловит неизвестные классы");
  for (const [name, c] of Object.entries(classes)) {
    const where = `класс ${name}`;
    if (!Array.isArray(c.tiers) || c.tiers.length === 0)
      fail(`${where}: tiers — непустой массив`);
    for (const t of c.tiers)
      if (!TIERS.includes(t)) fail(`${where}: неизвестный tier ${t}`);
    for (const t of c.deny ?? [])
      if (!TIERS.includes(t)) fail(`${where}: неизвестный tier в deny ${t}`);
    if (!LEVELS.includes(c.thinking))
      fail(`${where}: thinking должен быть одним из ${LEVELS.join("|")}`);
    if (!Number.isInteger(c.answerTokens) || c.answerTokens < 1)
      fail(`${where}: answerTokens — целое ≥ 1`);
    requireString(c, "dataClass", where);
    // Статическая проверка возможности: класс без единого способного кандидата —
    // ошибка старта, а не отказ в рантайме.
    const candidates = orderedCandidates(c, providers);
    const capable = candidates.filter(
      (p) => capabilityFit(p, c, c.thinking, c.dataClass, 0).ok,
    );
    if (capable.length === 0)
      fail(
        `${where}: ни один провайдер не удовлетворяет требованиям (ярусы, возможности, данные)`,
      );
  }
}

export function validateApps(appsConfig, env, classes) {
  if (!appsConfig || typeof appsConfig !== "object")
    fail("apps: ожидается объект");
  if (!appsConfig.admin?.secretEnv || !env[appsConfig.admin.secretEnv])
    fail("apps: admin.secretEnv не задан или переменная пуста");
  if (!Array.isArray(appsConfig.apps)) fail("apps: apps — массив");
  const ids = new Set();
  for (const a of appsConfig.apps) {
    const where = `приложение ${a?.id ?? "?"}`;
    requireString(a, "id", where);
    requireString(a, "secretEnv", where);
    if (ids.has(a.id)) fail(`${where}: id повторяется`);
    ids.add(a.id);
    if (!env[a.secretEnv])
      fail(`${where}: переменная ключа ${a.secretEnv} не задана`);
    if (!Array.isArray(a.classes) || a.classes.length === 0)
      fail(`${where}: classes — непустой массив`);
    for (const c of a.classes)
      if (!classes[c]) fail(`${where}: неизвестный класс ${c}`);
    const l = a.limits;
    // «Без лимита» не бывает: лимит выставляется на каждое приложение отдельно.
    const hasTokens = Number.isInteger(l?.dailyTokens) && l.dailyTokens > 0;
    const hasCost = typeof l?.dailyCostUsd === "number" && l.dailyCostUsd > 0;
    if (!hasTokens && !hasCost)
      fail(`${where}: нужен хотя бы один лимит — dailyTokens или dailyCostUsd`);
  }
}

/** Кандидаты класса в порядке политики: ярусы по порядку, внутри — порядок объявления. */
export function orderedCandidates(cls, providers) {
  const deny = new Set(cls.deny ?? []);
  const out = [];
  for (const tier of cls.tiers) {
    if (deny.has(tier)) continue;
    for (const p of providers) if (p.tier === tier) out.push(p);
  }
  return out;
}

/** Фильтр возможностей: статичен, несоответствие — отказ, не понижение. */
export function capabilityFit(
  p,
  cls,
  level,
  dataClass,
  inputTokens,
  extraRequires = [],
) {
  const required = [...(cls.requires ?? []), ...extraRequires];
  for (const cap of required)
    if (!p.capabilities.includes(cap))
      return { ok: false, reason: `нет возможности ${cap}` };
  if (level !== "none" && p.thinking[level] === undefined)
    return {
      ok: false,
      reason: `уровень размышлений ${level} не поддерживается`,
    };
  if (!p.dataClasses.includes(dataClass))
    return { ok: false, reason: `класс данных ${dataClass} не допускается` };
  if (cls.jurisdictions && !cls.jurisdictions.includes(p.jurisdiction))
    return {
      ok: false,
      reason: `юрисдикция ${p.jurisdiction} вне допустимых ${cls.jurisdictions.join(",")}`,
    };
  if (inputTokens > p.contextWindow)
    return {
      ok: false,
      reason: `вход ${inputTokens} токенов больше окна ${p.contextWindow}`,
    };
  return { ok: true };
}

export function loadConfig({ providers, classes, apps, env = process.env }) {
  validateProviders(providers, env);
  validateClasses(classes, providers);
  if (apps) validateApps(apps, env, classes);
  return { providers, classes, apps: apps ?? null };
}
