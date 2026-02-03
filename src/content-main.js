(() => {
  const LOG_SCOPE = "INJECT";
  const MSG_SCOPE = "MSG";
  const SCRAPER_SCOPE = "SCRAPER";
  const NAV_SCOPE = "NAV";
  const LOG_LEVEL_STORAGE_KEY = "focals_log_level";
  const DOM_PROFILE_SCRAPER_FLAG_KEY = "focals_dom_profile_scraper_enabled";

  const fallbackLogger = {
    debug: (scope, ...args) => console.debug(`[FOCALS][${scope}]`, ...args),
    info: (scope, ...args) => console.info(`[FOCALS][${scope}]`, ...args),
    warn: (scope, ...args) => console.warn(`[FOCALS][${scope}]`, ...args),
    error: (scope, ...args) => console.error(`[FOCALS][${scope}]`, ...args),
  };

  let logger = fallbackLogger;

  if (typeof chrome !== "undefined" && chrome?.runtime?.getURL) {
    import(chrome.runtime.getURL("src/utils/logger.js"))
      .then((mod) => {
        if (mod?.logger) logger = mod.logger;
        if (logger?.refresh) logger.refresh();
      })
      .catch(() => {});
  }

  const setDatasetFlag = (key, value) => {
    if (!document.documentElement) return;
    document.documentElement.dataset[key] = value;
  };

  const applyLogLevel = (value) => {
    const nextLevel = value ? String(value).toLowerCase() : "info";
    setDatasetFlag("focalsLogLevel", nextLevel);
  };

  const applyDomProfileScraperFlag = (value) => {
    const enabled = value !== false;
    setDatasetFlag("focalsDomProfileScraperEnabled", enabled ? "true" : "false");
    logger.info(SCRAPER_SCOPE, "DOM profile scraper flag", { enabled });
  };


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

  const initFeatureFlags = () => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local?.get) {
      applyLogLevel(null);
      applyDomProfileScraperFlag(true);
      return;
    }

    chrome.storage.local.get([LOG_LEVEL_STORAGE_KEY, DOM_PROFILE_SCRAPER_FLAG_KEY], (result) => {
      applyLogLevel(result?.[LOG_LEVEL_STORAGE_KEY]);
      applyDomProfileScraperFlag(result?.[DOM_PROFILE_SCRAPER_FLAG_KEY]);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes?.[LOG_LEVEL_STORAGE_KEY]) {
        applyLogLevel(changes[LOG_LEVEL_STORAGE_KEY].newValue);
      }
      if (changes?.[DOM_PROFILE_SCRAPER_FLAG_KEY]) {
        applyDomProfileScraperFlag(changes[DOM_PROFILE_SCRAPER_FLAG_KEY].newValue);
      }
    });
  };

  logger.info(LOG_SCOPE, "Démarrage du Content Script...");
  initFeatureFlags();
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
      logger.error(MSG_SCOPE, "Erreur data", e);
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
      logger.warn(NAV_SCOPE, "getCleanUrl failed", err?.message || err);
      return (url || "").replace(/[?#].*$/, "").replace(/\/$/, "");
    }
  };

  const mergeExperienceDetails = (profile, detailsPayload) => {
    if (!profile || !detailsPayload) return profile;
    const detailsExperiences = Array.isArray(detailsPayload.experiences)
      ? detailsPayload.experiences
      : [];
    if (!detailsExperiences.length) return profile;

    const normalizeKey = (exp) =>
      [exp?.title, exp?.company, exp?.dates, exp?.location]
        .map((val) => (val || "").toString().trim().toLowerCase())
        .join("||");

    const nextExperiences = Array.isArray(profile.experiences) ? [...profile.experiences] : [];
    const indexByKey = new Map(nextExperiences.map((exp, idx) => [normalizeKey(exp), idx]));

    for (const detail of detailsExperiences) {
      const enriched = {
        title: detail.title || null,
        company: detail.company || null,
        dates: detail.dates || null,
        location: detail.location || null,
        workplaceType: detail.workplaceType || null,
        description: detail.description || null,
        descriptionBullets: detail.descriptionBullets || null,
        skills: Array.isArray(detail.skills) ? detail.skills : [],
        skillsMoreCount: detail.skillsMoreCount ?? null,
        skillsText: Array.isArray(detail.skills) ? detail.skills.join(" · ") : null,
        start: null,
        end: null,
      };
      const key = normalizeKey(enriched);
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, nextExperiences.length);
        nextExperiences.push(enriched);
      } else {
        const current = nextExperiences[existingIndex] || {};
        nextExperiences[existingIndex] = {
          ...current,
          ...enriched,
          description: enriched.description || current.description || null,
          descriptionBullets: enriched.descriptionBullets || current.descriptionBullets || null,
          skills: enriched.skills.length ? enriched.skills : current.skills || [],
          skillsText: enriched.skillsText || current.skillsText || null,
          skillsMoreCount: enriched.skillsMoreCount ?? current.skillsMoreCount ?? null,
        };
      }
    }

    return {
      ...profile,
      experiences: nextExperiences,
      __detailsEnriched: true,
      debug: {
        ...(profile.debug || {}),
        detailsEnriched: true,
        experienceDetailsCount: detailsExperiences.length,
      },
    };
  };

  const initExperienceDetailsScraper = async () => {
    const moduleUrl = chrome.runtime.getURL("src/scrape/ExperienceDetailsScraper.js");
    return import(moduleUrl)
      .then((detailsModule) => {
        detailsModule.installExperienceDetailsScraper({
          onScrapeDone: async (payload) => {
            const publicIdentifier = payload?.publicIdentifier;
            if (!publicIdentifier) return;

            const stored = await chrome.storage.local.get(["FOCALS_LAST_PROFILE"]);
            const profile = stored?.FOCALS_LAST_PROFILE;
            if (!profile) return;

            const profileId = detailsModule.getPublicIdentifierFromUrl(profile.linkedin_url || "");
            if (!profileId || profileId !== publicIdentifier) return;

            const merged = mergeExperienceDetails(profile, payload);
            const cleanUrl = getCleanUrl(profile.linkedin_url || "");
            const cacheKey = cleanUrl ? `focals_last_result:${cleanUrl}` : null;
            const writePayload = { FOCALS_LAST_PROFILE: merged };
            if (cacheKey) {
              writePayload[cacheKey] = { payload: merged, ts: Date.now() };
            }
            await chrome.storage.local.set(writePayload);
            logger.info(SCRAPER_SCOPE, "Experience details merged into profile", {
              publicIdentifier,
              experiences: merged.experiences?.length ?? 0,
            });
          },
        });
      })
      .catch((err) => {
        logger.error(SCRAPER_SCOPE, "Experience details scraper init failed", err?.message || err);
      });
  };

  initExperienceDetailsScraper();

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
        logger.warn(SCRAPER_SCOPE, "scraper missing on window.FOCALS");
        sendResponse({ ok: false, error: "SCRAPER_MISSING" });
      }
    } catch (err) {
      logger.warn(SCRAPER_SCOPE, "trigger scrape failed", err?.message || err);
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
        logger.warn(SCRAPER_SCOPE, `Tentative ${attempt}/${maxRetries} échouée, retry...`);
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
        logger.info(NAV_SCOPE, `Recherche d'identité (Tentative ${attempt}/${maxAttempts})...`);
        const ids = extractLinkedinIds();

        if (ids) {
          window._focalsCurrentCandidateId = ids.linkedin_internal_id;
          logger.info(LOG_SCOPE, `MAPPING RÉUSSI : ${ids.linkedin_internal_id}`);

          try {
            await chrome.storage.local.set({
              current_linkedin_id: ids.linkedin_internal_id,
              current_profile_name: ids.name,
            });
          } catch (err) {
            logger.warn(LOG_SCOPE, "Erreur storage local", err);
          }

          try {
            await sendMessageWithRetry({
              type: "SAVE_PROFILE_TO_SUPABASE",
              profile: ids,
            });
          } catch (err) {
            logger.warn(LOG_SCOPE, "Background injoignable (normal si service worker endormi)", err.message);
          }

          // Déclenchement automatique du scraper d'expériences
          setTimeout(() => {
            if (window.FOCALS && typeof window.FOCALS.run === "function") {
              logger.info(SCRAPER_SCOPE, "Lancement automatique du scraper d'expériences...");
              window.FOCALS.run();
            } else {
              logger.warn(SCRAPER_SCOPE, "Le scraper (linkedinSduiScraper.js) n'est toujours pas détecté sur window.");
            }
          }, 1000);
          return;
        }

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      logger.warn(NAV_SCOPE, "Impossible de trouver l'ID technique après 5 tentatives.");
    } catch (e) {
      logger.warn(SCRAPER_SCOPE, "Erreur lors du scraping profil", e);
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

  logger.info(LOG_SCOPE, "Content Script prêt et actif");
})();
