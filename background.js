import supabase from "./supabase-client.js";
import { API_BASE_URL, IS_DEV } from "./src/api/config.js";
import { createLogger } from "./src/utils/logger.js";

const logger = createLogger("Background");
const FOCALS_DEBUG = IS_DEV;

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

const promisify = (target, method, ...args) =>
  new Promise((resolve, reject) => {
    try {
      target[method](...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || String(error)));
          return;
        }
        resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const randomBetween = (min, max) => {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
};

async function waitForComplete(tabId, timeoutMs = 45000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const tab = await promisify(chrome.tabs, "get", tabId);
    if (!tab) {
      throw new Error("Onglet introuvable");
    }
    if (tab.status === "complete") return tab;
    await wait(300);
  }

  throw new Error("Timeout lors du chargement de l'onglet");
}

async function ensureContentScript(tabId) {
  try {
    await promisify(chrome.tabs, "sendMessage", tabId, { action: "PING" });
    return true;
  } catch (error) {
    console.warn("[Focals] Injection content script requise", error?.message || error);
  }

  try {
    await promisify(chrome.scripting, "executeScript", {
      target: { tabId },
      files: ["src/content/linkedinSduiScraper.js", "content-main.js", "content-messaging.js"],
    });
    return true;
  } catch (error) {
    console.error("[Focals] Impossible d'injecter le content script", error);
    return false;
  }
}

async function getSupabaseSession() {
  try {
    const stored = await promisify(chrome.storage.local, "get", "focals_supabase_session");
    return stored?.focals_supabase_session || null;
  } catch (error) {
    console.warn("[Focals] Impossible de récupérer la session Supabase", error?.message || error);
    return null;
  }
}

async function scrapeLinkedinProfile(linkedinUrl) {
  let tabId;

  try {
    const tab = await promisify(chrome.tabs, "create", { url: linkedinUrl, active: false });
    tabId = tab?.id;

    if (!tabId) {
      throw new Error("Impossible d'ouvrir l'onglet");
    }

    await waitForComplete(tabId);
    await wait(randomBetween(2000, 3500));
    await ensureContentScript(tabId);

    const profileData = await promisify(chrome.tabs, "sendMessage", tabId, {
      type: "GET_CANDIDATE_DATA",
    });

    if (!profileData || profileData.error) {
      throw new Error(profileData?.error || "Échec du scraping");
    }

    return profileData;
  } finally {
    if (tabId) {
      try {
        await promisify(chrome.tabs, "remove", tabId);
      } catch (closeError) {
        console.warn("[Focals] Impossible de fermer l'onglet temporaire", closeError);
      }
    }
  }
}

