const AUTH_SESSION_KEY = "focals_supabase_session";
const USER_ID_KEY = "focals_user_id";
const ACCESS_TOKEN_KEYS = ["sb_access_token", "supabase_access_token"];
const FALLBACK_SESSION_KEYS = ["session", "sb-ppawceknsedxaejpeylu-auth-token"];

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

const getFromStorage = (keys) =>
  new Promise((resolve) => {
    try {
      chrome.storage?.local?.get(keys, (result) => resolve(result || {}));
    } catch {
      resolve({});
    }
  });

const extractSession = (storage) => {
  const storedSession = parseJson(storage?.[AUTH_SESSION_KEY]);
  const fallbackSession =
    parseJson(storage?.session) ||
    parseJson(storage?.["sb-ppawceknsedxaejpeylu-auth-token"]);
  const session = storedSession || fallbackSession;
  if (!session || typeof session !== "object") return null;
  return {
    accessToken: session.access_token || session.accessToken || "",
    userId: session.user_id || session.userId || session?.user?.id || "",
    expiresAt: session.expires_at || session.expiresAt || null,
  };
};

const isExpired = (expiresAt) => {
  if (!expiresAt) return false;
  const expiry = typeof expiresAt === "string" ? Number(expiresAt) : expiresAt;
  if (!Number.isFinite(expiry)) return false;
  return Date.now() / 1000 >= expiry;
};

export async function getSession() {
  const storage = await getFromStorage([
    AUTH_SESSION_KEY,
    USER_ID_KEY,
    ...ACCESS_TOKEN_KEYS,
    ...FALLBACK_SESSION_KEYS,
  ]);
  const session = extractSession(storage);
  const accessToken =
    session?.accessToken ||
    ACCESS_TOKEN_KEYS.map((key) => storage?.[key]).find(Boolean) ||
    "";
  const userId = session?.userId || storage?.[USER_ID_KEY] || "";
  const expiresAt = session?.expiresAt || null;

  if (isExpired(expiresAt)) {
    return null;
  }

  if (!accessToken && !userId) {
    return null;
  }

  return { accessToken, userId, expiresAt };
}

export async function setSession(session = {}) {
  const accessToken = session.access_token || session.accessToken || "";
  const userId = session.user_id || session.userId || session?.user?.id || "";
  const expiresAt = session.expires_at || session.expiresAt || null;

  const payload = {
    access_token: accessToken,
    user_id: userId,
    expires_at: expiresAt,
  };

  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.set(
        {
          [AUTH_SESSION_KEY]: payload,
          [USER_ID_KEY]: userId,
        },
        () => resolve(payload)
      );
    } catch {
      resolve(payload);
    }
  });
}
