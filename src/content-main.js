(() => {
  const TAG = "🧪 FOCALS CONSOLE";
  const DEBUG = true;

  // --- 1. UTILITAIRES ET CONSTANTES ---
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");
  const isProfileUrl = (u) => /linkedin\.com\/in\//i.test(u);

  const normalizeLinkedinProfileUrl = (value) => {
    if (!value) return null;
    const rawValue = String(value).trim();
    if (!rawValue || rawValue.toLowerCase() === "unknown") return null;
    try {
      const url = new URL(rawValue.startsWith("http") ? rawValue : `https://${rawValue}`, window.location.origin);
      url.search = "";
      url.hash = "";
      const match = url.pathname.match(/\/in\/[^/]+/i);
      return match ? `${url.origin}${match[0].replace(/\/$/, "")}/` : `${url.origin}${url.pathname.replace(/\/$/, "")}/`;
    } catch {
      return null;
    }
  };

  const safeSendMessage = (payload, callback) => {
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage(payload, callback);
    } else {
      warn("Contexte invalide. F5 requis.");
    }
  };

  // --- 2. ÉCOUTEUR DES SIGNAUX DE L'INTERCEPTEUR (L'OREILLE) ---
  window.addEventListener("message", (event) => {
    // On n'écoute que les messages venant de notre Spy
    if (event.data?.type === "FOCALS_VOYAGER_CONVERSATIONS") {
      log("📡 [VOYAGER] Données Bulk reçues de l'intercepteur");
      safeSendMessage({
        type: "FOCALS_VOYAGER_CONVERSATIONS",
        payload: event.data?.data || null,
      });
    }

    if (event.data?.type === "FOCALS_NETWORK_DATA") {
      log("📡 [VOYAGER] Nouveau message détecté (Temps réel)");
      // Relais direct au background pour traitement
      safeSendMessage({
        type: "FOCALS_NETWORK_DATA",
        payload: event.data?.data || null,
      });
    }
  });

  // --- 3. LOGIQUE DE SCRAPING DE PROFIL ---
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

  let lastLinkedinIdSync = null;
  function syncLinkedinIdsToSupabase() {
    if (!isProfileUrl(location.href)) return;
    const currentUrl = normalizeLinkedinProfileUrl(location.href);
    if (!currentUrl || currentUrl === lastLinkedinIdSync) return;

    const ids = extractLinkedinIds();
    const nameEl = document.querySelector("h1");
    const name = nameEl ? nameEl.innerText.trim() : "";

    if (currentUrl && ids.linkedin_internal_id) {
      lastLinkedinIdSync = currentUrl;
      log("✅ [MAPPING] Envoi des IDs...", { name, internalId: ids.linkedin_internal_id });
      safeSendMessage({
        type: "SAVE_PROFILE_TO_SUPABASE",
        profile: { name, linkedin_url: currentUrl, linkedin_internal_id: ids.linkedin_internal_id },
      });
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

  // --- 4. INJECTION DE L'INTERCEPTEUR ---
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
  log("🚀 Initialisation du Content Script (Oreille active)...");
  voyagerSpy();
  startProfileIdSyncWatcher();
  log("ℹ️ Radar DOM désactivé. Écoute réseau active.");
})();
