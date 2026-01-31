import supabase, { SUPABASE_URL } from "./supabase-client.js";
import { API_BASE_URL, IS_DEV } from "./src/api/config.js";
import { loadStoredToken } from "./src/api/supabaseClient.js";
import { createLogger } from "./src/utils/logger.js";

// Intercepteur spécifique pour l'API Dash Messenger (LinkedIn 2026)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method === "POST" && details.requestBody) {
      try {
        const urlMatch = details.url.match(
          /conversationUrn=(urn%3Ali%3Amsg_conversation%3A[^&]+)/
        );
        let conversationUrn = urlMatch ? decodeURIComponent(urlMatch[1]) : null;

        if (details.requestBody.raw) {
          const rawBody = details.requestBody.raw[0].bytes;
          const decoder = new TextDecoder("utf-8");
          const json = JSON.parse(decoder.decode(rawBody));

          const messageText = json.message?.body?.text;
          conversationUrn = conversationUrn || json.conversationUrn;

          if (messageText && conversationUrn) {
            console.log("🎯 [RADAR] Network Hit:", conversationUrn);

            if (typeof relayLiveMessageToSupabase === "function") {
              relayLiveMessageToSupabase({
                text: messageText,
                conversation_urn: conversationUrn,
                type: "linkedin_chat_dash",
              });
            }
          }
        }
      } catch (e) {
        // On ignore les requêtes malformées
      }
    }
  },
  {
    urls: [
      "*://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage*",
    ],
  },
  ["requestBody"]
);

const logger = createLogger("Background");
const FOCALS_DEBUG = IS_DEV;
const DEBUG_KEEP_DETAILS_TAB = false;
const EXP_TAG = "[FOCALS][EXPERIENCE]";
const expLog = (...a) => console.log(EXP_TAG, ...a);
const detailsLog = (...a) => console.log("[FOCALS][DETAILS]", ...a);
const detailsScrapeInFlight = new Map();
const DETAILS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

async function relayLiveMessageToSupabase(payload) {
  if (!payload?.text) return;

  let { text, conversation_urn, type, match_name, profile_url } = payload;

  if (payload?.identity) {
    match_name = payload.identity.match_name || payload.identity.matchName || match_name;
    profile_url = payload.identity.profile_url || payload.identity.profileUrl || profile_url;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const context = await chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_CONTEXT" });
      if (context) {
        match_name = context.matchName || context.match_name || match_name;
        profile_url = context.profileUrl || context.profile_url || profile_url;
      }
    }
  } catch (error) {
    console.warn("🎯 [RADAR] Échec de récupération du contexte", error);
  }

  const cleanText = String(text || "")
    .replace(/View profile.*/gi, "")
    .replace(/Voir le profil de.*/gi, "")
    .replace(/Madeleine Maisonneuve.*/gi, "")
    .replace(/\d{1,2}:\d{1,2}/g, "")
    .trim();

  if (cleanText.length < 2) return;

  const normalizeConversationUrn = (value) => {
    const fallback = "urn:li:msg_conversation:unknown";
    if (!value) return fallback;
    const raw = String(value).trim();
    if (!raw) return fallback;
    if (raw.startsWith("urn:li:msg_conversation:")) return raw;
    if (raw.startsWith("msg_conversation:")) return `urn:li:${raw}`;
    if (raw.includes("msg_conversation:")) {
      const idx = raw.indexOf("msg_conversation:");
      return `urn:li:${raw.slice(idx)}`;
    }
    return fallback;
  };

  const profileUrl = profile_url || "https://www.linkedin.com/in/unknown";
  const slugToName = (slug) =>
    slug
      ? slug
          .split(/[-_]/g)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
      : "";
  const extractNameFromUrl = (url) => {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/in\/([^/]+)/i);
      if (!match) return "";
      const slug = match[1].replace(/\/$/, "");
      return slugToName(slug);
    } catch {
      return "";
    }
  };
  let matchName = match_name || profileUrl.split("/in/")[1]?.replace("/", "") || "";
  if (
    !matchName ||
    ["unknown", "linkedin user"].includes(matchName.trim().toLowerCase())
  ) {
    matchName = extractNameFromUrl(profileUrl) || matchName;
  }
  if (!matchName || matchName.trim().toLowerCase() === "unknown") {
    matchName = "LinkedIn User";
  }

  const cleanPayload = {
    text: cleanText,
    match_name: matchName,
    profile_url: profileUrl,
    conversation_urn: normalizeConversationUrn(conversation_urn || payload?.conversationUrn),
    type: type || "linkedin_live",
    received_at: new Date().toISOString(),
  };

  console.log("🎯 [RADAR] SUPABASE relay payload :", cleanPayload);
  console.log("🚀 PAYLOAD FINAL:", cleanPayload);

  const token = await loadStoredToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const response = await fetch(`${API_BASE_URL}/focals-incoming-message`, {
    method: "POST",
    headers,
    body: JSON.stringify(cleanPayload),
  });
  const responseBody = await response.text();

  if (!response.ok) {
    console.error(`🎯 [RADAR] ❌ [SUPABASE] Error (${response.status}):`, responseBody);
    return { ok: false, status: response.status, error: responseBody };
  }

  console.log(`🎯 [RADAR] ✅ [SUPABASE] Success (${response.status}):`, responseBody);
  return { ok: true, status: response.status, data: responseBody };
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

