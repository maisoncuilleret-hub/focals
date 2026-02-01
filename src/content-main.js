(() => {
  const TAG = "🧪 [FOCALS-DEBUG]";

  // Utilitaires de log stylisés
  const log = (...a) => console.log(`%c${TAG}`, "color: #00ebff; font-weight: bold;", ...a);
  const success = (...a) => console.log(`%c${TAG} ✅`, "color: #00ff00; font-weight: bold;", ...a);
  const error = (...a) => console.error(`${TAG} ❌`, ...a);
  const warn = (...a) => console.warn(`${TAG} ⚠️`, ...a);
  const info = (...a) => console.info(`%c${TAG} ℹ️`, "color: #bb86fc;", ...a);

  log("Initialisation du script de debug...");

  // --- 1. L'OREILLE (ÉCOUTEUR DE DONNÉES VOYAGER) ---
  const handleIncomingData = (rawData, source) => {
    try {
      // 1. Initialisation de la mémoire si elle n'existe pas
      if (!window._focalsIdentityMap) {
        window._focalsIdentityMap = new Map();
      }

      const elements =
        rawData?.data?.messengerMessagesBySyncToken?.elements || rawData?.elements || [];

      if (elements.length === 0) return;

      log(`📡 [VOYAGER DATA] Source: ${source} | ${elements.length} messages`);

      const enriched = elements.map((item) => {
        const p =
          item?.sender?.participantType?.member ||
          item?.actor?.participantType?.member ||
          item?.sender?.member ||
          {};

        const fName = p?.firstName?.text || p?.firstName || "";
        const lName = p?.lastName?.text || p?.lastName || "";
        const fullName = (fName + " " + lName).trim() || "LinkedIn User";
        const techId = (item?.sender?.hostIdentityUrn || item?.actor?.hostIdentityUrn || "")
          .split(":")
          .pop();

        // --- LA LIGNE MANQUANTE : ON RANGE DANS LA MÉMOIRE ---
        if (fullName !== "LinkedIn User" && techId) {
          window._focalsIdentityMap.set(fullName, {
            name: fullName,
            internal_id: techId,
            conversation_urn: item?.conversationUrn || item?.backendConversationUrn,
          });
        }

        return {
          ...item,
          match_name: fullName,
          match_id: techId,
          body_text: item?.body?.text || "",
        };
      });

      success(`Mémoire mise à jour et envoi de ${enriched.length} messages au Service Worker.`);

      chrome.runtime.sendMessage({
        type: "FOCALS_VOYAGER_CONVERSATIONS",
        payload: { elements: enriched },
      });
    } catch (e) {
      error("Erreur lors du traitement des données :", e);
    }
  };

  // On écoute sur tous les canaux possibles pour ne rien rater
  window.addEventListener("FOCALS_VOYAGER_DATA", (e) => handleIncomingData(e.detail?.data, "CustomEvent"));
  window.addEventListener("message", (e) => {
    if (e.data?.type === "FOCALS_VOYAGER_CONVERSATIONS") {
      handleIncomingData(e.data.data, "PostMessage");
    }
  });

  // --- 2. LE SCRAPER DE PROFIL (MAPPING) ---
  function syncProfile() {
    if (!window.location.pathname.includes("/in/")) return;

    info("Analyse de la page profil pour mapping...");

    const nameEl = document.querySelector("h1.text-heading-xlarge, .pv-top-card-section__name, h1");
    const name = nameEl ? nameEl.innerText.trim() : "Nom introuvable";

    const codeTags = document.querySelectorAll("code");
    let techId = null;
    for (const tag of codeTags) {
      const m = tag.textContent.match(/urn:li:fsd_profile:([^",\s]+)/);
      if (m) {
        techId = m[1];
        break;
      }
    }

    if (techId) {
      success(`MAPPING DÉTECTÉ : ${name} <-> ${techId}`);
      chrome.runtime.sendMessage({
        type: "SAVE_PROFILE_TO_SUPABASE",
        profile: { name, linkedin_url: window.location.href, linkedin_internal_id: techId },
      });
    } else {
      warn("Page profil détectée mais ID technique (ACoAA) introuvable dans le DOM.");
    }
  }

  // --- 3. INJECTION DU SPY ---
  const voyagerSpy = () => {
    if (document.getElementById("focals-voyager-spy")) {
      log("Intercepteur déjà présent.");
      return;
    }
    const s = document.createElement("script");
    s.id = "focals-voyager-spy";
    s.src = chrome.runtime.getURL("src/content/linkedinVoyagerInterceptor.js");
    s.type = "text/javascript";
    (document.head || document.documentElement).appendChild(s);
    success("Intercepteur Voyager injecté avec succès.");
  };

  // --- LANCEMENT ---
  voyagerSpy();
  syncProfile();

  // Watcher pour les changements de page (LinkedIn est une Single Page App)
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      info(`Changement de page détecté : ${location.href}`);
      lastUrl = location.href;
      syncProfile();
    }
  }, 2000);

  success("Content Script prêt et à l'écoute !");
})();
