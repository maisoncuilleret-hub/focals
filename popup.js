import * as apiModule from "./src/api/focalsApi.js";
import { getOrCreateUserId, getUserIdCached } from "./src/focalsUserId.js";

const FOCALS_DEBUG = true;

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

  const STORAGE_KEYS = {
    tone: "focals_defaultTone",
    systemPromptOverride: "focals_systemPromptOverride",
  };

  const DEFAULT_TONE = "professional";

  function isLinkedinRecruiterContext(url = "") {
    if (!url) return false;
    const normalized = url.toLowerCase();
    return (
      /linkedin\.com\/talent\/hire\//.test(normalized) ||
      /linkedin\.com\/talent\/profile\//.test(normalized) ||
      /linkedin\.com\/recruiter\//.test(normalized)
    );
  }

  function isLinkedinProfileContext(url = "") {
    if (!url) return false;
    if (/linkedin\.com\/in\//i.test(url)) return true;
    return isLinkedinRecruiterContext(url);
  }

function withStorage(area = "sync") {
  return {
    async get(keys, defaults = {}) {
      return new Promise((resolve) => {
        try {
          chrome.storage[area].get(keys, (result) => resolve({ ...defaults, ...(result || {}) }));
        } catch (err) {
          debugLog("STORAGE_ERROR", err?.message || String(err));
          resolve({ ...defaults });
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
  };
}

const syncStore = withStorage("sync");

let state = {
  userId: null,
  tone: DEFAULT_TONE,
  systemPromptOverride: "",
  loading: false,
  profile: null,
  profileStatus: "idle",
  profileStatusMessage: "",
  activeTab: "profile",
  supabaseSession: null,
};

function setStatus(message) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = message || "";
  }
}

function setLoading(isLoading, message = "") {
  state.loading = isLoading;
  setStatus(isLoading ? message : "");
}

async function ensureProfileScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/linkedinScraper.js", "content-main.js"],
    });
    debugLog("POPUP_SCRIPT_INJECT", { tabId });
    return true;
  } catch (err) {
    console.warn("[Focals][POPUP] Unable to inject content scripts", err);
    return false;
  }
}

function requestProfileFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "FOCALS_GET_PROFILE" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError });
        return;
      }
      resolve({ response });
    });
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  const profileView = document.getElementById("profileView");
  const settingsView = document.getElementById("settingsView");
  const tabProfile = document.getElementById("tabProfile");
  const tabSettings = document.getElementById("tabSettings");
  if (profileView && settingsView) {
    profileView.style.display = tab === "profile" ? "block" : "none";
    settingsView.style.display = tab === "settings" ? "block" : "none";
  }
  if (tabProfile && tabSettings) {
    tabProfile.classList.toggle("active", tab === "profile");
    tabSettings.classList.toggle("active", tab === "settings");
  }
}

function setupTabs() {
  const tabProfile = document.getElementById("tabProfile");
  const tabSettings = document.getElementById("tabSettings");
  if (tabProfile) tabProfile.addEventListener("click", () => switchTab("profile"));
  if (tabSettings) tabSettings.addEventListener("click", () => switchTab("settings"));
  switchTab(state.activeTab);
}

function renderTone() {
  const select = document.getElementById("toneSelect");
  if (!select) return;
  select.value = state.tone || DEFAULT_TONE;
}

