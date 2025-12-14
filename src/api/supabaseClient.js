import { createLogger, redactPayload } from "../utils/logger.js";

const logger = createLogger("SupabaseApi");
const DEFAULT_BATCH_MS = 5_000;
const MAX_BATCH_SIZE = 10;
const RATE_LIMIT_PER_MINUTE = 60;
const ERROR_WINDOW_MS = 60_000;
const MAX_ERRORS = 5;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

export class SupabaseClient {
  constructor({ url, anonKeyLoader }) {
    this.url = url;
    this.anonKeyLoader = anonKeyLoader;
    this.queue = [];
    this.timer = null;
    this.inFlight = 0;
    this.errorTimestamps = [];
    this.rateLimiter = [];
  }

  async getHeaders() {
    const token = (await this.anonKeyLoader?.()) || "";
    if (!token) logger.warn("No Supabase token provided");
    return {
      apikey: token || "",
      Authorization: token ? `Bearer ${token}` : "",
      "Content-Type": "application/json",
    };
  }

  throttle() {
    const now = Date.now();
    this.rateLimiter = this.rateLimiter.filter((t) => now - t < 60_000);
    if (this.rateLimiter.length >= RATE_LIMIT_PER_MINUTE) return false;
    this.rateLimiter.push(now);
    return true;
  }

  recordError() {
    const now = Date.now();
    this.errorTimestamps.push(now);
    this.errorTimestamps = this.errorTimestamps.filter((t) => now - t < ERROR_WINDOW_MS);
    if (this.errorTimestamps.length >= MAX_ERRORS) {
      logger.warn("Circuit breaker open - too many errors");
      return true;
    }
    return false;
  }

  enqueue({ path, payload }) {
    const key = payload?.profileId || payload?.url;
    if (key && this.queue.some((item) => item.key === key)) return;
    this.queue.push({ path, payload, key });
    if (this.queue.length >= MAX_BATCH_SIZE) {
      this.flush();
    } else {
      this.schedule();
    }
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), DEFAULT_BATCH_MS);
  }

  async flush() {
    if (this.inFlight || !this.queue.length) return;
    if (this.recordError()) return;
    if (!this.throttle()) {
      logger.warn("Rate limit reached, delaying batch");
      this.schedule();
      return;
    }

    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    clearTimeout(this.timer);
    this.timer = null;
    this.inFlight = 1;

    try {
      await this.sendBatch(batch.map((b) => b.payload));
    } catch (e) {
      logger.error("Batch failed", e?.message || e);
      this.recordError();
      batch.forEach((item, idx) => this.retry(item, idx));
    } finally {
      this.inFlight = 0;
    }
  }

  async retry(item, attempt) {
    if (attempt > 3) return;
    const delay = backoffDelay(attempt);
    await wait(delay);
    this.enqueue(item);
  }

  async sendBatch(payload) {
    const headers = await this.getHeaders();
    const body = JSON.stringify(payload.map((p) => this.validate(p)));
    const res = await fetch(`${this.url}/rest/v1/rpc/ingest_profiles`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      const status = res.status;
      if ([429, 503].includes(status)) throw new Error(`Retryable ${status}`);
      throw new Error(text || `HTTP ${status}`);
    }
    logger.info("Batch sent", { size: payload.length });
  }

  validate(payload) {
    const sanitized = { ...payload };
    const allowed = ["profileId", "url", "fullName", "headline", "location", "summary"];
    for (const key of Object.keys(sanitized)) {
      if (!allowed.includes(key)) delete sanitized[key];
      if (typeof sanitized[key] === "string") sanitized[key] = sanitized[key].slice(0, 5000);
    }
    return sanitized;
  }
}

export async function loadStoredToken() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
      return new Promise((resolve) => {
        chrome.storage.local.get("focals_supabase_token", (res) => resolve(res?.focals_supabase_token || ""));
      });
    }
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("focals_supabase_token") || "";
    }
  } catch (e) {
    logger.warn("Token read failed", redactPayload(e?.message || e));
  }
  return "";
}

export default SupabaseClient;
