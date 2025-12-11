// ============================================================================
// [FOCALS] SCRAPER V4 - FINAL & CONNECTÉ UI
// ============================================================================

const triggerProfileScrape = async (force = false) => {
  console.log("%c[FOCALS] Scraper V4 (UI Fix) - Démarrage...", "background: #d32f2f; color: white; font-weight: bold; padding: 4px;");

  // 1. Fonction d'attente (max 5s)
  const waitForElement = (selector, timeout = 5000) => {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) return resolve(document.querySelector(selector));
      const observer = new MutationObserver((mutations, obs) => {
        if (document.querySelector(selector)) { obs.disconnect(); resolve(document.querySelector(selector)); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
  };

  try {
    // 2. On attend le Nom (Preuve que la page est prête)
    const nameEl = await waitForElement("h1, .text-heading-xlarge");
    if (!nameEl) console.warn("[FOCALS] ⚠️ Nom introuvable (on continue quand même).");

    // Pause de sécurité pour React
    await new Promise(r => setTimeout(r, 1000)); 

    const main = document.querySelector("main") || document.body;
    const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";

    // --- HELPERS (Contrats & Entreprises) ---
    const detectContract = (text) => {
        if (!text) return "";
        const lower = text.toLowerCase();
        if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
        if (lower.includes("cdd") || lower.includes("contract")) return "CDD";
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

    // --- LOGIQUE HÉRITAGE PARENT (Le fix Carrefour/KPMG) ---
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

    // --- 3. SCRAPING EXPÉRIENCES ---
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
            
            // Entreprise & Contrat (Logique combinée)
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

            // Nettoyage date
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

    // --- 4. RÉCUPÉRATION IMAGE & INFOS GLOBALES ---
    const imgEl = document.querySelector("img.pv-top-card-profile-picture__image--show") || 
                  document.querySelector(".pv-top-card-profile-picture__image") || 
                  document.querySelector("img[class*='profile-picture']");

    const result = {
      name: nameEl ? cleanText(nameEl.innerText) : document.title.split("|")[0].trim(),
      headline: document.querySelector(".text-body-medium")?.innerText.trim() || "",
      localisation: document.querySelector(".text-body-small.inline")?.innerText.trim() || "",
      profileImageUrl: imgEl ? imgEl.src : "", // CRUCIAL pour l'UI
      experiences: experiences,
      current_job: experiences[0] || {},
      linkedinProfileUrl: window.location.href.split("?")[0],
      source: "focals-scraper-v4"
    };
    
    // Compatibilité rétroactive stricte
    result.current_company = result.current_job.company || "—";

    console.log("%c[FOCALS] ✅ DATA READY :", "background: green; color: white;", result);

    // --- 5. ENVOI DES DONNÉES À L'UI (Sauvegarde + Appel Direct) ---
    
    // A. Sauvegarde Standard
    chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result }, () => {
        console.log("[FOCALS] Saved to Storage.");
    });

    // B. Appel Direct aux fonctions UI connues (Si elles existent dans la page)
    try {
        if (typeof updateFocalsPanel === 'function') {
            console.log("[FOCALS] 🚀 Appel direct updateFocalsPanel()");
            updateFocalsPanel(result);
        } else if (typeof mountFocalsSidebar === 'function') {
            console.log("[FOCALS] 🚀 Appel direct mountFocalsSidebar()");
            mountFocalsSidebar(result);
        } else {
            console.log("[FOCALS] ⚠️ Aucune fonction UI globale trouvée. Le listener storage devrait prendre le relais.");
        }
    } catch(err) {
        console.error("Erreur appel UI:", err);
    }

    return result;

  } catch (e) {
    console.error("[FOCALS] 💥 CRASH:", e);
    return null;
  }
};