function renderProfileCard(profile) {
  const card = document.getElementById("profileCard");
  const status = document.getElementById("profileStatus");
  if (status) status.textContent = "";
  if (!card) return;
  card.innerHTML = "";

  if (state.profileStatus === "loading") {
    const info = document.createElement("div");
    info.className = "profile-info";
    const title = document.createElement("div");
    title.className = "profile-name";
    title.textContent = "Analyse du profil en cours...";
    const subtitle = document.createElement("div");
    subtitle.className = "profile-sub muted";
    subtitle.textContent = "Patientez quelques secondes pendant le chargement de LinkedIn.";
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);
    if (status) status.textContent = "";
    return;
  }

  if (state.profileStatus === "unsupported") {
    const info = document.createElement("div");
    info.className = "profile-info";
    const title = document.createElement("div");
    title.className = "profile-name";
    title.textContent = "Page Recruiter non supportée";
    const subtitle = document.createElement("div");
    subtitle.className = "profile-sub muted";
    subtitle.textContent =
      state.profileStatusMessage || "Cette page LinkedIn Recruiter n’est pas encore supportée pour l’aperçu de profil.";
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);
    if (status) status.textContent = state.profileStatusMessage || "";
    return;
  }

  if (!profile || state.profileStatus === "error") {
    const info = document.createElement("div");
    info.className = "profile-info";
    const title = document.createElement("div");
    title.className = "profile-name";
    title.textContent = "Aucun profil détecté";
    const subtitle = document.createElement("div");
    subtitle.className = "profile-sub muted";
    subtitle.textContent =
      state.profileStatusMessage ||
      "La page LinkedIn est peut-être encore en train de charger, réessayez dans quelques secondes.";
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);
    if (status && state.profileStatus === "error") {
      status.textContent =
        state.profileStatusMessage ||
        "Aucun profil détecté (la page LinkedIn est peut-être encore en train de charger, réessayez dans quelques secondes).";
    }
    return;
  }

  if (profile.photo_url) {
    const avatar = document.createElement("img");
    avatar.src = profile.photo_url;
    avatar.alt = profile.name || "Profil";
    avatar.className = "avatar";
    card.appendChild(avatar);
  }

  const info = document.createElement("div");
  info.className = "profile-info";
  const title = document.createElement("div");
  title.className = "profile-name";
  title.textContent = profile.name || "Profil LinkedIn";
  const subtitle = document.createElement("div");
  subtitle.className = "profile-sub";
  subtitle.textContent = profile.headline || profile.current_title || "";
  const meta = document.createElement("div");
  meta.className = "profile-meta";
  meta.textContent = `${profile.current_company || ""} · ${profile.localisation || ""}`;
  const linkRow = document.createElement("div");
  linkRow.className = "profile-meta";
  const link = document.createElement("a");
  link.href = profile.linkedin_url || "#";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.style.color = "#60a5fa";
  link.textContent = "Ouvrir sur LinkedIn";
  linkRow.appendChild(link);
  info.appendChild(title);
  info.appendChild(subtitle);
  info.appendChild(meta);
  info.appendChild(linkRow);
  card.appendChild(info);

  const chips = document.createElement("div");
  chips.className = "profile-meta";
  const contractChip = document.createElement("span");
  contractChip.className = "pill-inline";
  contractChip.textContent = profile.contract || "—";
  chips.appendChild(contractChip);
  if (profile.firstName) {
    const firstChip = document.createElement("span");
    firstChip.className = "pill-inline";
    firstChip.textContent = profile.firstName;
    chips.appendChild(firstChip);
  }
  info.appendChild(chips);
}

function renderSystemPrompt() {
  const textarea = document.getElementById("systemPrompt");
  if (!textarea) return;
  textarea.value = state.systemPromptOverride || "";
}

async function loadState() {
  try {
    setLoading(true, "Chargement...");
    const storedValues = await syncStore.get([
      STORAGE_KEYS.systemPromptOverride,
      STORAGE_KEYS.tone,
    ]);
    const userId = await getOrCreateUserId();
    state.userId = userId;
    const data = await apiModule.bootstrapUser(userId);
    state.tone = data.settings?.default_tone || storedValues[STORAGE_KEYS.tone] || DEFAULT_TONE;
    state.settings = data.settings;
    state.systemPromptOverride =
      data.settings?.system_prompt_override || storedValues[STORAGE_KEYS.systemPromptOverride] || "";
    renderTone();
    renderSystemPrompt();
    await syncStore.set({
      [STORAGE_KEYS.tone]: state.tone,
      [STORAGE_KEYS.systemPromptOverride]: state.systemPromptOverride,
    });
  } catch (err) {
    console.error(err);
    alert(`Erreur Focals : ${err?.message || "Impossible de charger les données."}`);
  } finally {
    setLoading(false);
  }
}

