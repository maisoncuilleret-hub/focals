(() => {
  const TAG = "🧪 FOCALS CONSOLE";
  const DEBUG = true;

  // --- 1. UTILITAIRES ET CONSTANTES (DÉFINIS EN PREMIER) ---
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");

  const isProfileUrl = (u) => /linkedin\.com\/in\//i.test(u);

  const normalizeLinkedinProfileUrl = (value) => {
    if (!value) return null;
    const rawValue = String(value).trim();
    if (!rawValue || rawValue.toLowerCase() === "unknown") return null;
    try {
      const normalizedValue = rawValue.startsWith("www.linkedin.com/")
        ? `https://${rawValue}`
        : rawValue;
      const url = new URL(normalizedValue, window.location.origin);
      url.search = "";
      url.hash = "";
      const match = url.pathname.match(/\/in\/[^/]+/i);
      if (match) return `${url.origin}${match[0].replace(/\/$/, "")}/`;
      return `${url.origin}${url.pathname.replace(/\/$/, "")}/`;
    } catch {
      return null;
    }
  };

  const safeSendMessage = (payload, callback) => {
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage(payload, callback);
    } else {
      warn("Contexte de l'extension invalide. Rafraîchis la page.");
    }
  };

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

  // --- 2. ÉTAT ET CACHES (UNE SEULE DÉCLARATION) ---
  let lastLinkedinIdSync = null;
  const identityMap = (window._focalsIdentityMap = window._focalsIdentityMap || new Map());

  // --- 3. LOGIQUE DE SYNCHRONISATION ---
  function syncLinkedinIdsToSupabase() {
    if (!isProfileUrl(location.href)) return;

    const currentUrl = normalizeLinkedinProfileUrl(location.href);
    if (!currentUrl || currentUrl === lastLinkedinIdSync) return;

    const ids = extractLinkedinIds();
    // On essaie de récupérer le nom sur la page
    const nameEl = document.querySelector("h1.text-heading-xlarge");
    const name = nameEl ? nameEl.innerText.trim() : "";

    const payload = {
      name: name,
      linkedin_url: currentUrl,
      linkedin_internal_id: ids.linkedin_internal_id,
    };

    if (payload.linkedin_url && payload.linkedin_internal_id) {
      lastLinkedinIdSync = currentUrl;
      log("✅ [SCRAP] Mapping identité détecté :", payload.name, payload.linkedin_internal_id);
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

  // --- 4. RÉSEAU (VOYAGER) ---
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

  // Écouteur de messages pour les données réseau
  window.addEventListener("FOCALS_VOYAGER_DATA", (event) => {
    // La logique Voyager reste ici pour l'archivage automatique
    const data = event?.detail?.data;
    if (data) {
      safeSendMessage({ type: "FOCALS_VOYAGER_CONVERSATIONS", payload: data });
    }
  });

  // --- 5. INITIALISATION ---
  log("🚀 Content Script Focals démarré.");
  voyagerSpy();
  startProfileIdSyncWatcher();

  // On désactive le setupLiveObserver (Radar DOM bruyant)
  // car Voyager gère l'archivage de manière plus propre.
  log("ℹ️ Radar DOM désactivé. Synchronisation via Voyager prioritaire.");

  void clean;
  void DEBUG;
  void identityMap;
})();
