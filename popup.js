// popup.js — adapté à popup.html (ph, nm, hd, co, lc, lnk, go, copy, retry)

let lastData = null;
let pipelinePort = null;
let pipelineButton = null;
let pipelineProgressContainer = null;
let pipelineProgressBar = null;
let pipelineProgressLabel = null;
let pipelineHideTimeout = null;
const STORAGE_KEYS = {
  settings: "FOCALS_SETTINGS",
  templates: "FOCALS_TEMPLATES",
  activeTemplate: "FOCALS_ACTIVE_TEMPLATE",
  jobs: "FOCALS_JOBS",
  activeJob: "FOCALS_ACTIVE_JOB",
};

const DEFAULT_SETTINGS = {
  tone: "friendly",
  languageFallback: "en",
  followUpPreference: "next_steps",
};

const DEFAULT_TEMPLATES = [
  {
    id: "friendly_followup",
    title: "Friendly follow-up",
    content:
      "Remercie pour le message, réponds brièvement et propose la prochaine étape (appel ou échange). Reste concis et accessible.",
  },
  {
    id: "concise_ack",
    title: "Concise acknowledgement",
    content:
      "Accuse réception, reprends un élément clé du message précédent et propose une action claire en deux phrases maximum.",
  },
];

const DEFAULT_JOBS = [
  {
    id: "default_job",
    title: "Full-Stack Engineer",
    description:
      "We are hiring a pragmatic full-stack engineer who can ship end-to-end features with React/TypeScript and Node. Emphasis on ownership, clean communication, and shipping reliable customer-facing features.",
    keywords: ["React", "TypeScript", "Node", "shipping", "customer focus"],
  },
];

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || "—";
}

function setImg(id, url) {
  const el = document.getElementById(id);
  if (!el) return;
  if (url) {
    el.src = url;
  } else {
    el.removeAttribute("src");
  }
}

function setErr(msg) {
  const el = document.getElementById("err");
  if (el) el.textContent = msg || "";
}

function setMode(msg) {
  const el = document.getElementById("mode");
  if (el) el.textContent = msg || "";
}

function getFromStorage(area, defaults = {}) {
  return new Promise((resolve) => {
    try {
      chrome.storage[area].get(defaults, (result) => resolve(result || defaults));
    } catch (err) {
      console.warn("[Focals][POPUP] Storage get error", err);
      resolve(defaults);
    }
  });
}

function setInStorage(area, values = {}) {
  return new Promise((resolve) => {
    try {
      chrome.storage[area].set(values, () => resolve(true));
    } catch (err) {
      console.warn("[Focals][POPUP] Storage set error", err);
      resolve(false);
    }
  });
}

