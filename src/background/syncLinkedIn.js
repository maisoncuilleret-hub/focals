import { SUPABASE_URL } from "../../supabase-client.js";
import { getAuthContext } from "./authContext.js";

const EDGE_ENDPOINT = `${SUPABASE_URL}/functions/v1/sync-linkedin-conversation`;
const DEBUG = false;
const THROTTLE_MS = 10_000;
const lastSyncByThreadKey = new Map();

const now = () => Date.now();

const getThreadKey = (threadUrl) => threadUrl || "unknown-thread";

const shouldThrottle = (threadKey) => {
  const lastSync = lastSyncByThreadKey.get(threadKey) || 0;
  if (now() - lastSync < THROTTLE_MS) return true;
  lastSyncByThreadKey.set(threadKey, now());
  return false;
};

const safeJsonParse = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseBody = async (response) => {
  const text = await response.text().catch(() => "");
  const parsed = safeJsonParse(text);
  return parsed ?? text;
};

export async function syncLinkedinConversation({ threadUrl, payload }) {
  const threadKey = getThreadKey(threadUrl);

  if (shouldThrottle(threadKey)) {
    return {
      ok: true,
      skipped: true,
      reason: "throttled",
      meta: { threadKey },
    };
  }

  if (!payload) {
    return {
      ok: false,
      status: 400,
      error: "Missing payload",
      meta: { threadKey },
    };
  }

  const { accessToken, userId, anonKey } = await getAuthContext();
  const headers = {
    "Content-Type": "application/json",
  };

  if (anonKey) {
    headers.apikey = anonKey;
  }

  let usedAuth = "user_id";
  const body = { payload, threadUrl };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    usedAuth = "jwt";
  } else if (userId) {
    body.user_id = userId;
  } else {
    return {
      ok: false,
      status: 401,
      error: "Missing authentication context",
      meta: { threadKey, usedAuth: "none" },
    };
  }

  console.log(
    "[FOCALS][SUPABASE] auth=",
    usedAuth,
    "token=",
    accessToken ? "yes" : "no",
    "thread=",
    threadKey
  );
  if (DEBUG) {
    console.log("[FOCALS][SUPABASE] payload messages=", payload?.messages?.length || 0);
  }

  try {
    const response = await fetch(EDGE_ENDPOINT, {
      method: "POST",
      mode: "cors",
      headers,
      body: JSON.stringify(body),
    });
    const data = await parseBody(response);
    const result = {
      ok: response.ok,
      status: response.status,
      json: data,
      meta: { usedAuth, threadKey },
    };
    if (!response.ok) {
      const errorMessage =
        typeof data === "string" && data ? data : `HTTP ${response.status}`;
      result.error = errorMessage;
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || "Network error",
      meta: { usedAuth, threadKey, errorType: "network" },
    };
  }
}
