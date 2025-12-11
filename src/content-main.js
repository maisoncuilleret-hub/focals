// ============================================================================
// [FOCALS] CONTENT SCRIPT V13 - PRODUCTION FINALE (Fix Timing + Résilience)
// ============================================================================

// 1. SÉCURITÉ : Bloque l'exécution dans les iframes
if (window !== window.top) {
    // Si on n'est pas sur la fenêtre principale, on ne fait rien.
} else {

    console.log("%c[FOCALS] Scraper V13 (Production Finale) - Loaded", "background: #008080; color: white; padding: 4px; font-weight: bold;");

    window.triggerProfileScrape = async (force = false) => {
      console.log("%c[FOCALS] 🚀 Lancement du Scraper V13...", "color: #008080; font-weight: bold;");

      // Fonction d'attente générique pour le nom
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
      
      // Nouvelle fonction d'attente spécifique à la section Expérience (utilise MutationObserver)
      const waitForExperienceSection = (timeout = 8000) => {
          return new Promise((resolve) => {
              const main = document.querySelector("main") || document.body;
              let observer;
              
              const check = () => {
                  // Selecteurs d'ancrage stables (section, componentkey, data-view-name)
                  const potentialContainers = [...main.querySelectorAll("section, div[componentkey*='ExperienceTopLevelSection'], div[data-view-name*='experience']")];
                  
                  const foundSection = potentialContainers.find(el => {
                      // Vérifie la présence du titre (h2 ou classe de titre)
                      const titleElement = el.querySelector("h2, .pvs-header__title, .text-heading-large");
                      // Vérifie que le titre contient "Expérience" (casse et accent insensibles)
                      return titleElement && /exp[ée]rience/i.test(titleElement.innerText);
                  });

                  if (foundSection) {
                      if (observer) observer.disconnect();
                      return resolve(foundSection);
                  }
                  
                  return null;
              }

              // On observe le DOM pour détecter l'apparition du contenu dynamique
              observer = new MutationObserver(check);
              if (main) {
                observer.observe(main, { childList: true, subtree: true });
              }

              // Vérification initiale (si le contenu est déjà là)
              check();
              
              // Timeout de sécurité
              setTimeout(() => { 
                  if (observer) observer.disconnect(); 
                  resolve(null); 
              }, timeout);
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
        
        // 1. Trouver la section (Ancrage V13 - Utilise le nouveau waitForExperienceSection)
        let expSection = await waitForExperienceSection();

        if (!expSection) {
            console.warn("%c[FOCALS] ❌ Section Expérience introuvable après timeout. Skip.", "color: red;");
            return null;
        }
        
        // ✅ Section trouvée, on peut scraper
        console.log("✅ Section Expérience trouvée. Démarrage du parsing.");

        const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";
        
        // --- HELPERS (Logique V3) ---
        const detectContract = (text) => {
            if (!text) return "";
            const lower = text.toLowerCase();
            if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
            if (lower.includes("cdd") || lower.includes("contract") || lower.includes("fixed-term")) return "CDD";
            if (lower.includes("freelance") || lower.includes("indépendant") || lower.includes("self-employed")) return "Freelance";
            if (lower.includes("stage") || lower.includes("internship")) return "Stage";
            if (lower.includes("alternance") || lower.includes("apprenti") || lower.includes("apprentissage") || lower.includes("professionalisation")) return "Alternance";
            return "";
        };
        
        const isDateRange = (text) => {
            const lower = text.toLowerCase();
            if (lower.match(/janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|jan|fev|mar|avr|mai|juin|juil|aou|sep|oct|nov|dec/i)) return true;
            if (lower.match(/aujourd’hui|present|current/i)) return true;
            if (lower.match(/\d{4} - \d{4}|\d{4} - aujourd’hui/i)) return true;
            if (lower.match(/\d+ (an|ans|mois|mo|yr|yrs)/i)) return true;
            return false;
        }
        
        const isLocation = (text) => {
            const lower = text.toLowerCase();
            if (lower.includes("france") || lower.includes("paris") || lower.includes("région") || lower.includes("états-unis") || lower.includes("californie")) return true;
            return false;
        }

        const getCompanyFromLogo = (container) => {
            const img = container.querySelector("img[alt^='Logo de'], img[alt^='Logo']");
            if (img && img.alt) return img.alt.replace("Logo de ", "").replace("Logo ", "").trim();
            return "";
        };
        
        // 2. Pré-processing : Générer la liste finale avec l'héritage de l'entreprise injecté
        const topLevelItems = [...expSection.querySelectorAll('[componentkey^="entity-collection-item"], ul > li')];
        let allItems = [];
        const processedItems = new Set();
        
        for(const item of topLevelItems) {
            if (processedItems.has(item)) continue;

            const subRoles = item.querySelectorAll('ul > li');
            
            if (subRoles.length > 0) {
                // CAS 1: C'est un groupe (ex: Numberly). On extrait le nom du groupe.
                const headerContainer = item.querySelector('div:first-child');
                
                let companyName = "Entreprise Groupée";
                if (headerContainer) {
                    companyName = getCompanyFromLogo(headerContainer) || cleanText(headerContainer.querySelector('p')?.innerText) || cleanText(headerContainer.querySelector('span')?.innerText) || companyName;
                }
                
                for(const subItem of subRoles) {
                    if (processedItems.has(subItem)) continue;
                    subItem.setAttribute('data-focals-inherited-company', companyName); 
                    allItems.push(subItem);
                    processedItems.add(subItem);
                }
                processedItems.add(item); 
            } else {
                // CAS 2: C'est une expérience individuelle.
                if (item.querySelector("h3, p, .t-bold")) {
                    allItems.push(item);
                }
                processedItems.add(item);
            }
        }
        
        console.log(`%c[FOCALS] 🔎 ${allItems.length} rôles individuels détectés après traitement d'héritage.`, "color:yellowgreen;");
        
        // 3. Parsing Heuristique Final
        const textSelectors = "h3, .t-bold, .text-body-medium, span[aria-hidden='true'], p, span";
        
        let experiences = allItems.map((item, index) => {
            
            // 1. Détection d'Entreprise (Logo > Héritage > Fallback)
            let company = getCompanyFromLogo(item); 
            if (!company) company = item.getAttribute('data-focals-inherited-company');
            
            // Fallback pour Self-employed / Indépendant
            const texts = item.innerText;
            if (texts.includes("Self-employed") && !company) company = "Self-employed";
            if (texts.includes("Indépendant") && !company) company = "Indépendant";
            if (!company) company = "Non détectée";

            
            // 2. Extraction du Texte
            let title = '';
            let contract = '';
            let dates = '';
            let location = '';

            const localElements = [...item.querySelectorAll(textSelectors)];
            const localTexts = localElements.map(p => cleanText(p.innerText)).filter(t => t.length > 0 && t !== company && t !== item.getAttribute('aria-label'));
            
            if (localTexts.length === 0) return null;

            // PARSING HEURISTIQUE
            const candidates = [...localTexts];

            for (let i = 0; i < candidates.length; i++) {
                const text = candidates[i];
                
                const detectedContract = detectContract(text);
                
                if (detectedContract && !contract) { contract = detectedContract; }
                if (isDateRange(text) && !dates) { dates = text; }
                if (isLocation(text) && !location) { location = text; }
                
                if (!title) {
                    const isMetadata = isDateRange(text) || detectedContract || text === company;
                    if (i < 2 && !isMetadata && text.length > 5 && text.length < 100) { 
                        title = text;
                    }
                }
            }
            
            // Fallback pour le titre
            if (!title) title = localTexts.find(t => t.length > 5 && !isDateRange(t) && !detectContract(t) && !isLocation(t) && t !== company) || "Titre inconnu";

            // Nettoyage final du titre si c'est la description
            if (title.length > 150) {
                 title = title.substring(0, 150) + "...";
            }
            
            // Cas spécial où le titre est le nom de la compagnie
            if (title === company && candidates.length > 1) {
                 const nextTitle = candidates.find(t => t !== company && !isDateRange(t) && !detectContract(t) && !isLocation(t));
                 if (nextTitle) title = nextTitle;
            }


            return {
                title: title,
                company: company,
                contract_type: contract || "Non spécifié",
                dates: dates,
                location: location,
                description: item.innerText.substring(0, 150) + "..."
            };

        }).filter(Boolean);


        // --- C. INFOS GLOBALES & IMAGE PROFIL ---
        const imgEl = document.querySelector("img.pv-top-card-profile-picture__image--show") || 
                      document.querySelector(".pv-top-card-profile-picture__image") || 
                      document.querySelector("img[class*='profile-picture']"); 
                      
        const mainEl = document.querySelector("main") || document.body;

        const result = {
          // On tente de récupérer le nom depuis un selecteur plus générique si h1 échoue
          name: nameEl ? cleanText(nameEl.innerText) : cleanText(mainEl.querySelector("h1")?.innerText || document.title.split("|")[0]),
          headline: document.querySelector(".text-body-medium")?.innerText.trim() || "",
          localisation: document.querySelector(".text-body-small.inline")?.innerText.trim() || "",
          profileImageUrl: imgEl ? imgEl.src : "",
          experiences: experiences,
          current_job: experiences[0] || {},
          current_company: experiences[0]?.company || "—",
          linkedinProfileUrl: window.location.href.split("?")[0],
          source: "focals-scraper-v13-production"
        };

        console.log(`%c[FOCALS] ✅ SCRAPING TERMINÉ. Experiences trouvées: ${experiences.length}`, "background: green; color: white;", result);

        // --- D. ENVOI DES DONNÉES À L'UI ---
        chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result });
        
        if (window.updateFocalsPanel && typeof window.updateFocalsPanel === 'function') {
            window.updateFocalsPanel(result);
        }

        return result;

      } catch (e) {
        console.error("[FOCALS] 💥 CRASH V13:", e);
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
