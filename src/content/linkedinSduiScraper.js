(() => {
  const TAG = "🧪 FOCALS CONSOLE";
  const DEBUG = false;

  const log = (...a) => console.log(TAG, ...a);
  const dlog = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const clean = (s) => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const collapseDouble = (s) => {
    const t = clean(s);
    if (!t) return "";
    if (t.length % 2 === 0) {
      const h = t.length / 2;
      const a = t.slice(0, h),
        b = t.slice(h);
      if (a === b) return a;
    }
    const m = t.match(/^(.+?)\1$/);
    if (m && m[1]) return clean(m[1]);
    return t;
  };
  const monthToken =
    /(janv\.?|févr\.?|f[ée]v\.?|mars|avr\.?|mai|juin|juil\.?|ao[uû]t|sept\.?|oct\.?|nov\.?|d[ée]c\.?|january|february|march|april|may|june|july|august|september|october|november|december)/i;
  const looksLikeDates = (t) => {
    const s = clean(t);
    if (!s) return false;
    if (!monthToken.test(s)) return false;
    return /-/.test(s) && (/\b(19\d{2}|20\d{2})\b/.test(s) || /aujourd|present/i.test(s));
  };
  const looksLikeLocation = (t) => {
    const s = clean(t);
    if (!s) return false;
    if (looksLikeDates(s)) return false;
    if (s.includes("·")) return false;
    return /(,| Area\b|Région|Île-de-France|France)\b/i.test(s) && s.length <= 140;
  };
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
  const pickLocation = (scope) =>
    (getLines(scope).find(looksLikeLocation) ? collapseDouble(getLines(scope).find(looksLikeLocation)) : "");

  function parseGroupedV6(groupLi) {
    const headerCompany = pickHeaderCompany(groupLi);
    const roleLis = Array.from(groupLi.querySelectorAll(".pvs-entity__sub-components li")).filter(
      (li) => !!li.querySelector("div.t-bold, span.t-bold")
    );

    if (!roleLis.length) {
      const title = pickTitle(groupLi) || "";
      const dates = pickDates(groupLi, title) || "";
      let company = headerCompany || pickCompanyFromDotLine(groupLi, title) || "";
      if (!company || (title && company.toLowerCase() === title.toLowerCase())) {
        company = pickCompanyFallback(groupLi, title) || company;
      }
      const location = pickLocation(groupLi) || "";
      if (!title || !dates) return [];
      return [
        {
          title,
          company: collapseDouble(company),
          dates,
          location: collapseDouble(location),
          _scope: groupLi,
        },
      ];
    }

    const out = [];
    for (const roleLi of roleLis) {
      const title = pickTitle(roleLi);
      const dates = pickDates(roleLi, title) || pickDates(groupLi, title);
      if (!title || !dates) continue;

      let company = headerCompany || "";
      if (!company || company.toLowerCase() === title.toLowerCase()) {
        company = pickCompanyFromDotLine(groupLi, title) || pickCompanyFromDotLine(roleLi, title) || "";
      }
      if (!company || company.toLowerCase() === title.toLowerCase()) {
        company = pickCompanyFallback(groupLi, title) || company;
      }
      const location = pickLocation(groupLi) || pickLocation(roleLi) || "";
      out.push({
        title,
        company: collapseDouble(company),
        dates,
        location: collapseDouble(location),
        _scope: roleLi,
      });
    }

    const seen = new Set();
    return out.filter((e) => {
      const k = [e.title, e.company, e.dates, e.location].map((x) => clean(x).toLowerCase()).join("||");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const buildExpKey = (exp) =>
    [exp?.title, exp?.company, exp?.dates, exp?.location].map((x) => clean(x)).join("||").toLowerCase();

  const stripExperienceMetaFromDescription = (description, exp) => {
    if (!description) return null;
    const lines = description
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;
    const metaTokens = [exp?.title, exp?.company, exp?.dates, exp?.location]
      .map((x) => clean(x).toLowerCase())
      .filter(Boolean);
    const companyToken = clean(exp?.company).toLowerCase();
    const employmentLineRe =
      /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i;
    const metaSet = new Set(metaTokens);
    const filtered = lines.filter((line) => {
      const key = clean(line).toLowerCase();
      if (!key) return false;
      if (metaSet.has(key)) return false;
      if (companyToken && key.includes(companyToken) && (key.includes("·") || employmentLineRe.test(key))) {
        return false;
      }
      if (looksLikeDates(line)) return false;
      if (looksLikeLocation(line)) return false;
      if (looksLikePlainLocationFallback(line)) return false;
      return true;
    });
    if (!filtered.length) return null;
    const finalText = filtered.join("\n").trim();
    if (!finalText || finalText.length < 30) return null;
    return finalText;
  };

  const enrichDescriptionsFromScopes = (v6Parsed) => {
    if (!Array.isArray(v6Parsed)) return [];
    const descByKey = new Map();
    return v6Parsed.map((item) => {
      const key = buildExpKey(item);
      let entry = descByKey.get(key);
      if (!entry) {
        let description = null;
        let descriptionBullets = null;
        try {
          if (item?._scope) {
            clickSeeMoreInItem(item._scope);
            const extracted = extractExperienceDescription(item._scope);
            description = extracted?.description || null;
            description = stripExperienceMetaFromDescription(description, item);
            descriptionBullets = description ? extractDescriptionBullets(description) : null;
          }
        } catch (err) {
          description = null;
          descriptionBullets = null;
        }
        entry = { description, descriptionBullets };
        descByKey.set(key, entry);
      }
      return {
        ...item,
        Description: entry?.description || null,
        DescriptionBullets: entry?.descriptionBullets || null,
      };
    });
  };

  function findExperienceSectionRoot(main) {
    if (!main) return null;
    const heading = Array.from(main.querySelectorAll("h1, h2, h3")).find((el) =>
      /exp[ée]rience/i.test(clean(el.textContent))
    );
    if (!heading) return null;
    return heading.closest("section");
  }
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
    return collapseDouble(joined);
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
      const title = collapseDouble(clean(exp?.Titre));
      const company = collapseDouble(clean(exp?.Entreprise));
      const dates = collapseDouble(clean(exp?.Dates));
      const location = collapseDouble(clean(exp?.Lieu));
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
    const withBreaks = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ");
    const container = document.createElement("div");
    container.innerHTML = withBreaks;
    return container.textContent || container.innerText || "";
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
    const main = document.querySelector("main") || document.body;
    const section = findExperienceSectionRoot(main);
    if (section) return { mode: "HEADING_SECTION", root: section };
    return { mode: "MAIN_FALLBACK", root: main };
  }

  function getExperienceTopLis(expSection) {
    if (!expSection) return [];
    return Array.from(expSection.querySelectorAll("li")).filter((li) => {
      if (li.closest(".pvs-entity__sub-components")) return false;
      if (!li.querySelector("div.t-bold, span.t-bold")) return false;
      if (clean(li.textContent).length <= 25) return false;
      return true;
    });
  }

  function parseExperiencesWithV6(root) {
    if (!root) return [];
    const topLis = Array.from(root.querySelectorAll("li")).filter((li) => {
      if (li.closest(".pvs-entity__sub-components")) return false;
      if (!li.querySelector("div.t-bold, span.t-bold")) return false;
      if (clean(li.textContent).length <= 25) return false;
      return true;
    });

    const parsed = topLis.flatMap((li) => parseGroupedV6(li));
    const enriched = enrichDescriptionsFromScopes(parsed);
    const experiences = enriched.map((x) => ({
      Titre: x.title,
      Entreprise: x.company,
      Dates: x.dates,
      Lieu: x.location || null,
      Description: x.Description || null,
      DescriptionBullets: x.DescriptionBullets || null,
    }));
    return experiences;
  }

  function parseExperienceFromRoot(root) {
    if (!root) return [];
    const expRoot = findExperienceSectionRoot(root) || root;
    return parseExperiencesWithV6(expRoot);
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

  const EMPLOYMENT_RE =
    /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i;
  const DURATION_RE = /\b\d+\s*(an|ans|mois|yr|yrs|year|years|mos|months)\b/i;

  function looksLikeEmploymentType(s) {
    const t = clean(s);
    if (!t) return false;
    return EMPLOYMENT_RE.test(t);
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

  function splitCompanyLineSafe(line) {
    if (!line) return { company: null, extras: [] };
    const parts = dedupeInlineRepeats(line)
      .split("·")
      .map(clean)
      .filter(Boolean)
      .map(collapseDouble);
    if (!parts.length) return { company: null, extras: [] };
    const first = parts[0];
    // WHY: éviter de prendre "CDI · 1 an" ou "4 ans 7 mois" comme entreprise.
    if (EMPLOYMENT_RE.test(first) || DURATION_RE.test(first)) {
      return { company: null, extras: parts };
    }
    return { company: first || null, extras: parts.slice(1) };
  }

  function isBadCompanyCandidate(company, title) {
    const t = clean(company);
    if (!t) return true;
    if (looksLikeEmploymentType(t)) return true;
    if (looksLikeDates(t)) return true;
    if (DURATION_RE.test(t)) return true;
    if (title && t.toLowerCase() === clean(title).toLowerCase()) return true;
    return false;
  }

  function extractHeaderBoldCompany(groupItem) {
    if (!groupItem) return null;
    const nodes = Array.from(groupItem.querySelectorAll("div.t-bold, span.t-bold")).filter(
      (node) => !node.closest(".pvs-entity__sub-components")
    );
    for (const node of nodes) {
      const text = collapseDouble(
        dedupeInlineRepeats(node.querySelector("span[aria-hidden='true']")?.textContent || node.textContent)
      );
      if (text) return text;
    }
    return null;
  }

  function extractCompanyLinkText(scope) {
    if (!scope) return null;
    const link =
      scope.querySelector('a[href*="/company/"] span[aria-hidden="true"]') ||
      scope.querySelector('a[href*="/company/"] span') ||
      scope.querySelector('a[href*="/company/"]') ||
      null;
    return link ? collapseDouble(dedupeInlineRepeats(link.textContent)) : null;
  }

  function extractTitleFromContainer(container) {
    if (!container) return null;
    return (
      collapseDouble(dedupeInlineRepeats(container.querySelector("div.t-bold span[aria-hidden='true']")?.textContent)) ||
      collapseDouble(dedupeInlineRepeats(container.querySelector("div.t-bold span")?.textContent)) ||
      collapseDouble(
        dedupeInlineRepeats(
          container.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent
        )
      ) ||
      collapseDouble(dedupeInlineRepeats(container.querySelector(".hoverable-link-text.t-bold")?.textContent)) ||
      null
    );
  }

  function extractCompanyLineFromContainer(container) {
    if (!container) return null;
    return (
      collapseDouble(
        dedupeInlineRepeats(container.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent)
      ) ||
      collapseDouble(dedupeInlineRepeats(container.querySelector("span.t-14.t-normal")?.textContent)) ||
      null
    );
  }

  function extractDatesFromContainer(container) {
    if (!container) return null;
    const caption =
      collapseDouble(
        clean(container.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent)
      ) ||
      collapseDouble(clean(container.querySelector("span.pvs-entity__caption-wrapper")?.textContent)) ||
      null;
    if (caption) return caption;
    const fallback = Array.from(
      container.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => collapseDouble(clean(n.textContent)))
      .find((t) => looksLikeDates(t));
    return fallback || null;
  }

  function collectMetaLines(container) {
    if (!container) return [];
    let spans = Array.from(
      container.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
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

    if (!spans.length) {
      spans = Array.from(container.querySelectorAll("span.t-14.t-normal.t-black--light"))
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

    return uniq(spans);
  }

  function extractLocationAndWorkplaceType(lines) {
    let location = null;
    let workplaceType = null;

    for (const line of lines) {
      const parts = line.split("·").map((part) => collapseDouble(clean(part))).filter(Boolean);
      const candidates = parts.length ? parts : [collapseDouble(clean(line))];

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
          location = collapseDouble(part);
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
      const score = directLis.filter((li) =>
        li.querySelector('div[data-view-name="profile-component-entity"]')
      ).length;
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
    const { company: companyFromLine, extras } = splitCompanyLineSafe(companyLine);
    const metaLines = uniq([...collectMetaLines(entity), ...extras]);

    const { location, workplaceType } = extractLocationAndWorkplaceType(
      metaLines.filter((t) => t && t !== dates && t !== title && t !== companyFromLine)
    );

    let company = companyOverride || companyFromLine || null;
    if (isBadCompanyCandidate(company, title)) {
      const scope = scopeItem || entity;
      const fallback = pickCompanyFromDotLine(scope, title) || pickCompanyFallback(scope, title);
      if (fallback) company = fallback;
    }

    const { description, descriptionBullets } = extractExperienceDescription(
      scopeItem || entity.closest("li") || entity
    );
    const skillScope = scopeItem || entity.closest("li") || entity;
    const { skills, skillsMoreCount } = extractSkillsFromExperienceItem(skillScope);
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
      WorkplaceType: workplaceType,
      Description: description,
      DescriptionBullets: descriptionBullets,
      Skills: skills,
      SkillsMoreCount: skillsMoreCount,
    };
  }

  function parseLegacyExperienceLiExpanded(li, index) {
    const entity = li.querySelector('div[data-view-name="profile-component-entity"]');
    if (!entity) return [];

    const innerRoleEntities = Array.from(
      li.querySelectorAll('.pvs-entity__sub-components div[data-view-name="profile-component-entity"]')
    ).filter((e) => e.querySelector(".pvs-entity__caption-wrapper") && e.querySelector("div.t-bold, span.t-bold"));

    if (innerRoleEntities.length >= 2) {
      const headerTitle = extractTitleFromContainer(entity);
      let headerCompany =
        // WHY: sur grouped items, la company est le header bold (pas la ligne "CDI · 1 an").
        extractHeaderBoldCompany(li) ||
        extractCompanyLinkText(li) ||
        pickCompanyFromDotLine(li, headerTitle) ||
        pickCompanyFallback(li, headerTitle) ||
        null;
      if (isBadCompanyCandidate(headerCompany, headerTitle)) headerCompany = null;
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
          (li) =>
            li.querySelector("div.t-bold, span.t-bold") && li.querySelector(".pvs-entity__caption-wrapper")
        )
      : [];

    if (groupedRoles.length >= 2) {
      const headerTitle = extractTitleFromContainer(item);
      let headerCompany =
        // WHY: grouped items prennent la company depuis le header bold (pas la companyLine).
        extractHeaderBoldCompany(item) ||
        extractCompanyLinkText(item) ||
        pickCompanyFromDotLine(item, headerTitle) ||
        pickCompanyFallback(item, headerTitle) ||
        null;
      if (isBadCompanyCandidate(headerCompany, headerTitle)) headerCompany = null;

      return groupedRoles
        .map((roleItem, roleIndex) => {
          const title = extractTitleFromContainer(roleItem);
          const dates = extractDatesFromContainer(roleItem);
          const { company: companyFromLine, extras } = splitCompanyLineSafe(
            extractCompanyLineFromContainer(roleItem)
          );
          const metaLines = uniq([...collectMetaLines(roleItem), ...extras]);
          const { location, workplaceType } = extractLocationAndWorkplaceType(
            metaLines.filter((t) => t && t !== dates && t !== title && t !== companyFromLine)
          );

          const { description, descriptionBullets } = extractExperienceDescription(roleItem);
          const { skills, skillsMoreCount } = extractSkillsFromExperienceItem(roleItem);
          if (skills.length || skillsMoreCount) {
            expDlog("SKILLS_DEBUG", { title, company: headerCompany || companyFromLine, skills, skillsMoreCount });
          }

          let company = headerCompany || null;
          if (isBadCompanyCandidate(company, title)) {
            const fallback = pickCompanyFromDotLine(roleItem, title) || pickCompanyFallback(roleItem, title);
            if (fallback) company = fallback;
          }
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
            Skills: skills,
            SkillsMoreCount: skillsMoreCount,
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
    const { company: companyFromLine, extras } = splitCompanyLineSafe(companyLine);
    let company = companyFromLine;
    if (isBadCompanyCandidate(company, title)) {
      company =
        pickCompanyFromDotLine(item, title) ||
        pickCompanyFallback(item, title) ||
        pickCompanyFromDotLine(link || item, title) ||
        pickCompanyFallback(link || item, title) ||
        company;
    }

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
      .filter((t) => !/compétences de plus|competences de plus|skills|programming language/i.test(t));

    ps = uniq(ps);

    const metaCandidates = uniq([...collectMetaLines(item), ...extras, ...ps]).filter(
      (t) => t && t !== title && t !== company && t !== dates && !looksLikeEmploymentType(t)
    );

    const { location, workplaceType } = extractLocationAndWorkplaceType(metaCandidates);

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
      WorkplaceType: workplaceType,
      Description: description,
      DescriptionBullets: descriptionBullets,
      Skills: skills,
      SkillsMoreCount: skillsMoreCount,
    };
  }

  function collectExperiences(expSection) {
    if (!expSection) return { mode: "NO_ROOT", experiences: [], counts: {} };

    const topLis = getExperienceTopLis(expSection);
    const counts = {
      topLis: topLis.length,
    };
    const parsed = parseExperiencesWithV6(expSection);
    const ok = dedupeExperiences(parsed);
    return { mode: "V6", experiences: ok, counts };
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

  function scheduleRun(reason) {
    if (window.__FOCALS_TIMER) clearTimeout(window.__FOCALS_TIMER);
    window.__FOCALS_TIMER = setTimeout(() => runOnce(reason), 350);
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

  function debugScrapeExperiences() {
    const experiences = window.__FOCALS_LAST?.experiences || [];
    log("Experiences JSON:", experiences);
    return experiences;
  }

  function toExtensionProfile(res) {
    if (!res || !res.ok) return null;

    const experiences = (res.experiences || []).map((e) => ({
      title: e.Titre || null,
      company: e.Entreprise || null,
      dates: e.Dates || null,
      location: e.Lieu || null,
      workplaceType: e.WorkplaceType || null,
      description: e.Description || null,
      descriptionBullets: e.DescriptionBullets || null,
      skills: e.Skills || [],
      skillsMoreCount: e.SkillsMoreCount ?? null,
      skillsText: (e.Skills || []).join(" · "),
      start: null,
      end: null,
    }));

    const education = (res.education || []).map((ed) => ({
      school: ed.school || null,
      degree: ed.degree || null,
      dates: ed.dates || null,
    }));

    const skills = uniq(res.skills || []);

    const current_title = experiences[0]?.title || null;
    const current_company = experiences[0]?.company || null;

    return {
      fullName: res.fullName || null,
      relationDegree: res.relationDegree || null,
      photoUrl: res.photoUrl || null,
      linkedinUrl: res.linkedinUrl || canonicalProfileUrl(location.href),
      experiences,
      education,
      skills,
      infos: res.infos || null,
      name: res.fullName || null,
      headline: null,
      location: null,
      photo_url: res.photoUrl || null,
      linkedin_url: res.linkedinUrl || canonicalProfileUrl(location.href),
      current_title,
      current_company,
      about: res.infos || null,
    };
  }

  const scrapeFromDom = async () => {
    const res = await runOnce("extension_call");
    return toExtensionProfile(res);
  };

  window.__FocalsLinkedinSduiScraper = {
    scrapeFromDom,
  };

  window.FOCALS = {
    run: () => scheduleRun("manual_call"),
    dump,
    logExperienceDescriptions,
    debugScrapeExperiences,
  };

  log(
    "Ready. Autorun enabled. Also available:",
    "FOCALS.dump()",
    "FOCALS.run()",
    "FOCALS.logExperienceDescriptions()",
    "FOCALS.debugScrapeExperiences()"
  );
  installSpaWatcher();
  scheduleRun("init");
})();
