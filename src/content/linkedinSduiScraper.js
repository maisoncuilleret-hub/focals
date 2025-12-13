(() => {
  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function uniq(list) {
    const out = [];
    const seen = new Set();
    for (const v of list) {
      const t = cleanText(v);
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function getCanonicalLinkedinUrl() {
    try {
      const link = document.querySelector('link[rel="canonical"]');
      const href = link && link.getAttribute("href");
      if (href) return href;
    } catch (e) {}
    try {
      const url = new URL(window.location.href);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch (e) {
      return window.location.href;
    }
  }

  function parseRelationDegree(texts) {
    // FR: 1er, 2e, 3e, 4e...
    // EN: 1st, 2nd, 3rd, 4th...
    for (const t of texts) {
      const s = cleanText(t).replace(/^·\s*/g, "");
      const m = s.match(/\b(\d+(?:er|e|ème|eme|st|nd|rd|th))\b/i);
      if (m) return cleanText(m[1]);
    }
    return null;
  }

  function findTopcardRoot() {
    return (
      document.querySelector('section[componentkey*="Topcard"]') ||
      document.querySelector('section[data-view-name="profile-top-card"]') ||
      document.querySelector("section.pv-top-card")
    );
  }

  function scrapeTopcard() {
    const root = findTopcardRoot();
    if (!root) return null;

    const fullName = cleanText(root.querySelector("h2") && root.querySelector("h2").textContent);

    const pTexts = uniq(
      Array.from(root.querySelectorAll("p")).map((p) => p && p.textContent)
    );
    const relationDegree = parseRelationDegree(pTexts);

    const photoImg =
      root.querySelector('[data-view-name="profile-top-card-member-photo"] img') ||
      root.querySelector('[data-view-name="profile-top-card-member-photo"] image') ||
      root.querySelector("img.pv-top-card-profile-picture__image") ||
      root.querySelector("img");

    const photoUrl = cleanText(photoImg && photoImg.getAttribute("src"));

    const headline = (() => {
      // on tente de récupérer une ligne "Founder @ ..."
      for (const t of pTexts) {
        const s = cleanText(t);
        if (!s) continue;
        if (s.startsWith("·")) continue;
        if (s.includes("Coordonnées")) continue;
        if (s.includes("relations en commun")) continue;
        if (s.includes("@")) return s;
      }
      return null;
    })();

    const location = (() => {
      // généralement une ligne avec ville/pays, souvent après la headline
      // on prend la première ligne qui ressemble à une localisation
      for (const t of pTexts) {
        const s = cleanText(t);
        if (!s) continue;
        if (s.includes("@")) continue;
        if (s.startsWith("·")) continue;
        if (s.toLowerCase().includes("coordonnées")) continue;
        if (s.toLowerCase().includes("relations en commun")) continue;
        // heuristique simple: contient une virgule ou un pays
        if (s.includes(",")) return s;
      }
      return null;
    })();

    return {
      fullName: fullName || null,
      relationDegree,
      photoUrl: photoUrl || null,
      headline,
      location,
      linkedinUrl: getCanonicalLinkedinUrl()
    };
  }

  function findExperienceRoot() {
    return (
      document.querySelector('section[componentkey*="ExperienceTopLevelSection"]') ||
      document.querySelector('section[id*="experience"]') ||
      document.querySelector('section[data-view-name="profile-card"][aria-label*="Experience"]')
    );
  }

  function scrapeExperiences() {
    const root = findExperienceRoot();
    if (!root) return [];

    const itemRoots = Array.from(root.querySelectorAll('div[componentkey^="entity-collection-item-"]'));
    const experiences = [];

    for (const item of itemRoots) {
      const raw = uniq(
        Array.from(item.querySelectorAll("p")).map((p) => p && p.textContent)
      );

      const filtered = raw.filter((t) => {
        const s = cleanText(t).toLowerCase();
        if (!s) return false;
        if (s.includes("compétence")) return false;
        if (s.includes("skills")) return false;
        if (s.includes("et ") && s.includes("de plus")) return false;
        return true;
      });

      if (!filtered.length) continue;

      const title = filtered[0] || null;
      const companyLine = filtered[1] || "";
      const company = cleanText(companyLine.split("·")[0]) || null;

      const dates = filtered[2] || null;
      const location = filtered[3] || null;

      // start/end best effort, sans casser si format exotique
      let start = null;
      let end = null;
      if (dates) {
        const parts = dates.split(" - ").map(cleanText);
        if (parts.length >= 2) {
          start = parts[0] || null;
          end = parts.slice(1).join(" - ") || null;
        }
      }

      // on garde un format stable pour la popup + éventuels prompts
      experiences.push({
        title,
        company,
        dates,
        location,
        start,
        end
      });
    }

    return experiences;
  }

  function inferCurrentFromExperiences(experiences) {
    if (!experiences || !experiences.length) return { current_title: null, current_company: null };
    // on prend la première expérience, souvent la plus récente dans SDUI
    return {
      current_title: experiences[0].title || null,
      current_company: experiences[0].company || null
    };
  }

  function toExtensionProfile() {
    const top = scrapeTopcard();
    const experiences = scrapeExperiences();

    const { current_title, current_company } = inferCurrentFromExperiences(experiences);

    // format compatible avec la popup existante + champs demandés
    return {
      // champs "nouvelle version"
      fullName: (top && top.fullName) || null,
      relationDegree: (top && top.relationDegree) || null,
      photoUrl: (top && top.photoUrl) || null,
      linkedinUrl: (top && top.linkedinUrl) || getCanonicalLinkedinUrl(),
      experiences,

      // alias compat pour le reste de l’extension
      name: (top && top.fullName) || null,
      headline: (top && top.headline) || null,
      location: (top && top.location) || null,
      photo_url: (top && top.photoUrl) || null,
      linkedin_url: (top && top.linkedinUrl) || getCanonicalLinkedinUrl(),
      current_title,
      current_company
    };
  }

  window.__FocalsLinkedinSduiScraper = {
    scrapeFromDom: toExtensionProfile
  };
})();
