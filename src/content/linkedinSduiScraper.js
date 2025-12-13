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

  function looksLikeLocation(s) {
    const t = clean(s);
    if (!t) return false;
    return /(sur site|hybride|à distance|remote|on[- ]site|région|region|france|,)/i.test(t);
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
      clean(mainLink.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent) ||
      clean(mainLink.querySelector(".hoverable-link-text.t-bold")?.textContent) ||
      null;

    const company =
      clean(mainLink.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent) ||
      clean(mainLink.querySelector("span.t-14.t-normal")?.textContent) ||
      null;

    const dates =
      clean(mainLink.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent) ||
      clean(mainLink.querySelector("span.pvs-entity__caption-wrapper")?.textContent) ||
      null;

    let lightSpans = Array.from(
      mainLink.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => clean(n.textContent))
      .filter(Boolean);

    if (!lightSpans.length) {
      lightSpans = Array.from(mainLink.querySelectorAll("span.t-14.t-normal.t-black--light"))
        .map((n) => clean(n.textContent))
        .filter(Boolean);
    }

    lightSpans = uniq(lightSpans);

    const location =
      lightSpans.find((t) => looksLikeLocation(t) && t !== dates) ||
      lightSpans.find((t) => t !== dates) ||
      null;

    const ok = !!(title && company && dates);
    return { _idx: index, _ok: ok, Titre: title, Entreprise: company, Dates: dates, Lieu: location };
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
      .filter((t) => !/compétences de plus|skills|programming language/i.test(t));

    ps = uniq(ps);

    const title = ps[0] || null;

    let company = null;
    if (ps[1]) company = clean(ps[1].split("·")[0]);

    const dates = ps.find((t) => looksLikeDates(t)) || null;

    const location = ps.find((t) => looksLikeLocation(t) && t !== dates) || null;

    const ok = !!(title && company && dates);
    return { _idx: index, _ok: ok, Titre: title, Entreprise: company, Dates: dates, Lieu: location };
  }

  function collectExperiences(expSection) {
    if (!expSection) return { mode: "NO_ROOT", experiences: [], counts: {} };

    // FIX: LinkedIn SDUI utilise "entity-collection-item-xxxx" (pas "entity-collection-item--")
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
      const parsed = legacyLis.map((li, i) => parseLegacyExperienceLi(li, i));
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

  function toExtensionProfile(res) {
    if (!res || !res.ok) return null;

    const experiences = (res.experiences || []).map((e) => ({
      title: e.Titre || null,
      company: e.Entreprise || null,
      dates: e.Dates || null,
      location: e.Lieu || null,
      start: null,
      end: null,
    }));

    const current_title = experiences[0]?.title || null;
    const current_company = experiences[0]?.company || null;

    return {
      fullName: res.fullName || null,
      relationDegree: res.relationDegree || null,
      photoUrl: res.photoUrl || null,
      linkedinUrl: res.linkedinUrl || canonicalProfileUrl(location.href),
      experiences,
      name: res.fullName || null,
      headline: null,
      location: null,
      photo_url: res.photoUrl || null,
      linkedin_url: res.linkedinUrl || canonicalProfileUrl(location.href),
      current_title,
      current_company,
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
  };

  log("Ready. Autorun enabled. Also available:", "FOCALS.dump()", "FOCALS.run()");
  installSpaWatcher();
  scheduleRun("init");
})();
