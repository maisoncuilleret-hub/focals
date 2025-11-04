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
  const pickAttr = (selectors, attr) => {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = q(selector);
      if (el) {
        const value = el.getAttribute(attr);
        if (value) {
          return value.trim();
        }
      }
    }
    return "";
  };
  const pickTextFrom = (root, selectors) => {
    if (!root) return "";
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = root.querySelector(selector);
      const text = getText(el);
      if (text) {
        return text;
      }
    }
    return "";
  };
  const pickRoleText = (node) => {
    if (!node) return "";
    const fromSelectors = pickTextFrom(node, [
      ".display-flex.full-width .hoverable-link-text span[aria-hidden='true']",
      ".hoverable-link-text span[aria-hidden='true']",
      ".hoverable-link-text",
      ".t-bold span[aria-hidden='true']",
      ".t-bold",
    ]);
    if (fromSelectors) {
      return fromSelectors;
    }
    const bolds = node.querySelectorAll(".t-bold");
    for (const bold of bolds) {
      const text = getText(bold);
      if (text) {
        return text;
      }
    }
    return "";
  };
  const pickCompanyText = (node) => {
    if (!node) return "";
    const anchor = node.querySelector("a[data-field='experience_company_logo']");
    if (anchor) {
      const anchorCandidates = anchor.querySelectorAll(".t-14.t-normal");
      for (const candidate of anchorCandidates) {
        if (candidate.classList.contains("t-black--light")) continue;
        const text = getText(candidate);
        if (text) {
          return text;
        }
      }
      const ariaText = anchor.getAttribute("aria-label");
      if (ariaText) {
        return ariaText.trim();
      }
    }

    const candidates = node.querySelectorAll(".t-14.t-normal");
    for (const candidate of candidates) {
      if (candidate.classList.contains("t-black--light")) continue;
      const text = getText(candidate);
      if (text) {
        return text;
      }
    }

    return pickTextFrom(node, [
      "a[data-field='experience_company_logo'] span[aria-hidden='true']",
      "a[data-field='experience_company_logo']",
    ]);
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
  const findExperienceSection = () => {
    const anchor = q("#experience");
    if (anchor) {
      const section = anchor.closest("section");
      if (section) {
        return section;
      }
    }
    const cards = Array.from(document.querySelectorAll("section.artdeco-card"));
    for (const card of cards) {
      const heading = pickTextFrom(card, ["h2 span[aria-hidden='true']", "h2"]);
      if (heading && /expérience/i.test(heading)) {
        return card;
      }
    }
    return null;
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
    const rawName =
      pickText(
        ".pv-text-details__left-panel h1",
        "div[data-view-name='profile-card'] h1",
        "main section h1.inline.t-24.v-align-middle.break-words",
        "h1.inline.t-24.v-align-middle.break-words",
        "a[href*='/overlay/about-this-profile/'] h1",
        ".text-heading-xlarge",
        "h1"
      ) ||
      pickAttr([
        "a[href*='/overlay/about-this-profile/']",
        "a[href*='overlay/about-this-profile']",
        "a[href*='/overlay/contact-info/']",
      ], "aria-label") ||
      "";
    const name = rawName.replace(/\s+/g, " ").trim();

    const headline =
      pickText(
        ".pv-text-details__left-panel .text-body-medium.break-words",
        ".text-body-medium.break-words",
        "div[data-view-name='profile-card'] .text-body-medium",
        ".display-flex.full-width .hoverable-link-text span[aria-hidden='true']",
        ".display-flex.full-width .hoverable-link-text"
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
    const topCardCompanyRaw =
      pickText(
        ".pv-text-details__left-panel .inline.t-16.t-black.t-normal span[aria-hidden='true']",
        ".pv-text-details__left-panel .inline.t-16.t-black.t-normal",
        ".display-flex.full-width .t-14.t-normal span[aria-hidden='true']",
        ".display-flex.full-width .t-14.t-normal",
        "div[data-view-name='profile-card'] .t-14.t-normal span[aria-hidden='true']",
        "div[data-view-name='profile-card'] .t-14.t-normal"
      ) ||
      pickAttr(
        [
          "div[data-view-name='profile-card'] a[href*='/company/']",
          "div[data-view-name='profile-card'] a[href*='/school/']",
          ".pv-text-details__left-panel a[href*='/company/']",
        ],
        "aria-label"
      );
    const topCardCompany = parseCompanyAndContract(topCardCompanyRaw);
    let current_company = topCardCompany.company;
    let contract = topCardCompany.contract;

    const experienceSection = findExperienceSection();
    if (experienceSection) {
      const listItems = Array.from(experienceSection.querySelectorAll("ul li"));
      let firstEntity = null;
      for (const item of listItems) {
        const entity = item.querySelector("[data-view-name='profile-component-entity']");
        if (entity) {
          firstEntity = entity;
          break;
        }
      }
      if (!firstEntity) {
        firstEntity = experienceSection.querySelector("[data-view-name='profile-component-entity']");
      }

      if (firstEntity) {
        const multiRoleItem = firstEntity.querySelector(
          ".pvs-entity__sub-components ul li"
        );
        const roleNode = multiRoleItem || firstEntity;
        const roleText = pickRoleText(roleNode);
        const companyText = pickCompanyText(firstEntity) || pickCompanyText(roleNode);
        const parsedCompany = parseCompanyAndContract(companyText);

        if (roleText) {
          current_title = roleText;
        }

        if (parsedCompany.company) {
          current_company = parsedCompany.company;
        } else if (companyText) {
          current_company = companyText;
        }

        const contractFromCompany = parsedCompany.contract;
        const contractFromRoleBlock = detectContract(
          (multiRoleItem && multiRoleItem.innerText) || firstEntity.innerText || ""
        );

        if (!contract) {
          contract = contractFromCompany || contractFromRoleBlock || contract;
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

