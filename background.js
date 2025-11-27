import supabase from "./supabase-client.js";

const WEBAPP_EXTENSION_ID = "kekhkaclmlnmijnpekcpppnnoooodaca";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const SUPABASE_AUTH_KEY = "sb-ppawceknsedxaejpeylu-auth-token";
const pipelinePorts = new Set();
const pipelineState = {
  active: null,
  lastResult: null,
};

// Cache des profils pour matching rapide
let profilesCache = [];
let lastCacheRefresh = 0;
const CACHE_TTL_MS = 60000; // Rafraîchir le cache toutes les minutes

const broadcastPipeline = (message) => {
  for (const port of pipelinePorts) {
    try {
      port.postMessage(message);
    } catch (err) {
      console.warn("[Focals] pipeline port broadcast failed", err);
    }
  }
};

const createRequestId = () => `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function refreshProfilesCache() {
  const now = Date.now();
  if (now - lastCacheRefresh < CACHE_TTL_MS && profilesCache.length > 0) {
    return profilesCache;
  }

  try {
    const { data: userResult } = await supabase.auth.getUser();
    if (!userResult?.user) return [];

    const { data: clientId } = await supabase.rpc("get_user_client_id");
    if (!clientId) return [];

    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("id, name, linkedin_url")
      .eq("client_id", clientId)
      .not("linkedin_url", "is", null);

    if (error) throw error;

    profilesCache = profiles || [];
    lastCacheRefresh = now;
    console.log(`[Focals] Cache profils rafraîchi: ${profilesCache.length} profils`);

    return profilesCache;
  } catch (err) {
    console.error("[Focals] Erreur rafraîchissement cache:", err);
    return profilesCache;
  }
}

function normalizeLinkedInUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^\/]*)/);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function normalizeText(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*-\s*.*$/, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinkedinSlug(url) {
  if (!url) return "";
  const normalizedUrl = normalizeLinkedInUrl(url);
  return normalizedUrl || "";
}

function findMatchingProfile(name, profileUrl) {
  const inputSlug = extractLinkedinSlug(profileUrl);
  if (inputSlug) {
    const matchByUrl = profilesCache.find((p) => {
      const cachedSlug = extractLinkedinSlug(p.linkedin_url);
      return cachedSlug && (inputSlug === cachedSlug || profileUrl.includes(cachedSlug));
    });
    if (matchByUrl) return matchByUrl;
  }

  const normalizedName = normalizeText(name);
  if (normalizedName) {
    const exactMatch = profilesCache.find((p) => normalizeText(p.name) === normalizedName);
    if (exactMatch) return exactMatch;

    const nameParts = normalizedName.split(" ");
    if (nameParts.length >= 2) {
      const partialMatch = profilesCache.find((p) => {
        const profileName = normalizeText(p.name);
        return nameParts.every((part) => profileName.includes(part));
      });
      if (partialMatch) return partialMatch;
    }
  }

  return null;
}

async function saveActivityToSupabase(activity) {
  const { error } = await supabase.from("activities").insert(activity);
  if (error) throw error;
  return true;
}

async function checkRecentReply(profileId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("activities")
    .select("id")
    .eq("profile_id", profileId)
    .eq("type", "linkedin_reply")
    .gte("created_at", oneHourAgo)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

async function handleNewLinkedInMessage(payload, { skipCacheRefresh = false } = {}) {
  const { name, profileUrl, timestamp } = payload || {};

  if (!skipCacheRefresh) {
    await refreshProfilesCache();
  }

  const match = findMatchingProfile(name, profileUrl);

  if (!match) {
    console.log("[Focals] ℹ️ Profil non trouvé:", name || profileUrl || "<inconnu>");
    return { matched: false };
  }

  const duplicate = await checkRecentReply(match.id);
  if (duplicate) {
    console.log("[Focals] ⏭️ Réponse déjà enregistrée récemment");
    return { matched: true, duplicate: true };
  }

  await saveActivityToSupabase({
    profile_id: match.id,
    type: "linkedin_reply",
    content: `Réponse reçue de ${name || match.name}`,
    date: new Date().toISOString().split("T")[0],
    created_at: timestamp || new Date().toISOString(),
  });

  try {
    chrome.runtime.sendMessage(WEBAPP_EXTENSION_ID, {
      type: "LINKEDIN_REPLY_DETECTED",
      profile: match,
    });
  } catch (err) {
    console.warn("[Focals] Impossible de notifier l'app web:", err?.message || err);
  }

  console.log("[Focals] ✅ Réponse LinkedIn enregistrée pour:", match.name);
  return { matched: true, duplicate: false };
}

async function recordLinkedInReply(profile, conversation) {
  try {
    const { error } = await supabase.from("activities").insert({
      profile_id: profile.id,
      type: "linkedin_reply",
      comment: `Message reçu de ${conversation.name}: "${conversation.messageSnippet?.substring(0, 100)}..."`,
    });

    if (error) throw error;

    console.log(`[Focals] ✅ Activité linkedin_reply créée pour ${profile.name}`);

    chrome.notifications.create({
      type: "basic",
      title: "💬 Réponse LinkedIn",
      message: `${conversation.name} vous a répondu !`,
      priority: 2,
    });

    return true;
  } catch (err) {
    console.error("[Focals] Erreur enregistrement réponse:", err);
    return false;
  }
}

async function hydrateSupabaseSession(sessionPayload) {
  console.log("[Focals] 🔄 hydrateSupabaseSession appelée");
  console.log("[Focals] 📥 Payload reçu:", {
    hasAccessToken: !!sessionPayload?.access_token,
    hasRefreshToken: !!sessionPayload?.refresh_token,
    hasUser: !!sessionPayload?.user,
    topLevelKeys: Object.keys(sessionPayload || {}),
  });

  try {
    await chrome.storage.local.set({
      [SUPABASE_AUTH_KEY]: JSON.stringify(sessionPayload),
    });
    console.log("[Focals] ✅ Session sauvegardée dans chrome.storage");

    const access_token = sessionPayload?.access_token;
    const refresh_token = sessionPayload?.refresh_token;

    console.log("[Focals] 🔑 Tokens extraits:", {
      hasAccessToken: !!access_token,
      hasRefreshToken: !!refresh_token,
    });

    if (access_token && refresh_token) {
      await supabase.auth.setSession({ access_token, refresh_token });
      console.log("[Focals] ✅ supabase.auth.setSession() appelé avec succès");
    } else {
      console.warn("[Focals] ⚠️ Tokens manquants, setSession non appelé");
    }

    console.log("[Focals] ✅ Session Supabase synchronisée depuis l'app web");
  } catch (err) {
    console.error("[Focals] ❌ Impossible d'enregistrer la session Supabase", err);
    throw err;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "FOCALS_PING" });
    return;
  } catch (err) {
    console.log("[Focals] injecting content script", err?.message || err);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-main.js"],
    });
    await wait(120);
    await chrome.tabs.sendMessage(tabId, { type: "FOCALS_PING" });
  } catch (err) {
    throw new Error("Impossible d'injecter le script sur cet onglet.");
  }
}

async function startPipelineExport(tabId) {
  if (pipelineState.active) {
    throw new Error("Un export pipeline est déjà en cours.");
  }

  const requestId = createRequestId();
  pipelineState.active = {
    requestId,
    tabId,
    status: "starting",
    progress: 0,
    total: 25,
    stage: "init",
    startedAt: Date.now(),
  };
  broadcastPipeline({ type: "PIPELINE_STATUS", state: pipelineState.active });

  await ensureContentScript(tabId);

  pipelineState.active.status = "running";
  pipelineState.active.stage = "collect";
  broadcastPipeline({ type: "PIPELINE_STATUS", state: pipelineState.active });

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "PIPELINE_EXPORT_START",
      requestId,
      expectedTotal: pipelineState.active.total,
    });
  } catch (err) {
    pipelineState.lastResult = {
      success: false,
      error: err?.message || "Echec du démarrage de l'export pipeline.",
      finishedAt: Date.now(),
    };
    broadcastPipeline({
      type: "PIPELINE_ERROR",
      error: pipelineState.lastResult.error,
    });
    pipelineState.active = null;
    throw err;
  }

  return requestId;
}

function handlePipelineProgress(msg) {
  if (!pipelineState.active || msg.requestId !== pipelineState.active.requestId) {
    return;
  }

  if (typeof msg.total === "number") {
    pipelineState.active.total = msg.total;
  }
  if (typeof msg.completed === "number") {
    pipelineState.active.progress = msg.completed;
  }
  if (msg.stage) {
    pipelineState.active.stage = msg.stage;
  }

  broadcastPipeline({
    type: "PIPELINE_EXPORT_PROGRESS",
    state: { ...pipelineState.active },
  });
}

async function handlePipelineComplete(msg) {
  if (!pipelineState.active || msg.requestId !== pipelineState.active.requestId) {
    return;
  }

  const count = typeof msg.count === "number" ? msg.count : pipelineState.active.total;
  pipelineState.active.progress = count;
  pipelineState.active.status = "complete";
  pipelineState.active.stage = "download";
  broadcastPipeline({ type: "PIPELINE_STATUS", state: pipelineState.active });

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `pipeline-${timestamp}.csv`;
    const csvContent = typeof msg.csv === "string" ? msg.csv : "";

    if (!csvContent) {
      throw new Error("CSV vide reçu depuis le scraper.");
    }

    let downloadSucceeded = false;
    const { tabId } = pipelineState.active;

    if (typeof tabId === "number") {
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: "PIPELINE_DOWNLOAD_CSV",
          filename,
          csv: csvContent,
        });
        if (!response || response.error) {
          throw new Error(response?.error || "Réponse invalide du contenu pour le téléchargement.");
        }
        downloadSucceeded = true;
      } catch (tabErr) {
        console.warn("[Focals] Download via tab failed, fallback to downloads API", tabErr);
      }
    }

    if (!downloadSucceeded) {
      const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`;
      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
    }

    pipelineState.lastResult = {
      success: true,
      count,
      filename,
      finishedAt: Date.now(),
    };

    broadcastPipeline({
      type: "PIPELINE_EXPORT_COMPLETE",
      result: pipelineState.lastResult,
    });
  } catch (err) {
    const error = err?.message || "Impossible de télécharger le CSV";
    pipelineState.lastResult = {
      success: false,
      error,
      finishedAt: Date.now(),
    };
    broadcastPipeline({ type: "PIPELINE_ERROR", error });
  } finally {
    pipelineState.active = null;
  }
}

