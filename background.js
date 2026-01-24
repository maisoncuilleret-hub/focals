import supabase from "./supabase-client.js";
import { API_BASE_URL, IS_DEV } from "./src/api/config.js";
import { createLogger } from "./src/utils/logger.js";

const logger = createLogger("Background");
const FOCALS_DEBUG = IS_DEV;
const DEBUG_KEEP_DETAILS_TAB = false;
const EXP_TAG = "[FOCALS][EXPERIENCE]";
const expLog = (...a) => console.log(EXP_TAG, ...a);
const detailsScrapeInFlight = new Map();

function debugLog(stage, details) {
  if (!FOCALS_DEBUG) return;
  logger.debug(stage, details);
}

const buildApiUrl = (endpoint = "") => {
  if (!endpoint) return API_BASE_URL;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const normalizedBase = API_BASE_URL.replace(/\/?$/, "");
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedEndpoint}`;
};

async function resolveAuthHeaders(headers = {}) {
  try {
    const { data } = await supabase.auth.getSession();
    const sessionToken = data?.session?.access_token || null;

    return {
      Authorization: headers.Authorization || (sessionToken ? `Bearer ${sessionToken}` : ""),
      ...headers,
    };
  } catch (err) {
    logger.warn("AUTH fallback", err?.message || err);
    return {
      Authorization: headers.Authorization || "",
      ...headers,
    };
  }
}

async function fetchApi({ endpoint, method = "GET", params, body, headers = {} }) {
  const url = new URL(buildApiUrl(endpoint));

  if (method === "GET" && params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const resolvedHeaders = await resolveAuthHeaders(headers);

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...resolvedHeaders,
    },
    body: method && method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    const errorMessage =
      typeof payload === "string" && payload ? payload : `HTTP ${response.status}`;
    return { ok: false, status: response.status, error: errorMessage, data: payload };
  }

  return { ok: true, status: response.status, data: payload };
}

const STORAGE_KEYS = {
  tone: "focals_userTone",
  templates: "focals_templates",
  jobs: "focals_jobs",
  selectedTemplate: "focals_selectedTemplate",
  selectedJob: "focals_selectedJob",
  apiKey: "focals_openai_apiKey",
};

const DEFAULT_TONE = "professional";

const toBackendMessage = (msg = {}) => ({
  text: msg.text || "",
  fromMe: msg.fromMe ?? msg.senderType === "me",
  timestampRaw: msg.timestampRaw || msg.timestamp || msg.createdAt || undefined,
});

const getLastMessagesForBackend = (messages, limit = 3) => {
  if (!Array.isArray(messages)) return [];

  const sorted = [...messages]
    .map(toBackendMessage)
    .filter((m) => m.text)
    .sort((a, b) => {
      if (a.timestampRaw && b.timestampRaw) {
        return new Date(a.timestampRaw) - new Date(b.timestampRaw);
      }
      return 0;
    });

  return sorted.slice(-limit);
};

function withStorage(area = "sync") {
  return {
    async get(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage[area].get(keys, (result) => resolve(result || {}));
        } catch (err) {
          debugLog("STORAGE_ERROR", err?.message || String(err));
          resolve({});
        }
      });
    },
    async set(values) {
      return new Promise((resolve) => {
        try {
          chrome.storage[area].set(values, () => resolve(true));
        } catch (err) {
          debugLog("STORAGE_ERROR", err?.message || String(err));
          resolve(false);
        }
      });
    },
    async remove(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage[area].remove(keys, () => resolve(true));
        } catch (err) {
          debugLog("STORAGE_ERROR", err?.message || String(err));
          resolve(false);
        }
      });
    },
  };
}

async function saveProfileToSupabase(profile) {
  if (!profile || !profile.linkedin_url) {
    throw new Error("Profil invalide reçu pour l'envoi à Supabase.");
  }

  const { data: userResult, error: userError } = await supabase.auth.getUser();
  if (userError || !userResult?.user) {
    throw new Error("Utilisateur non authentifié - connecte-toi sur l'app web.");
  }

  const { data: clientId, error: clientError } = await supabase.rpc("get_user_client_id");
  if (clientError || !clientId) {
    throw new Error("Impossible de récupérer le client_id Supabase.");
  }

  const payload = {
    name: profile.name || "",
    linkedin_url: profile.linkedin_url,
    current_title: profile.current_title || "",
    current_company: profile.current_company || "",
    photo_url: profile.photo_url || "",
    client_id: clientId,
  };

  const { error } = await supabase.from("profiles").insert(payload);
  if (error) {
    throw new Error(error.message || "Erreur inconnue lors de l'insertion Supabase.");
  }

  return { success: true };
}

async function askGPT(prompt, { system, temperature = 0.2, maxTokens = 500 } = {}) {
  const syncStore = withStorage("sync");
  const stored = await syncStore.get(STORAGE_KEYS.apiKey);
  const apiKey = stored?.[STORAGE_KEYS.apiKey];
  if (!apiKey) {
    debugLog("GPT", "No API key configured");
    return { error: "Missing API key" };
  }

  const body = {
    model: "gpt-4o-mini",
    temperature,
    max_tokens: maxTokens,
    messages: [],
  };
  if (system) {
    body.messages.push({ role: "system", content: system });
  }
  body.messages.push({ role: "user", content: prompt });

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      debugLog("GPT_ERROR", text);
      return { error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    debugLog("GPT_RESULT", content.slice(0, 200));
    return { content };
  } catch (err) {
    debugLog("GPT_ERROR", err?.message || String(err));
    return { error: err?.message || "Request failed" };
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout"));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "FOCALS_PING" });
    console.log("[Focals] Content script déjà présent");
    return;
  } catch (err) {
    console.log("[Focals] Injection du content script...");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-main.js"],
  });
  await wait(500);
}

async function detailsExperienceScraper() {
  const EXP_TAG = "[FOCALS][EXPERIENCE]";
  const expLog = (...a) => console.log(EXP_TAG, ...a);
  const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalizeInfosText = (s) =>
    (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const fixSpacedUrls = (t) => t.replace(/\bhttps?:\/\/[^\s)]+/gi, (url) => url.replace(/\s+/g, ""));

  const extractTextWithBreaks = (node) => {
    if (!node) return "";
    const html = node.innerHTML || "";
    const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
    return withBreaks.replace(/<[^>]*>/g, "");
  };

  const WORKPLACE_TYPE_RULES = [
    { regex: /\bsur site\b/i, value: "Sur site" },
    { regex: /\bhybride\b/i, value: "Hybride" },
    { regex: /\bt[ée]l[ée]travail\b/i, value: "Télétravail" },
    { regex: /\bà distance\b/i, value: "À distance" },
    { regex: /\bon[- ]site\b/i, value: "On-site" },
    { regex: /\bhybrid\b/i, value: "Hybrid" },
    { regex: /\bremote\b/i, value: "Remote" },
  ];

  const monthTokenRegex =
    /(janv\.?|févr\.?|f[ée]v\.?|mars|avr\.?|mai|juin|juil\.?|ao[uû]t|sept\.?|oct\.?|nov\.?|d[ée]c\.?|jan|feb|mar|apr|may|jun|jul|aug|sep|septembre|october|november|dec|january|february|march|april|june|july|august|september|october|november|december)/i;

  const normalizeWorkplaceType = (text) => {
    const t = clean(text);
    if (!t) return null;
    const rule = WORKPLACE_TYPE_RULES.find((entry) => entry.regex.test(t));
    return rule ? rule.value : null;
  };

  const looksLikeDates = (text) => {
    const t = clean(text);
    if (!t) return false;
    return /-/.test(t) && (/\b(19\d{2}|20\d{2})\b/.test(t) || /aujourd/i.test(t));
  };

  const looksLikeEmploymentType = (text) =>
    /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i.test(
      text || ""
    );

  const looksLikeDateRange = (text) => {
    const t = clean(text).toLowerCase();
    if (!t) return false;
    if (/\b(19\d{2}|20\d{2})\b/.test(t) && (t.includes(" - ") || t.includes("–") || t.includes("—"))) {
      return true;
    }
    if (/\baujourd/i.test(t)) return true;
    return monthTokenRegex.test(t);
  };

  const isMostlyDatesText = (text) => {
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
  };

  const splitCompanyLine = (line) => {
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

  const collectMetaLines = (container) => {
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
    return spans;
  };

  const extractTitleFromContainer = (container) =>
    clean(container?.querySelector("div.t-bold span[aria-hidden='true']")?.textContent) ||
    clean(container?.querySelector("div.t-bold span")?.textContent) ||
    clean(container?.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent) ||
    clean(container?.querySelector(".hoverable-link-text.t-bold")?.textContent) ||
    null;

  const extractCompanyLineFromContainer = (container) =>
    clean(container?.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent) ||
    clean(container?.querySelector("span.t-14.t-normal")?.textContent) ||
    null;

  const extractDatesFromContainer = (container) =>
    clean(container?.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent) ||
    clean(container?.querySelector("span.pvs-entity__caption-wrapper")?.textContent) ||
    null;

  const extractDatesFromMetaLines = (lines) => lines.find((line) => looksLikeDates(line)) || null;

  const extractLocationAndWorkplaceType = (lines) => {
    let location = null;
    let workplaceType = null;

    for (const line of lines) {
      const parts = line.split("·").map(clean).filter(Boolean);
      for (const part of parts.length ? parts : [clean(line)]) {
        if (!part) continue;
        if (!workplaceType) {
          const detected = normalizeWorkplaceType(part);
          if (detected) {
            workplaceType = detected;
            continue;
          }
        }
        if (!location && !looksLikeDates(part) && !looksLikeEmploymentType(part)) {
          location = part;
        }
      }
    }

    return { location, workplaceType };
  };

  const SEE_MORE_REGEX = /(voir plus|see more|show more|afficher la suite)/i;

  const clickSeeMore = (scope) => {
    if (!scope || scope.dataset?.focalsSeeMoreClicked) return;
    const button = Array.from(scope.querySelectorAll("button, a")).find((el) => {
      const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim();
      if (!label) return false;
      if (!SEE_MORE_REGEX.test(label)) return false;
      const expanded = el.getAttribute("aria-expanded");
      return expanded !== "true";
    });
    if (button) {
      button.click();
      scope.dataset.focalsSeeMoreClicked = "true";
    }
  };

  const isTrivialMetaDescription = (desc, ctx) => {
    if (!desc) return true;
    const normalized = clean(desc).toLowerCase();
    if (!normalized) return true;
    const title = clean(ctx?.title || "").toLowerCase();
    const companyLine = clean(ctx?.companyLine || "").toLowerCase();
    const company = clean(ctx?.company || "").toLowerCase();
    const dates = clean(ctx?.dates || "").toLowerCase();
    const location = clean(ctx?.location || "").toLowerCase();
    const workplaceType = clean(ctx?.workplaceType || "").toLowerCase();
    const combo = [location, workplaceType].filter(Boolean).join(" · ");

    if (title && (normalized === title || normalized === `${title} ${title}`.trim())) return true;
    if (company && normalized === company) return true;
    if (companyLine && normalized === companyLine) return true;
    if (dates && normalized === dates) return true;
    if (location && normalized === location) return true;
    if (workplaceType && normalized === workplaceType) return true;
    if (combo && normalized === combo) return true;
    if (isMostlyDatesText(desc)) return true;
    return false;
  };

  const normalizeDetailsDescription = (text, ctx) => {
    let normalized = normalizeInfosText(text || "");
    normalized = normalized.replace(/…\s*(voir plus|see more|show more|afficher la suite)\s*$/i, "").trim();
    normalized = fixSpacedUrls(normalized);
    if (!normalized) return null;

    const lines = normalized
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((line) => !/comp[ée]tences|skills/i.test(line));

    const filtered = lines.filter((line) => !isTrivialMetaDescription(line, ctx));
    const finalText = filtered.join("\n").trim();
    if (!finalText || isTrivialMetaDescription(finalText, ctx)) return null;
    return finalText;
  };

  const extractDetailsDescription = (root, ctx) => {
    if (!root) return null;
    clickSeeMore(root);

    const preferredNodes = Array.from(
      root.querySelectorAll(
        'div[class*="inline-show-more-text"] span[aria-hidden="true"], .pv-shared-text-with-see-more span[aria-hidden="true"]'
      )
    );
    const inlineNodes = preferredNodes.length
      ? preferredNodes
      : Array.from(
          root.querySelectorAll('div[class*="inline-show-more-text"], .pv-shared-text-with-see-more')
        );

    const inlineText = inlineNodes.map(extractTextWithBreaks).filter(Boolean).join("\n");
    const normalizedInline = normalizeDetailsDescription(inlineText, ctx);
    if (normalizedInline) return normalizedInline;

    const fallbackNodes = Array.from(
      root.querySelectorAll("div.t-14, div.t-normal, span.t-14, span.t-normal, p")
    ).filter((node) => {
      if (!node) return false;
      if (node.closest("h1, h2, h3")) return false;
      if (node.closest("button, a")) return false;
      return true;
    });

    let best = null;
    let bestScore = 0;
    for (const node of fallbackNodes) {
      const raw = extractTextWithBreaks(node);
      const cleaned = normalizeDetailsDescription(raw, ctx);
      if (!cleaned) continue;
      const scoreBase = cleaned.length;
      const className = node.className || "";
      const classBonus =
        (className.includes("t-black") ? 12 : 0) +
        (className.includes("t-normal") ? 8 : 0) +
        (className.includes("t-14") ? 6 : 0);
      const score = scoreBase + classBonus;
      if (score > bestScore) {
        best = cleaned;
        bestScore = score;
      }
    }

    return best;
  };

  const scrollToLoad = async () => {
    let lastHeight = 0;
    let stableCount = 0;
    for (let i = 0; i < 40; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(450);
      const height = document.body.scrollHeight;
      if (height === lastHeight) {
        stableCount += 1;
        if (stableCount >= 3) break;
      } else {
        stableCount = 0;
        lastHeight = height;
      }
    }
  };

  await scrollToLoad();

  const main =
    document.querySelector('main[role="main"]') ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body;
  let experienceSection = null;
  let rootMode = "MAIN";

  const anchor = main.querySelector("#experience");
  if (anchor) {
    experienceSection = anchor.closest("section") || anchor.parentElement?.closest("section") || anchor.parentElement;
    rootMode = "ANCHOR";
  } else {
    const headings = Array.from(main.querySelectorAll("h1, h2, h3")).filter((el) =>
      /exp[ée]rience/i.test(clean(el.textContent))
    );
    if (headings.length) {
      experienceSection = headings[0].closest("section");
      rootMode = "HEADING";
    }
  }

  if (!experienceSection) {
    const sections = Array.from(main.querySelectorAll("section"));
    if (sections.length) {
      const scored = sections
        .map((section) => ({ section, score: clean(section.textContent || "").length }))
        .sort((a, b) => b.score - a.score);
      experienceSection = scored[0].section;
      rootMode = "LARGEST_SECTION";
    }
  }

  const scope = experienceSection || main;
  const allLis = Array.from(scope.querySelectorAll("li"));
  const topLis = allLis.filter((li) => {
    if (li.closest(".pvs-entity__sub-components")) return false;
    if (!li.querySelector("div.t-bold, span.t-bold")) return false;
    if (clean(li.innerText || "").length <= 25) return false;
    return true;
  });

  const results = [];
  const seen = new Set();
  const counts = { topLis: topLis.length, grouped: 0, singles: 0, skipped: 0 };

  const pushExperience = (record) => {
    const key = [record.title, record.company, record.dates, record.location, record.workplaceType || ""]
      .map((v) => clean(v).toLowerCase())
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    results.push(record);
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

        const metaLines = [...collectMetaLines(roleLi), ...extras].filter(
          (line) => line && line !== title && line !== dates && line !== company
        );
        const { location, workplaceType } = extractLocationAndWorkplaceType(metaLines);
        const ctx = { title, company, companyLine, dates, location, workplaceType };
        const description = extractDetailsDescription(roleLi, ctx);

        pushExperience({
          title,
          company,
          dates,
          location: location || "",
          workplaceType: workplaceType || null,
          description: description || null,
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

    const metaLines = [...collectMetaLines(li), ...extras].filter(
      (line) => line && line !== title && line !== company && line !== dates
    );
    const { location, workplaceType } = extractLocationAndWorkplaceType(metaLines);
    const ctx = { title, company, companyLine, dates, location, workplaceType };
    const description = extractDetailsDescription(li, ctx);

    pushExperience({
      title,
      company,
      dates,
      location: location || "",
      workplaceType: workplaceType || null,
      description: description || null,
    });
  }

  const debug = { rootMode, counts };
  expLog("DETAILS_DEBUG", debug);
  return { experiences: results, debug };
}

async function scrapeExperienceDetailsInBackground(detailsUrl, profileKey) {
  if (profileKey && detailsScrapeInFlight.has(profileKey)) {
    return detailsScrapeInFlight.get(profileKey);
  }

  const runner = (async () => {
    const tab = await chrome.tabs.create({ url: detailsUrl, active: false });
    if (!tab?.id) {
      throw new Error("Failed to open details tab");
    }

    expLog("DETAILS_TAB_CREATED", { tabId: tab.id, detailsUrl, profileKey });

    try {
      await waitForComplete(tab.id, 15000);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detailsExperienceScraper,
      });
      const payload = Array.isArray(results) ? results?.[0]?.result : null;
      const experiences = Array.isArray(payload?.experiences)
        ? payload.experiences
        : Array.isArray(payload)
          ? payload
          : [];
      expLog("DETAILS_SCRAPE_RESULT", {
        count: experiences?.length || 0,
        debug: payload?.debug || null,
        detailsUrl,
        profileKey,
      });
      return Array.isArray(experiences) ? experiences : [];
    } catch (err) {
      expLog("DETAILS_SCRAPE_ERROR", err?.message || err);
      throw err;
    } finally {
      if (!DEBUG_KEEP_DETAILS_TAB) {
        try {
          await chrome.tabs.remove(tab.id);
          expLog("DETAILS_TAB_CLOSED", { tabId: tab.id });
        } catch (err) {
          expLog("DETAILS_TAB_CLOSE_FAILED", err?.message || err);
        }
      }
    }
  })();

  if (profileKey) detailsScrapeInFlight.set(profileKey, runner);
  try {
    return await runner;
  } finally {
    if (profileKey) detailsScrapeInFlight.delete(profileKey);
  }
}

async function saveProfileToSupabaseExternal(profileData) {
  const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYXdjZWtuc2VkeGFlanBleWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4MTUzMTUsImV4cCI6MjA3NDM5MTMxNX0.G3XH8afOmaYh2PGttY3CVRwi0JIzIvsTKIeeynpKpKI";

  console.log(
    "[Focals] Sauvegarde vers Supabase:",
    profileData.linkedin_url || profileData.linkedinProfileUrl
  );

  const response = await fetch(`${SUPABASE_URL}/functions/v1/save-engineer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      userId: "extension-update",
      profile: profileData,
      exportedAt: new Date().toISOString(),
      source: "extension-update",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase error: ${error}`);
  }

  return response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const syncStore = withStorage("sync");
  const localStore = withStorage("local");

  switch (message?.type) {
    case "API_REQUEST": {
      const { endpoint, method = "GET", params, body, headers } = message;
      if (!endpoint) {
        sendResponse({ ok: false, error: "Missing endpoint" });
        return false;
      }

      fetchApi({ endpoint, method, params, body, headers })
        .then((result) => {
          if (!result?.ok) {
            console.warn("[Focals][API_REQUEST] Request failed", {
              endpoint,
              status: result?.status,
              error: result?.error,
            });
          }
          sendResponse(result);
        })
        .catch((error) => {
          console.error("[Focals][API_REQUEST] Network error", error);
          sendResponse({ ok: false, error: error?.message || "API request failed" });
        });

      return true;
    }
    case "BOUNCER_REQUEST": {
      const { endpoint, options = {} } = message || {};
      if (!endpoint) {
        sendResponse({ ok: false, error: "Missing endpoint" });
        return false;
      }

      const { method = "GET", headers = {}, body, params } = options;
      let parsedBody = body;
      if (typeof body === "string") {
        try {
          parsedBody = JSON.parse(body);
        } catch (e) {
          parsedBody = body;
        }
      }

      fetchApi({ endpoint, method, headers, body: parsedBody, params })
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || "Local request failed" }));
      return true;
    }
    case "FOCALS_SCRAPE_PROFILE_URL": {
      const { url } = message || {};
      if (!url) {
        sendResponse({ ok: false, error: "Missing URL" });
        return false;
      }

      chrome.tabs.create({ url, active: false }, (tab) => {
        if (chrome.runtime.lastError || !tab?.id) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError?.message || "Failed to open tab",
          });
          return;
        }
        sendResponse({ ok: true, tabId: tab.id });
      });
      return true;
    }
    case "FOCALS_SCRAPE_DETAILS_EXPERIENCE": {
      const { detailsUrl, profileKey } = message || {};
      if (!detailsUrl) {
        sendResponse({ ok: false, error: "Missing detailsUrl" });
        return false;
      }

      scrapeExperienceDetailsInBackground(detailsUrl, profileKey)
        .then((experiences) => sendResponse({ ok: true, experiences }))
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || "Details scrape failed" })
        );
      return true;
    }
    case "FOCALS_CLOSE_TAB": {
      const { tabId } = message || {};
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing tabId" });
        return false;
      }

      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true });
      });

      return true;
    }
    case "SUPABASE_SESSION": {
      const session = message.session;
      debugLog("BG_SUPABASE_SESSION", {
        hasAccessToken: !!session?.access_token,
        hasUser: !!session?.user,
      });
      chrome.storage.local.set({ focals_supabase_session: session }, () => {
        debugLog("BG_SUPABASE_SESSION_STORED", true);
        sendResponse({ ok: true });
      });
      return true;
    }
    case "FOCALS_GET_STATE": {
      Promise.all([
        syncStore.get([STORAGE_KEYS.tone, STORAGE_KEYS.templates, STORAGE_KEYS.selectedTemplate]),
        syncStore.get([STORAGE_KEYS.jobs, STORAGE_KEYS.selectedJob]),
      ]).then(([syncValues, jobValues]) => {
        sendResponse({
          tone: syncValues?.[STORAGE_KEYS.tone] || DEFAULT_TONE,
          templates: syncValues?.[STORAGE_KEYS.templates] || [],
          selectedTemplate: syncValues?.[STORAGE_KEYS.selectedTemplate] || null,
          jobs: jobValues?.[STORAGE_KEYS.jobs] || [],
          selectedJob: jobValues?.[STORAGE_KEYS.selectedJob] || null,
        });
      });
      return true;
    }
    case "FOCALS_SET_TONE": {
      syncStore.set({ [STORAGE_KEYS.tone]: message.value || DEFAULT_TONE }).then(() =>
        sendResponse({ ok: true })
      );
      return true;
    }
    case "FOCALS_SAVE_TEMPLATE": {
      syncStore.get([STORAGE_KEYS.templates]).then((values) => {
        const templates = Array.isArray(values?.[STORAGE_KEYS.templates])
          ? values[STORAGE_KEYS.templates]
          : [];
        const existingIndex = templates.findIndex((t) => t.id === message.template.id);
        if (existingIndex >= 0) {
          templates[existingIndex] = message.template;
        } else {
          templates.push(message.template);
        }
        syncStore
          .set({
            [STORAGE_KEYS.templates]: templates,
            [STORAGE_KEYS.selectedTemplate]: message.template.id,
          })
          .then(() => sendResponse({ ok: true, templates }));
      });
      return true;
    }
    case "FOCALS_DELETE_TEMPLATE": {
      syncStore.get([STORAGE_KEYS.templates]).then((values) => {
        const templates = Array.isArray(values?.[STORAGE_KEYS.templates])
          ? values[STORAGE_KEYS.templates]
          : [];
        const filtered = templates.filter((t) => t.id !== message.id);
        syncStore
          .set({ [STORAGE_KEYS.templates]: filtered })
          .then(() => sendResponse({ ok: true, templates: filtered }));
      });
      return true;
    }
    case "FOCALS_SELECT_TEMPLATE": {
      syncStore.set({ [STORAGE_KEYS.selectedTemplate]: message.id || null }).then(() =>
        sendResponse({ ok: true })
      );
      return true;
    }
    case "FOCALS_SAVE_JOB": {
      syncStore.get([STORAGE_KEYS.jobs]).then((values) => {
        const jobs = Array.isArray(values?.[STORAGE_KEYS.jobs]) ? values[STORAGE_KEYS.jobs] : [];
        const existingIndex = jobs.findIndex((j) => j.id === message.job.id);
        if (existingIndex >= 0) {
          jobs[existingIndex] = message.job;
        } else {
          jobs.push(message.job);
        }
        syncStore
          .set({
            [STORAGE_KEYS.jobs]: jobs,
            [STORAGE_KEYS.selectedJob]: message.job.id,
          })
          .then(() => sendResponse({ ok: true, jobs }));
      });
      return true;
    }
    case "FOCALS_DELETE_JOB": {
      syncStore.get([STORAGE_KEYS.jobs]).then((values) => {
        const jobs = Array.isArray(values?.[STORAGE_KEYS.jobs]) ? values[STORAGE_KEYS.jobs] : [];
        const filtered = jobs.filter((j) => j.id !== message.id);
        syncStore
          .set({ [STORAGE_KEYS.jobs]: filtered })
          .then(() => sendResponse({ ok: true, jobs: filtered }));
      });
      return true;
    }
    case "FOCALS_SELECT_JOB": {
      syncStore.set({ [STORAGE_KEYS.selectedJob]: message.id || null }).then(() =>
        sendResponse({ ok: true })
      );
      return true;
    }
    case "FOCALS_ASK_GPT": {
      askGPT(message.prompt, {
        system: message.system,
        temperature: message.temperature,
        maxTokens: message.maxTokens,
      }).then((result) => sendResponse(result));
      return true;
    }
    case "FOCALS_SET_API_KEY": {
      syncStore.set({ [STORAGE_KEYS.apiKey]: message.apiKey || "" }).then(() =>
        sendResponse({ ok: true })
      );
      return true;
    }
    case "SAVE_PROFILE_TO_SUPABASE": {
      (async () => {
        try {
          const result = await saveProfileToSupabase(message.profile);
          sendResponse({ success: true, result });
        } catch (err) {
          debugLog("SUPABASE_SAVE_ERROR", err?.message || String(err));
          sendResponse({ error: err?.message || "Enregistrement Supabase impossible" });
        }
      })();
      return true;
    }
    case "GENERATE_REPLY": {
      console.log("[Focals] Requête génération réponse:", message);

      (async () => {
        try {
          const {
            userId: userIdFromMessage,
            conversation,
            toneOverride,
            promptReply,
            jobId,
            templateId,
            messages: directMessages,
            context = {},
            customInstructions,
            systemPromptOverride,
          } = message;

          const stored = await chrome.storage.local.get(["focals_user_id"]);
          const userIdFromStorage = stored.focals_user_id;
          const userId = userIdFromMessage || userIdFromStorage;

          if (!userId) {
            console.error("[Focals][BG] Missing userId for GENERATE_REPLY");
            sendResponse({ success: false, error: "Missing userId" });
            return;
          }

          const rawMessages = Array.isArray(directMessages)
            ? directMessages
            : Array.isArray(conversation?.messages)
              ? conversation.messages
              : Array.isArray(conversation)
                ? conversation
                : [];

          const conversationMessages = getLastMessagesForBackend(rawMessages);

          if (!conversationMessages.length) {
            console.warn("[Focals][BG] Empty conversation in GENERATE_REPLY");
            sendResponse({ success: false, error: "Empty conversation" });
            return;
          }

          const normalizedSystemPrompt =
            (context?.systemPromptOverride && context.systemPromptOverride.trim()) ||
            (systemPromptOverride && systemPromptOverride.trim()) ||
            (customInstructions && customInstructions.trim()) ||
            (promptReply && promptReply.trim()) ||
            null;

          const payloadContext = { ...context };

          if (conversation?.language && !payloadContext.language) {
            payloadContext.language = conversation.language;
          }
          if (toneOverride && !payloadContext.tone) {
            payloadContext.tone = toneOverride;
          }
          const candidateName =
            payloadContext.candidateName ||
            conversation?.candidateFirstName ||
            conversation?.candidateName ||
            null;
          payloadContext.candidateName = candidateName;

          if (normalizedSystemPrompt !== null) {
            payloadContext.systemPromptOverride = normalizedSystemPrompt;
          }

          const payload = {
            userId,
            messages: conversationMessages,
            context: payloadContext,
            toneOverride,
            jobId,
            templateId,
          };

          console.log("[Focals][BG] Calling focals-generate-reply with payload", {
            ...payload,
            conversationLength: conversationMessages.length,
            hasSystemPromptOverride: !!payloadContext.systemPromptOverride,
          });

          const apiResponse = await fetchApi({
            endpoint: "focals-generate-reply",
            method: "POST",
            body: payload,
          });

          if (!apiResponse.ok) {
            console.error("[Focals][BG] focals-generate-reply failed", apiResponse);
            sendResponse({ success: false, error: apiResponse.error || "focals-generate-reply failed" });
            return;
          }

          const data = apiResponse.data;
          const replyText =
            data?.reply?.text ||
            (typeof data?.reply === "string" ? data.reply : null) ||
            data?.replyText;

          console.log("[Focals] Réponse générée:", replyText?.substring(0, 100) + "...");

          sendResponse({
            success: true,
            replyText,
            model: data.model,
          });
        } catch (error) {
          console.error("[Focals] Erreur génération:", error);
          sendResponse({
            success: false,
            error: error?.message || "Erreur réseau",
          });
        }
      })();

      return true;
    }
    default:
      break;
  }

  return false;
});

// ===== HANDLERS MESSAGES EXTERNES (depuis l'app web) =====
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log("[Focals] Message externe reçu:", message?.type, "depuis:", sender?.origin);

  if (message?.type === "PING_TEST" || message?.type === "PING") {
    console.log("[Focals] PING reçu, réponse PONG");
    sendResponse({ status: "pong", version: chrome.runtime.getManifest().version });
    return true;
  }

  if (message?.type === "SCRAPE_PROFILE") {
    console.log("[Focals] SCRAPE_PROFILE reçu:", message.linkedinUrl);

    (async () => {
      try {
        const { linkedinUrl } = message;

        if (!linkedinUrl) {
          sendResponse({ success: false, error: "URL LinkedIn manquante" });
          return;
        }

        const tab = await chrome.tabs.create({ url: linkedinUrl, active: true });
        console.log("[Focals] Onglet créé:", tab.id);

        await waitForComplete(tab.id);
        console.log("[Focals] Page chargée");

        await wait(2500);

        await ensureContentScript(tab.id);
        await wait(500);

        console.log("[Focals] Demande GET_CANDIDATE_DATA...");
        const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CANDIDATE_DATA" });

        await chrome.tabs.remove(tab.id);
        console.log("[Focals] Onglet fermé");

        if (response?.error) {
          console.error("[Focals] Erreur scraping:", response.error);
          sendResponse({ success: false, error: response.error });
          return;
        }

        if (!response?.data) {
          console.error("[Focals] Aucune donnée récupérée");
          sendResponse({ success: false, error: "Aucune donnée récupérée" });
          return;
        }

        console.log("[Focals] Données scrapées:", response.data.name || response.data.fullName);

        await saveProfileToSupabaseExternal(response.data);
        console.log("[Focals] ✅ Profil sauvegardé");

        sendResponse({ success: true, profile: response.data });
      } catch (error) {
        console.error("[Focals] ❌ Erreur SCRAPE_PROFILE:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true;
  }

  if (message?.type === "SCRAPE_PROFILES_BATCH") {
    console.log("[Focals] SCRAPE_PROFILES_BATCH reçu:", message.linkedinUrls?.length, "URLs");

    const { linkedinUrls } = message;

    if (!linkedinUrls || !Array.isArray(linkedinUrls) || linkedinUrls.length === 0) {
      sendResponse({ success: false, error: "URLs LinkedIn manquantes" });
      return true;
    }

    sendResponse({ success: true, status: "started", total: linkedinUrls.length });

    (async () => {
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < linkedinUrls.length; i++) {
        const url = linkedinUrls[i];
        console.log(`[Focals] Batch scraping ${i + 1}/${linkedinUrls.length}: ${url}`);

        try {
          const tab = await chrome.tabs.create({ url, active: true });

          await waitForComplete(tab.id);
          await wait(2500);

          await ensureContentScript(tab.id);
          await wait(500);

          const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CANDIDATE_DATA" });

          await chrome.tabs.remove(tab.id);

          if (response?.data) {
            await saveProfileToSupabaseExternal(response.data);
            successCount++;
            console.log(`[Focals] ✅ Profil ${i + 1} sauvegardé`);
          } else {
            errorCount++;
            console.warn(`[Focals] ⚠️ Profil ${i + 1}: pas de données`);
          }

          if (i < linkedinUrls.length - 1) {
            const delay = 2000 + Math.random() * 2000;
            console.log(`[Focals] Attente ${Math.round(delay)}ms avant prochain profil...`);
            await wait(delay);
          }
        } catch (error) {
          console.error(`[Focals] ❌ Erreur profil ${i + 1}:`, error);
          errorCount++;
        }
      }

      console.log(`[Focals] Batch terminé: ${successCount} succès, ${errorCount} erreurs`);
    })();

    return true;
  }

  return false;
});

console.log("[Focals] External message handlers registered");
