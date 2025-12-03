import supabase from "./supabase-client.js";
import { API_BASE_URL, IS_DEV } from "./src/api/config.js";

const FOCALS_DEBUG = IS_DEV;

function debugLog(stage, details) {
  if (!FOCALS_DEBUG) return;
  try {
    if (typeof details === "string") {
      console.log(`[Focals][${stage}]`, details);
    } else {
      console.log(`[Focals][${stage}]`, JSON.stringify(details, null, 2));
    }
  } catch (e) {
    console.log(`[Focals][${stage}]`, details);
  }
}

const buildApiUrl = (endpoint = "") => {
  if (!endpoint) return API_BASE_URL;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const normalizedBase = API_BASE_URL.replace(/\/?$/, "");
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${normalizedEndpoint}`;
};

async function fetchApi({ endpoint, method = "GET", params, body, headers = {} }) {
  const url = new URL(buildApiUrl(endpoint));

  if (method === "GET" && params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
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
    throw new Error("Utilisateur non authentifié — connecte-toi sur l'app web.");
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
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || "API request failed" }));

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
            mode,
            conversation,
            toneOverride,
            promptReply,
            jobId,
            templateId,
          } = message;

          const stored = await chrome.storage.local.get(["focals_user_id"]);
          const userIdFromStorage = stored.focals_user_id;
          const userId = userIdFromMessage || userIdFromStorage;

          if (!userId) {
            console.error("[Focals][BG] Missing userId for GENERATE_REPLY");
            sendResponse({ success: false, error: "Missing userId" });
            return;
          }
          if (!mode) {
            sendResponse({ success: false, error: "mode manquant" });
            return;
          }
          const conversationMessages =
            conversation?.messages || (Array.isArray(conversation) ? conversation : []);

          if (!conversationMessages.length) {
            console.warn("[Focals][BG] Empty conversation in GENERATE_REPLY", { mode });
            sendResponse({ success: false, error: "Empty conversation" });
            return;
          }

          if (mode === "prompt_reply" && (!promptReply || promptReply.trim() === "")) {
            sendResponse({ success: false, error: "promptReply requis pour mode prompt_reply" });
            return;
          }

          const payload = {
            userId,
            mode,
            conversation: conversationMessages,
            toneOverride,
            jobId,
            templateId,
          };

          if (mode === "prompt_reply" && promptReply && promptReply.trim().length > 0) {
            payload.promptReply = promptReply.trim();
          }

          console.log("[Focals][BG] Calling focals-generate-reply with payload", {
            ...payload,
            conversationLength: conversationMessages.length,
            hasPromptReply: !!payload.promptReply,
          });

          const response = await fetch(
            "https://ppawceknsedxaejpeylu.supabase.co/functions/v1/focals-generate-reply",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            }
          );

          if (!response.ok) {
            const errorText = await response.text().catch(() => null);
            console.error("[Focals][BG] focals-generate-reply failed", {
              status: response.status,
              errorText,
            });
            sendResponse({ success: false, error: "focals-generate-reply failed" });
            return;
          }

          const data = await response.json();
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