async function loadPreferences() {
  const [syncData, localData] = await Promise.all([
    getFromStorage("sync", {
      [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
      [STORAGE_KEYS.templates]: DEFAULT_TEMPLATES,
      [STORAGE_KEYS.activeTemplate]: DEFAULT_TEMPLATES[0].id,
    }),
    getFromStorage("local", {
      [STORAGE_KEYS.jobs]: DEFAULT_JOBS,
      [STORAGE_KEYS.activeJob]: DEFAULT_JOBS[0].id,
    }),
  ]);

  const settings = { ...DEFAULT_SETTINGS, ...(syncData?.[STORAGE_KEYS.settings] || {}) };
  const templates = Array.isArray(syncData?.[STORAGE_KEYS.templates])
    ? syncData[STORAGE_KEYS.templates]
    : DEFAULT_TEMPLATES;
  const activeTemplateId = syncData?.[STORAGE_KEYS.activeTemplate] || templates?.[0]?.id;
  const jobs = Array.isArray(localData?.[STORAGE_KEYS.jobs]) ? localData[STORAGE_KEYS.jobs] : DEFAULT_JOBS;
  const activeJobId = localData?.[STORAGE_KEYS.activeJob] || jobs?.[0]?.id;

  return { settings, templates, activeTemplateId, jobs, activeJobId };
}

function renderTemplateOptions(templates, activeTemplateId) {
  const select = document.getElementById("activeTemplate");
  const list = document.getElementById("templates");
  if (!select || !list) return;

  select.innerHTML = "";
  list.innerHTML = "";

  templates.forEach((tpl) => {
    const option = document.createElement("option");
    option.value = tpl.id;
    option.textContent = tpl.title;
    if (tpl.id === activeTemplateId) option.selected = true;
    select.appendChild(option);

    const item = document.createElement("div");
    item.textContent = `${tpl.title}: ${tpl.content.slice(0, 120)}${tpl.content.length > 120 ? "…" : ""}`;
    list.appendChild(item);
  });
}

function renderJobOptions(jobs, activeJobId) {
  const select = document.getElementById("activeJob");
  const list = document.getElementById("jobs");
  if (!select || !list) return;

  select.innerHTML = "";
  list.innerHTML = "";

  jobs.forEach((job) => {
    const option = document.createElement("option");
    option.value = job.id;
    option.textContent = job.title;
    if (job.id === activeJobId) option.selected = true;
    select.appendChild(option);

    const item = document.createElement("div");
    const keywords = Array.isArray(job.keywords) ? job.keywords.join(", ") : "";
    item.textContent = `${job.title} · ${keywords}`;
    list.appendChild(item);
  });
}

async function hydrateSettingsUI() {
  const { settings, templates, activeTemplateId, jobs, activeJobId } = await loadPreferences();

  const toneSelect = document.getElementById("toneSelect");
  const languageSelect = document.getElementById("languageSelect");
  const followUpSelect = document.getElementById("followUpSelect");
  if (toneSelect) toneSelect.value = settings.tone || "friendly";
  if (languageSelect) languageSelect.value = settings.languageFallback || "en";
  if (followUpSelect) followUpSelect.value = settings.followUpPreference || "next_steps";

  renderTemplateOptions(templates, activeTemplateId);
  renderJobOptions(jobs, activeJobId);
}

async function saveSettingsFromUI() {
  const toneSelect = document.getElementById("toneSelect");
  const languageSelect = document.getElementById("languageSelect");
  const followUpSelect = document.getElementById("followUpSelect");

  const settings = {
    tone: toneSelect?.value || DEFAULT_SETTINGS.tone,
    languageFallback: languageSelect?.value || DEFAULT_SETTINGS.languageFallback,
    followUpPreference: followUpSelect?.value || DEFAULT_SETTINGS.followUpPreference,
  };

  await setInStorage("sync", { [STORAGE_KEYS.settings]: settings });
  setMode("Mode : réglages mis à jour");
}

async function saveTemplateFromUI() {
  const titleEl = document.getElementById("templateTitle");
  const contentEl = document.getElementById("templateContent");
  const activeSelect = document.getElementById("activeTemplate");
  const title = titleEl?.value.trim();
  const content = contentEl?.value.trim();
  if (!title || !content) {
    setErr("Titre et contenu du modèle requis");
    return;
  }

  const { templates } = await loadPreferences();
  const existingIndex = templates.findIndex((tpl) => tpl.id === activeSelect?.value || tpl.title === title);
  const id = existingIndex >= 0 ? templates[existingIndex].id : `tpl_${Date.now()}`;
  const updatedTemplates = [...templates];
  const newTemplate = { id, title, content };

  if (existingIndex >= 0) {
    updatedTemplates[existingIndex] = newTemplate;
  } else {
    updatedTemplates.push(newTemplate);
  }

  await setInStorage("sync", {
    [STORAGE_KEYS.templates]: updatedTemplates,
    [STORAGE_KEYS.activeTemplate]: newTemplate.id,
  });

  setErr("");
  setMode("Mode : modèle enregistré");
  await hydrateSettingsUI();
}

async function saveJobFromUI() {
  const titleEl = document.getElementById("jobTitle");
  const descriptionEl = document.getElementById("jobDescription");
  const keywordsEl = document.getElementById("jobKeywords");
  const activeSelect = document.getElementById("activeJob");
  const title = titleEl?.value.trim();
  const description = descriptionEl?.value.trim();
  const keywords = (keywordsEl?.value || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!title || !description) {
    setErr("Titre et description du poste requis");
    return;
  }

  const { jobs } = await loadPreferences();
  const existingIndex = jobs.findIndex((job) => job.id === activeSelect?.value || job.title === title);
  const id = existingIndex >= 0 ? jobs[existingIndex].id : `job_${Date.now()}`;
  const updatedJobs = [...jobs];
  const newJob = { id, title, description, keywords };

  if (existingIndex >= 0) {
    updatedJobs[existingIndex] = newJob;
  } else {
    updatedJobs.push(newJob);
  }

  await setInStorage("local", {
    [STORAGE_KEYS.jobs]: updatedJobs,
    [STORAGE_KEYS.activeJob]: newJob.id,
  });

  setErr("");
  setMode("Mode : fiche de poste enregistrée");
  await hydrateSettingsUI();
}

async function setActiveTemplate(id) {
  if (!id) return;
  await setInStorage("sync", { [STORAGE_KEYS.activeTemplate]: id });
  setMode("Mode : modèle actif mis à jour");
}

async function setActiveJob(id) {
  if (!id) return;
  await setInStorage("local", { [STORAGE_KEYS.activeJob]: id });
  setMode("Mode : fiche de poste active mise à jour");
}

function ensurePipelineElements() {
  if (!pipelineProgressContainer) {
    pipelineProgressContainer = document.getElementById("pipelineProgress");
  }
  if (!pipelineProgressBar) {
    pipelineProgressBar = document.getElementById("pipelineProgressBar");
  }
  if (!pipelineProgressLabel) {
    pipelineProgressLabel = document.getElementById("pipelineProgressLabel");
  }
}

function hidePipelineProgress() {
  ensurePipelineElements();
  if (pipelineHideTimeout) {
    clearTimeout(pipelineHideTimeout);
    pipelineHideTimeout = null;
  }
  if (pipelineProgressContainer) {
    pipelineProgressContainer.classList.remove("progress--active");
  }
  if (pipelineProgressBar) {
    pipelineProgressBar.style.width = "0%";
  }
  if (pipelineProgressLabel) {
    pipelineProgressLabel.classList.remove("progress__label--active");
    pipelineProgressLabel.textContent = "";
  }
}

function formatPipelineStage(state, percent) {
  const labels = {
    prepare: "Préparation",
    collect: "Chargement de la liste",
    profile: "Profils",
    "public-url": "Récupération des URL",
    finalize: "Finalisation",
    download: "Téléchargement",
  };
  if (!state) return "";
  if (state.status === "complete") {
    return "Téléchargement du CSV…";
  }
  const stageLabel = labels[state.stage] || "Export en cours";
  const total = state.total ?? 0;
  const completed = Math.min(total, Math.max(0, state.progress ?? 0));
  const countInfo = total ? `(${completed}/${total})` : "";
  return `${stageLabel} · ${percent}% ${countInfo}`.trim();
}

function updatePipelineProgress(state) {
  ensurePipelineElements();
  if (!pipelineProgressContainer || !pipelineProgressBar || !pipelineProgressLabel) {
    return;
  }

  if (!state) {
    hidePipelineProgress();
    return;
  }

  if (pipelineHideTimeout) {
    clearTimeout(pipelineHideTimeout);
    pipelineHideTimeout = null;
  }

  const total = state.total ?? 0;
  const completed = Math.min(total, Math.max(0, state.progress ?? 0));
  const percent = total ? Math.round((completed / total) * 100) : 0;

  pipelineProgressContainer.classList.add("progress--active");
  pipelineProgressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  pipelineProgressLabel.classList.add("progress__label--active");
  pipelineProgressLabel.textContent = formatPipelineStage(state, percent);

  if (state.status === "complete") {
    pipelineHideTimeout = setTimeout(() => {
      hidePipelineProgress();
      pipelineHideTimeout = null;
    }, 2500);
  }
}

function handlePipelinePortMessage(msg) {
  if (!msg) return;

  if (msg.type === "PIPELINE_STATUS" || msg.type === "PIPELINE_EXPORT_PROGRESS") {
    updatePipelineProgress(msg.state);
    setMode("Mode : export pipeline (en cours)");
    if (pipelineButton) pipelineButton.disabled = true;
  } else if (msg.type === "PIPELINE_EXPORT_COMPLETE") {
    updatePipelineProgress({
      status: "complete",
      progress: msg.result?.count ?? 25,
      total: msg.result?.count ?? 25,
      stage: "download",
    });
    if (pipelineButton) pipelineButton.disabled = false;
    const count = msg.result?.count ?? 0;
    setErr(`${count} profils exportés ✅ (téléchargement en cours)`);
    setMode("Mode : export pipeline (terminé)");
  } else if (msg.type === "PIPELINE_ERROR") {
    if (pipelineButton) pipelineButton.disabled = false;
    updatePipelineProgress(null);
    setErr(msg.error || "Export pipeline impossible.");
    setMode("Mode : export pipeline (erreur)");
  } else if (msg.type === "PIPELINE_LAST_RESULT") {
    if (msg.result) {
      if (msg.result.success) {
        setErr(`Dernier export : ${msg.result.count ?? 0} profils ✅`);
      } else if (msg.result.error) {
        setErr(`Dernier export : ${msg.result.error}`);
      }
    }
    if (pipelineButton) pipelineButton.disabled = false;
  }
}

function ensurePipelinePort() {
  if (pipelinePort) {
    return pipelinePort;
  }
  try {
    pipelinePort = chrome.runtime.connect({ name: "pipeline-export" });
    pipelinePort.onMessage.addListener(handlePipelinePortMessage);
    pipelinePort.onDisconnect.addListener(() => {
      pipelinePort = null;
    });
    pipelinePort.postMessage({ type: "REQUEST_PIPELINE_STATUS" });
  } catch (err) {
    console.error("[Focals] pipeline port connection failed", err);
  }
  return pipelinePort;
}

function startPipelineExportForTab(tabId) {
  ensurePipelinePort();
  if (!pipelinePort) {
    setErr("Impossible de contacter le service d'export.");
    setMode("Mode : export pipeline (erreur)");
    if (pipelineButton) pipelineButton.disabled = false;
    return;
  }

  setErr("");
  setMode("Mode : export pipeline…");
  updatePipelineProgress({ status: "starting", progress: 0, total: 25, stage: "prepare" });
  pipelineButton.disabled = true;
  pipelinePort.postMessage({ type: "START_PIPELINE_EXPORT", tabId });
}

function formatConnectionSummary(data) {
  if (!data) return "—";
  const parts = [];
  const status = data.connection_status;
  if (status === "connected") {
    parts.push("Connecté");
  } else if (status === "not_connected") {
    parts.push("Non connecté");
  }

  if (data.connection_degree) {
    parts.push(data.connection_degree);
  } else if (data.connection_label) {
    parts.push(data.connection_label);
  }

  if (data.can_message_without_connect && status !== "connected") {
    parts.push("Message direct possible");
  }

  if (!parts.length && data.connection_summary) {
    return data.connection_summary;
  }

  return parts.length ? parts.join(" · ") : "—";
}

function formatPremium(value) {
  if (value === true) return "Oui";
  if (value === false) return "Non";
  return "—";
}

function fillUI(data, source = "standard") {
  if (!data) return;
  lastData = data;

  setImg("ph", data.photo_url);
  setText("nm", data.name);
  setText("hd", data.current_title);
  setText("co", data.current_company);
  setText("ct", data.contract);          // 👈 ajout
  setText("cx", formatConnectionSummary(data));
  setText("pr", formatPremium(data.is_premium));
  setText("lc", data.localisation);
  setText("lnk", data.linkedin_url);

  const st = document.getElementById("st");
  if (st) {
    if (data.name) {
      st.textContent = "OK";
      st.className = "badge badge--ok";
    } else {
      st.textContent = "Incomplet";
      st.className = "badge badge--warn";
    }
  }

  setErr("");
  setMode("Mode : " + source);
}

// demande les données au content script
function handleResponse(res, sourceLabel) {
  if (!res) {
    setErr("Impossible de récupérer les infos sur cette page.");
    setMode("Mode : échec");
    return false;
  }

  if (res.error) {
    setErr(res.error || "Impossible de récupérer les infos sur cette page.");
    setMode("Mode : erreur");
    return false;
  }

  if (!res.data) {
    setErr("Impossible de récupérer les infos sur cette page.");
    setMode("Mode : échec");
    return false;
  }

  fillUI(res.data, sourceLabel);
  return true;
}

function requestDataFromTab(tabId, sourceLabel) {
  chrome.tabs.sendMessage(tabId, { type: "GET_CANDIDATE_DATA" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      // pas de réponse → on injecte content-main.js puis on redemande
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ["content-main.js"],
        },
        () => {
          // on redemande
          chrome.tabs.sendMessage(tabId, { type: "GET_CANDIDATE_DATA" }, (res2) => {
            handleResponse(res2, sourceLabel + " (après injection)");
          });
        }
      );
      return;
    }

    if (!handleResponse(res, sourceLabel)) {
      setMode("Mode : échec");
    }
  });
}

