const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
const LOG_LEVEL_RANK: Record<(typeof LOG_LEVELS)[number], number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export const DEFAULT_LOG_LEVEL = "INFO";
export const LOG_LEVEL_STORAGE_KEY = "focals_log_level";
const DEDUPE_WINDOW_MS = 2000;
const MAX_MESSAGE_LENGTH = 200;

type LogLevel = keyof typeof LOG_LEVEL_RANK;

const recentMessages = new Map<string, number>();
let currentLevel: LogLevel = DEFAULT_LOG_LEVEL.toLowerCase() as LogLevel;

const normalizeLevel = (value: unknown): LogLevel | null => {
  if (!value) return null;
  const normalized = String(value).toLowerCase() as LogLevel;
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_RANK, normalized) ? normalized : null;
};

const redact = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let sanitized = value.replace(/[A-Za-z0-9_-]{24,}/g, (m) => `${m.slice(0, 3)}…${m.slice(-3)}`);
    sanitized = sanitized.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, (m) => `${m.slice(0, 2)}***@***${m.slice(-2)}`);
    sanitized = sanitized.replace(/\b\d{6,}\b/g, (m) => `${m.slice(0, 2)}…${m.slice(-2)}`);
    return sanitized;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|cookie|secret|email|auth/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
};

const formatChunk = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > MAX_MESSAGE_LENGTH) {
      return `${value.slice(0, 120)}…${value.slice(-20)}`;
    }
    return value;
  }
  return value;
};

const shouldLog = (level: LogLevel): boolean => {
  const rank = LOG_LEVEL_RANK[level];
  const currentRank = LOG_LEVEL_RANK[currentLevel];
  return rank <= currentRank;
};

const dedupeKey = (level: LogLevel, scope: string, chunks: unknown[]): string => {
  const base = chunks
    .map((chunk) => {
      try {
        return typeof chunk === "string" ? chunk : JSON.stringify(chunk);
      } catch {
        return String(chunk);
      }
    })
    .join("|");
  return `${level}:${scope}:${base}`;
};

const shouldDedupe = (key: string): boolean => {
  const now = Date.now();
  const last = recentMessages.get(key) || 0;
  if (now - last < DEDUPE_WINDOW_MS) return true;
  recentMessages.set(key, now);
  return false;
};

const emit = (level: LogLevel, scope: string | undefined, args: unknown[]) => {
  if (!shouldLog(level)) return;
  const normalizedScope = scope ? String(scope).toUpperCase() : "APP";
  const payload = args.map(redact).map(formatChunk);
  const key = dedupeKey(level, normalizedScope, payload);
  if (level !== "error" && shouldDedupe(key)) return;
  const fn = console[level] || console.log;
  fn.call(console, `[FOCALS][${normalizedScope}]`, ...payload);
};

const setLogLevel = (level: unknown) => {
  const normalized = normalizeLevel(level);
  if (!normalized) return;
  currentLevel = normalized;
};

const refreshLogLevel = () => {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
      chrome.storage.local.get([LOG_LEVEL_STORAGE_KEY], (result) => {
        if (chrome.runtime?.lastError) return;
        const storedLevel = normalizeLevel(result?.[LOG_LEVEL_STORAGE_KEY]);
        if (storedLevel) {
          setLogLevel(storedLevel);
        }
      });
    }
  } catch {
    // ignore storage failures
  }
};

const attachStorageListener = () => {
  try {
    if (typeof chrome === "undefined" || !chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes?.[LOG_LEVEL_STORAGE_KEY]) return;
      const nextLevel = normalizeLevel(changes[LOG_LEVEL_STORAGE_KEY].newValue);
      if (nextLevel) setLogLevel(nextLevel);
    });
  } catch {
    // ignore storage failures
  }
};

refreshLogLevel();
attachStorageListener();

export const logger = {
  debug: (scope: string, ...args: unknown[]) => emit("debug", scope, args),
  info: (scope: string, ...args: unknown[]) => emit("info", scope, args),
  warn: (scope: string, ...args: unknown[]) => emit("warn", scope, args),
  error: (scope: string, ...args: unknown[]) => emit("error", scope, args),
  table: (scope: string, rows: unknown[]) => {
    if (!shouldLog("debug")) return;
    const normalizedScope = scope ? String(scope).toUpperCase() : "APP";
    console.groupCollapsed(`[FOCALS][${normalizedScope}] table`);
    console.table(rows);
    console.groupEnd();
  },
  groupCollapsed: (scope: string, label: string, level: LogLevel = "info") => {
    const normalizedScope = scope ? String(scope).toUpperCase() : "APP";
    if (!shouldLog(level)) return false;
    console.groupCollapsed(`[FOCALS][${normalizedScope}] ${label}`);
    return true;
  },
  groupEnd: () => {
    console.groupEnd();
  },
  setLevel: (level: unknown) => setLogLevel(level),
  getLevel: (): LogLevel => currentLevel,
  refresh: refreshLogLevel,
};

export const createLogger = (scope: string) => ({
  debug: (...args: unknown[]) => logger.debug(scope, ...args),
  info: (...args: unknown[]) => logger.info(scope, ...args),
  warn: (...args: unknown[]) => logger.warn(scope, ...args),
  error: (...args: unknown[]) => logger.error(scope, ...args),
  table: (rows: unknown[]) => logger.table(scope, rows),
  groupCollapsed: (label: string, level?: LogLevel) => logger.groupCollapsed(scope, label, level),
  groupEnd: () => logger.groupEnd(),
});

export const redactPayload = redact;

export default logger;
