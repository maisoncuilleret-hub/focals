// popup.js — adapté à popup.html (ph, nm, hd, co, lc, lnk, go, copy, retry)

let lastData = null;
let pipelinePort = null;
let pipelineButton = null;
let pipelineProgressContainer = null;
let pipelineProgressBar = null;
let pipelineProgressLabel = null;
let pipelineHideTimeout = null;

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

document.addEventListener("DOMContentLoaded", () => {
  const btnGo = document.getElementById("go");
  const btnRetry = document.getElementById("retry");
  const btnCopy = document.getElementById("copy");
  const btnFromIn = document.getElementById("fromIn");
  const btnExport = document.getElementById("exportPipeline");

  if (btnGo) btnGo.addEventListener("click", fetchData);
  if (btnRetry) btnRetry.addEventListener("click", fetchData);
  if (btnCopy) btnCopy.addEventListener("click", copyJson);
  if (btnFromIn) btnFromIn.addEventListener("click", fetchData); // même action pour l'instant
  if (btnExport) btnExport.addEventListener("click", exportPipelineCsv);

  pipelineButton = btnExport;
  ensurePipelineElements();
  ensurePipelinePort();

  // on charge direct à l'ouverture
  fetchData();
});
