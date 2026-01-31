import BatchSupabaseClient, { loadStoredToken } from "./src/api/supabaseClient.js";
import { createLogger, redactPayload } from "./src/utils/logger.js";

const logger = createLogger("Supabase");
export const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
const SESSION_STORAGE_KEY = "focals_supabase_session";
const LOCALSTORAGE_SUPABASE_KEY = "sb-ppawceknsedxaejpeylu-auth-token";

const batchClient = new BatchSupabaseClient({
  url: SUPABASE_URL,
  anonKeyLoader: async () => {
    const stored = await loadStoredToken();
    return stored || "";
  },
});

function sanitizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    access_token: raw.access_token || raw.accessToken || "",
    refresh_token: raw.refresh_token || raw.refreshToken || "",
    user: raw.user || null,
  };
}

function readLocalStorageSession() {
  try {
    const raw =
      (typeof localStorage !== "undefined" &&
        (localStorage.getItem(SESSION_STORAGE_KEY) || localStorage.getItem(LOCALSTORAGE_SUPABASE_KEY))) ||
      null;
    return raw ? sanitizeSession(JSON.parse(raw)) : null;
  } catch (e) {
    logger.warn("Unable to read local storage session", redactPayload(e?.message || e));
    return null;
  }
}

async function getStoredSession() {
  if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(SESSION_STORAGE_KEY, (res) => {
          resolve(sanitizeSession(res?.[SESSION_STORAGE_KEY]));
        });
      } catch (e) {
        logger.warn("chrome.storage unavailable", redactPayload(e?.message || e));
        resolve(readLocalStorageSession());
      }
    });
  }
  return readLocalStorageSession();
}

async function buildHeaders(session, extra = {}) {
  const fallbackToken = await loadStoredToken();
  const token = session?.access_token || fallbackToken || "";
  return {
    apikey: token,
    Authorization: token ? `Bearer ${token}` : "",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fetchJson(url, options = {}, attempt = 0) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    const retryable = [429, 503].includes(response.status);
    if (retryable && attempt < 3) {
      const delay = Math.min(5000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delay));
      return fetchJson(url, options, attempt + 1);
    }
    const message = typeof body === "string" && body ? body : `HTTP ${response.status}`;
    return { ok: false, data: null, error: new Error(message), status: response.status };
  }

  return { ok: true, data: body, error: null, status: response.status };
}

async function rpc(fn, params = {}) {
  const session = await getStoredSession();
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const { ok, data, error } = await fetchJson(url, {
    method: "POST",
    headers: await buildHeaders(session),
    body: JSON.stringify(params ?? {}),
  });
  return { data: ok ? data : null, error };
}

function from(table) {
  return {
    insert: async (payload, options = {}) => {
      const session = await getStoredSession();
      const url = `${SUPABASE_URL}/rest/v1/${table}`;
      const prefer = options?.returning ? `return=${options.returning}` : "return=minimal";
      const { ok, data, error } = await fetchJson(url, {
        method: "POST",
        headers: await buildHeaders(session, { Prefer: prefer }),
        body: JSON.stringify(payload ?? {}),
      });
      if (ok) {
        batchClient.enqueue({ path: table, payload });
      }
      return { data: ok ? data : null, error };
    },
    upsert: async (payload, options = {}) => {
      const session = await getStoredSession();
      const params = new URLSearchParams();
      if (options?.onConflict) {
        params.set("on_conflict", options.onConflict);
      }
      const query = params.toString();
      const url = query ? `${SUPABASE_URL}/rest/v1/${table}?${query}` : `${SUPABASE_URL}/rest/v1/${table}`;
      const resolution = options?.preferResolution || "merge-duplicates";
      const preferParts = [`resolution=${resolution}`];
      preferParts.push(options?.returning ? `return=${options.returning}` : "return=minimal");
      const { ok, data, error } = await fetchJson(url, {
        method: "POST",
        headers: await buildHeaders(session, { Prefer: preferParts.join(",") }),
        body: JSON.stringify(payload ?? {}),
      });
      return { data: ok ? data : null, error };
    },
  };
}

async function getSession() {
  const session = await getStoredSession();
  return { data: { session }, error: null };
}

async function getUser() {
  const session = await getStoredSession();
  if (session?.user) {
    return { data: { user: session.user }, error: null };
  }
  return { data: { user: null }, error: new Error("User not authenticated") };
}

const supabase = {
  auth: {
    getSession,
    getUser,
  },
  rpc,
  from,
  queue: batchClient,
};

export default supabase;
