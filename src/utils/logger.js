const LEVELS = ["debug", "info", "warn", "error"];
const DEFAULT_LEVEL = "info";
const DEBUG_FLAG_KEY = "focals_debug";
const SAMPLE_TTL_MS = 10_000;

function sanitizeChunk(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length > 80) return `${text.slice(0, 40)}…${text.slice(-5)}`;
  return text;
}

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let sanitized = value.replace(/[A-Za-z0-9_-]{24,}/g, (m) => `${m.slice(0, 3)}…${m.slice(-3)}`);
    sanitized = sanitized.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => `${m.slice(0, 2)}***@***${m.slice(-2)}`);
    sanitized = sanitized.replace(/\b\d{6,}\b/g, (m) => `${m.slice(0, 2)}…${m.slice(-2)}`);
    return sanitized;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
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
}

class Logger {
  constructor(scope = "Focals") {
    this.scope = scope;
    this.sampleCache = new Map();
    this.level = DEFAULT_LEVEL;
    this.refreshLevel();
  }

  refreshLevel() {
    try {
      const raw =
        (typeof localStorage !== "undefined" && localStorage.getItem(DEBUG_FLAG_KEY)) ||
        (typeof chrome !== "undefined" && chrome?.storage?.local?.get);
      if (raw === "true") this.level = "debug";
    } catch (_) {
      /* ignore */
    }
  }

  shouldLog(level) {
    const idx = LEVELS.indexOf(level);
    const current = LEVELS.indexOf(this.level);
    return idx >= current;
  }

  sampled(key) {
    const now = Date.now();
    const last = this.sampleCache.get(key) || 0;
    if (now - last < SAMPLE_TTL_MS) return true;
    this.sampleCache.set(key, now);
    return false;
  }

  emit(level, ...args) {
    if (!this.shouldLog(level)) return;
    const payload = args.map((a) => redact(a)).map(sanitizeChunk);
    const key = `${level}:${payload.join("|")}`;
    if (level !== "error" && this.sampled(key)) return;

    const fn = console[level] || console.log;
    fn.call(console, `[${this.scope}]`, ...payload);
  }

  debug(...args) {
    this.emit("debug", ...args);
  }

  info(...args) {
    this.emit("info", ...args);
  }

  warn(...args) {
    this.emit("warn", ...args);
  }

  error(...args) {
    this.emit("error", ...args);
  }
}

export const createLogger = (scope) => new Logger(scope);
export const redactPayload = redact;
export default Logger;
