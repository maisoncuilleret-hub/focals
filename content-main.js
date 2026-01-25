(() => {
  const TAG = "🧪 FOCALS CONSOLE";
  const DEBUG = (() => {
    try {
      return localStorage.getItem("FOCALS_DEBUG") === "true";
    } catch (err) {
      return false;
    }
  })();

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const dlog = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);

  const EXP_TAG = "[FOCALS][EXPERIENCE]";
  const expLog = (...a) => DEBUG && console.log(EXP_TAG, ...a);
  const expDlog = (...a) => DEBUG && console.log(EXP_TAG, ...a);
  const expWarn = (...a) => DEBUG && console.warn(EXP_TAG, ...a);

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
  const normalizeProfilePath = (pathname = "") => {
    const normalized = pathname.replace(/\/$/, "");
    const match = normalized.match(/^\/in\/[^/]+/i);
    return match ? match[0] : null;
  };
  const canonicalProfileUrl = (u) => {
    try {
      const url = new URL(u, window.location.origin);
      url.search = "";
      url.hash = "";
      const basePath = normalizeProfilePath(url.pathname);
      if (!basePath) return null;
      return `${url.origin}${basePath}`;
    } catch {
      return null;
    }
  };
  const isDetailsExperiencePath = (pathname) => /\/details\/experience\/?$/i.test(pathname || "");

  const getStorageValue = (key) =>
    new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(null);
        return;
      }
      try {
        chrome.storage.local.get(key, (result) => resolve(result?.[key] ?? null));
      } catch (err) {
        warn("Storage get failed", err);
        resolve(null);
      }
    });

  const setStorageValue = (values) =>
    new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.set(values, () => resolve(true));
      } catch (err) {
        warn("Storage set failed", err);
        resolve(false);
      }
    });

  const persistLastProfile = async (profile) => {
    if (!profile) return;
    await setStorageValue({ FOCALS_LAST_PROFILE: profile });
  };

  const readProfileCache = async (profileUrl) => {
    if (!profileUrl) return null;
    const entry = await getStorageValue(profileUrl);
    if (!entry || typeof entry !== "object") return null;
    return entry;
  };

  const writeProfileCache = async (profileUrl, entry) => {
    if (!profileUrl || !entry) return false;
    return setStorageValue({ [profileUrl]: entry });
  };

  const readLastScrapeAt = async () => {
    const value = await getStorageValue(LAST_SCRAPE_AT_KEY);
    return Number.isFinite(value) ? value : 0;
  };

  const writeLastScrapeAt = async (value) => {
    if (!Number.isFinite(value)) return false;
    return setStorageValue({ [LAST_SCRAPE_AT_KEY]: value });
  };

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const COOLDOWN_BASE_MS = 90 * 1000;
  const COOLDOWN_JITTER_MS = 1500;
  const LAST_SCRAPE_AT_KEY = "FOCALS_LAST_SCRAPE_AT";
  let scrapeInFlight = false;
  let lastResult = null;
  let lastResultAt = 0;
  const detailsScrapeInFlight = new Map();

  const getExperienceDetailsUrl = (root = document) => {
    const anchor = root.querySelector('a[href*="/details/experience/"]');
    const href = anchor?.getAttribute("href") || anchor?.href || "";
    if (href) {
      try {
        const resolved = new URL(href, window.location.origin);
        const basePath = normalizeProfilePath(resolved.pathname);
        return basePath ? `${resolved.origin}${basePath}/details/experience/` : resolved.toString();
      } catch (err) {
        return href;
      }
    }

    const { origin, pathname } = window.location;
    const basePath = normalizeProfilePath(pathname);
    if (basePath) {
      return `${origin}${basePath}/details/experience/`;
    }

    return null;
  };

  const EXPERIENCE_CTA_REGEX = /(voir tout|voir les|see all|show all|afficher tout|afficher les)/i;
  const EXPERIENCE_LABEL_REGEX = /exp[ée]rience/i;

  const parseExperienceCount = (text) => {
    const match = String(text || "").match(/(\d[\d\s\u00a0\u202f]*)/);
    if (!match) return null;
    const parsed = parseInt(match[1].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const getVisibleExperienceCount = (root) => {
    if (!root) return { count: 0, source: "no_root" };
    const collected = collectExperiences(root);
    let count = collected.experiences.length;
    let source = "parsed";

    if (!count) {
      const entities = Array.from(root.querySelectorAll('div[data-view-name="profile-component-entity"]'));
      if (entities.length) {
        count = entities.length;
        source = "entity-count";
      } else {
        const liItems = Array.from(root.querySelectorAll("li")).filter((li) =>
          li.querySelector("div.t-bold, span.t-bold")
        );
        count = liItems.length;
        source = "li-count";
      }
    }

    return { count, source };
  };

  const findExperienceCta = (root) => {
    if (!root) return null;
    const candidates = Array.from(
      root.querySelectorAll('a[href*="/details/experience/"], button, a')
    );
    for (const el of candidates) {
      const label = clean(`${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`);
      const href = el.getAttribute("href") || "";
      if (href && href.includes("/details/experience/")) {
        if (!label || EXPERIENCE_LABEL_REGEX.test(label) || EXPERIENCE_CTA_REGEX.test(label)) {
          return { type: "details_link", label, element: el };
        }
      }
      if (label && EXPERIENCE_CTA_REGEX.test(label)) {
        if (EXPERIENCE_LABEL_REGEX.test(label)) {
          return { type: "cta_text", label, element: el };
        }
        if (root.contains(el)) {
          return { type: "cta_text", label, element: el };
        }
      }
    }
    return null;
  };

  const evaluateExperienceDetailsNeed = (root = document) => {
    const pick = pickExperienceSection();
    const scope = pick.root || root;
    if (!scope) {
      return { shouldUse: false, reason: "no_root", totalCount: null, visibleCount: 0 };
    }

    const cta = findExperienceCta(scope);
    const ctaText = cta?.label || "";
    const totalCount = parseExperienceCount(ctaText);
    const { count: visibleCount, source } = getVisibleExperienceCount(scope);

    if (cta && totalCount && visibleCount && totalCount > visibleCount) {
      return {
        shouldUse: true,
        reason: "cta_count_mismatch",
        totalCount,
        visibleCount,
        source,
      };
    }

    if (cta && !totalCount) {
      return { shouldUse: true, reason: "cta_found", totalCount: null, visibleCount, source };
    }

    if (cta && totalCount && visibleCount && totalCount <= visibleCount) {
      return {
        shouldUse: false,
        reason: "cta_count_not_truncated",
        totalCount,
        visibleCount,
        source,
      };
    }

    return { shouldUse: false, reason: "no_signal", totalCount, visibleCount, source };
  };

  const shouldUseExperienceDetails = (root = document) =>
    evaluateExperienceDetailsNeed(root).shouldUse;

  const requestExperienceDetailsScrape = (detailsUrl, profileKey) =>
    new Promise((resolve, reject) => {
      if (!detailsUrl) {
        resolve([]);
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: "FOCALS_SCRAPE_DETAILS_EXPERIENCE", detailsUrl, profileKey },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || "Messaging failed"));
              return;
            }
            if (!response?.ok) {
              reject(new Error(response?.error || "Background scrape failed"));
              return;
            }
            resolve(Array.isArray(response.experiences) ? response.experiences : []);
          }
        );
      } catch (err) {
        reject(err);
      }
    });

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
    const html = node.innerHTML || "";
    const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
    return withBreaks.replace(/<[^>]*>/g, "");
  };

  const SKILLS_LABEL_REGEX = /(Comp[ée]tences|Skills)\s*:/i;
  const normalizeSkill = (skill) =>
    clean(skill)
      .replace(/\((langage de programmation|programming language)\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const extractSkillsFromExperienceNode = (node) => {
    if (!node) return [];
    const candidates = Array.from(node.querySelectorAll("span, div, p"))
      .map((el) => ({ el, text: clean(el.textContent) }))
      .filter((entry) => entry.text && SKILLS_LABEL_REGEX.test(entry.text));
    if (!candidates.length) return [];
    const chosen = candidates.reduce((best, entry) => {
      if (!best) return entry;
      return entry.text.length < best.text.length ? entry : best;
    }, null);
    const text = chosen?.text || "";
    const separatorIndex = text.indexOf(":");
    if (separatorIndex === -1) return [];
    const rawSkills = text.slice(separatorIndex + 1);
    const parts = rawSkills.split("·");
    const seen = new Set();
    const out = [];
    for (const part of parts) {
      const normalized = normalizeSkill(part);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  };

  const runSkillsSelfTest = (nodes = [], root) => {
    if (!DEBUG || !nodes.length || !isDetailsExperiencePath(location.pathname)) return;
    if (root?.dataset?.focalsSkillsSelfTest) return;
    const rows = nodes.slice(0, 5).map((node, index) => {
      const skills = extractSkillsFromExperienceNode(node);
      return { index, skills, skillsCount: skills.length };
    });
    if (rows.length) {
      console.table(rows);
    }
    if (root?.dataset) {
      root.dataset.focalsSkillsSelfTest = "true";
    }
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

    const finalText = deduped.join("\n").trim();
    if (!finalText || finalText.length < 30) return null;
    return finalText;
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
      dlog("Clicked see more for experience description");
      return true;
    }
    return false;
  };

  const extractExperienceDescription = (item) => {
    if (!item) return { description: null, descriptionBullets: null };
    const scope = item.querySelector(".pvs-entity__sub-components") || item;
    if (!scope) return { description: null, descriptionBullets: null };

    clickSeeMoreInItem(item);

    const candidates = [];
    const inlineNodes = scope.querySelectorAll(
      'div[class*="inline-show-more-text"] span[aria-hidden="true"]'
    );
    if (inlineNodes.length) {
      inlineNodes.forEach((node) => candidates.push(node));
    } else {
      scope.querySelectorAll('div[class*="inline-show-more-text"]').forEach((node) => candidates.push(node));
      scope.querySelectorAll("span[aria-hidden='true']").forEach((node) => candidates.push(node));
    }

    const raw = candidates.map(extractTextWithBreaks).filter(Boolean).join("\n");
    const description = normalizeDescriptionText(raw);
    if (!description) return { description: null, descriptionBullets: null };

    return { description, descriptionBullets: extractDescriptionBullets(description) };
  };

  const monthTokenRegex =
    /(janv\.?|févr\.?|f[ée]v\.?|mars|avr\.?|mai|juin|juil\.?|ao[uû]t|sept\.?|oct\.?|nov\.?|d[ée]c\.?|jan|feb|mar|apr|may|jun|jul|aug|sep|septembre|october|november|dec|january|february|march|april|june|july|august|september|october|november|december)/i;

  function looksLikeDateRange(text) {
    const t = clean(text).toLowerCase();
    if (!t) return false;
    if (/\b(19\d{2}|20\d{2})\b/.test(t) && (t.includes(" - ") || t.includes("–") || t.includes("—"))) {
      return true;
    }
    if (/\baujourd/i.test(t)) return true;
    return monthTokenRegex.test(t);
  }

  function isMostlyDatesText(text) {
    const t = clean(text).toLowerCase();
    if (!t) return false;
    if (
      /^(du|de)\s+.+\s+(au|a|à)\s+.+/i.test(t) &&
      (monthTokenRegex.test(t) || /\b(19\d{2}|20\d{2})\b/.test(t))
    ) {
      return true;
    }
    if (!looksLikeDateRange(t)) return false;
    const stripped = t
      .replace(monthTokenRegex, "")
      .replace(/\b(19\d{2}|20\d{2})\b/g, "")
      .replace(/\b(aujourd'hui|aujourd’hui|present|présent)\b/g, "")
      .replace(/[0-9]/g, "")
      .replace(/[\s·\-–—]+/g, "")
      .trim();
    return stripped.length < 6;
  }

  function isDateRangeLine(line) {
    return /^(du|from)\b.+\b(au|to)\b/i.test(line);
  }

  function buildMetaLines(ctx) {
    const title = clean(ctx?.title || "");
    const company = clean(ctx?.company || "");
    const companyLine = clean(ctx?.companyLine || "");
    const dates = clean(ctx?.dates || "");
    const location = clean(ctx?.location || "");
    const workplaceType = clean(ctx?.workplaceType || "");
    const combo = [location, workplaceType].filter(Boolean).join(" · ");
    return [title, company, companyLine, dates, location, workplaceType, combo].filter(Boolean);
  }

  function isTrivialMetaDescription(desc, ctx) {
    if (!desc) return true;
    const normalized = clean(desc).toLowerCase();
    if (!normalized) return true;
    const metaLines = buildMetaLines(ctx).map((line) => line.toLowerCase());
    if (metaLines.some((line) => line && normalized === line)) return true;
    const title = clean(ctx?.title || "").toLowerCase();
    if (title && normalized === `${title} ${title}`.trim()) return true;
    if (isDateRangeLine(desc) || isMostlyDatesText(desc)) return true;
    return false;
  }

  function normalizeDetailsDescription(text, ctx) {
    let normalized = normalizeInfosText(text || "");
    normalized = normalized.replace(/…\s*(voir plus|see more|show more|afficher la suite)\s*$/i, "").trim();
    normalized = fixSpacedUrls(normalized);
    if (!normalized) return null;

    const metaLines = buildMetaLines(ctx).map((line) => line.toLowerCase());
    const lines = normalized
      .split("\n")
      .map((line) => line.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const filtered = [];
    let lastKey = null;
    for (const line of lines) {
      if (/comp[ée]tences\s*:/i.test(line)) continue;
      if (isDateRangeLine(line) || isMostlyDatesText(line)) continue;
      if (isTrivialMetaDescription(line, ctx)) continue;
      const key = line.toLowerCase();
      if (metaLines.some((meta) => meta && key === meta)) continue;
      if (lastKey && key === lastKey) continue;
      filtered.push(line);
      lastKey = key;
    }

    const finalText = filtered.join("\n").trim();
    if (!finalText || finalText.length < 20 || isTrivialMetaDescription(finalText, ctx)) return null;
    return finalText;
  }

  function extractDetailsDescription(root, ctx) {
    if (!root) return null;
    const scope = root.querySelector(".pvs-entity__sub-components") || root;
    const preferredNodes = Array.from(
      scope.querySelectorAll(
        'div[class*="inline-show-more-text"] span[aria-hidden="true"]:not(.visually-hidden), .pv-shared-text-with-see-more span[aria-hidden="true"]:not(.visually-hidden)'
      )
    );
    const inlineNodes = preferredNodes.length
      ? preferredNodes
      : Array.from(
          scope.querySelectorAll('div[class*="inline-show-more-text"], .pv-shared-text-with-see-more')
        );

    const inlineText = inlineNodes.map(extractTextWithBreaks).filter(Boolean).join("\n");
    const normalizedInline = normalizeDetailsDescription(inlineText, ctx);
    if (DEBUG && !root.dataset?.focalsDescDebug) {
      const rawPreview = inlineNodes.map((node) => clean(extractTextWithBreaks(node))).filter(Boolean);
      expDlog("DESC_DEBUG", {
        title: ctx?.title || null,
        rawPreview,
        outPreview: normalizedInline ? normalizedInline.slice(0, 160) : null,
      });
      root.dataset.focalsDescDebug = "true";
    }
    if (normalizedInline) return normalizedInline;
    return null;
  }

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

  const WORKPLACE_TYPE_RULES = [
    { regex: /\bsur site\b/i, value: "Sur site" },
    { regex: /\bhybride\b/i, value: "Hybride" },
    { regex: /\bt[ée]l[ée]travail\b/i, value: "Télétravail" },
    { regex: /\bon[- ]site\b/i, value: "On-site" },
    { regex: /\bhybrid\b/i, value: "Hybrid" },
    { regex: /\bremote\b/i, value: "Remote" },
  ];

  function normalizeWorkplaceType(s) {
    const t = clean(s);
    if (!t) return null;
    const rule = WORKPLACE_TYPE_RULES.find((entry) => entry.regex.test(t));
    return rule ? rule.value : null;
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
    if (normalizeWorkplaceType(t)) return false;

    const hasGeo =
      /(france|paris|île-de-france|ile-de-france|région|region|london|berlin|madrid|barcelona|bruxelles|brussels|amsterdam|lisbon|lisbonne)/i.test(
        t
      );

    return hasGeo;
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

  function splitCompanyLine(line) {
    if (!line) return { company: null, extras: [] };
    const parts = String(line)
      .split("·")
      .map(clean)
      .filter(Boolean);
    if (!parts.length) return { company: null, extras: [] };
    const first = parts[0];
    if (looksLikeEmploymentType(first)) {
      return { company: null, extras: parts };
    }
    return { company: first, extras: parts.slice(1) };
  }

  function extractGroupCompanyName(li) {
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
  }

  function extractTitleFromContainer(container) {
    if (!container) return null;
    return (
      clean(container.querySelector("div.t-bold span[aria-hidden='true']")?.textContent) ||
      clean(container.querySelector("div.t-bold span")?.textContent) ||
      clean(container.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent) ||
      clean(container.querySelector(".hoverable-link-text.t-bold")?.textContent) ||
      null
    );
  }

  function extractCompanyLineFromContainer(container) {
    if (!container) return null;
    return (
      clean(container.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent) ||
      clean(container.querySelector("span.t-14.t-normal")?.textContent) ||
      null
    );
  }

  function extractDatesFromContainer(container) {
    if (!container) return null;
    const caption =
      clean(container.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent) ||
      clean(container.querySelector("span.pvs-entity__caption-wrapper")?.textContent) ||
      null;
    if (caption) return caption;
    const fallback = Array.from(
      container.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => clean(n.textContent))
      .find((t) => looksLikeDates(t));
    return fallback || null;
  }

  function collectMetaLines(container) {
    if (!container) return [];
    let spans = Array.from(
      container.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => clean(n.textContent))
      .filter(Boolean);

    if (!spans.length) {
      spans = Array.from(container.querySelectorAll("span.t-14.t-normal.t-black--light"))
        .map((n) => clean(n.textContent))
        .filter(Boolean);
    }

    return uniq(spans);
  }

  function extractLocationAndWorkplaceType(lines) {
    let location = null;
    let workplaceType = null;

    for (const line of lines) {
      const parts = line.split("·").map(clean).filter(Boolean);
      const candidates = parts.length ? parts : [clean(line)];

      for (const part of candidates) {
        if (!part) continue;
        if (!workplaceType) {
          const detected = normalizeWorkplaceType(part);
          if (detected) {
            workplaceType = detected;
            continue;
          }
        }

        if (!location && (looksLikeLocation(part) || looksLikePlainLocationFallback(part))) {
          location = part;
        }
      }
    }

    return { location, workplaceType };
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
      return {
        _idx: index,
        _ok: false,
        Titre: null,
        Entreprise: companyOverride || null,
        Dates: null,
        Lieu: null,
        WorkplaceType: null,
      };

    const title = extractTitleFromContainer(entity) || extractTitleFromContainer(link) || null;
    const dates = extractDatesFromContainer(entity) || extractDatesFromContainer(link) || null;

    const companyLine = extractCompanyLineFromContainer(entity) || extractCompanyLineFromContainer(link);
    const { company: companyFromLine, extras } = splitCompanyLine(companyLine);
    const metaLines = uniq([...collectMetaLines(entity), ...extras]);

    const { location, workplaceType } = extractLocationAndWorkplaceType(
      metaLines.filter((t) => t && t !== dates && t !== title && t !== companyFromLine)
    );

    const company = companyOverride || companyFromLine || null;

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
      WorkplaceType: workplaceType,
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
      const headerTitle = extractTitleFromContainer(entity);
      const headerCompanyLine = extractCompanyLineFromContainer(entity);
      const headerCompany =
        extractGroupCompanyName(li) ||
        splitCompanyLine(headerCompanyLine).company ||
        headerTitle ||
        null;
      if (!headerCompany) {
        expLog("DETAILS_GROUPED_COMPANY_MISSING", {
          headerTitle,
          headerCompanyLine,
        });
      }
      const out = [];
      for (let i = 0; i < innerRoleEntities.length; i++) {
        const scopeItem = innerRoleEntities[i].closest("li") || li;
        const parsed = parseLegacyRoleEntity(innerRoleEntities[i], `${index}.${i}`, headerCompany, scopeItem);
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
    const subComponents = item.querySelector(".pvs-entity__sub-components");
    const groupedRoles = subComponents
      ? Array.from(subComponents.querySelectorAll("li")).filter(
          (li) => li.querySelector("div.t-bold") && li.querySelector(".pvs-entity__caption-wrapper")
        )
      : [];

    if (groupedRoles.length > 1) {
      const headerTitle = extractTitleFromContainer(item);
      const headerCompanyLine = extractCompanyLineFromContainer(item);
      const headerCompany =
        extractGroupCompanyName(item) ||
        splitCompanyLine(headerCompanyLine).company ||
        headerTitle ||
        null;
      if (!headerCompany) {
        expLog("DETAILS_GROUPED_COMPANY_MISSING", {
          headerTitle,
          headerCompanyLine,
        });
      }

      return groupedRoles
        .map((roleItem, roleIndex) => {
          const title = extractTitleFromContainer(roleItem);
          const dates = extractDatesFromContainer(roleItem);
          const { extras } = splitCompanyLine(extractCompanyLineFromContainer(roleItem));
          const metaLines = uniq([...collectMetaLines(roleItem), ...extras]);
          const { location, workplaceType } = extractLocationAndWorkplaceType(
            metaLines.filter((t) => t && t !== dates && t !== title && t !== headerCompany)
          );

          const { description, descriptionBullets } = extractExperienceDescription(roleItem);

          const company = headerCompany;
          const ok = !!(title && company && dates);

          return {
            _idx: `${index}.${roleIndex}`,
            _ok: ok,
            Titre: title,
            Entreprise: company,
            Dates: dates,
            Lieu: location,
            WorkplaceType: workplaceType,
            Description: description,
            DescriptionBullets: descriptionBullets,
          };
        })
        .filter((x) => x._ok);
    }

    const link =
      bestSduiLinkForItem(item) ||
      item.querySelector('a[href*="/company/"]') ||
      item.querySelector('a[href*="/school/"]') ||
      item.querySelector('a[href^="/company/"]') ||
      item.querySelector('a[href^="/school/"]') ||
      item.querySelector('a[href^="https://www.linkedin.com/company/"]') ||
      item.querySelector('a[href^="https://www.linkedin.com/school/"]') ||
      null;

    const title = extractTitleFromContainer(item) || extractTitleFromContainer(link);
    const dates = extractDatesFromContainer(item) || extractDatesFromContainer(link);
    const companyLine = extractCompanyLineFromContainer(item) || extractCompanyLineFromContainer(link);
    const { company, extras } = splitCompanyLine(companyLine);

    const pNodes = (link ? link.querySelectorAll("p") : item.querySelectorAll("p")) || [];
    let ps = Array.from(pNodes)
      .map((p) => clean(p.textContent))
      .filter(Boolean)
      .filter((t) => !/compétences de plus|competences de plus|skills|programming language/i.test(t));

    ps = uniq(ps);

    const metaCandidates = uniq([...collectMetaLines(item), ...extras, ...ps]).filter(
      (t) => t && t !== title && t !== company && t !== dates && !looksLikeEmploymentType(t)
    );

    const { location, workplaceType } = extractLocationAndWorkplaceType(metaCandidates);

    const { description, descriptionBullets } = extractExperienceDescription(item);

    const ok = !!(title && company && dates);
    return {
      _idx: index,
      _ok: ok,
      Titre: title,
      Entreprise: company,
      Dates: dates,
      Lieu: location,
      WorkplaceType: workplaceType,
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
      const parsed = sduiLikely.flatMap((it, i) => parseSduiExperienceItem(it, i));
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

  function pickDetailsExperienceSection(root = document) {
    const main =
      root.querySelector('main[role="main"]') ||
      root.querySelector("main") ||
      root.querySelector('[role="main"]') ||
      root.body;
    if (!main) return { mode: "NO_MAIN", root: null };

    const anchor = main.querySelector("#experience");
    if (anchor) {
      const section = anchor.closest("section") || anchor.parentElement?.closest("section") || anchor.parentElement;
      if (section) return { mode: "ANCHOR", root: section };
    }

    const headings = Array.from(main.querySelectorAll("h1, h2, h3")).filter((el) =>
      /exp[ée]rience/i.test(clean(el.textContent))
    );
    if (headings.length) {
      const section = headings[0].closest("section");
      if (section) return { mode: "HEADING", root: section };
    }

    const sections = Array.from(main.querySelectorAll("section"));
    if (sections.length) {
      const scored = sections
        .map((section) => ({
          section,
          score: clean(section.textContent || "").length,
        }))
        .sort((a, b) => b.score - a.score);
      return { mode: "LARGEST_SECTION", root: scored[0].section };
    }

    return { mode: "MAIN_ONLY", root: main };
  }

  function extractDatesFromMetaLines(lines) {
    return lines.find((line) => looksLikeDates(line)) || null;
  }

  function collectTopLevelExperienceLis(scope) {
    const lis = Array.from(scope.querySelectorAll("li"));
    return lis.filter((li) => {
      if (li.closest(".pvs-entity__sub-components")) return false;
      if (!li.querySelector("div.t-bold, span.t-bold")) return false;
      if (clean(li.innerText || "").length <= 25) return false;
      return true;
    });
  }

  function scrapeDetailsExperienceDocument(root = document) {
    const pick = pickDetailsExperienceSection(root);
    const scope = pick.root || root.body || root;
    const topLis = collectTopLevelExperienceLis(scope);
    runSkillsSelfTest(topLis, scope);
    const experiences = [];
    const seen = new Set();
    const counts = {
      topLis: topLis.length,
      grouped: 0,
      singles: 0,
      skipped: 0,
    };

    const pushExperience = (entry) => {
      if (!entry) return;
      const key = [entry.title, entry.company, entry.dates, entry.location, entry.workplaceType || ""]
        .map((v) => clean(v).toLowerCase())
        .join("|");
      if (seen.has(key)) return;
      seen.add(key);
      experiences.push(entry);
    };

    for (const li of topLis) {
      const subComponents = li.querySelector(".pvs-entity__sub-components");
      const roleLis = subComponents
        ? Array.from(subComponents.querySelectorAll("li")).filter((roleLi) => {
            if (!roleLi.querySelector("div.t-bold, span.t-bold")) return false;
            const datesSignal =
              extractDatesFromContainer(roleLi) ||
              extractDatesFromMetaLines(collectMetaLines(roleLi)) ||
              extractDatesFromMetaLines(collectMetaLines(roleLi.closest("li")));
            return !!datesSignal;
          })
        : [];

      if (roleLis.length >= 2) {
        counts.grouped += 1;
        const headerTitle = extractTitleFromContainer(li);
        const headerCompanyLine = extractCompanyLineFromContainer(li);
        const headerCompany =
          extractGroupCompanyName(li) ||
          splitCompanyLine(headerCompanyLine).company ||
          headerTitle ||
          null;
        if (!headerCompany) {
          expLog("DETAILS_GROUPED_COMPANY_MISSING", {
            headerTitle,
            headerCompanyLine,
          });
        }

        for (const roleLi of roleLis) {
          const title = extractTitleFromContainer(roleLi);
          const dates =
            extractDatesFromContainer(roleLi) ||
            extractDatesFromMetaLines(collectMetaLines(roleLi)) ||
            extractDatesFromMetaLines(collectMetaLines(roleLi.closest("li")));
          if (!title || !dates) {
            counts.skipped += 1;
            continue;
          }
          const companyLine = extractCompanyLineFromContainer(roleLi) || "";
          const { extras } = splitCompanyLine(companyLine);
          const company = headerCompany;
          if (!company) {
            counts.skipped += 1;
            continue;
          }

          const metaLines = uniq([...collectMetaLines(roleLi), ...extras]).filter(
            (line) => line && line !== title && line !== dates && line !== company
          );
          const { location, workplaceType } = extractLocationAndWorkplaceType(metaLines);

          const ctx = {
            title,
            company,
            companyLine,
            dates,
            location,
            workplaceType,
          };
          const description = extractDetailsDescription(roleLi, ctx);
          const skills = extractSkillsFromExperienceNode(roleLi);

          pushExperience({
            title,
            company,
            dates,
            location: location || "",
            workplaceType: workplaceType || null,
            description: description || null,
            skills,
          });
        }
        continue;
      }

      counts.singles += 1;
      const title = extractTitleFromContainer(li);
      const dates =
        extractDatesFromContainer(li) ||
        extractDatesFromMetaLines(collectMetaLines(li)) ||
        extractDatesFromMetaLines(collectMetaLines(li.closest("li")));
      const companyLine = extractCompanyLineFromContainer(li);
      const { company, extras } = splitCompanyLine(companyLine);

      if (!title || !company || !dates || looksLikeDates(company)) {
        counts.skipped += 1;
        continue;
      }

      const metaLines = uniq([...collectMetaLines(li), ...extras]).filter(
        (line) => line && line !== title && line !== company && line !== dates
      );
      const { location, workplaceType } = extractLocationAndWorkplaceType(metaLines);

      const ctx = {
        title,
        company,
        companyLine,
        dates,
        location,
        workplaceType,
      };
      const description = extractDetailsDescription(li, ctx);
      const skills = extractSkillsFromExperienceNode(li);

      pushExperience({
        title,
        company,
        dates,
        location: location || "",
        workplaceType: workplaceType || null,
        description: description || null,
        skills,
      });
    }

    const debug = { rootMode: pick.mode, counts };
    if (isDetailsExperiencePath(location.pathname)) {
      experiences.slice(0, 3).forEach((entry) => {
        expLog("DETAILS_SKILLS", {
          title: entry?.title || null,
          skillsCount: Array.isArray(entry?.skills) ? entry.skills.length : 0,
        });
      });
    }
    expLog("DETAILS_DEBUG", debug);
    return { experiences, debug };
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
    const profileCanonicalUrl = canonicalProfileUrl(href);
    const detailsUrl = getExperienceDetailsUrl();
    if (detailsUrl) {
      expDlog("Details URL detected", { detailsUrl, profileCanonicalUrl });
    } else {
      expWarn("Details URL missing for profile", { href, profileCanonicalUrl });
    }

    let detailsExperiences = [];
    let detailsDebug = null;
    if (detailsUrl) {
      try {
        if (isDetailsExperiencePath(location.pathname)) {
          const detailsResult = scrapeDetailsExperienceDocument(document);
          detailsExperiences = detailsResult.experiences || [];
          detailsDebug = detailsResult.debug || null;
        } else {
          const inflightKey = profileCanonicalUrl || detailsUrl;
          if (!detailsScrapeInFlight.has(inflightKey)) {
            detailsScrapeInFlight.set(
              inflightKey,
              requestExperienceDetailsScrape(detailsUrl, inflightKey)
            );
          }
          try {
            detailsExperiences = await detailsScrapeInFlight.get(inflightKey);
          } finally {
            detailsScrapeInFlight.delete(inflightKey);
          }
        }
        expLog("DETAILS_SCRAPED", {
          count: detailsExperiences.length,
          debug: detailsDebug,
          profileCanonicalUrl,
        });
      } catch (err) {
        expWarn("Details experience scrape failed", err?.message || err);
      }
    }

    const detailsNormalized = detailsExperiences
      .map((exp) => ({
        _idx: exp._idx ?? null,
        _ok: true,
        Titre: exp.title || "",
        Entreprise: exp.company || "",
        Dates: exp.dates || "",
        Lieu: exp.location || "",
        WorkplaceType: exp.workplaceType || null,
        Description: exp.description || null,
        DescriptionBullets: exp.descriptionBullets || null,
        Skills: Array.isArray(exp.skills) ? exp.skills : [],
        SkillsText: Array.isArray(exp.skills) && exp.skills.length ? exp.skills.join(" · ") : null,
      }))
      .filter((exp) => exp.Titre && exp.Entreprise);

    const finalExperiences = detailsNormalized.length ? detailsNormalized : ready.collected.experiences;
    expLog("Experience counts", {
      profileCount: ready.collected.experiences.length,
      detailsCount: detailsNormalized.length,
      finalCount: finalExperiences.length,
    });

    const result = {
      ok: true,
      mode: "OK",
      reason,
      startedAt,
      fullName,
      photoUrl,
      linkedinUrl,
      relationDegree,
      experiences: finalExperiences,
      education,
      skills,
      infos,
      debug: {
        experienceRootMode: ready.pick.mode,
        experienceCollectionMode: ready.collected.mode,
        experienceCounts: ready.collected.counts,
        experienceRootPath: elementPath(ready.pick.root),
        experienceDetailsUrl: detailsUrl || null,
        experienceDetailsCount: detailsNormalized.length,
        experienceDetailsDebug: detailsDebug,
      },
    };

    window.__FOCALS_LAST = result;

    log(`SCRAPE (${reason})`, {
      fullName: result.fullName,
      relationDegree: result.relationDegree,
      photoUrl: result.photoUrl,
      linkedinUrl: result.linkedinUrl,
      experiences: result.experiences.length,
    });
    if (reason === "AUTORUN") {
      log(`AUTORUN (${reason})`, {
        fullName: result.fullName,
        relationDegree: result.relationDegree,
        photoUrl: result.photoUrl,
        linkedinUrl: result.linkedinUrl,
        experiences: result.experiences.length,
        skills: result.experiences?.[0]?.Skills?.length ?? 0,
      });
    }

    if (!result.experiences.length) {
      expWarn("No experiences parsed. Debug:", result.debug);
    } else if (DEBUG) {
      console.table(
        result.experiences.map((e) => ({
          Titre: e.Titre,
          Entreprise: e.Entreprise,
          Dates: e.Dates,
          Lieu: e.Lieu,
          Skills: e.SkillsText || (e.Skills || []).join(" · "),
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
      workplaceType: exp.WorkplaceType || null,
      description: exp.Description || null,
      descriptionBullets: exp.DescriptionBullets || null,
      skills: exp.Skills || [],
      skillsText: exp.SkillsText || (exp.Skills || []).join(" · "),
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
    const profile = await getProfileForUi("message_request");
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

  async function handleScrapeRequest(reason) {
    const profileUrl = canonicalProfileUrl(location.href);
    if (!profileUrl) {
      return { ok: false, error: "BAD_CONTEXT" };
    }

    if (scrapeInFlight) {
      if (lastResult) {
        return {
          ok: true,
          profile: lastResult,
          debug: {
            cacheHit: false,
            cacheAgeSec: lastResultAt ? Math.floor((Date.now() - lastResultAt) / 1000) : null,
            cooldownActive: false,
            scrapedAt: lastResultAt || null,
          },
        };
      }
      return { ok: false, error: "IN_FLIGHT", status: "in_flight" };
    }

    const cachedEntry = await readProfileCache(profileUrl);
    const cacheAgeSec = cachedEntry?.scrapedAt
      ? Math.floor((Date.now() - cachedEntry.scrapedAt) / 1000)
      : null;
    if (
      cachedEntry?.result &&
      cachedEntry?.scrapedAt &&
      Date.now() - cachedEntry.scrapedAt < CACHE_TTL_MS
    ) {
      lastResult = cachedEntry.result;
      lastResultAt = cachedEntry.scrapedAt;
      await persistLastProfile(cachedEntry.result);
      return {
        ok: true,
        profile: cachedEntry.result,
        debug: {
          cacheHit: true,
          cacheAgeSec,
          cooldownActive: false,
          scrapedAt: cachedEntry.scrapedAt,
        },
      };
    }

    const lastScrapeAt = await readLastScrapeAt();
    const cooldownMs = COOLDOWN_BASE_MS + Math.floor(Math.random() * COOLDOWN_JITTER_MS);
    const cooldownActive = lastScrapeAt && Date.now() - lastScrapeAt < cooldownMs;
    if (cooldownActive) {
      if (lastResult) {
        return {
          ok: true,
          profile: lastResult,
          debug: {
            cacheHit: false,
            cacheAgeSec,
            cooldownActive: true,
            scrapedAt: lastResultAt || null,
          },
        };
      }
      return {
        ok: false,
        error: "COOLDOWN",
        status: "cooldown",
        debug: {
          cacheHit: false,
          cacheAgeSec,
          cooldownActive: true,
          scrapedAt: lastScrapeAt || null,
        },
      };
    }

    scrapeInFlight = true;
    let raw = null;
    try {
      raw = await runOnce(reason);
      const normalized = normalizeForUi(raw);
      if (!normalized) {
        return { ok: false, error: raw?.mode === "BAD_CONTEXT" ? "BAD_CONTEXT" : "SCRAPE_FAILED" };
      }
      const scrapedAt = Date.now();
      lastResult = normalized;
      lastResultAt = scrapedAt;
      await Promise.all([
        persistLastProfile(normalized),
        writeProfileCache(profileUrl, { scrapedAt, result: normalized }),
        writeLastScrapeAt(scrapedAt),
      ]);
      return {
        ok: true,
        profile: normalized,
        debug: {
          cacheHit: false,
          cacheAgeSec,
          cooldownActive: false,
          scrapedAt,
        },
      };
    } finally {
      scrapeInFlight = false;
    }
  }

  async function getProfileForUi(reason) {
    const response = await handleScrapeRequest(reason);
    return response?.ok ? response.profile : null;
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
    if (DEBUG) {
      console.table(rows);
    }
    return rows;
  }

  function debugScrapeExperiences() {
    const experiences = window.__FOCALS_LAST?.experiences || [];
    log("Experiences JSON:", experiences);
    return experiences;
  }

  window.FOCALS = {
    run: () => handleScrapeRequest("manual_call"),
    dump,
    logExperienceDescriptions,
    debugScrapeExperiences,
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

      if (request?.type === "FOCALS_SCRAPE_NOW") {
        handleScrapeRequest("popup_request")
          .then((payload) => sendResponse(payload))
          .catch((error) =>
            sendResponse({ ok: false, error: error?.message || "SCRAPE_FAILED" })
          );
        return true;
      }

      if (request?.action === "SCRAPE_PROFILE") {
        handleScrapeRequest("message_request")
          .then((payload) =>
            sendResponse(
              payload?.ok
                ? { status: "success", data: payload.profile, debug: payload.debug }
                : { status: "error", error: payload?.error || "SCRAPE_FAILED", debug: payload?.debug }
            )
          )
          .catch((error) =>
            sendResponse({ status: "error", error: error?.message || "SCRAPE_FAILED" })
          );
        return true;
      }
      if (request?.action === "PING") {
        sendResponse({ status: "pong" });
      }
      return undefined;
    });
  }

  log(
    "Ready. Manual scrape only. Also available:",
    "FOCALS.dump()",
    "FOCALS.run()",
    "FOCALS.logExperienceDescriptions()",
    "FOCALS.debugScrapeExperiences()"
  );
})();
