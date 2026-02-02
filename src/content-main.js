(() => {
  const TAG = "🧪 [FOCALS-DEBUG]";
  const log = (...a) => console.log(`%c${TAG}`, "color: #00ebff; font-weight: bold;", ...a);
  const success = (...a) => console.log(`%c${TAG} ✅`, "color: #00ff00; font-weight: bold;", ...a);
  const warn = (...a) => console.warn(`${TAG} ⚠️`, ...a);
  const info = (...a) => console.info(`%c${TAG} ℹ️`, "color: #bb86fc;", ...a);

  log("Démarrage du Content Script...");

  // Variable globale pour mémoriser l'ID du candidat actuel
  window._focalsCurrentCandidateId = window._focalsCurrentCandidateId || null;

  // --- 1. GESTION DES MESSAGES (VOYAGER) ---
  const handleIncomingData = (rawData, source) => {
    try {
      const elements = rawData?.data?.messengerMessagesBySyncToken?.elements || rawData?.elements || [];
      if (elements.length === 0) return;

      const enriched = elements.map((item) => {
        const p = item?.sender?.participantType?.member || item?.sender?.member || {};
        const fullName = `${p?.firstName?.text || p?.firstName || ""} ${p?.lastName?.text || p?.lastName || ""}`.trim();
        const techId = (item?.sender?.hostIdentityUrn || "").split(":").pop();

        // Distinction : Si l'ID de l'envoyeur n'est pas celui du candidat, c'est VOUS.
        const isFromMe = window._focalsCurrentCandidateId ? techId !== window._focalsCurrentCandidateId : null;

        return {
          ...item,
          match_name: fullName,
          match_id: techId,
          is_from_me: isFromMe,
          body_text: item?.body?.text || "",
        };
      });

      chrome.runtime.sendMessage({
        type: "FOCALS_VOYAGER_CONVERSATIONS",
        payload: { elements: enriched },
      });
    } catch (e) {
      console.error(`${TAG} Erreur data :`, e);
    }
  };

  window.addEventListener("FOCALS_VOYAGER_DATA", (e) => handleIncomingData(e.detail?.data, "CustomEvent"));

  // --- 2. SCRAPER DE PROFIL (MAPPING) ---
  function extractLinkedinIds() {
    const nameEl = document.querySelector("h1.text-heading-xlarge, h1");
    const name = nameEl ? nameEl.innerText.trim() : "Inconnu";

    const codeTags = document.querySelectorAll("code");
    let techId = null;
    for (const tag of codeTags) {
      const m = tag.textContent.match(/urn:li:fsd_profile:([^",\s]+)/);
      if (m) {
        techId = m[1];
        break;
      }
    }

    return {
      name,
      linkedin_internal_id: techId,
      linkedin_url: window.location.href,
    };
  }

  function syncProfile() {
    try {
      if (!window.location.pathname.includes("/in/")) return;

      log("🔍 Recherche d'identité...");
      const ids = extractLinkedinIds();

      if (ids.linkedin_internal_id) {
        window._focalsCurrentCandidateId = ids.linkedin_internal_id;
        success(`MAPPING RÉUSSI : ${ids.linkedin_internal_id}`);

        chrome.runtime.sendMessage({
          type: "SAVE_PROFILE_TO_SUPABASE",
          profile: ids,
        });

        // Déclenchement automatique du scraper d'expériences
        setTimeout(() => {
          if (window.FOCALS && typeof window.FOCALS.run === "function") {
            info("🚀 Lancement automatique du scraper d'expériences...");
            window.FOCALS.run();
          } else {
            warn("Le scraper (linkedinSduiScraper.js) n'est toujours pas détecté sur window.");
          }
        }, 500);
      }
    } catch (e) {
      warn("Erreur lors du scraping profil :", e);
    }
  }

  // --- 3. LANCEMENT ET WATCHER ---
  syncProfile();

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      syncProfile();
    }
  }, 2000);

  success("Content Script prêt et actif !");
})();
