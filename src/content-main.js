(() => {
  const TAG = "🧪 [FOCALS-DEBUG]";
  const log = (...a) => console.log(`%c${TAG}`, "color: #00ebff; font-weight: bold;", ...a);
  const success = (...a) => console.log(`%c${TAG} ✅`, "color: #00ff00; font-weight: bold;", ...a);
  const warn = (...a) => console.warn(`${TAG} ⚠️`, ...a);
  const info = (...a) => console.info(`%c${TAG} ℹ️`, "color: #bb86fc;", ...a);

  const injectPageScraper = () => {
    if (document.documentElement?.dataset?.focalsPageScraperInjected === "true") {
      return;
    }
    document.documentElement.dataset.focalsPageScraperInjected = "true";

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/content/linkedinSduiScraper.js");
    script.async = false;
    script.dataset.focals = "page-scraper";
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener("load", () => {
      script.remove();
    });
  };

  log("Démarrage du Content Script...");
  injectPageScraper();

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
  const getCleanUrl = (url) => {
    try {
      const parsed = new URL(url);
      parsed.search = "";
      parsed.hash = "";
      parsed.pathname = parsed.pathname.replace(/\/$/, "");
      return parsed.toString();
    } catch (err) {
      warn("🧪 [FOCALS-DEBUG] getCleanUrl failed:", err?.message || err);
      return (url || "").replace(/[?#].*$/, "").replace(/\/$/, "");
    }
  };

  const findTechIdInText = (text) => {
    if (!text) return null;
    const match = text.match(/urn:li:fsd_profile:([^",\s]+)/);
    return match ? match[1] : null;
  };

  function extractLinkedinIds() {
    const nameEl = document.querySelector("h1.text-heading-xlarge, h1");
    const name = nameEl ? nameEl.innerText.trim() : "";

    if (!name || name === "Expérience") {
      return null;
    }

    let techId = null;
    const codeTags = document.querySelectorAll("code");
    for (const tag of codeTags) {
      techId = findTechIdInText(tag.textContent);
      if (techId) break;
    }

    if (!techId) {
      const urnNodes = document.querySelectorAll('[data-entity-urn*="fsd_profile"], [data-urn*="fsd_profile"]');
      for (const node of urnNodes) {
        const urn = node.getAttribute("data-entity-urn") || node.getAttribute("data-urn") || "";
        techId = findTechIdInText(urn);
        if (techId) break;
      }
    }

    if (!techId) {
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        techId = findTechIdInText(script.textContent || "");
        if (techId) break;
      }
    }

    if (!techId) return null;

    return {
      name,
      linkedin_internal_id: techId,
      linkedin_url: window.location.href,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "FOCALS_TRIGGER_SCRAPE") return undefined;

    try {
      if (window.FOCALS && typeof window.FOCALS.run === "function") {
        // Le popup déclenche le scraper principal qui gère lui-même le stockage.
        window.FOCALS.run(message?.reason || "popup_trigger");
        sendResponse({ ok: true, triggered: true, cacheKey: `focals_last_result:${getCleanUrl(location.href)}` });
      } else {
        warn("🧪 [FOCALS-DEBUG] scraper missing on window.FOCALS.");
        sendResponse({ ok: false, error: "SCRAPER_MISSING" });
      }
    } catch (err) {
      warn("🧪 [FOCALS-DEBUG] trigger scrape failed:", err?.message || err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }

    return true;
  });

  async function sendMessageWithRetry(message, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        if (attempt > 1) {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "PING" }, () => {
              resolve();
            });
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          });
        });
      } catch (err) {
        if (attempt === maxRetries) {
          throw err;
        }
        warn(`Tentative ${attempt}/${maxRetries} échouée, retry...`);
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    return null;
  }

  async function syncProfile() {
    try {
      if (!window.location.pathname.includes("/in/")) return;

      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        log(`🔍 Recherche d'identité (Tentative ${attempt}/${maxAttempts})...`);
        const ids = extractLinkedinIds();

        if (ids) {
          window._focalsCurrentCandidateId = ids.linkedin_internal_id;
          success(`MAPPING RÉUSSI : ${ids.linkedin_internal_id}`);

          try {
            await chrome.storage.local.set({
              current_linkedin_id: ids.linkedin_internal_id,
              current_profile_name: ids.name,
            });
          } catch (err) {
            warn("Erreur storage local:", err);
          }

          try {
            await sendMessageWithRetry({
              type: "SAVE_PROFILE_TO_SUPABASE",
              profile: ids,
            });
          } catch (err) {
            warn(
              "Background injoignable (normal si service worker endormi):",
              err.message
            );
          }

          // Déclenchement automatique du scraper d'expériences
          setTimeout(() => {
            if (window.FOCALS && typeof window.FOCALS.run === "function") {
              info("🚀 Lancement automatique du scraper d'expériences...");
              window.FOCALS.run();
            } else {
              warn("Le scraper (linkedinSduiScraper.js) n'est toujours pas détecté sur window.");
            }
          }, 1000);
          return;
        }

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      warn("Impossible de trouver l'ID technique après 5 tentatives.");
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
