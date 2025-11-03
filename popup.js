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

function fillUI(data, source = "standard") {
  if (!data) return;
  lastData = data;

  setImg("ph", data.photo_url);
  setText("nm", data.name);
  setText("hd", data.current_title);
  setText("co", data.current_company);
  setText("ct", data.contract);          // 👈 ajout
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
function requestDataFromTab(tabId, sourceLabel) {
  chrome.tabs.sendMessage(tabId, { type: "GET_CANDIDATE_DATA" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.data) {
      // pas de réponse → on injecte content-main.js puis on redemande
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ["content-main.js"],
        },
        () => {
          // on redemande
          chrome.tabs.sendMessage(tabId, { type: "GET_CANDIDATE_DATA" }, (res2) => {
            if (chrome.runtime.lastError || !res2 || !res2.data) {
              setErr("Impossible de récupérer les infos sur cette page.");
              setMode("Mode : échec");
              return;
            }
            fillUI(res2.data, sourceLabel + " (après injection)");
          });
        }
      );
      return;
    }
    fillUI(res.data, sourceLabel);
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
