(async () => {
  if (window !== window.top) return;

  const safeGetURL = (path) => {
    if (!path || typeof path !== "string") return null;
    try {
      return chrome.runtime.getURL(path);
    } catch (err) {
      return null;
    }
  };

  const loggerUrl = safeGetURL("src/utils/logger.js");
  if (!loggerUrl) {
    console.error("[FOCALS] Fatal: Invalid Logger Path");
    return;
  }

  const { createLogger } = await import(loggerUrl);
  const logger = createLogger("FocalsContent");
  const log = (...a) => logger.info(...a);
  const dlog = (...a) => logger.debug(...a);
  const warn = (...a) => logger.warn(...a);
  const DEBUG = false;

  const seenSignatures = new Set();

  const relayMessage = (text, source) => {
    const cleanText = text.trim();
    if (cleanText.length <= 2 || seenSignatures.has(cleanText)) return;

    seenSignatures.add(cleanText);
    console.log(`🎯 [RADAR ${source}] :`, cleanText);

    chrome.runtime.sendMessage({
      type: "FOCALS_INCOMING_RELAY",
      payload: {
        text: cleanText,
        type: `linkedin_${source.toLowerCase()}`,
        received_at: new Date().toISOString(),
      },
    });
  };

  // --- RADAR RÉSEAU ---
  const injectNetworkSpy = () => {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/content/linkedinVoyagerInterceptor.js");
    (document.head || document.documentElement).appendChild(s);
  };

  window.addEventListener("message", (event) => {
    if (event.data?.type === "FOCALS_NETWORK_DATA") {
      const extract = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (typeof obj.text === "string") relayMessage(obj.text, "NETWORK");
        if (obj.body && typeof obj.body.text === "string") relayMessage(obj.body.text, "NETWORK");
        for (let key in obj) extract(obj[key]);
      };
      extract(event.data.data);
    }
  });

  // --- RADAR DOM (LIVE) ---
  const setupDomObserver = () => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            const bubbles = node.querySelectorAll(
              ".msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble"
            );
            bubbles.forEach((b) => relayMessage(b.innerText, "DOM_LIVE"));
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  injectNetworkSpy();
  setupDomObserver();

  const scrapeUrl = safeGetURL("src/scrape/ScrapeController.js");
  if (!scrapeUrl) {
    logger.error("Fatal: Invalid ScrapeController Path");
    return;
  }
  const domObserverUrl = safeGetURL("src/scrape/domObservers.js");
  if (!domObserverUrl) {
    logger.error("Fatal: Invalid domObservers Path");
    return;
  }

  const { ScrapeController, ScrapeState } = await import(scrapeUrl);
  const { createDomObserver, listenToNavigation } = await import(domObserverUrl);

  const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const INLINE_DATE_GLUE_RE = /(\d)\s*(an|ans|mois|yr|yrs|mos)\s*(De|Du)\s+/i;
  let dedupeSampleCount = 0;

  function dedupeInlineRepeats(text) {
    const normalized = clean(text);
    if (!normalized) return "";

    if (normalized.length % 2 === 0) {
      const half = normalized.slice(0, normalized.length / 2);
      if (half === normalized.slice(normalized.length / 2)) return half;
    }

    const gluedMatch = normalized.match(INLINE_DATE_GLUE_RE);
    if (gluedMatch) {
      return normalized.slice(0, gluedMatch.index).trim();
    }

    const chunks = normalized
      .split("·")
      .map(clean)
      .filter(Boolean);
    const dedupedChunks = [];
    for (const chunk of chunks) {
      const prev = dedupedChunks[dedupedChunks.length - 1];
      if (prev && prev.toLowerCase() === chunk.toLowerCase()) continue;
      dedupedChunks.push(chunk);
    }
    let joined = dedupedChunks.join(" · ");
    const prefixMatch = joined.match(/^(.{3,60})\s+\1\b/i);
    if (prefixMatch) {
      joined = joined.replace(prefixMatch[0], prefixMatch[1]);
    }
    return joined;
  }

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

  const SKILLS_LABEL_RE = /Comp[ée]tences\s*:/i;
  const SKILLS_MORE_RE = /(\d+)\s+comp[ée]tences?\s+de\s+plus/i;
  let skillsDebugCount = 0;

  const expDlog = (...args) => {
    if (skillsDebugCount >= 2) return;
    skillsDebugCount += 1;
    dlog(...args);
  };

  const uniqCaseInsensitive = (arr) => {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const val = clean(item);
      if (!val) continue;
      const key = val.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(val);
    }
    return out;
  };

  const dedupeExperiences = (experiences) => {
    const seen = new Set();
    const out = [];
    for (const exp of experiences) {
      const title = clean(exp?.Titre);
      const company = clean(exp?.Entreprise);
      const dates = clean(exp?.Dates);
      const location = clean(exp?.Lieu);
      const key = [title, company, dates, location].join("||").toLowerCase();
      if (!title || !company || !dates) {
        out.push(exp);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(exp);
    }
    return out;
  };

  const findLastSkillLabelSlice = (raw) => {
    const matches = [...raw.matchAll(/comp[ée]tences/gi)];
    if (!matches.length) return raw;
    const last = matches[matches.length - 1];
    return raw.slice(last.index + last[0].length);
  };

  function extractSkillsFromExperienceItem(li) {
    if (!li?.querySelector) return { skills: [], skillsMoreCount: null };
    const scope = li.querySelector(".pvs-entity__sub-components") || li;
    if (!scope) return { skills: [], skillsMoreCount: null };

    const candidates = Array.from(scope.querySelectorAll("span, div, p")).filter((node) =>
      SKILLS_LABEL_RE.test(node.textContent || "")
    );
    if (!candidates.length) return { skills: [], skillsMoreCount: null };

    const chosen = candidates.sort(
      (a, b) => (a.textContent || "").length - (b.textContent || "").length
    )[0];

    const raw = chosen?.textContent || "";
    let after = findLastSkillLabelSlice(raw);
    const colonIndex = after.lastIndexOf(":");
    if (colonIndex >= 0) {
      after = after.slice(colonIndex + 1);
    } else {
      const rawColonIndex = raw.lastIndexOf(":");
      if (rawColonIndex >= 0) {
        after = raw.slice(rawColonIndex + 1);
      }
    }

    let skillsMoreCount = null;
    const moreMatch = after.match(SKILLS_MORE_RE);
    if (moreMatch) {
      skillsMoreCount = Number.parseInt(moreMatch[1], 10);
      after = after.replace(SKILLS_MORE_RE, "");
    }

    const separator = after.includes("·") ? "·" : "\n";
    const tokens = after
      .split(separator)
      .map(clean)
      .filter(Boolean)
      .filter((t) => !/comp[ée]tences/i.test(t));

    const skills = uniqCaseInsensitive(tokens);
    return { skills, skillsMoreCount };
  }

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

  // FIX: plus strict + garde-fou longueur, pour éviter de prendre une description comme "Lieu"
  function looksLikeLocation(s) {
    const t = clean(s);
    if (!t) return false;
    if (t.length > 120) return false;

    // patterns typiques LinkedIn
    const hasWorkMode = /(sur site|hybride|à distance|remote|on[- ]site)/i.test(t);
    const hasGeo =
      /(france|paris|île-de-france|ile-de-france|région|region|london|berlin|madrid|barcelona|bruxelles|brussels|amsterdam|lisbon|lisbonne)/i.test(
        t
      );

    // si aucun signal géographique, on rejette
    return hasWorkMode || hasGeo;
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

  function parseLegacyExperienceLi(li, index) {
    const entity = li.querySelector('div[data-view-name="profile-component-entity"]');
    if (!entity)
      return { _idx: index, _ok: false, Titre: null, Entreprise: null, Dates: null, Lieu: null };

    const mainLink =
      entity.querySelector('a.optional-action-target-wrapper.display-flex.flex-column.full-width[href]') ||
      Array.from(entity.querySelectorAll('a[href]')).find((a) => a.querySelector(".hoverable-link-text.t-bold")) ||
      entity.querySelector('a[href]') ||
      null;

    if (!mainLink)
      return { _idx: index, _ok: false, Titre: null, Entreprise: null, Dates: null, Lieu: null };

    const title =
      dedupeInlineRepeats(mainLink.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent) ||
      dedupeInlineRepeats(mainLink.querySelector(".hoverable-link-text.t-bold")?.textContent) ||
      null;

    const company =
      dedupeInlineRepeats(mainLink.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent) ||
      dedupeInlineRepeats(mainLink.querySelector("span.t-14.t-normal")?.textContent) ||
      null;

    const dates =
      clean(mainLink.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent) ||
      clean(mainLink.querySelector("span.pvs-entity__caption-wrapper")?.textContent) ||
      null;

    let lightSpans = Array.from(
      mainLink.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => {
        const raw = clean(n.textContent);
        const deduped = dedupeInlineRepeats(raw);
        if (DEBUG && dedupeSampleCount < 3 && raw && deduped && raw !== deduped) {
          console.log("[FOCALS][DEDUP] sample", { before: raw, after: deduped });
          dedupeSampleCount += 1;
        }
        return deduped;
      })
      .filter(Boolean);

    if (!lightSpans.length) {
      lightSpans = Array.from(mainLink.querySelectorAll("span.t-14.t-normal.t-black--light"))
        .map((n) => {
          const raw = clean(n.textContent);
          const deduped = dedupeInlineRepeats(raw);
          if (DEBUG && dedupeSampleCount < 3 && raw && deduped && raw !== deduped) {
            console.log("[FOCALS][DEDUP] sample", { before: raw, after: deduped });
            dedupeSampleCount += 1;
          }
          return deduped;
        })
        .filter(Boolean);
    }

    lightSpans = uniq(lightSpans);

    // FIX: plus de fallback "random span"
    const location = lightSpans.find((t) => looksLikeLocation(t) && t !== dates) || null;

    const { description, descriptionBullets } = extractExperienceDescription(li);
    const { skills, skillsMoreCount } = extractSkillsFromExperienceItem(li);
    if (skills.length || skillsMoreCount) {
      expDlog("SKILLS_DEBUG", { title, company, skills, skillsMoreCount });
    }

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
      Skills: skills,
      SkillsMoreCount: skillsMoreCount,
    };
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
      .map((p) => {
        const raw = clean(p.textContent);
        const deduped = dedupeInlineRepeats(raw);
        if (DEBUG && dedupeSampleCount < 3 && raw && deduped && raw !== deduped) {
          console.log("[FOCALS][DEDUP] sample", { before: raw, after: deduped });
          dedupeSampleCount += 1;
        }
        return deduped;
      })
      .filter(Boolean)
      .filter((t) => !/compétences de plus|skills|programming language/i.test(t));

    ps = uniq(ps);

    const title = ps[0] || null;

    let company = null;
    if (ps[1]) company = clean(dedupeInlineRepeats(ps[1]).split("·")[0]);

    const dates = ps.find((t) => looksLikeDates(t)) || null;

    // garde le même comportement, mais looksLikeLocation est désormais plus strict
    const location = ps.find((t) => looksLikeLocation(t) && t !== dates) || null;

    const { description, descriptionBullets } = extractExperienceDescription(item);
    const { skills, skillsMoreCount } = extractSkillsFromExperienceItem(item);
    if (skills.length || skillsMoreCount) {
      expDlog("SKILLS_DEBUG", { title, company, skills, skillsMoreCount });
    }

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
      Skills: skills,
      SkillsMoreCount: skillsMoreCount,
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
      const ok = dedupeExperiences(parsed.filter((x) => x._ok));
      return { mode: "SDUI_ITEMS", experiences: ok, counts };
    }

    if (legacyLis.length) {
      const parsed = legacyLis.map((li, i) => parseLegacyExperienceLi(li, i));
      const ok = dedupeExperiences(parsed.filter((x) => x._ok));
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
      infos,
      experiences: ready.collected.experiences,
      debug: {
        experienceRootMode: ready.pick.mode,
        experienceCollectionMode: ready.collected.mode,
        experienceCounts: ready.collected.counts,
        experienceRootPath: elementPath(ready.pick.root),
      },
    };

    window.__FOCALS_LAST = result;

    dlog(`SCRAPE (${reason})`, {
      fullName: result.fullName,
      relationDegree: result.relationDegree,
      photoUrl: result.photoUrl,
      linkedinUrl: result.linkedinUrl,
      experiences: result.experiences.length,
    });

    if (!result.experiences.length) {
      warn("No experiences parsed");
    } else {
      if (DEBUG) {
        console.table(
          result.experiences.slice(0, 8).map((e) => ({
            Titre: e.Titre,
            Entreprise: e.Entreprise,
            Dates: e.Dates,
            Lieu: e.Lieu,
          }))
        );
      }
      dlog(
        "EXPERIENCES",
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
      skills: exp.Skills || [],
      skillsMoreCount: exp.SkillsMoreCount ?? null,
      skillsText: (exp.Skills || []).join(" · "),
    }));

    const infos = result.infos || "";

    return {
      name: result.fullName || "",
      headline: "",
      localisation: "",
      profileImageUrl: result.photoUrl || "",
      photoUrl: result.photoUrl || "",
      photo_url: result.photoUrl || "",
      experiences,
      infos,
      about: infos,
      current_job: experiences[0] || {},
      current_company: experiences[0]?.company || "",
      linkedinProfileUrl: result.linkedinUrl || "",
      linkedin_url: result.linkedinUrl || "",
      relationDegree: result.relationDegree || null,
      source: "focals-scraper-robust",
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

  const controller = new ScrapeController({
    onScrape: (reason) => handleScrape(reason),
    onStateChange: (state) => updateControls(state),
  });

  let domObserver = null;

  function updateControls(state) {
    updateButton(state);
    if (state === ScrapeState.RUNNING) {
      startObserver();
    } else {
      stopObserver();
    }
  }

  function startObserver() {
    stopObserver();
    domObserver = createDomObserver({
      targetSelector: "main",
      debounceMs: 600,
      onStable: (reason) => controller.trigger(reason || "mutation"),
    });
    domObserver.start();
  }

  function stopObserver() {
    if (domObserver) domObserver.stop();
    domObserver = null;
  }

  listenToNavigation((reason) => controller.trigger(reason || "navigation"));

  function dump() {
    const v = window.__FOCALS_LAST || null;
    log("Last JSON:", v ? "cached" : "none");
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

  function updateButton(state) {
    const btn = document.getElementById("focals-control-btn");
    if (!btn) return;
    const labels = {
      [ScrapeState.IDLE]: "Focals: prêt",
      [ScrapeState.RUNNING]: "Focals: scraping…",
      [ScrapeState.PAUSED]: "Focals: en pause",
      [ScrapeState.STOPPED]: "Focals: stoppé",
      [ScrapeState.ERROR]: "Focals: erreur",
    };
    btn.textContent = labels[state] || "Focals";
  }

  function installButton() {
    if (document.getElementById("focals-control-btn")) return;
    const btn = document.createElement("button");
    btn.id = "focals-control-btn";
    btn.type = "button";
    btn.textContent = "Focals: prêt";
    btn.style.position = "fixed";
    btn.style.bottom = "16px";
    btn.style.right = "16px";
    btn.style.zIndex = 2147483646;
    btn.style.padding = "8px 12px";
    btn.style.background = "#0a66c2";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "8px";
    btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    btn.style.cursor = "pointer";
    btn.onclick = () => {
      if (controller.state === ScrapeState.RUNNING) {
        controller.stop();
      } else {
        controller.start();
        controller.trigger("user");
      }
      updateButton(controller.state);
    };
    document.body.appendChild(btn);
  }

  window.FOCALS = {
    run: () => {
      controller.start();
      controller.trigger("manual_call");
    },
    dump,
    logExperienceDescriptions,
    stop: () => controller.stop(),
  };

  if (chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request?.action === "SCRAPE_PROFILE") {
        controller.start();
        controller.trigger("message_request").then((data) => sendResponse({ status: "success", data }));
        return true;
      }
      if (request?.action === "PING") {
        sendResponse({ status: "pong" });
      }
      return undefined;
    });
  }

  log("Ready. Click the Focals button to scrape. Also available: FOCALS.logExperienceDescriptions()");
  installButton();
})();
