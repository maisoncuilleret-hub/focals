// Injected on the web app domain to sync Supabase session to the extension.
(() => {
  const LOG_SCOPE = "NET";
  const fallbackLogger = {
    info: (scope, ...args) => console.info(`[FOCALS][${scope}]`, ...args),
    warn: (scope, ...args) => console.warn(`[FOCALS][${scope}]`, ...args),
    error: (scope, ...args) => console.error(`[FOCALS][${scope}]`, ...args),
  };
  let logger = fallbackLogger;

  if (typeof chrome !== "undefined" && chrome?.runtime?.getURL) {
    import(chrome.runtime.getURL("src/utils/logger.js"))
      .then((mod) => {
        if (mod?.logger) logger = mod.logger;
      })
      .catch(() => {});
  }

  const allowedHosts = ["focals.app", "localhost", "127.0.0.1"];
  if (!allowedHosts.some((host) => window.location.hostname.includes(host))) {
    return;
  }
  const SUPABASE_AUTH_KEY = "sb-ppawceknsedxaejpeylu-auth-token";

  logger.info(LOG_SCOPE, "session-bridge.js exécuté");

  const sessionRaw = localStorage.getItem(SUPABASE_AUTH_KEY);
  logger.info(LOG_SCOPE, "Session raw exists", !!sessionRaw);

  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw);
      logger.info(LOG_SCOPE, "Session parsed", {
        hasAccessToken: !!session.access_token,
        hasRefreshToken: !!session.refresh_token,
        hasUser: !!session.user,
      });

      chrome.storage?.local?.set?.({
        focals_supabase_session: session,
        focals_supabase_token: session.access_token || "",
      });

      chrome.runtime.sendMessage(
        { type: "SUPABASE_SESSION", session },
        (response) => {
          if (chrome.runtime.lastError) {
            logger.error(LOG_SCOPE, "Erreur sendMessage", chrome.runtime.lastError);
          } else {
            logger.info(LOG_SCOPE, "Session envoyée au background", response);
          }
        }
      );
    } catch (err) {
      logger.error(LOG_SCOPE, "Erreur parsing session", err);
    }
  } else {
    logger.warn(LOG_SCOPE, "Aucune session Supabase trouvée");
  }
})();