async function refreshProfileFromTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs?.[0];
    if (isLinkedinRecruiterContext(activeTab?.url)) {
      debugLog("POPUP_CONTEXT", { context: "recruiter", url: activeTab.url });
    }
    if (!activeTab?.id || !activeTab.url || !isLinkedinProfileContext(activeTab.url)) {
      state.profile = null;
      state.profileStatus = "error";
      state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
      renderProfileCard(null);
      return;
    }
    state.profileStatusMessage = "";
    debugLog("POPUP_PROFILE_REQUEST", { tabId: activeTab.id, url: activeTab.url });
    const { response: initialResponse, error: initialError } = await requestProfileFromTab(activeTab.id);

    let response = initialResponse;
    let requestError = initialError;

    const needsInjection =
      requestError && /Receiving end does not exist/i.test(requestError?.message || requestError?.toString() || "");

    if (needsInjection) {
      debugLog("POPUP_PROFILE_RETRY", { tabId: activeTab.id, reason: requestError?.message });
      const injected = await ensureProfileScripts(activeTab.id);
      if (injected) {
        const retry = await requestProfileFromTab(activeTab.id);
        response = retry.response;
        requestError = retry.error;
      }
    }

    const isPublicProfileUrl = /linkedin\.com\/in\//i.test(activeTab.url || "");

    if (!requestError && response?.status === "unsupported" && isPublicProfileUrl) {
      debugLog("POPUP_PROFILE_UNSUPPORTED_FALLBACK", { tabId: activeTab.id, url: activeTab.url });
      const rescrapeTriggered = await new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, { type: "FOCALS_FORCE_RESCRAPE" }, () => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(true);
        });
      });

      if (rescrapeTriggered) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const retry = await requestProfileFromTab(activeTab.id);
        response = retry.response;
        requestError = retry.error;
      }
    }

    if (requestError) {
      console.warn("[Focals][POPUP] No profile data:", requestError.message || String(requestError));
      state.profile = null;
      state.profileStatus = "error";
      state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
    } else if (!response) {
      debugLog("POPUP_PROFILE_NO_RESPONSE", { tabId: activeTab.id });
      state.profile = null;
      state.profileStatus = "error";
      state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
    } else {
      if (response.status === "unsupported") {
        state.profile = null;
        state.profileStatus = "unsupported";
        state.profileStatusMessage =
          response.message || "Cette page LinkedIn Recruiter n’est pas encore supportée pour l’aperçu de profil.";
      } else {
        state.profile = response?.profile || null;
        state.profileStatus = response?.status || (state.profile ? "ready" : "error");
        if (response?.message) state.profileStatusMessage = response.message;
        if (state.profileStatus === "ready") state.profileStatusMessage = "";
        if (state.profileStatus === "error" && !state.profileStatusMessage) {
          state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
        }
      }
    }

    renderProfileCard(state.profile);
  } catch (err) {
    console.error("[Focals][POPUP] Profil indisponible", err);
    state.profile = null;
    state.profileStatus = "error";
    state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
    renderProfileCard(null);
  }
}

async function loadSupabaseSession() {
  try {
    const result = await chrome.storage.local.get("focals_supabase_session");
    state.supabaseSession = result?.focals_supabase_session || null;
    debugLog("SUPABASE_SESSION_LOADED", {
      hasAccessToken: !!state.supabaseSession?.access_token,
      hasUser: !!state.supabaseSession?.user,
    });
  } catch (err) {
    console.error("[Focals][POPUP] Impossible de charger la session Supabase", err);
  }
}

