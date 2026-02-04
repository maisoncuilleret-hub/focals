const THREAD_MATCHER = /https:\/\/www\.linkedin\.com\/messaging\/thread\/[^/?#]+/i;
const DEFAULT_THROTTLE_MS = 10_000;
const DEFAULT_DEBOUNCE_MS = 1_200;
const DEFAULT_RETRY_DELAY_MS = 2_000;

const DEBUG = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (...args) => console.log("[FOCALS][SYNC]", ...args);
const warn = (...args) => console.warn("[FOCALS][SYNC]", ...args);
const debug = (...args) => {
  if (DEBUG) {
    console.log("[FOCALS][SYNC]", ...args);
  }
};

const isThreadUrl = (url) => THREAD_MATCHER.test(url || "");

export function initLinkedInThreadSync({
  loadExtractor,
  getRoot,
  logger,
  throttleMs = DEFAULT_THROTTLE_MS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (typeof loadExtractor !== "function" || typeof getRoot !== "function") {
    warn("Missing extractor loader or root getter");
    return;
  }

  let lastUrl = null;
  let debounceTimer = null;
  const throttleStorageKey = "syncThrottle";

  const getLastSync = async (threadKey) => {
    try {
      const data = await chrome.storage.local.get(throttleStorageKey);
      return data?.[throttleStorageKey]?.[threadKey] || 0;
    } catch (error) {
      warn("throttle storage read failed", error?.message || error);
      return 0;
    }
  };

  const setLastSync = async (threadKey) => {
    try {
      const data = await chrome.storage.local.get(throttleStorageKey);
      const throttle = data?.[throttleStorageKey] || {};
      throttle[threadKey] = Date.now();
      await chrome.storage.local.set({ [throttleStorageKey]: throttle });
    } catch (error) {
      warn("throttle storage write failed", error?.message || error);
    }
  };

  const shouldThrottle = async (threadUrl) => {
    const lastSync = await getLastSync(threadUrl);
    if (Date.now() - lastSync < throttleMs) return true;
    await setLastSync(threadUrl);
    return false;
  };

  const sendSync = async ({ threadUrl, payload, attempt = 0 }) => {
    if (
      !payload?.messages ||
      !Array.isArray(payload.messages) ||
      payload.messages.length === 0
    ) {
      warn("[FOCALS] Invalid payload - messages array required");
      return { ok: false, error: "Invalid payload: missing messages array" };
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "FOCALS_SYNC_LINKEDIN_THREAD", threadUrl, payload },
        async (response) => {
          if (chrome.runtime.lastError) {
            warn("runtime error", chrome.runtime.lastError.message || "unknown");
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message || "Runtime error",
            });
            return;
          }
          if (!response) {
            warn("empty response");
            resolve({ ok: false, error: "Empty response" });
            return;
          }
          if (!response.ok && response?.meta?.errorType === "network" && attempt < 1) {
            warn("network error, retrying once");
            await wait(retryDelayMs);
            resolve(sendSync({ threadUrl, payload, attempt: attempt + 1 }));
            return;
          }
          resolve(response);
        }
      );
    });
  };

  const runSync = async (threadUrl) => {
    if (!threadUrl || !isThreadUrl(threadUrl)) return;

    const extractor = await loadExtractor();
    if (!extractor) {
      warn("extractor missing");
      return;
    }
    const root = getRoot();
    if (!root) {
      warn("message root missing");
      return;
    }

    const payload = await extractor(root, {
      fillMissingTime: true,
      logger,
    });

    const messages = payload?.messages || [];
    if (!payload?.candidate || !payload?.me || !Array.isArray(messages) || !messages.length) {
      warn("invalid payload");
      return;
    }

    let userId = null;
    try {
      const authData = await chrome.storage.local.get(["focals_user_id"]);
      userId = authData?.focals_user_id || null;
    } catch (error) {
      warn("auth storage read failed", error?.message || error);
    }

    if (!userId) {
      warn("AUTH_MISSING: skip throttle + skip sync");
      return;
    }

    if (await shouldThrottle(threadUrl)) {
      log("throttled threadUrl=", threadUrl);
      return;
    }

    const candidateName =
      payload?.candidate?.fullName ||
      payload?.candidate?.name ||
      payload?.candidate?.firstName ||
      "unknown";
    log("trigger threadUrl=", threadUrl, "msgs=", messages.length, "candidate=", candidateName);
    debug("payload summary", {
      candidate: candidateName,
      me: payload?.me?.fullName || payload?.me?.name || "unknown",
      messages: messages.length,
    });
    const enrichedPayload = {
      ...payload,
      meta: {
        ...(payload?.meta || {}),
        href: payload?.meta?.href || threadUrl || window.location.href,
      },
    };
    const response = await sendSync({ threadUrl, payload: enrichedPayload });
    if (response?.ok) {
      log(
        "status=",
        response?.status,
        "ok=",
        response?.ok,
        "inserted=",
        response?.json?.inserted,
        "updated=",
        response?.json?.updated
      );
    } else {
      warn("ERROR", response?.status || "no-status", response?.error || response);
      if (response?.json) {
        warn("body", response.json);
      }
    }
  };

  const scheduleSync = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSync(window.location.href), debounceMs);
  };

  const pollUrlChanges = () => {
    const current = window.location.href;
    if (current === lastUrl) return;
    lastUrl = current;
    if (isThreadUrl(current)) {
      scheduleSync();
    }
  };

  pollUrlChanges();
  setInterval(pollUrlChanges, 1000);
}
