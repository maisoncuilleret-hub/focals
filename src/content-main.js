(() => {
  const TAG = "🧪 FOCALS CONSOLE";
  const DEBUG = true; // Forcer le debug pour voir les logs de fix

  // --- 1. UTILITAIRES ET CONSTANTES (TOUJOURS EN HAUT) ---
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");

  const isProfileUrl = (u) => /linkedin\.com\/in\//i.test(u);

  const normalizeLinkedinProfileUrl = (value) => {
    if (!value) return null;
    const rawValue = String(value).trim();
    if (!rawValue || rawValue.toLowerCase() === "unknown") return null;
    try {
      const url = new URL(
        rawValue.startsWith("http") ? rawValue : `https://${rawValue}`,
        window.location.origin
      );
      url.search = "";
      url.hash = "";
      const match = url.pathname.match(/\/in\/[^/]+/i);
      return match
        ? `${url.origin}${match[0].replace(/\/$/, "")}/`
        : `${url.origin}${url.pathname.replace(/\/$/, "")}/`;
    } catch {
      return null;
    }
  };

  const safeSendMessage = (payload, callback) => {
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage(payload, callback);
    } else {
      warn("Contexte de l'extension invalide. Rafraîchis la page (F5).");
    }
  };

  // --- 2. LOGIQUE DE SCRAPING ET MAPPING ---
  const extractLinkedinIds = () => {
    const [, rawSlug = ""] = window.location.pathname.split("/in/");
    const publicSlug = rawSlug.split("/")[0].trim();
    const codeTags = document.querySelectorAll("code");
    let technicalId = null;

    for (const tag of codeTags) {
      const match = tag.textContent.match(/urn:li:fsd_profile:([^",\s]+)/);
      if (match) {
        technicalId = match[1];
        break;
      }
    }

    return {
      linkedin_url: publicSlug ? `https://www.linkedin.com/in/${publicSlug}/` : null,
      linkedin_internal_id: technicalId,
    };
  };

  // --- 3. GESTION DU SYNC (UNE SEULE DÉCLARATION) ---
  let lastLinkedinIdSync = null;

  function syncLinkedinIdsToSupabase() {
    if (!isProfileUrl(location.href)) return;

    const currentUrl = normalizeLinkedinProfileUrl(location.href);
    if (!currentUrl || currentUrl === lastLinkedinIdSync) return;

    const ids = extractLinkedinIds();
    const nameEl = document.querySelector("h1");
    const name = nameEl ? nameEl.innerText.trim() : "";

    const payload = {
      name: name,
      linkedin_url: currentUrl,
      linkedin_internal_id: ids.linkedin_internal_id,
    };

    if (payload.linkedin_url && payload.linkedin_internal_id) {
      lastLinkedinIdSync = currentUrl;
      log("✅ [MAPPING] Envoi des IDs à Supabase...", payload);
      safeSendMessage({ type: "SAVE_PROFILE_TO_SUPABASE", profile: payload });
    }
  }

  function startProfileIdSyncWatcher() {
    let lastHref = location.href;
    syncLinkedinIdsToSupabase();
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        syncLinkedinIdsToSupabase();
      }
    }, 2000);
  }

  // --- 4. INTERCEPTEUR VOYAGER ---
  const voyagerSpy = () => {
    if (document.getElementById("focals-voyager-spy")) return;
    const script = document.createElement("script");
    script.id = "focals-voyager-spy";
    script.src = chrome.runtime.getURL("src/content/linkedinVoyagerInterceptor.js");
    script.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  };

  // --- 5. INITIALISATION ---
  log("🚀 Initialisation du Content Script...");

  // Lancer le Spy réseau
  voyagerSpy();

  // Lancer le Watcher de profil (Mapping technique <-> public)
  startProfileIdSyncWatcher();

  // --- ⚠️ DOM RADAR DÉSACTIVÉ ---
  // setupLiveObserver(); // Commenté pour éviter le bruit et les doublons
  log("ℹ️ Radar DOM désactivé. Synchronisation via Voyager active.");

  void clean;
  void DEBUG;
})();
