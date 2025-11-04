// popup.js — adapté à popup.html (ph, nm, hd, co, lc, lnk, go, copy, retry)

let lastData = null;

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

  if (btnGo) btnGo.addEventListener("click", fetchData);
  if (btnRetry) btnRetry.addEventListener("click", fetchData);
  if (btnCopy) btnCopy.addEventListener("click", copyJson);
  if (btnFromIn) btnFromIn.addEventListener("click", fetchData); // même action pour l'instant

  // on charge direct à l'ouverture
  fetchData();
});
