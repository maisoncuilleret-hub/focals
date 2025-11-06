const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const pipelinePorts = new Set();
const pipelineState = {
  active: null,
  lastResult: null,
};

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
    const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csvContent)}`;

    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
    });

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