function fetchData() {
  setErr("");
  setMode("Mode : chargement…");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) {
      setErr("Aucun onglet actif.");
      setMode("Mode : erreur");
      return;
    }
    const tab = tabs[0];
    if (!/linkedin\.com/.test(tab.url || "")) {
      setErr("Ouvre un profil LinkedIn.");
      setMode("Mode : erreur");
      return;
    }
    requestDataFromTab(tab.id, "standard");
  });
}

function exportPipelineCsv() {
  setErr("");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) {
      setErr("Aucun onglet actif.");
      setMode("Mode : export pipeline (erreur)");
      return;
    }

    const tab = tabs[0];
    if (!/linkedin\.com/.test(tab.url || "")) {
      setErr("Ouvre ta pipeline LinkedIn Recruiter.");
      setMode("Mode : export pipeline (erreur)");
      return;
    }

    if (pipelineButton) pipelineButton.disabled = true;
    startPipelineExportForTab(tab.id);
  });
}

function copyJson() {
  // si on a déjà lastData on le copie, sinon on prend depuis le DOM
  const data = lastData || {
    name: document.getElementById("nm")?.textContent || "",
    current_title: document.getElementById("hd")?.textContent || "",
    current_company: document.getElementById("co")?.textContent || "",
    contract: document.getElementById("ct")?.textContent || "",
    connection_status: "",
    connection_degree: "",
    connection_label: "",
    connection_summary: document.getElementById("cx")?.textContent || "",
    is_premium: undefined,
    can_message_without_connect: undefined,
    localisation: document.getElementById("lc")?.textContent || "",
    linkedin_url: document.getElementById("lnk")?.textContent || "",
    photo_url: document.getElementById("ph")?.src || "",
  };

  navigator.clipboard
    .writeText(JSON.stringify(data, null, 2))
    .then(() => setErr("JSON copié ✅"))
    .catch(() => setErr("Impossible de copier ❌"));
}