async function saveEngineerProfile(profile, { source = "extension-update" } = {}) {
  if (!profile) {
    throw new Error("Profil manquant pour l'envoi Supabase");
  }

  const session = await getSupabaseSession();

  const response = await fetch(
    "https://ppawceknsedxaejpeylu.supabase.co/functions/v1/save-engineer",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token || ""}`,
      },
      body: JSON.stringify({
        userId: session?.user?.id || "extension-anon",
        profile,
        exportedAt: new Date().toISOString(),
        source,
      }),
    }
  );

  const data = await response.json();
  return { ok: response.ok, data };
}

async function scrapeProfile(linkedinUrl) {
  if (!linkedinUrl) {
    throw new Error("linkedinUrl manquant");
  }

  console.log("[Focals][BG] External scrape request", { linkedinUrl });
}

async function scrapeProfilesBatch(linkedinUrls = []) {
  if (!Array.isArray(linkedinUrls) || !linkedinUrls.length) {
    throw new Error("Aucune URL LinkedIn fournie pour le batch");
  }

  for (const url of linkedinUrls) {
    await scrapeProfile(url);
  }
}

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCRAPE_PROFILE") {
    console.log("[Focals] Requête interne SCRAPE_PROFILE:", message.linkedinUrl);

    (async () => {
      try {
        const { linkedinUrl } = message || {};

        if (!linkedinUrl) {
          sendResponse({ success: false, error: "URL LinkedIn manquante" });
          return;
        }

        const profileData = await scrapeLinkedinProfile(linkedinUrl);
        const payload = {
          ...profileData,
          linkedinProfileUrl: profileData.linkedinProfileUrl || linkedinUrl,
          linkedin_url: profileData.linkedin_url || linkedinUrl,
        };

        const result = await saveEngineerProfile(payload, { source: "extension-scrape" });

        if (!result.ok) {
          sendResponse({ success: false, error: result.data?.error || "Erreur Supabase" });
          return;
        }

        sendResponse({ success: true, profile: result.data });
      } catch (error) {
        console.error("[Focals] Erreur interne SCRAPE_PROFILE:", error);
        sendResponse({ success: false, error: error?.message || "Erreur lors du scraping" });
      }
    })();

    return true;
  }

  if (message?.type === "SCRAPE_PROFILES_BATCH") {
    console.log(
      "[Focals] Requête interne SCRAPE_PROFILES_BATCH:",
      message.linkedinUrls?.length,
      "profils"
    );

    (async () => {
      try {
        const { linkedinUrls } = message || {};

        if (!linkedinUrls || !Array.isArray(linkedinUrls) || linkedinUrls.length === 0) {
          sendResponse({ success: false, error: "Liste d'URLs vide" });
          return;
        }

        sendResponse({ success: true, message: `Scraping de ${linkedinUrls.length} profils en cours...` });

        for (const linkedinUrl of linkedinUrls) {
          try {
            const profileData = await scrapeLinkedinProfile(linkedinUrl);

            if (profileData && !profileData.error) {
              const result = await saveEngineerProfile(
                {
                  ...profileData,
                  linkedinProfileUrl: profileData.linkedinProfileUrl || linkedinUrl,
                  linkedin_url: profileData.linkedin_url || linkedinUrl,
                },
                { source: "extension-scrape-batch" }
              );

              if (!result.ok) {
                console.error("[Focals] Erreur Supabase pour:", linkedinUrl, result.data?.error);
              }
            }
          } catch (profileError) {
            console.error("[Focals] Erreur pour profil:", linkedinUrl, profileError);
          }

          await wait(randomBetween(2000, 4000));
        }
      } catch (error) {
        console.error("[Focals] Erreur SCRAPE_PROFILES_BATCH:", error);
      }
    })();

    return true;
  }

  return false;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // ========================================
  // Handler SCRAPE_PROFILE - Mise à jour d'un seul profil
  // ========================================
  if (message?.type === "SCRAPE_PROFILE") {
    console.log("[Focals] Requête SCRAPE_PROFILE:", message.linkedinUrl);

    (async () => {
      try {
        const { linkedinUrl } = message || {};

        if (!linkedinUrl) {
          sendResponse({ success: false, error: "URL LinkedIn manquante" });
          return;
        }

        const profileData = await scrapeLinkedinProfile(linkedinUrl);
        const payload = {
          ...profileData,
          linkedinProfileUrl: profileData.linkedinProfileUrl || linkedinUrl,
          linkedin_url: profileData.linkedin_url || linkedinUrl,
        };

        const result = await saveEngineerProfile(payload, { source: "extension-update" });

        if (!result.ok) {
          sendResponse({ success: false, error: result.data?.error || "Erreur Supabase" });
          return;
        }

        console.log("[Focals] Profil mis à jour:", linkedinUrl);
        sendResponse({ success: true, profile: result.data });
      } catch (error) {
        console.error("[Focals] Erreur SCRAPE_PROFILE:", error);
        sendResponse({ success: false, error: error?.message || "Erreur lors du scraping" });
      }
    })();

    return true; // Keep channel open for async response
  }

  // ========================================
  // Handler SCRAPE_PROFILES_BATCH - Mise à jour de plusieurs profils
  // ========================================
  if (message?.type === "SCRAPE_PROFILES_BATCH") {
    console.log("[Focals] Requête SCRAPE_PROFILES_BATCH:", message.linkedinUrls?.length, "profils");

    (async () => {
      try {
        const { linkedinUrls } = message || {};

        if (!linkedinUrls || !Array.isArray(linkedinUrls) || linkedinUrls.length === 0) {
          sendResponse({ success: false, error: "Liste d'URLs vide" });
          return;
        }

        sendResponse({ success: true, status: "started", total: linkedinUrls.length });

        let successCount = 0;
        let errorCount = 0;

        for (const linkedinUrl of linkedinUrls) {
          try {
            console.log("[Focals] Scraping:", linkedinUrl);

            const profileData = await scrapeLinkedinProfile(linkedinUrl);

            if (profileData && !profileData.error) {
              const result = await saveEngineerProfile(
                {
                  ...profileData,
                  linkedinProfileUrl: profileData.linkedinProfileUrl || linkedinUrl,
                  linkedin_url: profileData.linkedin_url || linkedinUrl,
                },
                { source: "extension-update" }
              );

              if (result.ok) {
                successCount++;
                console.log("[Focals] Profil mis à jour:", linkedinUrl);
              } else {
                errorCount++;
                console.error("[Focals] Erreur Supabase pour:", linkedinUrl);
              }
            } else {
              errorCount++;
              console.error("[Focals] Échec scraping pour:", linkedinUrl);
            }

            await wait(randomBetween(2000, 4000));
          } catch (profileError) {
            errorCount++;
            console.error("[Focals] Erreur pour profil:", linkedinUrl, profileError);
          }
        }

        console.log("[Focals] Batch terminé:", successCount, "succès,", errorCount, "erreurs");
      } catch (error) {
        console.error("[Focals] Erreur SCRAPE_PROFILES_BATCH:", error);
      }
    })();

    return true; // Keep channel open for async response
  }

  return false;
});
