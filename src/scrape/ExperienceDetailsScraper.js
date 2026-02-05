import { logger } from "../utils/logger.js";
import ScrapeController from "./ScrapeController.js";
import { createDomObserver, listenToNavigation } from "./domObservers.js";
import { extractDetailsDescription } from "./experienceDetailsDescription.js";
import { extractSkillsFromExperienceItem } from "./experienceDetailsSkills.js";

export const URL_PATTERNS = {
  EXPERIENCE_DETAILS: /\/details\/experience\/?$/i,
};

const DETAILS_STORAGE_PREFIX = "focals_experience_details";
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;

const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");

const getPublicIdentifierFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/]+)/i);
    return match?.[1] || null;
  } catch (err) {
    const match = String(url || "").match(/\/in\/([^/]+)/i);
    return match?.[1] || null;
  }
};

const getDetailsStorageKey = (publicIdentifier) =>
  publicIdentifier ? `${DETAILS_STORAGE_PREFIX}:${publicIdentifier}` : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const monthToken =
  /(janv\.?|févr\.?|f[ée]v\.?|mars|avr\.?|mai|juin|juil\.?|ao[uû]t|sept\.?|oct\.?|nov\.?|d[ée]c\.?|january|february|march|april|may|june|july|august|september|october|november|december)/i;
const looksLikeDates = (t) => {
  const s = clean(t);
  if (!s) return false;
  const hasRange = /-|–|—| to /i.test(s);
  if (!hasRange) return false;
  const hasYear = /\b(19\d{2}|20\d{2})\b/.test(s);
  const hasMonth = monthToken.test(s);
  const hasPresent = /aujourd|present|présent/i.test(s);
  return (hasMonth && (hasYear || hasPresent)) || (hasYear && hasRange);
};

const collapseDouble = (s) => {
  const t = clean(s);
  if (!t) return "";
  if (t.length % 2 === 0) {
    const h = t.length / 2;
    const a = t.slice(0, h);
    const b = t.slice(h);
    if (a === b) return a;
  }
  const m = t.match(/^(.+?)\1$/);
  if (m && m[1]) return clean(m[1]);
  return t;
};

const looksLikeLocation = (t) => {
  const s = clean(t);
  if (!s) return false;
  if (looksLikeDates(s)) return false;
  if (s.includes("·")) return false;
  return /(,| Area\b|Région|Île-de-France|France)\b/i.test(s) && s.length <= 140;
};

const EMPLOYMENT_RE =
  /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i;

const isNoise = (t) => {
  const s = clean(t);
  if (!s) return true;
  if (/^(afficher plus|see more|show more)$/i.test(s)) return true;
  if (/^\d+\s+(mois|ans?)$/i.test(s)) return true;
  if (/^de\s/i.test(s) && monthToken.test(s)) return true;
  return false;
};

const getLines = (scope) => {
  const nodes = Array.from(scope.querySelectorAll("p, span[aria-hidden='true']"));
  const raw = nodes.map((n) => collapseDouble(n.textContent)).map(clean).filter(Boolean);
  const out = [];
  for (const r of raw) {
    if (!r) continue;
    if (out[out.length - 1] === r) continue;
    out.push(r);
  }
  return out;
};

const pickTitle = (li) => {
  const n = li.querySelector("div.t-bold span[aria-hidden='true'], div.t-bold, span.t-bold");
  return collapseDouble(clean(n?.textContent));
};

const pickHeaderCompany = (groupLi) => {
  const nodes = Array.from(groupLi.querySelectorAll("div.t-bold, span.t-bold"))
    .filter((n) => !n.closest(".pvs-entity__sub-components"))
    .map((n) => collapseDouble(n.textContent))
    .map(clean)
    .filter(Boolean);
  return nodes[0] || "";
};

const extractGroupCompanyName = (li) => {
  if (!li) return null;
  const companyLink = Array.from(li.querySelectorAll('a[href*="/company/"]')).find(
    (a) => clean(a.textContent).length >= 2
  );
  const linkText = clean(companyLink?.textContent);
  if (linkText) return linkText;

  const imgAlt = clean(li.querySelector('img[alt*="Logo"]')?.getAttribute("alt"));
  const match = imgAlt.match(/logo\s+de\s+(.+)/i);
  if (match?.[1]) return clean(match[1]);

  return null;
};

const pickDates = (scope, title = "") => {
  const lines = getLines(scope).filter((l) => l && l !== title);
  const candidates = lines.filter(looksLikeDates).filter((l) => l.length <= 120);
  if (!candidates.length) return "";
  const scored = candidates
    .map((l) => {
      let score = 0;
      if (/\s-\s| - /.test(l)) score += 3;
      if (/\b(19\d{2}|20\d{2})\b/.test(l)) score += 2;
      if (/aujourd|present/i.test(l)) score += 1;
      if (/^De\s/i.test(l)) score -= 1;
      return [l, score];
    })
    .sort((a, b) => b[1] - a[1]);
  return scored[0][0];
};

