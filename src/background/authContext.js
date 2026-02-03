import supabase from "../../supabase-client.js";
import { loadStoredToken } from "../api/supabaseClient.js";
import { getSession } from "./authStore.js";

const SESSION_STORAGE_KEY = "focals_supabase_session";
const LOCALSTORAGE_SUPABASE_KEY = "sb-ppawceknsedxaejpeylu-auth-token";
const USER_ID_STORAGE_KEY = "focals_user_id";
const SUPABASE_TOKEN_KEY = "focals_supabase_token";
const ACCESS_TOKEN_KEYS = ["sb_access_token", "supabase_access_token", "session"];

const parseJson = (raw) => {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const sanitizeSession = (raw) => {
  const session = parseJson(raw);
  if (!session || typeof session !== "object") return null;
  return {
    access_token: session.access_token || session.accessToken || "",
    refresh_token: session.refresh_token || session.refreshToken || "",
    user: session.user || null,
  };
};

const getStorageValues = (keys) =>
  new Promise((resolve) => {
    try {
      chrome.storage?.local?.get(keys, (result) => resolve(result || {}));
    } catch {
      resolve({});
    }
  });

const extractFromStorage = (storage) => {
  const session =
    sanitizeSession(storage?.[SESSION_STORAGE_KEY]) ||
    sanitizeSession(storage?.[LOCALSTORAGE_SUPABASE_KEY]) ||
    sanitizeSession(storage?.session);
  const userId = storage?.[USER_ID_STORAGE_KEY] || session?.user?.id || null;
  const accessToken =
    session?.access_token ||
    ACCESS_TOKEN_KEYS.map((key) => storage?.[key]).find(Boolean) ||
    null;
  const anonKey = storage?.[SUPABASE_TOKEN_KEY] || null;
  return { accessToken, userId, anonKey };
};

export async function getAuthContext() {
  let accessToken = null;
  let userId = null;

  try {
    const sessionResult = await supabase.auth.getSession();
    accessToken = sessionResult?.data?.session?.access_token || null;
  } catch {
    accessToken = null;
  }

  try {
    const userResult = await supabase.auth.getUser();
    userId = userResult?.data?.user?.id || null;
  } catch {
    userId = null;
  }

  const storage = await getStorageValues([
    SESSION_STORAGE_KEY,
    LOCALSTORAGE_SUPABASE_KEY,
    USER_ID_STORAGE_KEY,
    SUPABASE_TOKEN_KEY,
    ...ACCESS_TOKEN_KEYS,
  ]);
  const storageContext = extractFromStorage(storage);
  const storedSession = await getSession().catch(() => null);

  const anonKey =
    storageContext.anonKey ||
    (await loadStoredToken().catch(() => "")) ||
    "";

  return {
    accessToken:
      accessToken || storageContext.accessToken || storedSession?.accessToken || null,
    userId: userId || storageContext.userId || storedSession?.userId || null,
    anonKey,
  };
}
