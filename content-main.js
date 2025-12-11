// ============================================================================
// [FOCALS] CONTENT SCRIPT V6 - LE FIX FINAL (Logique V3 + Stabilité V5)
// ============================================================================

// 1. SÉCURITÉ : Bloque l'exécution dans les iframes (pub, notif, etc.)
if (window !== window.top) {
    // Si on n'est pas sur la fenêtre principale, on ne fait rien.
} else {

    console.log("%c[FOCALS] Scraper V6 (Logique Stable) - Loaded", "background: #0077b5; color: white; padding: 4px; font-weight: bold;");

    window.triggerProfileScrape = async (force = false) => {
      console.log("%c[FOCALS] 🚀 Lancement du Scraper...", "color: #0077b5; font-weight: bold;");

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
        // A. Conditions de lancement
        if (!window.location.href.includes("/in/")) {
            console.log("[FOCALS] Pas sur un profil (/in/), abandon.");
            return null;
        }

        const nameEl = await waitForElement("h1, .text-heading-xlarge");
        if (!nameEl) console.warn("[FOCALS] ⚠️ Nom non détecté.");

        // Petite pause pour s'assurer que le contenu dynamique est chargé
        await new Promise(r => setTimeout(r, 1500));

        const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";

        // --- HELPERS (Les fonctions de parsing éprouvées) ---
        const detectContract = (text) => {
            if (!text) return "";
            const lower = text.toLowerCase();
            if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
            if (lower.includes("cdd") || lower.includes("contract") || lower.includes("fixed-term")) return "CDD";
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
                 if (!company) {
                    const strong = headerDiv.querySelector("strong");
                    if(strong) company = cleanText(strong.innerText);
                 }
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

        // --- B. RECHERCHE DE LA SECTION EXPÉRIENCE (Utilisation de l'ancre #experience) ---
        let expSection = null;
        const anchor = document.getElementById("experience");
        
        if (anchor) {
            expSection = anchor.closest("section") || anchor.parentElement.closest("section");
        } 
        
        // Fallback ultime si l'ID d'ancre n'est pas là
        if (!expSection) {
            const allSections = [...document.querySelectorAll("section")];
            expSection = allSections.find(sec => {
                const h2 = sec.querySelector("h2, span.text-heading-large");
                return h2 && /exp[ée]rience/i.test(h2.innerText);
            });
        }
        
        let experiences = [];
        if (expSection) {
            // SÉLECTEUR AJUSTÉ : On cherche tous les <li> qui sont dans une liste d'expériences
            // Cette version est plus large que la V5 et devrait fonctionner comme le test console
            const items = [...expSection.querySelectorAll("ul li.pvs-list__item, ul li, div > div > div > ul > li")];

            console.log(`[FOCALS] 🔎 ${items.length} expériences potentielles trouvées.`);

            experiences = items.map((item) => {
                // On cherche spécifiquement les textes propres de LinkedIn dans les spans masqués (technique SDUI)
                const localParagraphs = [...item.querySelectorAll("span[aria-hidden='true']")]; 
                const localTexts = localParagraphs.map(p => cleanText(p.innerText)).filter(t => t.length > 0);
                
                if (localTexts.length === 0) return null;

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
                    description: item.innerText.substring(0, 150) + "..."
                };
            }).filter(Boolean);
        } else {
            console.warn("[FOCALS] ❌ Section Expérience introuvable. Tableau d'expériences vide.");
        }

        // --- C. INFOS GLOBALES & IMAGE PROFIL ---
        const imgEl = document.querySelector("img.pv-top-card-profile-picture__image--show") || 
                      document.querySelector(".pv-top-card-profile-picture__image") || 
                      document.querySelector("img[class*='profile-picture']"); 

        const result = {
          name: nameEl ? cleanText(nameEl.innerText) : document.title.split("|")[0].trim(),
          headline: document.querySelector(".text-body-medium")?.innerText.trim() || "",
          localisation: document.querySelector(".text-body-small.inline")?.innerText.trim() || "",
          profileImageUrl: imgEl ? imgEl.src : "",
          experiences: experiences,
          current_job: experiences[0] || {},
          current_company: experiences[0]?.company || "—",
          linkedinProfileUrl: window.location.href.split("?")[0],
          source: "focals-scraper-v6-stable"
        };

        console.log("%c[FOCALS] ✅ SCRAPING TERMINÉ :", "background: green; color: white;", result);

        // --- D. ENVOI DES DONNÉES À L'UI ---
        chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result });
        
        // Appel direct si la fonction UI est dans le contexte
        if (window.updateFocalsPanel && typeof window.updateFocalsPanel === 'function') {
            window.updateFocalsPanel(result);
        }

        return result;

      } catch (e) {
        console.error("[FOCALS] 💥 CRASH:", e);
        return null;
      }
    };

    // --- 2. GESTIONNAIRE D'ÉVÉNEMENTS (LISTENERS) ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "SCRAPE_PROFILE") {
        triggerProfileScrape(true).then(data => sendResponse({ status: "success", data: data }));
        return true; 
      }
      if (request.action === "PING") sendResponse({ status: "pong" });
    });

    // --- 3. AUTO-START (Debug Only) ---
    // Lance le scan automatiquement 3.5s après le chargement pour s'assurer que l'UI se met à jour.
    setTimeout(() => {
        triggerProfileScrape();
    }, 3500); 
}
