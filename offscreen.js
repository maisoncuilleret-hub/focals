const OFFSCREEN_MESSAGE_TYPE = "FETCH_LINKEDIN_STATUS";

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
  try {
    if (!linkedinUrl) {
      return { success: false, error: "URL LinkedIn manquante" };
    }

    const response = await fetch(linkedinUrl, {
      credentials: "include",
    });
    const html = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const status = extractConnectionStatus(doc);

    return {
      success: true,
      status,
      connection_status: status,
    };
  } catch (error) {
    return { success: false, error: error?.message || "Erreur de récupération" };
  }
}

function extractConnectionStatus(doc) {
  // Badge 1st / distance badge
  const degreeNode = doc.querySelector(".dist-value, .distance-badge");
  if (degreeNode && /1/.test(degreeNode.textContent || "")) {
    return "connected";
  }

  // Pending invitation
  if (doc.querySelector('button[aria-label*="Pending" i], button[aria-label*="En attente" i]')) {
    return "pending";
  }

  const messageButton = doc.querySelector('button[aria-label*="Message" i]');
  const connectButton = doc.querySelector('button[aria-label*="Connect" i], button[aria-label*="Se connecter" i]');
  if (messageButton && !connectButton) {
    return "connected";
  }

  return "not_connected";
}
