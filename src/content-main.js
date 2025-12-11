// ============================================================================
// [FOCALS] CONTENT SCRIPT V7 - LE FIX FINAL (Logique V3 Éprouvée + Stabilité)
// ============================================================================

// 1. SÉCURITÉ : Bloque l'exécution dans les iframes (pub, notif, etc.)
if (window !== window.top) {
    // Si on n'est pas sur la fenêtre principale, on ne fait rien.
} else {

    console.log("%c[FOCALS] Scraper V7 (Final Stable) - Loaded", "background: #117a65; color: white; padding: 4px; font-weight: bold;");

    window.triggerProfileScrape = async (force = false) => {
      console.log("%c[FOCALS] 🚀 Lancement du Scraper V7...", "color: #117a65; font-weight: bold;");

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
        // A. Conditions de lancement et attente
        if (!window.location.href.includes("/in/")) {
            console.log("[FOCALS] Pas sur un profil (/in/), abandon.");
            return null;
        }

        const nameEl = await waitForElement("h1, .text-heading-xlarge");
        if (!nameEl) console.warn("[FOCALS] ⚠️ Nom non détecté.");

        // Pause de sécurité avant le scraping de la liste
        await new Promise(r => setTimeout(r, 1500));

        const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";
        const main = document.querySelector("main") || document.body;
        
        // --- HELPERS (Copie conforme de V3) ---
        const detectContract = (text) => {
            if (!text) return "";
            const lower = text.toLowerCase();
            if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
            if (lower.includes("cdd") || lower.includes("contract") || lower.includes("fixed-term")) return "CDD";
            if (lower.includes("freelance") || lower.includes("indépendant")) return "Freelance";
            if (lower.includes("stage") || lower.includes("internship")) return "Stage";
            if (lower.includes("alternance") || lower.includes("apprenti") || lower.includes("apprentissage") || lower.includes("professionalisation")) return "Alternance";
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

        // --- B. EXTRACTION DES EXPÉRIENCES (Logique V3) ---

        // 1. Trouver la section (Méthode V3)
        const allSections = [...main.querySelectorAll("section")];
        let expSection = allSections.find(sec => {
            const h2 = sec.querySelector("h2, span.text-heading-large");
            return h2 && /exp[ée]rience/i.test(h2.innerText);
        });

        if (!expSection) {
            // Tentative par ID d'ancre (méthode V6) si la V3 échoue
            const anchor = document.getElementById("experience");
            if (anchor) expSection = anchor.closest("section") || anchor.parentElement.closest("section");
        }
        
        let experiences = [];
        if (expSection) {
            // 2. Parser les items (Sélecteur V3 éprouvé)
            const items = [...expSection.querySelectorAll("ul > li")];
            
            console.log(`[FOCALS] 🔎 ${items.length} expériences trouvées dans la section.`);

            experiences = items.map((item) => {
                // On utilise les sélecteurs V3 / SDUI pour les textes locaux
                const localParagraphs = [...item.querySelectorAll("p, span[aria-hidden='true']")]; 
                const localTexts = localParagraphs.map(p => cleanText(p.innerText)).filter(t => t.length > 0);
                
                if (localTexts.length === 0) return null; // Ignore les <li> vides (séparateurs, etc.)

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
            console.warn("[FOCALS] ❌ Section Expérience introuvable. Assurez-vous d'être sur la bonne page.");
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
          source: "focals-scraper-v7-final"
        };

        console.log(`%c[FOCALS] ✅ SCRAPING TERMINÉ. Experiences trouvées: ${experiences.length}`, "background: green; color: white;", result);

        // --- D. ENVOI DES DONNÉES À L'UI ---
        chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result });
        
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

    // --- 3. AUTO-START (Pour Debug) ---
    setTimeout(() => {
        triggerProfileScrape();
    }, 3500); 
}
