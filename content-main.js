console.log("[Focals][CONTENT] content-main loaded on", window.location.href);

(() => {
  console.log("[FOCALS] content-script loaded on", window.location.href);

  const FOCALS_DEBUG = false;

  const DEBUG = false;
  function safeLog(...args) {
    if (DEBUG) console.warn("[FOCALS]", ...args);
  }

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

  function logStorageSnapshot() {
    try {
      chrome.storage.local.get(null, (data) => {
        console.log("FOCALS STORAGE SNAPSHOT", {
          focals_user_id: data?.focals_user_id,
          focals_jobs: data?.focals_jobs,
          focals_selectedJob: data?.focals_selectedJob,
          focals_templates: data?.focals_templates,
        });
      });
    } catch (err) {
      console.warn("[FOCALS] Failed to read storage snapshot", err);
    }
  }

  window.focalsLogStorageSnapshot = logStorageSnapshot;

  function extractMemberIdFromProfile(targetUrl) {
    try {
      const url = targetUrl || window.location.href;
      const match = url.match(/linkedin\.com\/in\/([^\/?#]+)/);
      if (match && match[1]) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return match[1];
        }
      }

      console.warn("[FOCALS] No profile slug found from URL.");
      return null;
    } catch (e) {
      console.error("[FOCALS] extractMemberIdFromProfile crashed", e);
      return null;
    }
  }

  function sendApiRequest({ endpoint, method = "GET", body, params }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "API_REQUEST",
          endpoint,
          method,
          body,
          params,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "API request failed"));
            return;
          }
          resolve(response.data);
        }
      );
    });
  }

  function getEnvInfo() {
    const href = window.location.href;
    const origin = window.location.origin;
    const hostname = window.location.hostname;
    const isTop = window === window.top;
    const isSandbox =
      document.origin === "null" ||
      window.location.origin === "null" ||
      !!window.frameElement?.hasAttribute("sandbox");

    return { href, origin, hostname, isTop, isSandbox };
  }

  const env = getEnvInfo();
  debugLog("ENV", env);

  // Surface resource loading issues to ease debugging when the LinkedIn UI blocks assets
  // (e.g. 400/410/ERR_FAILED). This runs before any early-return so we still capture errors
  // that might explain missing buttons or scrapers.
  window.addEventListener(
    "error",
    (event) => {
      const target = event?.target;
      if (!target || target === window) return;
      const url = target?.src || target?.href || target?.currentSrc;
      if (!url) return;
      console.warn("[Focals][RESOURCE_ERROR] Failed to load", url, "at", env.hostname);
    },
    true
  );

  if (!env.isTop) {
    debugLog("EXIT", "Not in top window, skipping Focals content script");
    return;
  }
  if (env.isSandbox) {
    debugLog("EXIT", "Sandboxed document, skipping Focals content script");
    return;
  }
  const isLinkedinHost = (env.hostname || "").endsWith("linkedin.com");
  if (!isLinkedinHost) {
    debugLog(
      "EXIT",
      `Not on linkedin.com (hostname = ${env.hostname || "unknown"}), skipping Focals content script`
    );
    return;
  }

  if (window.__FOCALS_CONTENT_MAIN_LOADED__) {
    debugLog("EXIT", "content-main.js already initialized");
    return;
  }
  window.__FOCALS_CONTENT_MAIN_LOADED__ = true;
  debugLog("INIT", "Safe content-main.js loaded");

  let shadowRoot = null;
  let shadowMount = null;

  function ensureShadowHost() {
    if (shadowMount && shadowRoot) return shadowMount;

    const host = document.createElement("div");
    host.id = "focals-root";
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: "open" });
    shadowMount = document.createElement("div");
    shadowMount.id = "focals-shadow-mount";
    shadowMount.style.position = "absolute";
    shadowMount.style.inset = "0";
    shadowMount.style.pointerEvents = "none";
    shadowRoot.appendChild(shadowMount);

    return shadowMount;
  }

  function getShadowElementById(id) {
    return shadowRoot?.getElementById ? shadowRoot.getElementById(id) : null;
  }

  const STORAGE_KEYS = {
    tone: "focals_userTone",
    templates: "focals_templates",
    jobs: "focals_jobs",
    selectedTemplate: "focals_selectedTemplate",
    selectedJob: "focals_selectedJob",
  };
  const PROFILE_STORAGE_KEY = "FOCALS_LAST_PROFILE";

  function getLastScrapedProfile() {
    return new Promise((resolve) => {
      chrome.storage.local.get([PROFILE_STORAGE_KEY], (result) => {
        resolve(result?.[PROFILE_STORAGE_KEY] || null);
      });
    });
  }

  let lastScrapedProfile = null;
  let lastProfileUrl = null;
  let profileStatus = "idle";
  let lastProfileMode = "unknown";
  let lastHref = window.location.href;
  let currentScrapeToken = 0;

  function setProfileStatus(status) {
    profileStatus = status;
    debugLog("PROFILE_STATUS", { status, url: window.location.href });
  }

  async function callFocalsAPI(endpoint, payload) {
    const response = await sendApiRequest({
      endpoint,
      method: "POST",
      body: payload,
    });

    if (!response) {
      debugLog("API_ERROR", { endpoint, errorMessage: "Empty response" });
      throw new Error("API response vide");
    }

    return response;
  }

  async function bootstrapUser(userId) {
    return callFocalsAPI("focals-bootstrap-user", { userId });
  }

  async function getAllData(userId) {
    return callFocalsAPI("focals-get-data", { userId });
  }

  async function upsertSettings(userId, partial) {
    return callFocalsAPI("focals-upsert-settings", { userId, ...partial });
  }

  async function upsertJob(userId, jobInput) {
    return callFocalsAPI("focals-upsert-job", { userId, job: jobInput });
  }

  async function deleteJob(userId, jobId) {
    return callFocalsAPI("focals-delete-job", { userId, jobId });
  }

  async function upsertTemplate(userId, templateInput) {
    return callFocalsAPI("focals-upsert-template", { userId, template: templateInput });
  }

  async function deleteTemplate(userId, templateId) {
    return callFocalsAPI("focals-delete-template", { userId, templateId });
  }

  async function generateReplyApi(request) {
    return callFocalsAPI("focals-generate-reply", request);
  }

  function extractReplyText(response) {
    if (!response) return null;
    if (response.reply?.text) return response.reply.text;
    if (typeof response.reply === "string") return response.reply;
    return response.replyText || null;
  }

  /**
   * Scrape l'historique de conversation depuis LinkedIn Messaging
   * @returns {{ messages: Array<{senderType: string, text: string, createdAt?: string}>, candidateFirstName?: string }}
   */
  function scrapeLinkedInConversation() {
    const conversation = {
      messages: [],
      candidateFirstName: null,
      language: null,
    };

    const messageSelectors = [
      ".msg-s-message-list__event",
      ".msg-s-message-group",
      "[data-test-conversation-panel-message]",
    ];

    let messageElements = [];
    for (const selector of messageSelectors) {
      messageElements = document.querySelectorAll(selector);
      if (messageElements.length > 0) break;
    }

    debugLog("SCRAPE_MESSAGES", { count: messageElements.length });

    messageElements.forEach((msgEl) => {
      const isFromMe =
        msgEl.classList.contains("msg-s-message-group--is-from-me") ||
        msgEl.querySelector(".msg-s-message-group__meta--link") !== null ||
        msgEl.closest("[data-test-sender-is-me]") !== null;

      const textEl =
        msgEl.querySelector(".msg-s-event-listitem__body") ||
        msgEl.querySelector(".msg-s-message-group__body") ||
        msgEl.querySelector("[data-test-message-body]");

      const text = textEl ? textEl.innerText.trim() : "";
      if (!text) return;

      const timeEl = msgEl.querySelector("time");
      const createdAt = timeEl ? timeEl.getAttribute("datetime") : undefined;
      const timestamp = createdAt || new Date().toISOString();

      conversation.messages.push({
        senderType: isFromMe ? "me" : "candidate",
        text,
        createdAt,
        timestamp,
      });
    });

    const headerNameEl = document.querySelector(
      ".msg-conversation-card__participant-names, " +
        ".msg-thread__link-to-profile, " +
        "[data-test-conversation-title]"
    );
    if (headerNameEl) {
      const fullName = headerNameEl.innerText.trim();
      const [firstName] = fullName.split(/\s+/);
      conversation.candidateFirstName = firstName;
    }

    const allText = conversation.messages.map((m) => m.text).join(" ").toLowerCase();
    const frenchKeywords = ["bonjour", "merci", "je", "vous", "poste", "entretien"];
    const frenchCount = frenchKeywords.filter((kw) => allText.includes(kw)).length;
    conversation.language = frenchCount >= 2 ? "fr" : "en";

    return conversation;
  }

  /**
   * Envoie une requête de génération de réponse au background script
   * @param {Object} options
   * @param {string} [options.toneOverride] - "professional" | "warm" | "direct" | "very_formal"
   * @param {string} [options.jobId] - UUID du job
   * @param {string} [options.templateId] - UUID du template
   * @param {string} [options.promptReply] - Instructions custom pour le backend
   * @returns {Promise<{success: boolean, replyText?: string, error?: string}>}
   */
  async function generateReply(options) {
    const { toneOverride, jobId, templateId, promptReply } = options;

    const storage = await chrome.storage.local.get([USER_ID_STORAGE_KEY]);
    let userId = storage[USER_ID_STORAGE_KEY];

    if (!userId) {
      try {
        userId = await getOrCreateUserId();
      } catch (err) {
        debugLog("GENERATE_REPLY", "userId non trouvé et création échouée");
        return { success: false, error: "Utilisateur non connecté à Focals" };
      }
    }

    // Scrape la conversation LinkedIn pour constituer le payload envoyé au background
    const conversation = scrapeLinkedInConversation();

    if (!conversation?.messages?.length) {
      console.error("[Focals][ERROR][SCRAPE_CONVERSATION] Aucun message trouvé dans la conversation", {
        conversation,
      });
      debugLog("GENERATE_REPLY", "Aucun message trouvé dans la conversation");
      return { success: false, error: "Aucun message trouvé" };
    }

    const normalizedPromptReply = promptReply ? promptReply.trim() : null;

    const lastMessages = getLastMessagesForBackend(conversation.messages, 3).map((msg) => ({
      text: msg.text,
      fromMe: msg.senderType === "me",
      timestampRaw: msg.createdAt || msg.timestamp || msg.timestampRaw || new Date().toISOString(),
    }));

    const messagePayload = {
      type: "GENERATE_REPLY",
      userId,
      messages: lastMessages,
      context: {
        language: conversation.language,
        tone: toneOverride || undefined,
        candidateName: conversation.candidateFirstName || null,
        systemPromptOverride: normalizedPromptReply,
      },
      toneOverride,
      jobId,
      templateId,
    };

    console.log("[Focals][CONTENT] GENERATE_REPLY payload", {
      userId,
      conversationLength: lastMessages?.length,
      hasPromptReply: !!normalizedPromptReply,
      toneOverride,
      jobId,
      templateId,
    });

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(messagePayload, (response) => {
        if (chrome.runtime.lastError) {
          debugLog("GENERATE_REPLY_ERROR", chrome.runtime.lastError.message);
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  let conversationInitialized = false;
  const hasMessagingUi = () => {
    const pathnameMatch = /\/messaging\//.test(window.location.pathname);
    const overlaySelector = [
      ".msg-overlay-list-bubble",
      ".msg-overlay-conversation-bubble",
      ".msg-overlay-container",
    ].join(", ");
    const hasOverlay = !!document.querySelector(overlaySelector);

    console.log("[FOCALS] detectMessagingMode – pathnameMatch:", pathnameMatch, "hasOverlay:", hasOverlay);

    return pathnameMatch || hasOverlay;
  };

  const maybeInitConversationFlow = async () => {
    if (conversationInitialized) return;
    conversationInitialized = true;
    await initConversationFlow();
  };

  const messagingObserver = new MutationObserver(() => {
    if (hasMessagingUi()) {
      setTimeout(() => {
        maybeInitConversationFlow();
      }, 500);
    }
  });

  messagingObserver.observe(document.body, { childList: true, subtree: true });

  const USER_ID_STORAGE_KEY = "focals_user_id";
  let cachedUserId = null;

  async function getOrCreateUserId() {
    if (cachedUserId) return cachedUserId;
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get([USER_ID_STORAGE_KEY], (result) => {
          const existing = result?.[USER_ID_STORAGE_KEY];
          if (existing && typeof existing === "string") {
            cachedUserId = existing;
            resolve(existing);
            return;
          }
          const newId = crypto.randomUUID();
          chrome.storage.local.set({ [USER_ID_STORAGE_KEY]: newId }, () => {
            cachedUserId = newId;
            resolve(newId);
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  const DEFAULT_TONE = "professional";
  const LANGUAGE_MARKERS = {
    fr: ["je", "vous", "merci", "bien", "bonjour", "j'", "n'", "est", "suis"],
    en: [" i ", " you ", "the", "and", "thanks", "hi", "hello", "not", "am"],
  };

  function normalizeSpace(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getLastMessagesForBackend(allMessages, limit = 3) {
    if (!Array.isArray(allMessages)) return [];

    const sorted = [...allMessages].sort((a, b) => {
      const aDate = a.timestampRaw || a.timestamp;
      const bDate = b.timestampRaw || b.timestamp;
      if (aDate && bDate) {
        return new Date(aDate) - new Date(bDate);
      }
      return 0;
    });

    return sorted.slice(-limit);
  }

  const q = (selector) => document.querySelector(selector);
  const getText = (el) => (el ? el.innerText.trim() : "");
  const getAttr = (el, attr) => (el ? el.getAttribute(attr) : "");
  const pickText = (...selectors) => {
    for (const selector of selectors) {
      const value = getText(q(selector));
      if (value) return value;
    }
    return "";
  };
  const pickAttr = (selectors, attr) => {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = q(selector);
      if (el) {
        const value = el.getAttribute(attr);
        if (value) return value.trim();
      }
    }
    return "";
  };
  const pickTextFrom = (root, selectors) => {
    if (!root) return "";
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = root.querySelector(selector);
      if (el) {
        const text = getText(el);
        if (text) return text;
      }
    }
    return "";
  };
  const normalizeText = (text = "") => text.replace(/\s+/g, " ").trim();
  const firstNonEmpty = (...values) => values.find((v) => normalizeText(v)) || "";

  const isConnectionActivityText = (text = "") => {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) return false;
    const markers = [
      /nouvelle? relation/,
      /new connection/,
      /vous [eê]tes (?:maintenant )?en relation/,
      /is (?:now )?a new connection/,
    ];
    return markers.some((regex) => regex.test(normalized));
  };

  let linkedinScraper = window.__FocalsLinkedinScraper || {};

  const waitForScraper = (retries = 10, delay = 500) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const scraper = window.__FocalsLinkedinScraper;
        if (scraper) {
          resolve(scraper);
        } else if (retries > 0) {
          retries -= 1;
          setTimeout(check, delay);
        } else {
          reject(new Error("Scraper not found after timeout"));
        }
      };
      check();
    });

  function hasInlineRecruiterProfileCard() {
    return !!document.querySelector("section.artdeco-card.pv-profile-card");
  }

  const detectedMode = linkedinScraper.isPipelineProfile?.()
    ? "recruiter_pipeline"
    : linkedinScraper.isRecruiterProfile?.()
      ? "recruiter_profile"
      : /linkedin\.com\/in\//i.test(window.location.href)
        ? "public_profile"
        : "other";
  debugLog("ENV_MODE", { href: window.location.href, mode: detectedMode });

  const cacheProfile = (profile, source = "profile") => {
    if (!profile) return;
    try {
      chrome.storage.local.set(
        { [PROFILE_STORAGE_KEY]: { ...profile, experiences: (profile.experiences || []).slice(0, 6) } },
        () => {
          console.log(`[Focals][PROFILE] Saved ${source} profile`, {
            url: profile.linkedin_url,
            name: profile.name,
            currentTitle: profile.current_title,
            currentCompany: profile.current_company,
            experiencesCount: profile.experiences?.length || 0,
          });
        }
      );
    } catch (err) {
      debugLog("PROFILE_CACHE_ERROR", err?.message || String(err));
    }
  };

  const clearCachedProfile = () => {
    try {
      chrome.storage.local.remove([PROFILE_STORAGE_KEY]);
    } catch (err) {
      debugLog("PROFILE_CACHE_CLEAR_ERROR", err?.message || String(err));
    }
  };

  const isProfileUsable = (profile) => {
    if (!profile) return false;
    const name = normalizeText(profile.name || "");
    const title = normalizeText(profile.current_title || profile.headline || "");
    const company = normalizeText(profile.current_company || "");
    const hasExperiences = Array.isArray(profile.experiences) && profile.experiences.length > 0;
    return !!(name && (title || company || hasExperiences));
  };

  const isProfilePage = (href = window.location.href) => {
    if (typeof linkedinScraper.isRecruiterProfile === "function" && linkedinScraper.isRecruiterProfile()) {
      return true;
    }
    if (typeof linkedinScraper.isPipelineProfile === "function" && linkedinScraper.isPipelineProfile()) {
      return true;
    }
    return /linkedin\.com\/in\//i.test(href);
  };

  function cleanNameText(text) {
    if (!text) return "";
    const collapsed = text.replace(/\s+/g, " ");
    const withoutEmoji = collapsed.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
    return withoutEmoji.replace(/[^\p{L}\s\-']/gu, "").trim();
  }

  function extractFirstName(fullName) {
    if (!fullName) return null;
    const tokens = fullName
      .split(" ")
      .map((t) => t.trim())
      .filter(Boolean);
    const prefixes = ["mr", "m", "mme", "mrs", "ms", "dr", "m.", "mme."];
    const usable = tokens.filter((t) => !prefixes.includes(t.toLowerCase()));
    if (!usable.length) return null;
    const first = usable[0];
    if (!first) return null;
    const second = usable[1];
    if (second && /^[A-ZÀ-ÖØ-Ý]/.test(second) && second.length < 12) {
      return `${first} ${second}`;
    }
    return first;
  }

  function detectCandidateFirstNameFromDom() {
    const headerNode = document.querySelector("h2.msg-overlay-bubble-header__title .hoverable-link-text");
    const metaNode = document.querySelector(".msg-s-message-group__meta .msg-s-message-group__name");
    const headerText = headerNode?.innerText || headerNode?.textContent || "";
    const metaText = metaNode?.innerText || metaNode?.textContent || "";
    debugLog("NAME_HEADER_RAW", headerText);
    debugLog("NAME_META_RAW", metaText);

    const cleanedHeaderName = cleanNameText(headerText);
    const cleanedMetaName = cleanNameText(metaText);
    debugLog("NAME_HEADER_CLEAN", cleanedHeaderName);
    debugLog("NAME_META_CLEAN", cleanedMetaName);

    const headerFirst = extractFirstName(cleanedHeaderName);
    const metaFirst = extractFirstName(cleanedMetaName);

    const normalize = (value) =>
      (value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    let firstName = null;
    let source = "none";
    let confidence = 0;

    if (headerFirst && metaFirst && normalize(headerFirst) === normalize(metaFirst)) {
      firstName = headerFirst;
      source = "both";
      confidence = 0.9;
    } else if (headerFirst) {
      firstName = headerFirst;
      source = "header";
      confidence = 0.7;
    } else if (metaFirst) {
      firstName = metaFirst;
      source = "meta";
      confidence = 0.7;
    }

    debugLog("NAME_FINAL", { firstName, source, confidence });
    return { fullHeaderName: cleanedHeaderName || null, fullMetaName: cleanedMetaName || null, firstName, source, confidence };
  }

  function countMarkers(text, markers) {
    const lower = ` ${normalizeSpace(text).toLowerCase()} `;
    let count = 0;
    markers.forEach((word) => {
      const regex = new RegExp(word.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g");
      const matches = lower.match(regex);
      if (matches) count += matches.length;
    });
    return count;
  }

  async function detectLanguage(text) {
    const snippet = (text || "").slice(0, 200);
    const frCount = countMarkers(text, LANGUAGE_MARKERS.fr);
    const enCount = countMarkers(text, LANGUAGE_MARKERS.en);
    let heuristic = "unknown";
    if (frCount > enCount * 2 && frCount >= 1) heuristic = "fr";
    if (enCount > frCount * 2 && enCount >= 1) heuristic = "en";
    if (heuristic === "fr" || heuristic === "en") {
      debugLog("LANG_DETECTION", { snippet, heuristic, result: heuristic });
      return heuristic;
    }

    let gptResult = "unknown";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "FOCALS_ASK_GPT",
        prompt: `Detect the language of this message and respond with exactly 'fr' or 'en'.\nMessage: ${text}`,
        system: "You are a strict language detector. Only answer fr or en.",
        temperature: 0,
        maxTokens: 4,
      });
      if (response && (response.content === "fr" || response.content === "en")) {
        gptResult = response.content;
      }
    } catch (err) {
      debugLog("LANG_GPT_ERROR", err?.message || String(err));
    }

    debugLog("LANG_DETECTION", { snippet, heuristic, result: gptResult });
    if (gptResult === "fr" || gptResult === "en") return gptResult;
    return "unknown";
  }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "FOCALS_GET_PROFILE") {
        debugLog("MSG_GET_PROFILE", { hasProfile: !!lastScrapedProfile, status: profileStatus });
        const isPipelineMode = lastProfileMode === "pipeline";
        sendResponse({
          profile: isPipelineMode ? null : lastScrapedProfile,
          pipeline: isPipelineMode ? lastScrapedProfile : null,
          status: isPipelineMode ? "unsupported" : profileStatus,
          url: lastProfileUrl,
          mode: lastProfileMode,
          message: isPipelineMode
            ? "Cette page LinkedIn Recruiter n’est pas encore supportée pour l’aperçu de profil."
            : "",
        });
        return true;
      }
    if (message?.type === "FOCALS_FORCE_RESCRAPE") {
      debugLog("PROFILE_FORCE_RESCRAPE", { url: window.location.href });
      triggerProfileScrape(true);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  function parseCompanyAndContract(rawText = "") {
    const normalized = normalizeText(rawText);
    if (!normalized) return { company: "", contract: "" };
    const contractMatch = normalized.match(/(freelance|cdi|cdd|internship|stage|contract|apprentissage|alternance)/i);
    const contract = contractMatch ? contractMatch[1] : "";
    const withoutContract = normalized.replace(contractMatch ? contractMatch[0] : "", "").trim();
    return { company: withoutContract || normalized, contract: contract || "" };
  }

  function inferCurrentRole(headline = "", fallback = "") {
    const parts = normalizeText(headline).split("·");
    if (parts.length) {
      return parts[0] || fallback;
    }
    return fallback || headline;
  }

  function scrapeProfileFromDom() {
    const profileSlug = extractMemberIdFromProfile();
    const rawName =
      pickText(
        ".pv-text-details__left-panel h1",
        "div[data-view-name='profile-card'] h1",
        "main section h1.inline.t-24.v-align-middle.break-words",
        "h1.inline.t-24.v-align-middle.break-words",
        "a[href*='/overlay/about-this-profile/'] h1",
        ".text-heading-xlarge",
        "h1"
      ) ||
      pickAttr(
        [
          "a[href*='/overlay/about-this-profile/']",
          "a[href*='overlay/about-this-profile']",
          "a[href*='/overlay/contact-info/']",
        ],
        "aria-label"
      ) ||
      "";

    const name = normalizeText(rawName) || "—";
    const [firstName, ...restName] = name.split(/\s+/);
    const lastName = normalizeText(restName.join(" "));

    const headline =
      pickText(
        ".pv-text-details__left-panel .text-body-medium.break-words",
        ".text-body-medium.break-words",
        "div[data-view-name='profile-card'] .text-body-medium",
        ".display-flex.full-width .hoverable-link-text span[aria-hidden='true']",
        ".display-flex.full-width .hoverable-link-text"
      ) || "";

    const localisation =
      getText(q(".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words")) ||
      getText(q(".text-body-small.inline.t-black--light.break-words")) ||
      getText(q("div[data-view-name='profile-card'] .text-body-small")) ||
      "";

    const photo_url =
      getAttr(q(".pv-top-card-profile-picture__image"), "src") ||
      getAttr(q("img.pv-top-card-profile-picture__image--show"), "src") ||
      getAttr(q('meta[property="og:image"]'), "content") ||
      "";

    const topCardCompanyRaw =
      pickText(
        ".pv-text-details__left-panel .inline.t-16.t-black.t-normal span[aria-hidden='true']",
        ".pv-text-details__left-panel .inline.t-16.t-black.t-normal",
        ".display-flex.full-width .t-14.t-normal span[aria-hidden='true']",
        ".display-flex.full-width .t-14.t-normal",
        "div[data-view-name='profile-card'] .t-14.t-normal span[aria-hidden='true']",
        "div[data-view-name='profile-card'] .t-14.t-normal"
      ) ||
      pickAttr(
        [
          "div[data-view-name='profile-card'] a[href*='/company/']",
          "div[data-view-name='profile-card'] a[href*='/school/']",
          ".pv-text-details__left-panel a[href*='/company/']",
        ],
        "aria-label"
      );

    const topCardCompany = parseCompanyAndContract(topCardCompanyRaw);
    let current_company = topCardCompany.company;
    let contract = topCardCompany.contract;
    let current_title = headline || "";

    const experienceSection = (() => {
      const anchor = q("#experience");
      if (anchor) {
        const section = anchor.closest("section");
        if (section) return section;
      }
      const cards = Array.from(document.querySelectorAll("section.artdeco-card"));
      for (const card of cards) {
        const heading = pickTextFrom(card, ["h2 span[aria-hidden='true']", "h2"]);
        if (heading && /expérience/i.test(heading)) {
          return card;
        }
      }
      return null;
    })();

    const experiences = [];
    if (experienceSection) {
      const entityNodes = Array.from(
        experienceSection.querySelectorAll("div[data-view-name='profile-component-entity']")
      ).slice(0, 6);

      const firstEntity = entityNodes[0] || null;
      if (firstEntity) {
        const roleText = pickTextFrom(firstEntity, [
          ".hoverable-link-text.t-bold span[aria-hidden='true']",
          ".hoverable-link-text.t-bold",
          ".t-bold span[aria-hidden='true']",
          ".t-bold",
        ]);
        const companyText = pickTextFrom(firstEntity, [
          ".t-14.t-normal span[aria-hidden='true']",
          ".t-14.t-normal",
        ]);
        if (roleText) current_title = normalizeText(roleText);
        if (companyText) {
          const parsed = parseCompanyAndContract(companyText);
          current_company = parsed.company || current_company;
          contract = parsed.contract || contract;
        }
      }

      entityNodes.forEach((entity) => {
        const title = normalizeText(
          pickTextFrom(entity, [
            ".hoverable-link-text.t-bold span[aria-hidden='true']",
            ".hoverable-link-text.t-bold",
            ".t-bold span[aria-hidden='true']",
            ".t-bold",
          ]) || ""
        );
        const companyText = pickTextFrom(entity, [
          ".t-14.t-normal span[aria-hidden='true']",
          ".t-14.t-normal",
        ]);
        let company = normalizeText(companyText || "");
        if (!company) {
          const parentCompany = pickTextFrom(entity.closest("li.artdeco-list__item, li"), [
            ".t-14.t-normal span[aria-hidden='true']",
            ".t-14.t-normal",
          ]);
          company = normalizeText(parentCompany || "");
        }

        const metadataText = normalizeText(
          pickTextFrom(entity, [
            ".t-14.t-normal.t-black--light .pvs-entity__caption-wrapper span[aria-hidden='true']",
            ".t-14.t-normal.t-black--light span[aria-hidden='true']",
            ".t-14.t-normal.t-black--light",
          ]) || ""
        );

        let dateText = metadataText;
        let location = "";
        if (metadataText.includes("·")) {
          const [maybeDates, ...rest] = metadataText.split("·").map(normalizeText);
          dateText = maybeDates;
          location = rest.filter(Boolean).join(" · ");
        }

        let start = "";
        let end = "";
        const rangeSeparator = dateText.includes("–") ? "–" : dateText.includes("-") ? "-" : null;
        if (dateText && rangeSeparator) {
          const [from, to] = dateText.split(rangeSeparator);
          start = normalizeText(from || "");
          end = normalizeText(to || "");
        }

        if (isConnectionActivityText(title) || isConnectionActivityText(company)) {
          return;
        }

        if (title || company) {
          experiences.push({
            title: title || "",
            company: company || "",
            start: start || dateText || "",
            end: end || "",
            location,
          });
        }
      });
    }

    if (!current_title) {
      current_title = inferCurrentRole(headline, "");
    }

    const linkedinUrl = profileSlug ? `https://www.linkedin.com/in/${profileSlug}` : location.href;

    const profile = {
      name: name || "—",
      firstName: normalizeText(firstName),
      lastName: lastName || "",
      headline: normalizeText(headline),
      current_title: normalizeText(current_title) || "—",
      current_company: normalizeText(current_company) || "—",
      contract: normalizeText(contract) || "—",
      localisation: normalizeText(localisation) || "—",
      linkedin_url: linkedinUrl,
      profile_slug: profileSlug || "",
      photo_url: photo_url || "",
      experiences,
    };

    lastScrapedProfile = profile;
    lastProfileUrl = window.location.href;
    debugLog("PROFILE_SCRAPED", profile);
    cacheProfile(profile, "public");
    return profile;
  }

  function scrapeInlineRecruiterProfileFromDom() {
    const card = document.querySelector("section.artdeco-card.pv-profile-card");
    if (!card) return null;

    const rawName =
      pickTextFrom(card, ["h1", ".pv-text-details__left-panel h1", "header h1"]) || "";
    const name = normalizeText(rawName) || "—";
    const [firstName, ...restName] = name.split(/\s+/);
    const lastName = normalizeText(restName.join(" "));

    const headline =
      pickTextFrom(card, [
        ".text-body-medium.break-words",
        ".pv-text-details__left-panel .text-body-medium",
      ]) || "";

    const experiences = [];
    const entityNodes = Array.from(
      card.querySelectorAll("div[data-view-name='profile-component-entity']")
    ).slice(0, 6);

    let current_title = "";
    let current_company = "";

    entityNodes.forEach((entity, index) => {
      const title = normalizeText(
        pickTextFrom(entity, [
          ".hoverable-link-text.t-bold span[aria-hidden='true']",
          ".hoverable-link-text.t-bold",
          ".t-bold span[aria-hidden='true']",
          ".t-bold",
        ]) || ""
      );
      const companyText = pickTextFrom(entity, [
        ".t-14.t-normal span[aria-hidden='true']",
        ".t-14.t-normal",
      ]);
      let company = normalizeText(companyText || "");
      if (!company) {
        const parentCompany = pickTextFrom(entity.closest("li.artdeco-list__item, li"), [
          ".t-14.t-normal span[aria-hidden='true']",
          ".t-14.t-normal",
        ]);
        company = normalizeText(parentCompany || "");
      }

      const metadataText = normalizeText(
        pickTextFrom(entity, [
          ".t-14.t-normal.t-black--light .pvs-entity__caption-wrapper span[aria-hidden='true']",
          ".t-14.t-normal.t-black--light span[aria-hidden='true']",
          ".t-14.t-normal.t-black--light",
        ]) || ""
      );

      let dateText = metadataText;
      let location = "";
      if (metadataText.includes("·")) {
        const [maybeDates, ...rest] = metadataText.split("·").map(normalizeText);
        dateText = maybeDates;
        location = rest.filter(Boolean).join(" · ");
      }

      let start = "";
      let end = "";
      const rangeSeparator = dateText.includes("–") ? "–" : dateText.includes("-") ? "-" : null;
      if (dateText && rangeSeparator) {
        const [from, to] = dateText.split(rangeSeparator);
        start = normalizeText(from || "");
        end = normalizeText(to || "");
      }

      if (title || company) {
        experiences.push({
          title: title || "",
          company: company || "",
          start: start || dateText || "",
          end: end || "",
          location,
        });
      }

      if (index === 0) {
        current_title = title || current_title;
        current_company = company || current_company;
      }
    });

    if (!current_title) {
      current_title = inferCurrentRole(headline, experiences[0]?.title || "");
    }

    const profile = {
      name,
      firstName: normalizeText(firstName),
      lastName: lastName || "",
      headline: normalizeText(headline),
      current_title: normalizeText(current_title) || "—",
      current_company: normalizeText(current_company) || "—",
      contract: "",
      localisation: "",
      linkedin_url: window.location.href,
      profile_slug: "",
      photo_url: "",
      experiences,
    };

    lastScrapedProfile = profile;
    lastProfileUrl = window.location.href;
    cacheProfile(profile, "recruiter_inline");

    return profile;
  }

  const PROFILE_READY_SELECTORS = [
    ".pv-text-details__left-panel h1",
    "div[data-view-name='profile-card'] h1",
    "main section h1.inline.t-24.v-align-middle.break-words",
    "h1.inline.t-24.v-align-middle.break-words",
    "a[href*='/overlay/about-this-profile/'] h1",
    ".text-heading-xlarge",
    "main .pv-text-details__left-panel",
  ];

    async function runProfileScrape(force = false) {
      if (!isProfilePage() && !hasInlineRecruiterProfileCard()) {
        lastScrapedProfile = null;
        lastProfileUrl = null;
        lastProfileMode = "none";
        setProfileStatus("idle");
        return;
      }

    if (!force && profileStatus === "ready" && lastProfileUrl === window.location.href) {
      return;
    }

    const token = ++currentScrapeToken;
    lastScrapedProfile = null;
    lastProfileUrl = window.location.href;
    setProfileStatus("loading");

    try {
      const domReady =
        typeof linkedinScraper.waitForDom === "function"
          ? await linkedinScraper.waitForDom()
          : await new Promise((resolve) => {
              const fallbackReady = PROFILE_READY_SELECTORS.some((selector) => document.querySelector(selector));
              resolve(fallbackReady);
            });
      if (token !== currentScrapeToken) return;
      if (!domReady) {
        setProfileStatus("error");
        return;
      }

      const source = linkedinScraper.isPipelineProfile?.()
        ? "pipeline"
        : linkedinScraper.isRecruiterProfile?.()
          ? "recruiter"
          : hasInlineRecruiterProfileCard()
            ? "recruiter_inline"
            : "public";
      debugLog("PROFILE_SOURCE", { source, url: window.location.href });
      lastProfileMode = source;

      let profile = null;
      if (source === "pipeline" && typeof linkedinScraper.scrapeRecruiterPipeline === "function") {
        profile = await linkedinScraper.scrapeRecruiterPipeline({ expectedTotal: 25 });
      } else if (source === "recruiter" && typeof linkedinScraper.scrapePublicProfile === "function") {
        profile = linkedinScraper.scrapePublicProfile();
      } else if (source === "recruiter_inline") {
        profile = scrapeInlineRecruiterProfileFromDom();
      } else if (typeof linkedinScraper.scrapePublicProfile === "function") {
        profile = linkedinScraper.scrapePublicProfile();
      } else {
        profile = scrapeProfileFromDom();
      }

      if ((!profile || !profile.name) && typeof linkedinScraper.scrapePublicProfileDomFallback === "function") {
        console.log("[FOCALS] Voyager empty, using DOM fallback");
        profile = linkedinScraper.scrapePublicProfileDomFallback();
      }

      lastScrapedProfile = profile;
      debugLog("PROFILE_SCRAPED", { source: "historical", profile });
      if (token === currentScrapeToken) {
        if (isProfileUsable(profile)) {
          cacheProfile(profile, source);
          setProfileStatus("ready");
        } else {
          clearCachedProfile();
          setProfileStatus("error");
        }
      }
    } catch (err) {
      debugLog("PROFILE_SCRAPE_ERROR", err?.message || String(err));
      if (token === currentScrapeToken) {
        setProfileStatus("error");
      }
    }
  }

  const triggerProfileScrape = async (force = false) => {
    console.log("%c[FOCALS] Scraper SDUI V3 - Démarrage...", "background: #0077b5; color: white; font-weight: bold; padding: 4px;");

    // Fonction d'attente d'élément (Timeboxée à 5s)
    const waitForElement = (selector, timeout = 5000) => {
      return new Promise((resolve) => {
        if (document.querySelector(selector)) return resolve(document.querySelector(selector));
        const observer = new MutationObserver((mutations, obs) => {
          if (document.querySelector(selector)) { obs.disconnect(); resolve(document.querySelector(selector)); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
      });
    };

    try {
      // 1. Attente de l'affichage du Nom (Preuve que le profil est chargé)
      const nameEl = await waitForElement("h1, .text-heading-xlarge");
      if (!nameEl) console.warn("[FOCALS] ⚠️ Nom introuvable (Scraping continué malgré tout).");

      // Pause de sécurité pour laisser React finir le rendu des listes
      await new Promise(r => setTimeout(r, 1500)); 

      const main = document.querySelector("main") || document.body;
      const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').trim() : "";

      // --- HELPER 1 : Détection du type de contrat ---
      const detectContract = (text) => {
          if (!text) return "";
          const lower = text.toLowerCase();
          if (lower.includes("cdi") || lower.includes("full-time") || lower.includes("permanent")) return "CDI";
          if (lower.includes("cdd") || lower.includes("contract") || lower.includes("fixed-term") || lower.includes("déterminé")) return "CDD";
          if (lower.includes("freelance") || lower.includes("indépendant")) return "Freelance";
          if (lower.includes("stage") || lower.includes("internship")) return "Stage";
          if (lower.includes("alternance") || lower.includes("apprenti") || lower.includes("apprentissage") || lower.includes("professionalisation")) return "Alternance";
          return "";
      };

      // --- HELPER 2 : Extraction Entreprise via Logo (Priorité Absolue) ---
      const getCompanyFromLogo = (container) => {
          const img = container.querySelector("img[alt^='Logo de'], img[alt^='Logo']");
          if (img && img.alt) {
              return img.alt.replace("Logo de ", "").replace("Logo ", "").trim();
          }
          return "";
      };

      // --- HELPER 3 : Logique d'Héritage (Le Secret du Fix) ---
      // Récupère les infos (Entreprise, Contrat, Lieu) depuis le header au-dessus de la liste
      const getParentHeaderData = (liElement) => {
          const parentUl = liElement.closest("ul");
          if (!parentUl) return {};

          // Le header est l'élément juste avant le UL
          const headerDiv = parentUl.previousElementSibling;
          if (!headerDiv) return {};

          // 1. Entreprise
          let company = getCompanyFromLogo(headerDiv);
          if (!company) {
               // Fallback texte : souvent dans un paragraphe spécifique du header
               const p = headerDiv.querySelector("div > div > div > p");
               if (p) company = cleanText(p.innerText);
          }
          
          // 2. Contrat & Lieu (Scan de tous les textes du header)
          const headerTexts = [...headerDiv.querySelectorAll("p, span")].map(el => el.innerText);
          let contract = "";
          let location = "";
          
          headerTexts.forEach(txt => {
              if (!contract) contract = detectContract(txt);
              if (!location && (txt.includes("France") || txt.includes("Paris") || txt.includes("Région"))) location = txt;
          });

          return { company, contract, location };
      };

      // --- 2. RECHERCHE DE LA SECTION EXPÉRIENCE ---
      const allSections = [...main.querySelectorAll("section")];
      const expSection = allSections.find(sec => {
          const h2 = sec.querySelector("h2");
          return h2 && /exp[ée]rience/i.test(h2.innerText);
      });

      let experiences = [];
      
      if (expSection) {
          // On cible les éléments de liste (li)
          const items = [...expSection.querySelectorAll("ul > li")];
          console.log(`[FOCALS] 📋 ${items.length} expériences trouvées.`);

          experiences = items.map((item) => {
              // A. Données Locales (dans le li)
              const localParagraphs = [...item.querySelectorAll("p, span[aria-hidden='true']")];
              const localTexts = localParagraphs.map(p => cleanText(p.innerText)).filter(t => t.length > 0);
              
              // B. Données Héritées (depuis le header parent)
              const inherited = getParentHeaderData(item);

              // --- CONSTRUCTION INTELLIGENTE ---
              
              // TITRE : Toujours le 1er texte local
              let title = localTexts[0] || "";

              // ENTREPRISE : Héritée > Logo Local > Texte Local (2eme pos)
              let company = inherited.company; 
              if (!company) company = getCompanyFromLogo(item);
              if (!company && localTexts[1] && !localTexts[1].match(/\d{4}/)) company = localTexts[1];

              // CONTRAT : Hérité > Local
              let contract = inherited.contract;
              if (!contract) {
                  localTexts.forEach(t => { if (!contract) contract = detectContract(t); });
              }

              // DATE & LIEU : Scan local + Fallback hérité pour le lieu
              let dateRange = "";
              let location = inherited.location || "";
              
              localTexts.forEach(txt => {
                  // Date : contient une année (4 chiffres) ou "aujourd'hui"
                  if ((txt.match(/\d{4}/) || txt.toLowerCase().includes("aujourd’hui") || txt.toLowerCase().includes("present")) && !dateRange) {
                      dateRange = txt;
                  }
                  // Lieu : mots clés géographiques
                  if (!location && (txt.includes("France") || txt.includes("Paris") || txt.includes("Région"))) {
                      location = txt;
                  }
              });

              // Nettoyage final de la date (si le contrat est collé dedans ex: "CDI · 2 ans")
              if (dateRange && dateRange.includes("·")) {
                  const parts = dateRange.split("·").map(s => s.trim());
                  if (detectContract(parts[0])) {
                      // Si la première partie est un contrat, on le capture (si manquant) et on l'enlève de la date
                      if (!contract) contract = detectContract(parts[0]);
                      dateRange = parts.filter(p => !detectContract(p)).join(" · ");
                  }
              }

              // Ignorer les éléments vides
              if (!title) return null;

              return {
                  title: title,
                  company: company || "Entreprise inconnue",
                  contract_type: contract || "Non spécifié",
                  dates: dateRange,
                  location: location,
                  description: item.innerText // Snippet complet pour le contexte LLM
              };
          }).filter(Boolean);

      } else {
          console.error("[FOCALS] ❌ Section Expérience introuvable (DOM structure inconnue).");
      }

      // --- 3. RETOUR DU RÉSULTAT GLOBAL ---
      const result = {
        name: nameEl ? cleanText(nameEl.innerText) : document.title.split("|")[0].trim(),
        headline: document.querySelector(".text-body-medium")?.innerText.trim() || "",
        localisation: document.querySelector(".text-body-small.inline")?.innerText.trim() || "",
        experiences: experiences,
        // Le job actuel est le premier de la liste
        current_job: experiences[0] || {}, 
        linkedinProfileUrl: window.location.href.split("?")[0],
        source: "focals-scraper-sdui-v3"
      };

      // Compatibilité
      result.current_company = result.current_job.company || "—";

      console.log("%c[FOCALS] ✅ SCRAPING TERMINÉ & RÉUSSI", "background: green; color: white; padding: 4px;", result);

      // Sauvegarde
      if (result.name) {
         chrome.storage.local.set({ "FOCALS_LAST_PROFILE": result });
         // Si tu as une fonction d'update UI, appelle-la ici :
         // updateFocalsPanel(result);
      }

      return result;

    } catch (e) {
      console.error("[FOCALS] 💥 Erreur Critique Scraper:", e);
      return null;
    }
  };

  setProfileStatus(isProfilePage() || hasInlineRecruiterProfileCard() ? "loading" : "idle");
  if (isProfilePage() || hasInlineRecruiterProfileCard()) {
    triggerProfileScrape(true);
  }

  setInterval(() => {
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      debugLog("PROFILE_URL_CHANGED", { from: lastHref, to: currentHref });
      lastHref = currentHref;
      if (isProfilePage(currentHref) || hasInlineRecruiterProfileCard()) {
        triggerProfileScrape(true);
      } else {
        lastScrapedProfile = null;
        lastProfileUrl = null;
        setProfileStatus("idle");
      }
    }
  }, 1000);

  let cachedBootstrap = null;

  async function getUserId() {
    return getOrCreateUserId();
  }

  async function loadBootstrapData() {
    if (cachedBootstrap) return cachedBootstrap;
    const userId = await getUserId();
    try {
      cachedBootstrap = await bootstrapUser(userId);

      const needsEnrichment =
        !Array.isArray(cachedBootstrap?.jobs) ||
        !cachedBootstrap.jobs.length ||
        !Array.isArray(cachedBootstrap?.templates) ||
        !cachedBootstrap.templates.length;
      if (needsEnrichment) {
        try {
          const fullData = await getAllData(userId);
          cachedBootstrap = {
            ...cachedBootstrap,
            ...fullData,
            templates: Array.isArray(fullData?.templates)
              ? fullData.templates
              : cachedBootstrap?.templates || [],
            jobs: Array.isArray(fullData?.jobs)
              ? fullData.jobs
              : cachedBootstrap?.jobs || [],
          };
          debugLog("BOOTSTRAP_ENRICHED", {
            templates: cachedBootstrap.templates?.length || 0,
            jobs: cachedBootstrap.jobs?.length || 0,
          });
        } catch (err) {
          debugLog("BOOTSTRAP_ENRICH_ERROR", err?.message || String(err));
        }
      }
    } catch (err) {
      debugLog("BOOTSTRAP_ERROR", err?.message || String(err));
      throw err;
    }
    return cachedBootstrap;
  }

  async function ensureConfigAvailable() {
    const readStorage = () =>
      new Promise((resolve, reject) => {
        try {
          chrome.storage.local.get(null, (data) => resolve(data || {}));
        } catch (err) {
          reject(err);
        }
      });

    let data = {};
    try {
      data = await readStorage();
    } catch (err) {
      console.warn("[FOCALS] Impossible de lire le storage", err);
      return { ok: true, missing: ["storage_read_error"] };
    }

    let jobs = Array.isArray(data.focals_jobs) ? data.focals_jobs : [];
    let templates = Array.isArray(data.focals_templates) ? data.focals_templates : [];
    let selectedJob = data.focals_selectedJob || null;

    const needsHydration = !jobs.length || !templates.length || !selectedJob;
    if (needsHydration) {
      try {
        const bootstrap = await loadBootstrapData();
        if (!jobs.length && Array.isArray(bootstrap?.jobs)) {
          jobs = bootstrap.jobs;
        }
        if (!templates.length && Array.isArray(bootstrap?.templates)) {
          templates = bootstrap.templates;
        }
        if (!selectedJob) {
          selectedJob = bootstrap?.settings?.default_job_id || null;
        }
        chrome.storage.local.set({
          focals_jobs: jobs,
          focals_templates: templates,
          focals_selectedJob: selectedJob,
        });
      } catch (err) {
        debugLog("CONFIG_HYDRATION_ERROR", err?.message || String(err));
      }
    }

    const missing = [];
    if (!Array.isArray(jobs) || jobs.length === 0) {
      missing.push("focals_jobs");
    }
    if (!selectedJob) {
      missing.push("focals_selectedJob");
    }
    if (!Array.isArray(templates) || templates.length === 0) {
      missing.push("focals_templates");
    }

    if (missing.length) {
      logStorageSnapshot();
      console.warn("[FOCALS] Config partielle détectée, poursuite avec valeurs par défaut", {
        missing,
        snapshot: {
          focals_user_id: data.focals_user_id,
          focals_jobs: jobs.length || 0,
          focals_selectedJob: selectedJob,
          focals_templates: templates.length || 0,
        },
      });
    }

    return { ok: true, missing };
  }

  function buildGreeting(firstNameInfo, language) {
    if (language === "en") {
      if (firstNameInfo.firstName && firstNameInfo.confidence >= 0.75) {
        return `Hi ${firstNameInfo.firstName},`;
      }
      return "Hi,";
    }
    if (firstNameInfo.firstName && firstNameInfo.confidence >= 0.75) {
      return `Bonjour ${firstNameInfo.firstName},`;
    }
    return "Bonjour,";
  }

  async function safeGetStorage(area, keys, defaults = {}) {
    return new Promise((resolve) => {
      try {
        chrome.storage[area].get(keys, (result) => resolve({ ...defaults, ...(result || {}) }));
      } catch (err) {
        debugLog("STORAGE_ERROR", err?.message || String(err));
        resolve({ ...defaults });
      }
    });
  }

  async function loadTone() {
    const bootstrap = await loadBootstrapData();
    const values = await safeGetStorage("sync", [STORAGE_KEYS.tone]);
    const tone = bootstrap?.settings?.default_tone || values[STORAGE_KEYS.tone] || DEFAULT_TONE;
    const map = {
      very_formal: "Use a very formal and polite tone, similar to a corporate email.",
      professional: "Use a professional and polite tone.",
      warm: "Use a warm and friendly tone while staying professional.",
      direct: "Be concise and to the point, without being rude.",
    };
    const instruction = map[tone] || map[DEFAULT_TONE];
    debugLog("TONE", { tone, instruction });
    return { tone, instruction };
  }

  async function loadTemplatesAndJobs() {
    const bootstrap = await loadBootstrapData();
    const values = await safeGetStorage("sync", [
      STORAGE_KEYS.selectedTemplate,
      STORAGE_KEYS.selectedJob,
    ]);
    return {
      templates: Array.isArray(bootstrap?.templates) ? bootstrap.templates : [],
      jobs: Array.isArray(bootstrap?.jobs) ? bootstrap.jobs : [],
      selectedTemplate: values[STORAGE_KEYS.selectedTemplate] || null,
      selectedJob:
        values[STORAGE_KEYS.selectedJob] ||
        bootstrap?.settings?.default_job_id ||
        bootstrap?.jobs?.[0]?.id ||
        null,
    };
  }

  function extractLinkedInMessages(limit = 10) {
    const containers = document.querySelectorAll(
      [
        ".msg-s-message-list__event",
        ".msg-s-event-listitem",
        "[data-test-message-listitem]",
        ".msg-s-message-group",
      ].join(", ")
    );
    const messages = [];
    containers.forEach((container) => {
      const isFromMe =
        container.classList.contains("msg-s-message-list__event--self") ||
        container.classList.contains("msg-s-message-group--self") ||
        !!container.querySelector('[data-test-sender="self"]') ||
        !!container.closest(".msg-s-message-list__event--self");
      const textNode = container.querySelector(
        [
          ".msg-s-event-listitem__body",
          ".msg-s-message-group__content",
          "[data-test-message-text]",
          ".msg-s-event__content",
        ].join(", ")
      );
      const text = normalizeSpace(textNode?.innerText || textNode?.textContent || "");
      if (!text) return;
      const timeEl = container.querySelector("time, .msg-s-message-list__time-heading");
      const timestamp = timeEl ? new Date(timeEl.getAttribute("datetime") || timeEl.innerText).getTime() : Date.now();
      messages.push({ text, fromMe: isFromMe, timestamp });
    });
    const sorted = messages.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return 0;
    });
    const recent = typeof limit === "number" ? sorted.slice(-limit) : sorted;
    debugLog("MESSAGES", { total: messages.length, recent: recent.length });
    return recent;
  }

  function insertReplyIntoMessageInput(replyText) {
    const inputSelectors = [
      ".msg-form__contenteditable",
      "[data-test-message-input]",
      '.msg-form__message-texteditor [contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
    ];

    let inputField = null;
    for (const selector of inputSelectors) {
      inputField = document.querySelector(selector);
      if (inputField) break;
    }

    if (!inputField) {
      debugLog("INPUT", "Message input not found; copying to clipboard");
      try {
        navigator.clipboard.writeText(replyText).then(() => {
          alert("Réponse copiée dans le presse-papier. Collez-la dans LinkedIn.");
        });
      } catch (err) {
        debugLog("CLIPBOARD_ERROR", err?.message || String(err));
      }
      return false;
    }

    try {
      inputField.focus();
      inputField.innerHTML = "";
      document.execCommand("insertText", false, replyText);
      if (!inputField.innerText || inputField.innerText.trim().length === 0) {
        inputField.innerText = replyText;
        inputField.dispatchEvent(new Event("input", { bubbles: true }));
        inputField.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(inputField);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      debugLog("INPUT", "Reply inserted into composer");
      return true;
    } catch (err) {
      debugLog("INPUT_ERROR", err?.message || String(err));
      return false;
    }
  }

  function setButtonsLoading(isLoading, label = "") {
    const replyBtn = getShadowElementById("focals-reply-btn");
    const generatePromptBtn = getShadowElementById("focals-generate-prompt-btn");
    const toggleButton = (btn, baseLabel) => {
      if (!btn) return;
      btn.disabled = isLoading;
      btn.textContent = isLoading && label ? label : baseLabel;
      btn.style.opacity = isLoading ? "0.7" : "1";
    };
    toggleButton(replyBtn, "Standard reply");
    toggleButton(generatePromptBtn, "Custom reply");
  }

  function applyTemplate(templateContent, { firstNameInfo, job }) {
    let content = templateContent || "";
    const replacements = {
      firstName: firstNameInfo.firstName || "",
      company: job?.company || "",
      role: job?.title || "",
    };
    Object.entries(replacements).forEach(([key, value]) => {
      content = content.replace(new RegExp(`{${key}}`, "g"), value || "");
    });
    return content;
  }

  function buildFollowUpSummary(messages) {
    const summary = [];
    messages.slice(-10).forEach((msg) => {
      summary.push(`${msg.fromMe ? "Me" : "Candidate"}: ${msg.text.slice(0, 120)}`);
    });
    return summary.join("\n");
  }

  async function generateReplyLegacy({ templateId, jobId, customInstructions }) {
    const allMessages = extractLinkedInMessages(10);
    if (!allMessages.length) {
      alert("Aucun message détecté dans la conversation.");
      return;
    }

    const candidateMessages = allMessages.filter((m) => !m.fromMe);
    const snippet = candidateMessages.map((m) => m.text).slice(-3).join("\n");
    const language = (await detectLanguage(snippet)) || "unknown";
    const languageFinal = language === "unknown" ? "fr" : language;

    const firstNameInfo = detectCandidateFirstNameFromDom();
    const { tone } = await loadTone();
    const { templates, jobs } = await loadTemplatesAndJobs();
    const selectedTemplate = templates.find((t) => t.id === templateId) || null;
    const selectedJob = jobs.find((j) => j.id === jobId) || null;

    const templateText = selectedTemplate
      ? applyTemplate(selectedTemplate.content, { firstNameInfo, job: selectedJob })
      : null;

    const messagesPayload = allMessages.map((m) => {
      const timestamp = new Date(m.timestamp || Date.now()).toISOString();
      return {
        senderType: m.fromMe ? "me" : "candidate",
        text: m.text,
        createdAt: timestamp,
        timestamp,
      };
    });

    const lastMessages = getLastMessagesForBackend(messagesPayload, 3).map((m) => ({
      text: m.text,
      fromMe: m.senderType === "me",
      timestampRaw: m.timestamp || m.createdAt,
    }));

    const trimmedInstructions = (customInstructions || "").trim();
    const request = {
      userId: await getUserId(),
      messages: lastMessages,
      context: {
        language: languageFinal,
        tone,
        candidateName: firstNameInfo.firstName || null,
        systemPromptOverride: trimmedInstructions || null,
      },
      toneOverride: tone,
      jobId: selectedJob?.id || undefined,
      templateId: selectedTemplate?.id || null,
      templateContentOverride: templateText,
    };

    try {
      setButtonsLoading(true, "Génération...");
      const response = await generateReplyApi(request);
      const replyText = extractReplyText(response);
      if (!replyText) {
        alert("Impossible de générer une réponse.");
        return;
      }
      insertReplyIntoMessageInput(replyText);
    } catch (error) {
      console.error("[Focals] generate-reply error", error);
      alert(`Erreur Focals : ${error?.message || "Une erreur est survenue."}`);
    } finally {
      setButtonsLoading(false);
    }
  }

  function buildControlPanel(state) {
    const mount = ensureShadowHost();
    if (shadowRoot?.getElementById("focals-controls")) return;
    const container = document.createElement("div");
    container.id = "focals-controls";
    container.style.position = "fixed";
    container.style.bottom = "16px";
    container.style.right = "16px";
    container.style.zIndex = "2147483647";
    container.style.background = "rgba(17,24,39,0.96)";
    container.style.color = "#fff";
    container.style.padding = "12px";
    container.style.border = "1px solid #334155";
    container.style.borderRadius = "12px";
    container.style.boxShadow = "0 10px 30px rgba(0,0,0,0.3)";
    container.style.width = "280px";
    container.style.fontFamily = "system-ui, sans-serif";
    container.style.pointerEvents = "auto";

    const title = document.createElement("div");
    title.textContent = "Focals";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";
    container.appendChild(title);

    const templateSelect = document.createElement("select");
    templateSelect.style.width = "100%";
    templateSelect.style.marginBottom = "6px";
    const defaultTpl = document.createElement("option");
    defaultTpl.value = "";
    defaultTpl.textContent = "Aucun modèle";
    templateSelect.appendChild(defaultTpl);
    state.templates.forEach((tpl) => {
      const opt = document.createElement("option");
      opt.value = tpl.id;
      opt.textContent = `${tpl.label || tpl.id} (${tpl.language})`;
      if (tpl.id === state.selectedTemplate) opt.selected = true;
      templateSelect.appendChild(opt);
    });

    const jobSelect = document.createElement("select");
    jobSelect.style.width = "100%";
    jobSelect.style.marginBottom = "6px";
    const defaultJob = document.createElement("option");
    defaultJob.value = "";
    defaultJob.textContent = "Aucun job";
    jobSelect.appendChild(defaultJob);
    state.jobs.forEach((job) => {
      const opt = document.createElement("option");
      opt.value = job.id;
      opt.textContent = `${job.title} @ ${job.company}`;
      if (job.id === state.selectedJob) opt.selected = true;
      jobSelect.appendChild(opt);
    });

    const actionRow = document.createElement("div");
    actionRow.style.display = "flex";
    actionRow.style.gap = "6px";
    actionRow.style.marginTop = "6px";

    const replyBtn = document.createElement("button");
    replyBtn.id = "focals-reply-btn";
    replyBtn.textContent = "Standard reply";
    replyBtn.style.flex = "1";
    replyBtn.style.padding = "10px";
    replyBtn.style.background = "#22c55e";
    replyBtn.style.border = "none";
    replyBtn.style.borderRadius = "10px";
    replyBtn.style.color = "#0f172a";
    replyBtn.style.fontWeight = "700";
    replyBtn.style.cursor = "pointer";

    const promptContainer = document.createElement("div");
    promptContainer.id = "focals-prompt-container";
    promptContainer.style.display = "flex";
    promptContainer.style.flexDirection = "column";
    promptContainer.style.gap = "6px";
    promptContainer.style.marginTop = "8px";

    const promptLabel = document.createElement("label");
    promptLabel.textContent = "Donne des instructions à l'IA pour répondre au candidat";
    promptLabel.style.fontSize = "13px";
    promptLabel.style.color = "#e2e8f0";

    const promptInput = document.createElement("textarea");
    promptInput.id = "focals-prompt-input";
    promptInput.placeholder =
      "Ex: Réponds en 3 phrases, propose un call, reste très concret, ne donne pas de détails techniques.";
    promptInput.maxLength = 500;
    promptInput.style.width = "100%";
    promptInput.style.minHeight = "72px";
    promptInput.style.padding = "8px";
    promptInput.style.borderRadius = "8px";
    promptInput.style.border = "1px solid #334155";
    promptInput.style.background = "rgba(255,255,255,0.05)";
    promptInput.style.color = "#e2e8f0";

    const promptGenerateBtn = document.createElement("button");
    promptGenerateBtn.id = "focals-generate-prompt-btn";
    promptGenerateBtn.textContent = "Custom reply";
    promptGenerateBtn.style.padding = "10px";
    promptGenerateBtn.style.background = "#0ea5e9";
    promptGenerateBtn.style.border = "none";
    promptGenerateBtn.style.borderRadius = "10px";
    promptGenerateBtn.style.color = "#0f172a";
    promptGenerateBtn.style.fontWeight = "700";
    promptGenerateBtn.style.cursor = "pointer";
    promptGenerateBtn.style.alignSelf = "flex-start";
    promptGenerateBtn.disabled = true;
    promptGenerateBtn.style.opacity = "0.7";

    const info = document.createElement("div");
    info.style.fontSize = "12px";
    info.style.color = "#cbd5e1";
    info.style.marginTop = "6px";
    info.textContent = `Ton: ${state.tone || DEFAULT_TONE}`;

    templateSelect.addEventListener("change", () => {
      const value = templateSelect.value || null;
      state.selectedTemplate = value;
      try {
        chrome.storage.sync.set({ [STORAGE_KEYS.selectedTemplate]: value });
      } catch (err) {
        debugLog("STORAGE_ERROR", err?.message || String(err));
      }
    });

    jobSelect.addEventListener("change", () => {
      const value = jobSelect.value || null;
      state.selectedJob = value;
      try {
        chrome.storage.sync.set({ [STORAGE_KEYS.selectedJob]: value });
      } catch (err) {
        debugLog("STORAGE_ERROR", err?.message || String(err));
      }
    });

    const updatePromptButtonState = () => {
      const hasText = (promptInput.value || "").trim().length > 0;
      promptGenerateBtn.disabled = !hasText;
      promptGenerateBtn.style.opacity = hasText ? "1" : "0.7";
    };

    replyBtn.onclick = () => {
      generateReplyLegacy({
        templateId: templateSelect.value || null,
        jobId: jobSelect.value || null,
        customInstructions: null,
      });
    };
    promptInput.addEventListener("input", updatePromptButtonState);
    promptGenerateBtn.onclick = () => {
      const instructions = (promptInput.value || "").trim();
      if (!instructions) {
        alert("Ajoutez des instructions avant de générer une réponse.");
        return;
      }
      generateReplyLegacy({
        templateId: templateSelect.value || null,
        jobId: jobSelect.value || null,
        customInstructions: instructions,
      });
    };
    updatePromptButtonState();

    container.appendChild(templateSelect);
    container.appendChild(jobSelect);
    actionRow.appendChild(replyBtn);
    container.appendChild(actionRow);
    promptContainer.appendChild(promptLabel);
    promptContainer.appendChild(promptInput);
    promptContainer.appendChild(promptGenerateBtn);
    container.appendChild(promptContainer);
    container.appendChild(info);

    mount.appendChild(container);
    console.log("[FOCALS] React portal mounted successfully");
  }

  async function initConversationFlow() {
    debugLog("MODE", "conversation");
  }

  async function initProfileFlow() {
    debugLog("MODE", "profile");
    console.log("[FOCALS] Étape 1 – récupération des infos profil de base");
    console.log("[FOCALS] Étape 2 – récupération de l’URL / ID");
    console.log("[FOCALS] Étape 3 – lancement du scraping et de l'injection UI");
    triggerProfileScrape(true);
  }

  async function injectProfileUi() {
    console.log("[FOCALS] Injection UI profil");
    await initProfileFlow();
  }

  console.log("[FOCALS] initAppsInjections start");
  const memberId = extractMemberIdFromProfile();
  if (!memberId) {
    console.warn("[FOCALS] No memberId extracted, continuing without it.");
  }

  async function init() {
    console.log("[FOCALS] Init – URL détectée :", window.location.href);
    const configCheck = await ensureConfigAvailable();
    console.log("[FOCALS] Config ready – clés :", Object.keys(configCheck || {}), "missing:", configCheck?.missing || []);
    if (!configCheck.ok) {
      debugLog("CONFIG_GUARD", configCheck);
      return;
    }

    const isProfileDetected = isProfilePage() || hasInlineRecruiterProfileCard();
    console.log("[FOCALS] detectIsProfilePage =", isProfileDetected);

    const messagingDetected = hasMessagingUi();

    if (!isProfileDetected && !messagingDetected) {
      console.warn("[FOCALS] Page non reconnue comme profil, arrêt du script");
      return;
    }

    console.log("[FOCALS] Début injection UI Focals");

    if (isProfileDetected) {
      await injectProfileUi();
    }

    if (messagingDetected) {
      console.log("[FOCALS] Mode messagerie détecté, activation des features messaging");
      await maybeInitConversationFlow();
    }
  }

  const runInit = () => {
    setTimeout(() => {
      init().catch((err) => {
        console.error("[FOCALS] Failed to initialize content script", err);
      });
    }, 300);
  };

  if (document.readyState === "complete") {
    runInit();
  } else {
    window.addEventListener(
      "load",
      () => {
        runInit();
      },
      { once: true }
    );
  }

  // === DEBUG FOCALS – NE PAS LAISSER EN PROD ===
  window.FOCALS_DEBUG = function () {
    console.log("[FOCALS DEBUG] href", window.location.href);

    try {
      chrome.storage.local.get(null, (data) => {
        console.log("[FOCALS DEBUG] STORAGE COMPLET", data);

        const hasJobs = Array.isArray(data.focals_jobs) && data.focals_jobs.length > 0;
        const hasSelectedJob = !!data.focals_selectedJob;
        const hasTemplates = Array.isArray(data.focals_templates) && data.focals_templates.length > 0;

        console.log("[FOCALS DEBUG] hasJobs", hasJobs, "hasSelectedJob", hasSelectedJob, "hasTemplates", hasTemplates);

        const profileRoot = document.querySelector("main");
        console.log("[FOCALS DEBUG] profileRoot", !!profileRoot);

        const nameEl = document.querySelector("h1");
        console.log("[FOCALS DEBUG] nameEl", !!nameEl, nameEl && nameEl.innerText);

        console.log("[FOCALS DEBUG] FIN DEBUG");
      });
    } catch (e) {
      console.error("[FOCALS DEBUG] ERREUR GLOBALE", e);
    }
  };
})();
