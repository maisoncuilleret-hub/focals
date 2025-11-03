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
      getText(q(".pv-text-details__left-panel h1")) ||
      getText(q(".text-heading-xlarge")) ||
      getText(q(".inline.t-24.t-black.t-normal.break-words")) ||
      "";

    const headline =
      getText(q(".pv-text-details__left-panel .text-body-medium.break-words")) ||
      getText(q(".text-body-medium.break-words")) ||
      "";

    const localisation =
      getText(q(".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words")) ||
      getText(q(".text-body-small.inline.t-black--light.break-words")) ||
      "";

    const photo_url =
      getAttr(q(".pv-top-card-profile-picture__image"), "src") ||
      getAttr(q("img.pv-top-card-profile-picture__image--show"), "src") ||
      getAttr(q('meta[property="og:image"]'), "content") ||
      "";

    // On récupère la première expérience visible
    let current_title = "";
    let current_company = "";
    let contract = "";

    const expBlock = q("section[id*='experience'] ul") || q(".pvs-list__outer-container");
    if (expBlock) {
      const first = expBlock.querySelector("li") || expBlock.querySelector(".pvs-entity");
      if (first) {
        current_title =
          getText(first.querySelector(".mr1.t-bold span[aria-hidden='true']")) ||
          getText(first.querySelector(".t-bold span[aria-hidden='true']")) ||
          "";

        current_company =
          getText(first.querySelector(".t-14.t-normal span[aria-hidden='true']")) ||
          getText(first.querySelector(".t-normal.t-black--light span[aria-hidden='true']")) ||
          "";

        // Détection contrat
        const textLower = first.innerText.toLowerCase();
        if (/\bcdi\b/.test(textLower)) contract = "CDI";
        else if (/freelance|indépendant|independant/.test(textLower)) contract = "Freelance";
        else if (/\bstage\b/.test(textLower)) contract = "Stage";
        else if (/\balternance\b/.test(textLower)) contract = "Alternance";
      }
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

