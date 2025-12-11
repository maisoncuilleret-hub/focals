// =============================================================================
// [FOCALS] CONTENT SCRIPT V13 - PRODUCTION (Timing fix + Résilience)
// =============================================================================

if (window !== window.top) {
  // Ignore iframes entirely
} else {
  console.log(
    "%c[FOCALS] Scraper V13 (Production Finale) - Loaded",
    "background: #008080; color: white; padding: 4px; font-weight: bold;",
  );

  window.triggerProfileScrape = async (force = false) => {
    console.log(
      "%c[FOCALS] 🚀 Lancement du Scraper V13...",
      "color: #008080; font-weight: bold;",
    );

    const waitForElement = (selector, timeout = 5000) =>
      new Promise((resolve) => {
        const check = () => {
          const el = document.querySelector(selector);
          if (el && el.innerText.trim().length > 0) {
            resolve(el);
            return true;
          }
          return false;
        };

        if (check()) return;

        const observer = new MutationObserver(() => {
          if (check()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
          observer.disconnect();
          resolve(document.querySelector(selector));
        }, timeout);
      });

    const waitForExperienceSection = (timeout = 8000) =>
      new Promise((resolve) => {
        const main = document.querySelector("main") || document.body;
        let observer;

        const check = () => {
          const potentialContainers = [
            ...main.querySelectorAll(
              "section, div[componentkey*='ExperienceTopLevelSection'], div[data-view-name*='experience']",
            ),
          ];

          const foundSection = potentialContainers.find((el) => {
            const titleElement = el.querySelector(
              "h2, .pvs-header__title, .text-heading-large",
            );
            return titleElement && /exp[ée]rience/i.test(titleElement.innerText);
          });

          if (foundSection) {
            if (observer) observer.disconnect();
            resolve(foundSection);
            return true;
          }
          return false;
        };

        observer = new MutationObserver(check);
        if (main) observer.observe(main, { childList: true, subtree: true });

        check();

        setTimeout(() => {
          if (observer) observer.disconnect();
          resolve(null);
        }, timeout);
      });

    try {
      if (!window.location.href.includes("/in/")) {
        console.log("[FOCALS] Pas sur un profil (/in/), abandon.");
        return null;
      }

      const nameEl = await waitForElement("h1, .text-heading-xlarge");
      if (!nameEl) {
        console.warn(
          "%c[FOCALS] ⚠️ Nom non détecté après timeout. Continuation...",
          "color:orange;",
        );
      }

      const expSection = await waitForExperienceSection();
      if (!expSection) {
        console.warn(
          "%c[FOCALS] ❌ Section Expérience introuvable après timeout. Skip.",
          "color: red;",
        );
        return null;
      }

      console.log("✅ Section Expérience trouvée. Démarrage du parsing.");

      const cleanText = (txt) => (txt ? txt.replace(/\s+/g, " ").trim() : "");

      const detectContract = (text) => {
        if (!text) return "";
        const lower = text.toLowerCase();
        if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
        if (lower.includes("cdd") || lower.includes("contract") || lower.includes("fixed-term")) return "CDD";
        if (lower.includes("freelance") || lower.includes("indépendant") || lower.includes("self-employed")) return "Freelance";
        if (lower.includes("stage") || lower.includes("internship")) return "Stage";
        if (
          lower.includes("alternance") ||
          lower.includes("apprenti") ||
          lower.includes("apprentissage") ||
          lower.includes("professionalisation")
        )
          return "Alternance";
        return "";
      };

      const isDateRange = (text) => {
        const lower = text.toLowerCase();
        if (
          lower.match(
            /janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|jan|fev|mar|avr|mai|juin|juil|aou|sep|oct|nov|dec/i,
          )
        )
          return true;
        if (lower.match(/aujourd’hui|present|current/i)) return true;
        if (lower.match(/\d{4} - \d{4}|\d{4} - aujourd’hui/i)) return true;
        if (lower.match(/\d+ (an|ans|mois|mo|yr|yrs)/i)) return true;
        return false;
      };

      const isLocation = (text) => {
        const lower = text.toLowerCase();
        if (lower.match(/paris|france|région|region|états-unis|usa|californie|london|uk|canada|montréal|montreal/)) return true;
        if (lower.includes("remote") || lower.includes("à distance")) return true;
        return false;
      };

      const getCompanyFromLogo = (container) => {
        const img = container.querySelector("img[alt^='Logo de'], img[alt^='Logo']");
        if (img && img.alt) return img.alt.replace("Logo de ", "").replace("Logo ", "").trim();
        return "";
      };

      const topLevelItems = [...expSection.querySelectorAll('[componentkey^="entity-collection-item"], ul > li')];
      const allItems = [];
      const processedItems = new Set();

      for (const item of topLevelItems) {
        if (processedItems.has(item)) continue;

        const subRoles = item.querySelectorAll("ul > li");
        if (subRoles.length > 0) {
          let companyName = "Entreprise Groupée";
          const headerContainer = item.querySelector("div:first-child");
          if (headerContainer) {
            companyName =
              getCompanyFromLogo(headerContainer) ||
              cleanText(headerContainer.querySelector("p")?.innerText) ||
              cleanText(headerContainer.querySelector("span")?.innerText) ||
              companyName;
          }

          for (const subItem of subRoles) {
            if (processedItems.has(subItem)) continue;
            subItem.setAttribute("data-focals-inherited-company", companyName);
            allItems.push(subItem);
            processedItems.add(subItem);
          }
          processedItems.add(item);
        } else {
          if (item.querySelector("h3, p, .t-bold")) {
            allItems.push(item);
          }
          processedItems.add(item);
        }
      }

      console.log(
        `%c[FOCALS] 🔎 ${allItems.length} rôles individuels détectés après traitement d'héritage.`,
        "color: yellowgreen;",
      );

      const textSelectors = "h3, .t-bold, .text-body-medium, span[aria-hidden='true'], p, span";

      const experiences = allItems
        .map((item) => {
          let company = getCompanyFromLogo(item);
          if (!company) company = item.getAttribute("data-focals-inherited-company");

          const texts = item.innerText;
          if (texts.includes("Self-employed") && !company) company = "Self-employed";
          if (texts.includes("Indépendant") && !company) company = "Indépendant";
          if (!company) company = "Non détectée";

          let title = "";
          let contract = "";
          let dates = "";
          let location = "";

          const localElements = [...item.querySelectorAll(textSelectors)];
          const localTexts = localElements
            .map((p) => cleanText(p.innerText))
            .filter((t) => t.length > 0 && t !== company && t !== item.getAttribute("aria-label"));

          if (localTexts.length === 0) return null;

          const candidates = [...localTexts];

          for (let i = 0; i < candidates.length; i += 1) {
            const text = candidates[i];
            const detectedContract = detectContract(text);

            if (detectedContract && !contract) contract = detectedContract;
            if (isDateRange(text) && !dates) dates = text;
            if (isLocation(text) && !location) location = text;

            if (!title) {
              const isMetadata = isDateRange(text) || detectedContract || text === company;
              if (i < 2 && !isMetadata && text.length > 5 && text.length < 100) {
                title = text;
              }
            }
          }

          if (!title)
            title =
              localTexts.find(
                (t) => t.length > 5 && !isDateRange(t) && !detectContract(t) && !isLocation(t) && t !== company,
              ) || "Titre inconnu";

          if (title.length > 150) {
            title = `${title.substring(0, 150)}...`;
          }

          if (title === company && candidates.length > 1) {
            const nextTitle = candidates.find(
              (t) => t !== company && !isDateRange(t) && !detectContract(t) && !isLocation(t),
            );
            if (nextTitle) title = nextTitle;
          }

          return {
            title,
            company,
            contract_type: contract || "Non spécifié",
            dates,
            location,
            description: `${item.innerText.substring(0, 150)}...`,
          };
        })
        .filter(Boolean);

      const imgEl =
        document.querySelector("img.pv-top-card-profile-picture__image--show") ||
        document.querySelector(".pv-top-card-profile-picture__image") ||
        document.querySelector("img[class*='profile-picture']");

      const mainEl = document.querySelector("main") || document.body;

      const result = {
        name: nameEl
          ? cleanText(nameEl.innerText)
          : cleanText(mainEl.querySelector("h1")?.innerText || document.title.split("|")[0]),
        headline: document.querySelector(".text-body-medium")?.innerText.trim() || "",
        localisation: document.querySelector(".text-body-small.inline")?.innerText.trim() || "",
        profileImageUrl: imgEl ? imgEl.src : "",
        experiences,
        current_job: experiences[0] || {},
        current_company: experiences[0]?.company || "—",
        linkedinProfileUrl: window.location.href.split("?")[0],
        source: "focals-scraper-v13-production",
      };

      console.log(
        `%c[FOCALS] ✅ SCRAPING TERMINÉ. Experiences trouvées: ${experiences.length}`,
        "background: green; color: white;",
        result,
      );

      chrome.storage.local.set({ FOCALS_LAST_PROFILE: result });

      if (window.updateFocalsPanel && typeof window.updateFocalsPanel === "function") {
        window.updateFocalsPanel(result);
      }

      return result;
    } catch (e) {
      console.error("[FOCALS] 💥 CRASH V13:", e);
      return null;
    }
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SCRAPE_PROFILE") {
      triggerProfileScrape(true).then((data) => sendResponse({ status: "success", data }));
      return true;
    }
    if (request.action === "PING") sendResponse({ status: "pong" });
    return false;
  });

  setTimeout(() => {
    triggerProfileScrape();
  }, 3500);
}
