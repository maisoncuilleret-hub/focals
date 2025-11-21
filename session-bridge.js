// Injected on the web app domain to sync Supabase session to the extension.
(() => {
  const SUPABASE_AUTH_KEY = "sb-ppawceknsedxaejpeylu-auth-token";

  console.log("[Focals] 🚀 session-bridge.js exécuté");

  const sessionRaw = localStorage.getItem(SUPABASE_AUTH_KEY);
  console.log("[Focals] 🔍 Session raw exists:", !!sessionRaw);

  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw);
      console.log("[Focals] 📦 Session parsed:", {
        hasAccessToken: !!session.access_token,
        hasRefreshToken: !!session.refresh_token,
        hasUser: !!session.user,
      });

      chrome.runtime.sendMessage(
        { type: "SUPABASE_SESSION", session },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("[Focals] ❌ Erreur sendMessage:", chrome.runtime.lastError);
          } else {
            console.log("[Focals] ✅ Session envoyée au background:", response);
          }
        }
      );
    } catch (err) {
      console.error("[Focals] ❌ Erreur parsing session:", err);
    }
  } else {
    console.warn("[Focals] ⚠️ Aucune session Supabase trouvée");
  }
})();
