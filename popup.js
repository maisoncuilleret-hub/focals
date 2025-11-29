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
  selectedTemplate: "focals_selectedTemplate",
  selectedJob: "focals_selectedJob",
  apiKey: "focals_openai_apiKey",
};

const DEFAULT_TONE = "professional";

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

let apiModule = null;
let userIdHelpers = null;

let state = {
  userId: null,
  tone: DEFAULT_TONE,
  templates: [],
  jobs: [],
  selectedTemplate: null,
  selectedJob: null,
  apiKey: "",
  loading: false,
};

let editingTemplateId = null;
let editingJobId = null;

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

function renderTone() {
  const select = document.getElementById("toneSelect");
  if (!select) return;
  select.value = state.tone || DEFAULT_TONE;
}

function renderTemplates() {
  const list = document.getElementById("templatesList");
  const form = document.getElementById("templateForm");
  const labelInput = document.getElementById("templateLabel");
  const idInput = document.getElementById("templateId");
  const langSelect = document.getElementById("templateLanguage");
  const contentInput = document.getElementById("templateContent");
  if (!list) return;

  list.innerHTML = "";
  const templates = Array.isArray(state.templates) ? state.templates : [];
  templates.forEach((tpl) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const info = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = tpl.label || tpl.id;
    const meta = document.createElement("small");
    meta.textContent = tpl.content ? tpl.content.slice(0, 80) : "";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = tpl.language || "—";
    info.appendChild(strong);
    info.appendChild(meta);
    info.appendChild(pill);

    const actions = document.createElement("div");
    actions.className = "row";

    const selectBtn = document.createElement("button");
    selectBtn.className = "secondary";
    selectBtn.textContent = tpl.id === state.selectedTemplate ? "Par défaut" : "Définir";
    selectBtn.onclick = async () => {
      await syncStore.set({ [STORAGE_KEYS.selectedTemplate]: tpl.id });
      state.selectedTemplate = tpl.id;
      renderTemplates();
      setStatus("Modèle par défaut mis à jour");
    };

    const editBtn = document.createElement("button");
    editBtn.className = "secondary";
    editBtn.textContent = "Éditer";
    editBtn.onclick = () => {
      editingTemplateId = tpl.id;
      if (form) form.style.display = "block";
      if (labelInput) labelInput.value = tpl.label || "";
      if (idInput) idInput.value = tpl.id || "";
      if (langSelect) langSelect.value = tpl.language || "fr";
      if (contentInput) contentInput.value = tpl.content || "";
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.onclick = async () => {
      if (!state.userId || !apiModule) return;
      try {
        setLoading(true, "Suppression du modèle...");
        await apiModule.deleteTemplate(state.userId, tpl.id);
        state.templates = templates.filter((t) => t.id !== tpl.id);
        if (state.selectedTemplate === tpl.id) {
          state.selectedTemplate = null;
          await syncStore.set({ [STORAGE_KEYS.selectedTemplate]: null });
        }
        renderTemplates();
        setStatus("Modèle supprimé");
      } catch (err) {
        console.error(err);
        alert(`Erreur Focals : ${err?.message || "Une erreur est survenue."}`);
      } finally {
        setLoading(false);
      }
    };

    actions.appendChild(selectBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(info);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

function renderJobs() {
  const list = document.getElementById("jobsList");
  const form = document.getElementById("jobForm");
  const titleInput = document.getElementById("jobTitle");
  const idInput = document.getElementById("jobId");
  const companyInput = document.getElementById("jobCompany");
  const langSelect = document.getElementById("jobLanguage");
  const descInput = document.getElementById("jobDescription");
  const summaryInput = document.getElementById("jobSummary");
  if (!list) return;

  list.innerHTML = "";
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  jobs.forEach((job) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const info = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${job.title || "Job"} @ ${job.company || "—"}`;
    const meta = document.createElement("small");
    meta.textContent = job.summary ? job.summary.slice(0, 80) : job.raw_description?.slice(0, 80) || "";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = job.language || "—";
    info.appendChild(strong);
    info.appendChild(meta);
    info.appendChild(pill);

    const actions = document.createElement("div");
    actions.className = "row";

    const selectBtn = document.createElement("button");
    selectBtn.className = "secondary";
    selectBtn.textContent = job.id === state.selectedJob ? "Par défaut" : "Définir";
    selectBtn.onclick = async () => {
      if (!state.userId || !apiModule) return;
      try {
        setLoading(true, "Mise à jour du job par défaut...");
        const settings = await apiModule.upsertSettings(state.userId, { default_job_id: job.id });
        state.selectedJob = settings.default_job_id;
        state.settings = settings;
        await syncStore.set({ [STORAGE_KEYS.selectedJob]: job.id });
        renderJobs();
        setStatus("Job par défaut mis à jour");
      } catch (err) {
        console.error(err);
        alert(`Erreur Focals : ${err?.message || "Une erreur est survenue."}`);
      } finally {
        setLoading(false);
      }
    };

    const editBtn = document.createElement("button");
    editBtn.className = "secondary";
    editBtn.textContent = "Éditer";
    editBtn.onclick = () => {
      editingJobId = job.id;
      if (form) form.style.display = "block";
      if (titleInput) titleInput.value = job.title || "";
      if (idInput) idInput.value = job.id || "";
      if (companyInput) companyInput.value = job.company || "";
      if (langSelect) langSelect.value = job.language || "fr";
      if (descInput) descInput.value = job.raw_description || "";
      if (summaryInput) summaryInput.value = job.summary || "";
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.onclick = async () => {
      if (!state.userId || !apiModule) return;
      try {
        setLoading(true, "Suppression du job...");
        await apiModule.deleteJob(state.userId, job.id);
        const filtered = jobs.filter((j) => j.id !== job.id);
        state.jobs = filtered;
        if (state.selectedJob === job.id) {
          state.selectedJob = null;
          await syncStore.set({ [STORAGE_KEYS.selectedJob]: null });
          state.settings = { ...state.settings, default_job_id: null };
        }
        renderJobs();
        setStatus("Job supprimé");
      } catch (err) {
        console.error(err);
        alert(`Erreur Focals : ${err?.message || "Une erreur est survenue."}`);
      } finally {
        setLoading(false);
      }
    };

    actions.appendChild(selectBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(info);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

async function loadState() {
  if (!apiModule || !userIdHelpers) return;
  try {
    setLoading(true, "Chargement...");
    const [{ getOrCreateUserId }, apiKeyValues] = await Promise.all([
      Promise.resolve(userIdHelpers),
      syncStore.get([STORAGE_KEYS.selectedTemplate, STORAGE_KEYS.selectedJob, STORAGE_KEYS.apiKey]),
    ]);
    const userId = await getOrCreateUserId();
    state.userId = userId;
    const data = await apiModule.bootstrapUser(userId);
    state.tone = data.settings?.default_tone || DEFAULT_TONE;
    state.templates = data.templates || [];
    state.jobs = data.jobs || [];
    state.settings = data.settings;
    state.selectedJob = data.settings?.default_job_id || apiKeyValues[STORAGE_KEYS.selectedJob] || null;
    state.selectedTemplate = apiKeyValues[STORAGE_KEYS.selectedTemplate] || null;
    state.apiKey = apiKeyValues[STORAGE_KEYS.apiKey] || "";
    renderTone();
    renderTemplates();
    renderJobs();
    const apiInput = document.getElementById("apiKey");
    if (apiInput) apiInput.value = state.apiKey || "";
  } catch (err) {
    console.error(err);
    alert(`Erreur Focals : ${err?.message || "Impossible de charger les données."}`);
  } finally {
    setLoading(false);
  }
}

function setupTone() {
  const select = document.getElementById("toneSelect");
  if (!select) return;
  select.addEventListener("change", async (e) => {
    const tone = e.target.value || DEFAULT_TONE;
    state.tone = tone;
    if (!state.userId || !apiModule) return;
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

function setupTemplateForm() {
  const addBtn = document.getElementById("addTemplate");
  const form = document.getElementById("templateForm");
  const cancelBtn = document.getElementById("cancelTemplate");
  const saveBtn = document.getElementById("saveTemplate");
  const labelInput = document.getElementById("templateLabel");
  const idInput = document.getElementById("templateId");
  const langSelect = document.getElementById("templateLanguage");
  const contentInput = document.getElementById("templateContent");

  const resetForm = () => {
    editingTemplateId = null;
    if (labelInput) labelInput.value = "";
    if (idInput) idInput.value = "";
    if (langSelect) langSelect.value = "fr";
    if (contentInput) contentInput.value = "";
  };

  if (addBtn && form) {
    addBtn.addEventListener("click", () => {
      form.style.display = "block";
      resetForm();
    });
  }

  if (cancelBtn && form) {
    cancelBtn.addEventListener("click", () => {
      form.style.display = "none";
      resetForm();
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (!state.userId || !apiModule) return;
      const label = labelInput?.value.trim();
      const id = idInput?.value.trim();
      const language = langSelect?.value || "fr";
      const content = contentInput?.value.trim();
      if (!label || !content) {
        setStatus("Veuillez remplir tous les champs du modèle");
        return;
      }
      try {
        setLoading(true, "Enregistrement du modèle...");
        const template = await apiModule.upsertTemplate(state.userId, {
          id: editingTemplateId || id || undefined,
          label,
          language,
          content,
        });
        const templates = Array.isArray(state.templates) ? [...state.templates] : [];
        const existingIdx = templates.findIndex((t) => t.id === template.id);
        if (existingIdx >= 0) {
          templates[existingIdx] = template;
        } else {
          templates.push(template);
        }
        state.templates = templates;
        state.selectedTemplate = template.id;
        await syncStore.set({
          [STORAGE_KEYS.selectedTemplate]: template.id,
        });
        renderTemplates();
        if (form) form.style.display = "none";
        resetForm();
        setStatus("Modèle enregistré");
      } catch (err) {
        console.error(err);
        alert(`Erreur Focals : ${err?.message || "Une erreur est survenue."}`);
      } finally {
        setLoading(false);
      }
    });
  }
}

function setupJobForm() {
  const addBtn = document.getElementById("addJob");
  const form = document.getElementById("jobForm");
  const cancelBtn = document.getElementById("cancelJob");
  const saveBtn = document.getElementById("saveJob");
  const titleInput = document.getElementById("jobTitle");
  const idInput = document.getElementById("jobId");
  const companyInput = document.getElementById("jobCompany");
  const langSelect = document.getElementById("jobLanguage");
  const descInput = document.getElementById("jobDescription");
  const summaryInput = document.getElementById("jobSummary");

  const resetForm = () => {
    editingJobId = null;
    if (titleInput) titleInput.value = "";
    if (idInput) idInput.value = "";
    if (companyInput) companyInput.value = "";
    if (langSelect) langSelect.value = "fr";
    if (descInput) descInput.value = "";
    if (summaryInput) summaryInput.value = "";
  };

  if (addBtn && form) {
    addBtn.addEventListener("click", () => {
      form.style.display = "block";
      resetForm();
    });
  }

  if (cancelBtn && form) {
    cancelBtn.addEventListener("click", () => {
      form.style.display = "none";
      resetForm();
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (!state.userId || !apiModule) return;
      const title = titleInput?.value.trim();
      const id = idInput?.value.trim();
      const company = companyInput?.value.trim();
      const language = langSelect?.value || "fr";
      const rawDescription = descInput?.value.trim();
      const summary = summaryInput?.value.trim() || null;
      if (!title || !company || !rawDescription) {
        setStatus("Veuillez remplir tous les champs obligatoires du job");
        return;
      }
      try {
        setLoading(true, "Enregistrement du job...");
        const job = await apiModule.upsertJob(state.userId, {
          id: editingJobId || id || undefined,
          title,
          company,
          language,
          raw_description: rawDescription,
          summary,
          is_default: state.selectedJob === (editingJobId || id),
        });
        const jobs = Array.isArray(state.jobs) ? [...state.jobs] : [];
        const existingIdx = jobs.findIndex((j) => j.id === job.id);
        if (existingIdx >= 0) {
          jobs[existingIdx] = job;
        } else {
          jobs.push(job);
        }
        state.jobs = jobs;
        renderJobs();
        if (form) form.style.display = "none";
        resetForm();
        setStatus("Job enregistré");
      } catch (err) {
        console.error(err);
        alert(`Erreur Focals : ${err?.message || "Une erreur est survenue."}`);
      } finally {
        setLoading(false);
      }
    });
  }
}

function setupApiKey() {
  const saveBtn = document.getElementById("saveApiKey");
  const input = document.getElementById("apiKey");
  if (!saveBtn || !input) return;
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    await syncStore.set({ [STORAGE_KEYS.apiKey]: value });
    state.apiKey = value;
    setStatus("Clé OpenAI sauvegardée");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    [apiModule, userIdHelpers] = await Promise.all([
      import(chrome.runtime.getURL("src/api/focalsApi.js")),
      import(chrome.runtime.getURL("src/focalsUserId.js")),
    ]);
  } catch (err) {
    console.error("Impossible de charger les modules Focals", err);
  }
  await loadState();
  setupTone();
  setupTemplateForm();
  setupJobForm();
  setupApiKey();
  debugLog("POPUP_READY", state);
});