function saveToSupabase() {
  if (!lastData) {
    setErr("Récupère un profil avant de l'envoyer.");
    setMode("Mode : aucun profil à envoyer");
    return;
  }

  setErr("");
  setMode("Mode : envoi Supabase…");

  const profileToSend = {
    ...lastData,
    linkedin_connected_at:
      lastData.connection_status === "connected" ? new Date().toISOString() : null,
  };

  chrome.runtime.sendMessage(
    { type: "SAVE_PROFILE_TO_SUPABASE", profile: profileToSend },
    (res) => {
      if (res?.error) {
        setErr(res.error || "Envoi Supabase impossible.");
        setMode("Mode : erreur Supabase");
        return;
      }

      setErr("Profil enregistré dans Supabase ✅");
      setMode("Mode : Supabase OK");
    }
  );
}

document.addEventListener("DOMContentLoaded", () => {
  const btnGo = document.getElementById("go");
  const btnRetry = document.getElementById("retry");
  const btnCopy = document.getElementById("copy");
  const btnFromIn = document.getElementById("fromIn");
  const btnSaveSupabase = document.getElementById("saveSupabase");
  const btnExport = document.getElementById("exportPipeline");
  const btnSaveTemplate = document.getElementById("saveTemplate");
  const btnSaveJob = document.getElementById("saveJob");
  const toneSelect = document.getElementById("toneSelect");
  const languageSelect = document.getElementById("languageSelect");
  const followUpSelect = document.getElementById("followUpSelect");
  const activeTemplateSelect = document.getElementById("activeTemplate");
  const activeJobSelect = document.getElementById("activeJob");

  if (btnGo) btnGo.addEventListener("click", fetchData);
  if (btnRetry) btnRetry.addEventListener("click", fetchData);
  if (btnCopy) btnCopy.addEventListener("click", copyJson);
  if (btnFromIn) btnFromIn.addEventListener("click", fetchData); // même action pour l'instant
  if (btnSaveSupabase) btnSaveSupabase.addEventListener("click", saveToSupabase);
  if (btnExport) btnExport.addEventListener("click", exportPipelineCsv);
  if (btnSaveTemplate) btnSaveTemplate.addEventListener("click", saveTemplateFromUI);
  if (btnSaveJob) btnSaveJob.addEventListener("click", saveJobFromUI);
  if (toneSelect) toneSelect.addEventListener("change", saveSettingsFromUI);
  if (languageSelect) languageSelect.addEventListener("change", saveSettingsFromUI);
  if (followUpSelect) followUpSelect.addEventListener("change", saveSettingsFromUI);
  if (activeTemplateSelect)
    activeTemplateSelect.addEventListener("change", (e) => setActiveTemplate(e.target.value));
  if (activeJobSelect) activeJobSelect.addEventListener("change", (e) => setActiveJob(e.target.value));

  pipelineButton = btnExport;
  ensurePipelineElements();
  ensurePipelinePort();

  // on charge direct à l'ouverture
  hydrateSettingsUI();
  fetchData();
});
