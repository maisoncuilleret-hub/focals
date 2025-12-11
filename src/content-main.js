// ============================================================================
// [FOCALS] CONTENT SCRIPT V10 - DEBUG EXPÉRIENCE
// ============================================================================

// 1. SÉCURITÉ : Bloque l'exécution dans les iframes
if (window !== window.top) {
    // Si on n'est pas sur la fenêtre principale, on ne fait rien.
} else {

    console.log("%c[FOCALS] Scraper V10 (Avec Logs Debug) - Loaded", "background: #c0392b; color: white; padding: 4px; font-weight: bold;");

    window.triggerProfileScrape = async (force = false) => {
      console.log("%c[FOCALS] 🚀 Lancement du Scraper V10...", "color: #c0392b; font-weight: bold;");

      const waitForElement = (selector, timeout = 5000) => {
        return new Promise((resolve) => {
          const check = () => {
             const el = document.querySelector(selector);
             if (el && el.innerText.trim().length > 0) {
                 return resolve(el);
             }
             return null;
          }
          if (check()) return;
          const observer = new MutationObserver((mutations, obs) => {
            if (check()) obs.disconnect();
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => { observer.disconnect(); resolve(document.querySelector(selector)); }, timeout);
        });
      };

      try {
        // A. Conditions de lancement et attente
        if (!window.location.href.includes("/in/")) {
            console.log("[FOCALS] Pas sur un profil (/in/), abandon.");
            return null;
        }

        const nameEl = await waitForElement("h1, .text-heading-xlarge");
        if (!nameEl) console.warn("%c[FOCALS] ⚠️ Nom non détecté après timeout. Continuation...", "color:orange;");

        await new Promise(r => setTimeout(r, 1500)); 

        const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";
        const main = document.querySelector("main") || document.body;
        
        // --- HELPERS (Logique V3) ---
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

        // --- B. EXTRACTION DES EXPÉRIENCES ---
        
        // 1. Trouver la section
        const allSections = [...main.querySelectorAll("section")];
        let expSection = allSections.find(sec => {
            const h2 = sec.querySelector("h2, span.text-heading-large");
            return h2 && /exp[ée]rience/i.test(h2.innerText);
        });

        if (!expSection) {
            const anchor = document.getElementById("experience");
            if (anchor) expSection = anchor.closest("section") || anchor.parentElement.closest("section");
        }
        
        let experiences = [];
        if (expSection) {
            const items = [...expSection.querySelectorAll("ul > li")];
            
            console.log(`%c[FOCALS DEBUG] 🔎 ${items.length} <li> éléments bruts trouvés dans Expérience.`, "color:yellowgreen;");

            experiences = items.map((item, index) => {
                
                // V10: SÉLECTION MAXIMALE. Fusion de tous les sélecteurs de texte utiles
                const textSelectors = "h3, .t-bold, .text-body-medium, span[aria-hidden='true'], p, span, div.pvs-list__outer-container";
                const localElements = [...item.querySelectorAll(textSelectors)];
                
                const localTexts = localElements.map(p => cleanText(p.innerText)).filter(t => t.length > 0);
                
                // NOUVEAU LOG DE DEBUG CRITIQUE
                if (localTexts.length === 0) {
                     console.warn(`%c[FOCALS DEBUG] ❌ Expérience #${index}: Texte local introuvable. Skip.`, "color: red;");
                     console.log("[FOCALS DEBUG] Éléments dans <li>:", item.innerHTML);
                     return null; // Ignore les <li> vides
                }
                console.log(`%c[FOCALS DEBUG] ✅ Expérience #${index}: Texte local trouvé.`, "color: green;");
                console.log("[FOCALS DEBUG] Texte brute trouvé:", localTexts);


                // --- LOGIQUE DE PARSING V3 ---
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
          source: "focals-scraper-v10-debug"
        };

        console.log(`%c[FOCALS] ✅ SCRAPING TERMINÉ. Experiences trouvées: ${experiences.length}`, "background: green; color: white;", result);

        // --- D. ENVOI DES DONNÉES À L'UI ---
        chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result });
        
        if (window.updateFocalsPanel && typeof window.updateFocalsPanel === 'function') {
            window.updateFocalsPanel(result);
        }

        return result;

      } catch (e) {
        console.error("[FOCALS] 💥 CRASH V10:", e);
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