function handlePipelineError(msg) {
  if (!pipelineState.active || msg.requestId !== pipelineState.active.requestId) {
    return;
  }

  const error = msg.error || "Erreur inconnue pendant l'export pipeline.";
  pipelineState.lastResult = {
    success: false,
    error,
    finishedAt: Date.now(),
  };
  broadcastPipeline({ type: "PIPELINE_ERROR", error });
  pipelineState.active = null;
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pipeline-export") {
    return;
  }

  pipelinePorts.add(port);

  if (pipelineState.active) {
    port.postMessage({ type: "PIPELINE_STATUS", state: pipelineState.active });
  }
  if (pipelineState.lastResult) {
    port.postMessage({ type: "PIPELINE_LAST_RESULT", result: pipelineState.lastResult });
  }

  port.onDisconnect.addListener(() => {
    pipelinePorts.delete(port);
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;

    if (msg.type === "START_PIPELINE_EXPORT") {
      const tabId = msg.tabId;
      if (typeof tabId !== "number") {
        port.postMessage({ type: "PIPELINE_ERROR", error: "Onglet invalide pour l'export." });
        return;
      }
      try {
        await startPipelineExport(tabId);
      } catch (err) {
        port.postMessage({
          type: "PIPELINE_ERROR",
          error: err?.message || "Impossible de démarrer l'export pipeline.",
        });
      }
    } else if (msg.type === "REQUEST_PIPELINE_STATUS") {
      if (pipelineState.active) {
        port.postMessage({ type: "PIPELINE_STATUS", state: pipelineState.active });
      } else if (pipelineState.lastResult) {
        port.postMessage({ type: "PIPELINE_LAST_RESULT", result: pipelineState.lastResult });
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SUPABASE_SESSION" && msg.session) {
    (async () => {
      try {
        await hydrateSupabaseSession(msg.session);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err?.message || "Impossible de stocker la session Supabase" });
      }
    })();
    return true;
  }

  if (msg?.type === "SCRAPE_PUBLIC_PROFILE" && msg.url) {
    (async () => {
      try {
        console.log("[Focals] Opening public profile:", msg.url);
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        await waitForComplete(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_CANDIDATE_DATA" });
        await chrome.tabs.remove(tab.id);
        sendResponse(res || { error: "No response from content script" });
      } catch (e) {
        console.error("[Focals] Error during scrape:", e);
        sendResponse({ error: e?.message || "SCRAPE_PUBLIC_PROFILE failed" });
      }
    })();
    return true;
  }

  if (msg?.type === "SAVE_PROFILE_TO_SUPABASE" && msg.profile) {
    (async () => {
      try {
        const result = await saveProfileToSupabase(msg.profile);
        sendResponse({ success: true, result });
      } catch (err) {
        console.error("[Focals] Supabase save error", err);
        sendResponse({ error: err?.message || "Enregistrement Supabase impossible" });
      }
    })();
    return true;
  }

  if (msg?.type === "RESOLVE_RECRUITER_PUBLIC_URL" && msg.url) {
    (async () => {
      try {
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        await wait(randomBetween(180, 320));
        await waitForComplete(tab.id);
        await wait(randomBetween(160, 260));
        const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PUBLIC_PROFILE_URL" });
        await wait(randomBetween(140, 240));
        await chrome.tabs.remove(tab.id);
        sendResponse({ url: response?.url || "" });
      } catch (err) {
        console.error("[Focals] recruiter public URL error", err);
        sendResponse({ error: err?.message || "Impossible de récupérer l'URL publique." });
      }
    })();
    return true;
  }

  // Gestionnaire CHECK_LINKEDIN_CONNECTION_STATUS
  if (msg?.type === "CHECK_LINKEDIN_CONNECTION_STATUS") {
    console.log("[Focals] Requête vérification statut:", msg.linkedinUrl);

    (async () => {
      try {
        const { linkedinUrl } = msg;

        if (!linkedinUrl) {
          sendResponse({ success: false, error: "URL manquante" });
          return;
        }

        // Ouvrir la page en arrière-plan
        const tab = await chrome.tabs.create({
          url: linkedinUrl,
          active: false,
        });

        // Attendre le chargement
        await wait(3000);

        // Vérifier le statut
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "CHECK_CONNECTION_STATUS_ON_PAGE",
          linkedinUrl,
        });

        // Fermer l'onglet
        await chrome.tabs.remove(tab.id);

        console.log("[Focals] Statut vérifié:", response.status);
        sendResponse({ success: true, status: response.status });
      } catch (error) {
        console.error("[Focals] Erreur:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true; // Keep channel open
  }

  if (msg?.type === "LINKEDIN_NEW_MESSAGES_DETECTED") {
    console.log("[Focals] Nouvelles conversations détectées:", msg.conversations);

    (async () => {
      try {
        await refreshProfilesCache();

        for (const conversation of msg.conversations || []) {
          await handleNewLinkedInMessage(
            {
              name: conversation.name,
              profileUrl: conversation.linkedinUrl,
              timestamp: conversation.detectedAt,
            },
            { skipCacheRefresh: true }
          );
        }

        sendResponse({ success: true });
      } catch (err) {
        console.error("[Focals] Erreur traitement messages:", err);
        sendResponse({ error: err.message });
      }
    })();

    return true;
  }

  if (msg?.type === "NEW_LINKEDIN_MESSAGE") {
    (async () => {
      try {
        await handleNewLinkedInMessage(msg);
        sendResponse({ success: true });
      } catch (err) {
        console.error("[Focals] Erreur gestion nouveau message:", err);
        sendResponse({ error: err?.message || "Traitement message échoué" });
      }
    })();

    return true;
  }

  if (msg?.type === "PIPELINE_EXPORT_PROGRESS") {
    handlePipelineProgress(msg);
  } else if (msg?.type === "PIPELINE_EXPORT_COMPLETE") {
    handlePipelineComplete(msg);
  } else if (msg?.type === "PIPELINE_EXPORT_ERROR") {
    handlePipelineError(msg);
  } else if (msg?.type === "FOCALS_PING_RESPONSE" && pipelineState.active) {
    // ignore — handshake acknowledgement
  }
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type === "FORCE_LINKEDIN_MESSAGE_SCAN") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: "*://www.linkedin.com/messaging/*" });

        if (tabs.length === 0) {
          const tab = await chrome.tabs.create({
            url: "https://www.linkedin.com/messaging/",
            active: false,
          });

          await wait(5000);

          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "FORCE_SCAN_MESSAGES",
          });

          await wait(2000);
          await chrome.tabs.remove(tab.id);

          sendResponse({ success: true, ...response });
        } else {
          const response = await chrome.tabs.sendMessage(tabs[0].id, {
            type: "FORCE_SCAN_MESSAGES",
          });
          sendResponse({ success: true, ...response });
        }
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();

    return true;
  }

  // Gestionnaire pour CHECK_LINKEDIN_CONNECTION_STATUS depuis l'app web
  if (message?.type === "CHECK_LINKEDIN_CONNECTION_STATUS") {
    console.log("[Focals] Requête de vérification statut LinkedIn:", message);

    (async () => {
      try {
        const { linkedinUrl } = message || {};

        if (!linkedinUrl) {
          sendResponse({ success: false, error: "URL LinkedIn manquante" });
          return;
        }

        // Ouvrir la page LinkedIn en arrière-plan
        const tab = await chrome.tabs.create({
          url: linkedinUrl,
          active: false,
        });

        // Attendre que la page se charge
        await wait(3000);

        // Demander au content script de vérifier le statut
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "CHECK_CONNECTION_STATUS_ON_PAGE",
          linkedinUrl,
        });

        // Fermer l'onglet temporaire
        await chrome.tabs.remove(tab.id);

        console.log("[Focals] Statut vérifié:", response);
        sendResponse({
          success: true,
          status: response?.status,
          details: response?.details,
        });
      } catch (error) {
        console.error("[Focals] Erreur vérification statut:", error);
        sendResponse({ success: false, error: error?.message || "Erreur lors de la vérification" });
      }
    })();

    return true; // Keep channel open for async response
  }

  // Handler pour ENVOYER une demande de connexion LinkedIn
  if (message?.type === "SEND_LINKEDIN_CONNECTION") {
    console.log("[Focals] Requête envoi connexion LinkedIn:", message);

    (async () => {
      try {
        const { linkedinUrl, connectionMessage } = message || {};

        if (!linkedinUrl) {
          sendResponse({ success: false, error: "URL LinkedIn manquante" });
          return;
        }

        const tab = await chrome.tabs.create({
          url: linkedinUrl,
          active: false,
        });

        await waitForComplete(tab.id);
        await wait(2500);

        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "SEND_CONNECTION_ON_PAGE",
          message: connectionMessage || "",
        });

        await chrome.tabs.remove(tab.id);

        console.log("[Focals] Résultat envoi connexion:", response);
        sendResponse({
          success: response?.success || false,
          error: response?.error,
        });
      } catch (error) {
        console.error("[Focals] Erreur envoi connexion:", error);
        sendResponse({ success: false, error: error?.message || "Erreur lors de l'envoi" });
      }
    })();

    return true; // Keep channel open for async response
  }
});

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

console.log("[Focals] background service worker initialisé");
