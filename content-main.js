(() => {
  if (window.__FOCALS_CONTENT_MAIN_LOADED__) {
    console.log("[Focals] content-main.js already initialized");
    return;
  }
  window.__FOCALS_CONTENT_MAIN_LOADED__ = true;

  console.log("[Focals] Safe content-main.js loaded");

  // Simple sélecteurs
  const q = (s) => document.querySelector(s);
  const getText = (el) => (el ? el.innerText.trim() : "");
  const getAttr = (el, attr) => (el ? el.getAttribute(attr) : "");
  const pickText = (...selectors) => {
    for (const selector of selectors) {
      const text = getText(q(selector));
      if (text) {
        return text;
      }
    }
    return "";
  };
  const detectContract = (text) => {
    const normalized = (text || "").toLowerCase();
    if (/\bcdi\b/.test(normalized)) return "CDI";
    if (/\bcdd\b/.test(normalized)) return "CDD";
    if (/freelance|indépendant|independant/.test(normalized)) return "Freelance";
    if (/\bstage\b/.test(normalized)) return "Stage";
    if (/alternance/.test(normalized)) return "Alternance";
    return "";
  };
  const parseCompanyAndContract = (rawText) => {
    const trimmed = (rawText || "").trim();
    if (!trimmed) {
      return { company: "", contract: "" };
    }
    const parts = trimmed.split("·").map((part) => part.trim()).filter(Boolean);
    let company = parts[0] || trimmed;
    let contract = "";
    for (const part of parts.slice(1)) {
      const detected = detectContract(part);
      if (detected) {
        contract = detected;
        break;
      }
    }
    if (!contract) {
      contract = detectContract(trimmed);
    }
    return { company, contract };
  };

  // === Listener ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "GET_CANDIDATE_DATA") {
      try {
        const data = scrapePublicProfile();
        console.log("[Focals] Scraped data:", data);
        sendResponse({ data });
      } catch (e) {
        console.error("[Focals] scrape error", e);
        sendResponse({ error: e.message });
      }
    }
  });

  // === Scraper profil public /in/ ===
  function scrapePublicProfile() {
    const name =
      pickText(
        ".pv-text-details__left-panel h1",
        "div[data-view-name='profile-card'] h1",
        "main section h1.inline.t-24.v-align-middle.break-words",
        "h1.inline.t-24.v-align-middle.break-words",
        ".text-heading-xlarge",
        "h1"
      ) || "";

    const headline =
      pickText(
        ".pv-text-details__left-panel .text-body-medium.break-words",
        ".text-body-medium.break-words",
        "div[data-view-name='profile-card'] .text-body-medium",
        ".display-flex.full-width .hoverable-link-text span[aria-hidden='true']"
      ) || "";

    const localisation =
      getText(q(".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words")) ||
      getText(q(".text-body-small.inline.t-black--light.break-words")) ||
      getText(q("div[data-view-name='profile-card'] .text-body-small")) ||
      "";

    const photo_url =
      getAttr(q(".pv-top-card-profile-picture__image"), "src") ||
      getAttr(q("img.pv-top-card-profile-picture__image--show"), "src") ||
      getAttr(q('meta[property="og:image"]'), "content") ||
      "";

    // On récupère la première expérience visible
    let current_title = headline || "";
    const topCardCompanyRaw = pickText(
      ".pv-text-details__left-panel .inline.t-16.t-black.t-normal span[aria-hidden='true']",
      ".pv-text-details__left-panel .inline.t-16.t-black.t-normal",
      ".display-flex.full-width .t-14.t-normal span[aria-hidden='true']",
      ".display-flex.full-width .t-14.t-normal",
      "div[data-view-name='profile-card'] .t-14.t-normal span[aria-hidden='true']"
    );
    const topCardCompany = parseCompanyAndContract(topCardCompanyRaw);
    let current_company = topCardCompany.company;
    let contract = topCardCompany.contract;

    const expBlock = q("section[id*='experience'] ul") || q(".pvs-list__outer-container");
    if (expBlock) {
      const first = expBlock.querySelector("li") || expBlock.querySelector(".pvs-entity");
      if (first) {
        if (!current_title) {
          current_title =
            getText(first.querySelector(".mr1.t-bold span[aria-hidden='true']")) ||
            getText(first.querySelector(".t-bold span[aria-hidden='true']")) ||
            "";
        }

        if (!current_company) {
          current_company =
            getText(first.querySelector(".t-14.t-normal span[aria-hidden='true']")) ||
            getText(first.querySelector(".t-normal.t-black--light span[aria-hidden='true']")) ||
            "";
        }

        // Détection contrat
        const contractFromExp = detectContract(first.innerText);
        if (!contract && contractFromExp) {
          contract = contractFromExp;
        }
      }
    }

    if (!contract) {
      contract = detectContract(current_company);
    }

    // Nettoyage
    const [firstName, ...rest] = (name || "").split(/\s+/);
    const lastName = rest.join(" ").trim();

    return {
      name: name || "—",
      current_title: current_title || headline || "—",
      current_company: current_company || "—",
      contract: contract || "—",
      localisation: localisation || "—",
      linkedin_url: location.href || "—",
      photo_url: photo_url || "",
      firstName,
      lastName,
    };
  }
})();