async function forceRescrapeProfile() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs?.[0];
    if (!activeTab?.id || !activeTab.url || !isLinkedinProfileContext(activeTab.url)) {
      state.profile = null;
      state.profileStatus = "error";
      state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
      renderProfileCard(null);
      return;
    }
    state.profileStatus = "loading";
    renderProfileCard(state.profile);
    chrome.tabs.sendMessage(activeTab.id, { type: "FOCALS_FORCE_RESCRAPE" }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Focals][POPUP] Force rescrape error:", chrome.runtime.lastError.message);
        state.profileStatus = "error";
        state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
        renderProfileCard(null);
        return;
      }
      setTimeout(() => refreshProfileFromTab(), 200);
    });
  } catch (err) {
    console.error("[Focals][POPUP] Force rescrape failed", err);
    state.profileStatus = "error";
    state.profileStatusMessage = "Cette page LinkedIn n’est pas encore supportée par Focals.";
    renderProfileCard(null);
  }
}

async function handleAssociateProfile() {
  const status = document.getElementById("profileStatus");
  if (!state.profile) {
    if (status) status.textContent = "Aucun profil LinkedIn détecté.";
    return;
  }
  if (!state.supabaseSession?.access_token) {
    if (status) status.textContent = "Utilisateur non authentifié — connecte-toi sur l'app web.";
    return;
  }
  const userId = state.userId || (await getOrCreateUserId());
  try {
    if (status) status.textContent = "Association en cours...";
    const payload = { ...state.profile, userId };
    debugLog("PROFILE_ASSOCIATE", payload);
    const res = await apiModule.associateProfile(payload, state.supabaseSession.access_token, userId);
    debugLog("PROFILE_ASSOCIATE_RESPONSE", res || {});
    if (status) status.textContent = "Profil associé avec succès ✅";
  } catch (err) {
    console.error(err);
    if (status)
      status.textContent = err?.message || "Association impossible. Connecte-toi sur l'app web.";
  }
}

function setupProfileActions() {
  const refreshBtn = document.getElementById("refreshProfile");
  const associateBtn = document.getElementById("associateProfile");
  if (refreshBtn) refreshBtn.addEventListener("click", () => forceRescrapeProfile());
  if (associateBtn) associateBtn.addEventListener("click", () => handleAssociateProfile());
}

function setupTone() {
  const select = document.getElementById("toneSelect");
  if (!select) return;
  select.addEventListener("change", async (e) => {
    const tone = e.target.value || DEFAULT_TONE;
    state.tone = tone;
    if (!state.userId) return;
    try {
      setLoading(true, "Mise à jour du ton...");
      const settings = await apiModule.upsertSettings(state.userId, { default_tone: tone });
      state.settings = settings;
      await syncStore.set({ [STORAGE_KEYS.tone]: tone });
      setStatus("Ton mis à jour");
    } catch (err) {
      console.error(err);
      alert(`Erreur Focals : ${err?.message || "Une erreur est survenue."}`);
    } finally {
      setLoading(false);
    }
  });
}

function setupSystemPrompt() {
  const textarea = document.getElementById("systemPrompt");
  const saveBtn = document.getElementById("saveSystemPrompt");
  if (!textarea || !saveBtn) return;

  textarea.addEventListener("input", () => {
    state.systemPromptOverride = textarea.value || "";
  });

  saveBtn.addEventListener("click", async () => {
    if (!state.userId) return;
    const value = (textarea.value || "").trim();
    try {
      setLoading(true, "Enregistrement des règles...");
      const settings = await apiModule.upsertSettings(state.userId, {
        system_prompt_override: value,
      });
      state.systemPromptOverride = settings.system_prompt_override || value;
      state.settings = settings;
      await syncStore.set({ [STORAGE_KEYS.systemPromptOverride]: value });
      setStatus("Règles personnalisées enregistrées");
    } catch (err) {
      console.error(err);
      alert(`Erreur Focals : ${err?.message || "Impossible d'enregistrer."}`);
    } finally {
      setLoading(false);
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await loadState();
  setupTone();
  setupSystemPrompt();
  setupTabs();
  setupProfileActions();
  await refreshProfileFromTab();
  await loadSupabaseSession();
  debugLog("POPUP_READY", state);
});
