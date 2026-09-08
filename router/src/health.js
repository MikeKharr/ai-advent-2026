// Здоровье провайдеров: отрицательный кэш, предохранитель, «занят до T»,
// ёмкость хоста (ADR 2026-09-08-1748, п. 4 и 7). Всё в памяти процесса
// роутера — он один на все приложения, поэтому счёт ведётся в одном месте.

const NEGATIVE_MS = 60_000;
const OPEN_MS = 60_000;
const FAILURES_TO_OPEN = 3;
const BUSY_DEFAULT_MS = 10_000;

export function createHealth({ now = Date.now } = {}) {
  /** @type {Map<string, {negativeUntil:number, failures:number, openUntil:number, probing:boolean, busyUntil:number}>} */
  const state = new Map();
  /** @type {Map<string, number>} inflight по хосту, не по записи. */
  const inflight = new Map();

  const key = (p) => `${p.id}#${p.revision}`;
  const host = (p) => p.hostId ?? new URL(p.baseUrl).host;
  const get = (p) => {
    const k = key(p);
    if (!state.has(k))
      state.set(k, {
        negativeUntil: 0,
        failures: 0,
        openUntil: 0,
        probing: false,
        busyUntil: 0,
      });
    return state.get(k);
  };

  return {
    /** Почему провайдер сейчас непригоден; null — пригоден. */
    unavailableReason(p) {
      const t = now();
      const s = get(p);
      if (s.negativeUntil > t)
        return `недоступен до ${new Date(s.negativeUntil).toISOString()} (отрицательный кэш)`;
      if (s.busyUntil > t)
        return `занят до ${new Date(s.busyUntil).toISOString()} (429)`;
      if (s.openUntil > t)
        return `предохранитель разомкнут до ${new Date(s.openUntil).toISOString()}`;
      if (s.openUntil !== 0 && s.probing)
        return "предохранитель полуоткрыт, проба уже идёт";
      if ((inflight.get(host(p)) ?? 0) >= p.maxConcurrency)
        return `ёмкость хоста ${host(p)} исчерпана`;
      return null;
    },

    /** Занять слот ёмкости и, если предохранитель полуоткрыт, отметить пробу. */
    acquire(p) {
      const s = get(p);
      const h = host(p);
      inflight.set(h, (inflight.get(h) ?? 0) + 1);
      if (s.openUntil !== 0 && s.openUntil <= now()) s.probing = true;
    },

    release(p) {
      const h = host(p);
      inflight.set(h, Math.max(0, (inflight.get(h) ?? 0) - 1));
    },

    /** Транспортная недоступность: отрицательный кэш, в предохранитель не идёт. */
    unreachable(p) {
      const s = get(p);
      s.negativeUntil = now() + NEGATIVE_MS;
      s.probing = false;
    },

    /** 429: занят до T, не поломка. */
    busy(p, retryAfterMs) {
      const s = get(p);
      s.busyUntil = now() + (retryAfterMs ?? BUSY_DEFAULT_MS);
      s.probing = false;
    },

    /** Прикладная неудача: считается в предохранитель. */
    failure(p) {
      const s = get(p);
      // Неудача пробы в полуоткрытом состоянии размыкает снова (ADR §7),
      // а не начинает новый отсчёт трёх неудач.
      const halfOpen = s.openUntil !== 0 && s.openUntil <= now();
      s.failures += 1;
      s.probing = false;
      if (halfOpen || s.failures >= FAILURES_TO_OPEN) {
        s.openUntil = now() + OPEN_MS;
        s.failures = 0;
      }
    },

    success(p) {
      const s = get(p);
      s.failures = 0;
      s.openUntil = 0;
      s.probing = false;
    },

    inflightOf(p) {
      return inflight.get(host(p)) ?? 0;
    },

    /** Для метрик и тестов. */
    snapshot(p) {
      return { ...get(p), inflight: inflight.get(host(p)) ?? 0 };
    },
  };
}
