// Injected on the web app domain to sync Supabase session to the extension.
(() => {
  const SUPABASE_KEY_PREFIX = "sb-";
  const AUTH_TOKEN_SUFFIX = "-auth-token";

  function findSessionKey() {
    return Object.keys(localStorage).find(
      (key) => key.startsWith(SUPABASE_KEY_PREFIX) && key.includes(AUTH_TOKEN_SUFFIX)
    );
  }

  const key = findSessionKey();
  if (!key) {
    return;
  }

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.currentSession?.access_token) return;

    chrome.runtime.sendMessage({
      type: "SUPABASE_SESSION",
      key,
      session: parsed,
    });
  } catch (err) {
    console.warn("[Focals] Impossible de synchroniser la session Supabase", err);
  }
})();
