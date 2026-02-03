const OFFSCREEN_MESSAGE_TYPE = "FETCH_LINKEDIN_STATUS";
const LOG_SCOPE = "NET";
const fallbackLogger = {
  info: (scope, ...args) => console.info(`[FOCALS][${scope}]`, ...args),
  warn: (scope, ...args) => console.warn(`[FOCALS][${scope}]`, ...args),
  error: (scope, ...args) => console.error(`[FOCALS][${scope}]`, ...args),
};
let logger = fallbackLogger;

if (typeof chrome !== "undefined" && chrome?.runtime?.getURL) {
  import(chrome.runtime.getURL("src/utils/logger.js"))
    .then((mod) => {
      if (mod?.logger) logger = mod.logger;
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === OFFSCREEN_MESSAGE_TYPE) {
    fetchLinkedInStatus(request.linkedinUrl)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  return undefined;
});

async function fetchLinkedInStatus(linkedinUrl) {
  logger.info(LOG_SCOPE, "Offscreen fetch", linkedinUrl);

  try {
    if (!linkedinUrl) {
      return { success: false, error: "URL LinkedIn manquante" };
    }

    const response = await fetch(linkedinUrl, {
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const status = extractConnectionStatus(doc, html);
    logger.info(LOG_SCOPE, "Offscreen status", status);

    return {
      success: true,
      status,
      connection_status: status,
    };
  } catch (error) {
    logger.error(LOG_SCOPE, "Offscreen error", error);
    return { success: false, error: error?.message || "Erreur de récupération" };
  }
}

function extractConnectionStatus(doc, html) {
  const bodyText = doc.body?.innerText?.toLowerCase() || html.toLowerCase();

  if (bodyText.includes("1er") || bodyText.includes("1st degree")) {
    return "connected";
  }

  const pendingIndicators = ["pending", "en attente", "invitation envoyée", "invitation sent"];
  for (const indicator of pendingIndicators) {
    if (bodyText.includes(indicator)) {
      return "pending";
    }
  }

  const htmlLower = html.toLowerCase();
  if (htmlLower.includes('aria-label="pending"') || htmlLower.includes('aria-label="en attente"')) {
    return "pending";
  }

  const hasMessage =
    htmlLower.includes('aria-label="message"') ||
    htmlLower.includes(">message<") ||
    doc.querySelector('button[aria-label*="Message" i]');
  const hasConnect =
    htmlLower.includes('aria-label="connect"') ||
    htmlLower.includes('aria-label="se connecter"') ||
    doc.querySelector('button[aria-label*="Connect" i], button[aria-label*="Se connecter" i]');

  if (hasMessage && !hasConnect) {
    return "connected";
  }

  return "not_connected";
}