const buildDetailsCacheKey = (profileKey) => `focals_details_cache:${profileKey}`;
const isCacheFresh = (ts) => Number.isFinite(ts) && Date.now() - ts < DETAILS_CACHE_TTL_MS;

async function getDetailsCache(profileKey) {
  if (!profileKey) return null;
  const localStore = withStorage("local");
  const key = buildDetailsCacheKey(profileKey);
  const data = await localStore.get(key);
  const entry = data?.[key];
  if (!entry || typeof entry !== "object") return null;
  if (!isCacheFresh(entry.ts)) return null;
  return Array.isArray(entry.experiences) ? entry.experiences : null;
}

async function setDetailsCache(profileKey, experiences) {
  if (!profileKey || !Array.isArray(experiences)) return false;
  const localStore = withStorage("local");
  const key = buildDetailsCacheKey(profileKey);
  return localStore.set({ [key]: { ts: Date.now(), experiences } });
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
  const clean = (t) => (t ? String(t).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : "");
  const collapseDouble = (text) => {
    const t = clean(text);
    if (!t) return "";
    const match = t.match(/^(.+?)\s+\1$/i);
    if (match?.[1]) return clean(match[1]);
    if (t.length % 2 === 0) {
      const half = t.slice(0, t.length / 2);
      if (half === t.slice(t.length / 2)) return clean(half);
    }
    return t;
  };
  const cleanText = (text) => collapseDouble(text);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const DEBUG = (() => {
    try {
      return localStorage.getItem("FOCALS_DEBUG") === "true";
    } catch (err) {
      return false;
    }
  })();

  const monthTokenRegex =
    /(janv\.?|févr\.?|f[ée]v\.?|mars|avr\.?|mai|juin|juil\.?|ao[uû]t|sept\.?|oct\.?|nov\.?|d[ée]c\.?|jan|feb|mar|apr|may|jun|jul|aug|sep|septembre|october|november|dec|january|february|march|april|june|july|august|september|october|november|december)/i;

  const looksLikeDates = (text) => {
    const t = cleanText(text);
    if (!t) return false;
    return monthTokenRegex.test(t) || /\b(19\d{2}|20\d{2})\b/.test(t) || /aujourd|present|présent/i.test(t);
  };

  const looksLikeLocation = (text) => {
    const t = cleanText(text);
    if (!t) return false;
    if (t.length > 80) return false;
    if (looksLikeDates(t)) return false;
    if (looksLikeEmploymentType(t)) return false;
    if (/comp[ée]tences|skills/i.test(t)) return false;
    if (normalizeWorkplaceType(t)) return false;
    if (/[0-9]{2,}/.test(t)) return false;
    if (/,/.test(t)) return true;
    return /[\p{L}]{2,}/u.test(t);
  };

  const isNoise = (text) => {
    const t = cleanText(text);
    if (!t) return true;
    if (looksLikeEmploymentType(t)) return true;
    if (looksLikeDates(t)) return true;
    if (/\b\d+\s*(an|ans|mois|yr|yrs|year|years|mos|months)\b/i.test(t)) return true;
    if (/comp[ée]tences|skills/i.test(t)) return true;
    return false;
  };

  const getLines = (scope) => {
    if (!scope) return [];
    const nodes = Array.from(scope.querySelectorAll("p, span[aria-hidden='true']"));
    const out = [];
    let lastKey = null;
    for (const node of nodes) {
      const raw = node.textContent || "";
      const parts = raw.split("\n").map((line) => collapseDouble(line)).filter(Boolean);
      for (const part of parts) {
        const key = part.toLowerCase();
        if (lastKey && key === lastKey) continue;
        out.push(part);
        lastKey = key;
      }
    }
    return out;
  };

  const pickTitle = (li) => {
    if (!li) return null;
    const node =
      li.querySelector("div.t-bold span[aria-hidden='true']") ||
      li.querySelector("div.t-bold span") ||
      li.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']") ||
      li.querySelector(".hoverable-link-text.t-bold");
    const title = cleanText(node?.textContent);
    return title || null;
  };

  const pickHeaderCompany = (groupLi) => {
    if (!groupLi) return null;
    const candidates = Array.from(groupLi.querySelectorAll(".t-bold")).filter(
      (node) => !node.closest(".pvs-entity__sub-components")
    );
    for (const node of candidates) {
      const text = cleanText(node.querySelector("span[aria-hidden='true']")?.textContent || node.textContent);
      if (text) return text;
    }
    return null;
  };

  const pickDates = (scope, title) => {
    const lines = getLines(scope);
    let best = null;
    let bestScore = -1;
    const titleKey = cleanText(title).toLowerCase();
    for (const line of lines) {
      if (titleKey && line.toLowerCase() === titleKey) continue;
      if (!looksLikeDates(line)) continue;
      let score = 0;
      if (/\b(19\d{2}|20\d{2})\b/.test(line)) score += 2;
      if (monthTokenRegex.test(line)) score += 1;
      if (/[–—-]/.test(line)) score += 1;
      if (/aujourd|present|présent/i.test(line)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = line;
      }
    }
    return best ? cleanText(best) : null;
  };

  const pickCompanyFromDotLine = (scope, title) => {
    const lines = getLines(scope);
    const titleKey = cleanText(title).toLowerCase();
    for (const line of lines) {
      if (!line.includes("·")) continue;
      const first = cleanText(line.split("·")[0]);
      if (!first) continue;
      if (titleKey && first.toLowerCase() === titleKey) continue;
      if (isNoise(first)) continue;
      return first;
    }
    return null;
  };

  const pickCompanyFallback = (scope, title) => {
    const lines = getLines(scope);
    if (!lines.length) return null;
    const titleKey = cleanText(title).toLowerCase();
    const titleIndex = lines.findIndex((line) => line.toLowerCase() === titleKey);
    if (titleIndex >= 0 && lines[titleIndex + 1]) {
      const candidate = cleanText(lines[titleIndex + 1]);
      if (candidate && !isNoise(candidate) && candidate.toLowerCase() !== titleKey) {
        return candidate;
      }
    }
    for (const line of lines) {
      const candidate = cleanText(line);
      if (!candidate) continue;
      if (candidate.toLowerCase() === titleKey) continue;
      if (isNoise(candidate)) continue;
      return candidate;
    }
    return null;
  };

  const pickLocation = (scope) => {
    const lines = getLines(scope);
    for (const line of lines) {
      if (!line.includes("·")) continue;
      const parts = line.split("·").map(cleanText).filter(Boolean);
      for (const part of parts) {
        if (looksLikeLocation(part)) return part;
      }
    }
    for (const line of lines) {
      if (looksLikeLocation(line)) return cleanText(line);
    }
    return null;
  };

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
    const withBreaks = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ");
    return withBreaks
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
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

  const runSkillsSelfTest = (nodes = []) => {
    if (!DEBUG || !nodes.length) return;
    const rows = nodes.slice(0, 5).map((node, index) => {
      const skills = extractSkillsFromExperienceNode(node);
      return { index, skills, skillsCount: skills.length };
    });
    if (rows.length) {
      console.table(rows);
    }
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

  const normalizeWorkplaceType = (text) => {
    const t = cleanText(text);
    if (!t) return null;
    const rule = WORKPLACE_TYPE_RULES.find((entry) => entry.regex.test(t));
    return rule ? rule.value : null;
  };

  const looksLikeEmploymentType = (text) =>
    /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i.test(
      text || ""
    );

  const looksLikeDateRange = (text) => {
    const t = cleanText(text).toLowerCase();
    if (!t) return false;
    if (/\b(19\d{2}|20\d{2})\b/.test(t) && (t.includes(" - ") || t.includes("–") || t.includes("—"))) {
      return true;
    }
    if (/\baujourd/i.test(t)) return true;
    return monthTokenRegex.test(t);
  };

  const isMostlyDatesText = (text) => {
    const t = cleanText(text).toLowerCase();
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
      .map(cleanText)
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
      (a) => cleanText(a.textContent).length >= 2
    );
    const linkText = cleanText(companyLink?.textContent);
    if (linkText) return linkText;

    const imgAlt = cleanText(li.querySelector('img[alt*="Logo"]')?.getAttribute("alt"));
    const match = imgAlt.match(/logo\s+de\s+(.+)/i);
    if (match?.[1]) return cleanText(match[1]);

    return null;
  };

  const collectMetaLines = (container) => {
    if (!container) return [];
    let spans = Array.from(
      container.querySelectorAll("span.t-14.t-normal.t-black--light span[aria-hidden='true']")
    )
      .map((n) => cleanText(n.textContent))
      .filter(Boolean);
    if (!spans.length) {
      spans = Array.from(container.querySelectorAll("span.t-14.t-normal.t-black--light"))
        .map((n) => cleanText(n.textContent))
        .filter(Boolean);
    }
    return spans;
  };

  const extractTitleFromContainer = (container) =>
    cleanText(container?.querySelector("div.t-bold span[aria-hidden='true']")?.textContent) ||
    cleanText(container?.querySelector("div.t-bold span")?.textContent) ||
    cleanText(container?.querySelector(".hoverable-link-text.t-bold span[aria-hidden='true']")?.textContent) ||
    cleanText(container?.querySelector(".hoverable-link-text.t-bold")?.textContent) ||
    null;

  const extractCompanyLineFromContainer = (container) =>
    cleanText(container?.querySelector("span.t-14.t-normal span[aria-hidden='true']")?.textContent) ||
    cleanText(container?.querySelector("span.t-14.t-normal")?.textContent) ||
    null;

  const extractDatesFromContainer = (container) =>
    cleanText(container?.querySelector("span.pvs-entity__caption-wrapper[aria-hidden='true']")?.textContent) ||
    cleanText(container?.querySelector("span.pvs-entity__caption-wrapper")?.textContent) ||
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

  const isDateRangeLine = (line) => /^(du|from)\b.+\b(au|to)\b/i.test(line);

  const buildMetaLines = (ctx) => {
    const title = cleanText(ctx?.title || "");
    const company = cleanText(ctx?.company || "");
    const companyLine = cleanText(ctx?.companyLine || "");
    const dates = cleanText(ctx?.dates || "");
    const location = cleanText(ctx?.location || "");
    const workplaceType = cleanText(ctx?.workplaceType || "");
    const combo = [location, workplaceType].filter(Boolean).join(" · ");
    return [title, company, companyLine, dates, location, workplaceType, combo].filter(Boolean);
  };

  const isTrivialMetaDescription = (desc, ctx) => {
    if (!desc) return true;
    const normalized = cleanText(desc).toLowerCase();
    if (!normalized) return true;
    const metaLines = buildMetaLines(ctx).map((line) => line.toLowerCase());
    if (metaLines.some((line) => line && normalized === line)) return true;
    const title = cleanText(ctx?.title || "").toLowerCase();
    if (title && normalized === `${title} ${title}`.trim()) return true;
    if (isDateRangeLine(desc) || isMostlyDatesText(desc)) return true;
    return false;
  };

  const normalizeDetailsDescription = (text, ctx) => {
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
  };

  const extractDetailsDescription = (root, ctx) => {
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
    if (FOCALS_DEBUG && !root.dataset?.focalsDescDebug) {
      const rawPreview = inlineNodes.map((node) => cleanText(extractTextWithBreaks(node))).filter(Boolean);
      expLog("DESC_DEBUG", {
        title: ctx?.title || null,
        rawPreview,
        outPreview: normalizedInline ? normalizedInline.slice(0, 160) : null,
      });
      root.dataset.focalsDescDebug = "true";
    }
    if (normalizedInline) return normalizedInline;
    return null;
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
    if (cleanText(li.innerText || "").length <= 25) return false;
    return true;
  });
  runSkillsSelfTest(topLis);

  const results = [];
  const seen = new Set();
  const parsedRecords = [];
  const duplicateKeys = [];
  const counts = { topLis: topLis.length, grouped: 0, singles: 0, skipped: 0 };

  const pushExperience = (record) => {
    const key = [record.title, record.company, record.dates, record.location]
      .map((v) => cleanText(v).toLowerCase())
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
        if (!company || isNoise(company) || (title && company.toLowerCase() === cleanText(title).toLowerCase())) {
          company =
            pickCompanyFromDotLine(roleLi, title) ||
            pickCompanyFallback(roleLi, title) ||
            pickCompanyFromDotLine(li, title) ||
            pickCompanyFallback(li, title) ||
            company;
        }

        if (!company || isNoise(company) || (title && company.toLowerCase() === cleanText(title).toLowerCase())) {
          counts.skipped += 1;
          continue;
        }

        const companyLine = cleanText(company);
        const location = pickLocation(roleLi) || pickLocation(li);
        const ctx = { title, company, companyLine, dates, location, workplaceType: null };
        const description = extractDetailsDescription(roleLi, ctx);
        const skills = extractSkillsFromExperienceNode(roleLi);

        const record = {
          title: cleanText(title),
          company: cleanText(company),
          dates: cleanText(dates),
          location: cleanText(location || ""),
          workplaceType: null,
          description: description || null,
          skills,
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

    if (!company || isNoise(company) || (title && company.toLowerCase() === cleanText(title).toLowerCase())) {
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
    const skills = extractSkillsFromExperienceNode(li);

    const record = {
      title: cleanText(title),
      company: cleanText(company),
      dates: cleanText(dates),
      location: cleanText(location || ""),
      workplaceType: null,
      description: description || null,
      skills,
    };
    parsedRecords.push(record);
    pushExperience(record);
  }

  const debug = { rootMode, counts };
  results.slice(0, 3).forEach((entry) => {
    expLog("DETAILS_SKILLS", {
      title: entry?.title || null,
      skillsCount: Array.isArray(entry?.skills) ? entry.skills.length : 0,
    });
  });
  detailsLog("SCRAPE_DONE", {
    rootMode,
    topLis: topLis.length,
    parsed: parsedRecords.length,
    deduped: results.length,
    duplicateKeysCount: duplicateKeys.length,
  });
  if (!results.length) {
    const previews = topLis.slice(0, 3).map((li) => cleanText(li.innerText || "").slice(0, 200));
    detailsLog("EMPTY_RESULT", { previews });
  }
  expLog("DETAILS_DEBUG", debug);
  if (DEBUG && parsedRecords.length) {
    console.table(
      parsedRecords.slice(0, 10).map((row) => ({
        title: row.title || "",
        company: row.company || "",
        dates: row.dates || "",
        location: row.location || "",
      }))
    );
  }
  return { experiences: results, debug };
}

async function scrapeExperienceDetailsInBackground(detailsUrl, profileKey, reason) {
  if (profileKey && detailsScrapeInFlight.has(profileKey)) {
    return detailsScrapeInFlight.get(profileKey);
  }

  const runner = (async () => {
    const cached = await getDetailsCache(profileKey);
    if (cached) {
      detailsLog("CACHE_HIT", { profileKey, count: cached.length });
      return cached;
    }
    if (profileKey) {
      detailsLog("CACHE_MISS", { profileKey });
    }

    const tab = await chrome.tabs.create({ url: detailsUrl, active: false });
    if (!tab?.id) {
      throw new Error("Failed to open details tab");
    }

    detailsLog("TAB_CREATED", { tabId: tab.id, url: detailsUrl, profileKey });

    try {
      await waitForComplete(tab.id, 15000);
      const prepResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
          const clean = (s) => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
          const getMain = () =>
            document.querySelector('main[role="main"]') ||
            document.querySelector("main") ||
            document.querySelector('[role="main"]') ||
            document.body;
          const findExperienceSectionRoot = (main) => {
            if (!main) return null;
            const heading = Array.from(main.querySelectorAll("h1, h2, h3")).find((el) =>
              /exp[ée]rience/i.test(clean(el.textContent))
            );
            if (!heading) return null;
            return heading.closest("section");
          };
          const getTopLis = (scope) =>
            Array.from(scope?.querySelectorAll("li") || []).filter((li) => {
              if (li.closest(".pvs-entity__sub-components")) return false;
              if (!li.querySelector("div.t-bold, span.t-bold")) return false;
              if (clean(li.textContent).length <= 25) return false;
              return true;
            });
          const getRoleLisCount = (scope) =>
            Array.from(scope?.querySelectorAll(".pvs-entity__sub-components li") || []).length;
          const waitForContent = async () => {
            for (let i = 0; i < 40; i += 1) {
              const main = getMain();
              const section = findExperienceSectionRoot(main);
              if (main && section) {
                return { main, section };
              }
              await sleep(250);
            }
            const main = getMain();
            const section = findExperienceSectionRoot(main);
            return { main, section };
          };

          await waitForContent();
          let topLisExp = 0;
          let rolesCount = 0;
          const steps = rand(12, 18);
          for (let i = 0; i < steps; i += 1) {
            window.scrollTo(0, document.body.scrollHeight);
            window.dispatchEvent(
              new WheelEvent("wheel", { deltaY: 900, bubbles: true, cancelable: true })
            );
            document.dispatchEvent(
              new WheelEvent("wheel", { deltaY: 900, bubbles: true, cancelable: true })
            );
            await sleep(rand(250, 450));
            const main = getMain();
            const section = findExperienceSectionRoot(main);
            const root = section || main;
            if (root) {
              topLisExp = getTopLis(root).length;
              rolesCount = getRoleLisCount(root);
              if (topLisExp >= 3 && rolesCount >= 3) break;
            }
          }
          window.scrollTo(0, 0);
          await sleep(250);
          const main = getMain();
          const section = findExperienceSectionRoot(main);
          const liCountMain = main ? main.querySelectorAll("li").length : 0;
          return {
            topLisExp,
            rolesCount,
            liCountMain,
          };
        },
      });
      const prepPayload = Array.isArray(prepResults) ? prepResults?.[0]?.result : null;
      detailsLog("PREP_COUNTS", {
        topLisExp: prepPayload?.topLisExp ?? null,
        rolesCount: prepPayload?.rolesCount ?? null,
        liCountMain: prepPayload?.liCountMain ?? null,
        profileKey,
      });
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
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
          // --- DESC HELPERS ---
          function normalizeDescText(raw, { looksLikeDates, clean }) {
            const text = (raw || "")
              .replace(/\u00a0/g, " ")
              .replace(/[ \t]+\n/g, "\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();

            if (!text) return null;

            const lines = text.split("\n").map(clean).filter(Boolean);

            // filtre agressif: on ne garde PAS header/dates/location/contrat
            const filtered = lines.filter((l) => {
              if (!l) return false;
              if (looksLikeDates(l)) return false;
              if (/^logo de\s/i.test(l)) return false;
              if (
                /^\s*(cdi|cdd|stage|alternance|freelance|indépendant|independant|full[- ]time|part[- ]time|contract)\b/i.test(
                  l
                )
              )
                return false;
              if (/^\d+\s+(mois|ans?)$/i.test(l)) return false;
              return true;
            });

            const out = filtered.join("\n\n").trim();

            // seuil anti-bruit: en dessous => on considère que ce n’est pas une description
            if (!out || out.length < 40) return null;
            return out;
          }

          function findDescriptionBlocks(scope) {
            // Sur LinkedIn details/experience, les descriptions sont souvent dans:
            // - div.t-14.t-normal.t-black
            // - .display-flex .t-14.t-normal.t-black
            // parfois avec span[aria-hidden] + span.visually-hidden
            // IMPORTANT: on ne prend pas tous les spans aria-hidden du scope (trop bruité),
            // on cible uniquement les conteneurs “body”.
            const containers = Array.from(
              scope.querySelectorAll("div.t-14.t-normal.t-black, div.display-flex .t-14.t-normal.t-black")
            );

            // On retourne les spans internes (visually-hidden en priorité), sinon le container.
            const blocks = [];
            for (const c of containers) {
              const vh = c.querySelector(".visually-hidden");
              if (vh) {
                blocks.push(vh);
                continue;
              }
              const ah = c.querySelector("span[aria-hidden='true']");
              if (ah) {
                blocks.push(ah);
                continue;
              }
              blocks.push(c);
            }
            return blocks;
          }

          function extractDescriptionFromScope(scope, ctx, { looksLikeDates, clean }) {
            const blocks = findDescriptionBlocks(scope);
            if (!blocks.length) return null;

            const candidates = blocks
              .map((n) => normalizeDescText(n.textContent || "", { looksLikeDates, clean }))
              .filter(Boolean);

            if (!candidates.length) return null;

            // Prendre le plus long (en général le bon, surtout avec visually-hidden)
            candidates.sort((a, b) => b.length - a.length);
            return candidates[0];
          }
          const looksLikeLocation = (t) => {
            const s = clean(t);
            if (!s) return false;
            if (looksLikeDates(s)) return false;
            if (s.includes("·")) return false;
            return /(,| Area\b|Région|Île-de-France|France)\b/i.test(s) && s.length <= 140;
          };
          const EMPLOYMENT_RE =
            /\b(cdi|cdd|stage|alternance|freelance|indépendant|independant|temps plein|temps partiel|full[- ]time|part[- ]time|internship|apprenticeship|contract)\b/i;
          const looksLikeEmploymentType = (s) => {
            const t = clean(s);
            if (!t) return false;
            return EMPLOYMENT_RE.test(t);
          };
          const looksLikePlainLocationFallback = (s) => {
            const t = clean(s);
            if (!t) return false;
            if (t.length > 80) return false;
            if (looksLikeDates(t)) return false;
            if (looksLikeEmploymentType(t)) return false;
            if (/compétences|competences|skills/i.test(t)) return false;
            return /^[\p{L}\s,'’.\-]+$/u.test(t);
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
            (getLines(scope).find(looksLikeLocation)
              ? collapseDouble(getLines(scope).find(looksLikeLocation))
              : "");
          const normalizeInfosText = (s) =>
            (s || "")
              .replace(/\u00a0/g, " ")
              .replace(/[ \t]+\n/g, "\n")
              .replace(/[ \t]{2,}/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          const fixSpacedUrls = (t) =>
            t.replace(/\bhttps?:\/\/[^\s)]+/gi, (url) => url.replace(/\s+/g, ""));
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
            const lines = text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            const bullets = lines
              .filter((line) => /^[-•]\s+/.test(line))
              .map((line) => line.replace(/^[-•]\s+/, "").trim())
              .filter(Boolean);
            return bullets.length ? bullets : null;
          };
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
            scope.querySelectorAll("ul li, ol li").forEach((node) => candidates.push(node));

            const raw = candidates.map(extractTextWithBreaks).filter(Boolean).join("\n");
            const description = normalizeDescriptionText(raw);
            if (!description) return { description: null, descriptionBullets: null };

            return { description, descriptionBullets: extractDescriptionBullets(description) };
          };

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
              const k = [e.title, e.company, e.dates, e.location]
                .map((x) => clean(x).toLowerCase())
                .join("||");
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          }

          const buildExpKey = (exp) =>
            [exp?.title, exp?.company, exp?.dates, exp?.location].map((x) => clean(x)).join("||").toLowerCase();
          const enrichDescriptionsFromScopes = (v6Parsed) => {
            if (!Array.isArray(v6Parsed)) return [];
            const descByKey = new Map();
            const enriched = v6Parsed.map((item) => {
              const key = buildExpKey(item);
              let entry = descByKey.get(key);
              if (!entry) {
                let description = null;
                try {
                  if (item?._scope) {
                    description = extractDescriptionFromScope(item._scope, item, { looksLikeDates, clean });
                  }
                } catch (err) {
                  description = null;
                }
                entry = { description };
                descByKey.set(key, entry);
              }
              const hasDesc = !!entry?.description;
              console.log("[FOCALS][DESC] MATCH", {
                title: item?.title || null,
                company: item?.company || null,
                dates: item?.dates || null,
                hasDesc,
                descLen: entry?.description ? entry.description.length : 0,
              });
              return {
                ...item,
                Description: entry?.description || null,
                DescriptionBullets: null,
              };
            });
            const total = enriched.length;
            const withDesc = enriched.filter((item) => item.Description).length;
            console.log("[FOCALS][DESC] SUMMARY", { total, withDesc });
            return enriched;
          };

          function findExperienceSectionRoot(main) {
            if (!main) return null;
            const heading = Array.from(main.querySelectorAll("h1, h2, h3")).find((el) =>
              /exp[ée]rience/i.test(clean(el.textContent))
            );
            if (!heading) return null;
            return heading.closest("section");
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
            return enriched.map((x) => ({
              Titre: x.title,
              Entreprise: x.company,
              Dates: x.dates,
              Lieu: x.location || null,
              Description: x.Description || null,
              DescriptionBullets: x.DescriptionBullets || null,
            }));
          }

          const main =
            document.querySelector('main[role="main"]') ||
            document.querySelector("main") ||
            document.querySelector('[role="main"]') ||
            document.body;
          const expRoot = findExperienceSectionRoot(main) || main;
          return parseExperiencesWithV6(expRoot);
        },
      });
      const payload = Array.isArray(results) ? results?.[0]?.result : null;
      const experiences = Array.isArray(payload?.experiences)
        ? payload.experiences
        : Array.isArray(payload)
          ? payload
          : [];
      console.log("[FOCALS][DETAILS] DESC_COUNT", {
        count: experiences.filter((e) => e?.Description).length,
      });
      const experienceCount = experiences?.length || 0;
      detailsLog("SCRAPED_COUNT", { profileKey, count: experienceCount });
      expLog("DETAILS_SCRAPED", { count: experienceCount, detailsUrl, profileKey });
      if (!experienceCount) {
        expLog("DETAILS_EMPTY", { detailsUrl, profileKey });
      } else {
        await setDetailsCache(profileKey, experiences);
      }
      expLog("DETAILS_SCRAPE_RESULT", {
        count: experienceCount,
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
    case "FOCALS_UPSERT_INTERACTIONS": {
      const payload = message?.payload;
      if (!Array.isArray(payload) || !payload.length) {
        sendResponse({ ok: false, error: "Missing interactions payload" });
        return false;
      }

      (async () => {
        try {
          let session = null;
          const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
          session = sessionData?.session || null;

          if (!session) {
            const stored = await new Promise((resolve) => {
              chrome.storage.local.get(
                ["focals_supabase_session", "focals_supabase_token"],
                (res) => resolve(res)
              );
            });
            session = stored?.focals_supabase_session || null;
            if (!session && stored?.focals_supabase_token) {
              session = { access_token: stored.focals_supabase_token, user: null };
            }
          }

          if (sessionError || !session || !session.user?.id) {
            console.warn("[Focals] Session absente pour upsert interactions.");
          }

          const hasLinkedinUrn = payload.some((item) => item?.linkedin_message_urn);
          const sourceLabel = hasLinkedinUrn ? "💾 Source: Voyager" : "👁️ Source: DOM";
          console.log(sourceLabel);

          const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
          const SUPABASE_ANON_KEY =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYXdjZWtuc2VkeGFlanBleWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4MTUzMTUsImV4cCI6MjA3NDM5MTMxNX0.G3XH8afOmaYh2PGttY3CVRwi0JIzIvsTKIeeynpKpKI";

          const response = await fetch(
            `${SUPABASE_URL}/functions/v1/focals-upsert-interactions`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                apikey: SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({
                interactions: payload,
                user_id: session?.user?.id || null,
              }),
            }
          );

          if (!response.ok) {
            const errorText = await response.text();
            console.error("❌ [Focals] Supabase Error:", errorText || response.status);
            sendResponse({ ok: false, error: errorText || "UPSERT_FAILED" });
            return;
          }

          console.log("✅ [Focals] Message synchronisé avec succès !");
          sendResponse({ ok: true, count: payload.length });
        } catch (err) {
          console.error("❌ [Focals] Supabase Error:", err?.message || err);
          sendResponse({ ok: false, error: err?.message || "UPSERT_FAILED" });
        }
      })();

      return true;
    }
    case "FOCALS_VOYAGER_CONVERSATIONS": {
      const payload = message?.payload;
      if (!payload || typeof payload !== "object") {
        sendResponse({ ok: false, error: "Missing voyager payload" });
        return false;
      }

      const elements = Array.isArray(payload?.elements) ? payload.elements : [];
      const records = elements
        .map((item) => {
          const externalId = item?.entityUrn || null;
          const participant = item?.participants?.[0]?.messagingMember || null;
          const contactName = participant?.miniProfile?.firstName || null;
          const lastMessage = item?.events?.[0]?.eventContent?.attributedBody?.text || null;
          if (!externalId) return null;
          return {
            external_id: externalId,
            contact_name: contactName,
            last_message: lastMessage,
            source: "linkedin_voyager",
            synced_at: new Date().toISOString(),
            sync_reason: "intercepted",
          };
        })
        .filter(Boolean);

      if (!records.length) {
        sendResponse({ ok: true, count: 0 });
        return false;
      }

      supabase
        .from("interactions")
        .upsert(records, { onConflict: "external_id" })
        .then(({ error }) => {
          if (error) {
            console.error("[SaaS-Debug] Supabase upsert failed:", error?.message || error);
            sendResponse({ ok: false, error: error?.message || "UPSERT_FAILED" });
            return;
          }
          sendResponse({ ok: true, count: records.length });
        })
        .catch((err) => {
          console.error("[SaaS-Debug] Supabase upsert error:", err?.message || err);
          sendResponse({ ok: false, error: err?.message || "UPSERT_FAILED" });
        });

      return true;
    }
    case "SYNC_LINKEDIN_MESSAGE": {
      const payload = message?.payload;
      if (!payload?.message_id) {
        sendResponse({ ok: false, error: "Missing message_id" });
        return false;
      }

      const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
      const SUPABASE_ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYXdjZWtuc2VkeGFlanBleWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4MTUzMTUsImV4cCI6MjA3NDM5MTMxNX0.G3XH8afOmaYh2PGttY3CVRwi0JIzIvsTKIeeynpKpKI";

      fetch(`${SUPABASE_URL}/rest/v1/linkedin_messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(payload),
      })
        .then(async (response) => {
          if (!response.ok) {
            const errorText = await response.text();
            sendResponse({ ok: false, error: errorText || "SUPABASE_FAILED" });
            return;
          }
          sendResponse({ ok: true });
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message || "SUPABASE_FAILED" });
        });

      return true;
    }
    case "NEW_LIVE_MESSAGE": {
      const payload = message?.data || null;
      if (!payload) {
        sendResponse({ ok: false, error: "Missing live message payload" });
        return false;
      }

      console.log("🎯 [RADAR] Incoming live relay :", payload?.text);
      relayLiveMessageToSupabase(payload)
        .then((result) => {
          console.log("🎯 [RADAR] Live message synced to Supabase");
          sendResponse(result);
        })
        .catch((err) => {
          console.error("🎯 [RADAR] Live relay failed", err?.message || err);
          sendResponse({ ok: false, error: err?.message || "Relay failed" });
        });
      return true;
    }
    case "FOCALS_INCOMING_RELAY": {
      const payload = message?.payload || null;
      if (!payload) {
        sendResponse({ ok: false, error: "Missing incoming relay payload" });
        return false;
      }

      console.log("🎯 [RADAR] Incoming network/dom relay :", payload?.text);
      relayLiveMessageToSupabase(payload)
        .then((result) => {
          console.log("🎯 [RADAR] Incoming message synced to Supabase");
          sendResponse(result);
        })
        .catch((err) => {
          console.error("🎯 [RADAR] Incoming relay failed", err?.message || err);
          sendResponse({ ok: false, error: err?.message || "Relay failed" });
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
      const { detailsUrl, profileKey, reason } = message || {};
      if (!detailsUrl) {
        sendResponse({ ok: false, error: "Missing detailsUrl" });
        return false;
      }

      scrapeExperienceDetailsInBackground(detailsUrl, profileKey, reason)
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