const pickCompanyFromDotLine = (scope, title = "") => {
  const lines = getLines(scope);
  const dotLine = lines.find((l) => l.includes("·") && !looksLikeDates(l) && l.length <= 160);
  if (!dotLine) return "";
  const first = collapseDouble(clean(dotLine.split("·")[0]));
  if (!first) return "";
  if (title && first.toLowerCase() === title.toLowerCase()) return "";
  if (looksLikeLocation(first)) return "";
  return first;
};

const pickCompanyFallback = (scope, title = "") => {
  const lines = getLines(scope);
  const idx = lines.findIndex((l) => clean(l).toLowerCase() === clean(title).toLowerCase());
  if (idx >= 0) {
    const next = lines[idx + 1] || "";
    const c = collapseDouble(next);
    if (c && !looksLikeDates(c) && !looksLikeLocation(c) && !isNoise(c) && c.length <= 120) {
      return clean(c.split("·")[0]);
    }
  }
  const candidates = lines.filter((l) => {
    const s = clean(l);
    if (!s) return false;
    if (title && s.toLowerCase() === title.toLowerCase()) return false;
    if (looksLikeDates(s) || looksLikeLocation(s) || isNoise(s)) return false;
    if (s.length > 140) return false;
    return true;
  });
  if (!candidates.length) return "";
  return clean(candidates[0].split("·")[0]);
};

const pickLocation = (scope) => {
  const location = getLines(scope).find(looksLikeLocation);
  return location ? collapseDouble(location) : "";
};

const findExperienceSectionRoot = (main) => {
  if (!main) return null;
  const heading = Array.from(main.querySelectorAll("h1, h2, h3")).find((el) =>
    /exp[ée]rience/i.test(clean(el.textContent))
  );
  if (!heading) return null;
  return heading.closest("section");
};

const SEE_MORE_REGEX = /(voir plus|see more|show more|afficher la suite)/i;

