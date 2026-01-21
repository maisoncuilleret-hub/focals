(() => {
  const TAG = "🧪 FOCALS CONSOLE";
  const DEBUG = false;

  const log = (...a) => console.log(TAG, ...a);
  const dlog = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const uniq = (arr) => {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const v = clean(x);
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  const isProfileUrl = (u) => /linkedin\.com\/in\//i.test(u);
  const canonicalProfileUrl = (u) => {
    try {
      const url = new URL(u);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return u;
    }
  };

  function elementPath(el) {
    if (!el) return null;
    const parts = [];
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      const id = cur.id ? `#${cur.id}` : "";
      const cls =
        cur.className && typeof cur.className === "string"
          ? "." + cur.className.split(/\s+/).slice(0, 2).join(".")
          : "";
      parts.push(`${cur.tagName.toLowerCase()}${id}${cls}`);
      cur = cur.parentElement;
    }
    return parts.join(" <- ");
  }

  function normText(s) {
    return clean(s || "");
  }

  const textContent = (el) => normText(el?.textContent);

  const normalizeInfosText = (s) =>
    (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const fixSpacedUrls = (t) => t.replace(/\bhttps?:\/\/[^\s)]+/gi, (url) => url.replace(/\s+/g, ""));

  const dedupeSentences = (text) => {
    const paras = normalizeInfosText(text).split(/\n{2,}/).filter(Boolean);
    const seen = new Set();
    const out = [];

    for (const para of paras) {
      const chunks = (para.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
        .map((x) => x.trim())
        .filter(Boolean);

      const kept = [];
      for (const c of chunks) {
        const key = c.replace(/\s+/g, " ").toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          kept.push(c);
        }
      }
      if (kept.length) out.push(kept.join(" "));
    }
    return out.join("\n\n").trim();
  };

  const SEE_MORE_REGEX = /(voir plus|see more|show more|afficher la suite)/i;

  const extractTextWithBreaks = (node) => {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    return clone.textContent || "";
  };

  const normalizeDescriptionText = (text) => {
    let normalized = normalizeInfosText(text || "");
    normalized = normalized.replace(/…\s*(voir plus|see more|show more|afficher la suite)\s*$/i, "").trim();
    normalized = fixSpacedUrls(normalized);
    if (!normalized) return null;

    const lines = normalized
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const seen = new Set();
    const deduped = [];
    for (const line of lines) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(line);
    }

    return deduped.join("\n").trim() || null;
  };

  const extractDescriptionBullets = (text) => {
    if (!text) return null;
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const bullets = lines
      .filter((line) => /^[-•]\s+/.test(line))
      .map((line) => line.replace(/^[-•]\s+/, "").trim())
      .filter(Boolean);
    return bullets.length ? bullets : null;
  };

  const clickSeeMoreInItem = (item) => {
    if (!item) return false;
    const scope = item.querySelector(".pvs-entity__sub-components") || item;
    const buttons = Array.from(scope.querySelectorAll("button, a"))
      .map((el) => ({
        el,
        label: `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim(),
      }))
      .filter(({ label }) => SEE_MORE_REGEX.test(label));
    const target = buttons.find(({ el }) => !el.disabled)?.el;
    if (target) {
      target.click();
      dlog("Clicked see more for experience description");
      return true;
    }
    return false;
  };

  const extractExperienceDescription = (item) => {
    if (!item) return { description: null, descriptionBullets: null };
    const subComponents = item.querySelector(".pvs-entity__sub-components");
    if (!subComponents) return { description: null, descriptionBullets: null };

    clickSeeMoreInItem(item);

    const candidates = [];
    const inlineNodes = subComponents.querySelectorAll(
      'div[class*="inline-show-more-text"] span[aria-hidden="true"]'
    );
    if (inlineNodes.length) {
      inlineNodes.forEach((node) => candidates.push(node));
    } else {
      subComponents.querySelectorAll('div[class*="inline-show-more-text"]').forEach((node) => candidates.push(node));
      subComponents.querySelectorAll("span[aria-hidden='true']").forEach((node) => candidates.push(node));
    }

    const raw = candidates.map(extractTextWithBreaks).filter(Boolean).join("\n");
    const description = normalizeDescriptionText(raw);
    if (!description) return { description: null, descriptionBullets: null };

    return { description, descriptionBullets: extractDescriptionBullets(description) };
  };

  const findAboutSection = () => {
    const anchor = document.getElementById("about");
    if (anchor) return anchor.closest("section") || anchor.parentElement?.closest("section") || null;

    const headings = Array.from(document.querySelectorAll("h2, h3, span")).filter((el) =>
      /^(Infos|About|À propos)$/i.test((el.innerText || "").trim())
    );
    return headings[0]?.closest("section") || null;
  };

  const scrapeInfosSection = () => {
    const section = findAboutSection();
    if (!section) return null;

    const el =
      section.querySelector('div[class*="inline-show-more-text"] span[aria-hidden="true"]') ||
      section.querySelector('.pv-shared-text-with-see-more span[aria-hidden="true"]');

    let text = normalizeInfosText(el?.textContent || el?.innerText || "");
    text = text.replace(/…\s*(voir plus|see more)\s*$/i, "").trim();
    text = dedupeSentences(text);
    text = fixSpacedUrls(text);

    return text || null;
  };

  const findSectionByAnchorId = (id) => {
    const anchor = document.querySelector(`#${CSS.escape(id)}`);
    if (!anchor) return null;
    return anchor.closest("section") || anchor.parentElement?.closest("section") || null;
  };

  const findSectionByTitle = (title) => {
    const h2s = [...document.querySelectorAll("h2")];
    const h2 = h2s.find((x) => textContent(x).toLowerCase() === title.toLowerCase());
    return h2?.closest("section") || null;
  };

  function parseEducation() {
    const section = findSectionByAnchorId("education") || findSectionByTitle("Formation");

    if (!section) return [];

    const lis = [...section.querySelectorAll("li.artdeco-list__item")];
    const out = [];

    for (const li of lis) {
      if (/Afficher les/i.test(textContent(li))) continue;

      const school =
        textContent(li.querySelector("a[href*='/company/'] .t-bold span[aria-hidden='true']")) ||
        textContent(li.querySelector("a[href*='/company/'] .t-bold")) ||
        textContent(li.querySelector(".t-bold span[aria-hidden='true']")) ||
        "";

      const degree = textContent(li.querySelector(".t-14.t-normal span[aria-hidden='true']")) || "";

      const dates = textContent(li.querySelector(".pvs-entity__caption-wrapper")) || "";

      if (!school) continue;

      out.push({ school, degree, dates });
    }

    const seen = new Set();
    return out.filter((e) => {
      const key = `${e.school}|${e.degree}|${e.dates}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseSkills() {
    const section = findSectionByAnchorId("skills") || findSectionByTitle("Compétences");

    if (!section) return [];

    const links = [...section.querySelectorAll("a[data-field='skill_card_skill_topic']")];
    const skills = links
      .map((a) => textContent(a.querySelector("span[aria-hidden='true']")) || textContent(a))
      .filter(Boolean);

    return [...new Set(skills)];
  }

  // ---------------- Top card ----------------
  function pickBestProfileRoot() {
    return (
      document.querySelector('section[componentkey*="Topcard"]') ||
      document.querySelector('[data-view-name="profile-top-card"]') ||
      document.querySelector(".pv-top-card") ||
      document.querySelector("main") ||
      document.body
    );
  }

  function getFullName(profileRoot) {
    const h1 = profileRoot.querySelector("h1");
    if (clean(h1?.textContent)) return clean(h1.textContent);

    const h2 = profileRoot.querySelector("h2");
    if (clean(h2?.textContent)) return clean(h2.textContent);

    const candidates = Array.from(profileRoot.querySelectorAll("h1,h2,span,p"))
      .map((n) => clean(n.textContent))
      .filter((t) => t && t.length >= 3 && t.length <= 70)
      .filter((t) => !/abonnés|followers/i.test(t));

    return candidates[0] || null;
  }

  function normalizeDegree(s) {
    const t = clean(s).toLowerCase();
    if (t.includes("1er") || t.includes("1st")) return "1er";
    if (t.includes("2e") || t.includes("2nd")) return "2e";
    if (t.includes("3e") || t.includes("3rd")) return "3e";
    return null;
  }

  function rankDegree(d) {
    if (d === "1er") return 1;
    if (d === "2e") return 2;
    if (d === "3e") return 3;
    return 99;
  }

  function extractDegreesFromTexts(texts) {
    const hits = [];

    for (const raw of texts) {
      const t = clean(raw);
      if (!t) continue;

      const rel = t.match(/\brelation\s+de\s+(1er|2e|3e)\s+niveau\b/i);
      if (rel) hits.push(normalizeDegree(rel[1]));

      const bullet = t.match(/[·•]\s*(1er|2e|3e|1st|2nd|3rd)\b/i);
      if (bullet) hits.push(normalizeDegree(bullet[1]));

      const loose = t.match(/\b(1er|2e|3e|1st|2nd|3rd)\b/i);
      if (loose) hits.push(normalizeDegree(loose[1]));
    }

    return hits.filter(Boolean);
  }

  function getRelationDegree(profileRoot) {
    const dist = document.querySelector(".dist-value");
    const distText = clean(dist?.textContent || "");
    if (distText) return normalizeDegree(distText);

    const topcard =
      document.querySelector('section[componentkey*="Topcard"]') ||
      document.querySelector('[data-view-name="profile-top-card"]') ||
      profileRoot;

    const nodes = Array.from(topcard.querySelectorAll("p,span,div")).slice(0, 500);

    const topTexts = [];
    for (const n of nodes) {
      const aria = clean(n.getAttribute?.("aria-label") || "");
      if (aria) topTexts.push(aria);
      const txt = clean(n.textContent || "");
      if (txt) topTexts.push(txt);
    }

    let degrees = extractDegreesFromTexts(uniq(topTexts));
    if (degrees.length) {
      degrees.sort((a, b) => rankDegree(a) - rankDegree(b));
      return degrees[0];
    }

    const blob = clean(topcard.textContent || "");
    degrees = extractDegreesFromTexts([blob]);
    if (degrees.length) {
      degrees.sort((a, b) => rankDegree(a) - rankDegree(b));
      return degrees[0];
    }

    return null;
  }

  // ---------------- Photo ----------------
  function isPlausibleProfilePhotoSrc(src) {
    if (!src) return false;
    const s = String(src).toLowerCase();
    if (!s.startsWith("http")) return false;
    if (!s.includes("media.licdn.com/dms/image")) return false;
    return /\/profile-(displayphoto|framedphoto)/i.test(src);
  }

  function getPhotoUrl(profileRoot) {
    const sduiImg =
      document.querySelector('[data-view-name="profile-top-card-member-photo"] img') ||
      profileRoot.querySelector('[data-view-name="profile-top-card-member-photo"] img');
    if (sduiImg) {
      const src = sduiImg.getAttribute("src") || sduiImg.currentSrc || "";
      if (isPlausibleProfilePhotoSrc(src)) return src;
    }

    const selectors = [
      "img.pv-top-card-profile-picture__image",
      "img.profile-photo-edit__preview",
      "img.pv-top-card__photo",
      'img[alt*="Photo de profil"]',
    ];

    for (const sel of selectors) {
      const img = profileRoot.querySelector(sel);
      const src = img?.getAttribute("src") || img?.currentSrc || "";
      if (isPlausibleProfilePhotoSrc(src)) return src;
    }

    const imgs = Array.from(profileRoot.querySelectorAll("img"))
      .map((img) => ({
        src: img.getAttribute("src") || img.currentSrc || "",
        area: (img.naturalWidth || 0) * (img.naturalHeight || 0),
      }))
      .filter((x) => isPlausibleProfilePhotoSrc(x.src))
      .sort((a, b) => b.area - a.area);

    return imgs[0]?.src || null;
  }

  // ---------------- Experience root picking ----------------
  function pickExperienceSection() {
    const legacyAnchor = document.querySelector("#experience");
    if (legacyAnchor) {
      const section =
        legacyAnchor.closest("section.artdeco-card") ||
        legacyAnchor.closest("section") ||
        legacyAnchor.parentElement;
      if (section) return { mode: "LEGACY_ANCHOR", root: section };
    }

    const sduiCard = document.querySelector('[data-view-name="profile-card-experience"]');
    if (sduiCard) return { mode: "SDUI_CARD", root: sduiCard.querySelector("section") || sduiCard };

    const sduiTopSection = document.querySelector('section[componentkey*="ExperienceTopLevelSection"]');
    if (sduiTopSection) return { mode: "SDUI_COMPONENTKEY", root: sduiTopSection };

    const h2 = Array.from(document.querySelectorAll("h2")).find((x) =>
      /expérience/i.test(clean(x.textContent))
    );
    if (h2) {
      const sec = h2.closest("section");
      if (sec) return { mode: "HEADING_FALLBACK", root: sec };
    }

    return { mode: "NOT_FOUND", root: null };
  }

  function looksLikeDates(s) {
    const t = clean(s);
    if (!t) return false;
    return /-/.test(t) && (/\b(19\d{2}|20\d{2})\b/.test(t) || /aujourd/i.test(t));
  }

  function looksLikeEmploymentType(s) {
    const t = clean(s);
    if (!t) return false;
    return /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i.test(
      t
    );
  }

  // strict, pour éviter de prendre une description comme "Lieu"
  function looksLikeLocation(s) {
    const t = clean(s);
    if (!t) return false;
    if (t.length > 120) return false;

    const hasWorkMode = /(sur site|hybride|à distance|remote|on[- ]site)/i.test(t);
    const hasGeo =
      /(france|paris|île-de-france|ile-de-france|région|region|london|berlin|madrid|barcelona|bruxelles|brussels|amsterdam|lisbon|lisbonne)/i.test(
        t
      );

    return hasWorkMode || hasGeo;
  }

  // fallback safe: "Six-fours les plages", "Nice", etc
  function looksLikePlainLocationFallback(s) {
    const t = clean(s);
    if (!t) return false;
    if (t.length > 80) return false;
    if (looksLikeDates(t)) return false;
    if (looksLikeEmploymentType(t)) return false;
    if (/compétences|competences|skills/i.test(t)) return false;

    // lettres + espaces + ponctuation "adresse" très simple
    // exclut la plupart des descriptions (":", "+", chiffres, etc)
    return /^[\p{L}\s,'’.\-]+$/u.test(t);
  }

  function bestUlForLegacy(expSection) {
    const uls = Array.from(expSection.querySelectorAll("ul"));
    let best = null;
    let bestScore = 0;

    for (const ul of uls) {
      const directLis = Array.from(ul.children).filter((c) => c && c.tagName === "LI");
      const score = directLis.filter((li) => li.querySelector('div[data-view-name="profile-component-entity"]')).length;
      if (score > bestScore) {
        bestScore = score;
        best = ul;
      }
    }

    return { ul: best, score: bestScore };
  }

  // ---------- Legacy parsing (support grouped experiences like "Amadeus" with nested roles) ----------
  function pickMainEntityLink(entity) {
    return (
      entity.querySelector('a.optional-action-target-wrapper.display-flex.flex-column.full-width[href]') ||
      Array.from(entity.querySelectorAll('a[href]')).find((a) => a.querySelector(".hoverable-link-text.t-bold")) ||
      entity.querySelector('a[href]') ||
      null
    );
  }

  function extractCompanyFromEntity(entity) {
    const c1 = clean(entity.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent);
    if (c1) return c1;
    const c2 = clean(entity.querySelector(".hoverable-link-text.t-bold")?.textContent);
    return c2 || null;
  }

  function parseLegacyRoleEntity(entity, index, companyOverride, scopeItem) {
    const link = pickMainEntityLink(entity);
    if (!link)
      return { _idx: index, _ok: false, Titre: null, Entreprise: companyOverride || null, Dates: null, Lieu: null };

    const title =
      clean(link.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent) ||
      clean(link.querySelector(".hoverable-link-text.t-bold")?.textContent) ||
      null;

    const dates =
      clean(link.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent) ||
      clean(link.querySelector("span.pvs-entity__caption-wrapper")?.textContent) ||
      null;

    let lightSpans = Array.from(
      link.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => clean(n.textContent))
      .filter(Boolean);

    if (!lightSpans.length) {
      lightSpans = Array.from(link.querySelectorAll("span.t-14.t-normal.t-black--light"))
        .map((n) => clean(n.textContent))
        .filter(Boolean);
    }

    lightSpans = uniq(lightSpans);

    // FIX: sur legacy, le "lieu" est presque toujours un t-black--light
    // donc on accepte aussi un fallback "plain text" (ex: "Six-fours les plages")
    const location =
      lightSpans.find(
        (t) =>
          t &&
          t !== dates &&
          !looksLikeEmploymentType(t) &&
          (looksLikeLocation(t) || looksLikePlainLocationFallback(t))
      ) || null;

    const companyFlat =
      clean(link.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent) ||
      clean(link.querySelector("span.t-14.t-normal")?.textContent) ||
      null;

    const company = companyOverride || companyFlat || null;

    const { description, descriptionBullets } = extractExperienceDescription(
      scopeItem || entity.closest("li") || entity
    );

    const ok = !!(title && company && dates);
    return {
      _idx: index,
      _ok: ok,
      Titre: title,
      Entreprise: company,
      Dates: dates,
      Lieu: location,
      Description: description,
      DescriptionBullets: descriptionBullets,
    };
  }

  function parseLegacyExperienceLiExpanded(li, index) {
    const entity = li.querySelector('div[data-view-name="profile-component-entity"]');
    if (!entity) return [];

    const innerRoleEntities = Array.from(
      li.querySelectorAll('.pvs-entity__sub-components div[data-view-name="profile-component-entity"]')
    ).filter((e) => e.querySelector(".pvs-entity__caption-wrapper"));

    if (innerRoleEntities.length) {
      const outerCompany = extractCompanyFromEntity(entity) || null;
      const out = [];
      for (let i = 0; i < innerRoleEntities.length; i++) {
        const scopeItem = innerRoleEntities[i].closest("li") || li;
        const parsed = parseLegacyRoleEntity(innerRoleEntities[i], `${index}.${i}`, outerCompany, scopeItem);
        if (parsed._ok) out.push(parsed);
      }
      return out;
    }

    const parsed = parseLegacyRoleEntity(entity, index, null, li);
    return parsed._ok ? [parsed] : [];
  }

  function bestSduiLinkForItem(item) {
    const links = Array.from(item.querySelectorAll('a[href]')).filter((a) => {
      const href = a.getAttribute("href") || "";
      if (!href) return false;
      if (href === "#") return false;
      return true;
    });

    if (!links.length) return null;

    const scored = links
      .map((a) => {
        const ps = Array.from(a.querySelectorAll("p")).map((p) => clean(p.textContent)).filter(Boolean);
        const hasDate = ps.some((t) => looksLikeDates(t));
        const score = ps.length + (hasDate ? 10 : 0);
        return { a, score, ps };
      })
      .sort((x, y) => y.score - x.score);

    return scored[0]?.a || null;
  }

  function parseSduiExperienceItem(item, index) {
    const link =
      bestSduiLinkForItem(item) ||
      item.querySelector('a[href*="/company/"]') ||
      item.querySelector('a[href*="/school/"]') ||
      item.querySelector('a[href^="/company/"]') ||
      item.querySelector('a[href^="/school/"]') ||
      item.querySelector('a[href^="https://www.linkedin.com/company/"]') ||
      item.querySelector('a[href^="https://www.linkedin.com/school/"]') ||
      null;

    const pNodes = (link ? link.querySelectorAll("p") : item.querySelectorAll("p")) || [];
    let ps = Array.from(pNodes)
      .map((p) => clean(p.textContent))
      .filter(Boolean)
      .filter((t) => !/compétences de plus|competences de plus|skills|programming language/i.test(t));

    ps = uniq(ps);

    const title = ps[0] || null;

    let company = null;
    if (ps[1]) company = clean(ps[1].split("·")[0]);

    const dates = ps.find((t) => looksLikeDates(t)) || null;

    // FIX: SDUI peut contenir des lieux "ville seule" pas dans la regex, donc fallback plain text
    const locationCandidates = ps
      .filter(Boolean)
      .filter((t) => t !== title)
      .filter((t) => t !== company)
      .filter((t) => t !== dates)
      .filter((t) => !looksLikeEmploymentType(t));

    const location =
      locationCandidates.find((t) => looksLikeLocation(t)) ||
      locationCandidates.find((t) => looksLikePlainLocationFallback(t)) ||
      null;

    const { description, descriptionBullets } = extractExperienceDescription(item);

    const ok = !!(title && company && dates);
    return {
      _idx: index,
      _ok: ok,
      Titre: title,
      Entreprise: company,
      Dates: dates,
      Lieu: location,
      Description: description,
      DescriptionBullets: descriptionBullets,
    };
  }

  function collectExperiences(expSection) {
    if (!expSection) return { mode: "NO_ROOT", experiences: [], counts: {} };

    const sduiItems = Array.from(
      expSection.querySelectorAll('[componentkey^="entity-collection-item-"], [componentkey*="entity-collection-item-"]')
    );

    const sduiLikely = sduiItems.filter((it) =>
      Array.from(it.querySelectorAll("p")).some((p) => looksLikeDates(p.textContent))
    );

    const { ul: legacyUl, score: legacyScore } = bestUlForLegacy(expSection);
    const legacyLis = legacyUl
      ? Array.from(legacyUl.children).filter((li) => li.querySelector('div[data-view-name="profile-component-entity"]'))
      : [];

    const counts = {
      sduiItems: sduiItems.length,
      sduiLikely: sduiLikely.length,
      legacyUlScore: legacyScore,
      legacyLis: legacyLis.length,
    };

    if (sduiLikely.length) {
      const parsed = sduiLikely.map((it, i) => parseSduiExperienceItem(it, i));
      const ok = parsed.filter((x) => x._ok);
      return { mode: "SDUI_ITEMS", experiences: ok, counts };
    }

    if (legacyLis.length) {
      const parsed = legacyLis.flatMap((li, i) => parseLegacyExperienceLiExpanded(li, i));
      const ok = parsed.filter((x) => x._ok);
      return { mode: "LEGACY_LIS", experiences: ok, counts };
    }

    return { mode: "EMPTY", experiences: [], counts };
  }

  async function waitForExperienceReady(timeoutMs = 6500) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const pick = pickExperienceSection();
      if (pick.root) {
        const collected = collectExperiences(pick.root);
        if (collected.experiences.length > 0) return { pick, collected, waited: true };
      }
      await sleep(250);
    }

    const pick = pickExperienceSection();
    const collected = pick.root
      ? collectExperiences(pick.root)
      : { mode: "NO_ROOT", experiences: [], counts: {} };
    return { pick, collected, waited: true };
  }

  // ---------------- Runner + SPA watcher ----------------
  async function runOnce(reason) {
    const startedAt = new Date().toISOString();
    const href = location.href;

    if (!isProfileUrl(href)) {
      warn("Not on /in/ profile page. Skipping.", href);
      const out = { ok: false, mode: "BAD_CONTEXT", href, startedAt, reason };
      window.__FOCALS_LAST = out;
      return out;
    }

    const profileRoot = pickBestProfileRoot();
    const fullName = getFullName(profileRoot);
    const photoUrl = getPhotoUrl(profileRoot);
    const relationDegree = getRelationDegree(profileRoot);
    const linkedinUrl = canonicalProfileUrl(href);
    const education = parseEducation();
    const skills = parseSkills();
    const infos = scrapeInfosSection();

    const ready = await waitForExperienceReady(6500);

    const result = {
      ok: true,
      mode: "OK",
      reason,
      startedAt,
      fullName,
      photoUrl,
      linkedinUrl,
      relationDegree,
      experiences: ready.collected.experiences,
      education,
      skills,
      infos,
      debug: {
        experienceRootMode: ready.pick.mode,
        experienceCollectionMode: ready.collected.mode,
        experienceCounts: ready.collected.counts,
        experienceRootPath: elementPath(ready.pick.root),
      },
    };

    window.__FOCALS_LAST = result;

    log(`AUTORUN (${reason})`, {
      fullName: result.fullName,
      relationDegree: result.relationDegree,
      photoUrl: result.photoUrl,
      linkedinUrl: result.linkedinUrl,
      experiences: result.experiences.length,
    });

    if (!result.experiences.length) {
      warn("No experiences parsed. Debug:", result.debug);
    } else {
      console.table(
        result.experiences.map((e) => ({
          Titre: e.Titre,
          Entreprise: e.Entreprise,
          Dates: e.Dates,
          Lieu: e.Lieu,
          Description: e.Description ? `${e.Description.slice(0, 120)}…` : null,
        }))
      );
    }

    dlog("DEBUG (full)", result);
    return result;
  }

  function normalizeForUi(result) {
    if (!result || !result.ok) return null;

    const experiences = (result.experiences || []).map((exp) => ({
      title: exp.Titre || "",
      company: exp.Entreprise || "",
      dates: exp.Dates || "",
      location: exp.Lieu || "",
      description: exp.Description || null,
      descriptionBullets: exp.DescriptionBullets || null,
    }));

    const education = (result.education || []).map((ed) => ({
      school: ed.school || "",
      degree: ed.degree || "",
      dates: ed.dates || "",
    }));

    const skills = uniq(result.skills || []);
    const infos = result.infos || "";

    return {
      name: result.fullName || "",
      headline: "",
      localisation: "",
      profileImageUrl: result.photoUrl || "",
      photoUrl: result.photoUrl || "",
      photo_url: result.photoUrl || "",
      experiences,
      education,
      skills,
      infos,
      about: infos,
      current_job: experiences[0] || {},
      current_company: experiences[0]?.company || "",
      current_title: experiences[0]?.title || "",
      linkedinProfileUrl: result.linkedinUrl || "",
      linkedin_url: result.linkedinUrl || "",
      relationDegree: result.relationDegree || null,
      source: "focals-scraper-robust",
    };
  }

  function mapConnectionStatus(relationDegree) {
    const rel = (relationDegree || "").toString().toLowerCase();
    if (!rel) return "not_connected";
    if (rel.includes("pending")) return "pending";
    if (rel.includes("1")) return "connected";
    return "not_connected";
  }

  async function buildCandidateData() {
    const profile = await handleScrape("message_request");
    if (!profile) return null;

    const linkedin_url =
      profile.linkedin_url ||
      profile.linkedinProfileUrl ||
      profile.linkedinProfileURL ||
      profile.linkedinUrl ||
      "";

    const name = profile.name || profile.fullName || "";
    const [firstName, ...lastParts] = name.split(/\s+/).filter(Boolean);

    const current_job = profile.current_job || profile.experiences?.[0] || {};

    return {
      ...profile,
      name,
      current_title: profile.current_title || current_job.title || "",
      current_company: profile.current_company || current_job.company || "",
      localisation: profile.localisation || current_job.location || "",
      linkedin_url,
      photo_url: profile.photo_url || profile.photoUrl || profile.profileImageUrl || "",
      firstName: firstName || "",
      lastName: lastParts.join(" "),
      headline: profile.headline || profile.about || "",
      connection_status: mapConnectionStatus(profile.relationDegree || profile.relation_degree),
    };
  }

  async function handleScrape(reason) {
    const raw = await runOnce(reason);
    const normalized = normalizeForUi(raw);

    if (normalized) {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.set({ FOCALS_LAST_PROFILE: normalized });
        }
      } catch (err) {
        warn("Unable to persist profile", err);
      }

      if (typeof window.updateFocalsPanel === "function") {
        try {
          window.updateFocalsPanel(normalized);
        } catch (err) {
          warn("updateFocalsPanel failed", err);
        }
      }
    }

    return normalized || raw;
  }

  function scheduleRun(reason) {
    if (window.__FOCALS_TIMER) clearTimeout(window.__FOCALS_TIMER);
    window.__FOCALS_TIMER = setTimeout(() => handleScrape(reason), 350);
  }

  function installSpaWatcher() {
    if (window.__FOCALS_WATCHER_INSTALLED) return;
    window.__FOCALS_WATCHER_INSTALLED = true;

    let lastHref = location.href;

    const patch = (fnName) => {
      const orig = history[fnName];
      if (!orig || orig.__FOCALS_PATCHED) return;
      history[fnName] = function () {
        const ret = orig.apply(this, arguments);
        window.dispatchEvent(new Event("focals:navigation"));
        return ret;
      };
      history[fnName].__FOCALS_PATCHED = true;
    };
    patch("pushState");
    patch("replaceState");

    window.addEventListener("popstate", () => window.dispatchEvent(new Event("focals:navigation")));
    window.addEventListener("focals:navigation", () => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        scheduleRun("spa_navigation");
      }
    });

    const obs = new MutationObserver(() => {
      if (isProfileUrl(location.href)) scheduleRun("dom_mutation");
    });
    obs.observe(document.body, { childList: true, subtree: true });

    log("SPA watcher installed");
  }

  function dump() {
    const v = window.__FOCALS_LAST || null;
    log("Last JSON:", v);
    return v;
  }

  function logExperienceDescriptions(maxLen = 120) {
    const experiences = window.__FOCALS_LAST?.experiences || [];
    const rows = experiences.map((exp) => ({
      Titre: exp.Titre || null,
      Entreprise: exp.Entreprise || null,
      Description: exp.Description ? exp.Description.slice(0, maxLen) : null,
    }));
    console.table(rows);
    return rows;
  }

  window.FOCALS = {
    run: () => scheduleRun("manual_call"),
    dump,
    logExperienceDescriptions,
  };

  if (chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request?.type === "FOCALS_PING") {
        sendResponse({ status: "pong" });
        return true;
      }

      if (request?.type === "GET_CANDIDATE_DATA") {
        (async () => {
          try {
            const data = await buildCandidateData();
            sendResponse({ data });
          } catch (error) {
            sendResponse({ error: error?.message || "Scraping failed" });
          }
        })();

        return true;
      }

      if (request?.action === "SCRAPE_PROFILE") {
        handleScrape("message_request").then((data) => sendResponse({ status: "success", data }));
        return true;
      }
      if (request?.action === "PING") {
        sendResponse({ status: "pong" });
      }
      return undefined;
    });
  }

  log(
    "Ready. Autorun enabled. Also available:",
    "FOCALS.dump()",
    "FOCALS.run()",
    "FOCALS.logExperienceDescriptions()"
  );
  installSpaWatcher();
  scheduleRun("init");
})();
