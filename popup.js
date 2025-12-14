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

  function isLinkedinProfileContext(url = "") {
    if (!url) return false;
    return /linkedin\.com\/in\//i.test(url);
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
const localStore = withStorage("local");

function displayProfileData(profile) {
  const nameEl = document.getElementById("profileName");
  const headlineEl = document.getElementById("profileHeadline");
  const companyEl = document.getElementById("currentCompany");
  const statusEl = document.getElementById("profileStatus");

  if (profile && nameEl && headlineEl && companyEl) {
    nameEl.innerText = profile.name || "Profil inconnu";
    headlineEl.innerText = profile.headline || "Pas de titre trouvé";
    companyEl.innerText = profile.current_company || "Pas d'entreprise actuelle";

    if (statusEl) {
      statusEl.innerText = "Dernier scrape V14 réussi : " + new Date().toLocaleTimeString();
    }
  } else if (nameEl && headlineEl && companyEl) {
    nameEl.innerText = "--";
    headlineEl.innerText = "--";
    companyEl.innerText = "--";
    if (statusEl) {
      statusEl.innerText = "Aucun profil chargé. Lancez le scrape.";
    }
  }
}

async function loadProfileDataFromStorage(localStore) {
  const data = await localStore.get("FOCALS_LAST_PROFILE");
  const profile = data ? data.FOCALS_LAST_PROFILE : null;
  state.profile = profile;
  state.profileStatus = profile ? "ready" : "idle";
  displayProfileData(profile);
  renderProfileCard(profile);
}

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
      files: ["src/content/linkedinSduiScraper.js", "content-main.js"],
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
    chrome.tabs.sendMessage(tabId, { action: "SCRAPE_PROFILE" }, (response) => {
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
  const experiencesList = document.getElementById("experiencesList");
  const experiencesMeta = document.getElementById("experiencesMeta");
  const educationList = document.getElementById("educationList");
  const educationMeta = document.getElementById("educationMeta");
  const skillsList = document.getElementById("skillsList");
  const skillsMeta = document.getElementById("skillsMeta");
  if (status) status.textContent = "";
  if (experiencesList) experiencesList.innerHTML = "";
  if (experiencesMeta) experiencesMeta.textContent = "";
  if (educationList) educationList.innerHTML = "";
  if (educationMeta) educationMeta.textContent = "";
  if (skillsList) skillsList.innerHTML = "";
  if (skillsMeta) skillsMeta.textContent = "";
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

  if (!profile || state.profileStatus === "error") {
    const info = document.createElement("div");
    info.className = "profile-info";
    const title = document.createElement("div");
    title.className = "profile-name";
    title.textContent = "Aucun profil détecté";
    const subtitle = document.createElement("div");
    subtitle.className = "profile-sub muted";
    subtitle.textContent = state.profileStatusMessage || "Ouvrez un profil LinkedIn (/in/...) pour afficher les infos.";
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);
    if (status && state.profileStatus === "error") {
      status.textContent = state.profileStatusMessage || "Ouvrez un profil LinkedIn (/in/...) pour afficher les infos.";
    }
    return;
  }

  const photoSrc =
    profile.photo_url || profile.photoUrl || profile.profileImageUrl || profile.profile_image_url;
  if (photoSrc) {
    const avatar = document.createElement("img");
    avatar.src = photoSrc;
    avatar.alt = profile.fullName || profile.name || "Profil";
    avatar.className = "avatar";
    card.appendChild(avatar);
  }

  const info = document.createElement("div");
  info.className = "profile-info";
  const title = document.createElement("div");
  title.className = "profile-name";
  title.textContent = profile.fullName || profile.name || "Profil LinkedIn";
  const subtitle = document.createElement("div");
  subtitle.className = "profile-sub";
  subtitle.textContent = profile.headline || profile.current_title || "";
  const meta = document.createElement("div");
  meta.className = "profile-meta";
  const location = profile.location || profile.localisation || "";
  const metaParts = [profile.current_company || "", location].filter(Boolean);
  meta.textContent = metaParts.join(" · ");
  const linkRow = document.createElement("div");
  linkRow.className = "profile-meta";
  const link = document.createElement("a");
  link.href = profile.linkedin_url || profile.linkedinUrl || profile.linkedinProfileUrl || "#";
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
  contractChip.textContent = profile.contract || "-";
  chips.appendChild(contractChip);

  if (profile.firstName) {
    const firstChip = document.createElement("span");
    firstChip.className = "pill-inline";
    firstChip.textContent = profile.firstName;
    chips.appendChild(firstChip);
  }

  if (profile.relationDegree) {
    const relationChip = document.createElement("span");
    relationChip.className = "pill-inline";
    relationChip.textContent = `Relation ${profile.relationDegree}`;
    chips.appendChild(relationChip);
  }

  info.appendChild(chips);

  const experiences = profile.experiences || [];
  if (experiencesMeta) {
    experiencesMeta.textContent = `${experiences.length || 0} expérience(s)`;
  }

  if (experiencesList) {
    if (!experiences.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Aucune expérience détectée.";
      experiencesList.appendChild(empty);
    } else {
      experiences.forEach((exp) => {
        const row = document.createElement("div");
        row.className = "experience-row";

        const header = document.createElement("div");
        header.className = "profile-sub";
        const headerParts = [exp.title, exp.company].filter(Boolean);
        header.textContent = headerParts.join(" · ");
        row.appendChild(header);

        const detailsParts = [exp.dates, exp.location].filter(Boolean);
        if (detailsParts.length) {
          const details = document.createElement("div");
          details.className = "profile-meta";
          details.textContent = detailsParts.join(" · ");
          row.appendChild(details);
        }

        experiencesList.appendChild(row);
      });
    }
  }

  const education = profile.education || [];
  if (educationMeta) {
    educationMeta.textContent = `${education.length || 0} formation(s)`;
  }

  if (educationList) {
    if (!education.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Aucune formation détectée.";
      educationList.appendChild(empty);
    } else {
      education.forEach((ed) => {
        const row = document.createElement("div");
        row.className = "experience-row";

        const header = document.createElement("div");
        header.className = "profile-sub";
        const headerParts = [ed.degree, ed.school].filter(Boolean);
        header.textContent = headerParts.join(" · ");
        row.appendChild(header);

        if (ed.dates) {
          const details = document.createElement("div");
          details.className = "profile-meta";
          details.textContent = ed.dates;
          row.appendChild(details);
        }

        educationList.appendChild(row);
      });
    }
  }

  const skills = profile.skills || [];
  if (skillsMeta) {
    skillsMeta.textContent = `${skills.length || 0} compétence(s)`;
  }

  if (skillsList) {
    if (!skills.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Aucune compétence détectée.";
      skillsList.appendChild(empty);
    } else {
      skills.forEach((skill) => {
        const chip = document.createElement("span");
        chip.className = "pill-inline";
        chip.textContent = skill;
        skillsList.appendChild(chip);
      });
    }
  }
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
    if (!activeTab?.id || !activeTab.url || !isLinkedinProfileContext(activeTab.url)) {
      state.profile = null;
      state.profileStatus = "error";
      state.profileStatusMessage = "Ouvrez un profil LinkedIn (/in/...) pour afficher les infos.";
      renderProfileCard(null);
      return;
    }

    state.profileStatus = "loading";
    state.profileStatusMessage = "";
    renderProfileCard(state.profile);
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

    if (requestError || !response || response.status !== "success" || !response.data) {
      console.warn("[Focals][POPUP] No profile data:", requestError?.message || requestError || response);
      state.profile = null;
      state.profileStatus = "error";
      state.profileStatusMessage =
        "Aucun profil détecté. Assurez-vous d'être sur une page LinkedIn /in/ et réessayez.";
    } else {
      state.profile = response.data;
      state.profileStatus = "ready";
      state.profileStatusMessage = "";
    }

    renderProfileCard(state.profile);
  } catch (err) {
    console.error("[Focals][POPUP] Profil indisponible", err);
    state.profile = null;
    state.profileStatus = "error";
    state.profileStatusMessage = "Ouvrez un profil LinkedIn (/in/...) pour afficher les infos.";
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
      state.profileStatusMessage = "Ouvrez un profil LinkedIn (/in/...) pour afficher les infos.";
      renderProfileCard(null);
      return;
    }
    state.profileStatus = "loading";
    renderProfileCard(state.profile);
    await refreshProfileFromTab();
  } catch (err) {
    console.error("[Focals][POPUP] Force rescrape failed", err);
    state.profileStatus = "error";
    state.profileStatusMessage = "Ouvrez un profil LinkedIn (/in/...) pour afficher les infos.";
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
    if (status) status.textContent = "Utilisateur non authentifié - connecte-toi sur l'app web.";
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
  const statusEl = document.getElementById("profileStatus");

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (activeTab && isLinkedinProfileContext(activeTab.url)) {
        const currentStatusText = statusEl.innerText;
        statusEl.innerText = "Scraping en cours... ⏳";

        try {
          chrome.tabs.sendMessage(activeTab.id, { action: "SCRAPE_PROFILE" }, (response) => {
            if (chrome.runtime.lastError) {
              console.error("[Focals][Popup] Erreur de communication:", chrome.runtime.lastError.message);
              statusEl.innerText = "Erreur: Rechargez la page LinkedIn. ❌";
              return;
            }

            if (response && response.status === "success" && response.data) {
              state.profile = response.data;
              state.profileStatus = "ready";
              state.profileStatusMessage = "";
              displayProfileData(state.profile);
              renderProfileCard(state.profile);
              statusEl.innerText = "Scrape V14 terminé ! ✅";
            } else {
              statusEl.innerText = response?.error || "Échec du scrape. ❌";
            }
          });
        } catch (e) {
          statusEl.innerText = "Échec de l'envoi du message. ❌";
          console.error("[Focals] Message send failed:", e);
        }
      } else {
        statusEl.innerText = "Veuillez vous placer sur un profil LinkedIn. ⚠️";
      }
    });
  }

  if (associateBtn) {
    associateBtn.addEventListener("click", () => handleAssociateProfile());
  }
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
  await loadProfileDataFromStorage(localStore);
  setupTone();
  setupSystemPrompt();
  setupTabs();
  setupProfileActions();
  await refreshProfileFromTab();
  await loadSupabaseSession();
  debugLog("POPUP_READY", state);
});
