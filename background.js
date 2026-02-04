import supabase, { SUPABASE_URL } from "./supabase-client.js";
import { API_BASE_URL, IS_DEV } from "./src/api/config.js";
import { createLogger } from "./src/utils/logger.js";

// === CONFIGURATION & GLOBALS ===
const logger = createLogger("Background");
const FOCALS_DEBUG = IS_DEV;
const detailsScrapeInFlight = new Map();
const DETAILS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEYS = {
  tone: "focals_userTone",
  templates: "focals_templates",
  jobs: "focals_jobs",
  selectedTemplate: "focals_selectedTemplate",
  apiKey: "focals_openai_apiKey",
};

// === HELPERS ===
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveProfileToSupabaseExternal(profileData) {
  const SUPABASE_URL = "https://ppawceknsedxaejpeylu.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYXdjZWtuc2VkeGFlanBleWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4MTUzMTUsImV4cCI6MjA3NDM5MTMxNX0.G3XH8afOmaYh2PGttY3CVRwi0JIzIvsTKIeeynpKpKI";

  const response = await fetch(`${SUPABASE_URL}/functions/v1/save-engineer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      userId: "extension-update",
      profile: profileData,
      exportedAt: new Date().toISOString()
    }),
  });
  return response.json();
}

async function handleScrapeRequest(linkedinUrl, sendResponse) {
  try {
    if (!linkedinUrl) {
      sendResponse({ success: false, error: "URL manquante" });
      return;
    }
    const tab = await chrome.tabs.create({ url: linkedinUrl, active: true });
    // Ici on simule l'attente, tu peux garder tes fonctions waitForComplete
    await wait(5000); 
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CANDIDATE_DATA" }).catch(() => null);
    await chrome.tabs.remove(tab.id);

    if (response?.data) {
      await saveProfileToSupabaseExternal(response.data);
      sendResponse({ success: true, profile: response.data });
    } else {
      sendResponse({ success: false, error: "Scraping échoué" });
    }
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// === LISTENERS INTERNES ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GENERATE_REPLY") {
     // Ta logique de génération ici...
     sendResponse({ success: true, replyText: "Généré !" });
     return true;
  }
  return false;
});

// === LISTENERS EXTERNES (LOVABLE / WEB APP) ===
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log("📥 Message externe reçu:", message?.type);

  if (message?.type === "FOCALS_LOGIN_SUCCESS") {
    chrome.storage.local.set({ focals_user_id: message.userId }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message?.type === "PING") {
    sendResponse({ status: "pong" });
    return false;
  }

  if (message?.type === "SCRAPE_PROFILE") {
    handleScrapeRequest(message.linkedinUrl, sendResponse);
    return true;
  }

  return false;
});

console.log("🚀 Focals Background Loaded");
