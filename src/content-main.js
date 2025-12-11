// ============================================================================
// [FOCALS] CONTENT SCRIPT MAIN - COMPLET (Scraper V4 + Listeners)
// ============================================================================

console.log("%c[FOCALS] Content Script Loaded & Ready", "background: #0077b5; color: white; padding: 4px; font-weight: bold;");

// --- 1. FONCTION DE SCRAPING (Moteur V4) ---
window.triggerProfileScrape = async (force = false) => {
  console.log("%c[FOCALS] 🚀 Lancement du Scraper V4...", "color: #0077b5; font-weight: bold;");

  const waitForElement = (selector, timeout = 5000) => {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver((mutations, obs) => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
  };

  try {
    // A. Vérification de la page
    const nameEl = await waitForElement("h1, .text-heading-xlarge");
    if (!nameEl) console.warn("[FOCALS] ⚠️ Nom introuvable (Scan continué).");

    // Pause technique (Laisse React finir son rendu)
    await new Promise(r => setTimeout(r, 1500));

    const main = document.querySelector("main") || document.body;
    const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";

    // B. Helpers d'analyse
    const detectContract = (text) => {
        if (!text) return "";
        const lower = text.toLowerCase();
        if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
        if (lower.includes("cdd") || lower.includes("contract") || lower.includes("determiné")) return "CDD";
        if (lower.includes("freelance") || lower.includes("indépendant")) return "Freelance";
        if (lower.includes("stage") || lower.includes("internship")) return "Stage";
        if (lower.includes("alternance") || lower.includes("apprenti") || lower.includes("professionalisation")) return "Alternance";
        return "";
    };

    const getCompanyFromLogo = (container) => {
        const img = container.querySelector("img[alt^='Logo de'], img[alt^='Logo']");
        if (img && img.alt) return img.alt.replace("Logo de ", "").replace("Logo ", "").trim();
        return "";
    };

    const getParentHeaderData = (liElement) => {
        const parentUl = liElement.closest("ul");
        if (!parentUl) return {};
        const headerDiv = parentUl.previousElementSibling;
        if (!headerDiv) return {};

        let company = getCompanyFromLogo(headerDiv);
        if (!company) {
             const p = headerDiv.querySelector("div > div > div > p");
             if (p) company = cleanText(p.innerText);
        }
        
        const headerTexts = [...headerDiv.querySelectorAll("p, span")].map(el => el.innerText);
        let contract = "";
        let location = "";
        headerTexts.forEach(txt => {
            if (!contract) contract = detectContract(txt);
            if (!location && (txt.includes("France") || txt.includes("Paris") || txt.includes("Région"))) location = txt;
        });

        return { company, contract, location };
    };

    // C. Extraction des Expériences
    const allSections = [...main.querySelectorAll("section")];
    const expSection = allSections.find(sec => {
        const h2 = sec.querySelector("h2");
        return h2 && /exp[ée]rience/i.test(h2.innerText);
    });

    let experiences = [];
    if (expSection) {
        const items = [...expSection.querySelectorAll("ul > li")];
        experiences = items.map((item) => {
            const localParagraphs = [...item.querySelectorAll("p, span[aria-hidden='true']")];
            const localTexts = localParagraphs.map(p => cleanText(p.innerText)).filter(t => t.length > 0);
            const inherited = getParentHeaderData(item);

            let title = localTexts[0] || "";
            
            let company = inherited.company; 
            if (!company) company = getCompanyFromLogo(item);
            if (!company && localTexts[1] && !localTexts[1].match(/\d{4}/)) company = localTexts[1];

            let contract = inherited.contract;
            if (!contract) localTexts.forEach(t => { if (!contract) contract = detectContract(t); });

            let dateRange = "";
            let location = inherited.location || "";
            localTexts.forEach(txt => {
                if ((txt.match(/\d{4}/) || txt.toLowerCase().includes("aujourd’hui") || txt.toLowerCase().includes("present")) && !dateRange) dateRange = txt;
                if (!location && (txt.includes("France") || txt.includes("Paris") || txt.includes("Région"))) location = txt;
            });

            if (dateRange && dateRange.includes("·")) {
                const parts = dateRange.split("·").map(s => s.trim());
                if (detectContract(parts[0])) dateRange = parts.filter(p => !detectContract(p)).join(" · ");
            }

            if (!title) return null;
            return {
                title,
                company: company || "Entreprise inconnue",
                contract_type: contract || "Non spécifié",
                dates: dateRange,
                location: location,
                description: item.innerText
            };
        }).filter(Boolean);
    }

    // D. Image de profil (Crucial pour l'UI)
    const imgEl = document.querySelector("img.pv-top-card-profile-picture__image--show") || 
                  document.querySelector(".pv-top-card-profile-picture__image") || 
                  document.querySelector("img[class*='profile-picture']");

    // E. Construction de l'objet Final
    const result = {
      name: nameEl ? cleanText(nameEl.innerText) : document.title.split("|")[0].trim(),
      headline: document.querySelector(".text-body-medium")?.innerText.trim() || "",
      localisation: document.querySelector(".text-body-small.inline")?.innerText.trim() || "",
      profileImageUrl: imgEl ? imgEl.src : "https://via.placeholder.com/150", // Fallback image
      experiences: experiences,
      current_job: experiences[0] || {},
      current_company: experiences[0]?.company || "—",
      linkedinProfileUrl: window.location.href.split("?")[0],
      source: "focals-scraper-v4-complete"
    };

    console.log("%c[FOCALS] ✅ SCRAPING TERMINÉ :", "background: green; color: white;", result);

    // F. Sauvegarde & Envoi UI
    chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result }, () => {
        console.log("[FOCALS] Données sauvegardées dans le Storage.");
    });
    
    // Tentative d'appel direct si l'UI est injectée dans le DOM
    if (window.updateFocalsPanel) window.updateFocalsPanel(result);

    return result;

  } catch (e) {
    console.error("[FOCALS] 💥 Erreur Critique Scraper:", e);
    return null;
  }
};

// --- 2. GESTIONNAIRE D'ÉVÉNEMENTS (LISTENERS) ---
// C'est ça qui manquait ! Sans ça, le popup ne peut pas déclencher le scraper.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[FOCALS] 📩 Message reçu:", request);

  if (request.action === "SCRAPE_PROFILE") {
    triggerProfileScrape(true).then(data => {
      sendResponse({ status: "success", data: data });
    });
    return true; // Indique que la réponse est asynchrone
  }

  if (request.action === "PING") {
    sendResponse({ status: "pong" });
  }
});

// --- 3. AUTO-START (POUR TESTER) ---
// Force le scan 3 secondes après le chargement pour voir si ça marche sans cliquer
setTimeout(() => {
    console.log("[FOCALS] ⏱️ Auto-start du scraping pour test...");
    triggerProfileScrape();
}, 3000);
