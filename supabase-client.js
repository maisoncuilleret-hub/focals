export const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYXdjZWtuc2VkeGFlanBleWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4MTUzMTUsImV4cCI6MjA3NDM5MTMxNX0.G3XH8afOmaYh2PGttY3CVRwi0JIzIvsTKIeeynpKpKI";

const SESSION_STORAGE_KEY = "focals_supabase_session";
const LOCALSTORAGE_SUPABASE_KEY = "sb-ppawceknsedxaejpeylu-auth-token";

function readLocalStorageSession() {
  try {
    const raw =
      (typeof localStorage !== "undefined" &&
        (localStorage.getItem(SESSION_STORAGE_KEY) ||
          localStorage.getItem(LOCALSTORAGE_SUPABASE_KEY))) ||
      null;
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn("[Focals][Supabase] Unable to read localStorage session", e);
    return null;
  }
}

async function getStoredSession() {
  if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(SESSION_STORAGE_KEY, (res) => {
          resolve(res?.[SESSION_STORAGE_KEY] || null);
        });
      } catch (e) {
        console.warn("[Focals][Supabase] chrome.storage unavailable", e);
        resolve(null);
      }
    });
  }

  return readLocalStorageSession();
}

function buildHeaders(session, extra = {}) {
  const token = session?.access_token || SUPABASE_ANON_KEY;
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
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
    headers: buildHeaders(session),
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
        headers: buildHeaders(session, { Prefer: prefer }),
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
};

export default supabase;