const clickSeeMoreInItem = (item) => {
  if (!item) return false;
  const scope = item.querySelector(".pvs-entity__sub-components") || item;
  if (!scope || scope.dataset?.focalsSeeMoreClicked) return false;
  const buttons = Array.from(scope.querySelectorAll("button, a"))
    .map((el) => ({
      el,
      label: `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim(),
    }))
    .filter(({ label }) => SEE_MORE_REGEX.test(label));
  const target = buttons.find(({ el }) => !el.disabled)?.el;
  if (target) {
    target.click();
    scope.dataset.focalsSeeMoreClicked = "true";
    return true;
  }
  return false;
};

const expandSeeMoreButtons = async (items) => {
  let clicked = 0;
  for (const item of items) {
    if (clickSeeMoreInItem(item)) clicked += 1;
  }
  if (clicked > 0) {
    await sleep(200);
  }
  return clicked;
};

export async function scrapeExperienceDetailsDocument(root = document) {
  const main =
    root.querySelector('main[role="main"]') ||
    root.querySelector("main") ||
    root.querySelector('[role="main"]') ||
    root.body ||
    root;
  let experienceSection = null;
  let rootMode = "MAIN";

  const anchor = main?.querySelector?.("#experience");
  if (anchor) {
    experienceSection =
      anchor.closest("section") || anchor.parentElement?.closest("section") || anchor.parentElement;
    rootMode = "ANCHOR";
  } else {
    const headingRoot = findExperienceSectionRoot(main);
    if (headingRoot) {
      experienceSection = headingRoot;
      rootMode = "HEADING";
    }
  }

  if (!experienceSection && main) {
    const sections = Array.from(main.querySelectorAll("section"));
    if (sections.length) {
      const scored = sections
        .map((section) => ({ section, score: clean(section.textContent || "").length }))
        .sort((a, b) => b.score - a.score);
      experienceSection = scored[0].section;
      rootMode = "LARGEST_SECTION";
    }
  }

  const scope = experienceSection || main || root;
  const allLis = Array.from(scope.querySelectorAll("li"));
  const pagedLis = allLis.filter((li) => li.classList?.contains("pvs-list__paged-list-item"));
  const topLis = pagedLis.length
    ? pagedLis
    : allLis.filter((li) => {
        if (li.closest(".pvs-entity__sub-components")) return false;
        if (!li.querySelector("div.t-bold, span.t-bold")) return false;
        if (clean(li.innerText || "").length <= 25) return false;
        return true;
      });

  await expandSeeMoreButtons(topLis);

  const results = [];
  const seen = new Set();
  const parsedRecords = [];
  const duplicateKeys = [];
  const counts = { topLis: topLis.length, grouped: 0, singles: 0, skipped: 0 };

  const pushExperience = (record) => {
    const key = [record.title, record.company, record.dates, record.location]
      .map((v) => clean(v).toLowerCase())
      .join("|");
    if (seen.has(key)) {
      duplicateKeys.push(key);
      return;
    }
    seen.add(key);
    results.push(record);
  };

  for (const li of topLis) {
    const subComponents = li.querySelector(".pvs-entity__sub-components");
    const roleLis = subComponents ? Array.from(subComponents.querySelectorAll("li")) : [];

    if (roleLis.length) {
      counts.grouped += 1;
      const headerTitle = pickTitle(li);
      const headerCompany =
        pickHeaderCompany(li) ||
        extractGroupCompanyName(li) ||
        pickCompanyFromDotLine(li, headerTitle) ||
        pickCompanyFallback(li, headerTitle) ||
        headerTitle ||
        null;

      for (const roleLi of roleLis) {
        const title = pickTitle(roleLi);
        const dates = pickDates(roleLi, title) || pickDates(li, title);
        if (!title || !dates) {
          counts.skipped += 1;
          continue;
        }

        let company = headerCompany;
        if (!company || isNoise(company) || (title && company.toLowerCase() === clean(title).toLowerCase())) {
          company =
            pickCompanyFromDotLine(roleLi, title) ||
            pickCompanyFallback(roleLi, title) ||
            pickCompanyFromDotLine(li, title) ||
            pickCompanyFallback(li, title) ||
            company;
        }

        if (!company || isNoise(company) || (title && company.toLowerCase() === clean(title).toLowerCase())) {
          counts.skipped += 1;
          continue;
        }

        const location = pickLocation(roleLi) || pickLocation(li);
        const ctx = { title, company, companyLine: company, dates, location, workplaceType: null };
        const description = extractDetailsDescription(roleLi, ctx);
        const { skills, skillsMoreCount } = extractSkillsFromExperienceItem(roleLi);

        const record = {
          title: clean(title),
          company: clean(company),
          dates: clean(dates),
          location: clean(location || ""),
          workplaceType: null,
          description: description || null,
          skills,
          skillsMoreCount,
        };
        parsedRecords.push(record);
        pushExperience(record);
      }
      continue;
    }

    counts.singles += 1;
    const title = pickTitle(li);
    const dates = pickDates(li, title);
    let company = pickCompanyFromDotLine(li, title) || pickCompanyFallback(li, title) || null;

    if (!company || isNoise(company) || (title && company.toLowerCase() === clean(title).toLowerCase())) {
      const fallback = pickCompanyFallback(li, title);
      if (fallback && !isNoise(fallback)) company = fallback;
    }

    if (!title || !company || !dates || isNoise(company)) {
      counts.skipped += 1;
      continue;
    }

    const location = pickLocation(li);
    const ctx = { title, company, companyLine: company, dates, location, workplaceType: null };
    const description = extractDetailsDescription(li, ctx);
    const { skills, skillsMoreCount } = extractSkillsFromExperienceItem(li);

    const record = {
      title: clean(title),
      company: clean(company),
      dates: clean(dates),
      location: clean(location || ""),
      workplaceType: null,
      description: description || null,
      skills,
      skillsMoreCount,
    };
    parsedRecords.push(record);
    pushExperience(record);
  }

  const debug = { rootMode, counts, duplicateKeysCount: duplicateKeys.length };
  return { experiences: results, debug, parsedRecordsCount: parsedRecords.length };
}

export function installExperienceDetailsScraper({ onScrapeDone } = {}) {
  const LOG_SCOPE = "SCRAPER";
  const controller = new ScrapeController({
    onScrape: async (reason, shouldAbort) => {
      if (shouldAbort()) return;
      if (!URL_PATTERNS.EXPERIENCE_DETAILS.test(location.pathname)) return;

      const publicIdentifier = getPublicIdentifierFromUrl(location.href);
      if (!publicIdentifier) {
        logger.warn(LOG_SCOPE, "Missing public identifier; skipping details scrape");
        return;
      }

      const { experiences, debug } = await scrapeExperienceDetailsDocument(document);
      if (shouldAbort()) return;

      const key = getDetailsStorageKey(publicIdentifier);
      const payload = {
        publicIdentifier,
        profileUrl: location.href,
        experiences,
        debug,
      };
      if (key) {
        await chrome.storage.local.set({
          [key]: { ts: Date.now(), payload },
        });
      }
      window.__FOCALS_DETAILS_LAST = payload;
      logger.info(LOG_SCOPE, "Stored experience details", {
        publicIdentifier,
        count: experiences.length,
        reason,
      });
      if (typeof onScrapeDone === "function") onScrapeDone(payload);
    },
  });

  const observer = createDomObserver({
    targetSelector: "main",
    debounceMs: 450,
    onStable: (reason) => controller.trigger(reason),
  });

  const handleNavigation = (reason = "navigation") => {
    if (URL_PATTERNS.EXPERIENCE_DETAILS.test(location.pathname)) {
      controller.start();
      observer.start();
      controller.trigger(reason);
    } else {
      observer.stop();
      controller.pause();
    }
  };

  listenToNavigation(handleNavigation);
  handleNavigation("init");

  const publicIdentifier = getPublicIdentifierFromUrl(location.href);
  if (publicIdentifier) {
    const key = getDetailsStorageKey(publicIdentifier);
    chrome.storage.local.get([key]).then((stored) => {
      const entry = stored?.[key];
      if (!entry?.ts) return;
      if (Date.now() - entry.ts < DETAILS_TTL_MS) return;
      chrome.storage.local.remove(key);
    });
  }

  return { controller, observer };
}

export { getPublicIdentifierFromUrl, getDetailsStorageKey, DETAILS_TTL_MS };
